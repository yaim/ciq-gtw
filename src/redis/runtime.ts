/**
 * The Redis COMPOSITION ROOT (specification sections 18.1, 19.1, 28.2, 31.3).
 *
 * This is the only place that turns validated configuration into live
 * Redis-backed services, and it creates EXACTLY ONE client for the process no
 * matter how many of them are enabled. Phase 4A idempotency, Phase 4B rate
 * limiting, and Phase 5A OpenCode thread reuse therefore share one connection,
 * one reconnect policy, one readiness probe, and one shutdown close — a second
 * client would double the socket budget, split readiness, and make "Redis is
 * up" mean two different things.
 *
 * It is deliberately NOT exported from `src/redis/index.ts`: the substrate
 * barrel must stay dependency-free so features can import it without a cycle.
 * The process root imports this module directly.
 *
 * Construction opens no socket. Only the process root calls `connect()` and
 * `close()`, and `close()` runs LAST during shutdown — after the application has
 * drained — so an in-flight completion can still settle its idempotency record.
 */
import type { AppConfig } from "../config/schema.js";
import {
  createIdempotencyCoordinatorFromConfig,
  type IdempotencyCoordinator,
} from "../idempotency/index.js";
import { createRateLimiterFromConfig, type RateLimiter } from "../rate-limit/index.js";
import {
  createThreadReuseCoordinatorFromConfig,
  type ThreadReuseCoordinator,
} from "../thread-reuse/index.js";
import { createRedisConnection, type RedisConnectionOptions } from "./client.js";

/** The composed Redis-backed services owned by the process root. */
export interface RedisRuntime {
  /**
   * Cross-replica idempotency (Phase 4A). Present whenever `REDIS_URL` is
   * configured; `null` is impossible here because the runtime itself is `null`
   * without a URL, but the type keeps the composition honest.
   */
  readonly idempotency: IdempotencyCoordinator | null;
  /** Cross-replica rate limiting (Phase 4B). `null` unless explicitly enabled. */
  readonly rateLimiter: RateLimiter | null;
  /** Cross-replica OpenCode thread reuse (Phase 5A). `null` unless explicitly enabled. */
  readonly threadReuse: ThreadReuseCoordinator | null;
  /** Bounded, synchronous readiness probe over the ONE shared connection (no I/O). */
  isReady(): boolean;
  /** Begin connecting in the background. Never throws, never blocks startup. */
  connect(): void;
  /** Bounded graceful close with force-destroy fallback. Never rejects. */
  close(): Promise<void>;
}

export type RedisRuntimeOptions = Omit<RedisConnectionOptions, "url">;

/**
 * Compose every enabled Redis-backed service over one connection, or `null` when
 * `REDIS_URL` is blank/absent — in which case the gateway never contacts Redis,
 * a supplied `Idempotency-Key` fails closed with `503`, and both rate limiting
 * and thread reuse are necessarily disabled too (configuration validation
 * rejects enabling either without a Redis endpoint).
 */
export function createRedisRuntime(
  config: AppConfig,
  options: RedisRuntimeOptions = {},
): RedisRuntime | null {
  if (config.REDIS_URL === undefined) return null;

  const connection = createRedisConnection({ url: config.REDIS_URL, ...options });
  const { substrate } = connection;

  return {
    idempotency: createIdempotencyCoordinatorFromConfig(config, substrate),
    rateLimiter: createRateLimiterFromConfig(config, substrate),
    threadReuse: createThreadReuseCoordinatorFromConfig(config, substrate),
    isReady: () => connection.isReady(),
    connect: () => connection.connect(),
    close: () => connection.close(),
  };
}
