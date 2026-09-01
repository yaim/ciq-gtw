/**
 * Conservative, non-overridable bounds for the shared Redis client substrate
 * (specification sections 18.1, 19.1, 31.2).
 *
 * These bound the CONNECTION, not any feature that uses it, so idempotency
 * (section 18.1) and rate limiting (section 19.1) share exactly one set of
 * deadlines and one reconnect policy. Relaxing a bound is a
 * configuration-contract/security change, not a runtime override.
 */

/** Bounded deadline for a single Redis command, in ms. */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;
/** Bounded deadline for establishing the Redis connection, in ms. */
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
/** Maximum automatic reconnect backoff, in ms. */
export const REDIS_RECONNECT_MAX_DELAY_MS = 5_000;
/** Bounded graceful Redis close window before the socket is force-destroyed, in ms. */
export const REDIS_CLOSE_TIMEOUT_MS = 2_000;
