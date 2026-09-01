/**
 * Rate-limit key derivation (Phase 4B; specification section 19.1).
 *
 * Two properties carry the whole design and are asserted here directly:
 *
 *  - the rate-limit domain is SEPARATE from the idempotency domain, so the two
 *    features can never share, correlate, or collide on a value even though
 *    they expand the same configured master key;
 *  - the scope is stable across replicas and independent of gateway-key ORDER,
 *    which is what makes one quota span replicas at all.
 *
 * Every value here is synthetic.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
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

const MASTER_KEY = randomBytes(32).toString("base64url");
const OTHER_MASTER_KEY = randomBytes(32).toString("base64url");
const KEY_A = "gw-fake-key-alpha";
const KEY_B = "gw-fake-key-bravo";
const NAMESPACE = "collectiviq-gateway";

const rate = deriveRateLimitKeyring(MASTER_KEY);
const idem = deriveIdempotencyKeyring(MASTER_KEY);

describe("rate-limit keyring derivation", () => {
  it("is deterministic for the same master key", () => {
    expect(deriveRateLimitKeyring(MASTER_KEY).rateKey.equals(rate.rateKey)).toBe(true);
  });

  it("produces a different subkey for a different master key", () => {
    expect(deriveRateLimitKeyring(OTHER_MASTER_KEY).rateKey.equals(rate.rateKey)).toBe(false);
  });

  it("is domain-separated from EVERY idempotency subkey", () => {
    // MUTATION GUARD: reusing the idempotency HKDF salt/info here would make one
    // of these comparisons true, which would let a rate-limit value be
    // reinterpreted under an idempotency key (and vice versa).
    expect(rate.rateKey.equals(idem.redisKey)).toBe(false);
    expect(rate.rateKey.equals(idem.bodyKey)).toBe(false);
    expect(rate.rateKey.equals(idem.aeadKey)).toBe(false);
  });

  it("rejects a master key of the wrong size without echoing it", () => {
    const short = randomBytes(16).toString("base64url");
    expect(() => deriveRateLimitKeyring(short)).toThrow(/unsupported size/);
    try {
      deriveRateLimitKeyring(short);
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });
});

describe("rate-limit gateway-key scope", () => {
  it("is stable for the same key and master key", () => {
    expect(deriveRateLimitScope(rate, KEY_A)).toBe(deriveRateLimitScope(rate, KEY_A));
  });

  it("is independent of configured key ORDER", () => {
    // The scope is a function of the key alone, so reordering
    // COLLECTIVIQ_GATEWAY_KEYS cannot re-partition an existing shared quota.
    const scopes = [KEY_A, KEY_B].map((key) => deriveRateLimitScope(rate, key));
    const reversed = [KEY_B, KEY_A].map((key) => deriveRateLimitScope(rate, key));
    expect(reversed.reverse()).toEqual(scopes);
  });

  it("never lets two distinct keys share a quota", () => {
    expect(deriveRateLimitScope(rate, KEY_A)).not.toBe(deriveRateLimitScope(rate, KEY_B));
  });

  it("DIFFERS from the idempotency scope for the same key", () => {
    // MUTATION GUARD: reusing the idempotency scope (or its domain tag) here
    // would make these equal, coupling two independent features to one value.
    expect(deriveRateLimitScope(rate, KEY_A)).not.toBe(deriveGatewayKeyScope(idem, KEY_A));
    expect(deriveRateLimitScope(rate, KEY_B)).not.toBe(deriveGatewayKeyScope(idem, KEY_B));
  });

  it("discloses neither the gateway key nor the master key", () => {
    const scope = deriveRateLimitScope(rate, KEY_A);
    expect(scope).not.toContain(KEY_A);
    expect(scope).not.toContain(MASTER_KEY);
    expect(scope).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is unforgeable without the master key", () => {
    const foreign = deriveRateLimitKeyring(OTHER_MASTER_KEY);
    expect(deriveRateLimitScope(foreign, KEY_A)).not.toBe(deriveRateLimitScope(rate, KEY_A));
  });
});

describe("rate-limit Redis key", () => {
  const scope = deriveRateLimitScope(rate, KEY_A);

  it("carries the readable namespace and the fixed `rate` category", () => {
    expect(buildRateLimitKey(rate, NAMESPACE, scope)).toMatch(
      new RegExp(`^${NAMESPACE}:rate:[A-Za-z0-9_-]+$`),
    );
  });

  it("is domain-separated from the idempotency keyspace", () => {
    // Different category AND a different digest: neither the prefix nor the
    // HMAC can collide with an idempotency record for the same tenant.
    const idempotencyKey = buildStorageKey(
      idem,
      NAMESPACE,
      deriveGatewayKeyScope(idem, KEY_A),
      "k",
    );
    expect(buildRateLimitKey(rate, NAMESPACE, scope)).not.toBe(idempotencyKey);
    expect(buildRateLimitKey(rate, NAMESPACE, scope)).toContain(":rate:");
    expect(idempotencyKey).toContain(":idem:");
  });

  it("separates namespaces and scopes", () => {
    const other = deriveRateLimitScope(rate, KEY_B);
    expect(buildRateLimitKey(rate, NAMESPACE, scope)).not.toBe(
      buildRateLimitKey(rate, "other-ns", scope),
    );
    expect(buildRateLimitKey(rate, NAMESPACE, scope)).not.toBe(
      buildRateLimitKey(rate, NAMESPACE, other),
    );
  });

  it("cannot be forged by shifting a boundary between the framed components", () => {
    // Length framing means "ab" + "c" and "a" + "bc" are different inputs; an
    // unframed concatenation would collapse them onto one key.
    expect(buildRateLimitKey(rate, "ab", "c")).not.toBe(buildRateLimitKey(rate, "a", "bc"));
  });

  it("holds no gateway key, scope material, or master key", () => {
    const key = buildRateLimitKey(rate, NAMESPACE, scope);
    expect(key).not.toContain(KEY_A);
    expect(key).not.toContain(MASTER_KEY);
    expect(key).not.toContain(scope);
    // The process-local capacity identity must never reach Redis either.
    expect(key).not.toContain("k0");
  });
});
