/**
 * A deterministic in-memory {@link SharedCapacityStore} for hermetic tests.
 *
 * It stands in for the REDIS SERVER, not for the coordinator under test: the
 * real Lua behaviour is proven against a live server by
 * `test/redis/shared-capacity-store.test.ts`, and the script arguments the store
 * actually ships are asserted by
 * `test/unit/shared-capacity-redis-store.test.ts`.
 *
 * What this fake gives a coordinator or route test is threefold:
 *
 *  - a faithful model of the grant rules — prune expired leases, count global and
 *    per-scope occupancy, skip a scope that is already at its limit so a later
 *    scope can still be granted, stop at the global limit — so contention and
 *    per-key bypass can be exercised without Redis;
 *  - an exact, inspectable record of every claim and release, in order, so a
 *    test can prove WHAT was asked and WHEN relative to the rest of the route;
 *  - the ability to force each closed outcome, to reject outright, and to DEFER a
 *    claim so a cancellation, timeout, or shutdown can be raced against an
 *    in-flight reply.
 *
 * Its clock is manual: leases only expire when a test calls `advanceMs`.
 * Everything it holds is synthetic.
 */
import {
  MAX_CAPACITY_CLAIM_BATCH,
  type CapacityCandidate,
  type CapacityClaimLimits,
  type CapacityClaimResult,
  type CapacityReleaseResult,
  type SharedCapacityStore,
} from "../../src/shared-capacity/index.js";

/** One recorded `claimBatch` invocation. */
export interface RecordedClaim {
  readonly key: string;
  readonly candidates: readonly CapacityCandidate[];
  readonly limits: CapacityClaimLimits;
  /** Whether the caller passed an abort signal (production passes none). */
  readonly hadSignal: boolean;
}

/** One recorded `release` invocation. */
export interface RecordedRelease {
  readonly key: string;
  readonly owner: string;
  readonly scope: string;
  /** Whether the caller passed an abort signal (production passes none). */
  readonly hadSignal: boolean;
}

/** One member of the modelled registry. */
export interface FakeMember {
  readonly scope: string;
  readonly deadlineMs: number;
}

/**
 * How a forced `release` failure surfaces.
 *
 * `"sync"` is not a stylistic variant of `"async"`: a synchronous throw escapes
 * the ARGUMENT position, before any promise exists to absorb it, so a caller
 * that only attaches a `.catch` is protected against one and not the other.
 */
export type FakeReleaseFailureMode = "async" | "sync";

export interface FakeSharedCapacityStore extends SharedCapacityStore {
  /** Every `claimBatch` call, in order. */
  readonly claims: readonly RecordedClaim[];
  /** Every `release` call, in order. */
  readonly releases: readonly RecordedRelease[];
  /** The modelled registry, keyed by owner token. */
  readonly members: ReadonlyMap<string, FakeMember>;
  /** Queue one claim outcome for the next call; an empty queue grants normally. */
  nextClaim(result: CapacityClaimResult): void;
  /** Force every subsequent claim to this outcome until cleared with `null`. */
  alwaysClaim(result: CapacityClaimResult | null): void;
  /** Force every subsequent release to this outcome until cleared with `null`. */
  alwaysRelease(result: CapacityReleaseResult | null): void;
  /**
   * Make `claimBatch` REJECT until cleared with `null`. The real store is total
   * and never does this; the coordinator must still fail closed if one ever did,
   * and it must do so without inspecting the thrown value — so any value is
   * accepted here, not just an `Error`.
   */
  rejectClaimWith(error: unknown): void;
  /**
   * Make `release` FAIL until cleared with `null`, either as a rejected promise
   * (`"async"`, the default) or as a synchronous throw (`"sync"`).
   *
   * The real store is total and does NEITHER, which is exactly why both must be
   * proven harmless: `Permit.release()` is synchronous and the route calls it in
   * a `finally`, so an escaping failure would replace an already successful
   * response. The call is still RECORDED before it fails — it really was issued.
   * Any value is accepted, not just an `Error`, because the coordinator must
   * never inspect one.
   */
  failReleaseWith(error: unknown, mode?: FakeReleaseFailureMode): void;
  /** Force `isReady()` on or off. */
  setReady(ready: boolean): void;
  /**
   * Run `hook` at the START of the next `claimBatch`, before it resolves. Used
   * to observe what the coordinator had (and had not) already done at that point.
   */
  onNextClaim(hook: () => void): void;
  /**
   * Hold the next `claimBatch` unresolved until {@link settleDeferredClaim} is
   * called, so a departure can be raced against an in-flight reply.
   */
  deferNextClaim(): void;
  /** Resolve a deferred claim. Returns `false` when none is pending. */
  settleDeferredClaim(): boolean;
  /** True while a deferred claim is waiting to be settled. */
  hasDeferredClaim(): boolean;
  /** Advance the manual clock so leases can expire. */
  advanceMs(ms: number): void;
  /** The manual clock's current value, in ms. */
  nowMs(): number;
}

