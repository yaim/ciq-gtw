/**
 * Composition of the OPTIONAL cross-replica capacity layer (Phase 4D;
 * specification section 19.2).
 *
 * The behaviour under test is entirely about WIRING: which controller a
 * validated configuration selects, what is built when the feature is off, and
 * that turning it on changes neither the readiness probe nor the shutdown
 * sequence. Everything here is hermetic and socket-free — the Redis client
 * factory is injected, the substrate is a recorder, and no Redis, CollectivIQ,
 * or collector call is made or required.
 *
 * Selection is asserted by BEHAVIOUR as well as identity: an object comparison
 * alone would still pass if `selectCapacity` handed back the right controller
 * while the admission path consulted another one.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReadinessState } from "../../src/api/health-route.js";
import type { CollectivIQAdapter } from "../../src/collectiviq/types.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import { createCompletionRuntime } from "../../src/generation/runtime.js";
import type { CapacityController, CapacityRequest } from "../../src/generation/types.js";
import { createMetrics, METRIC_NAMES } from "../../src/observability/metrics.js";
import { createNoopTracing } from "../../src/observability/tracing.js";
import type { Telemetry } from "../../src/observability/telemetry.js";
import type {
  MinimalRedisClient,
  RedisClientConfig,
  RedisSubstrate,
} from "../../src/redis/index.js";
import { createRedisRuntime } from "../../src/redis/runtime.js";
import { runGracefulShutdown } from "../../src/index.js";
import { buildServer } from "../../src/server.js";
import {
  buildCapacityRegistryKey,
  buildCapacityScopeDeriver,
  createSharedCapacityControllerFromConfig,
  createSharedCapacityCoordinator,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
} from "../../src/shared-capacity/index.js";
import {
  createFakeSharedCapacityStore,
  type FakeSharedCapacityStore,
} from "../support/fake-shared-capacity-store.js";

const GATEWAY_KEY_A = "gw-fake-key-alpha";
const GATEWAY_KEY_B = "gw-fake-key-bravo";
const MASTER_KEY = randomBytes(32).toString("base64url");
const NAMESPACE = "test-ns";

const MODEL: VirtualModel = {
  id: "collectiviq-consensus",
  displayName: "consensus",
  selectedLlms: ["gpt"],
  generateCombined: false,
  answerSource: "gpt",
  toolMode: "disabled",
  promptMode: "protocol",
  requestTimeoutMs: 90_000,
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 5_000,
  maximumPromptBytes: 6_291_456,
};

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.example.invalid",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake-upstream",
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_A, GATEWAY_KEY_B],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHARED_CAPACITY_ENABLED: false,
    SHUTDOWN_DRAIN_MS: 30_000,
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY,
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: NAMESPACE,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    METRICS_ENABLED: false,
    TRACING_ENABLED: false,
    TRACING_SAMPLE_RATIO: 1,
    models: [MODEL],
    ...over,
  };
}

/**
 * Construction-only stub. Nothing in this file performs a completion, so no
 * method is ever invoked; it exists so the runtime does not build the real HTTP
 * adapter.
 */
const adapter: CollectivIQAdapter = {
  createThread: () => Promise.resolve({ threadId: "thread-unused", rawStatus: 200 }),
  processMessage: () =>
    Promise.resolve({ accepted: true, combinedRunId: "run-unused", rawStatus: 202 }),
  getMessages: () => Promise.resolve({ messages: [], rawStatus: 200 }),
  getThreadTitle: () => Promise.resolve({ kind: "pending" }),
};

/** A substrate that records every command and readiness read it is asked for. */
interface RecordingSubstrate extends RedisSubstrate {
  readonly evalCalls: readonly string[];
  readonly readyReads: { count: number };
}

function recordingSubstrate(): RecordingSubstrate {
  const evalCalls: string[] = [];
  const readyReads = { count: 0 };
  return {
    evalCalls,
    readyReads,
    evalScript: (script) => {
      evalCalls.push(script.sha);
      return Promise.resolve(null);
    },
    isReady: () => {
      readyReads.count += 1;
      return true;
    },
  };
}

