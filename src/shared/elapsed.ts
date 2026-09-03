/**
 * Monotonic duration measurement for telemetry (specification section 23.2).
 *
 * Durations are measured with `process.hrtime.bigint()` rather than `Date.now()`
 * so a wall-clock adjustment cannot produce a negative or wildly wrong latency
 * sample. The result is always a finite, non-negative number of seconds, which
 * is what the Prometheus histograms require.
 */

/** Seconds elapsed since a `process.hrtime.bigint()` start, never negative. */
export function elapsedSeconds(startNs: bigint): number {
  const deltaNs = process.hrtime.bigint() - startNs;
  if (deltaNs <= 0n) return 0;
  return Number(deltaNs) / 1e9;
}
