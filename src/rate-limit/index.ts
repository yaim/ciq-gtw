/**
 * Public surface of the OPTIONAL Redis-backed cross-replica rate limiter
 * (Phase 4B; specification section 19.1).
 *
 * Consumers outside `src/rate-limit/` import from here. The Lua script, the
 * derived subkey, the GCRA arithmetic, and the Redis key shape stay internal to
 * this boundary — the API layer sees only a closed decision union and owns every
 * public status, header, and envelope.
 */
export { computeGcraParameters, retryAfterSecondsForDelay, type GcraParameters } from "./gcra.js";
export {
  buildRateLimitKey,
  deriveRateLimitKeyring,
  deriveRateLimitScope,
  type RateLimitKeyring,
} from "./keyring.js";
export { MAX_RETRY_AFTER_SECONDS, MAX_TAT_VALUE_BYTES, MIN_RETRY_AFTER_SECONDS } from "./limits.js";
export { createRedisRateLimiter, type RedisRateLimiterOptions } from "./redis-limiter.js";
export {
  buildRateLimitScopeDeriver,
  createRateLimiterFromConfig,
  type RateLimitScopeDeriver,
} from "./runtime.js";
export type { RateLimitDecision, RateLimiter } from "./types.js";