/** Build the coordinator with both non-deterministic seams pinned. */
function sharedCoordinator(
  store: FakeSharedCapacityStore,
  limits: { maxActive: number; maxActivePerScope: number },
): CapacityController {
  return createSharedCapacityCoordinator({
    store,
    registryKey: buildCapacityRegistryKey(deriveSharedCapacityKeyring(MASTER_KEY), NAMESPACE),
    limits: { ...limits, maxQueued: 20, maxQueueWaitMs: 5_000 },
    random: () => 0,
    // No timer ever fires on its own, so nothing here depends on wall-clock time.
    schedule: () => ({ cancel: () => undefined }),
  });
}

function request(capacityScopeId: string | null = "scope-alpha"): CapacityRequest {
  return {
    keyId: "k0",
    capacityScopeId,
    requestTimeoutMs: MODEL.requestTimeoutMs,
    signal: new AbortController().signal,
  };
}

/** Let a claim round trip through the store before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The numeric value of one Prometheus exposition sample line, or `undefined`. */
function sample(exposition: string, prefix: string): number | undefined {
  for (const line of exposition.split("\n")) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(prefix)) continue;
    const parsed = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function metricsTelemetry(): { readonly telemetry: Telemetry; collect: () => Promise<string> } {
  const metrics = createMetrics({ modelIds: [MODEL.id] });
  return { telemetry: { metrics, tracing: createNoopTracing() }, collect: () => metrics.collect() };
}

describe("buildCapacityScopeDeriver", () => {
  it("returns null when shared capacity is disabled", () => {
    expect(buildCapacityScopeDeriver(config())).toBeNull();
  });

  it("returns a deriver whose scopes match the boundary's own derivation", () => {
    const derive = buildCapacityScopeDeriver(config({ SHARED_CAPACITY_ENABLED: true }));
    expect(derive).not.toBeNull();
    const keyring = deriveSharedCapacityKeyring(MASTER_KEY);
    expect(derive?.(GATEWAY_KEY_A)).toBe(deriveCapacityScope(keyring, GATEWAY_KEY_A));
    expect(derive?.(GATEWAY_KEY_B)).toBe(deriveCapacityScope(keyring, GATEWAY_KEY_B));
    expect(derive?.(GATEWAY_KEY_A)).not.toBe(derive?.(GATEWAY_KEY_B));
  });

  it("derives the same scope regardless of gateway-key ORDER", () => {
    // The whole point of a derived scope rather than the process-local
    // `k<index>`: a cluster-wide per-key budget must survive reordering or
    // adding keys, and must be identical on every replica.
    const forward = buildCapacityScopeDeriver(
      config({
        SHARED_CAPACITY_ENABLED: true,
        COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_A, GATEWAY_KEY_B],
      }),
    );
    const reversed = buildCapacityScopeDeriver(
      config({
        SHARED_CAPACITY_ENABLED: true,
        COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_B, GATEWAY_KEY_A],
      }),
    );
    expect(forward?.(GATEWAY_KEY_A)).toBe(reversed?.(GATEWAY_KEY_A));
  });

  it("derives an opaque value that leaks neither the key nor the master key", () => {
    const derive = buildCapacityScopeDeriver(config({ SHARED_CAPACITY_ENABLED: true }));
    const scope = derive?.(GATEWAY_KEY_A) ?? "";
    expect(scope).not.toContain(GATEWAY_KEY_A);
    expect(scope).not.toContain(MASTER_KEY);
    expect(scope).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is pure enough for buildServer to call during construction", () => {
    // `buildServer` runs the deriver for every configured key. It takes no Redis
    // client and opens no socket, so a construction that needed I/O could not
    // succeed here at all.
    const app = buildServer({
      config: config({ SHARED_CAPACITY_ENABLED: true }),
      readiness: createReadinessState(true),
    });
    expect(typeof app.inject).toBe("function");
  });
});

