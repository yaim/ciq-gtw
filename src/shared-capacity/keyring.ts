/**
 * Shared-capacity key derivation (Phase 4D; specification sections 19.2, 21.1,
 * 22.2).
 *
 * The configured 32-byte master key (`IDEMPOTENCY_ENCRYPTION_KEY`) is reused as
 * HKDF input keying material, but this boundary expands it under its OWN salt
 * and `info` label, so the capacity HMAC key is cryptographically independent of
 * every idempotency, rate-limit, and thread-reuse subkey. Two consequences
 * matter:
 *
 *  - a capacity scope can never be reinterpreted as any other feature's scope
 *    (or vice versa), so the features cannot correlate or collide in Redis;
 *  - changing anything here can never alter an existing derivation for another
 *    feature, because no code is shared with `../idempotency/keyring.ts`,
 *    `../rate-limit/keyring.ts`, or `../thread-reuse/keyring.ts`. The small
 *    length-framing helper is DELIBERATELY duplicated rather than extracted:
 *    the four boundaries must be able to evolve without the risk of silently
 *    re-keying already-stored records of another feature.
 *
 * Derivation is deterministic, so every replica configured with the same master
 * key computes the same scope for the same gateway key — which is exactly what
 * makes one active-permit budget span replicas — and it is independent of the
 * ORDER of `COLLECTIVIQ_GATEWAY_KEYS`, unlike the process-local capacity
 * identity `k<index>` (section 9.1), which must never be written to Redis.
 *
 * Nothing here is ever logged: the master key, the subkey, the derived scope,
 * and the registry key are all secret or scope-identifying material.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { IDEMPOTENCY_LIMITS } from "../config/schema.js";

/** Fixed HKDF salt. Distinct from every other feature's salt; constant across replicas. */
const HKDF_SALT = "collectiviq-gateway/shared-capacity/v1";

/** Fixed HKDF `info` label defining this key domain. */
const INFO_CAPACITY_KEY = "ciq-cap:v1:capacity-key";

/** Fixed domain tags mixed into each HMAC input (defence in depth beyond HKDF). */
const SCOPE_TAG = "cap-gateway-key:v1";
const STORAGE_TAG = "cap-storage:v1";

const SUBKEY_BYTES = 32;

/** The single subkey this boundary derives from the configured master key. */
export interface SharedCapacityKeyring {
  /** HMAC key for the gateway-key scope and the Redis registry key. */
  readonly capacityKey: Buffer;
}

/**
 * Expand the configured master key into the shared-capacity keyring.
 *
 * @param encodedMasterKey the validated canonical unpadded base64url master key.
 * @throws {Error} when the decoded key is not exactly 32 bytes. Configuration
 *   validation already guarantees this; the check is a fail-closed backstop and
 *   its message contains no key material.
 */
export function deriveSharedCapacityKeyring(encodedMasterKey: string): SharedCapacityKeyring {
  const master = Buffer.from(encodedMasterKey, "base64url");
  if (master.length !== IDEMPOTENCY_LIMITS.encryptionKeyBytes) {
    throw new Error("shared-capacity master key has an unsupported size");
  }
  return {
    capacityKey: Buffer.from(
      hkdfSync("sha256", master, HKDF_SALT, INFO_CAPACITY_KEY, SUBKEY_BYTES),
    ),
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
 * Derive the stable, opaque CAPACITY scope for one configured gateway key.
 *
 * Computed ONCE per configured key at authenticator construction, so the raw
 * gateway key is never re-read per request. The scope is never logged,
 * reflected, or exposed, and it is a different value from this key's
 * idempotency, rate-limit, and thread-reuse scopes.
 *
 * The digest is unpadded base64url, which is what lets a ZSET member encode
 * `version | owner | scope` with an unambiguous out-of-alphabet delimiter.
 */
export function deriveCapacityScope(keyring: SharedCapacityKeyring, rawGatewayKey: string): string {
  return createHmac("sha256", keyring.capacityKey)
    .update(framed([SCOPE_TAG, rawGatewayKey]), "utf8")
    .digest("base64url");
}

/**
 * Build the ONE namespace-level Redis registry key holding every active permit.
 *
 * There is deliberately no per-scope component: the global limit has to be
 * counted across all gateway keys, which a per-scope key could not do
 * atomically. Per-key occupancy is instead counted from the scope carried inside
 * each member.
 *
 * The identifying part is an HMAC, so Redis holds no gateway key, no
 * authorization value, and nothing that can be correlated back to a tenant. The
 * namespace is a readable prefix purely so operators can scope operational
 * commands, and the fixed `capacity` category keeps the registry from ever
 * colliding with the `idem`, `rate`, or `reuse` keyspaces.
 */
export function buildCapacityRegistryKey(
  keyring: SharedCapacityKeyring,
  namespace: string,
): string {
  const digest = createHmac("sha256", keyring.capacityKey)
    .update(framed([STORAGE_TAG, namespace]), "utf8")
    .digest("base64url");
  return `${namespace}:capacity:${digest}`;
}
