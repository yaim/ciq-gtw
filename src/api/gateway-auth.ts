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
 * The result of authenticating a presented credential. On success it carries an
 * OPAQUE, stable per-configured-key identity (`keyId`) derived from the matched
 * key's configuration index — never the raw key or its digest. The identity is
 * used only for process-local per-key capacity accounting.
 */
export type AuthResult = { readonly ok: true; readonly keyId: string } | { readonly ok: false };

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

/**
 * Build an authenticator over the configured gateway keys.
 *
 * @param keys the validated, bounded gateway keys (1–64, each ≤ 8 KiB UTF-8).
 * @param compare fixed-length comparison seam; defaults to `timingSafeEqual`.
 *   Injectable only so a test can prove the comparison loop is not
 *   short-circuited. It receives SHA-256 digests, never raw key material.
 */
export function createGatewayAuthenticator(
  keys: readonly string[],
  compare: (a: Buffer, b: Buffer) => boolean = timingSafeEqual,
): GatewayAuthenticator {
  // Precompute one fixed-length digest per configured key.
  const digests = keys.map((key) => sha256(key));

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
      // The matched index (if any) yields only an opaque identity.
      let matchedIndex = -1;
      for (let i = 0; i < digests.length; i += 1) {
        const digest = digests[i];
        if (digest !== undefined && digest.length === DIGEST_BYTES && compare(presented, digest)) {
          matchedIndex = i;
        }
      }
      return matchedIndex >= 0 ? { ok: true, keyId: keyIdForIndex(matchedIndex) } : { ok: false };
    },
  };
}