export function createFakeSharedCapacityStore(initialNowMs = 1_000_000): FakeSharedCapacityStore {
  const claims: RecordedClaim[] = [];
  const releases: RecordedRelease[] = [];
  const members = new Map<string, FakeMember>();
  const queued: CapacityClaimResult[] = [];

  let now = initialNowMs;
  let forcedClaim: CapacityClaimResult | null = null;
  let forcedRelease: CapacityReleaseResult | null = null;
  let releaseFailure: { error: Error; mode: FakeReleaseFailureMode } | null = null;
  let rejection: { error: Error } | null = null;
  let ready = true;
  let hook: (() => void) | null = null;
  let deferNext = false;
  let deferred: (() => void) | null = null;

  /** Drop every member whose lease deadline has passed, exactly as the Lua does. */
  function prune(): void {
    for (const [owner, member] of members) {
      if (member.deadlineMs <= now) members.delete(owner);
    }
  }

  /** The real grant rules, applied to the modelled registry. */
  function grant(
    candidates: readonly CapacityCandidate[],
    limits: CapacityClaimLimits,
  ): CapacityClaimResult {
    // The real store validates its arguments SERVER-SIDE before touching the
    // registry, so a batch it would refuse must be refused here too — otherwise
    // this fake would quietly grant permits the production path cannot. A batch
    // can never usefully exceed the global limit, because the script cannot
    // grant more than that in total.
    if (candidates.length > Math.min(limits.maxActive, MAX_CAPACITY_CLAIM_BATCH)) {
      return { kind: "corrupt" };
    }
    if (limits.maxActivePerScope > limits.maxActive) return { kind: "corrupt" };
    const owners = new Set(candidates.map((candidate) => candidate.owner));
    // A repeated owner token would add a second member for one permit.
    if (owners.size !== candidates.length) return { kind: "corrupt" };
    prune();
    let active = members.size;
    const perScope = new Map<string, number>();
    for (const member of members.values()) {
      perScope.set(member.scope, (perScope.get(member.scope) ?? 0) + 1);
    }
    const granted: string[] = [];
    for (const candidate of candidates) {
      if (active >= limits.maxActive) break;
      const held = perScope.get(candidate.scope) ?? 0;
      // A blocked scope is SKIPPED, not fatal: a later distinct scope may still
      // be granted, which is why a reply must name owner tokens.
      if (held >= limits.maxActivePerScope) continue;
      members.set(candidate.owner, {
        scope: candidate.scope,
        deadlineMs: now + candidate.leaseMs,
      });
      perScope.set(candidate.scope, held + 1);
      active += 1;
      granted.push(candidate.owner);
    }
    return { kind: "claimed", granted };
  }

  return {
    claims,
    releases,
    members,

    nextClaim(result) {
      queued.push(result);
    },
    alwaysClaim(result) {
      forcedClaim = result;
    },
    alwaysRelease(result) {
      forcedRelease = result;
    },
    rejectClaimWith(error) {
      // The cast only satisfies the lint rule; the coordinator never reads the
      // value, so a deliberately non-Error rejection is the point of this seam.
      rejection = error === null ? null : { error: error as Error };
    },
    failReleaseWith(error, mode = "async") {
      // As above, the cast only satisfies the lint rule.
      releaseFailure = error === null ? null : { error: error as Error, mode };
    },
    setReady(value) {
      ready = value;
    },
    onNextClaim(next) {
      hook = next;
    },
    deferNextClaim() {
      deferNext = true;
    },
    settleDeferredClaim() {
      if (deferred === null) return false;
      const resume = deferred;
      deferred = null;
      resume();
      return true;
    },
    hasDeferredClaim() {
      return deferred !== null;
    },
    advanceMs(ms) {
      now += ms;
    },
    nowMs() {
      return now;
    },

    claimBatch(key, candidates, limits, signal) {
      claims.push({
        key,
        candidates: candidates.map((c) => ({ ...c })),
        limits: { ...limits },
        hadSignal: signal !== undefined,
      });
      if (hook !== null) {
        const run = hook;
        hook = null;
        run();
      }
      if (rejection !== null) return Promise.reject(rejection.error);

      const decide = (): CapacityClaimResult => {
        const forced = forcedClaim ?? queued.shift() ?? null;
        // A forced non-grant outcome mutates nothing, exactly like the script:
        // a corrupt registry is left untouched and an unavailable dependency
        // never applied anything the caller can observe.
        if (forced !== null) return forced;
        return grant(candidates, limits);
      };

      if (deferNext) {
        deferNext = false;
        return new Promise<CapacityClaimResult>((resolve) => {
          deferred = () => resolve(decide());
        });
      }
      return Promise.resolve(decide());
    },

    release(key, owner, scope, signal) {
      releases.push({ key, owner, scope, hadSignal: signal !== undefined });
      if (releaseFailure !== null) {
        // Nothing is removed: a release that failed left the member in place, to
        // expire with its own lease.
        if (releaseFailure.mode === "sync") throw releaseFailure.error;
        return Promise.reject(releaseFailure.error);
      }
      if (forcedRelease !== null) return Promise.resolve(forcedRelease);
      prune();
      const member = members.get(owner);
      // Exact member match, as the Lua `ZREM` does: an owner recorded under a
      // different scope is not this permit.
      if (member !== undefined && member.scope === scope) members.delete(owner);
      return Promise.resolve({ kind: "ok" });
    },

    isReady() {
      return ready;
    },
  };
}
