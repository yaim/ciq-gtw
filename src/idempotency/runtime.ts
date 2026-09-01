/**
 * Idempotency runtime composition (Phase 4A).
 *
 * Wires validated configuration into the concrete idempotency layer: derive the
 * keyring, create the Redis connection, and build the coordinator. Redis stays
 * OPTIONAL — when `REDIS_URL` is blank/absent this module produces nothing at
 * all and the gateway behaves exactly as it did before Phase 4A for unkeyed
 * requests (a supplied `Idempotency-Key` then fails closed with `503`).
 *
 * Construction performs NO I/O: the client is created but never connected here,
 * so `buildServer`, every test suite, and the compiled-import smoke test stay
 * socket-free. Only the process composition root calls `connect()`.
 */
import type { AppConfig } from "../config/schema.js";
import { systemClock } from "../generation/seams.js";
import type { Sleeper } from "../generation/types.js";
import { createIdempotencyCoordinator, type IdempotencyCoordinator } from "./coordinator.js";
import {
  deriveGatewayKeyScope,
  deriveIdempotencyKeyring,
  type IdempotencyKeyring,
} from "./keyring.js";
import { createRedisIdempotencyConnection } from "./redis-store.js";

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

/** The composed idempotency layer owned by the process root. */
export interface IdempotencyRuntime {
  readonly coordinator: IdempotencyCoordinator;
  /** Bounded, synchronous readiness probe (no I/O). */
  isReady(): boolean;
  /** Begin connecting in the background. Never throws, never blocks startup. */
  connect(): void;
  /** Bounded graceful close with force-destroy fallback. Never rejects. */
  close(): Promise<void>;
}

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
 * Compose the idempotency runtime from validated configuration, or `null` when
 * Redis is disabled. Creates the client WITHOUT connecting.
 */
export function createIdempotencyRuntime(config: AppConfig): IdempotencyRuntime | null {
  const keyring = buildKeyring(config);
  if (keyring === null || config.REDIS_URL === undefined) return null;

  const connection = createRedisIdempotencyConnection({ url: config.REDIS_URL });
  const coordinator = createIdempotencyCoordinator({
    store: connection.store,
    keyring,
    namespace: config.REDIS_KEY_PREFIX,
    ttlMs: config.IDEMPOTENCY_TTL_MS,
    clock: systemClock,
    sleeper: systemSleeper,
  });

  return {
    coordinator,
    isReady: () => connection.isReady(),
    connect: () => connection.connect(),
    close: () => connection.close(),
  };
}
