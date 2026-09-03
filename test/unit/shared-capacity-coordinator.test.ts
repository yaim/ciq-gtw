/**
 * The cross-replica capacity coordinator (Phase 4D; specification section
 * 19.2).
 *
 * These tests drive the real coordinator against the in-memory store fake,
 * which reproduces the Lua grant rules (prune, count global and per-scope
 * occupancy, skip a scope at its limit, stop at the global limit). The timer and
 * randomness seams are injected, so every retry, queue wait, and jitter draw is
 * deterministic and no real timer is ever created.
 *
 * What they assert is the contract admission control lives or dies by: that a
 * full cluster is BACKPRESSURE rather than a rejection, that an undecided claim
 * is never retried or compensated, that a grant confirmed for a departed waiter
 * is handed straight back, and that no timer or abort listener outlives the
 * request that created it.
 *
 * Every value here is synthetic.
 */
import { describe, expect, it } from "vitest";
import { CAPACITY_LIMITS, MODEL_CONFIG_LIMITS } from "../../src/config/schema.js";
import { createUnavailableCapacityController } from "../../src/generation/capacity.js";
import type {
  CapacityAcquisition,
  CapacityController,
  CapacityRequest,
  Permit,
  RandomFn,
} from "../../src/generation/types.js";
import {
  CAPACITY_LEASE_MARGIN_MS,
  CAPACITY_RETRY_INITIAL_MS,
  CAPACITY_RETRY_MAX_MS,
  capacityLeaseMsFor,
  createSharedCapacityCoordinator,
  MAX_CAPACITY_CLAIM_BATCH,
  MAX_CAPACITY_LEASE_MS,
  type CapacityScheduleFn,
  type CapacityTimer,
  type SharedCapacityLimits,
} from "../../src/shared-capacity/index.js";
import {
  createFakeSharedCapacityStore,
  type FakeSharedCapacityStore,
} from "../support/fake-shared-capacity-store.js";

const REGISTRY_KEY = "test-ns:capacity:AAAA";
const SCOPE_A = "scope-alpha";
const SCOPE_B = "scope-bravo";

/**
 * Stands in for the PROCESS-LOCAL `k<index>` gateway-key identity. It is shaped
 * as a sentinel rather than a bare `k0` so an assertion that it never reaches
 * shared state cannot pass or fail by accident against a random owner token.
 */
const LOCAL_KEY_ID = "k0-LOCAL-SENTINEL";

const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The queue wait used everywhere, chosen well above the 1 000 ms retry cap so a
 * scheduled timer's delay unambiguously identifies which seam created it.
 */
const QUEUE_WAIT_MS = 60_000;

/** Let an in-flight claim's `await` resume and its settlement run to completion. */
async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function permitOf(outcome: CapacityAcquisition): Permit {
  if (!outcome.ok) throw new Error(`expected a permit, got ${outcome.reason}`);
  return outcome.permit;
}

/**
 * An abort signal that counts the listeners attached to it.
 *
 * Wrapping the instance methods is what makes "no dangling abort listener"
 * checkable at all: a `once: true` listener the coordinator forgets to detach is
 * invisible to every public API, yet it keeps the waiter (and its closure)
 * reachable for as long as the caller's signal lives.
 */
interface TrackedSignal {
  readonly signal: AbortSignal;
  abort(): void;
  /** Abort listeners currently attached to this signal. */
  attached(): number;
}

function trackSignal(): TrackedSignal {
  const controller = new AbortController();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let attached = 0;
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (...args: Parameters<typeof add>): void => {
      attached += 1;
      add(...args);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value: (...args: Parameters<typeof remove>): void => {
      attached -= 1;
      remove(...args);
    },
  });
  return {
    signal,
    abort: () => controller.abort(),
    attached: () => attached,
  };
}

/** One timer the coordinator asked the injected seam for. */
interface FakeTimer {
  /** Derived from the requested delay; see {@link QUEUE_WAIT_MS}. */
  readonly kind: "queue-wait" | "retry";
  readonly ms: number;
  fired: boolean;
  cancelled: boolean;
  /** Run the scheduled callback exactly once, as a real timer would. */
  fire(): void;
}

interface AcquireOptions {
  readonly signal?: TrackedSignal;
  readonly requestTimeoutMs?: number;
}

interface Harness {
  readonly controller: CapacityController;
  readonly store: FakeSharedCapacityStore;
  /** Every timer the coordinator asked for, in order. */
  readonly timers: readonly FakeTimer[];
  /** Timers that are neither fired nor cancelled. */
  live(kind?: FakeTimer["kind"]): readonly FakeTimer[];
  /** The delay of every retry timer that was scheduled, in order. */
  retryDelays(): readonly number[];
  /** Fire the single live retry timer. */
  fireRetry(): void;
  /** Fire the single live queue-wait timer. */
  fireQueueWait(): void;
  acquire(scope: string | null, options?: AcquireOptions): Promise<CapacityAcquisition>;
  /** A signal this harness tracks, so a test can abort it mid-flight. */
  trackedSignal(): TrackedSignal;
  /** Abort listeners still attached across every signal this harness minted. */
  attachedListeners(): number;
}

function harness(over: Partial<SharedCapacityLimits> = {}, random: RandomFn = () => 0.5): Harness {
  const limits: SharedCapacityLimits = {
    maxActive: 2,
    maxActivePerScope: 2,
    maxQueued: 4,
    maxQueueWaitMs: QUEUE_WAIT_MS,
    ...over,
  };
  const store = createFakeSharedCapacityStore();
  const timers: FakeTimer[] = [];
  const signals: TrackedSignal[] = [];

  const schedule: CapacityScheduleFn = (fn, ms): CapacityTimer => {
    const timer: FakeTimer = {
      kind: ms === limits.maxQueueWaitMs ? "queue-wait" : "retry",
      ms,
      fired: false,
      cancelled: false,
      fire: (): void => {
        if (timer.fired || timer.cancelled) {
          throw new Error("fake timer: already fired or cancelled");
        }
        timer.fired = true;
        fn();
      },
    };
    timers.push(timer);
    return {
      cancel: (): void => {
        timer.cancelled = true;
      },
    };
  };

  const controller = createSharedCapacityCoordinator({
    store,
    registryKey: REGISTRY_KEY,
    limits,
    random,
    schedule,
  });

  function live(kind?: FakeTimer["kind"]): readonly FakeTimer[] {
    return timers.filter(
      (timer) => !timer.fired && !timer.cancelled && (kind === undefined || timer.kind === kind),
    );
  }

  function fireOnly(kind: FakeTimer["kind"]): void {
    const candidates = live(kind);
    const [timer] = candidates;
    if (candidates.length !== 1 || timer === undefined) {
      throw new Error(
        `expected exactly one live ${kind} timer, found ${String(candidates.length)}`,
      );
    }
    timer.fire();
  }

  function trackedSignal(): TrackedSignal {
    const tracked = trackSignal();
    signals.push(tracked);
    return tracked;
  }

  return {
    controller,
    store,
    timers,
    live,
    retryDelays: () => timers.filter((timer) => timer.kind === "retry").map((timer) => timer.ms),
    fireRetry: () => fireOnly("retry"),
    fireQueueWait: () => fireOnly("queue-wait"),
    acquire: (scope, options = {}) => {
      const tracked = options.signal ?? trackedSignal();
      const request: CapacityRequest = {
        keyId: LOCAL_KEY_ID,
        capacityScopeId: scope,
        requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        signal: tracked.signal,
      };
      return controller.acquire(request);
    },
    trackedSignal,
    attachedListeners: () => signals.reduce((total, tracked) => total + tracked.attached(), 0),
  };
}

