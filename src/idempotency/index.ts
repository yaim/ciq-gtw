/**
 * Public surface of the optional Redis-backed idempotency boundary (Phase 4A).
 *
 * Consumers outside `src/idempotency/` import from here. The Lua scripts, the
 * derived subkeys, and the record/payload wire formats stay internal to this
 * boundary — nothing above it knows how idempotency state is stored. The
 * connection itself belongs to the shared substrate in `src/redis/`, which the
 * Redis composition root wires in.
 */
export {
  createIdempotencyCoordinator,
  type BeginInput,
  type BeginOutcome,
  type CompletionIdentity,
  type IdempotencyCoordinator,
  type IdempotencyCoordinatorDeps,
  type IdempotencyOwnerSession,
  type ResolveOutcome,
} from "./coordinator.js";
export {
  IDEMPOTENCY_KEY_HEADER,
  readIdempotencyKeyHeader,
  type IdempotencyHeaderResult,
} from "./header.js";
export { fingerprintRequestBody, type FingerprintResult } from "./fingerprint.js";
export {
  buildStorageKey,
  deriveGatewayKeyScope,
  deriveIdempotencyKeyring,
  type IdempotencyKeyring,
} from "./keyring.js";
export {
  decodeCachedCompletion,
  encodeCachedCompletion,
  type CachedCompletion,
  type CachedResult,
} from "./payload.js";
export {
  buildGatewayScopeDeriver,
  createIdempotencyCoordinatorFromConfig,
  type GatewayKeyScopeDeriver,
} from "./runtime.js";
export { createRedisIdempotencyStore } from "./redis-store.js";
export type {
  ActiveLeases,
  CasResult,
  ClaimResult,
  IdempotencyStore,
  ReadResult,
} from "./store.js";
export {
  RECORD_STATES,
  RECORD_VERSION,
  decodeRecord,
  encodeRecord,
  type IdempotencyRecord,
  type RecordState,
} from "./records.js";
