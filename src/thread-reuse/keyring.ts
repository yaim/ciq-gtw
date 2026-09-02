/**
 * Thread-reuse key derivation and mapping identity (Phase 5A; specification
 * sections 5.1.1, 21.1, 22.2).
 *
 * The configured 32-byte master key (`IDEMPOTENCY_ENCRYPTION_KEY`) is reused as
 * HKDF input keying material, but this boundary expands it under its OWN salt
 * and `info` labels, so every subkey here is cryptographically independent of
 * every Phase 4A idempotency subkey and of the Phase 4B rate-limit subkey. Two
 * consequences matter:
 *
 *  - a reuse scope, storage key, or fingerprint can never be reinterpreted
 *    under another feature's domain, so the three features cannot correlate or
 *    collide in Redis;
 *  - changing anything here can never alter an existing idempotency or
 *    rate-limit derivation, because no code is shared with
 *    `../idempotency/keyring.ts` or `../rate-limit/keyring.ts`. The small
 *    length-framing helper is DELIBERATELY duplicated for the same reason the
 *    rate limiter duplicates it: the boundaries must be able to evolve without
 *    the risk of silently re-keying already-stored records.
 *
 * Derivation is deterministic, so every replica configured with the same master
 * key computes the same scope, fingerprints, and storage key — which is what
 * lets one OpenCode session address one upstream thread from any replica — and
 * it is independent of the ORDER of `COLLECTIVIQ_GATEWAY_KEYS`.
 *
 * Nothing here is ever logged. The master key, every subkey, the session id,
 * the raw gateway key, the upstream credential material, the derived scope, the
 * fingerprints, and the storage key are all secret or identity-bearing.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { IDEMPOTENCY_LIMITS, type VirtualModel } from "../config/schema.js";

/** Fixed HKDF salt. Distinct from the idempotency and rate-limit salts. */
const HKDF_SALT = "collectiviq-gateway/thread-reuse/v1";

/** Fixed HKDF `info` labels; each one defines a separate key domain. */
const INFO_SCOPE = "ciq-reuse:v1:scope";
const INFO_STORAGE = "ciq-reuse:v1:storage";
const INFO_AEAD = "ciq-reuse:v1:aead";
const INFO_NAMESPACE = "ciq-reuse:v1:namespace";

/** Fixed domain tags mixed into each HMAC input (defence in depth beyond HKDF). */
const SCOPE_TAG = "reuse-gateway-key:v1";
const STORAGE_TAG = "reuse-storage:v1";
const IDENTITY_TAG = "reuse-identity:v1";
const POLICY_TAG = "reuse-policy:v1";
const PRINCIPAL_TAG = "reuse-principal:v1";

const SUBKEY_BYTES = 32;

/** The four domain-separated subkeys derived from the configured master key. */
export interface ThreadReuseKeyring {
  /** HMAC key for the per-gateway-key reuse scope. */
  readonly scopeKey: Buffer;
  /** HMAC key for the Redis storage key. */
  readonly storageKey: Buffer;
  /** AES-256-GCM key sealing the upstream thread id at rest. */
  readonly aeadKey: Buffer;
  /**
   * HMAC key for the value-free namespace fingerprints: the normalized
   * model-policy fingerprint, the upstream-principal fingerprint, and the
   * mapping-identity digest bound into the AEAD associated data.
   */
  readonly namespaceKey: Buffer;
}

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, info, SUBKEY_BYTES));
}

/**
 * Expand the configured master key into the thread-reuse keyring.
 *
 * @param encodedMasterKey the validated canonical unpadded base64url master key.
 * @throws {Error} when the decoded key is not exactly 32 bytes. Configuration
 *   validation already guarantees this; the check is a fail-closed backstop and
 *   its message contains no key material.
 */
export function deriveThreadReuseKeyring(encodedMasterKey: string): ThreadReuseKeyring {
  const master = Buffer.from(encodedMasterKey, "base64url");
  if (master.length !== IDEMPOTENCY_LIMITS.encryptionKeyBytes) {
    throw new Error("thread-reuse master key has an unsupported size");
  }
  return {
    scopeKey: derive(master, INFO_SCOPE),
    storageKey: derive(master, INFO_STORAGE),
    aeadKey: derive(master, INFO_AEAD),
    namespaceKey: derive(master, INFO_NAMESPACE),
  };
}

/**
 * Length-prefix each component so no two different component tuples can produce
 * the same HMAC input by concatenation. Without this an identity of
 * `("ab", "c")` and one of `("a", "bc")` would hash identically and two
 * different sessions could share one upstream thread.
 */
function framed(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    out += `${Buffer.byteLength(part, "utf8")}:${part}|`;
  }
  return out;
}

