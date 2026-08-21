/**
 * Unit tests for the process-local native-title correlation service.
 *
 * A fake adapter (only `getThreadTitle`) and a controllable clock make the TTL,
 * capacity, single-flight, two-second floor, and six-attempt bounds deterministic
 * without any real time or network. The registry must never store a title, must
 * fail open (a full registry still lets the completion succeed), and must fail
 * closed (unknown/expired/exhausted → unavailable).
 */
import { describe, expect, it, vi } from "vitest";
import { createTitleBridge, type TitleBridge } from "../../src/opencode/title-bridge.js";
import type { GetThreadTitleResult } from "../../src/collectiviq/types.js";
import type { Clock } from "../../src/generation/types.js";

/** A mutable clock. */
function fakeClock(start = 0): Clock & { set(ms: number): void; advance(ms: number): void } {
  let now = start;
  return {
    nowMs: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

type TitleFn = (threadId: string, signal?: AbortSignal) => Promise<GetThreadTitleResult>;

function fakeAdapter(fn: TitleFn): { getThreadTitle: TitleFn } {
  return { getThreadTitle: vi.fn(fn) };
}

function build(fn: TitleFn, clock: Clock): TitleBridge {
  return createTitleBridge({ adapter: fakeAdapter(fn), clock });
}

const abortNever = new AbortController().signal;

describe("title bridge — registration", () => {
  it("first registration wins; a later completion never replaces it", async () => {
    const clock = fakeClock();
    const bridge = build(
      (id) => Promise.resolve({ kind: "ready", title: `title-for-${id}` }),
      clock,
    );
    bridge.register({ keyId: "k0", sessionId: "s1", upstreamThreadId: "T-first" });
    bridge.register({ keyId: "k0", sessionId: "s1", upstreamThreadId: "T-second" });
    // The first (T-first) mapping is used; move past the 2s floor to allow a lookup.
    clock.advance(2_000);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s1" }, abortNever)).resolves.toEqual({
      kind: "ready",
      title: "title-for-T-first",
    });
  });

  it("isolates correlations by gateway key", async () => {
    const clock = fakeClock();
    const bridge = build((id) => Promise.resolve({ kind: "ready", title: id }), clock);
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T-k0" });
    bridge.register({ keyId: "k1", sessionId: "s", upstreamThreadId: "T-k1" });
    clock.advance(2_000);
    await expect(bridge.lookup({ keyId: "k1", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "ready",
      title: "T-k1",
    });
  });

  it("returns unavailable for an unknown correlation", async () => {
    const clock = fakeClock();
    const bridge = build(() => Promise.resolve({ kind: "pending" }), clock);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "nope" }, abortNever)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("silently skips registration past the global cap of 128 (fail-open)", async () => {
    const clock = fakeClock();
    const bridge = build(() => Promise.resolve({ kind: "ready", title: "x" }), clock);
    for (let i = 0; i < 128; i += 1) {
      bridge.register({ keyId: `k${i}`, sessionId: "s", upstreamThreadId: `T${i}` });
    }
    // The 129th distinct correlation is dropped; its lookup is unavailable.
    bridge.register({ keyId: "kOVER", sessionId: "s", upstreamThreadId: "T-over" });
    clock.advance(2_000);
    await expect(bridge.lookup({ keyId: "kOVER", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("silently skips registration past the per-key cap of 32 (fail-open)", async () => {
    const clock = fakeClock();
    const bridge = build(() => Promise.resolve({ kind: "ready", title: "x" }), clock);
    for (let i = 0; i < 32; i += 1) {
      bridge.register({ keyId: "k0", sessionId: `s${i}`, upstreamThreadId: `T${i}` });
    }
    bridge.register({ keyId: "k0", sessionId: "sOVER", upstreamThreadId: "T-over" });
    clock.advance(2_000);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "sOVER" }, abortNever)).resolves.toEqual({
      kind: "unavailable",
    });
    // A DIFFERENT key is unaffected by k0's saturation.
    bridge.register({ keyId: "k1", sessionId: "s", upstreamThreadId: "T-k1" });
    await expect(bridge.lookup({ keyId: "k1", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "ready",
      title: "x",
    });
  });
});

describe("title bridge — TTL and lazy expiry", () => {
  it("expires a correlation after 60s (unavailable)", async () => {
    const clock = fakeClock();
    const bridge = build(() => Promise.resolve({ kind: "ready", title: "x" }), clock);
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T" });
    clock.advance(60_001);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("an expired entry frees its per-key slot on the next registration sweep", async () => {
    const clock = fakeClock();
    const bridge = build(() => Promise.resolve({ kind: "ready", title: "fresh" }), clock);
    for (let i = 0; i < 32; i += 1) {
      bridge.register({ keyId: "k0", sessionId: `s${i}`, upstreamThreadId: `T${i}` });
    }
    // All 32 expire; a new registration sweeps them and is admitted.
    clock.advance(60_001);
    bridge.register({ keyId: "k0", sessionId: "sNEW", upstreamThreadId: "T-new" });
    clock.advance(2_000);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "sNEW" }, abortNever)).resolves.toEqual({
      kind: "ready",
      title: "fresh",
    });
  });
});

describe("title bridge — lookup bounds", () => {
  it("enforces a two-second floor between actual upstream lookups", async () => {
    const clock = fakeClock();
    const adapterFn = vi.fn<TitleFn>(() => Promise.resolve({ kind: "pending" }));
    const bridge = createTitleBridge({ adapter: { getThreadTitle: adapterFn }, clock });
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T" });
    // First lookup at t=0 performs an actual call.
    await bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever);
    expect(adapterFn).toHaveBeenCalledTimes(1);
    // Within 2s: no new upstream call, returns pending.
    clock.advance(1_999);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "pending",
    });
    expect(adapterFn).toHaveBeenCalledTimes(1);
    // At/after 2s: a second actual call happens.
    clock.advance(1);
    await bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever);
    expect(adapterFn).toHaveBeenCalledTimes(2);
  });

  it("caps actual upstream lookups at six, then returns unavailable", async () => {
    const clock = fakeClock();
    const adapterFn = vi.fn<TitleFn>(() => Promise.resolve({ kind: "pending" }));
    const bridge = createTitleBridge({ adapter: { getThreadTitle: adapterFn }, clock });
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T" });
    for (let i = 0; i < 6; i += 1) {
      await bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever);
      clock.advance(2_000); // clear the floor each round
    }
    expect(adapterFn).toHaveBeenCalledTimes(6);
    // The 7th lookup is exhausted — no further upstream call.
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(adapterFn).toHaveBeenCalledTimes(6);
  });

  it("shares a single in-flight lookup across concurrent callers (single-flight)", async () => {
    const clock = fakeClock();
    let resolveFn: ((r: GetThreadTitleResult) => void) | undefined;
    const adapterFn = vi.fn<TitleFn>(
      () =>
        new Promise<GetThreadTitleResult>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const bridge = createTitleBridge({ adapter: { getThreadTitle: adapterFn }, clock });
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T" });
    const a = bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever);
    const b = bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever);
    expect(adapterFn).toHaveBeenCalledTimes(1);
    resolveFn?.({ kind: "ready", title: "shared" });
    await expect(a).resolves.toEqual({ kind: "ready", title: "shared" });
    await expect(b).resolves.toEqual({ kind: "ready", title: "shared" });
    expect(adapterFn).toHaveBeenCalledTimes(1);
  });

  it("treats a recoverable upstream failure as pending while attempts remain", async () => {
    const clock = fakeClock();
    let calls = 0;
    const bridge = build(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("upstream down"));
      return Promise.resolve({ kind: "ready", title: "recovered" });
    }, clock);
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T" });
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "pending",
    });
    clock.advance(2_000);
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "ready",
      title: "recovered",
    });
  });

  it("returns unavailable when the final permitted attempt fails", async () => {
    const clock = fakeClock();
    const bridge = build(() => Promise.reject(new Error("always down")), clock);
    bridge.register({ keyId: "k0", sessionId: "s", upstreamThreadId: "T" });
    // Attempts 1..5 fail → pending; attempt 6 (the last) fails → unavailable.
    for (let i = 0; i < 5; i += 1) {
      await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
        kind: "pending",
      });
      clock.advance(2_000);
    }
    await expect(bridge.lookup({ keyId: "k0", sessionId: "s" }, abortNever)).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
