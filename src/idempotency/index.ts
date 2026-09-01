/**
 * Public surface of the optional Redis-backed idempotency boundary (Phase 4A).
 *
 * Consumers outside `src/idempotency/` import from here. The Redis client, the
 * Lua scripts, and the record/payload wire formats stay internal to this
 * boundary — nothing above it knows Redis exists.
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
  createIdempotencyRuntime,
  type GatewayKeyScopeDeriver,
  type IdempotencyRuntime,
} from "./runtime.js";
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
