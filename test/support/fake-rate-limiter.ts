/**
 * A deterministic in-memory {@link RateLimiter} for hermetic route tests.
 *
 * It stands in for the REDIS SERVER, not for the limiter logic under test: the
 * real GCRA arithmetic and Lua behaviour are proven separately by
 * `test/unit/rate-limit-*.test.ts` and, against a live server, by `test/redis/`.
 * What this fake gives an integration test is an exact, inspectable record of
 * WHICH scopes were charged and IN WHAT ORDER relative to the rest of the route,
 * plus the ability to force each of the four closed outcomes.
 *
 * Everything it holds is synthetic.
 */
import type { RateLimitDecision, RateLimiter } from "../../src/rate-limit/index.js";

export interface FakeRateLimiter extends RateLimiter {
  /** Ordered scopes charged, one entry per `consume` call that reached the fake. */
  readonly consumed: readonly string[];
  /** Total `consume` calls, including those answered from the queued outcomes. */
  readonly calls: { count: number };
  /** Queue one outcome for the next call; an empty queue means `allowed`. */
  next(decision: RateLimitDecision): void;
  /** Force every subsequent call to this outcome until cleared with `null`. */
  always(decision: RateLimitDecision | null): void;
  /**
   * Make `consume` REJECT until cleared with `null`. The real limiter is total
   * and never does this; the route must still fail closed if one ever did, and
   * it must do so without inspecting the thrown value — so any value is
   * accepted here, not just an `Error`.
   */
  rejectWith(error: unknown): void;
  /** Force `isReady()` on or off. */
  setReady(ready: boolean): void;
  /**
   * Run `hook` at the START of the next `consume`, before it resolves. Used to
   * observe what the route had (and had not) already done at that point.
   */
  onNextConsume(hook: () => void): void;
}

export function createFakeRateLimiter(): FakeRateLimiter {
  const consumed: string[] = [];
  const queue: RateLimitDecision[] = [];
  const calls = { count: 0 };
  let forced: RateLimitDecision | null = null;
  let rejection: { error: Error } | null = null;
  let ready = true;
  let hook: (() => void) | null = null;

  return {
    consumed,
    calls,
    next(decision) {
      queue.push(decision);
    },
    always(decision) {
      forced = decision;
    },
    rejectWith(error) {
      // The cast only satisfies the lint rule; the route never reads the value,
      // so a deliberately non-Error rejection is the point of this seam.
      rejection = error === null ? null : { error: error as Error };
    },
    setReady(value) {
      ready = value;
    },
    onNextConsume(next) {
      hook = next;
    },

    consume(gatewayKeyScope: string): Promise<RateLimitDecision> {
      calls.count += 1;
      if (hook !== null) {
        const run = hook;
        hook = null;
        run();
      }
      if (rejection !== null) return Promise.reject(rejection.error);
      const decision = forced ?? queue.shift() ?? { kind: "allowed" };
      // Only an attempt that actually spends quota is recorded, mirroring the
      // real limiter: a rejection mutates no stored state.
      if (decision.kind === "allowed") consumed.push(gatewayKeyScope);
      return Promise.resolve(decision);
    },

    isReady(): boolean {
      return ready;
    },
  };
}
