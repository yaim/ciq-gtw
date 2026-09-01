/**
 * Rate-limit runtime composition (Phase 4B; specification section 19.1).
 *
 * Wires validated configuration into the concrete limiter. The feature is OFF
 * unless `RATE_LIMIT_ENABLED=true`, which configuration validation additionally
 * requires to be accompanied by a valid `REDIS_URL` (and therefore, by the
 * existing Phase 4A rule, by `IDEMPOTENCY_ENCRYPTION_KEY`). When it is off this
 * module produces nothing at all: no scope is derived, no limiter is built, and
 * no Redis command is ever issued for rate limiting.
 *
 * Construction performs NO I/O and creates no client: the connection is owned by
 * the Redis composition root (`src/redis/runtime.ts`).
 */
import type { AppConfig } from "../config/schema.js";
import type { RedisSubstrate } from "../redis/index.js";
import { deriveRateLimitKeyring, deriveRateLimitScope, type RateLimitKeyring } from "./keyring.js";
import { createRedisRateLimiter } from "./redis-limiter.js";
import type { RateLimiter } from "./types.js";

/**
 * Derives the per-gateway-key rate-limit scope. Present only when the limiter is
 * enabled; the gateway authenticator exposes `rateLimitScopeId: null` otherwise.
 */
export type RateLimitScopeDeriver = (rawGatewayKey: string) => string;

/**
 * Derive the keyring when rate limiting is enabled. Requires the master key,
 * which configuration validation guarantees is present whenever the feature is
 * enabled (enabling it requires Redis, and Redis requires the key).
 */
function buildKeyring(config: AppConfig): RateLimitKeyring | null {
  if (!config.RATE_LIMIT_ENABLED) return null;
  if (config.IDEMPOTENCY_ENCRYPTION_KEY === undefined) return null;
  return deriveRateLimitKeyring(config.IDEMPOTENCY_ENCRYPTION_KEY);
}

/**
 * Build the per-gateway-key scope deriver from validated configuration, or
 * `null` when rate limiting is disabled. Pure: HKDF/HMAC only, no I/O, no socket
 * — so `buildServer` can call it during construction.
 */
export function buildRateLimitScopeDeriver(config: AppConfig): RateLimitScopeDeriver | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;
  return (rawGatewayKey: string) => deriveRateLimitScope(keyring, rawGatewayKey);
}

/**
 * Compose the limiter over the shared Redis substrate, or `null` when rate
 * limiting is disabled. Performs no I/O.
 */
export function createRateLimiterFromConfig(
  config: AppConfig,
  substrate: RedisSubstrate,
): RateLimiter | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;

  return createRedisRateLimiter({
    substrate,
    keyring,
    namespace: config.REDIS_KEY_PREFIX,
    requests: config.RATE_LIMIT_REQUESTS,
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    burst: config.RATE_LIMIT_BURST,
  });
}
