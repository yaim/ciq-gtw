/**
 * Public surface of the OPTIONAL Redis-backed OpenCode thread reuse boundary
 * (Phase 5A; specification section 5.1.1).
 *
 * Consumers outside `src/thread-reuse/` import from here. The Lua scripts, the
 * derived subkeys, the mapping-identity framing, and the record wire format stay
 * internal to this boundary — nothing above it knows that a session-to-thread
 * mapping is stored in Redis at all. The connection itself belongs to the shared
 * substrate in `src/redis/`, which the Redis composition root wires in.
 *
 * `runtime.ts` IS re-exported here (matching the idempotency and rate-limit
 * barrels) because it composes only over an injected substrate; the process-wide
 * Redis composition root remains `src/redis/runtime.ts`, which is deliberately
 * absent from the substrate barrel so the dependency direction stays one-way.
 */
export {
  createThreadReuseCoordinator,
  type ReuseAcquireInput,
  type ReuseAcquireOutcome,
  type ThreadReuseCoordinator,
  type ThreadReuseCoordinatorDeps,
  type ThreadReuseSession,
} from "./coordinator.js";
export { openThreadId, sealThreadId, type SealedThread, type ThreadAeadBinding } from "./crypto.js";
export {
  buildMappingIdentityDigest,
  buildReuseStorageKey,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  type MappingIdentity,
  type ThreadReuseKeyring,
} from "./keyring.js";
export {
  MAX_REUSE_PROCESSING_LEASE_MS,
  MAX_REUSE_RECORD_BYTES,
  MAX_UPSTREAM_THREAD_ID_BYTES,
  REUSE_AMBIGUOUS_TTL_MS,
  REUSE_COMMITTED_TTL_MS,
  REUSE_EXPIRED_LEASE_GRACE_MS,
  REUSE_LEASE_MS,
  REUSE_LEASE_RENEW_INTERVAL_MS,
  REUSE_PROCESSING_LEASE_MARGIN_MS,
} from "./limits.js";
export {
  REUSE_RECORD_STATES,
  REUSE_RECORD_VERSION,
  decodeReuseRecord,
  encodeReuseRecord,
  newReuseOwnerToken,
  type ReuseRecordState,
  type ThreadReuseRecord,
} from "./records.js";
export { createRedisThreadReuseStore } from "./redis-store.js";
export {
  buildThreadReuseScopeDeriver,
  createThreadReuseCoordinatorFromConfig,
  type ThreadReuseScopeDeriver,
} from "./runtime.js";
export type {
  ReuseAcquireResult,
  ReuseCasResult,
  ReuseReleaseResult,
  ReuseTimings,
  ThreadReuseStore,
} from "./store.js";
