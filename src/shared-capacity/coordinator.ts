/**
 * The shared-capacity coordinator (Phase 4D; specification section 19.2).
 *
 * This module is the optional cross-replica {@link CapacityController}. It keeps
 * everything the process-local controller does about QUEUEING and moves only the
 * two ACTIVE limits into Redis:
 *
 * ```text
 *  one process-local FIFO queue          exactly one Redis claim in flight
 *  ────────────────────────────          ────────────────────────────────
 *   w1  w2  w3  w4  …                     claimBatch(candidates, limits)
 *    │   │   │                                      │
 *    └───┴───┴──► batch (FIFO order,                ▼
 *                 ≤ per-scope limit,        atomic prune + count + grant
 *                 ≤ global limit)                   │
 *                                                   ▼
 *                                    granted owner tokens (a SUBSET)
 *                                          │            │
 *                              permit ◄────┘            └──► stay queued,
 *                                                             bounded retry
 * ```
 *
 * Design rules this module enforces:
 *
 *  - **The queue stays local.** `MAX_QUEUED_REQUESTS` and `MAX_QUEUE_WAIT_MS`
 *    remain per replica, local FIFO order and per-key bypass are preserved, and
 *    no cross-replica fairness is promised: replicas compete for the shared
 *    budget, and a busy replica's queue does not yield to an idle one.
 *
 *  - **At most one claim is in flight per process.** Batching is what lets the
 *    server apply the per-key limit across several waiters atomically, and one
 *    in-flight command keeps a burst of arrivals from turning into a burst of
 *    Redis round trips.
 *
 *  - **A pending claim candidate is not a queued waiter.** They are counted
 *    separately, so `MAX_QUEUED_REQUESTS=0` still admits a request that can be
 *    granted immediately — the shared analogue of the local controller's
 *    fast path, which cannot exist here because occupancy is only knowable after
 *    a round trip. The honest cost of that carve-out is that a replica's
 *    in-system bound becomes `maxActive + batch + maxQueued` rather than the
 *    local controller's `maxActive + maxQueued`. The extra term is bounded by
 *    the batch size and lasts one Redis command deadline, and none of those
 *    candidates holds a permit or touches CollectivIQ. The queue bound is
 *    REAPPLIED the moment a claim settles: an ungranted candidate is an ordinary
 *    queued waiter again, and any overflow is shed with the same `capacity`
 *    rejection the arrival path gives.
 *
 *  - **An arrival never pre-empts a scheduled retry.** It claims only when
 *    nothing is scheduled; it never cancels or accelerates a pending retry,
 *    because an arrival is no evidence that the cluster has room. That is what
 *    keeps the cost to Redis on the bounded retry cadence rather than on the
 *    offered request rate. Three paths may start a claim for a queue that is
 *    already waiting: the retry timer; a RELEASE ATTEMPT for a permit this
 *    replica confirmed it held (see `onRelease`); and the settlement of a
 *    fail-closed claim, which starts one fresh decision for the DISTINCT
 *    waiters that arrived while it was in flight and were therefore excluded
 *    from it — a first decision for them, not a retry of the batch that failed.
 *
 *  - **A full cluster leaves waiters queued.** Being at the limit right now is
 *    ordinary backpressure, not a rejection: the waiter keeps its place until it
 *    is granted, times out, is cancelled, or admission closes. Only the
 *    queue-length and queue-wait bounds produce a `429`.
 *
 *  - **Every non-grant outcome fails CLOSED and is never retried or
 *    compensated.** An unavailable, corrupt, or ambiguous reply leaves it
 *    unknown whether a member was added; a retry could double-count a permit
 *    this replica already holds, and a speculative release could remove one
 *    another replica now holds. Any member that WAS added is an orphan bounded
 *    by its own lease.
 *
 *  - **A confirmed grant is never dropped.** If a waiter departs while the claim
 *    is in flight and Redis then confirms its grant, the permit is released
 *    immediately and never delivered — otherwise nothing would ever give it
 *    back.
 *
 * The coordinator imports nothing from the API or generation layers beyond the
 * capacity port; the route owns every public status and envelope.
 */
