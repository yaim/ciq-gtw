/**
 * Shared-capacity key derivation and member encoding (Phase 4D; specification
 * sections 19.2, 21.1, 22.2).
 *
 * Three properties carry this boundary and are asserted directly:
 *
 *  - the capacity domain is SEPARATE from the idempotency, rate-limit, and
 *    thread-reuse domains even though all four expand ONE configured master key,
 *    so no value computed for one feature can be reinterpreted by another;
 *  - the scope is deterministic and independent of gateway-key ORDER, which is
 *    the only reason one active-permit budget can span replicas at all;
 *  - every component is unpadded base64url, which is what lets a ZSET member
 *    carry `version | owner | scope` with an out-of-alphabet delimiter.
 *
 * Every value here is synthetic.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VirtualModel } from "../../src/config/schema.js";
import {
  buildStorageKey,
  deriveGatewayKeyScope,
  deriveIdempotencyKeyring,
} from "../../src/idempotency/index.js";
import {
  buildRateLimitKey,
  deriveRateLimitKeyring,
  deriveRateLimitScope,
} from "../../src/rate-limit/index.js";
import {
  buildCapacityRegistryKey,
  CAPACITY_MEMBER_DELIMITER,
  CAPACITY_MEMBER_VERSION,
  CAPACITY_OWNER_FINAL_CHARS,
  CAPACITY_OWNER_TOKEN_BYTES,
  CAPACITY_OWNER_TOKEN_CHARS,
  CAPACITY_SCOPE_BYTES,
  CAPACITY_SCOPE_CHARS,
  CAPACITY_SCOPE_FINAL_CHARS,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
  encodeCapacityMember,
  isCanonicalCapacityOwner,
  isCanonicalCapacityScope,
  MAX_CAPACITY_MEMBER_BYTES,
  newCapacityOwnerToken,
} from "../../src/shared-capacity/index.js";
import {
  buildReuseStorageKey,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
} from "../../src/thread-reuse/index.js";

const MASTER_KEY = randomBytes(32).toString("base64url");
const OTHER_MASTER_KEY = randomBytes(32).toString("base64url");
const NAMESPACE = "collectiviq-gateway";

const KEY_A = "gw-fake-key-alpha";
const KEY_B = "gw-fake-key-bravo";

const capacity = deriveSharedCapacityKeyring(MASTER_KEY);
const idem = deriveIdempotencyKeyring(MASTER_KEY);
const rate = deriveRateLimitKeyring(MASTER_KEY);
const reuse = deriveThreadReuseKeyring(MASTER_KEY);

/** Only the fields `deriveModelPolicyFingerprint` reads matter here. */
function model(): VirtualModel {
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
  };
}

/** The thread-reuse storage key for `KEY_A`, used only for category comparison. */
function reuseKeyFor(gatewayKey: string): string {
  return buildReuseStorageKey(reuse, NAMESPACE, {
    gatewayKeyScope: deriveThreadReuseScope(reuse, gatewayKey),
    sessionId: "ses_fake_alpha",
    policyFingerprint: deriveModelPolicyFingerprint(reuse, model()),
    origin: "https://api.example.invalid",
    principalFingerprint: deriveUpstreamPrincipalFingerprint(reuse, {
      authMode: "bearer",
      credentialMaterial: "sk-fake-upstream",
    }),
  });
}

describe("shared-capacity keyring derivation", () => {
  it("derives one 32-byte subkey deterministically", () => {
    expect(capacity.capacityKey).toHaveLength(32);
    expect(deriveSharedCapacityKeyring(MASTER_KEY).capacityKey.equals(capacity.capacityKey)).toBe(
      true,
    );
    // Nothing derived may reveal the master key.
    expect(capacity.capacityKey.toString("base64url")).not.toBe(MASTER_KEY);
  });

  it("produces a different subkey for a different master key", () => {
    expect(
      deriveSharedCapacityKeyring(OTHER_MASTER_KEY).capacityKey.equals(capacity.capacityKey),
    ).toBe(false);
  });

  it("is domain-separated from EVERY other feature's subkey", () => {
    // MUTATION GUARD: reusing another feature's HKDF salt/info here would make
    // one of these equal, letting a capacity value be reinterpreted under an
    // idempotency, rate-limit, or thread-reuse key (and vice versa).
    const foreign = [
      idem.redisKey,
      idem.bodyKey,
      idem.aeadKey,
      rate.rateKey,
      reuse.scopeKey,
      reuse.storageKey,
      reuse.aeadKey,
      reuse.namespaceKey,
    ];
    for (const subkey of foreign) expect(capacity.capacityKey.equals(subkey)).toBe(false);
    const all = [...foreign, capacity.capacityKey].map((k) => k.toString("base64url"));
    expect(new Set(all).size).toBe(all.length);
  });

  it("rejects a master key of the wrong size without echoing it", () => {
    const short = randomBytes(16).toString("base64url");
    expect(() => deriveSharedCapacityKeyring(short)).toThrow(
      /shared-capacity master key has an unsupported size/,
    );
    try {
      deriveSharedCapacityKeyring(short);
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
      expect((error as Error).message).not.toContain(MASTER_KEY);
    }
  });
});

