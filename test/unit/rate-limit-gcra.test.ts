/**
 * GCRA arithmetic (Phase 4B; specification section 19.1).
 *
 * These tests pin the exact burst and refill behaviour the documented defaults
 * promise. They are written as a REFERENCE SIMULATION of the Lua script's
 * decision rule rather than as assertions about the implementation's shape, so
 * they fail if the arithmetic drifts even when the code still "looks right".
 * The script itself is exercised at the command level in
 * `rate-limit-redis-limiter.test.ts` and against a real server in `test/redis/`.
 */
import { describe, expect, it } from "vitest";
import { computeGcraParameters, retryAfterSecondsForDelay } from "../../src/rate-limit/gcra.js";
import { MAX_RETRY_AFTER_SECONDS, MIN_RETRY_AFTER_SECONDS } from "../../src/rate-limit/limits.js";

/**
 * The decision rule the Lua script implements, in TypeScript, over an explicit
 * clock. Keeping one readable reference here is what lets the burst/refill
 * tests below assert observable admission behaviour instead of intermediate
 * values.
 */
function simulator(requests: number, windowMs: number, burst: number) {
  const { intervalUs, toleranceUs } = computeGcraParameters(requests, windowMs, burst);
  let stored: number | null = null;
  return {
    intervalUs,
    toleranceUs,
    /** Returns `null` when admitted, else the rejection delay in microseconds. */
    consume(nowUs: number): number | null {
      const tat = stored !== null && stored > nowUs ? stored : nowUs;
      if (nowUs >= tat - toleranceUs) {
        stored = tat + intervalUs;
        return null;
      }
      return tat - toleranceUs - nowUs;
    },
    /** The TTL the script would write, in ms. */
    ttlMs(nowUs: number): number {
      if (stored === null) return 0;
      return Math.max(1, Math.ceil((stored - nowUs) / 1000));
    },
  };
}

describe("GCRA parameters", () => {
  it("derives the documented defaults", () => {
    // 60 requests / 60 s => one emission per second; burst 8 => 7 s of slack.
    expect(computeGcraParameters(60, 60_000, 8)).toEqual({
      intervalUs: 1_000_000,
      toleranceUs: 7_000_000,
    });
  });

  it("rounds the interval UP so the sustained rate can never exceed the limit", () => {
    // 7 requests per 1000 ms is 142.857… µs; rounding down would admit an extra
    // request inside the window.
    const { intervalUs } = computeGcraParameters(7, 1_000, 1);
    expect(intervalUs).toBe(142_858);
    expect(intervalUs * 7).toBeGreaterThan(1_000_000);
  });

  it("keeps the interval at least one microsecond at the extreme limit", () => {
    // 100000 requests per 1000 ms is 10 µs; the floor never binds in range, but
    // the guard must hold anyway.
    expect(computeGcraParameters(100_000, 1_000, 1).intervalUs).toBe(10);
  });

  it("gives a burst of one exactly zero tolerance", () => {
    expect(computeGcraParameters(60, 60_000, 1).toleranceUs).toBe(0);
  });

  it("scales tolerance linearly with the burst", () => {
    const { intervalUs, toleranceUs } = computeGcraParameters(120, 60_000, 5);
    expect(intervalUs).toBe(500_000);
    expect(toleranceUs).toBe(4 * 500_000);
  });
});

