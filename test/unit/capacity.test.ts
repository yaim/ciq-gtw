import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapacityController, type CapacityLimits } from "../../src/generation/capacity.js";
import type { CapacityAcquisition } from "../../src/generation/types.js";

function limits(overrides: Partial<CapacityLimits> = {}): CapacityLimits {
  return {
    maxConcurrent: 2,
    maxConcurrentPerKey: 2,
    maxQueued: 4,
    maxQueueWaitMs: 1_000,
    ...overrides,
  };
}

/** A signal that never aborts. */
function openSignal(): AbortSignal {
  return new AbortController().signal;
}

function grantOf(outcome: CapacityAcquisition): { release(): void } {
  if (!outcome.ok) throw new Error(`expected grant, got ${outcome.reason}`);
  return outcome.permit;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createCapacityController", () => {
  it("grants immediately when under both limits", async () => {
    const controller = createCapacityController(limits());
    const outcome = await controller.acquire("k1", openSignal());
    expect(outcome.ok).toBe(true);
    expect(controller.activeCount).toBe(1);
    expect(controller.queuedCount).toBe(0);
  });

  it("returns cancelled for an already-aborted signal", async () => {
    const controller = createCapacityController(limits());
    const outcome = await controller.acquire("k1", AbortSignal.abort());
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(controller.activeCount).toBe(0);
  });

  it("queues when the global limit is reached", async () => {
    const controller = createCapacityController(limits({ maxConcurrent: 1 }));
    await controller.acquire("k1", openSignal());
    let settled = false;
    const pending = controller.acquire("k2", openSignal()).then((o) => {
      settled = true;
      return o;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(controller.queuedCount).toBe(1);
    void pending;
  });

  it("blocks a key at its per-key limit while another key proceeds", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 3, maxConcurrentPerKey: 1 }),
    );
    await controller.acquire("A", openSignal());
    let aSecondSettled = false;
    void controller.acquire("A", openSignal()).then(() => {
      aSecondSettled = true;
    });
    const b = await controller.acquire("B", openSignal());
    await Promise.resolve();
    expect(b.ok).toBe(true);
    expect(aSecondSettled).toBe(false);
    expect(controller.queuedCount).toBe(1);
    expect(controller.activeCount).toBe(2);
  });

  it("grants queued waiters in FIFO order on release", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 1, maxConcurrentPerKey: 5 }),
    );
    const first = grantOf(await controller.acquire("A", openSignal()));
    const order: string[] = [];
    const second = controller.acquire("B", openSignal()).then((o) => {
      order.push("B");
      return grantOf(o);
    });
    const third = controller.acquire("C", openSignal()).then((o) => {
      order.push("C");
      return grantOf(o);
    });
    await Promise.resolve();
    expect(controller.queuedCount).toBe(2);

    first.release();
    const secondPermit = await second;
    expect(order).toEqual(["B"]);
    expect(controller.queuedCount).toBe(1);

    secondPermit.release();
    await third;
    expect(order).toEqual(["B", "C"]);
    expect(controller.queuedCount).toBe(0);
  });

  it("scans past a blocked head to grant a later grantable waiter", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 3, maxConcurrentPerKey: 1 }),
    );
    const a1 = grantOf(await controller.acquire("A", openSignal()));
    let a2Granted = false;
    void controller.acquire("A", openSignal()).then((o) => {
      a2Granted = o.ok;
    });
    const b1 = grantOf(await controller.acquire("B", openSignal()));
    let b2Granted = false;
    void controller.acquire("B", openSignal()).then((o) => {
      b2Granted = o.ok;
    });
    await Promise.resolve();
    expect(controller.queuedCount).toBe(2);

    // Releasing B frees a global slot; head A2 stays blocked (A still held),
    // so the grant pass must scan past it and grant B2.
    b1.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(b2Granted).toBe(true);
    expect(a2Granted).toBe(false);
    expect(controller.queuedCount).toBe(1);
    void a1;
  });

  it("rejects with capacity when the queue is full", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 1, maxConcurrentPerKey: 5, maxQueued: 1 }),
    );
    await controller.acquire("A", openSignal());
    void controller.acquire("B", openSignal());
    await Promise.resolve();
    expect(controller.queuedCount).toBe(1);
    const overflow = await controller.acquire("C", openSignal());
    expect(overflow).toEqual({ ok: false, reason: "capacity" });
  });

  it("resolves a waiter with capacity after the queue-wait timeout", async () => {
    vi.useFakeTimers();
    const controller = createCapacityController(
      limits({ maxConcurrent: 1, maxConcurrentPerKey: 5, maxQueueWaitMs: 500 }),
    );
    await controller.acquire("A", openSignal());
    const waiter = controller.acquire("B", openSignal());
    await Promise.resolve();
    expect(controller.queuedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiter).toEqual({ ok: false, reason: "capacity" });
    expect(controller.queuedCount).toBe(0);
  });

  it("resolves a queued waiter with cancelled when its signal aborts", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 1, maxConcurrentPerKey: 5 }),
    );
    await controller.acquire("A", openSignal());
    const aborter = new AbortController();
    const waiter = controller.acquire("B", aborter.signal);
    await Promise.resolve();
    expect(controller.queuedCount).toBe(1);
    aborter.abort();
    expect(await waiter).toEqual({ ok: false, reason: "cancelled" });
    expect(controller.queuedCount).toBe(0);
  });

  it("treats a double release as a no-op", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 1, maxConcurrentPerKey: 5 }),
    );
    const first = grantOf(await controller.acquire("A", openSignal()));
    const second = controller.acquire("B", openSignal()).then(grantOf);
    await Promise.resolve();

    first.release();
    first.release(); // no-op: must not double-decrement or double-grant
    await second;
    expect(controller.activeCount).toBe(1);
    expect(controller.queuedCount).toBe(0);
  });

  it("closeAdmission rejects queued waiters and blocks new acquires", async () => {
    const controller = createCapacityController(
      limits({ maxConcurrent: 1, maxConcurrentPerKey: 5 }),
    );
    const held = grantOf(await controller.acquire("A", openSignal()));
    const queued = controller.acquire("B", openSignal());
    await Promise.resolve();
    expect(controller.queuedCount).toBe(1);

    controller.closeAdmission();
    expect(await queued).toEqual({ ok: false, reason: "capacity" });
    expect(controller.queuedCount).toBe(0);

    const afterClose = await controller.acquire("C", openSignal());
    expect(afterClose).toEqual({ ok: false, reason: "capacity" });

    // Held permits remain releasable.
    held.release();
    expect(controller.activeCount).toBe(0);
  });
});
