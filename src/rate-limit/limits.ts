/**
 * Conservative, non-overridable bounds for the OPTIONAL Redis-backed
 * cross-replica rate limiter (Phase 4B; specification section 19.1).
 *
 * These are the single source of truth for every bound this boundary enforces.
 * Relaxing one is a configuration-contract/security change, not a runtime
 * override.
 */

/**
 * Maximum accepted size of the stored theoretical-arrival-time value, in bytes.
 *
 * The stored value is only ever a decimal microsecond timestamp. Even the
 * largest reachable value (`now + burst * interval`, ~1.8e15 today) is 16
 * digits, so this cap is generous while still bounding what the Lua script may
 * materialize: the script checks `STRLEN` BEFORE its internal `GET`, so an
 * oversized or hostile value is classified corrupt without its bytes ever being
 * read into the script or crossing into Node.
 */
export const MAX_TAT_VALUE_BYTES = 32;

/**
 * Lower clamp for the public `Retry-After`, in seconds.
 *
 * A sub-second delay still rounds up to one second: `Retry-After: 0` would
 * invite an immediate retry that is guaranteed to be rejected again.
 */
export const MIN_RETRY_AFTER_SECONDS = 1;

/**
 * Upper clamp for the public `Retry-After`, in seconds.
 *
 * The GCRA delay can never exceed one emission interval, and the largest
 * configurable interval is `RATE_LIMIT_WINDOW_MS` at its 3,600,000 ms maximum
 * with `RATE_LIMIT_REQUESTS = 1`. The clamp is therefore not a truncation of any
 * reachable value; it is a fail-closed bound so a corrupt or absurd computed
 * delay can never produce an unbounded header.
 */
export const MAX_RETRY_AFTER_SECONDS = 3_600;