/**
 * Derive the stable, opaque REUSE scope for one configured gateway key.
 *
 * Computed ONCE per configured key at authenticator construction, so the raw
 * gateway key is never re-read per request. The scope is never logged,
 * reflected, or exposed, and it is a different value from both the idempotency
 * scope and the rate-limit scope for the same key.
 */
export function deriveThreadReuseScope(keyring: ThreadReuseKeyring, rawGatewayKey: string): string {
  return createHmac("sha256", keyring.scopeKey)
    .update(framed([SCOPE_TAG, rawGatewayKey]), "utf8")
    .digest("base64url");
}

/**
 * The value-free fingerprint of the ACTIVE upstream principal.
 *
 * A mapping must never survive a change of upstream identity: a thread created
 * under one principal may be invisible, or forbidden, to another. The input is
 * the auth mode plus the CONFIGURED credential material for that mode — the
 * bearer token, or the username in password mode. The transient OAuth access
 * token is deliberately NOT used: it rotates on every login, which would
 * needlessly re-partition mappings for the same principal.
 *
 * Only the HMAC output leaves this function; the raw material is never stored,
 * logged, or returned.
 */
export function deriveUpstreamPrincipalFingerprint(
  keyring: ThreadReuseKeyring,
  input: { readonly authMode: string; readonly credentialMaterial: string },
): string {
  return createHmac("sha256", keyring.namespaceKey)
    .update(framed([PRINCIPAL_TAG, input.authMode, input.credentialMaterial]), "utf8")
    .digest("base64url");
}

/**
 * The value-free fingerprint of a resolved virtual model's NORMALIZED policy.
 *
 * Any policy change — a different source set, a different answer source, a
 * different combined mode, a different prompt or tool mode — produces a
 * different mapping, so a reconfigured model can never continue a thread whose
 * earlier turns were generated under different routing. `selectedLlms` is
 * ORDER-SIGNIFICANT because its order is itself part of the policy.
 */
export function deriveModelPolicyFingerprint(
  keyring: ThreadReuseKeyring,
  model: VirtualModel,
): string {
  return createHmac("sha256", keyring.namespaceKey)
    .update(
      framed([
        POLICY_TAG,
        model.id,
        String(model.selectedLlms.length),
        ...model.selectedLlms,
        model.generateCombined ? "1" : "0",
        model.answerSource,
        model.promptMode,
        model.toolMode,
      ]),
      "utf8",
    )
    .digest("base64url");
}

/** Everything a mapping's identity binds. All five components are required. */
export interface MappingIdentity {
  /** The stable per-gateway-key reuse scope. */
  readonly gatewayKeyScope: string;
  /** The validated, opaque OpenCode session id. */
  readonly sessionId: string;
  /** {@link deriveModelPolicyFingerprint} for the resolved model. */
  readonly policyFingerprint: string;
  /** The validated CollectivIQ origin (`COLLECTIVIQ_BASE_URL`). */
  readonly origin: string;
  /** {@link deriveUpstreamPrincipalFingerprint} for the active principal. */
  readonly principalFingerprint: string;
}

function identityParts(namespace: string, identity: MappingIdentity): readonly string[] {
  return [
    namespace,
    identity.gatewayKeyScope,
    identity.sessionId,
    identity.policyFingerprint,
    identity.origin,
    identity.principalFingerprint,
  ];
}

/**
 * Build the Redis storage key for one mapping identity.
 *
 * The identifying part is an HMAC over every component, so Redis holds no raw
 * session id, gateway key, upstream credential, model id, or origin — and an
 * operator inspecting Redis cannot correlate a key back to a session or a
 * tenant. The namespace is a readable prefix purely so operators can scope
 * operational commands, and the fixed `reuse` category keeps mapping keys from
 * ever colliding with the `idem` or `rate` keyspaces.
 */
export function buildReuseStorageKey(
  keyring: ThreadReuseKeyring,
  namespace: string,
  identity: MappingIdentity,
): string {
  const digest = createHmac("sha256", keyring.storageKey)
    .update(framed([STORAGE_TAG, ...identityParts(namespace, identity)]), "utf8")
    .digest("base64url");
  return `${namespace}:reuse:${digest}`;
}

/**
 * An INDEPENDENT digest of the same mapping identity, derived under the
 * namespace subkey rather than the storage subkey.
 *
 * It is bound into the sealed thread id's associated data, so a ciphertext
 * relocated to another mapping's key fails authentication even if an actor with
 * Redis write access also forges a matching storage key. Deriving it under a
 * different subkey than the storage key means neither value can be computed
 * from the other.
 */
export function buildMappingIdentityDigest(
  keyring: ThreadReuseKeyring,
  namespace: string,
  identity: MappingIdentity,
): string {
  return createHmac("sha256", keyring.namespaceKey)
    .update(framed([IDENTITY_TAG, ...identityParts(namespace, identity)]), "utf8")
    .digest("base64url");
}