describe("shared-capacity gateway-key scope", () => {
  it("is stable for the same key and master key, so replicas agree", () => {
    expect(deriveCapacityScope(capacity, KEY_A)).toBe(deriveCapacityScope(capacity, KEY_A));
  });

  it("is independent of configured key ORDER", () => {
    // The scope is a function of the key alone. Unlike the process-local
    // `k<index>` identity, reordering COLLECTIVIQ_GATEWAY_KEYS cannot
    // re-partition the cluster-wide budget of an already-running deployment.
    const scopes = [KEY_A, KEY_B].map((key) => deriveCapacityScope(capacity, key));
    const reversed = [KEY_B, KEY_A].map((key) => deriveCapacityScope(capacity, key));
    expect(reversed.reverse()).toEqual(scopes);
  });

  it("never lets two distinct keys share a per-key budget", () => {
    expect(deriveCapacityScope(capacity, KEY_A)).not.toBe(deriveCapacityScope(capacity, KEY_B));
  });

  it("is unforgeable without the master key", () => {
    const foreign = deriveSharedCapacityKeyring(OTHER_MASTER_KEY);
    expect(deriveCapacityScope(foreign, KEY_A)).not.toBe(deriveCapacityScope(capacity, KEY_A));
  });

  it("DIFFERS from this key's idempotency, rate-limit, and thread-reuse scopes", () => {
    // MUTATION GUARD: reusing another boundary's scope (or its domain tag) would
    // collapse these onto one value and couple four independent features.
    for (const key of [KEY_A, KEY_B]) {
      const scopes = [
        deriveCapacityScope(capacity, key),
        deriveGatewayKeyScope(idem, key),
        deriveRateLimitScope(rate, key),
        deriveThreadReuseScope(reuse, key),
      ];
      expect(new Set(scopes).size).toBe(4);
    }
  });

  it("discloses neither the gateway key nor the master key", () => {
    const scope = deriveCapacityScope(capacity, KEY_A);
    expect(scope).not.toContain(KEY_A);
    expect(scope).not.toContain(MASTER_KEY);
  });

  it("is unpadded base64url, so it cannot contain the member delimiter", () => {
    // LOAD BEARING: the ZSET member format relies on the delimiter being outside
    // the component alphabet. A padded or otherwise widened encoding would let a
    // component forge an extra field.
    for (const key of [KEY_A, KEY_B, "", "a".repeat(512)]) {
      const scope = deriveCapacityScope(capacity, key);
      expect(scope).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(scope).not.toContain(CAPACITY_MEMBER_DELIMITER);
      // A base64url SHA-256 digest is 43 characters with no padding.
      expect(scope).toHaveLength(43);
    }
    expect(CAPACITY_MEMBER_DELIMITER).not.toMatch(/[A-Za-z0-9_-]/);
  });
});