describe("capacityLeaseMsFor", () => {
  it("adds a fixed 30-second margin to the request's own deadline", () => {
    // The lease is a CRASH REAPER, not a liveness mechanism: derived from the
    // holder's own deadline so the request's deadline always fires first.
    expect(CAPACITY_LEASE_MARGIN_MS).toBe(30_000);
    expect(capacityLeaseMsFor(90_000)).toBe(120_000);
    expect(capacityLeaseMsFor(1_000)).toBe(31_000);
  });

  it("never truncates a deadline the configuration permits", () => {
    expect(MAX_CAPACITY_LEASE_MS).toBe(630_000);
    expect(capacityLeaseMsFor(MODEL_CONFIG_LIMITS.requestTimeoutMs.max)).toBe(
      MAX_CAPACITY_LEASE_MS,
    );
  });

  it("clamps an absurd deadline at the ceiling", () => {
    expect(capacityLeaseMsFor(10 * MAX_CAPACITY_LEASE_MS)).toBe(MAX_CAPACITY_LEASE_MS);
  });

  it("floors an impossible deadline at the margin rather than at zero", () => {
    // A zero-length lease would make a permit expire the instant it exists.
    for (const impossible of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -CAPACITY_LEASE_MARGIN_MS,
      -1_000_000,
    ]) {
      expect(capacityLeaseMsFor(impossible)).toBe(CAPACITY_LEASE_MARGIN_MS);
    }
  });

  it("always returns a lease inside [1, the ceiling]", () => {
    for (const deadline of [0, 1, 999, 600_000, 1e9, -1e9, Number.NaN]) {
      const lease = capacityLeaseMsFor(deadline);
      expect(lease).toBeGreaterThanOrEqual(1);
      expect(lease).toBeLessThanOrEqual(MAX_CAPACITY_LEASE_MS);
      expect(Number.isInteger(lease)).toBe(true);
    }
  });
});

describe("shared capacity coordinator: granting", () => {
  it("grants a permit and registers one member with a derived deadline", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2 });
    const at = h.store.nowMs();
    const outcome = await h.acquire(SCOPE_A);

    expect(outcome.ok).toBe(true);
    expect(h.controller.activeCount).toBe(1);
    expect(h.controller.queuedCount).toBe(0);

    const [member] = [...h.store.members.values()];
    expect(h.store.members.size).toBe(1);
    expect(member?.scope).toBe(SCOPE_A);
    // The DEADLINE is stamped from the store's clock; the coordinator supplies
    // only a duration derived from the request's own total deadline.
    expect(member?.deadlineMs).toBe(at + REQUEST_TIMEOUT_MS + CAPACITY_LEASE_MARGIN_MS);

    const [claim] = h.store.claims;
    expect(claim?.key).toBe(REGISTRY_KEY);
    expect(claim?.limits).toEqual({ maxActive: 2, maxActivePerScope: 2 });
    expect(claim?.candidates).toHaveLength(1);
    expect(claim?.candidates[0]?.scope).toBe(SCOPE_A);
    expect(claim?.candidates[0]?.leaseMs).toBe(REQUEST_TIMEOUT_MS + CAPACITY_LEASE_MARGIN_MS);
    // A freshly minted 128-bit owner token, not any caller-supplied identity.
    expect(claim?.candidates[0]?.owner).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The process-local `k<index>` identity is ordering dependent and must never
    // be written to shared state.
    expect(JSON.stringify(h.store.claims)).not.toContain(LOCAL_KEY_ID);
  });

  it("claims WITHOUT any request's abort signal, because a batch is shared", async () => {
    const h = harness();
    const tracked = h.trackedSignal();
    expect((await h.acquire(SCOPE_A, { signal: tracked })).ok).toBe(true);
    // One departing waiter must not cancel a command the others depend on.
    expect(h.store.claims[0]?.hadSignal).toBe(false);
  });

  it("derives each candidate's lease from ITS OWN model deadline", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4 });
    h.store.deferNextClaim();
    const first = h.acquire(SCOPE_A, { requestTimeoutMs: 10_000 });
    const second = h.acquire(SCOPE_B, { requestTimeoutMs: 300_000 });
    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await first).ok).toBe(true);
    h.fireRetry();
    expect((await second).ok).toBe(true);
    const leases = h.store.claims.flatMap((claim) => claim.candidates.map((c) => c.leaseMs));
    expect(leases).toEqual([10_000 + CAPACITY_LEASE_MARGIN_MS, 300_000 + CAPACITY_LEASE_MARGIN_MS]);
  });
});

