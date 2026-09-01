import { describe, expect, it } from "vitest";
import { createReadinessState, type ReadinessProbe } from "../../src/api/health-route.js";

function probe(value: () => boolean): ReadinessProbe {
  return { isReady: value };
}

describe("createReadinessState", () => {
  it("keeps the pre-dependency behaviour when no probe is registered", () => {
    const readiness = createReadinessState(false);
    expect(readiness.isReady()).toBe(false);
    readiness.setReady(true);
    expect(readiness.isReady()).toBe(true);
    readiness.setReady(false);
    expect(readiness.isReady()).toBe(false);
  });

  it("treats an empty dependency list exactly like no dependencies", () => {
    const readiness = createReadinessState(true, { dependencies: [] });
    expect(readiness.isReady()).toBe(true);
  });

  it("is not ready while a registered dependency is not ready", () => {
    let redisReady = false;
    const readiness = createReadinessState(false, {
      dependencies: [probe(() => redisReady)],
    });
    readiness.setReady(true);
    // Configured but disconnected/reconnecting.
    expect(readiness.isReady()).toBe(false);
    // Recovers automatically once the dependency reports ready.
    redisReady = true;
    expect(readiness.isReady()).toBe(true);
    // And flips back if it drops again.
    redisReady = false;
    expect(readiness.isReady()).toBe(false);
  });

  it("requires EVERY dependency to be ready", () => {
    let second = false;
    const readiness = createReadinessState(true, {
      dependencies: [probe(() => true), probe(() => second)],
    });
    expect(readiness.isReady()).toBe(false);
    second = true;
    expect(readiness.isReady()).toBe(true);
  });

  it("treats a throwing probe as not ready without propagating", () => {
    const readiness = createReadinessState(true, {
      dependencies: [
        probe(() => {
          throw new Error("probe exploded");
        }),
      ],
    });
    expect(() => readiness.isReady()).not.toThrow();
    expect(readiness.isReady()).toBe(false);
  });

  it("treats a non-boolean probe result as not ready", () => {
    const readiness = createReadinessState(true, {
      dependencies: [probe(() => "yes" as unknown as boolean)],
    });
    expect(readiness.isReady()).toBe(false);
  });

  it("never becomes ready again once shutting down", () => {
    let dependencyReady = true;
    const readiness = createReadinessState(true, {
      dependencies: [probe(() => dependencyReady)],
    });
    expect(readiness.isReady()).toBe(true);
    readiness.markShuttingDown();
    expect(readiness.isReady()).toBe(false);
    // Neither a later setReady nor a dependency recovery can flip it back.
    readiness.setReady(true);
    dependencyReady = true;
    expect(readiness.isReady()).toBe(false);
  });

  it("does not consult dependencies while the local flag is false", () => {
    let probed = 0;
    const readiness = createReadinessState(false, {
      dependencies: [
        probe(() => {
          probed += 1;
          return true;
        }),
      ],
    });
    expect(readiness.isReady()).toBe(false);
    expect(probed).toBe(0);
  });
});
