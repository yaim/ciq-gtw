import { afterEach, describe, expect, it, vi } from "vitest";
import { runGracefulShutdown, type GracefulShutdownDeps } from "../../src/index.js";

/** A resolvable close() barrier so the test controls drain timing. */
function deferredClose(): { close: () => Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { close: () => promise, resolve };
}

interface Trace {
  order: string[];
  aborted: number;
}

function makeDeps(over: Partial<GracefulShutdownDeps>, trace: Trace): GracefulShutdownDeps {
  return {
    setNotReady: () => trace.order.push("setNotReady"),
    closeAdmission: () => trace.order.push("closeAdmission"),
    abortInFlight: () => {
      trace.aborted += 1;
      trace.order.push("abortInFlight");
    },
    close: () => Promise.resolve(),
    drainMs: 30_000,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runGracefulShutdown", () => {
  it("flips readiness and closes admission before draining, then aborts once", async () => {
    const trace: Trace = { order: [], aborted: 0 };
    await runGracefulShutdown(makeDeps({ close: () => Promise.resolve() }, trace));
    expect(trace.order).toEqual(["setNotReady", "closeAdmission", "abortInFlight"]);
    // No process.exit, no leftover work.
    expect(trace.aborted).toBe(1);
  });

  it("force-cancels in-flight work when close() outlasts the drain window", async () => {
    vi.useFakeTimers();
    const trace: Trace = { order: [], aborted: 0 };
    const barrier = deferredClose();
    const promise = runGracefulShutdown(makeDeps({ close: barrier.close, drainMs: 1_000 }, trace));

    // Readiness/admission happen synchronously; close() is still pending.
    expect(trace.order).toEqual(["setNotReady", "closeAdmission"]);
    expect(trace.aborted).toBe(0);

    // The drain window elapses → in-flight work is aborted while close() hangs.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(trace.aborted).toBe(1);

    // close() finally resolves; the sequence completes (idempotent final abort).
    barrier.resolve();
    await promise;
    expect(trace.aborted).toBe(2);
  });

  it("clears the drain timer when close() resolves within the window", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const trace: Trace = { order: [], aborted: 0 };
    await runGracefulShutdown(makeDeps({ close: () => Promise.resolve(), drainMs: 1_000 }, trace));
    expect(clearSpy).toHaveBeenCalled();
    // Aborted exactly once (the final idempotent abort), never via the timer.
    expect(trace.aborted).toBe(1);
    // Advancing past the window fires no further abort (timer was cleared).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(trace.aborted).toBe(1);
    clearSpy.mockRestore();
  });

  it("routes a close() failure to the content-free error sink and still aborts", async () => {
    const trace: Trace = { order: [], aborted: 0 };
    const errors: unknown[] = [];
    await runGracefulShutdown(
      makeDeps(
        {
          close: () => Promise.reject(new Error("close failed")),
          onError: (e) => errors.push(e),
        },
        trace,
      ),
    );
    expect(errors).toHaveLength(1);
    expect(trace.aborted).toBe(1);
  });
});