describe("shared capacity coordinator: batching", () => {
  it("keeps at most ONE claim in flight and batches later arrivals into the next", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4 });
    const first = h.acquire(SCOPE_A);
    const second = h.acquire(SCOPE_A);
    const third = h.acquire(SCOPE_B);

    // The first arrival started the claim; a burst of arrivals must not become a
    // burst of Redis round trips.
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.claims[0]?.candidates).toHaveLength(1);
    expect((await first).ok).toBe(true);
    expect(h.store.claims).toHaveLength(1);

    h.fireRetry();
    expect(h.store.claims).toHaveLength(2);
    expect(h.store.claims[1]?.candidates).toHaveLength(2);
    expect((await second).ok).toBe(true);
    expect((await third).ok).toBe(true);
  });

  it("builds the batch in local FIFO order, ungranted waiters first", async () => {
    const h = harness({ maxActive: 8, maxActivePerScope: 8, maxQueued: 8 });
    // The cluster is at its limit, so nothing is granted and every waiter keeps
    // its place.
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const first = h.acquire(SCOPE_A);
    await flush();
    const second = h.acquire(SCOPE_B);
    const third = h.acquire(SCOPE_A);
    await flush();
    h.fireRetry();
    await flush();

    const batch = h.store.claims.at(-1)?.candidates ?? [];
    // Arrival order, exactly: an ungranted waiter is re-queued at the FRONT,
    // ahead of anything that arrived during its claim.
    expect(batch.map((candidate) => candidate.scope)).toEqual([SCOPE_A, SCOPE_B, SCOPE_A]);
    const firstOwner = h.store.claims[0]?.candidates[0]?.owner;
    expect(batch[0]?.owner).toBe(firstOwner);

    h.controller.closeAdmission();
    for (const outcome of await Promise.all([first, second, third])) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("never puts more than the per-scope limit of ONE scope in a single batch", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 1, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const firstA = h.acquire(SCOPE_A);
    await flush();
    const secondA = h.acquire(SCOPE_A);
    const firstB = h.acquire(SCOPE_B);
    await flush();
    h.fireRetry();

    // The blocked second A is SKIPPED rather than blocking the scan, so the
    // later distinct scope still gets its chance.
    expect(h.store.claims.at(-1)?.candidates.map((c) => c.scope)).toEqual([SCOPE_A, SCOPE_B]);
    expect(h.controller.queuedCount).toBe(3);

    h.controller.closeAdmission();
    for (const outcome of await Promise.all([firstA, secondA, firstB])) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("caps one batch at the configured global limit", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const waiters = [h.acquire(SCOPE_A)];
    await flush();
    waiters.push(h.acquire(SCOPE_A), h.acquire(SCOPE_B), h.acquire(SCOPE_B));
    await flush();
    h.fireRetry();

    // The server can never grant more than the global limit at once, so a larger
    // batch would only be wasted work.
    expect(h.store.claims.at(-1)?.candidates).toHaveLength(2);
    expect(h.controller.queuedCount).toBe(4);
    // The other side of `min(maxActive, MAX_CAPACITY_CLAIM_BATCH)` is
    // unreachable through validated configuration: the ceiling IS the largest
    // configurable global limit, so the configured limit is always the bound.
    expect(MAX_CAPACITY_CLAIM_BATCH).toBe(CAPACITY_LIMITS.maxConcurrent.max);

    h.controller.closeAdmission();
    for (const outcome of await Promise.all(waiters)) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });
});

describe("shared capacity coordinator: per-key bypass", () => {
  it("grants the first A and the first B while a second A stays queued", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 1, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const firstA = h.acquire(SCOPE_A);
    await flush();
    let secondASettled = false;
    const secondA = h.acquire(SCOPE_A).then((outcome) => {
      secondASettled = true;
      return outcome;
    });
    const firstB = h.acquire(SCOPE_B);
    await flush();

    // The cluster has room again.
    h.store.alwaysClaim(null);
    h.fireRetry();
    expect((await firstA).ok).toBe(true);
    expect((await firstB).ok).toBe(true);
    expect(secondASettled).toBe(false);
    expect(h.controller.activeCount).toBe(2);
    expect(h.controller.queuedCount).toBe(1);
    expect([...h.store.members.values()].map((member) => member.scope).sort()).toEqual([
      SCOPE_A,
      SCOPE_B,
    ]);

    h.controller.closeAdmission();
    expect(await secondA).toEqual({ ok: false, reason: "capacity" });
  });

  it("grants a distinct scope past a per-key-blocked queue on the NEXT retry", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 1, maxQueued: 4 });
    const held = permitOf(await h.acquire(SCOPE_A));

    // Held back by the per-key limit rather than the global one, so it stays
    // queued and schedules a retry...
    const blocked = h.acquire(SCOPE_A);
    await flush();
    expect(h.controller.queuedCount).toBe(1);
    expect(h.live("retry")).toHaveLength(1);

    // ...and a distinct scope arriving behind it does not jump that backoff.
    // Per-key bypass is a property of BATCH CONSTRUCTION, not of the arrival:
    // this waiter passes the blocked one on the pending retry, one bounded delay
    // later, and never by issuing a claim of its own.
    const distinct = h.acquire(SCOPE_B);
    expect(h.store.claims).toHaveLength(2);

    h.fireRetry();
    expect(h.store.claims.at(-1)?.candidates.map((candidate) => candidate.scope)).toEqual([
      SCOPE_A,
      SCOPE_B,
    ]);
    expect((await distinct).ok).toBe(true);
    expect(h.controller.activeCount).toBe(2);
    expect(h.controller.queuedCount).toBe(1);

    h.controller.closeAdmission();
    expect(await blocked).toEqual({ ok: false, reason: "capacity" });
    held.release();
  });

  it("honours the granted OWNER TOKENS, so a grant need not be a prefix", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    let firstSettled = false;
    const first = h.acquire(SCOPE_A).then((outcome) => {
      firstSettled = true;
      return outcome;
    });
    await flush();

    h.store.alwaysClaim(null);
    // Grant ONLY the second candidate — an outcome a count could not express.
    h.store.onNextClaim(() => {
      const candidates = h.store.claims.at(-1)?.candidates ?? [];
      const chosen = candidates[1]?.owner ?? "";
      h.store.nextClaim({ kind: "claimed", granted: [chosen] });
    });
    const second = h.acquire(SCOPE_B);
    // The arrival queues behind the pending retry; the retry carries both.
    h.fireRetry();
    await flush();

    expect(h.store.claims.at(-1)?.candidates.map((c) => c.scope)).toEqual([SCOPE_A, SCOPE_B]);
    expect((await second).ok).toBe(true);
    expect(firstSettled).toBe(false);
    expect(h.controller.activeCount).toBe(1);
    expect(h.controller.queuedCount).toBe(1);

    h.controller.closeAdmission();
    expect(await first).toEqual({ ok: false, reason: "capacity" });
  });
});

describe("shared capacity coordinator: a full cluster", () => {
  it("leaves a waiter QUEUED and grants it on a later retry", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1 });
    expect((await h.acquire(SCOPE_A)).ok).toBe(true);

    let settled = false;
    const waiter = h.acquire(SCOPE_B).then((outcome) => {
      settled = true;
      return outcome;
    });
    await flush();

    // Being at the limit right now is ordinary backpressure, NOT a rejection:
    // only the queue-length and queue-wait bounds may produce a `429`.
    expect(settled).toBe(false);
    expect(h.controller.queuedCount).toBe(1);
    expect(h.store.claims.at(-1)?.candidates).toHaveLength(1);

    const retries = h.live("retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.ms).toBeGreaterThanOrEqual(1);
    expect(retries[0]?.ms).toBeLessThanOrEqual(CAPACITY_RETRY_MAX_MS);

    // The holder's lease elapses, so the next retry finds room.
    h.store.advanceMs(REQUEST_TIMEOUT_MS + CAPACITY_LEASE_MARGIN_MS + 1);
    h.fireRetry();
    expect((await waiter).ok).toBe(true);
    expect(h.store.claims).toHaveLength(3);
  });
});

