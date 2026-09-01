/**
 * Idempotency key derivation (Phase 4A; specification sections 18, 21.1, 22.2).
 *
 * One configured 32-byte master key (`IDEMPOTENCY_ENCRYPTION_KEY`) is expanded
 * with HKDF-SHA-256 into three DOMAIN-SEPARATED subkeys, using only Node's
 * built-in cryptography:
 *
 *  - `redisKey` — HMAC key for the Redis storage key and the gateway-key scope;
 *  - `bodyKey`  — HMAC key for the canonical request-body fingerprint;
 *  - `aeadKey`  — AES-256-GCM key for the encrypted final payload.
 *
 * Domain separation means a value computed under one subkey can never be
 * reinterpreted under another, and no derived value discloses the master key.
 *
 * Derivation is deterministic: the same master key yields the same subkeys on
 * every replica, which is what makes a scope, a storage key, and a fingerprint
 * comparable across replicas. It follows that ALL replicas must be configured
 * with the same master key, namespace, Redis endpoint, and gateway-key set;
 * mixing master keys during a rolling deployment is unsupported (a request
 * served by a replica with a different key simply computes a different storage
 * key and cannot see the other replica's records).
 *
 * Nothing here is ever logged: the master key, every subkey, the derived scope,
 * and the storage key are all secret or scope-identifying material.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { IDEMPOTENCY_LIMITS } from "../config/schema.js";

/** Fixed HKDF salt. Constant across replicas so derivation is reproducible. */
const HKDF_SALT = "collectiviq-gateway/idempotency/v1";

/** Fixed HKDF `info` labels; each one defines a separate key domain. */
const INFO_REDIS_KEY = "ciq-idem:v1:redis-key";
const INFO_BODY = "ciq-idem:v1:body";
const INFO_AEAD = "ciq-idem:v1:aead";

/** Fixed domain tags mixed into each HMAC input (defence in depth beyond HKDF). */
const SCOPE_TAG = "gateway-key:v1";
const STORAGE_TAG = "storage:v1";

const SUBKEY_BYTES = 32;

/** The three domain-separated subkeys derived from the configured master key. */
export interface IdempotencyKeyring {
  /** HMAC key for the Redis storage key and the gateway-key scope. */
  readonly redisKey: Buffer;
  /** HMAC key for the canonical request-body fingerprint. */
  readonly bodyKey: Buffer;
  /** AES-256-GCM key for the encrypted final payload. */
  readonly aeadKey: Buffer;
}

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, info, SUBKEY_BYTES));
}

/**
 * Expand the configured master key into the keyring.
 *
 * @param encodedMasterKey the validated canonical unpadded base64url master key.
 * @throws {Error} when the decoded key is not exactly 32 bytes. Configuration
 *   validation already guarantees this; the check is a fail-closed backstop and
 *   its message contains no key material.
 */
export function deriveIdempotencyKeyring(encodedMasterKey: string): IdempotencyKeyring {
  const master = Buffer.from(encodedMasterKey, "base64url");
  if (master.length !== IDEMPOTENCY_LIMITS.encryptionKeyBytes) {
    throw new Error("idempotency master key has an unsupported size");
  }
  return {
    redisKey: derive(master, INFO_REDIS_KEY),
    bodyKey: derive(master, INFO_BODY),
    aeadKey: derive(master, INFO_AEAD),
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
 * Derive the stable, opaque Redis SCOPE for one configured gateway key.
 *
 * The scope is a keyed HMAC of the raw gateway key, so it is identical on every
 * replica and independent of the key's position in `COLLECTIVIQ_GATEWAY_KEYS`
 * (unlike the process-local capacity identity `k<index>`, which is ordering
 * dependent). Reordering or adding keys therefore never re-partitions existing
 * idempotency state, and two different gateway keys can never share cached
 * results. The scope is never logged, reflected, or exposed.
 */
export function deriveGatewayKeyScope(keyring: IdempotencyKeyring, rawGatewayKey: string): string {
  return createHmac("sha256", keyring.redisKey)
    .update(framed([SCOPE_TAG, rawGatewayKey]), "utf8")
    .digest("base64url");
}

/**
 * Build the Redis storage key for one `(namespace, gateway-key scope, client
 * idempotency key)` triple.
 *
 * The identifying part is an HMAC over all three components, so Redis never
 * holds the client's raw idempotency key and an operator inspecting Redis
 * cannot correlate a key back to a tenant or a request. The namespace is also
 * used as a readable prefix purely so operators can scope operational commands.
 */
export function buildStorageKey(
  keyring: IdempotencyKeyring,
  namespace: string,
  gatewayKeyScope: string,
  clientKey: string,
): string {
  const digest = createHmac("sha256", keyring.redisKey)
    .update(framed([STORAGE_TAG, namespace, gatewayKeyScope, clientKey]), "utf8")
    .digest("base64url");
  return `${namespace}:idem:${digest}`;
}
