/**
 * Gateway client authentication.
 *
 * The gateway authenticates OpenCode (and any other client) with a bearer key
 * presented as `Authorization: Bearer <gateway-key>`. This key is entirely
 * separate from the CollectivIQ upstream credentials and is never forwarded
 * upstream, logged, or reflected in a response.
 *
 * Comparison is fixed-length and timing-safe: the configured keys are reduced
 * to SHA-256 digests once at construction, the presented token is hashed once,
 * and the digest is compared against every configured digest with
 * `timingSafeEqual`. The loop never returns early on a match, so the number of
 * comparisons does not depend on which key (if any) matched. No secret material
 * is retained beyond the digests, and neither the presented token nor any
 * configured key is ever placed in an error, log, or return value.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { GATEWAY_KEY_LIMITS } from "../config/schema.js";

/**
 * Maximum accepted size of a presented bearer token, in UTF-8 bytes. A larger
 * token is rejected before hashing (it can never match a bounded configured
 * key). This mirrors {@link GATEWAY_KEY_LIMITS.maxKeyBytes}.
 */
export const PRESENTED_TOKEN_MAX_BYTES = GATEWAY_KEY_LIMITS.maxKeyBytes;

/** The case-insensitive authentication scheme. */
const SCHEME = "bearer";

/** SHA-256 digest length, in bytes. All digests are exactly this length. */
const DIGEST_BYTES = 32;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The result of authenticating a presented credential.
 *
 * Success carries FIVE separate opaque identities for the matched key, and none
 * of them is the raw key or its digest:
 *
 *  - `keyId` — the PROCESS-LOCAL identity (`k<index>`), derived from the key's
 *    configuration index and used only for per-key capacity accounting when
 *    capacity is process-local. It is ordering dependent and meaningless outside
 *    this process, so it must never be written to shared state.
 *  - `scopeId` — the CROSS-REPLICA idempotency scope, an HMAC of the raw key
 *    under an HKDF-derived subkey. It is identical on every replica configured
 *    with the same encryption key and is independent of gateway-key ordering, so
 *    reordering or adding keys never re-partitions existing idempotency state.
 *    It is `null` when idempotency is disabled (no encryption key configured).
 *  - `rateLimitScopeId` — the CROSS-REPLICA rate-limit scope, derived the same
 *    way but under a SEPARATE HKDF salt/label, so it is a different value from
 *    `scopeId` for the same key and the two features can never share, correlate,
 *    or collide on a Redis key. It is `null` when rate limiting is disabled.
 *  - `reuseScopeId` — the CROSS-REPLICA OpenCode thread-reuse scope, derived the
 *    same way under a THIRD independent HKDF salt/label. It is `null` when
 *    thread reuse is disabled.
 *  - `capacityScopeId` — the CROSS-REPLICA capacity scope, derived the same way
 *    under a FOURTH independent HKDF salt/label. It is what makes the per-key
 *    ACTIVE limit span replicas, and it is the value written into the shared
 *    lease registry — never `keyId`, whose meaning differs per process. It is
 *    `null` when shared capacity is disabled.
 *
 * No identity is ever logged, reflected, or returned to a client.
 */
export type AuthResult =
  | {
      readonly ok: true;
      readonly keyId: string;
      readonly scopeId: string | null;
      readonly rateLimitScopeId: string | null;
      readonly reuseScopeId: string | null;
      readonly capacityScopeId: string | null;
    }
  | { readonly ok: false };

/** Authenticates a presented `Authorization` header against configured keys. */
export interface GatewayAuthenticator {
  /**
   * Return `{ ok: true, keyId }` only when `header` is a well-formed `Bearer`
   * credential whose token exactly matches a configured gateway key; the `keyId`
   * is an opaque, stable identity for the matched key. A missing, malformed,
   * empty, oversized, or incorrect credential returns `{ ok: false }` — the
   * caller maps every failure to the same fixed `401` response.
   */
  authenticate(header: string | undefined): AuthResult;
}

/** The fixed, opaque identity for a configured key at index `i`. */
function keyIdForIndex(index: number): string {
  return `k${index}`;
}

/**
 * Extract the verbatim token from an `Authorization` header value, or `null`
 * when the header is absent or does not use the `Bearer` scheme.
 *
 * Only the first space separates the scheme from the token; every remaining
 * character (including any further whitespace) is preserved verbatim so the
 * exact comparison below rejects padded or altered tokens.
 */
function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const separator = header.indexOf(" ");
  if (separator === -1) return null;
  const scheme = header.slice(0, separator);
  if (scheme.toLowerCase() !== SCHEME) return null;
  return header.slice(separator + 1);
}