describe("createSharedCapacityControllerFromConfig", () => {
  it("returns null when shared capacity is disabled, so nothing can be wired", () => {
    const substrate = recordingSubstrate();
    expect(createSharedCapacityControllerFromConfig(config(), substrate)).toBeNull();
    expect(substrate.evalCalls).toEqual([]);
  });

  it("returns a controller when enabled, performing NO I/O at construction", () => {
    const substrate = recordingSubstrate();
    const controller = createSharedCapacityControllerFromConfig(
      config({ SHARED_CAPACITY_ENABLED: true }),
      substrate,
    );
    expect(controller).not.toBeNull();
    expect(controller?.activeCount).toBe(0);
    expect(controller?.queuedCount).toBe(0);
    // No command, no readiness read: the connection belongs to the Redis root.
    expect(substrate.evalCalls).toEqual([]);
    expect(substrate.readyReads.count).toBe(0);
  });

  it("stays unwired when the master key is somehow absent", () => {
    // Unreachable through validated configuration (enabling the feature requires
    // Redis, and Redis requires the key), but an unwired controller must be a
    // fail-closed `null` rather than a keyring derived from nothing.
    const { IDEMPOTENCY_ENCRYPTION_KEY: _omitted, ...withoutKey } = config({
      SHARED_CAPACITY_ENABLED: true,
    });
    expect(createSharedCapacityControllerFromConfig(withoutKey, recordingSubstrate())).toBeNull();
  });
});

describe("createCompletionRuntime capacity selection", () => {
  it("uses the process-local controller when shared capacity is disabled", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 4, maxActivePerScope: 2 });
    const runtime = createCompletionRuntime(config(), { adapter, sharedCapacity: coordinator });

    expect(runtime.capacity).not.toBe(coordinator);
    // A disabled instance carries no scope, and the local controller ignores it.
    const acquisition = await runtime.capacity.acquire(request(null));
    expect(acquisition.ok).toBe(true);
    expect(runtime.capacity.activeCount).toBe(1);
    // The shared registry was never touched.
    expect(store.claims).toEqual([]);
    if (acquisition.ok) acquisition.permit.release();
    expect(store.releases).toEqual([]);
  });

  it("uses the injected coordinator when shared capacity is enabled and wired", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 4, maxActivePerScope: 2 });
    const runtime = createCompletionRuntime(config({ SHARED_CAPACITY_ENABLED: true }), {
      adapter,
      sharedCapacity: coordinator,
    });

    expect(runtime.capacity).toBe(coordinator);
    const acquisition = await runtime.capacity.acquire(request());
    expect(acquisition.ok).toBe(true);
    expect(store.claims).toHaveLength(1);
    expect(store.claims[0]?.candidates[0]?.scope).toBe("scope-alpha");
    if (acquisition.ok) acquisition.permit.release();
    expect(store.releases).toHaveLength(1);
    expect(store.members.size).toBe(0);
  });

  it("admits NOTHING when shared capacity is enabled but no coordinator was wired", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 4, maxActivePerScope: 2 });
    const runtime = createCompletionRuntime(config({ SHARED_CAPACITY_ENABLED: true }), { adapter });

    expect(runtime.capacity).not.toBe(coordinator);
    // Falling back to the local controller here would silently multiply the
    // configured cluster-wide limit by the replica count.
    for (const scope of ["scope-alpha", null]) {
      expect(await runtime.capacity.acquire(request(scope))).toEqual({
        ok: false,
        reason: "unavailable",
      });
    }
    expect(runtime.capacity.activeCount).toBe(0);
    expect(runtime.capacity.queuedCount).toBe(0);
    // It holds and queues nothing, so closing admission has nothing to reject.
    expect(() => runtime.capacity.closeAdmission()).not.toThrow();
    expect(store.claims).toEqual([]);
  });

  it("lets an explicit capacity override outrank configuration (test seam only)", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 4, maxActivePerScope: 2 });
    const runtime = createCompletionRuntime(config(), { adapter, capacity: coordinator });
    expect(runtime.capacity).toBe(coordinator);
    const acquisition = await runtime.capacity.acquire(request());
    expect(acquisition.ok).toBe(true);
    if (acquisition.ok) acquisition.permit.release();
  });
});

