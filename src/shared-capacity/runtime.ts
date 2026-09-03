/**
 * Shared-capacity runtime composition (Phase 4D; specification section 19.2).
 *
 * Wires validated configuration into the concrete cross-replica controller: the
 * keyring, the one namespace-level registry key, the store over the SHARED Redis
 * substrate, and the coordinator. The feature is OFF unless
 * `SHARED_CAPACITY_ENABLED=true`, which configuration validation additionally
 * requires to be accompanied by a valid `REDIS_URL` (and therefore, by the
 * existing Phase 4A rule, by `IDEMPOTENCY_ENCRYPTION_KEY`). When it is off this
 * module produces nothing at all: no scope is derived, no coordinator is built,
 * and no Redis capacity operation is ever issued — the process-local controller
 * of specification section 19 stays exactly as it was.
 *
 * The two ACTIVE limits are reinterpreted, not replaced: `MAX_CONCURRENT_REQUESTS`
 * and `MAX_CONCURRENT_REQUESTS_PER_KEY` become CLUSTER-WIDE, while
 * `MAX_QUEUED_REQUESTS` and `MAX_QUEUE_WAIT_MS` stay per replica. No new tuning
 * variable and no new secret is introduced.
 *
 * Construction performs NO I/O and creates no client: the connection is owned by
 * the Redis composition root (`src/redis/runtime.ts`).
 */
import type { AppConfig } from "../config/schema.js";
import type { CapacityController } from "../generation/types.js";
import type { RedisSubstrate } from "../redis/index.js";
import { createSharedCapacityCoordinator } from "./coordinator.js";
import {
  buildCapacityRegistryKey,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
  type SharedCapacityKeyring,
} from "./keyring.js";
import { createRedisSharedCapacityStore } from "./redis-store.js";

/**
 * Derives the per-gateway-key capacity scope. Present only when shared capacity
 * is enabled; the gateway authenticator exposes `capacityScopeId: null`
 * otherwise.
 */
export type CapacityScopeDeriver = (rawGatewayKey: string) => string;

/**
 * Derive the keyring when shared capacity is enabled. Requires the master key,
 * which configuration validation guarantees is present whenever the feature is
 * enabled (enabling it requires Redis, and Redis requires the key).
 */
function buildKeyring(config: AppConfig): SharedCapacityKeyring | null {
  if (!config.SHARED_CAPACITY_ENABLED) return null;
  if (config.IDEMPOTENCY_ENCRYPTION_KEY === undefined) return null;
  return deriveSharedCapacityKeyring(config.IDEMPOTENCY_ENCRYPTION_KEY);
}

/**
 * Build the per-gateway-key scope deriver from validated configuration, or
 * `null` when shared capacity is disabled. Pure: HKDF/HMAC only, no I/O, no
 * socket — so `buildServer` can call it during construction.
 */
export function buildCapacityScopeDeriver(config: AppConfig): CapacityScopeDeriver | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;
  return (rawGatewayKey: string) => deriveCapacityScope(keyring, rawGatewayKey);
}

/**
 * Compose the cross-replica capacity controller over the shared Redis substrate,
 * or `null` when shared capacity is disabled. Performs no I/O.
 */
export function createSharedCapacityControllerFromConfig(
  config: AppConfig,
  substrate: RedisSubstrate,
): CapacityController | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;

  return createSharedCapacityCoordinator({
    store: createRedisSharedCapacityStore(substrate),
    registryKey: buildCapacityRegistryKey(keyring, config.REDIS_KEY_PREFIX),
    limits: {
      maxActive: config.MAX_CONCURRENT_REQUESTS,
      maxActivePerScope: config.MAX_CONCURRENT_REQUESTS_PER_KEY,
      maxQueued: config.MAX_QUEUED_REQUESTS,
      maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    },
  });
}