describe("shared capacity coordinator: retry schedule", () => {
  it("draws the retry delay symmetrically around the base", async () => {
    for (const [draw, factor] of [
      [0, 0.75],
      [0.5, 1],
      [1, 1.25],
    ] as const) {
      const h = harness({ maxActive: 1, maxActivePerScope: 1 }, () => draw);
      h.store.alwaysClaim({ kind: "claimed", granted: [] });
      const waiter = h.acquire(SCOPE_A);
      await flush();
      expect(h.retryDelays()).toEqual([Math.round(factor * CAPACITY_RETRY_INITIAL_MS)]);
      h.controller.closeAdmission();
      expect(await waiter).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("escalates a consecutive full outcome up to the one-second cap", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1 }, () => 0);
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const waiter = h.acquire(SCOPE_A);
    await flush();
    for (let round = 0; round < 24; round += 1) {
      // A second timer would multiply claims per queue.
      expect(h.live("retry")).toHaveLength(1);
      h.fireRetry();
      await flush();
    }

    const delays = h.retryDelays();
    expect(delays[0]).toBe(Math.round(0.75 * CAPACITY_RETRY_INITIAL_MS));
    for (const [index, delay] of delays.entries()) {
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(CAPACITY_RETRY_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(delays[index - 1] ?? delay);
    }
    // Saturated: the stored base is clamped at the cap, so the jittered floor is.
    expect(delays.at(-1)).toBe(Math.round(0.75 * CAPACITY_RETRY_MAX_MS));

    h.controller.closeAdmission();
    expect(await waiter).toEqual({ ok: false, reason: "capacity" });
  });

  it("never exceeds the cap even at the top of the jitter band", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1 }, () => 1);
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const waiter = h.acquire(SCOPE_A);
    await flush();
    for (let round = 0; round < 24; round += 1) {
      h.fireRetry();
      await flush();
    }

    const delays = h.retryDelays();
    expect(delays[0]).toBe(Math.round(1.25 * CAPACITY_RETRY_INITIAL_MS));
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(CAPACITY_RETRY_MAX_MS);
    }
    expect(delays.at(-1)).toBe(CAPACITY_RETRY_MAX_MS);

    h.controller.closeAdmission();
    expect(await waiter).toEqual({ ok: false, reason: "capacity" });
  });

  it("resets the backoff as soon as a claim grants anything", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 1, maxQueued: 8 }, () => 0);
    const held = permitOf(await h.acquire(SCOPE_B));

    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const waiterA = h.acquire(SCOPE_A);
    await flush();
    const waiterB = h.acquire(SCOPE_B);
    await flush();
    for (let round = 0; round < 3; round += 1) {
      h.fireRetry();
      await flush();
    }
    const escalated = h.retryDelays().at(-1) ?? 0;
    expect(escalated).toBeGreaterThan(Math.round(0.75 * CAPACITY_RETRY_INITIAL_MS));

    // The next claim grants A (its scope is free) but not B (the global limit is
    // reached), which is progress, so the backoff starts over from its floor.
    h.store.alwaysClaim(null);
    h.fireRetry();
    await flush();
    expect((await waiterA).ok).toBe(true);
    expect(h.retryDelays().at(-1)).toBe(Math.round(0.75 * CAPACITY_RETRY_INITIAL_MS));

    h.controller.closeAdmission();
    expect(await waiterB).toEqual({ ok: false, reason: "capacity" });
    held.release();
  });

  it("releases the shared retry timer when admission closes", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const first = h.acquire(SCOPE_A);
    await flush();
    expect(h.live("retry")).toHaveLength(1);

    h.controller.closeAdmission();
    expect(h.live("retry")).toHaveLength(0);
    expect(await first).toEqual({ ok: false, reason: "capacity" });
  });
});