describe("GCRA admission with the documented defaults (60/60s, burst 8)", () => {
  const start = 1_800_000_000_000_000;

  it("admits exactly the burst immediately and rejects the next request", () => {
    const gcra = simulator(60, 60_000, 8);
    for (let i = 0; i < 8; i += 1) {
      expect(gcra.consume(start)).toBeNull();
    }
    // MUTATION GUARD: a ninth immediate request must be rejected. An
    // off-by-one in the tolerance (using `burst` instead of `burst - 1`) makes
    // this line pass and is exactly the bug this test exists to catch.
    const delay = gcra.consume(start);
    expect(delay).not.toBeNull();
    expect(delay).toBe(1_000_000);
  });

  it("refills exactly one slot per emission interval", () => {
    const gcra = simulator(60, 60_000, 8);
    for (let i = 0; i < 8; i += 1) expect(gcra.consume(start)).toBeNull();

    // Half an interval later the bucket is still empty.
    expect(gcra.consume(start + 500_000)).not.toBeNull();
    // A full interval later exactly ONE slot is available...
    expect(gcra.consume(start + 1_000_000)).toBeNull();
    expect(gcra.consume(start + 1_000_000)).not.toBeNull();
    // ...and three intervals of idling restore exactly three.
    for (let i = 0; i < 3; i += 1) {
      expect(gcra.consume(start + 4_000_000)).toBeNull();
    }
    expect(gcra.consume(start + 4_000_000)).not.toBeNull();
  });

  it("never accumulates more than the burst, however long the scope idles", () => {
    const gcra = simulator(60, 60_000, 8);
    // A full hour of silence must not bank an hour of requests.
    const later = start + 3_600 * 1_000_000;
    for (let i = 0; i < 8; i += 1) expect(gcra.consume(later)).toBeNull();
    expect(gcra.consume(later)).not.toBeNull();
  });

  it("sustains exactly the configured rate over a full window", () => {
    const gcra = simulator(60, 60_000, 8);
    let admitted = 0;
    // One attempt every 100 ms for 60 s: 600 attempts against a 60/min limit
    // with a burst of 8. GCRA admits the burst plus one per second.
    for (let tick = 0; tick < 600; tick += 1) {
      if (gcra.consume(start + tick * 100_000) === null) admitted += 1;
    }
    expect(admitted).toBe(8 + 59);
  });

  it("reports a rejection delay that is exactly long enough", () => {
    const gcra = simulator(60, 60_000, 8);
    for (let i = 0; i < 8; i += 1) gcra.consume(start);
    const delay = gcra.consume(start);
    expect(delay).not.toBeNull();
    // Waiting the reported delay admits; waiting one microsecond less does not.
    const almost = simulator(60, 60_000, 8);
    for (let i = 0; i < 8; i += 1) almost.consume(start);
    expect(almost.consume(start + (delay as number) - 1)).not.toBeNull();

    const exact = simulator(60, 60_000, 8);
    for (let i = 0; i < 8; i += 1) exact.consume(start);
    expect(exact.consume(start + (delay as number))).toBeNull();
  });

  it("writes a TTL that outlives the outstanding debt and is never zero", () => {
    const gcra = simulator(60, 60_000, 8);
    gcra.consume(start);
    // A single request owes one interval, so the record must live ~1 s.
    expect(gcra.ttlMs(start)).toBe(1_000);

    for (let i = 0; i < 7; i += 1) gcra.consume(start);
    // A fully spent burst owes the whole burst window.
    expect(gcra.ttlMs(start)).toBe(8_000);
    // Once the debt is nearly repaid the TTL shrinks but stays >= 1 ms, so the
    // record can never be written with a non-positive expiry.
    expect(gcra.ttlMs(start + 7_999_999)).toBe(1);
  });

  it("treats a rejection as consuming nothing", () => {
    const gcra = simulator(60, 60_000, 8);
    for (let i = 0; i < 8; i += 1) gcra.consume(start);
    // Twenty rejected attempts must not push the recovery time out at all.
    for (let i = 0; i < 20; i += 1) expect(gcra.consume(start)).not.toBeNull();
    expect(gcra.consume(start + 1_000_000)).toBeNull();
  });
});

describe("retry-after conversion", () => {
  it("rounds a sub-second delay up to the minimum", () => {
    expect(retryAfterSecondsForDelay(1)).toBe(MIN_RETRY_AFTER_SECONDS);
    expect(retryAfterSecondsForDelay(999_999)).toBe(1);
  });

  it("rounds up rather than truncating", () => {
    expect(retryAfterSecondsForDelay(1_000_000)).toBe(1);
    expect(retryAfterSecondsForDelay(1_000_001)).toBe(2);
    expect(retryAfterSecondsForDelay(2_500_000)).toBe(3);
  });

  it("never returns zero or a negative value", () => {
    for (const delay of [0, -1, -1_000_000]) {
      expect(retryAfterSecondsForDelay(delay)).toBe(MIN_RETRY_AFTER_SECONDS);
    }
  });

  it("clamps an absurd or non-finite delay instead of trusting it", () => {
    expect(retryAfterSecondsForDelay(Number.MAX_SAFE_INTEGER)).toBe(MAX_RETRY_AFTER_SECONDS);
    for (const delay of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const seconds = retryAfterSecondsForDelay(delay);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(MIN_RETRY_AFTER_SECONDS);
      expect(seconds).toBeLessThanOrEqual(MAX_RETRY_AFTER_SECONDS);
    }
  });

  it("covers the largest delay any in-range configuration can produce", () => {
    // The delay can never exceed one emission interval, and the largest
    // configurable interval is a 3 600 000 ms window with a single request.
    const { intervalUs } = computeGcraParameters(1, 3_600_000, 1);
    expect(retryAfterSecondsForDelay(intervalUs)).toBe(MAX_RETRY_AFTER_SECONDS);
  });
});
