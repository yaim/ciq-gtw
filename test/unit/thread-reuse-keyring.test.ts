/**
 * Key derivation and mapping identity for OpenCode thread reuse (Phase 5A;
 * specification sections 5.1.1, 21.1, 22.2).
 *
 * The properties under test are the ones a privacy or correctness failure would
 * silently violate: every subkey is in its OWN HKDF domain (including relative
 * to Phase 4A and Phase 4B), no raw material survives into a derived value, and
 * no two distinct mapping identities can collide onto one storage key.
 *
 * Every value here is synthetic.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VirtualModel } from "../../src/config/schema.js";
import { deriveIdempotencyKeyring, deriveGatewayKeyScope } from "../../src/idempotency/index.js";
import { deriveRateLimitKeyring, deriveRateLimitScope } from "../../src/rate-limit/index.js";
import {
  buildMappingIdentityDigest,
  buildReuseStorageKey,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  type MappingIdentity,
} from "../../src/thread-reuse/index.js";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveThreadReuseKeyring(MASTER_KEY);
const NAMESPACE = "test-ns";

const GATEWAY_KEY = "gw-fake-key-alpha";
const SESSION_ID = "ses_fake_alpha";

function model(over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: "collectiviq-claude-direct",
    displayName: "direct",
    selectedLlms: ["claude"],
    generateCombined: false,
    answerSource: "claude",
    toolMode: "disabled",
    promptMode: "direct",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
    ...over,
  };
}

function identity(over: Partial<MappingIdentity> = {}): MappingIdentity {
  return {
    gatewayKeyScope: deriveThreadReuseScope(KEYRING, GATEWAY_KEY),
    sessionId: SESSION_ID,
    policyFingerprint: deriveModelPolicyFingerprint(KEYRING, model()),
    origin: "https://api.example.invalid",
    principalFingerprint: deriveUpstreamPrincipalFingerprint(KEYRING, {
      authMode: "bearer",
      credentialMaterial: "sk-fake-upstream",
    }),
    ...over,
  };
}

describe("thread-reuse keyring", () => {
  it("derives four distinct subkeys of exactly 32 bytes", () => {
    const subkeys = [KEYRING.scopeKey, KEYRING.storageKey, KEYRING.aeadKey, KEYRING.namespaceKey];
    for (const subkey of subkeys) expect(subkey).toHaveLength(32);
    const distinct = new Set(subkeys.map((k) => k.toString("base64url")));
    expect(distinct.size).toBe(4);
    // Nothing derived may reveal the master key.
    for (const subkey of subkeys) expect(subkey.toString("base64url")).not.toBe(MASTER_KEY);
  });

  it("rejects a master key of the wrong size without echoing it", () => {
    const short = randomBytes(16).toString("base64url");
    expect(() => deriveThreadReuseKeyring(short)).toThrowError(
      /thread-reuse master key has an unsupported size/,
    );
    try {
      deriveThreadReuseKeyring(short);
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });

  it("keeps every subkey out of the Phase 4A and Phase 4B domains", () => {
    // The three boundaries share ONE configured master key, so the only thing
    // separating them is the HKDF salt/info. If any subkey collided, a value
    // computed for one feature could be reinterpreted by another.
    const idem = deriveIdempotencyKeyring(MASTER_KEY);
    const rate = deriveRateLimitKeyring(MASTER_KEY);
    const all = [
      idem.redisKey,
      idem.bodyKey,
      idem.aeadKey,
      rate.rateKey,
      KEYRING.scopeKey,
      KEYRING.storageKey,
      KEYRING.aeadKey,
      KEYRING.namespaceKey,
    ].map((k) => k.toString("base64url"));
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives one gateway key three unrelated scopes", () => {
    const idem = deriveGatewayKeyScope(deriveIdempotencyKeyring(MASTER_KEY), GATEWAY_KEY);
    const rate = deriveRateLimitScope(deriveRateLimitKeyring(MASTER_KEY), GATEWAY_KEY);
    const reuse = deriveThreadReuseScope(KEYRING, GATEWAY_KEY);
    expect(new Set([idem, rate, reuse]).size).toBe(3);
    // A scope must not leak the key it was derived from.
    expect(reuse).not.toContain(GATEWAY_KEY);
  });

  it("derives a deterministic scope that differs per gateway key", () => {
    expect(deriveThreadReuseScope(KEYRING, GATEWAY_KEY)).toBe(
      deriveThreadReuseScope(KEYRING, GATEWAY_KEY),
    );
    expect(deriveThreadReuseScope(KEYRING, GATEWAY_KEY)).not.toBe(
      deriveThreadReuseScope(KEYRING, "gw-fake-key-bravo"),
    );
    // A different master key partitions everything.
    const other = deriveThreadReuseKeyring(randomBytes(32).toString("base64url"));
    expect(deriveThreadReuseScope(other, GATEWAY_KEY)).not.toBe(
      deriveThreadReuseScope(KEYRING, GATEWAY_KEY),
    );
  });

  it("fingerprints the upstream principal without exposing its material", () => {
    const bearer = deriveUpstreamPrincipalFingerprint(KEYRING, {
      authMode: "bearer",
      credentialMaterial: "sk-fake-upstream",
    });
    expect(bearer).toBe(
      deriveUpstreamPrincipalFingerprint(KEYRING, {
        authMode: "bearer",
        credentialMaterial: "sk-fake-upstream",
      }),
    );
    expect(bearer).not.toContain("sk-fake-upstream");
    // A different credential, and the SAME credential under a different auth
    // mode, are different principals.
    expect(bearer).not.toBe(
      deriveUpstreamPrincipalFingerprint(KEYRING, {
        authMode: "bearer",
        credentialMaterial: "sk-fake-other",
      }),
    );
    expect(bearer).not.toBe(
      deriveUpstreamPrincipalFingerprint(KEYRING, {
        authMode: "password",
        credentialMaterial: "sk-fake-upstream",
      }),
    );
  });

  it("fingerprints every normalized model-policy field", () => {
    const base = deriveModelPolicyFingerprint(KEYRING, model());
    expect(base).toBe(deriveModelPolicyFingerprint(KEYRING, model()));
    const variants: Partial<VirtualModel>[] = [
      { id: "collectiviq-claude-other" },
      { selectedLlms: ["gpt"] },
      { generateCombined: true },
      { answerSource: "gpt" },
      { promptMode: "protocol" },
      { toolMode: "emulated" },
    ];
    for (const over of variants) {
      expect(deriveModelPolicyFingerprint(KEYRING, model(over))).not.toBe(base);
    }
    // `selectedLlms` ORDER is part of the policy (it breaks consensus ties).
    expect(deriveModelPolicyFingerprint(KEYRING, model({ selectedLlms: ["a", "b"] }))).not.toBe(
      deriveModelPolicyFingerprint(KEYRING, model({ selectedLlms: ["b", "a"] })),
    );
    // Each element is framed individually AND the arity is mixed in, so neither
    // shifting a boundary between two sources nor splitting one into two can
    // make two different source lists share a fingerprint.
    const collisionCandidates = [["ab", "c"], ["a", "bc"], ["abc"], ["a", "b", "c"], ["", "abc"]];
    const fingerprints = collisionCandidates.map((selectedLlms) =>
      deriveModelPolicyFingerprint(KEYRING, model({ selectedLlms })),
    );
    expect(new Set(fingerprints).size).toBe(collisionCandidates.length);
    // A source list must also not collide with the NEXT field in the tuple.
    expect(deriveModelPolicyFingerprint(KEYRING, model({ selectedLlms: ["x"] }))).not.toBe(
      deriveModelPolicyFingerprint(KEYRING, model({ selectedLlms: ["x"], answerSource: "x" })),
    );
    // Timeouts and display metadata are NOT routing policy.
    expect(deriveModelPolicyFingerprint(KEYRING, model({ requestTimeoutMs: 1_000 }))).toBe(base);
    expect(deriveModelPolicyFingerprint(KEYRING, model({ displayName: "other" }))).toBe(base);
  });

  it("builds a namespaced storage key that leaks no identity component", () => {
    const key = buildReuseStorageKey(KEYRING, NAMESPACE, identity());
    expect(key.startsWith(`${NAMESPACE}:reuse:`)).toBe(true);
    expect(key).not.toContain(SESSION_ID);
    expect(key).not.toContain(GATEWAY_KEY);
    expect(key).not.toContain("api.example.invalid");
    expect(key).not.toContain("collectiviq-claude-direct");
    // Deterministic across calls, which is what makes a mapping cross-replica.
    expect(buildReuseStorageKey(KEYRING, NAMESPACE, identity())).toBe(key);
  });

  it("separates the storage key from the mapping-identity digest", () => {
    // The digest is bound into the AEAD associated data. Deriving it under a
    // different subkey means neither value can be computed from the other, so
    // forging a storage key does not also forge the binding.
    const key = buildReuseStorageKey(KEYRING, NAMESPACE, identity());
    const digest = buildMappingIdentityDigest(KEYRING, NAMESPACE, identity());
    expect(key).not.toContain(digest);
    expect(digest).not.toBe(key);
    expect(buildMappingIdentityDigest(KEYRING, NAMESPACE, identity())).toBe(digest);
  });

  it("gives every distinct mapping identity a distinct key and digest", () => {
    const variants: Partial<MappingIdentity>[] = [
      {},
      { gatewayKeyScope: deriveThreadReuseScope(KEYRING, "gw-fake-key-bravo") },
      { sessionId: "ses_fake_bravo" },
      { policyFingerprint: deriveModelPolicyFingerprint(KEYRING, model({ answerSource: "gpt" })) },
      { origin: "https://api.other.invalid" },
      {
        principalFingerprint: deriveUpstreamPrincipalFingerprint(KEYRING, {
          authMode: "password",
          credentialMaterial: "user-fake",
        }),
      },
    ];
    const keys = variants.map((over) => buildReuseStorageKey(KEYRING, NAMESPACE, identity(over)));
    const digests = variants.map((over) =>
      buildMappingIdentityDigest(KEYRING, NAMESPACE, identity(over)),
    );
    expect(new Set(keys).size).toBe(variants.length);
    expect(new Set(digests).size).toBe(variants.length);
    // A different namespace partitions the keyspace too.
    expect(buildReuseStorageKey(KEYRING, "other-ns", identity())).not.toBe(keys[0]);
  });

  it("cannot be fooled by shifting a boundary between identity components", () => {
    // Without length framing, ("ab","c") and ("a","bc") would hash identically
    // and two different OpenCode sessions could share one upstream thread.
    const left = buildReuseStorageKey(
      KEYRING,
      NAMESPACE,
      identity({ gatewayKeyScope: "ab", sessionId: "c" }),
    );
    const right = buildReuseStorageKey(
      KEYRING,
      NAMESPACE,
      identity({ gatewayKeyScope: "a", sessionId: "bc" }),
    );
    expect(left).not.toBe(right);
    // The same shift across the namespace boundary must also be distinguishable.
    expect(buildReuseStorageKey(KEYRING, "ns", identity({ gatewayKeyScope: "x" }))).not.toBe(
      buildReuseStorageKey(KEYRING, "n", identity({ gatewayKeyScope: "sx" })),
    );
  });
});