describe("shared capacity coordinator: claim triggers", () => {
  it("claims immediately for the first arrival and queues the rest behind it", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4, maxQueued: 4 });
    h.store.deferNextClaim();
    const first = h.acquire(SCOPE_A);
    // Nothing is in flight and nothing is scheduled, so there is nothing to wait
    // for: an idle replica must not make its first request pay a retry delay.
    expect(h.store.claims).toHaveLength(1);
    expect(h.live("retry")).toHaveLength(0);

    const second = h.acquire(SCOPE_B);
    // Single-flight is what keeps a burst of arrivals from becoming a burst of
    // round trips, so this one simply joins the queue.
    expect(h.store.claims).toHaveLength(1);
    expect(h.controller.queuedCount).toBe(2);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await first).ok).toBe(true);
    h.fireRetry();
    expect((await second).ok).toBe(true);
    expect(h.store.claims).toHaveLength(2);
  });

  it("leaves a pending retry untouched while fresh arrivals queue behind it", async () => {
    const h = harness({ maxActive: 8, maxActivePerScope: 8, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const first = h.acquire(SCOPE_A);
    await flush();
    expect(h.store.claims).toHaveLength(1);
    const [scheduled] = h.live("retry");
    expect(scheduled).toBeDefined();

    // The backoff exists precisely to bound how often a full replica talks to
    // Redis. An arrival is no evidence that the cluster has room again, so it
    // may neither cancel the timer nor pull it forward; otherwise sustained
    // traffic drives claims at arrival (really round-trip) frequency.
    const arrivals = [h.acquire(SCOPE_B), h.acquire(SCOPE_A), h.acquire(SCOPE_B)];
    await flush();
    expect(h.store.claims).toHaveLength(1);
    expect(h.live("retry")).toHaveLength(1);
    expect(h.live("retry")[0]).toBe(scheduled);
    // Not rescheduled either: a fresh draw per arrival would restart the delay.
    expect(h.retryDelays()).toHaveLength(1);
    expect(h.controller.queuedCount).toBe(4);

    // Firing it produces exactly ONE claim, carrying every waiter that arrived.
    h.fireRetry();
    expect(h.store.claims).toHaveLength(2);
    expect(h.store.claims[1]?.candidates).toHaveLength(4);
    await flush();

    h.controller.closeAdmission();
    for (const outcome of await Promise.all([first, ...arrivals])) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("releases a retry armed for a queue that has since drained", async () => {
    const h = harness({ maxActive: 8, maxActivePerScope: 8, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const tracked = h.trackedSignal();
    const departing = h.acquire(SCOPE_A, { signal: tracked });
    await flush();
    expect(h.live("retry")).toHaveLength(1);

    // Every waiter leaves, so the armed retry now has nothing to retry FOR.
    // Leaving it armed would be a silent latency cost rather than a correctness
    // bug: the next arrival would find a pending timer, decline to claim, and
    // wait out its remainder — up to CAPACITY_RETRY_MAX_MS on an idle replica.
    tracked.abort();
    expect(await departing).toEqual({ ok: false, reason: "cancelled" });
    expect(h.controller.queuedCount).toBe(0);
    expect(h.live("retry")).toHaveLength(0);

    // So the next arrival claims at once, exactly as it would on a fresh replica.
    h.store.alwaysClaim(null);
    const next = h.acquire(SCOPE_B);
    expect(h.store.claims).toHaveLength(2);
    expect((await next).ok).toBe(true);
  });

  it("keeps a retry armed while any waiter is still queued behind a departure", async () => {
    // MUTATION GUARD for the test above: cancelling on ANY departure, rather
    // than only on a drained queue, would let a departure hand the next arrival
    // an immediate claim and reopen the bypass Finding 4 closed.
    const h = harness({ maxActive: 8, maxActivePerScope: 8, maxQueued: 8 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const tracked = h.trackedSignal();
    const leaving = h.acquire(SCOPE_A, { signal: tracked });
    await flush();
    const staying = h.acquire(SCOPE_B);
    await flush();
    const [scheduled] = h.live("retry");
    expect(h.controller.queuedCount).toBe(2);

    tracked.abort();
    expect(await leaving).toEqual({ ok: false, reason: "cancelled" });
    expect(h.controller.queuedCount).toBe(1);
    expect(h.live("retry")).toHaveLength(1);
    expect(h.live("retry")[0]).toBe(scheduled);
    expect(h.store.claims).toHaveLength(1);

    h.controller.closeAdmission();
    expect(await staying).toEqual({ ok: false, reason: "capacity" });
  });

  it("holds the claim rate to the retry cadence under sustained arrivals", async () => {
    const h = harness({ maxActive: 8, maxActivePerScope: 8, maxQueued: 64 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const waiters = [h.acquire(SCOPE_A)];
    await flush();
    expect(h.store.claims).toHaveLength(1);

    const cycles = 5;
    const perCycle = 6;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let arrival = 0; arrival < perCycle; arrival += 1) {
        waiters.push(h.acquire(arrival % 2 === 0 ? SCOPE_A : SCOPE_B));
      }
      // A whole cycle of arrivals bought no round trip at all...
      expect(h.store.claims).toHaveLength(cycle + 1);
      h.fireRetry();
      await flush();
      // ...and the timer bought exactly one.
      expect(h.store.claims).toHaveLength(cycle + 2);
    }

    // One claim for the opening arrival plus one per retry: the cost to Redis
    // tracks the BOUNDED cadence, never the offered load.
    expect(waiters).toHaveLength(1 + cycles * perCycle);
    expect(h.store.claims).toHaveLength(1 + cycles);
    expect(h.live("retry")).toHaveLength(1);

    h.controller.closeAdmission();
    for (const outcome of await Promise.all(waiters)) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("lets ONLY a release attempt for a locally held permit pre-empt the retry", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1, maxQueued: 4 });
    const permit = permitOf(await h.acquire(SCOPE_A));
    const waiter = h.acquire(SCOPE_B);
    await flush();
    expect(h.live("retry")).toHaveLength(1);
    const claimed = h.store.claims.length;

    // An arrival says nothing about cluster occupancy.
    const arrival = h.acquire(SCOPE_B);
    expect(h.store.claims).toHaveLength(claimed);
    expect(h.live("retry")).toHaveLength(1);

    // Releasing a permit this replica confirmed it HELD does pre-empt it. What
    // is confirmed is only the local side — the Redis release is best effort and
    // is not awaited — so this buys ONE bounded immediate probe rather than a
    // guarantee that cluster occupancy fell.
    permit.release();
    expect(h.store.claims).toHaveLength(claimed + 1);
    expect(h.live("retry")).toHaveLength(0);
    expect(h.timers.filter((timer) => timer.kind === "retry" && timer.cancelled)).toHaveLength(1);

    expect((await waiter).ok).toBe(true);
    expect(h.controller.activeCount).toBe(1);

    h.controller.closeAdmission();
    expect(await arrival).toEqual({ ok: false, reason: "capacity" });
  });
});

describe("shared capacity coordinator: queue bounds", () => {
  it("still admits an immediately claimable request when the queue length is zero", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 0 });
    h.store.deferNextClaim();
    const first = h.acquire(SCOPE_A);

    // A pending claim candidate is not a queued waiter: occupancy is only
    // knowable after a round trip, so there is no local fast path to take.
    expect(h.controller.queuedCount).toBe(1);
    expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "capacity" });
    expect(h.store.claims).toHaveLength(1);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await first).ok).toBe(true);
  });

  it("rejects the request past the queue bound with `capacity`", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4, maxQueued: 2 });
    h.store.deferNextClaim();
    const pending = h.acquire(SCOPE_A);
    const queued = [h.acquire(SCOPE_A), h.acquire(SCOPE_A)];
    expect(h.controller.queuedCount).toBe(3);

    expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "capacity" });

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await pending).ok).toBe(true);
    h.fireRetry();
    for (const outcome of await Promise.all(queued)) expect(outcome.ok).toBe(true);
  });

  it("grants an immediately available request with a zero-length queue", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 0 });
    // The carve-out that makes `MAX_QUEUED_REQUESTS=0` usable at all: a request
    // that can start its own claim is a pending CANDIDATE, not a queued waiter.
    expect((await h.acquire(SCOPE_A)).ok).toBe(true);
    expect(h.controller.activeCount).toBe(1);
    expect(h.store.claims).toHaveLength(1);
    expect(h.live()).toHaveLength(0);
  });

  it("rejects an UNGRANTED immediate claim with `capacity` when the queue is zero-length", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 0 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });

    // The carve-out lasts exactly one Redis command. A candidate that comes back
    // ungranted is an ordinary queued waiter again, and a zero-length queue has
    // no room for it — so it gets the route's existing `429` rather than
    // retrying forever behind a bound that was never reapplied.
    expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "capacity" });
    expect(h.store.claims).toHaveLength(1);
    expect(h.controller.queuedCount).toBe(0);
    expect(h.live()).toHaveLength(0);
    expect(h.attachedListeners()).toBe(0);
  });

  it("still fails closed with `unavailable` when the queue is zero-length", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 0 });
    h.store.alwaysClaim({ kind: "unavailable" });
    // The fail-closed branch settles every candidate itself and returns nothing
    // to the queue, so the bound has nothing to reapply: the outcome stays the
    // undecidable `503`, never the "cluster is busy" `429`.
    expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "unavailable" });
    expect(h.controller.queuedCount).toBe(0);
    expect(h.store.releases).toHaveLength(0);
    expect(h.live()).toHaveLength(0);
  });

  it("reapplies the bound after a partial grant, keeping the EARLIEST waiters", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4, maxQueued: 3 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const first = h.acquire(SCOPE_A);
    await flush();
    const second = h.acquire(SCOPE_A);
    const third = h.acquire(SCOPE_A);
    expect(h.controller.queuedCount).toBe(3);

    // One batch of all three, held open, granting only its first candidate.
    h.store.alwaysClaim(null);
    h.store.deferNextClaim();
    h.store.onNextClaim(() => {
      const candidates = h.store.claims.at(-1)?.candidates ?? [];
      h.store.nextClaim({ kind: "claimed", granted: [candidates[0]?.owner ?? ""] });
    });
    h.fireRetry();
    expect(h.store.claims.at(-1)?.candidates).toHaveLength(3);

    // These see an EMPTY queue while the claim is in flight, so all three are
    // admitted; the two ungranted candidates then rejoin ahead of them.
    const fourth = h.acquire(SCOPE_B);
    const fifth = h.acquire(SCOPE_B);
    const sixth = h.acquire(SCOPE_B);
    expect(h.controller.queuedCount).toBe(6);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await first).ok).toBe(true);
    // Overflow is shed from the BACK, so the waiters that have already waited
    // longest keep their places.
    expect(await fifth).toEqual({ ok: false, reason: "capacity" });
    expect(await sixth).toEqual({ ok: false, reason: "capacity" });
    expect(h.controller.queuedCount).toBe(3);
    // ...and each rejected waiter took its timer and its abort listener with it.
    expect(h.live("queue-wait")).toHaveLength(3);
    expect(h.attachedListeners()).toBe(3);

    // Exact FIFO order survives the merge: ungranted candidates, then arrivals.
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    h.fireRetry();
    expect(h.store.claims.at(-1)?.candidates.map((candidate) => candidate.scope)).toEqual([
      SCOPE_A,
      SCOPE_A,
      SCOPE_B,
    ]);

    h.controller.closeAdmission();
    for (const outcome of await Promise.all([second, third, fourth])) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("holds the steady-state queue at its bound across repeated full batches", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4, maxQueued: 2 });
    h.store.alwaysClaim({ kind: "claimed", granted: [] });
    const opening = h.acquire(SCOPE_A);
    await flush();
    const retained = [opening, h.acquire(SCOPE_A)];
    const shed: Promise<CapacityAcquisition>[] = [];

    for (let round = 0; round < 4; round += 1) {
      // A batch takes the whole queue, so arrivals during it see an empty one.
      h.store.deferNextClaim();
      h.fireRetry();
      shed.push(h.acquire(SCOPE_B), h.acquire(SCOPE_B));
      expect(h.controller.queuedCount).toBe(4);

      expect(h.store.settleDeferredClaim()).toBe(true);
      await flush();
      // The moment the claim settles they are ordinary waiters again, and the
      // replica sheds straight back down to its bound — the pending batch may
      // exceed it only for the duration of ONE in-flight command.
      expect(h.controller.queuedCount).toBe(2);
    }

    for (const outcome of await Promise.all(shed)) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
    expect(h.live("queue-wait")).toHaveLength(2);
    expect(h.attachedListeners()).toBe(2);

    h.controller.closeAdmission();
    for (const outcome of await Promise.all(retained)) {
      expect(outcome).toEqual({ ok: false, reason: "capacity" });
    }
  });

  it("resolves a waiter with `capacity` when its queue wait elapses, exactly once", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1 });
    expect((await h.acquire(SCOPE_A)).ok).toBe(true);
    const tracked = h.trackedSignal();
    const waiter = h.acquire(SCOPE_B, { signal: tracked });
    await flush();
    expect(h.controller.queuedCount).toBe(1);

    h.fireQueueWait();
    expect(await waiter).toEqual({ ok: false, reason: "capacity" });
    expect(h.controller.queuedCount).toBe(0);
    expect(tracked.attached()).toBe(0);

    // A late abort must not re-settle or re-remove an already-departed waiter.
    tracked.abort();
    expect(await waiter).toEqual({ ok: false, reason: "capacity" });
    expect(h.controller.queuedCount).toBe(0);
    expect(h.live("queue-wait")).toHaveLength(0);
  });
});