describe("capacity gauges follow the ACTIVE controller", () => {
  it("reports the shared coordinator's counts when it is selected", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 1, maxActivePerScope: 1 });
    const { telemetry, collect } = metricsTelemetry();
    const runtime = createCompletionRuntime(
      config({ SHARED_CAPACITY_ENABLED: true, METRICS_ENABLED: true }),
      { adapter, sharedCapacity: coordinator, telemetry },
    );

    const held = await runtime.capacity.acquire(request());
    expect(held.ok).toBe(true);
    const pending = runtime.capacity.acquire(request());
    await settle();
    expect(runtime.capacity.queuedCount).toBe(1);

    const busy = await collect();
    // Both gauges stay a PER-INSTANCE view; no replica can observe the cluster.
    expect(sample(busy, METRIC_NAMES.activeRequests)).toBe(1);
    expect(sample(busy, METRIC_NAMES.queuedRequests)).toBe(1);

    if (held.ok) held.permit.release();
    const granted = await pending;
    expect(granted.ok).toBe(true);
    if (granted.ok) granted.permit.release();

    const settled = await collect();
    expect(sample(settled, METRIC_NAMES.activeRequests)).toBe(0);
    expect(sample(settled, METRIC_NAMES.queuedRequests)).toBe(0);
  });

  it("reports the LOCAL controller's counts when shared capacity is disabled", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 4, maxActivePerScope: 2 });
    const { telemetry, collect } = metricsTelemetry();
    const runtime = createCompletionRuntime(config({ METRICS_ENABLED: true }), {
      adapter,
      sharedCapacity: coordinator,
      telemetry,
    });

    // A permit taken on the UNSELECTED coordinator must be invisible: the bound
    // source is the controller admission actually uses.
    const stray = await coordinator.acquire(request());
    expect(stray.ok).toBe(true);
    expect(sample(await collect(), METRIC_NAMES.activeRequests)).toBe(0);

    const local = await runtime.capacity.acquire(request(null));
    expect(local.ok).toBe(true);
    expect(sample(await collect(), METRIC_NAMES.activeRequests)).toBe(1);

    if (stray.ok) stray.permit.release();
    if (local.ok) local.permit.release();
  });

  it("reports zeroes for an enabled-but-unwired instance", async () => {
    const { telemetry, collect } = metricsTelemetry();
    const runtime = createCompletionRuntime(
      config({ SHARED_CAPACITY_ENABLED: true, METRICS_ENABLED: true }),
      { adapter, telemetry },
    );
    await runtime.capacity.acquire(request());
    const exposition = await collect();
    expect(sample(exposition, METRIC_NAMES.activeRequests)).toBe(0);
    expect(sample(exposition, METRIC_NAMES.queuedRequests)).toBe(0);
  });
});

describe("readiness is unchanged by shared capacity", () => {
  interface Tracker {
    readonly configs: readonly RedisClientConfig[];
    readonly clients: { isReady: boolean; readyReads: number }[];
    createRedisClient: (clientConfig: RedisClientConfig) => MinimalRedisClient;
  }

  /** Records every client created and every readiness read performed on it. */
  function tracker(): Tracker {
    const configs: RedisClientConfig[] = [];
    const clients: { isReady: boolean; readyReads: number }[] = [];
    return {
      configs,
      clients,
      createRedisClient: (clientConfig) => {
        configs.push(clientConfig);
        const state = { isReady: true, readyReads: 0 };
        clients.push(state);
        return {
          connect: () => Promise.resolve(undefined),
          close: () => Promise.resolve(),
          destroy: () => undefined,
          on: () => undefined,
          sendCommand: () => Promise.resolve(["ok"]),
          get isReady(): boolean {
            state.readyReads += 1;
            return state.isReady;
          },
        };
      },
    };
  }

  for (const enabled of [false, true]) {
    it(`performs exactly ONE probe over ONE connection with the feature ${enabled ? "on" : "off"}`, () => {
      const t = tracker();
      const runtime = createRedisRuntime(config({ SHARED_CAPACITY_ENABLED: enabled }), {
        createRedisClient: t.createRedisClient,
      });
      // MUTATION GUARD: giving shared capacity its own connection would make this 2.
      expect(t.configs).toHaveLength(1);
      expect(runtime?.sharedCapacity === null).toBe(!enabled);

      const readiness = createReadinessState(true, {
        dependencies: [{ isReady: () => runtime?.isReady() ?? false }],
      });
      const before = t.clients[0]?.readyReads ?? -1;
      expect(readiness.isReady()).toBe(true);
      expect((t.clients[0]?.readyReads ?? -1) - before).toBe(1);
    });
  }

  it("degrades and recovers every enabled feature through the one shared view", () => {
    const t = tracker();
    const runtime = createRedisRuntime(
      config({ SHARED_CAPACITY_ENABLED: true, RATE_LIMIT_ENABLED: true }),
      { createRedisClient: t.createRedisClient },
    );
    expect(runtime?.isReady()).toBe(true);
    expect(runtime?.rateLimiter?.isReady()).toBe(true);

    const state = t.clients[0];
    if (state === undefined) throw new Error("expected a client");
    state.isReady = false;
    expect(runtime?.isReady()).toBe(false);
    expect(runtime?.rateLimiter?.isReady()).toBe(false);

    state.isReady = true;
    expect(runtime?.isReady()).toBe(true);
  });
});

