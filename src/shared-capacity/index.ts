/**
 * Public surface of the OPTIONAL cross-replica capacity boundary (Phase 4D;
 * specification section 19.2).
 *
 * Consumers above this boundary see only the shared {@link
 * import("../generation/types.js").CapacityController} port plus the composition
 * helpers below; they never learn that active permits live in Redis, and they
 * never see a registry key, a scope, an owner token, or a Lua reply.
 */
export {
  capacityLeaseMsFor,
  createSharedCapacityCoordinator,
  type CapacityScheduleFn,
  type CapacityTimer,
  type SharedCapacityCoordinatorDeps,
  type SharedCapacityLimits,
} from "./coordinator.js";
export {
  buildCapacityRegistryKey,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
  type SharedCapacityKeyring,
} from "./keyring.js";
export {
  CAPACITY_LEASE_MARGIN_MS,
  CAPACITY_MEMBER_DELIMITER,
  CAPACITY_MEMBER_VERSION,
  CAPACITY_OWNER_TOKEN_BYTES,
  CAPACITY_RETRY_BACKOFF_FACTOR,
  CAPACITY_RETRY_INITIAL_MS,
  CAPACITY_RETRY_JITTER_RATIO,
  CAPACITY_RETRY_MAX_MS,
  CAPACITY_SCOPE_BYTES,
  MAX_CAPACITY_CLAIM_BATCH,
  MAX_CAPACITY_LEASE_MS,
  MAX_CAPACITY_MEMBER_BYTES,
  MAX_CAPACITY_REGISTRY_MEMBERS,
} from "./limits.js";
export {
  CAPACITY_OWNER_FINAL_CHARS,
  CAPACITY_OWNER_TOKEN_CHARS,
  CAPACITY_SCOPE_CHARS,
  CAPACITY_SCOPE_FINAL_CHARS,
  encodeCapacityMember,
  isCanonicalCapacityOwner,
  isCanonicalCapacityScope,
  newCapacityOwnerToken,
} from "./members.js";
export { createRedisSharedCapacityStore } from "./redis-store.js";
export {
  buildCapacityScopeDeriver,
  createSharedCapacityControllerFromConfig,
  type CapacityScopeDeriver,
} from "./runtime.js";
export type {
  CapacityCandidate,
  CapacityClaimLimits,
  CapacityClaimResult,
  CapacityReleaseResult,
  SharedCapacityStore,
} from "./store.js";
