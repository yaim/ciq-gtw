/**
 * Rate-limit key derivation (Phase 4B; specification sections 19.1, 21.1, 22.2).
 *
 * The configured 32-byte master key (`IDEMPOTENCY_ENCRYPTION_KEY`) is reused as
 * HKDF input keying material, but this boundary expands it under its OWN salt
 * and `info` label, so the rate-limit HMAC key is cryptographically independent
 * of every idempotency subkey. Two consequences matter:
 *
 *  - a rate-limit scope can never be reinterpreted as an idempotency scope (or
 *    vice versa), so the two features cannot correlate or collide in Redis;
 *  - changing anything here can never alter an existing idempotency derivation,
 *    because no code is shared with `../idempotency/keyring.ts`. The small
 *    length-framing helper is DELIBERATELY duplicated rather than extracted:
 *    the two boundaries must be able to evolve without the risk of silently
 *    re-keying already-stored idempotency records.
 *
 * Derivation is deterministic, so every replica configured with the same master
 * key computes the same scope for the same gateway key — which is exactly what
 * makes one quota span replicas — and it is independent of the ORDER of
 * `COLLECTIVIQ_GATEWAY_KEYS`, unlike the process-local capacity identity
 * `k<index>` (section 9.1).
 *
 * Nothing here is ever logged: the master key, the subkey, the derived scope,
 * and the Redis key are all secret or scope-identifying material.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { IDEMPOTENCY_LIMITS } from "../config/schema.js";

/** Fixed HKDF salt. Distinct from the idempotency salt; constant across replicas. */
const HKDF_SALT = "collectiviq-gateway/rate-limit/v1";

/** Fixed HKDF `info` label defining this key domain. */
const INFO_RATE_KEY = "ciq-rl:v1:rate-key";

/** Fixed domain tags mixed into each HMAC input (defence in depth beyond HKDF). */
const SCOPE_TAG = "rl-gateway-key:v1";
const STORAGE_TAG = "rl-storage:v1";

const SUBKEY_BYTES = 32;

/** The single subkey this boundary derives from the configured master key. */
export interface RateLimitKeyring {
  /** HMAC key for the gateway-key scope and the Redis quota key. */
  readonly rateKey: Buffer;
}

/**
 * Expand the configured master key into the rate-limit keyring.
 *
 * @param encodedMasterKey the validated canonical unpadded base64url master key.
 * @throws {Error} when the decoded key is not exactly 32 bytes. Configuration
 *   validation already guarantees this; the check is a fail-closed backstop and
 *   its message contains no key material.
 */
export function deriveRateLimitKeyring(encodedMasterKey: string): RateLimitKeyring {
  const master = Buffer.from(encodedMasterKey, "base64url");
  if (master.length !== IDEMPOTENCY_LIMITS.encryptionKeyBytes) {
    throw new Error("rate-limit master key has an unsupported size");
  }
  return {
    rateKey: Buffer.from(hkdfSync("sha256", master, HKDF_SALT, INFO_RATE_KEY, SUBKEY_BYTES)),
  };
}

/**
 * Length-prefix each component so no two different component tuples can produce
 * the same HMAC input by concatenation.
 */
function framed(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    out += `${Buffer.byteLength(part, "utf8")}:${part}|`;
  }
  return out;
}

/**
 * Derive the stable, opaque RATE-LIMIT scope for one configured gateway key.
 *
 * Computed ONCE per configured key at authenticator construction, so the raw
 * gateway key is never re-read per request. The scope is never logged,
 * reflected, or exposed, and it is a different value from the idempotency scope
 * for the same key.
 */
export function deriveRateLimitScope(keyring: RateLimitKeyring, rawGatewayKey: string): string {
  return createHmac("sha256", keyring.rateKey)
    .update(framed([SCOPE_TAG, rawGatewayKey]), "utf8")
    .digest("base64url");
}

/**
 * Build the Redis quota key for one `(namespace, gateway-key scope)` pair.
 *
 * The identifying part is an HMAC, so Redis holds no gateway key, no
 * authorization value, and nothing that can be correlated back to a tenant. The
 * namespace is a readable prefix purely so operators can scope operational
 * commands, and the fixed `rate` category keeps quota keys from ever colliding
 * with the `idem` keyspace.
 */
export function buildRateLimitKey(
  keyring: RateLimitKeyring,
  namespace: string,
  gatewayKeyScope: string,
): string {
  const digest = createHmac("sha256", keyring.rateKey)
    .update(framed([STORAGE_TAG, namespace, gatewayKeyScope]), "utf8")
    .digest("base64url");
  return `${namespace}:rate:${digest}`;
}