describe("shared-capacity registry key", () => {
  const key = buildCapacityRegistryKey(capacity, NAMESPACE);

  /** The identifying digest, past the readable `<namespace>:capacity:` prefix. */
  function digestOf(registryKey: string): string {
    return registryKey.split(":capacity:")[1] ?? "";
  }

  it("carries the readable namespace verbatim and the fixed `capacity` category", () => {
    expect(key.startsWith(`${NAMESPACE}:capacity:`)).toBe(true);
    expect(key).toMatch(new RegExp(`^${NAMESPACE}:capacity:[A-Za-z0-9_-]+$`));
    expect(buildCapacityRegistryKey(capacity, NAMESPACE)).toBe(key);
  });

  it("keys the digest, so it cannot be computed without the master key", () => {
    const foreign = deriveSharedCapacityKeyring(OTHER_MASTER_KEY);
    expect(digestOf(buildCapacityRegistryKey(foreign, NAMESPACE))).not.toBe(digestOf(key));
  });

  it("separates namespaces in the digest, not merely in the prefix", () => {
    const other = buildCapacityRegistryKey(capacity, "other-ns");
    expect(other).not.toBe(key);
    expect(digestOf(other)).not.toBe(digestOf(key));
  });

  it("cannot be forged by shifting a boundary between the framed components", () => {
    // Without length framing the framed tag and namespace could be re-split.
    expect(digestOf(buildCapacityRegistryKey(capacity, "ab"))).not.toBe(
      digestOf(buildCapacityRegistryKey(capacity, "a")),
    );
  });

  it("holds no gateway key, scope, or master key", () => {
    expect(key).not.toContain(KEY_A);
    expect(key).not.toContain(KEY_B);
    expect(key).not.toContain(MASTER_KEY);
    // There is deliberately NO per-scope component: the global limit has to be
    // counted across all gateway keys, so one namespace-level key holds them all
    // and per-key occupancy comes from the scope inside each member.
    expect(key).not.toContain(deriveCapacityScope(capacity, KEY_A));
    expect(key).not.toContain(deriveCapacityScope(capacity, KEY_B));
    // The process-local `k<index>` identity must never reach Redis either.
    // Searching the digest for `k0` would be an unsound way to show that: two
    // characters recur in a random base64url digest often enough to flake.
    // Assert the structural reason it cannot appear instead — the key is a
    // function of the master key and the namespace ALONE, so no gateway key,
    // configuration index, or key ORDER can influence it.
    expect(buildCapacityRegistryKey(deriveSharedCapacityKeyring(MASTER_KEY), NAMESPACE)).toBe(key);
  });

  it("cannot collide with the idem, rate, or reuse keyspaces", () => {
    const keys = [
      key,
      buildStorageKey(idem, NAMESPACE, deriveGatewayKeyScope(idem, KEY_A), "client-key"),
      buildRateLimitKey(rate, NAMESPACE, deriveRateLimitScope(rate, KEY_A)),
      reuseKeyFor(KEY_A),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // Different category AND a different keyed digest: neither the prefix nor
    // the HMAC can collide with another feature's record for the same tenant.
    expect(keys[0]).toContain(":capacity:");
    expect(keys[1]).toContain(":idem:");
    expect(keys[2]).toContain(":rate:");
    expect(keys[3]).toContain(":reuse:");
    for (const category of [":idem:", ":rate:", ":reuse:"]) {
      expect(key).not.toContain(category);
    }
  });
});

describe("shared-capacity member encoding", () => {
  it("mints a 128-bit unpadded base64url owner token", () => {
    expect(CAPACITY_OWNER_TOKEN_BYTES).toBe(16);
    const token = newCapacityOwnerToken();
    // 16 bytes of CSPRNG output is 22 base64url characters with no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(token).not.toContain(CAPACITY_MEMBER_DELIMITER);
  });

  it("mints a distinct token every time", () => {
    // A predictable token would let a caller release a permit it does not hold.
    const tokens = new Set(Array.from({ length: 64 }, () => newCapacityOwnerToken()));
    expect(tokens.size).toBe(64);
  });

  it("encodes exactly `version | owner | scope`", () => {
    const owner = newCapacityOwnerToken();
    const scope = deriveCapacityScope(capacity, KEY_A);
    const member = encodeCapacityMember(owner, scope);
    expect(
      member.startsWith(`${String(CAPACITY_MEMBER_VERSION)}${CAPACITY_MEMBER_DELIMITER}`),
    ).toBe(true);
    expect(member.split(CAPACITY_MEMBER_DELIMITER)).toEqual([
      String(CAPACITY_MEMBER_VERSION),
      owner,
      scope,
    ]);
  });

  it("accepts only the CANONICAL encoding of each component", () => {
    // A member's identity IS its byte string, so two spellings of one owner
    // token would be two registry members for one permit. Node decodes a
    // non-canonical trailing character silently (`…B` and `…A` yield identical
    // bytes), which is why the validators re-encode instead of checking only
    // length and alphabet.
    const owner = newCapacityOwnerToken();
    const scope = deriveCapacityScope(capacity, KEY_A);
    expect(isCanonicalCapacityOwner(owner)).toBe(true);
    expect(isCanonicalCapacityScope(scope)).toBe(true);

    // Same bytes, non-canonical spelling. The canonical final character's 6-bit
    // value is divisible by 16 (its four low bits are the spare ones), so the
    // NEXT character in the alphabet keeps both data bits and only dirties a
    // spare bit — which is exactly the second spelling that must be refused.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const forged = owner.slice(0, -1) + alphabet[alphabet.indexOf(owner.slice(-1)) + 1];
    expect(forged).not.toBe(owner);
    expect(Buffer.from(forged, "base64url").equals(Buffer.from(owner, "base64url"))).toBe(true);
    expect(isCanonicalCapacityOwner(forged)).toBe(false);

    // Wrong length, and each component rejected in the other's role.
    expect(isCanonicalCapacityOwner(owner.slice(0, -1))).toBe(false);
    expect(isCanonicalCapacityOwner(`${owner}A`)).toBe(false);
    expect(isCanonicalCapacityScope(`${scope}A`)).toBe(false);
    expect(isCanonicalCapacityOwner(scope)).toBe(false);
    expect(isCanonicalCapacityScope(owner)).toBe(false);
    expect(isCanonicalCapacityOwner(`${owner.slice(0, -1)}|`)).toBe(false);
    expect(isCanonicalCapacityOwner("")).toBe(false);
  });

  it("agrees with the final-character classes the Lua patterns are built from", () => {
    // MUTATION GUARD: the server-side patterns narrow the LAST character of each
    // component, because the spare low bits of a canonical encoding are zero.
    // If these classes and the real encodings ever disagree, the Lua would
    // reject honest members — so derive both from real output.
    expect(CAPACITY_OWNER_TOKEN_CHARS).toBe(22);
    expect(CAPACITY_SCOPE_CHARS).toBe(43);
    expect(CAPACITY_SCOPE_BYTES).toBe(32);

    const ownerFinals = new Set<string>();
    const scopeFinals = new Set<string>();
    for (let i = 0; i < 512; i += 1) {
      const owner = newCapacityOwnerToken();
      const scope = deriveCapacityScope(capacity, `gw-fake-key-${String(i)}`);
      expect(owner).toHaveLength(CAPACITY_OWNER_TOKEN_CHARS);
      expect(scope).toHaveLength(CAPACITY_SCOPE_CHARS);
      ownerFinals.add(owner.slice(-1));
      scopeFinals.add(scope.slice(-1));
    }
    for (const final of ownerFinals) expect(CAPACITY_OWNER_FINAL_CHARS).toContain(final);
    for (const final of scopeFinals) expect(CAPACITY_SCOPE_FINAL_CHARS).toContain(final);
    // Every advertised final character must also be reachable, so neither class
    // is quietly wider than the encoding it describes.
    expect(CAPACITY_OWNER_FINAL_CHARS.length).toBe(4);
    expect(CAPACITY_SCOPE_FINAL_CHARS.length).toBe(16);
    expect([...CAPACITY_OWNER_FINAL_CHARS].sort().join("")).toBe("AQgw");
    expect([...CAPACITY_SCOPE_FINAL_CHARS].sort().join("")).toBe("048AEIMQUYcgkosw");
  });

  it("splits unambiguously because neither component can hold the delimiter", () => {
    // MUTATION GUARD: widening either component's alphabet to include `|` would
    // let a hostile writer forge an extra field inside one member.
    for (const key of [KEY_A, KEY_B]) {
      const member = encodeCapacityMember(
        newCapacityOwnerToken(),
        deriveCapacityScope(capacity, key),
      );
      expect(member.split(CAPACITY_MEMBER_DELIMITER)).toHaveLength(3);
    }
  });

  it("stays well inside the accepted member byte bound", () => {
    const member = encodeCapacityMember(
      newCapacityOwnerToken(),
      deriveCapacityScope(capacity, KEY_A),
    );
    // 1 version character + 2 delimiters + a 22-character token + a 43-character
    // digest. The bound exists to cap what the Lua validator may accept from a
    // hostile writer, so an honest member must sit comfortably below it.
    expect(Buffer.byteLength(member, "utf8")).toBe(68);
    expect(Buffer.byteLength(member, "utf8")).toBeLessThan(MAX_CAPACITY_MEMBER_BYTES);
  });
});