describe("shutdown closes admission on whichever controller is active", () => {
  interface ShutdownTrace {
    readonly order: string[];
  }

  async function shutdown(capacity: CapacityController, trace: ShutdownTrace): Promise<void> {
    await runGracefulShutdown({
      setNotReady: () => trace.order.push("setNotReady"),
      closeAdmission: () => {
        trace.order.push("closeAdmission");
        capacity.closeAdmission();
      },
      abortInFlight: () => trace.order.push("abortInFlight"),
      close: () => {
        trace.order.push("close");
        return Promise.resolve();
      },
      drainMs: 30_000,
      closeDependencies: () => {
        trace.order.push("closeDependencies");
        return Promise.resolve();
      },
    });
  }

  const EXPECTED_ORDER = [
    "setNotReady",
    "closeAdmission",
    "close",
    "abortInFlight",
    "closeDependencies",
  ];

  it("rejects the SHARED controller's queued work, before the drain and the dependency close", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 1, maxActivePerScope: 1 });
    const runtime = createCompletionRuntime(config({ SHARED_CAPACITY_ENABLED: true }), {
      adapter,
      sharedCapacity: coordinator,
    });

    const held = await runtime.capacity.acquire(request());
    expect(held.ok).toBe(true);
    const queued = runtime.capacity.acquire(request());
    await settle();
    expect(runtime.capacity.queuedCount).toBe(1);

    const trace: ShutdownTrace = { order: [] };
    await shutdown(runtime.capacity, trace);

    // Queued (never-started) work keeps the retryable busy-cluster reason, which
    // the route maps to the existing 429 — never the undecidable `unavailable`.
    expect(await queued).toEqual({ ok: false, reason: "capacity" });
    expect(runtime.capacity.queuedCount).toBe(0);
    expect(trace.order).toEqual(EXPECTED_ORDER);
    if (held.ok) held.permit.release();
  });

  it("rejects the LOCAL controller's queued work when shared capacity is disabled", async () => {
    const store = createFakeSharedCapacityStore();
    const coordinator = sharedCoordinator(store, { maxActive: 1, maxActivePerScope: 1 });
    const runtime = createCompletionRuntime(
      config({ MAX_CONCURRENT_REQUESTS: 1, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 }),
      { adapter, sharedCapacity: coordinator },
    );

    const held = await runtime.capacity.acquire(request(null));
    expect(held.ok).toBe(true);
    const queued = runtime.capacity.acquire(request(null));
    expect(runtime.capacity.queuedCount).toBe(1);

    const trace: ShutdownTrace = { order: [] };
    await shutdown(runtime.capacity, trace);

    expect(await queued).toEqual({ ok: false, reason: "capacity" });
    expect(trace.order).toEqual(EXPECTED_ORDER);
    // The unselected coordinator was never involved.
    expect(store.claims).toEqual([]);
    if (held.ok) held.permit.release();
  });
});