describe("shared capacity coordinator: cancellation", () => {
  it("resolves a queued waiter with `cancelled` when its signal aborts", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1 });
    expect((await h.acquire(SCOPE_A)).ok).toBe(true);
    const tracked = h.trackedSignal();
    const waiter = h.acquire(SCOPE_B, { signal: tracked });
    await flush();
    expect(h.controller.queuedCount).toBe(1);
    expect(tracked.attached()).toBe(1);

    tracked.abort();
    expect(await waiter).toEqual({ ok: false, reason: "cancelled" });
    expect(h.controller.queuedCount).toBe(0);
    expect(tracked.attached()).toBe(0);
    expect(h.live("queue-wait")).toHaveLength(0);
  });

  it("short-circuits an already-aborted signal without enqueueing or claiming", async () => {
    const h = harness();
    const tracked = h.trackedSignal();
    tracked.abort();

    expect(await h.acquire(SCOPE_A, { signal: tracked })).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(h.store.claims).toHaveLength(0);
    expect(h.store.releases).toHaveLength(0);
    expect(h.controller.queuedCount).toBe(0);
    expect(h.timers).toHaveLength(0);
    expect(tracked.attached()).toBe(0);
  });
});

describe("shared capacity coordinator: failing closed", () => {
  it("reports `unavailable` for a missing capacity scope without touching Redis", async () => {
    for (const scope of [null, ""]) {
      const h = harness();
      // Shared capacity is enabled but this request carries no cross-replica
      // identity: never a silent downgrade to process-local accounting.
      expect(await h.acquire(scope)).toEqual({ ok: false, reason: "unavailable" });
      expect(h.store.claims).toHaveLength(0);
      expect(h.store.releases).toHaveLength(0);
      expect(h.controller.activeCount).toBe(0);
      expect(h.controller.queuedCount).toBe(0);
      expect(h.timers).toHaveLength(0);
    }
  });

  it("reports `unavailable` without enqueueing while the store is not ready", async () => {
    const h = harness();
    h.store.setReady(false);
    expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "unavailable" });
    // Nothing waits behind a dependency already known to be unusable.
    expect(h.store.claims).toHaveLength(0);
    expect(h.controller.queuedCount).toBe(0);
    expect(h.timers).toHaveLength(0);
  });

  it.each([
    [
      "an unavailable",
      (store: FakeSharedCapacityStore) => store.alwaysClaim({ kind: "unavailable" }),
    ],
    ["a corrupt", (store: FakeSharedCapacityStore) => store.alwaysClaim({ kind: "corrupt" })],
    ["a rejected", (store: FakeSharedCapacityStore) => store.rejectClaimWith("not an Error")],
  ] as const)(
    "fails closed on %s claim, with no retry and no compensation",
    async (_label, fault) => {
      const h = harness({ maxActive: 4, maxActivePerScope: 4, maxQueued: 8 });
      fault(h.store);
      const outcomes = await Promise.all([
        h.acquire(SCOPE_A),
        h.acquire(SCOPE_B),
        h.acquire(SCOPE_B),
      ]);

      for (const outcome of outcomes) expect(outcome).toEqual({ ok: false, reason: "unavailable" });
      // No candidate is ever resubmitted: whether a member was added is unknown, so
      // a retry could double-count a permit this replica already holds.
      const submitted = h.store.claims.flatMap((claim) =>
        claim.candidates.map((candidate) => candidate.owner),
      );
      expect(submitted).toHaveLength(3);
      expect(new Set(submitted).size).toBe(3);
      // And no speculative release: it could remove a member another replica holds.
      expect(h.store.releases).toHaveLength(0);
      expect(h.controller.activeCount).toBe(0);
      expect(h.controller.queuedCount).toBe(0);
      expect(h.live()).toHaveLength(0);
    },
  );
});

