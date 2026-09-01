/**
 * Idempotency runtime composition (Phase 4A).
 *
 * Wires validated configuration into the concrete idempotency layer: derive the
 * keyring, build the store over the SHARED Redis substrate, and build the
 * coordinator. Redis stays OPTIONAL — when `REDIS_URL` is blank/absent this
 * module produces nothing at all and the gateway behaves exactly as it did
 * before Phase 4A for unkeyed requests (a supplied `Idempotency-Key` then fails
 * closed with `503`).
 *
 * Construction performs NO I/O and creates no client: the connection is owned by
 * the Redis composition root (`src/redis/runtime.ts`), so `buildServer`, every
 * test suite, and the compiled-import smoke test stay socket-free.
 */
import type { AppConfig } from "../config/schema.js";
import { systemClock } from "../generation/seams.js";
import type { Sleeper } from "../generation/types.js";
import type { RedisSubstrate } from "../redis/index.js";
import { createIdempotencyCoordinator, type IdempotencyCoordinator } from "./coordinator.js";
import {
  deriveGatewayKeyScope,
  deriveIdempotencyKeyring,
  type IdempotencyKeyring,
} from "./keyring.js";
import { createRedisIdempotencyStore } from "./redis-store.js";

/** Abort-aware sleep used by the waiter's bounded backoff. Clears its timer. */
const systemSleeper: Sleeper = {
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

/**
 * Derives the per-gateway-key Redis scope. Present only when idempotency is
 * enabled; the gateway authenticator exposes `scopeId: null` otherwise.
 */
export type GatewayKeyScopeDeriver = (rawGatewayKey: string) => string;

/**
 * Build the per-gateway-key scope deriver from validated configuration, or
 * `null` when idempotency is disabled. Pure: HKDF only, no I/O, no socket — so
 * `buildServer` can call it during construction.
 */
export function buildGatewayScopeDeriver(config: AppConfig): GatewayKeyScopeDeriver | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;
  return (rawGatewayKey: string) => deriveGatewayKeyScope(keyring, rawGatewayKey);
}

/**
 * Derive the keyring when idempotency is enabled. Requires BOTH a Redis URL and
 * the master key; configuration validation already guarantees the key is present
 * whenever the URL is.
 */
function buildKeyring(config: AppConfig): IdempotencyKeyring | null {
  if (config.REDIS_URL === undefined) return null;
  if (config.IDEMPOTENCY_ENCRYPTION_KEY === undefined) return null;
  return deriveIdempotencyKeyring(config.IDEMPOTENCY_ENCRYPTION_KEY);
}

/**
 * Compose the idempotency coordinator over the shared Redis substrate, or
 * `null` when Redis is disabled. Performs no I/O.
 */
export function createIdempotencyCoordinatorFromConfig(
  config: AppConfig,
  substrate: RedisSubstrate,
): IdempotencyCoordinator | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;

  return createIdempotencyCoordinator({
    store: createRedisIdempotencyStore(substrate),
    keyring,
    namespace: config.REDIS_KEY_PREFIX,
    ttlMs: config.IDEMPOTENCY_TTL_MS,
    clock: systemClock,
    sleeper: systemSleeper,
  });
}