import type {
  CapacityAcquisition,
  CapacityController,
  CapacityRequest,
  Permit,
  RandomFn,
} from "../generation/types.js";
import {
  CAPACITY_LEASE_MARGIN_MS,
  CAPACITY_RETRY_BACKOFF_FACTOR,
  CAPACITY_RETRY_INITIAL_MS,
  CAPACITY_RETRY_JITTER_RATIO,
  CAPACITY_RETRY_MAX_MS,
  MAX_CAPACITY_CLAIM_BATCH,
  MAX_CAPACITY_LEASE_MS,
} from "./limits.js";
import { newCapacityOwnerToken } from "./members.js";
import type { CapacityCandidate, CapacityClaimResult, SharedCapacityStore } from "./store.js";

/** A cancellable timer handle. */
export interface CapacityTimer {
  cancel(): void;
}

/** Timer seam; injected only so tests can drive the scheduler deterministically. */
export type CapacityScheduleFn = (fn: () => void, ms: number) => CapacityTimer;

function defaultSchedule(fn: () => void, ms: number): CapacityTimer {
  const timer = setTimeout(fn, ms);
  // `unref` so a pending retry can never keep the process alive on shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

/** The admission limits this coordinator enforces. */
export interface SharedCapacityLimits {
  /** `MAX_CONCURRENT_REQUESTS`, applied CLUSTER-WIDE. */
  readonly maxActive: number;
  /** `MAX_CONCURRENT_REQUESTS_PER_KEY`, applied CLUSTER-WIDE. */
  readonly maxActivePerScope: number;
  /** `MAX_QUEUED_REQUESTS`, applied PER REPLICA. */
  readonly maxQueued: number;
  /** `MAX_QUEUE_WAIT_MS`, applied PER REPLICA. */
  readonly maxQueueWaitMs: number;
}

/** Injected dependencies (all narrow ports; every seam is test-injectable). */
export interface SharedCapacityCoordinatorDeps {
  readonly store: SharedCapacityStore;
  /** The one namespace-level registry key, derived once at composition. */
  readonly registryKey: string;
  readonly limits: SharedCapacityLimits;
  /** Deterministic randomness seam for the retry jitter (defaults to `Math.random`). */
  readonly random?: RandomFn;
  /** Timer seam for the retry delay (defaults to `setTimeout`). */
  readonly schedule?: CapacityScheduleFn;
}

/** One waiting request. */
interface Waiter {
  /** This waiter's freshly minted owner token; the identity Redis stores. */
  readonly owner: string;
  /** The waiter's opaque cross-replica capacity scope. */
  readonly scope: string;
  /** Lease this waiter's permit will carry, derived from its own deadline. */
  readonly leaseMs: number;
  readonly signal: AbortSignal;
  /** True once the pending `acquire` promise has been resolved. */
  settled: boolean;
  resolve(outcome: CapacityAcquisition): void;
  /** Release the queue-wait timer and the abort listener. Idempotent. */
  detach(): void;
}

/**
 * Derive one permit's lease from its request's own total deadline.
 *
 * The lease is a crash reaper, not a liveness mechanism: there is no heartbeat
 * and no renewal, so it must outlast any completion that could legitimately
 * still be holding the permit. Deriving it from the holder's own deadline
 * guarantees that — the request's deadline always fires first — while still
 * reclaiming a hard-killed replica's permits within a bounded window.
 */
export function capacityLeaseMsFor(requestTimeoutMs: number): number {
  const raw = requestTimeoutMs + CAPACITY_LEASE_MARGIN_MS;
  if (!Number.isFinite(raw)) return CAPACITY_LEASE_MARGIN_MS;
  const bounded = Math.floor(Math.min(raw, MAX_CAPACITY_LEASE_MS));
  // Fail-closed floor: an absurd or negative deadline must never mint a
  // zero-length lease, which would make its permit expire the instant it exists.
  return bounded >= 1 ? bounded : CAPACITY_LEASE_MARGIN_MS;
}

export function createSharedCapacityCoordinator(
  deps: SharedCapacityCoordinatorDeps,
): CapacityController {
  const { limits } = deps;
  const random = deps.random ?? Math.random;
  const schedule = deps.schedule ?? defaultSchedule;
  /** The largest batch worth sending: the server can never grant more at once. */
  const batchCap = Math.max(1, Math.min(limits.maxActive, MAX_CAPACITY_CLAIM_BATCH));

  /** Waiters that are NOT part of the in-flight claim, in local FIFO order. */
  let queue: Waiter[] = [];
  /**
   * The candidates of the in-flight claim, in the order they were submitted.
   * A departed candidate stays here until the claim settles, so a grant that
   * arrives for it can be handed straight back.
   */
  let pending: Waiter[] = [];
  let claimInFlight = false;
  let closed = false;

  /** Confirmed shared permits held by THIS replica. */
  let activeCount = 0;
  const perScopeActive = new Map<string, number>();

  let retryTimer: CapacityTimer | null = null;
  let retryDelayMs = CAPACITY_RETRY_INITIAL_MS;

  // --- local active accounting ----------------------------------------------

  function incrementActive(scope: string): void {
    activeCount += 1;
    perScopeActive.set(scope, (perScopeActive.get(scope) ?? 0) + 1);
  }

  function decrementActive(scope: string): void {
    activeCount -= 1;
    const next = (perScopeActive.get(scope) ?? 0) - 1;
    if (next <= 0) perScopeActive.delete(scope);
    else perScopeActive.set(scope, next);
  }

  // --- waiter lifecycle ------------------------------------------------------

  /** Resolve a waiter exactly once and drop its timer and abort listener. */
  function finish(waiter: Waiter, outcome: CapacityAcquisition): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.detach();
    waiter.resolve(outcome);
  }

  /**
   * Settle a waiter that left before being granted. A queued waiter is removed
   * outright; a pending claim candidate is only marked, because the claim may
   * still confirm a grant that has to be released.
   */
  function abandon(waiter: Waiter, outcome: CapacityAcquisition): void {
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
    finish(waiter, outcome);
    // A retry armed for a queue that has since emptied is a retry for nothing,
    // and leaving it armed would make the NEXT arrival wait out its remainder
    // (up to CAPACITY_RETRY_MAX_MS) before its first claim. Cancelling it here
    // is timer hygiene rather than a fourth claim trigger: it starts no claim,
    // and it cannot let an arrival pre-empt a retry that still has waiters.
    // A pending claim candidate is never in `queue`, and no retry can be armed
    // while a claim is in flight, so this only ever fires for a drained queue.
    if (queue.length === 0) cancelRetry();
  }

  /** Give a permit back to the shared registry. Bounded, best effort, never throws. */
  function releaseMember(owner: string, scope: string): void {
    try {
      // Deliberately WITHOUT the request's abort signal: a released permit must
      // be returned even when the request that held it was cancelled or timed
      // out.
      //
      // The INVOCATION is guarded, not just the returned promise: a store that
      // threw synchronously would do so while its argument was being evaluated,
      // before `Promise.resolve` existed to wrap it, and the throw would escape
      // the synchronous `Permit.release()` the route calls in a `finally` — and
      // so replace an already successful response with a failure.
      void Promise.resolve(deps.store.release(deps.registryKey, owner, scope)).catch(
        () => undefined,
      );
    } catch {
      // The store is total and should never throw; fail closed either way,
      // without inspecting the thrown value. The member simply expires with its
      // own lease, which conservatively under-admits this replica until then.
    }
  }

  function createPermit(owner: string, scope: string): Permit {
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        decrementActive(scope);
        // A failed or unacknowledged release NEVER changes an already successful
        // response; the member simply expires with its own lease, which
        // conservatively under-admits this replica until then.
        releaseMember(owner, scope);
        onRelease();
      },
    };
  }

  // --- retry scheduling ------------------------------------------------------

  function cancelRetry(): void {
    retryTimer?.cancel();
    retryTimer = null;
  }

  /**
   * The next retry delay, with symmetric bounded jitter so replicas that all
   * became full at the same instant do not retry in lockstep.
   *
   * The returned value is always within `[max(1, round(0.75 * base)),
   * min(round(1.25 * base), CAPACITY_RETRY_MAX_MS)]`, and the stored base grows
   * by the backoff factor up to the same cap.
   */
  function nextRetryDelayMs(): number {
    const base = retryDelayMs;
    const jittered = base * (1 + (random() * 2 - 1) * CAPACITY_RETRY_JITTER_RATIO);
    retryDelayMs = Math.min(base * CAPACITY_RETRY_BACKOFF_FACTOR, CAPACITY_RETRY_MAX_MS);
    return Math.max(1, Math.min(Math.round(jittered), CAPACITY_RETRY_MAX_MS));
  }

  function scheduleRetry(): void {
    if (closed || claimInFlight || queue.length === 0) return;
    // One retry timer at a time; a second would multiply claims per queue.
    if (retryTimer !== null) return;
    retryTimer = schedule(() => {
      // Drop the handle BEFORE claiming, so the claim this timer starts is not
      // mistaken for one racing a still-pending timer.
      retryTimer = null;
      startClaim();
    }, nextRetryDelayMs());
  }

  // --- claim scheduling ------------------------------------------------------

  /**
   * Take the next batch out of the queue in FIFO order.
   *
   * A candidate whose scope already contributes `maxActivePerScope` entries to
   * THIS batch is skipped rather than blocking the scan, so a later waiter with
   * a different scope can still be included — the same per-key bypass the local
   * controller performs, and the reason a claim reply must name owner tokens
   * rather than a count.
   */
  function buildBatch(): Waiter[] {
    const batch: Waiter[] = [];
    const remaining: Waiter[] = [];
    const perScopeBatch = new Map<string, number>();
    for (const waiter of queue) {
      if (batch.length >= batchCap) {
        remaining.push(waiter);
        continue;
      }
      const taken = perScopeBatch.get(waiter.scope) ?? 0;
      if (taken >= limits.maxActivePerScope) {
        remaining.push(waiter);
        continue;
      }
      perScopeBatch.set(waiter.scope, taken + 1);
      batch.push(waiter);
    }
    queue = remaining;
    return batch;
  }

  /**
   * Start one claim when this process is idle and has work.
   *
   * It deliberately never touches the retry timer. WHICH events may pre-empt the
   * backoff is the caller's decision: an arrival may not, a local release may,
   * the timer is the backoff, and a fail-closed settlement runs with no timer
   * pending because a claim was in flight until that moment.
   */
  function startClaim(): void {
    if (closed || claimInFlight || queue.length === 0) return;
    const batch = buildBatch();
    if (batch.length === 0) return;
    claimInFlight = true;
    pending = batch;
    void issueClaim(batch);
  }

  /**
   * A new waiter joined the queue.
   *
   * It claims immediately only while nothing is already scheduled. A pending
   * retry means a claim found the cluster full a moment ago, and an arrival is
   * no evidence that it has room now: letting one cancel the timer would drive
   * claims at arrival (in practice round-trip) frequency under sustained load,
   * which is exactly what the bounded schedule exists to prevent. The waiter
   * keeps its place until the timer fires instead.
   *
   * So an arrival joins an existing retry only while at least one waiter is
   * still owed it. A queue that DRAINS releases the timer as its last waiter
   * departs (see `abandon`), so the next arrival on an otherwise idle replica
   * finds nothing scheduled and claims at once rather than waiting out a delay
   * nothing was waiting for.
   */
  function onArrival(): void {
    if (retryTimer !== null) return;
    startClaim();
  }

  /**
   * A release was ATTEMPTED for a permit this replica had confirmed it held.
   *
   * This is the one trigger allowed to pre-empt the backoff, and the claim it
   * starts is safe — but be precise about what it does and does not know. What
   * is confirmed is only the LOCAL side: this replica held the permit and has
   * now decremented its own accounting. The Redis release itself is best effort
   * and is not awaited, so it may still throw, reject, or go unacknowledged, in
   * which case the member survives to its lease deadline and CLUSTER occupancy
   * is unchanged. The immediate claim may therefore simply observe the permit
   * still held and grant nothing.
   *
   * So this provides ONE bounded immediate probe per locally released permit —
   * a better bet than waiting out the delay, since the common case is a
   * successful release — not a claim that occupancy actually fell.
   */
  function onRelease(): void {
    cancelRetry();
    startClaim();
  }

  async function issueClaim(batch: readonly Waiter[]): Promise<void> {
    const candidates: CapacityCandidate[] = batch.map((waiter) => ({
      owner: waiter.owner,
      scope: waiter.scope,
      leaseMs: waiter.leaseMs,
    }));
    let result: CapacityClaimResult;
    try {
      // No abort signal is passed: the batch belongs to several waiters, so one
      // departing waiter must not cancel a command the others depend on. The
      // substrate already bounds the command with its own deadline, and each
      // waiter's own cancellation is observed through its abort listener.
      result = await deps.store.claimBatch(deps.registryKey, candidates, {
        maxActive: limits.maxActive,
        maxActivePerScope: limits.maxActivePerScope,
      });
    } catch {
      // The store is total and should never reject; fail closed without
      // inspecting the thrown value.
      result = { kind: "unavailable" };
    }
    settleClaim(batch, result);
  }

  function settleClaim(batch: readonly Waiter[], result: CapacityClaimResult): void {
    claimInFlight = false;
    pending = [];

    // Re-observe each waiter's own signal AFTER the await: a waiter aborted while
    // the claim was in flight must report `cancelled`, not `unavailable` or a
    // permit. Its abort listener has normally already settled it; this is the
    // belt-and-braces path for an abort that raced the listener.
    for (const waiter of batch) {
      if (!waiter.settled && waiter.signal.aborted) {
        finish(waiter, { ok: false, reason: "cancelled" });
      }
    }

    if (result.kind !== "claimed") {
      // Fail CLOSED with no retry and no compensating mutation. Whether a member
      // was added is unknown, so retrying could double-count a permit this
      // replica already holds and releasing could remove one another replica now
      // holds. Any member that was added is an orphan bounded by its own lease
      // and is invisible to this replica's gauges.
      for (const waiter of batch) finish(waiter, { ok: false, reason: "unavailable" });
      retryDelayMs = CAPACITY_RETRY_INITIAL_MS;
      // Nothing rejoins the queue here — every candidate was settled above — so
      // the local queue bound cannot have been exceeded and there is nothing to
      // reapply it to.
      //
      // This `startClaim` is the THIRD and narrowest path that starts a claim
      // for an already-waiting queue. Waiters that arrived while this claim was
      // in flight were excluded from it, so they have had no decision at all and
      // are owed one. It is NOT a retry or reconciliation of the batch that just
      // failed closed — those candidates were settled `unavailable` above and are
      // never reissued — and it is NOT an arrival pre-empting a scheduled retry,
      // because a claim was in flight until this moment, so none can be armed. It
      // is bounded by the same rules as any other claim: one in flight at a time,
      // and the local queue limits.
      startClaim();
      return;
    }

    const granted = new Set(result.granted);
    const ungranted: Waiter[] = [];
    for (const waiter of batch) {
      const wasGranted = granted.has(waiter.owner);
      if (waiter.settled) {
        // The waiter timed out, was cancelled, or admission closed while the
        // claim was in flight. A CONFIRMED grant for it must be handed straight
        // back: it is never delivered, and nothing else would ever release it.
        if (wasGranted) releaseMember(waiter.owner, waiter.scope);
        continue;
      }
      if (wasGranted) {
        incrementActive(waiter.scope);
        finish(waiter, { ok: true, permit: createPermit(waiter.owner, waiter.scope) });
      } else {
        ungranted.push(waiter);
      }
    }

    // Ungranted waiters keep their places at the FRONT of the queue, ahead of
    // anything that arrived during the claim, so local FIFO order is exact.
    if (ungranted.length > 0) queue = [...ungranted, ...queue];
    // Then REAPPLY the local queue bound, which the pending-candidate carve-out
    // suspended for the duration of this one command. A candidate that comes
    // back ungranted is an ordinary queued waiter again, so the earliest
    // `maxQueued` waiters are retained and the rest are shed with the same
    // `capacity` rejection the arrival path gives (the route's existing `429`).
    // Without this, `MAX_QUEUED_REQUESTS=0` would turn an ungranted immediate
    // claim into an unbounded retry loop instead of a rejection, and the
    // documented in-system bound would stop holding after the first settlement.
    if (queue.length > limits.maxQueued) {
      const overflow = queue.slice(limits.maxQueued);
      queue = queue.slice(0, limits.maxQueued);
      // Through `finish`, so "resolved exactly once, timer and abort listener
      // detached" stays structural rather than repeated here.
      for (const waiter of overflow) finish(waiter, { ok: false, reason: "capacity" });
    }
    // Any grant at all is progress, so the backoff starts over from its floor.
    if (result.granted.length > 0) retryDelayMs = CAPACITY_RETRY_INITIAL_MS;
    if (queue.length > 0) scheduleRetry();
    else retryDelayMs = CAPACITY_RETRY_INITIAL_MS;
  }

  // --- port ------------------------------------------------------------------

  function acquire(request: CapacityRequest): Promise<CapacityAcquisition> {
    if (closed) return Promise.resolve({ ok: false, reason: "capacity" });
    if (request.signal.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });

    const scope = request.capacityScopeId;
    // Shared capacity is enabled but this request carries no cross-replica
    // identity: an unavailable dependency, never a silent downgrade to local
    // accounting. Validated configuration makes this unreachable.
    if (scope === null || scope.length === 0) {
      return Promise.resolve({ ok: false, reason: "unavailable" });
    }
    // Avoid enqueueing behind a dependency that is already known to be unusable;
    // the substrate would fail the claim for the same reason a moment later.
    if (!deps.store.isReady()) return Promise.resolve({ ok: false, reason: "unavailable" });

    // A request that can start its own claim right now is a PENDING CANDIDATE,
    // not a queued waiter, so `MAX_QUEUED_REQUESTS=0` still admits an
    // immediately available grant instead of rejecting every request outright.
    const canClaimImmediately = !claimInFlight && queue.length === 0;
    if (!canClaimImmediately && queue.length >= limits.maxQueued) {
      return Promise.resolve({ ok: false, reason: "capacity" });
    }

    return new Promise<CapacityAcquisition>((resolve) => {
      const waiter: Waiter = {
        owner: newCapacityOwnerToken(),
        scope,
        leaseMs: capacityLeaseMsFor(request.requestTimeoutMs),
        signal: request.signal,
        settled: false,
        resolve,
        detach: () => undefined,
      };
      const timer = schedule(
        () => abandon(waiter, { ok: false, reason: "capacity" }),
        limits.maxQueueWaitMs,
      );
      const onAbort = (): void => abandon(waiter, { ok: false, reason: "cancelled" });
      request.signal.addEventListener("abort", onAbort, { once: true });
      waiter.detach = (): void => {
        timer.cancel();
        request.signal.removeEventListener("abort", onAbort);
      };
      queue.push(waiter);
      onArrival();
    });
  }

  function closeAdmission(): void {
    closed = true;
    cancelRetry();
    // Queued (never-started) work resolves with `capacity`, which the route maps
    // to the retryable `429` — intentional, and unchanged from the process-local
    // controller. A pending claim candidate has not started either, so it is
    // settled the same way; it stays in `pending` so a grant confirmed after
    // this point is released rather than leaked.
    const waiting = queue;
    queue = [];
    for (const waiter of waiting) finish(waiter, { ok: false, reason: "capacity" });
    for (const waiter of pending) finish(waiter, { ok: false, reason: "capacity" });
  }

  return {
    acquire,
    closeAdmission,
    get activeCount(): number {
      return activeCount;
    },
    get queuedCount(): number {
      // Both collections hold waiting requests. A departed pending candidate is
      // excluded: it is only retained so its grant can be released.
      let count = queue.length;
      for (const waiter of pending) if (!waiter.settled) count += 1;
      return count;
    },
  };
}