describe("shared capacity coordinator: a grant for a departed waiter", () => {
  it.each([
    ["an aborted signal", "cancelled", (_h: Harness, tracked: TrackedSignal) => tracked.abort()],
    ["an elapsed queue wait", "capacity", (h: Harness) => h.fireQueueWait()],
    ["closed admission", "capacity", (h: Harness) => h.controller.closeAdmission()],
  ] as const)("hands back a grant confirmed after %s", async (_label, reason, depart) => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2 });
    const tracked = h.trackedSignal();
    h.store.deferNextClaim();
    const waiter = h.acquire(SCOPE_A, { signal: tracked });
    expect(h.store.hasDeferredClaim()).toBe(true);
    expect(h.controller.queuedCount).toBe(1);

    depart(h, tracked);
    // A departed pending candidate is no longer a WAITING request; it is retained
    // only so a grant that arrives for it can be released.
    expect(h.controller.queuedCount).toBe(0);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect(await waiter).toEqual({ ok: false, reason });
    await flush();

    // The permit is never delivered, and nothing else would ever give it back.
    expect(h.controller.activeCount).toBe(0);
    expect(h.store.releases).toEqual([
      {
        key: REGISTRY_KEY,
        owner: h.store.claims[0]?.candidates[0]?.owner,
        scope: SCOPE_A,
        // WITHOUT the request's signal: a released permit must be returned even
        // when the request that held it was cancelled.
        hadSignal: false,
      },
    ]);
    expect(h.store.members.size).toBe(0);
    expect(tracked.attached()).toBe(0);
  });
});

describe("shared capacity coordinator: releasing", () => {
  it("releases a permit synchronously and idempotently", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2 });
    const permit = permitOf(await h.acquire(SCOPE_A));
    const owner = h.store.claims[0]?.candidates[0]?.owner;

    permit.release();
    expect(h.controller.activeCount).toBe(0);
    expect(h.store.releases).toHaveLength(1);
    expect(h.store.releases[0]?.owner).toBe(owner);
    expect(h.store.releases[0]?.hadSignal).toBe(false);
    expect(h.store.members.size).toBe(0);

    permit.release();
    expect(h.controller.activeCount).toBe(0);
    expect(h.store.releases).toHaveLength(1);
  });

  it("never lets a failed release change an answer already given", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2 });
    const outcome = await h.acquire(SCOPE_A);
    const permit = permitOf(outcome);

    h.store.alwaysRelease({ kind: "unavailable" });
    expect(() => {
      permit.release();
    }).not.toThrow();
    await flush();

    expect(outcome.ok).toBe(true);
    expect(h.controller.activeCount).toBe(0);
    // Nothing is retried: the orphaned member expires with its own lease, which
    // conservatively under-admits this replica until then.
    expect(h.store.releases).toHaveLength(1);
    expect(h.store.members.size).toBe(1);
  });

  it.each([
    ["a synchronous throw", "sync"],
    ["an asynchronous rejection", "async"],
  ] as const)("never lets %s from the store escape `Permit.release()`", async (_label, mode) => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1, maxQueued: 4 });
    const outcome = await h.acquire(SCOPE_A);
    const permit = permitOf(outcome);
    let settled = false;
    const waiter = h.acquire(SCOPE_B).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);
    expect(h.live("retry")).toHaveLength(1);

    // The route calls `release()` from a `finally`, so a failure that escaped
    // would replace an already successful response with one. A SYNCHRONOUS throw
    // is the case a bare `.catch` on the returned promise cannot reach: it
    // happens while evaluating the argument, before any promise exists.
    h.store.failReleaseWith(new Error("release exploded"), mode);
    expect(() => {
      permit.release();
    }).not.toThrow();

    expect(outcome.ok).toBe(true);
    // Local accounting decremented exactly once...
    expect(h.controller.activeCount).toBe(0);
    // ...and the scheduler still woke, pre-empting the backoff as usual.
    expect(h.store.claims).toHaveLength(3);
    expect(h.live("retry")).toHaveLength(0);
    await flush();

    // A double release stays a no-op.
    permit.release();
    expect(h.controller.activeCount).toBe(0);
    expect(h.store.releases).toHaveLength(1);

    // The member the failed release left behind conservatively under-admits this
    // replica until its own lease expires, and no further.
    expect(settled).toBe(false);
    h.store.failReleaseWith(null);
    h.store.advanceMs(REQUEST_TIMEOUT_MS + CAPACITY_LEASE_MARGIN_MS + 1);
    h.fireRetry();
    expect((await waiter).ok).toBe(true);
  });

  it("never lets a synchronous release throw escape a claim settlement", async () => {
    const h = harness({ maxActive: 2, maxActivePerScope: 2, maxQueued: 4 });
    const tracked = h.trackedSignal();
    h.store.deferNextClaim();
    const departed = h.acquire(SCOPE_A, { signal: tracked });
    const queued = h.acquire(SCOPE_B);
    tracked.abort();

    // Handing back a departed waiter's confirmed grant happens INSIDE the
    // settlement, so a throw there would abandon the rest of the batch and
    // surface only as an unhandled rejection.
    h.store.failReleaseWith(new Error("release exploded"), "sync");
    expect(h.store.settleDeferredClaim()).toBe(true);
    expect(await departed).toEqual({ ok: false, reason: "cancelled" });
    await flush();

    expect(h.store.releases).toHaveLength(1);
    expect(h.controller.activeCount).toBe(0);
    // The settlement ran to the end: the waiter that arrived during the claim
    // still got its own decision.
    h.store.failReleaseWith(null);
    h.fireRetry();
    expect((await queued).ok).toBe(true);
  });

  it("wakes the scheduler on release instead of waiting out the backoff", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1 });
    const permit = permitOf(await h.acquire(SCOPE_A));
    let settled = false;
    const waiter = h.acquire(SCOPE_B).then((outcome) => {
      settled = true;
      return outcome;
    });
    await flush();
    expect(settled).toBe(false);
    expect(h.live("retry")).toHaveLength(1);
    const before = h.store.claims.length;

    permit.release();
    // This replica just freed a slot, so a claim has a real chance right now.
    expect(h.store.claims).toHaveLength(before + 1);
    expect(h.live("retry")).toHaveLength(0);
    expect((await waiter).ok).toBe(true);
    expect(h.controller.activeCount).toBe(1);
  });
});

