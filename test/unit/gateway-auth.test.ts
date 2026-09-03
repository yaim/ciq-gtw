import { describe, expect, it, vi } from "vitest";
import { timingSafeEqual } from "node:crypto";
import {
  PRESENTED_TOKEN_MAX_BYTES,
  createGatewayAuthenticator,
} from "../../src/api/gateway-auth.js";

const KEY_A = "gw-fake-key-alpha";
const KEY_B = "gw-fake-key-bravo-longer-than-alpha";

/** A success with every cross-replica scope absent (no feature enabled). */
function unscoped(keyId: string): {
  ok: true;
  keyId: string;
  scopeId: null;
  rateLimitScopeId: null;
  reuseScopeId: null;
  capacityScopeId: null;
} {
  return {
    ok: true,
    keyId,
    scopeId: null,
    rateLimitScopeId: null,
    reuseScopeId: null,
    capacityScopeId: null,
  };
}

describe("createGatewayAuthenticator", () => {
  it("accepts every configured key with a case-insensitive scheme and an opaque identity", () => {
    const auth = createGatewayAuthenticator([KEY_A, KEY_B]);
    // The process-local identity is the matched key's config index, never the
    // key itself; with no deriver configured EVERY cross-replica scope is null.
    expect(auth.authenticate(`Bearer ${KEY_A}`)).toEqual(unscoped("k0"));
    expect(auth.authenticate(`Bearer ${KEY_B}`)).toEqual(unscoped("k1"));
    expect(auth.authenticate(`bearer ${KEY_A}`)).toEqual(unscoped("k0"));
    expect(auth.authenticate(`BEARER ${KEY_A}`)).toEqual(unscoped("k0"));
    expect(auth.authenticate(`BeArEr ${KEY_B}`)).toEqual(unscoped("k1"));
  });

  it("rejects missing, malformed, empty, wrong-scheme, and wrong tokens alike", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    expect(auth.authenticate(undefined)).toEqual({ ok: false }); // missing header
    expect(auth.authenticate("")).toEqual({ ok: false }); // empty header
    expect(auth.authenticate(KEY_A)).toEqual({ ok: false }); // no scheme separator
    expect(auth.authenticate("Bearer")).toEqual({ ok: false }); // scheme only, no token
    expect(auth.authenticate("Bearer ")).toEqual({ ok: false }); // empty token
    expect(auth.authenticate("Basic " + KEY_A)).toEqual({ ok: false }); // wrong scheme
    expect(auth.authenticate("Token " + KEY_A)).toEqual({ ok: false }); // wrong scheme
    expect(auth.authenticate("Bearer gw-wrong-key")).toEqual({ ok: false }); // wrong token
  });

  it("compares the token exactly, rejecting any extra whitespace", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    // Only the first space delimits the scheme; further whitespace is part of
    // the token and must not match the exact configured key.
    expect(auth.authenticate(`Bearer  ${KEY_A}`)).toEqual({ ok: false }); // leading space
    expect(auth.authenticate(`Bearer ${KEY_A} `)).toEqual({ ok: false }); // trailing space
    expect(auth.authenticate(`Bearer ${KEY_A}\t`)).toEqual({ ok: false }); // trailing tab
    expect(auth.authenticate(`Bearer ${KEY_A.toUpperCase()}`)).toEqual({ ok: false }); // wrong case
  });

  it("rejects an oversized presented token before it can match", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    const oversized = "a".repeat(PRESENTED_TOKEN_MAX_BYTES + 1);
    expect(auth.authenticate(`Bearer ${oversized}`)).toEqual({ ok: false });
    // A token exactly at the cap is allowed to be compared (still wrong here).
    const atCap = "a".repeat(PRESENTED_TOKEN_MAX_BYTES);
    expect(auth.authenticate(`Bearer ${atCap}`)).toEqual({ ok: false });
  });

  it("authenticates keys regardless of differing lengths", () => {
    const short = "g";
    const long = "gw-" + "z".repeat(500);
    const auth = createGatewayAuthenticator([short, long]);
    expect(auth.authenticate(`Bearer ${short}`)).toEqual(unscoped("k0"));
    expect(auth.authenticate(`Bearer ${long}`)).toEqual(unscoped("k1"));
    expect(auth.authenticate(`Bearer gw-${"z".repeat(499)}`)).toEqual({ ok: false });
  });

  it("exposes a stable idempotency scope that is independent of key ORDER", () => {
    // The Redis scope must survive reordering or adding gateway keys: only the
    // process-local capacity identity is index-derived.
    const deriver = (key: string): string => `scope(${key})`;
    const first = createGatewayAuthenticator([KEY_A, KEY_B], { scopeDeriver: deriver });
    const reordered = createGatewayAuthenticator(["gw-new", KEY_B, KEY_A], {
      scopeDeriver: deriver,
    });
    expect(first.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k0",
      scopeId: "scope(gw-fake-key-alpha)",
      rateLimitScopeId: null,
      reuseScopeId: null,
      capacityScopeId: null,
    });
    // Same scope, DIFFERENT capacity identity, after reordering.
    expect(reordered.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k2",
      scopeId: "scope(gw-fake-key-alpha)",
      rateLimitScopeId: null,
      reuseScopeId: null,
      capacityScopeId: null,
    });
    // Distinct keys never share a scope.
    expect(first.authenticate(`Bearer ${KEY_B}`)).toEqual({
      ok: true,
      keyId: "k1",
      scopeId: "scope(gw-fake-key-bravo-longer-than-alpha)",
      rateLimitScopeId: null,
      reuseScopeId: null,
      capacityScopeId: null,
    });
  });

  it("derives each scope exactly once, at construction", () => {
    const scopeDeriver = vi.fn((key: string) => `scope(${key})`);
    const rateLimitScopeDeriver = vi.fn((key: string) => `rate(${key})`);
    const reuseScopeDeriver = vi.fn((key: string) => `reuse(${key})`);
    const capacityScopeDeriver = vi.fn((key: string) => `capacity(${key})`);
    const auth = createGatewayAuthenticator([KEY_A, KEY_B], {
      scopeDeriver,
      rateLimitScopeDeriver,
      reuseScopeDeriver,
      capacityScopeDeriver,
    });
    expect(scopeDeriver).toHaveBeenCalledTimes(2);
    expect(rateLimitScopeDeriver).toHaveBeenCalledTimes(2);
    expect(reuseScopeDeriver).toHaveBeenCalledTimes(2);
    expect(capacityScopeDeriver).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i += 1) auth.authenticate(`Bearer ${KEY_A}`);
    // The raw key material is never re-read per request, by any deriver.
    expect(scopeDeriver).toHaveBeenCalledTimes(2);
    expect(rateLimitScopeDeriver).toHaveBeenCalledTimes(2);
    expect(reuseScopeDeriver).toHaveBeenCalledTimes(2);
    expect(capacityScopeDeriver).toHaveBeenCalledTimes(2);
  });

  it("reports a null scope for a failed authentication", () => {
    const auth = createGatewayAuthenticator([KEY_A], {
      scopeDeriver: (k) => `scope(${k})`,
      rateLimitScopeDeriver: (k) => `rate(${k})`,
      reuseScopeDeriver: (k) => `reuse(${k})`,
    });
    expect(auth.authenticate("Bearer gw-wrong")).toEqual({ ok: false });
  });

  it("carries INDEPENDENT idempotency, rate-limit, and thread-reuse scopes", () => {
    // Each feature gets its own identity for the same key, so any one boundary
    // can be enabled without the others and none can be mistaken for another.
    const auth = createGatewayAuthenticator([KEY_A, KEY_B], {
      scopeDeriver: (k) => `scope(${k})`,
      rateLimitScopeDeriver: (k) => `rate(${k})`,
      reuseScopeDeriver: (k) => `reuse(${k})`,
    });
    expect(auth.authenticate(`Bearer ${KEY_B}`)).toEqual({
      ok: true,
      keyId: "k1",
      scopeId: "scope(gw-fake-key-bravo-longer-than-alpha)",
      rateLimitScopeId: "rate(gw-fake-key-bravo-longer-than-alpha)",
      reuseScopeId: "reuse(gw-fake-key-bravo-longer-than-alpha)",
      capacityScopeId: null,
    });
  });

  it("exposes a thread-reuse scope independent of key ORDER, with the others disabled", () => {
    // Thread reuse must be usable on its own, and reordering or adding gateway
    // keys must never re-partition an existing session-to-thread mapping.
    const reuseScopeDeriver = (key: string): string => `reuse(${key})`;
    const first = createGatewayAuthenticator([KEY_A, KEY_B], { reuseScopeDeriver });
    const reordered = createGatewayAuthenticator(["gw-fake-key-charlie", KEY_B, KEY_A], {
      reuseScopeDeriver,
    });
    expect(first.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k0",
      scopeId: null,
      rateLimitScopeId: null,
      reuseScopeId: "reuse(gw-fake-key-alpha)",
      capacityScopeId: null,
    });
    expect(reordered.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k2",
      scopeId: null,
      rateLimitScopeId: null,
      reuseScopeId: "reuse(gw-fake-key-alpha)",
      capacityScopeId: null,
    });
    // Distinct keys never share a mapping scope.
    expect(reordered.authenticate(`Bearer ${KEY_B}`)).toEqual({
      ok: true,
      keyId: "k1",
      scopeId: null,
      rateLimitScopeId: null,
      reuseScopeId: "reuse(gw-fake-key-bravo-longer-than-alpha)",
      capacityScopeId: null,
    });
  });

  it("exposes a rate-limit scope independent of key ORDER, with idempotency disabled", () => {
    // Rate limiting must be usable on its own, and reordering or adding gateway
    // keys must never re-partition an existing shared quota.
    const rateLimitScopeDeriver = (key: string): string => `rate(${key})`;
    const first = createGatewayAuthenticator([KEY_A, KEY_B], { rateLimitScopeDeriver });
    const reordered = createGatewayAuthenticator(["gw-new", KEY_B, KEY_A], {
      rateLimitScopeDeriver,
    });
    expect(first.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k0",
      scopeId: null,
      rateLimitScopeId: "rate(gw-fake-key-alpha)",
      reuseScopeId: null,
      capacityScopeId: null,
    });
    expect(reordered.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k2",
      scopeId: null,
      rateLimitScopeId: "rate(gw-fake-key-alpha)",
      reuseScopeId: null,
      capacityScopeId: null,
    });
    // Distinct keys never share a quota.
    expect(reordered.authenticate(`Bearer ${KEY_B}`)).toEqual({
      ok: true,
      keyId: "k1",
      scopeId: null,
      rateLimitScopeId: "rate(gw-fake-key-bravo-longer-than-alpha)",
      reuseScopeId: null,
      capacityScopeId: null,
    });
  });

  it("exposes a capacity scope independent of key ORDER, with the others disabled", () => {
    // Shared capacity must be usable on its own, and the cluster-wide per-key
    // budget has to follow the KEY rather than its configuration index — which
    // is exactly why the process-local `keyId` can never be written to Redis.
    const capacityScopeDeriver = (key: string): string => `capacity(${key})`;
    const first = createGatewayAuthenticator([KEY_A, KEY_B], { capacityScopeDeriver });
    const reordered = createGatewayAuthenticator(["gw-new", KEY_B, KEY_A], {
      capacityScopeDeriver,
    });
    expect(first.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k0",
      scopeId: null,
      rateLimitScopeId: null,
      reuseScopeId: null,
      capacityScopeId: "capacity(gw-fake-key-alpha)",
    });
    expect(reordered.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k2",
      scopeId: null,
      rateLimitScopeId: null,
      reuseScopeId: null,
      capacityScopeId: "capacity(gw-fake-key-alpha)",
    });
    // Distinct keys never share a cluster-wide budget.
    expect(reordered.authenticate(`Bearer ${KEY_B}`)).toEqual({
      ok: true,
      keyId: "k1",
      scopeId: null,
      rateLimitScopeId: null,
      reuseScopeId: null,
      capacityScopeId: "capacity(gw-fake-key-bravo-longer-than-alpha)",
    });
  });

  it("reports a null capacity scope when no capacity deriver is supplied", () => {
    // Omitting the deriver is how shared capacity stays off, and the capacity
    // port reads that `null` as "admission is process-local".
    const auth = createGatewayAuthenticator([KEY_A], {
      scopeDeriver: (k) => `scope(${k})`,
      rateLimitScopeDeriver: (k) => `rate(${k})`,
      reuseScopeDeriver: (k) => `reuse(${k})`,
    });
    expect(auth.authenticate(`Bearer ${KEY_A}`)).toEqual({
      ok: true,
      keyId: "k0",
      scopeId: "scope(gw-fake-key-alpha)",
      rateLimitScopeId: "rate(gw-fake-key-alpha)",
      reuseScopeId: "reuse(gw-fake-key-alpha)",
      capacityScopeId: null,
    });
  });

  it("gives the capacity scope its own value, never another feature's", () => {
    // Every field is wired to its OWN deriver: reusing the idempotency scope
    // for capacity would let the two boundaries correlate and collide in Redis.
    const auth = createGatewayAuthenticator([KEY_A], {
      scopeDeriver: (k) => `scope(${k})`,
      rateLimitScopeDeriver: (k) => `rate(${k})`,
      reuseScopeDeriver: (k) => `reuse(${k})`,
      capacityScopeDeriver: (k) => `capacity(${k})`,
    });
    const result = auth.authenticate(`Bearer ${KEY_A}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.capacityScopeId).toBe("capacity(gw-fake-key-alpha)");
      expect(result.capacityScopeId).not.toBe(result.scopeId);
      expect(result.capacityScopeId).not.toBe(result.rateLimitScopeId);
      expect(result.capacityScopeId).not.toBe(result.reuseScopeId);
    }
  });

  it("does not short-circuit the comparison loop when a key matches", () => {
    // A spy comparator (over SHA-256 digests, never raw keys) proves every
    // configured key is compared even though the FIRST one matches.
    const compare = vi.fn((a: Buffer, b: Buffer) => timingSafeEqual(a, b));
    const auth = createGatewayAuthenticator([KEY_A, KEY_B], { compare });
    expect(auth.authenticate(`Bearer ${KEY_A}`)).toEqual(unscoped("k0"));
    expect(compare).toHaveBeenCalledTimes(2);
    // The comparator only ever sees 32-byte digests, not key material.
    for (const call of compare.mock.calls) {
      expect(call[0]).toHaveLength(32);
      expect(call[1]).toHaveLength(32);
    }
  });

  it("surfaces only an opaque identity, never the presented token or a configured key", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    const result = auth.authenticate(`Bearer ${KEY_A}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyId).toMatch(/^k\d+$/);
      expect(result.keyId).not.toContain(KEY_A);
      expect(JSON.stringify(result)).not.toContain(KEY_A);
    }
  });
});
