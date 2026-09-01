/**
 * GCRA (generic cell rate algorithm) arithmetic (Phase 4B; specification
 * section 19.1).
 *
 * Pure functions only — no clock, no Redis, no I/O. The decision itself is made
 * inside one atomic Lua script against Redis's OWN clock (`redis-limiter.ts`);
 * this module owns the parameters that script is given and the conversion of a
 * returned delay into a public `Retry-After`.
 *
 * GCRA is used instead of a fixed window because it is exactly expressible as a
 * single stored integer — the theoretical arrival time (TAT) of the next
 * conforming request — which makes one compare-and-set atomic and keeps the
 * stored state free of any counter history:
 *
 * ```text
 * intervalUs  = ceil(windowMs * 1000 / requests)   // emission interval
 * toleranceUs = (burst - 1) * intervalUs           // immediate burst allowance
 * allowed     <=> now >= tat - toleranceUs
 * newTat      =  max(tat, now) + intervalUs        // on allow only
 * delay       =  tat - toleranceUs - now           // on reject only
 * ```
 *
 * With the documented defaults (60 requests / 60 000 ms / burst 8) the interval
 * is 1 000 000 µs, so a cold scope admits 8 requests immediately and then one
 * per second, refilling one burst slot per second.
 */
import { MAX_RETRY_AFTER_SECONDS, MIN_RETRY_AFTER_SECONDS } from "./limits.js";

/** The two derived GCRA parameters, in microseconds. */
export interface GcraParameters {
  /** Emission interval: the steady-state spacing between admitted requests. */
  readonly intervalUs: number;
  /** Burst allowance: how far ahead of the steady state a scope may run. */
  readonly toleranceUs: number;
}

/**
 * Derive the GCRA parameters from validated configuration.
 *
 * `requests`, `windowMs`, and `burst` are already range-checked by
 * configuration validation (`RATE_LIMIT_REQUESTS` 1–100000, `RATE_LIMIT_WINDOW_MS`
 * 1000–3600000, `RATE_LIMIT_BURST` 1–10000 and `<= RATE_LIMIT_REQUESTS`), so the
 * interval is always at least 1 µs and the tolerance is always non-negative.
 */
export function computeGcraParameters(
  requests: number,
  windowMs: number,
  burst: number,
): GcraParameters {
  const intervalUs = Math.max(1, Math.ceil((windowMs * 1000) / requests));
  return { intervalUs, toleranceUs: Math.max(0, (burst - 1) * intervalUs) };
}

/**
 * Convert the script's rejection delay (microseconds until the next admissible
 * request) into a bounded, positive integer `Retry-After` in seconds.
 *
 * A non-finite or negative delay is treated as the minimum rather than trusted,
 * so a corrupt reply can never produce a nonsensical header.
 */
export function retryAfterSecondsForDelay(delayUs: number): number {
  if (!Number.isFinite(delayUs) || delayUs <= 0) return MIN_RETRY_AFTER_SECONDS;
  const seconds = Math.ceil(delayUs / 1_000_000);
  if (seconds < MIN_RETRY_AFTER_SECONDS) return MIN_RETRY_AFTER_SECONDS;
  if (seconds > MAX_RETRY_AFTER_SECONDS) return MAX_RETRY_AFTER_SECONDS;
  return seconds;
}