describe("shared capacity coordinator: closing admission", () => {
  it("closes for queued, pending, and future requests alike", async () => {
    const h = harness({ maxActive: 1, maxActivePerScope: 1, maxQueued: 4 });
    const held = permitOf(await h.acquire(SCOPE_A));
    const first = h.acquire(SCOPE_B);
    await flush();
    const second = h.acquire(SCOPE_B);
    await flush();
    expect(h.controller.queuedCount).toBe(2);
    expect(h.live("retry")).toHaveLength(1);

    h.controller.closeAdmission();
    expect(await first).toEqual({ ok: false, reason: "capacity" });
    expect(await second).toEqual({ ok: false, reason: "capacity" });
    expect(h.controller.queuedCount).toBe(0);
    expect(h.live()).toHaveLength(0);
    expect(h.attachedListeners()).toBe(0);

    expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "capacity" });
    // A held permit stays releasable across shutdown.
    held.release();
    expect(h.controller.activeCount).toBe(0);
  });

  it("leaves no waiter timer or abort listener behind on any exit path", async () => {
    const paths: readonly [string, (h: Harness) => Promise<void>][] = [
      [
        "granted then released",
        async (h) => {
          permitOf(await h.acquire(SCOPE_A)).release();
        },
      ],
      [
        "already aborted",
        async (h) => {
          const tracked = h.trackedSignal();
          tracked.abort();
          await h.acquire(SCOPE_A, { signal: tracked });
        },
      ],
      [
        "cancelled while queued",
        async (h) => {
          permitOf(await h.acquire(SCOPE_A));
          const tracked = h.trackedSignal();
          const waiter = h.acquire(SCOPE_B, { signal: tracked });
          await flush();
          tracked.abort();
          await waiter;
        },
      ],
      [
        "queue wait elapsed",
        async (h) => {
          permitOf(await h.acquire(SCOPE_A));
          const waiter = h.acquire(SCOPE_B);
          await flush();
          h.fireQueueWait();
          await waiter;
        },
      ],
      [
        "claim unavailable",
        async (h) => {
          h.store.alwaysClaim({ kind: "unavailable" });
          await h.acquire(SCOPE_A);
        },
      ],
      [
        "claim corrupt",
        async (h) => {
          h.store.alwaysClaim({ kind: "corrupt" });
          await h.acquire(SCOPE_A);
        },
      ],
      [
        "missing scope",
        async (h) => {
          await h.acquire(null);
        },
      ],
      [
        "store not ready",
        async (h) => {
          h.store.setReady(false);
          await h.acquire(SCOPE_A);
        },
      ],
      [
        "queue full",
        async (h) => {
          h.store.deferNextClaim();
          const pending = h.acquire(SCOPE_A);
          const queued = h.acquire(SCOPE_A);
          expect(await h.acquire(SCOPE_A)).toEqual({ ok: false, reason: "capacity" });
          h.controller.closeAdmission();
          expect(h.store.settleDeferredClaim()).toBe(true);
          await Promise.all([pending, queued]);
          await flush();
        },
      ],
      [
        "departed while pending",
        async (h) => {
          const tracked = h.trackedSignal();
          h.store.deferNextClaim();
          const waiter = h.acquire(SCOPE_A, { signal: tracked });
          tracked.abort();
          expect(h.store.settleDeferredClaim()).toBe(true);
          await waiter;
          await flush();
        },
      ],
    ];

    for (const [, run] of paths) {
      const h = harness({ maxActive: 1, maxActivePerScope: 1, maxQueued: 1 });
      await run(h);
      // Every settled waiter has released its own timer and abort listener...
      expect(h.live("queue-wait")).toHaveLength(0);
      expect(h.attachedListeners()).toBe(0);
      // ...and the ONE shared retry timer, which is bounded and `unref`ed in
      // production, is released by closing admission.
      expect(h.live("retry").length).toBeLessThanOrEqual(1);
      h.controller.closeAdmission();
      await flush();
      expect(h.live()).toHaveLength(0);
      expect(h.attachedListeners()).toBe(0);
    }
  });
});

describe("shared capacity coordinator: gauges", () => {
  it("counts waiting requests, excludes a departed candidate, and counts only confirmed permits", async () => {
    const h = harness({ maxActive: 4, maxActivePerScope: 4, maxQueued: 4 });
    const tracked = h.trackedSignal();
    h.store.deferNextClaim();
    const pending = h.acquire(SCOPE_A, { signal: tracked });
    const queued = [h.acquire(SCOPE_A), h.acquire(SCOPE_B)];
    expect(h.controller.queuedCount).toBe(3);
    expect(h.controller.activeCount).toBe(0);

    tracked.abort();
    expect(h.controller.queuedCount).toBe(2);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: "cancelled" });
    await flush();
    // The departed candidate's confirmed grant was handed back, so it was never
    // active on this replica.
    expect(h.controller.activeCount).toBe(0);
    expect(h.controller.queuedCount).toBe(2);

    h.fireRetry();
    for (const outcome of await Promise.all(queued)) expect(outcome.ok).toBe(true);
    expect(h.controller.activeCount).toBe(2);
    expect(h.controller.queuedCount).toBe(0);
  });
});

describe("createUnavailableCapacityController", () => {
  const request: CapacityRequest = {
    keyId: LOCAL_KEY_ID,
    capacityScopeId: SCOPE_A,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    signal: new AbortController().signal,
  };

  it("admits nothing, holds nothing, and closes safely", async () => {
    // The fail-closed backstop for `SHARED_CAPACITY_ENABLED=true` with no
    // coordinator composed: falling back to the process-local controller would
    // silently multiply the cluster-wide limit by the replica count.
    const controller = createUnavailableCapacityController();
    expect(await controller.acquire(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(controller.activeCount).toBe(0);
    expect(controller.queuedCount).toBe(0);

    expect(() => {
      controller.closeAdmission();
    }).not.toThrow();
    expect(await controller.acquire(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(controller.activeCount).toBe(0);
    expect(controller.queuedCount).toBe(0);
  });
});