/** Optional construction seams for {@link createGatewayAuthenticator}. */
export interface GatewayAuthenticatorOptions {
  /**
   * Fixed-length comparison seam; defaults to `timingSafeEqual`. Injectable only
   * so a test can prove the comparison loop is not short-circuited. It receives
   * SHA-256 digests, never raw key material.
   */
  readonly compare?: (a: Buffer, b: Buffer) => boolean;
  /**
   * Derives the stable cross-replica idempotency scope for a configured key.
   * Supplied only when Redis-backed idempotency is enabled; every scope is
   * precomputed once at construction so the raw key is not re-read per request.
   * Omitted means `scopeId` is always `null`.
   */
  readonly scopeDeriver?: (rawGatewayKey: string) => string;
  /**
   * Derives the stable cross-replica RATE-LIMIT scope for a configured key.
   * Supplied only when Redis-backed rate limiting is enabled, and independent of
   * {@link GatewayAuthenticatorOptions.scopeDeriver} — the two produce different
   * values for the same key. Precomputed once at construction for the same
   * reason. Omitted means `rateLimitScopeId` is always `null`.
   */
  readonly rateLimitScopeDeriver?: (rawGatewayKey: string) => string;
  /**
   * Derives the stable cross-replica OpenCode THREAD-REUSE scope for a
   * configured key. Supplied only when thread reuse is enabled, and independent
   * of the other derivers — each produces a different value for the same key.
   * Precomputed once at construction for the same reason. Omitted means
   * `reuseScopeId` is always `null`.
   */
  readonly reuseScopeDeriver?: (rawGatewayKey: string) => string;
  /**
   * Derives the stable cross-replica CAPACITY scope for a configured key.
   * Supplied only when shared capacity is enabled, and independent of the other
   * three derivers. Precomputed once at construction for the same reason.
   * Omitted means `capacityScopeId` is always `null`.
   */
  readonly capacityScopeDeriver?: (rawGatewayKey: string) => string;
}

/**
 * Build an authenticator over the configured gateway keys.
 *
 * @param keys the validated, bounded gateway keys (1–64, each ≤ 8 KiB UTF-8).
 * @param options optional comparison and idempotency-scope seams.
 */
export function createGatewayAuthenticator(
  keys: readonly string[],
  options: GatewayAuthenticatorOptions = {},
): GatewayAuthenticator {
  const compare = options.compare ?? timingSafeEqual;
  // Precompute one fixed-length digest per configured key.
  const digests = keys.map((key) => sha256(key));
  // Precompute all four opaque cross-replica scopes per configured key so the
  // raw key material is used exactly once, at construction, and never again per
  // request. They are derived under different HKDF domains, so a key's
  // idempotency, rate-limit, thread-reuse, and capacity scopes are unrelated
  // values.
  const derive = (deriver: ((key: string) => string) | undefined): (string | null)[] =>
    deriver === undefined ? keys.map(() => null) : keys.map((key) => deriver(key));
  const scopes = derive(options.scopeDeriver);
  const rateLimitScopes = derive(options.rateLimitScopeDeriver);
  const reuseScopes = derive(options.reuseScopeDeriver);
  const capacityScopes = derive(options.capacityScopeDeriver);

  return {
    authenticate(header: string | undefined): AuthResult {
      const token = extractBearerToken(header);
      if (token === null) return { ok: false };
      // Reject an oversized token before hashing; it can never match a
      // bounded configured key, and this bounds the work per request.
      if (Buffer.byteLength(token, "utf8") > PRESENTED_TOKEN_MAX_BYTES) return { ok: false };

      const presented = sha256(token);
      // All digests are exactly DIGEST_BYTES, so timingSafeEqual never throws
      // on a length mismatch. Compare against every configured digest without
      // returning early, so a match's position does not affect the work done.
      // The matched index (if any) yields only opaque identities.
      let matchedIndex = -1;
      for (let i = 0; i < digests.length; i += 1) {
        const digest = digests[i];
        if (digest !== undefined && digest.length === DIGEST_BYTES && compare(presented, digest)) {
          matchedIndex = i;
        }
      }
      if (matchedIndex < 0) return { ok: false };
      return {
        ok: true,
        keyId: keyIdForIndex(matchedIndex),
        scopeId: scopes[matchedIndex] ?? null,
        rateLimitScopeId: rateLimitScopes[matchedIndex] ?? null,
        reuseScopeId: reuseScopes[matchedIndex] ?? null,
        capacityScopeId: capacityScopes[matchedIndex] ?? null,
      };
    },
  };
}
