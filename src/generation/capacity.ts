/**
 * Process-local admission control (specification section 19).
 *
 * Enforces a global active-permit limit, a per-key active-permit limit, and a
 * bounded FIFO wait queue with a bounded per-waiter wait. Capacity is NOT shared
 * across replicas. The controller never throws from `acquire`; every outcome is
 * a discriminated {@link CapacityAcquisition}. No timer or abort listener is ever
 * left dangling on any exit path.
 */
import type { CapacityAcquisition, CapacityController, Permit } from "./types.js";

export interface CapacityLimits {
  /** Maximum number of concurrently held permits across all keys. */
  readonly maxConcurrent: number;
  /** Maximum number of concurrently held permits for a single key. */
  readonly maxConcurrentPerKey: number;
  /** Maximum number of waiters allowed in the FIFO queue. */
  readonly maxQueued: number;
  /** Maximum time a waiter may wait before resolving with `capacity`, in ms. */
  readonly maxQueueWaitMs: number;
}

interface Waiter {
  readonly keyId: string;
  /** Resolves the pending `acquire` promise exactly once. */
  resolve(outcome: CapacityAcquisition): void;
  /** Queue-wait timer handle; cleared when the waiter leaves the queue. */
  timer: ReturnType<typeof setTimeout>;
  /** Abort listener detacher; cleared when the waiter leaves the queue. */
  removeAbortListener(): void;
}

export function createCapacityController(limits: CapacityLimits): CapacityController {
  let activeCount = 0;
  let closed = false;
  const perKeyActive = new Map<string, number>();
  const queue: Waiter[] = [];

  function perKey(keyId: string): number {
    return perKeyActive.get(keyId) ?? 0;
  }

  function incrementActive(keyId: string): void {
    activeCount += 1;
    perKeyActive.set(keyId, perKey(keyId) + 1);
  }

  function decrementActive(keyId: string): void {
    activeCount -= 1;
    const next = perKey(keyId) - 1;
    if (next <= 0) {
      perKeyActive.delete(keyId);
    } else {
      perKeyActive.set(keyId, next);
    }
  }

  function createPermit(keyId: string): Permit {
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        decrementActive(keyId);
        runGrantPass();
      },
    };
  }

  /** Detach a waiter's timer and abort listener. */
  function detachWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    waiter.removeAbortListener();
  }

  /** Remove a specific waiter from the queue, if still present. */
  function removeFromQueue(waiter: Waiter): void {
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
  }

  /**
   * Grant permits to grantable waiters in FIFO order. Per-key limits can leave
   * the head blocked while a later waiter is grantable, so scan past blocked
   * heads without ever exceeding the global or per-key limits.
   */
  function runGrantPass(): void {
    let index = 0;
    while (index < queue.length && activeCount < limits.maxConcurrent) {
      const waiter = queue[index];
      if (waiter === undefined) break;
      if (perKey(waiter.keyId) < limits.maxConcurrentPerKey) {
        queue.splice(index, 1);
        detachWaiter(waiter);
        incrementActive(waiter.keyId);
        waiter.resolve({ ok: true, permit: createPermit(waiter.keyId) });
        // Do not advance `index`: the splice shifted the next waiter into place.
      } else {
        index += 1;
      }
    }
  }

  function acquire(keyId: string, signal: AbortSignal): Promise<CapacityAcquisition> {
    if (closed) return Promise.resolve({ ok: false, reason: "capacity" });
    if (signal.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });

    if (activeCount < limits.maxConcurrent && perKey(keyId) < limits.maxConcurrentPerKey) {
      incrementActive(keyId);
      return Promise.resolve({ ok: true, permit: createPermit(keyId) });
    }

    if (queue.length >= limits.maxQueued) {
      return Promise.resolve({ ok: false, reason: "capacity" });
    }

    return new Promise<CapacityAcquisition>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        keyId,
        resolve(outcome: CapacityAcquisition): void {
          if (settled) return;
          settled = true;
          resolve(outcome);
        },
        timer: setTimeout(() => {
          removeFromQueue(waiter);
          detachWaiter(waiter);
          waiter.resolve({ ok: false, reason: "capacity" });
        }, limits.maxQueueWaitMs),
        removeAbortListener(): void {
          signal.removeEventListener("abort", onAbort);
        },
      };

      function onAbort(): void {
        removeFromQueue(waiter);
        detachWaiter(waiter);
        waiter.resolve({ ok: false, reason: "cancelled" });
      }

      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }

  function closeAdmission(): void {
    closed = true;
    // Queued (never-started) work is resolved with `capacity`, which the route
    // maps to a retryable 429 + Retry-After — intentional and distinct from an
    // in-flight completion, which the shutdown drain cancels into a 503 only
    // after its permit-holding work is aborted.
    while (queue.length > 0) {
      const waiter = queue.shift();
      if (waiter === undefined) break;
      detachWaiter(waiter);
      waiter.resolve({ ok: false, reason: "capacity" });
    }
  }

  return {
    acquire,
    closeAdmission,
    get activeCount(): number {
      return activeCount;
    },
    get queuedCount(): number {
      return queue.length;
    },
  };
}
