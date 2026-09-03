/**
 * `POST /v1/chat/completions` under cross-replica capacity accounting (Phase 4D;
 * specification section 19.2).
 *
 * Hermetic end-to-end coverage over the real route, the real gateway
 * authenticator (with real HMAC-derived scopes), the REAL completion
 * orchestration, the real shared-capacity coordinator, and INJECTED in-memory
 * stand-ins for Redis and for CollectivIQ. No socket (except the one loopback
 * disconnect case), no Redis, no CollectivIQ call, and no real credential — only
 * synthetic values.
 *
 * The load-bearing questions these tests answer are which admission outcome maps
 * to which public status — the busy-cluster `429` and the undecidable `503` are
 * deliberately different answers — and what has (or has not) already happened at
 * the moment each rejection is produced.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createReadinessState } from "../../src/api/health-route.js";
import type { CollectivIQAdapter } from "../../src/collectiviq/types.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import { RequestCancelledError } from "../../src/generation/chat-completion.js";
import { createCompletionRuntime } from "../../src/generation/runtime.js";
import type {
  CapacityController,
  Clock,
  IdGenerator,
  Poller,
  Sleeper,
} from "../../src/generation/types.js";
import {
  createIdempotencyCoordinator,
  deriveIdempotencyKeyring,
  type IdempotencyCoordinator,
} from "../../src/idempotency/index.js";
import { decodeRecord } from "../../src/idempotency/records.js";
import { METRIC_NAMES } from "../../src/observability/metrics.js";
import { createServerDefaultTelemetry, type Telemetry } from "../../src/observability/telemetry.js";
import {
  CAPACITY_UNAVAILABLE_ERROR,
  GATEWAY_CAPACITY_EXCEEDED_ERROR,
} from "../../src/openai/errors.js";
import type { TitleBridge, TitleRegistration } from "../../src/opencode/title-bridge.js";
import { buildServer, type GatewayServer } from "../../src/server.js";
import {
  buildCapacityRegistryKey,
  capacityLeaseMsFor,
  CAPACITY_RETRY_INITIAL_MS,
  createSharedCapacityCoordinator,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
  type CapacityScheduleFn,
} from "../../src/shared-capacity/index.js";
import {
  buildReuseStorageKey,
  createThreadReuseCoordinator,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  type ThreadReuseCoordinator,
} from "../../src/thread-reuse/index.js";
import {
  createFakeIdempotencyStore,
  type FakeIdempotencyStore,
} from "../support/fake-idempotency-store.js";
import { createFakeRateLimiter, type FakeRateLimiter } from "../support/fake-rate-limiter.js";
import {
  createFakeSharedCapacityStore,
  type FakeSharedCapacityStore,
} from "../support/fake-shared-capacity-store.js";
import {
  createFakeThreadReuseStore,
  type FakeThreadReuseStore,
} from "../support/fake-thread-reuse-store.js";

const GATEWAY_KEY_A = "gw-fake-key-alpha";
const GATEWAY_KEY_B = "gw-fake-key-bravo";
const MASTER_KEY = randomBytes(32).toString("base64url");
const NAMESPACE = "test-ns";
const ORIGIN = "https://api.example.invalid";
const UPSTREAM_CREDENTIAL = "sk-fake-upstream";
const IDEMPOTENCY_KEY = "idem-fake-0001";
const SESSION_ID = "ses_fake_alpha";
const SESSION_HEADER = "x-collectiviq-opencode-session-id";
const ANSWER = "the synthetic answer";

const url = "/v1/chat/completions";
const authA = { authorization: `Bearer ${GATEWAY_KEY_A}` };
const authB = { authorization: `Bearer ${GATEWAY_KEY_B}` };
const keyedA = { ...authA, "idempotency-key": IDEMPOTENCY_KEY };

const CAPACITY_KEYRING = deriveSharedCapacityKeyring(MASTER_KEY);
const REGISTRY_KEY = buildCapacityRegistryKey(CAPACITY_KEYRING, NAMESPACE);
const REUSE_KEYRING = deriveThreadReuseKeyring(MASTER_KEY);

/** The public envelopes under test, taken from the contract rather than retyped. */
const CAPACITY_BODY = GATEWAY_CAPACITY_EXCEEDED_ERROR.body;
const UNAVAILABLE_BODY = CAPACITY_UNAVAILABLE_ERROR.body;

function model(id: string, over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id,
    displayName: id,
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
    promptMode: "protocol",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
    ...over,
  };
}

const TEXT_MODEL = model("collectiviq-consensus");
/** Reuse eligibility needs `promptMode: "direct"` with tools disabled. */
const DIRECT_MODEL = model("collectiviq-claude-direct", {
  selectedLlms: ["claude"],
  answerSource: "claude",
  promptMode: "direct",
});
const MODELS: readonly VirtualModel[] = [TEXT_MODEL, DIRECT_MODEL];

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: ORIGIN,
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: UPSTREAM_CREDENTIAL,
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_A, GATEWAY_KEY_B],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHARED_CAPACITY_ENABLED: true,
    SHUTDOWN_DRAIN_MS: 30_000,
    // Present so `buildServer` derives REAL, non-null scopes. It never creates a
    // Redis client: every back end is injected below.
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
    models: MODELS,
    ...over,
  };
}

// --- deterministic timer seam ------------------------------------------------

interface FakeTimerRecord {
  readonly ms: number;
  readonly run: () => void;
  cancelled: boolean;
  fired: boolean;
}

interface FakeScheduler {
  readonly schedule: CapacityScheduleFn;
  readonly timers: readonly FakeTimerRecord[];
  /** Fire every live timer registered for exactly `ms`; returns how many ran. */
  fire(ms: number): number;
}

/**
 * The coordinator's only timers are the per-waiter queue wait and the
 * full-capacity retry, so replacing the seam makes both observable and removes
 * every wall-clock dependency from this suite.
 */
function createFakeScheduler(): FakeScheduler {
  const timers: FakeTimerRecord[] = [];
  return {
    timers,
    schedule: (fn, ms) => {
      const record: FakeTimerRecord = { ms, run: fn, cancelled: false, fired: false };
      timers.push(record);
      return {
        cancel: () => {
          record.cancelled = true;
        },
      };
    },
    fire(ms: number): number {
      let fired = 0;
      // Snapshot: firing a queue-wait timer can register further timers.
      for (const record of [...timers]) {
        if (record.cancelled || record.fired || record.ms !== ms) continue;
        record.fired = true;
        fired += 1;
        record.run();
      }
      return fired;
    },
  };
}

// --- synthetic upstream ------------------------------------------------------

/** What the fake CollectivIQ adapter was asked to do, in order. */
interface UpstreamLog {
  /** Thread ids created, in creation order. */
  readonly created: string[];
  /** One entry per `process_message`, in submission order. */
  readonly submitted: { readonly threadId: string; readonly marker: string }[];
}

const MARKER_PATTERN = /marker-[a-z0-9]+/;

/**
 * Recover a request's synthetic marker from its serialized prompt. Capacity is
 * acquired immediately before `create_thread`, so submission ORDER is grant
 * order — which is what makes contention and FIFO assertions possible without
 * reaching into the coordinator.
 */
function markerOf(prompt: string): string {
  return MARKER_PATTERN.exec(prompt)?.[0] ?? "unknown";
}

/** Await a test gate, reporting a cancellation if the request aborts first. */
function awaitGate(gate: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
  if (gate === undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new RequestCancelledError());
      return;
    }
    const onAbort = (): void => reject(new RequestCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * A real but negligible sleep that never advances a virtual clock, so an
 * idempotency waiter always ends because the owner settled rather than because
 * its own deadline elapsed.
 */
const shortSleeper: Sleeper = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(resolve, Math.min(ms, 1));
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }),
};

// --- harness -----------------------------------------------------------------

interface BuildOptions {
  readonly config?: Partial<AppConfig>;
  /**
   * Omit the `sharedCapacity` COMPOSITION seam. It does not disable Phase 4D —
   * `config.SHARED_CAPACITY_ENABLED` independently controls that — so omitting
   * it while configuration enables the feature is an unavailable dependency.
   */
  readonly withSharedCapacity?: boolean;
  /**
   * Inject the shared coordinator through the TEST `capacity` override, which
   * outranks configuration. Used only to observe what a request carries when
   * configuration has the feature OFF.
   */
  readonly forceSharedCapacity?: boolean;
  readonly withRateLimiter?: boolean;
  readonly withIdempotency?: boolean;
  readonly withThreadReuse?: boolean;
}

interface Harness {
  readonly app: GatewayServer;
  /** The resolved configuration, so a test can assert against it rather than a literal. */
  readonly config: AppConfig;
  readonly store: FakeSharedCapacityStore;
  /** The controller configuration actually SELECTED for this instance. */
  readonly capacity: CapacityController;
  /** The shared coordinator, whether or not it was selected. */
  readonly coordinator: CapacityController;
  readonly scheduler: FakeScheduler;
  readonly upstream: UpstreamLog;
  readonly limiter: FakeRateLimiter;
  readonly idempotencyStore: FakeIdempotencyStore;
  readonly reuseStore: FakeThreadReuseStore;
  readonly titles: TitleRegistration[];
  readonly shutdown: AbortController;
  readonly exposition: () => Promise<string>;
  /** Hold the completion for `marker` until the returned function is called. */
  hold(marker: string): () => void;
}

function build(options: BuildOptions = {}): Harness {
  const config = makeConfig(options.config);
  const store = createFakeSharedCapacityStore();
  const scheduler = createFakeScheduler();
  const limiter = createFakeRateLimiter();
  const reuseStore = createFakeThreadReuseStore();
  const idempotencyStore = createFakeIdempotencyStore({ nowMs: () => Date.now() });
  const titles: TitleRegistration[] = [];
  const shutdown = new AbortController();
  const upstream: UpstreamLog = { created: [], submitted: [] };
  const gates = new Map<string, Promise<void>>();
  let threadSeq = 0;
  let idSeq = 0;

  // Mirrors `createSharedCapacityControllerFromConfig` exactly, with the two
  // deterministic seams the production composition leaves at their defaults.
  const coordinator = createSharedCapacityCoordinator({
    store,
    registryKey: buildCapacityRegistryKey(CAPACITY_KEYRING, config.REDIS_KEY_PREFIX),
    limits: {
      maxActive: config.MAX_CONCURRENT_REQUESTS,
      maxActivePerScope: config.MAX_CONCURRENT_REQUESTS_PER_KEY,
      maxQueued: config.MAX_QUEUED_REQUESTS,
      maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    },
    random: () => 0,
    schedule: scheduler.schedule,
  });

  const adapter: CollectivIQAdapter = {
    createThread: () => {
      threadSeq += 1;
      const threadId = `thread-${String(threadSeq)}`;
      upstream.created.push(threadId);
      return Promise.resolve({ threadId, rawStatus: 200 });
    },
    processMessage: ({ threadId, prompt }) => {
      const marker = markerOf(prompt);
      upstream.submitted.push({ threadId, marker });
      // The run id doubles as the request's identity, so the poller can be gated
      // per request without the generation layer knowing about the test.
      return Promise.resolve({ accepted: true, combinedRunId: marker, rawStatus: 202 });
    },
    getMessages: () => Promise.resolve({ messages: [], rawStatus: 200 }),
    getThreadTitle: () => Promise.resolve({ kind: "pending" }),
  };

  const poller: Poller = {
    poll: async (params) => {
      await awaitGate(gates.get(params.combinedRunId), params.signal);
      return { kind: "answer", content: ANSWER, messages: [], pollCount: 1 };
    },
  };

  const ids: IdGenerator = {
    completionId: () => {
      idSeq += 1;
      return `chatcmpl_ciq_${String(idSeq)}`;
    },
  };
  const clock: Clock = { nowMs: () => 1_700_000_000_000 };

  const titleBridge: TitleBridge = {
    register: (registration) => {
      titles.push(registration);
    },
    lookup: () => Promise.resolve({ kind: "unavailable" }),
  };

  // Real coordinator, real clock: nothing in this suite depends on reaching an
  // idempotency waiter's deadline, and a virtual clock advanced by the waiter's
  // own backoff would race it against the owner it is waiting for.
  const idempotency: IdempotencyCoordinator = createIdempotencyCoordinator({
    store: idempotencyStore,
    keyring: deriveIdempotencyKeyring(MASTER_KEY),
    namespace: NAMESPACE,
    ttlMs: config.IDEMPOTENCY_TTL_MS,
    clock: { nowMs: () => Date.now() },
    sleeper: shortSleeper,
    random: () => 0,
    scheduleRenewal: () => ({ cancel: () => undefined }),
  });

  const threadReuse: ThreadReuseCoordinator = createThreadReuseCoordinator({
    store: reuseStore,
    keyring: REUSE_KEYRING,
    namespace: NAMESPACE,
    origin: ORIGIN,
    principalFingerprint: deriveUpstreamPrincipalFingerprint(REUSE_KEYRING, {
      authMode: "bearer",
      credentialMaterial: UPSTREAM_CREDENTIAL,
    }),
    mappingTtlMs: config.OPENCODE_THREAD_REUSE_TTL_MS,
    scheduleRenewal: () => ({ cancel: () => undefined }),
  });

  const telemetry: Telemetry = createServerDefaultTelemetry(config);
  const forced = options.forceSharedCapacity === true;
  const runtime = createCompletionRuntime(config, {
    adapter,
    poller,
    ids,
    clock,
    titleBridge,
    telemetry,
    ...(forced ? { capacity: coordinator } : {}),
    ...(forced || options.withSharedCapacity === false ? {} : { sharedCapacity: coordinator }),
  });

  const app = buildServer({
    config,
    readiness: createReadinessState(true),
    telemetry,
    completion: {
      chatService: runtime.chatService,
      titleBridge: runtime.titleBridge,
      shutdownSignal: shutdown.signal,
    },
    ...(options.withIdempotency === true ? { idempotency } : {}),
    ...(options.withRateLimiter === true ? { rateLimiter: limiter } : {}),
    ...(options.withThreadReuse === true ? { threadReuse } : {}),
  });

  return {
    app,
    config,
    store,
    capacity: runtime.capacity,
    coordinator,
    scheduler,
    upstream,
    limiter,
    idempotencyStore,
    reuseStore,
    titles,
    shutdown,
    exposition: () => telemetry.metrics.collect(),
    hold: (marker: string) => {
      let release = (): void => undefined;
      gates.set(
        marker,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
  };
}

let current: GatewayServer | undefined;
afterEach(async () => {
  if (current) await current.close();
  current = undefined;
});

function use(harness: Harness): Harness {
  current = harness.app;
  return harness;
}

function body(marker: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: TEXT_MODEL.id, messages: [{ role: "user", content: marker }], ...over };
}

function directBody(marker: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...body(marker, over), model: DIRECT_MODEL.id };
}

/** Poll `predicate` until true or the deadline; throw on timeout (no hang). */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The ordered `data:` payloads of an SSE body (`[DONE]` stays a literal). */
function dataPayloads(raw: string): string[] {
  return raw
    .split("\n\n")
    .filter((record) => record.startsWith("data: "))
    .map((record) => record.slice("data: ".length));
}

/** The parsed SSE chunk/error objects, excluding the `[DONE]` sentinel. */
function jsonEvents(raw: string): unknown[] {
  return dataPayloads(raw)
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as unknown);
}

function answerOf(raw: string): string | undefined {
  return (JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }).choices?.[0]
    ?.message?.content;
}

function errorCodeOf(raw: string): string | undefined {
  return (JSON.parse(raw) as { error?: { code?: string } }).error?.code;
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

/** Every metric FAMILY name present in a Prometheus exposition. */
function metricFamilies(exposition: string): string[] {
  const names: string[] = [];
  for (const line of exposition.split("\n")) {
    if (!line.startsWith("# TYPE ")) continue;
    const name = line.slice("# TYPE ".length).split(" ")[0];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** The single idempotency record's state, or `null` when none is stored. */
function storedIdempotencyState(store: FakeIdempotencyStore): string | null {
  const claim = store.calls.find((call) => call.startsWith("claim:"));
  if (claim === undefined) return null;
  const raw = store.peek(claim.slice("claim:".length));
  if (raw === null) return null;
  const decoded = decodeRecord(raw);
  return decoded.ok ? decoded.record.s : "corrupt";
}

/** The reuse mapping key the route's identity resolves to for the direct model. */
function reuseKey(): string {
  return buildReuseStorageKey(REUSE_KEYRING, NAMESPACE, {
    gatewayKeyScope: deriveThreadReuseScope(REUSE_KEYRING, GATEWAY_KEY_A),
    sessionId: SESSION_ID,
    policyFingerprint: deriveModelPolicyFingerprint(REUSE_KEYRING, DIRECT_MODEL),
    origin: ORIGIN,
    principalFingerprint: deriveUpstreamPrincipalFingerprint(REUSE_KEYRING, {
      authMode: "bearer",
      credentialMaterial: UPSTREAM_CREDENTIAL,
    }),
  });
}

describe("shared capacity: disabled mode is completely inert", () => {
  const DISABLED = { config: { SHARED_CAPACITY_ENABLED: false } } as const;

  it("completes a JSON request with ZERO claims and ZERO releases", async () => {
    const h = use(build(DISABLED));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(200);
    expect(answerOf(response.body)).toBe(ANSWER);
    // Not "no scope reached Redis" but "Redis was never involved at all".
    expect(h.store.claims).toEqual([]);
    expect(h.store.releases).toEqual([]);
    expect(h.store.members.size).toBe(0);
    // The process-local controller served the request and freed its slot.
    expect(h.capacity.activeCount).toBe(0);
    expect(h.capacity.queuedCount).toBe(0);
  });

  it("completes an SSE request with ZERO claims and ZERO releases", async () => {
    const h = use(build(DISABLED));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1", { stream: true }),
    });

    expect(response.statusCode).toBe(200);
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    expect(h.store.claims).toEqual([]);
    expect(h.store.releases).toEqual([]);
  });

  it("derives NO capacity scope, which an active shared controller reports as unavailable", async () => {
    // The indirect proof that `gatewayCapacityScopeId` is null when the feature
    // is off: the shared coordinator is forced ACTIVE against a disabled
    // configuration, and its only remaining input is the request's scope. It
    // fails closed rather than silently accounting per replica.
    const h = use(build({ ...DISABLED, forceSharedCapacity: true }));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(503);
    expect(errorCodeOf(response.body)).toBe("capacity_unavailable");
    // No scope means there was nothing to claim in the first place.
    expect(h.store.claims).toEqual([]);
    expect(h.upstream.created).toEqual([]);
  });
});

describe("shared capacity: a granted permit", () => {
  it("takes exactly one shared permit and gives it back (JSON)", async () => {
    const h = use(build());
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(200);
    expect(answerOf(response.body)).toBe(ANSWER);
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.releases).toHaveLength(1);
    // The registry is empty again, so nothing is left occupying the cluster.
    expect(h.store.members.size).toBe(0);
    expect(h.capacity.activeCount).toBe(0);
  });

  it("takes exactly one shared permit and gives it back (SSE)", async () => {
    const h = use(build());
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1", { stream: true }),
    });

    expect(response.statusCode).toBe(200);
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.releases).toHaveLength(1);
    expect(h.store.members.size).toBe(0);
  });

  it("claims with the configured cluster-wide limits, the key's scope, and a deadline-derived lease", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 3, MAX_CONCURRENT_REQUESTS_PER_KEY: 2 } }),
    );
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    expect(response.statusCode).toBe(200);

    const claim = h.store.claims[0];
    expect(claim?.key).toBe(REGISTRY_KEY);
    expect(claim?.limits).toEqual({ maxActive: 3, maxActivePerScope: 2 });
    // Production never passes a request's abort signal into a batched claim.
    expect(claim?.hadSignal).toBe(false);
    expect(claim?.candidates).toHaveLength(1);

    const candidate = claim?.candidates[0];
    expect(candidate?.scope).toBe(deriveCapacityScope(CAPACITY_KEYRING, GATEWAY_KEY_A));
    expect(candidate?.leaseMs).toBe(capacityLeaseMsFor(TEXT_MODEL.requestTimeoutMs));
    // A released permit must come back even for a cancelled request.
    expect(h.store.releases[0]?.hadSignal).toBe(false);
  });

  it("writes an opaque cross-replica scope, never the raw key or the process-local identity", async () => {
    const h = use(build());
    await h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    const scope = h.store.claims[0]?.candidates[0]?.scope ?? "";

    expect(scope).not.toBe("k0");
    expect(scope).not.toContain(GATEWAY_KEY_A);
    expect(scope).not.toContain(MASTER_KEY);
    expect(scope).toMatch(/^[A-Za-z0-9_-]+$/);
    // A capacity scope is its own HKDF domain, unrelated to the other features'.
    expect(scope).not.toBe(deriveThreadReuseScope(REUSE_KEYRING, GATEWAY_KEY_A));
  });

  it("reflects no scope, registry key, or owner token in the response", async () => {
    const h = use(build());
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    const serialized = JSON.stringify({
      headers: response.headers,
      body: response.json<unknown>(),
    });
    const owner = h.store.claims[0]?.candidates[0]?.owner ?? "sentinel-owner";
    const scope = h.store.claims[0]?.candidates[0]?.scope ?? "sentinel-scope";
    for (const secret of [owner, scope, REGISTRY_KEY, GATEWAY_KEY_A, MASTER_KEY]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("shared capacity: contention", () => {
  it("serializes two concurrent completions against a cluster-wide limit of one", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 1, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 } }),
    );
    const releaseFirst = h.hold("marker-1");

    const first = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);

    const second = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });
    await waitFor(() => h.capacity.queuedCount === 1);

    // Being at the cluster limit is backpressure, not a rejection: the second
    // request keeps its place instead of receiving a 429.
    expect(h.capacity.activeCount).toBe(1);
    expect(h.upstream.submitted).toHaveLength(1);

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(h.upstream.submitted.map((entry) => entry.marker)).toEqual(["marker-1", "marker-2"]);
    expect(h.store.members.size).toBe(0);
    expect(h.capacity.activeCount).toBe(0);
  });

  it("lets DIFFERENT gateway keys proceed concurrently while the SAME key serializes", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 2, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 } }),
    );
    const releaseA1 = h.hold("marker-a1");
    const releaseB1 = h.hold("marker-b1");

    const a1 = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-a1") });
    await waitFor(() => h.upstream.submitted.length === 1);
    const b1 = h.app.inject({ method: "POST", url, headers: authB, payload: body("marker-b1") });
    // A distinct cross-replica scope is admitted straight away.
    await waitFor(() => h.upstream.submitted.length === 2);
    expect(h.capacity.activeCount).toBe(2);

    const a2 = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-a2") });
    await waitFor(() => h.capacity.queuedCount === 1);
    // The per-key limit, not the global one, is what holds the second A back.
    expect(h.upstream.submitted).toHaveLength(2);

    releaseA1();
    await waitFor(() => h.upstream.submitted.length === 3);
    releaseB1();

    const [x, y, z] = await Promise.all([a1, b1, a2]);
    expect([x.statusCode, y.statusCode, z.statusCode]).toEqual([200, 200, 200]);
    expect(h.upstream.submitted.map((entry) => entry.marker)).toEqual([
      "marker-a1",
      "marker-b1",
      "marker-a2",
    ]);
    expect(h.store.members.size).toBe(0);
  });

  it("grants same-scope waiters in local submission order", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 1, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 } }),
    );
    const releaseFirst = h.hold("marker-1");

    const first = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);
    const second = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });
    await waitFor(() => h.capacity.queuedCount === 1);
    const third = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-3") });
    await waitFor(() => h.capacity.queuedCount === 2);

    releaseFirst();
    const responses = await Promise.all([first, second, third]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(h.upstream.submitted.map((entry) => entry.marker)).toEqual([
      "marker-1",
      "marker-2",
      "marker-3",
    ]);
  });

  it("lets a later distinct scope pass an earlier one blocked by the per-key limit", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 2, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 } }),
    );
    const releaseA1 = h.hold("marker-a1");
    const releaseB1 = h.hold("marker-b1");

    const a1 = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-a1") });
    await waitFor(() => h.upstream.submitted.length === 1);

    // a2 joins the queue FIRST but cannot be granted; b1 joins behind it and is.
    const a2 = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-a2") });
    await waitFor(() => h.capacity.queuedCount === 1);
    const b1 = h.app.inject({ method: "POST", url, headers: authB, payload: body("marker-b1") });
    // b1's ARRIVAL deliberately does not claim: a2's no-grant claim already
    // armed the retry, and an arrival may neither cancel nor accelerate it
    // (specification §19.2), so the bypass is exercised on the next retry rather
    // than on b1's own request. Wait until BOTH are queued before firing, since
    // `inject` is asynchronous and firing early would race b1 into `acquire`.
    await waitFor(() => h.capacity.queuedCount === 2);
    // `random: () => 0` in this harness makes the first delay the jitter floor,
    // `round(0.75 * CAPACITY_RETRY_INITIAL_MS)`.
    const firstRetryMs = Math.round(0.75 * CAPACITY_RETRY_INITIAL_MS);
    expect(h.scheduler.fire(firstRetryMs)).toBe(1);
    await waitFor(() => h.upstream.submitted.length === 2);
    expect(h.upstream.submitted[1]?.marker).toBe("marker-b1");

    releaseA1();
    await waitFor(() => h.upstream.submitted.length === 3);
    releaseB1();

    const responses = await Promise.all([a1, a2, b1]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(h.upstream.submitted.map((entry) => entry.marker)).toEqual([
      "marker-a1",
      "marker-b1",
      "marker-a2",
    ]);
  });
});

describe("shared capacity: 429 gateway_capacity_exceeded", () => {
  it("rejects a request that arrives with the local queue already full", async () => {
    const h = use(
      build({
        config: {
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
          MAX_QUEUED_REQUESTS: 0,
        },
      }),
    );
    // A request that can start its own claim is a pending candidate rather than
    // a queued waiter, so a second arrival is the first one the bound rejects.
    h.store.deferNextClaim();
    const pending = h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    await waitFor(() => h.store.hasDeferredClaim());

    const rejected = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-2"),
    });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("5");
    expect(rejected.json()).toEqual(CAPACITY_BODY);
    expect(errorCodeOf(rejected.body)).toBe("gateway_capacity_exceeded");
    // The rejected request never even reached the registry.
    expect(h.store.claims).toHaveLength(1);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await pending).statusCode).toBe(200);
  });

  it("rejects a zero-queue request whose own immediate claim grants nothing", async () => {
    // The pending-candidate carve-out lets ONE request through the disabled queue
    // to ask Redis whether a permit is free, because cluster occupancy is only
    // knowable after a round trip. This is the other half of that carve-out: when
    // the answer is "full", the request must receive the ordinary `429` rather
    // than being re-queued past a bound of zero and retried forever. Asserted at
    // the ROUTE, because the client-visible outcome of that settlement — a status
    // and a header, not a resolved promise — is what regressed before.
    const h = use(
      build({
        config: {
          MAX_CONCURRENT_REQUESTS: 2,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
          MAX_QUEUED_REQUESTS: 0,
        },
      }),
    );
    // A well-formed reply that grants nothing: the cluster is at its limit, which
    // is a legitimate `claimed` outcome and NOT a dependency failure.
    h.store.alwaysClaim({ kind: "claimed", granted: [] });

    const rejected = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("5");
    expect(rejected.json()).toEqual(CAPACITY_BODY);
    expect(errorCodeOf(rejected.body)).toBe("gateway_capacity_exceeded");

    // Exactly ONE claim: the shed waiter must not be retried, which is what
    // distinguishes this from ordinary backpressure. No retry timer may be LIVE
    // either — the shed waiter is gone, so a timer armed for it would fire into
    // an empty queue. Retry delays are bounded by CAPACITY_RETRY_MAX_MS (1 s) and
    // the queue wait is far above it, so the two cannot be confused.
    expect(h.store.claims).toHaveLength(1);
    const retryTimers = h.scheduler.timers.filter(
      (timer) => timer.ms !== h.config.MAX_QUEUE_WAIT_MS && !timer.cancelled,
    );
    expect(retryTimers).toHaveLength(0);

    // No permit was granted, so nothing upstream may have happened.
    expect(h.upstream.created).toHaveLength(0);
    expect(h.upstream.submitted).toHaveLength(0);
    expect(h.store.releases).toHaveLength(0);
    expect(h.store.members.size).toBe(0);

    // Accounting is settled and no timer or abort listener is left behind.
    expect(h.capacity.activeCount).toBe(0);
    expect(h.capacity.queuedCount).toBe(0);
    for (const timer of h.scheduler.timers) {
      expect(timer.cancelled || timer.fired).toBe(true);
    }
  });

  it("rejects a request once the bounded local queue is saturated", async () => {
    const h = use(
      build({
        config: {
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
          MAX_QUEUED_REQUESTS: 1,
        },
      }),
    );
    const releaseFirst = h.hold("marker-1");
    const first = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);
    const queued = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });
    await waitFor(() => h.capacity.queuedCount === 1);

    const rejected = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-3"),
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("5");
    expect(rejected.json()).toEqual(CAPACITY_BODY);

    releaseFirst();
    expect((await first).statusCode).toBe(200);
    expect((await queued).statusCode).toBe(200);
    // The rejected request contributed no upstream work.
    expect(h.upstream.submitted.map((entry) => entry.marker)).toEqual(["marker-1", "marker-2"]);
  });

  it("rejects a waiter that exhausts MAX_QUEUE_WAIT_MS with the identical envelope", async () => {
    const h = use(
      build({
        config: {
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
          // Distinct from every retry delay, so firing it can only be a queue wait.
          MAX_QUEUE_WAIT_MS: 1_234,
        },
      }),
    );
    const releaseFirst = h.hold("marker-1");
    const first = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);
    const waiter = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });
    await waitFor(() => h.capacity.queuedCount === 1);

    expect(h.scheduler.fire(1_234)).toBe(1);

    const rejected = await waiter;
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("5");
    expect(rejected.json()).toEqual(CAPACITY_BODY);
    expect(h.capacity.queuedCount).toBe(0);
    expect(h.upstream.submitted).toHaveLength(1);

    releaseFirst();
    expect((await first).statusCode).toBe(200);
  });
});

describe("shared capacity: 503 capacity_unavailable", () => {
  /** Every one of these is an undecidable dependency, never a busy cluster. */
  async function expectUnavailable(h: Harness): Promise<void> {
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    const error = response.json<{ error: { type: string; param: string | null; code: string } }>()
      .error;
    expect(error.code).toBe("capacity_unavailable");
    expect(error.type).toBe("server_error");
    expect(error.param).toBeNull();
    // Failing closed means the completion never started.
    expect(h.upstream.created).toEqual([]);
    expect(h.upstream.submitted).toEqual([]);
    expect(h.titles).toEqual([]);
  }

  it("fails closed when the registry is unavailable", async () => {
    const h = use(build());
    h.store.alwaysClaim({ kind: "unavailable" });
    await expectUnavailable(h);
    // A fail-closed claim is never retried or compensated.
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.releases).toEqual([]);
  });

  it("fails closed on corrupt registry state, without repairing it", async () => {
    const h = use(build());
    h.store.alwaysClaim({ kind: "corrupt" });
    await expectUnavailable(h);
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.releases).toEqual([]);
  });

  it("fails closed when the store rejects outright, never reflecting the thrown value", async () => {
    const h = use(build());
    h.store.rejectClaimWith(new Error("boom-should-never-surface"));
    await expectUnavailable(h);

    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-2"),
    });
    expect(response.body).not.toContain("boom-should-never-surface");
    expect(JSON.stringify(response.headers)).not.toContain("boom-should-never-surface");
  });

  it("fails closed without issuing a claim when the store reports itself not ready", async () => {
    const h = use(build());
    h.store.setReady(false);
    await expectUnavailable(h);
    // No point queueing behind a dependency already known to be unusable.
    expect(h.store.claims).toEqual([]);
  });

  it("fails closed when the feature is ENABLED but no coordinator was wired", async () => {
    // Reverting to the process-local controller here would silently multiply the
    // configured cluster-wide limit by the replica count, which is exactly the
    // failure this control exists to prevent.
    const h = use(build({ withSharedCapacity: false }));
    await expectUnavailable(h);
    expect(h.store.claims).toEqual([]);
    // The fail-closed controller holds and queues nothing.
    expect(h.capacity.activeCount).toBe(0);
    expect(h.capacity.queuedCount).toBe(0);
  });

  it("fails closed for every configured gateway key, not just the first", async () => {
    const h = use(build({ withSharedCapacity: false }));
    for (const headers of [authA, authB]) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers,
        payload: body("marker-1"),
      });
      expect(response.statusCode).toBe(503);
      expect(errorCodeOf(response.body)).toBe("capacity_unavailable");
    }
    expect(h.upstream.created).toEqual([]);
  });
});

describe("shared capacity: the streamed transport", () => {
  it("reports a capacity 503 as an SSE error record, never an HTTP 503", async () => {
    const h = use(build());
    h.store.alwaysClaim({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1", { stream: true }),
    });

    // Capacity is reached AFTER the headers and the assistant-role opener, so the
    // committed status line stays 200 for the life of the stream.
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["retry-after"]).toBeUndefined();

    const events = jsonEvents(response.body);
    expect((events[0] as { choices: { delta: object }[] }).choices[0]?.delta).toEqual({
      role: "assistant",
    });
    expect(events.at(-1)).toEqual(UNAVAILABLE_BODY);
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    // An error record replaces the terminal chunk; it never accompanies one.
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(response.body).not.toContain(ANSWER);
  });

  it("reports the queue-full 429 as an SSE error record too", async () => {
    const h = use(
      build({
        config: {
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
          MAX_QUEUED_REQUESTS: 0,
        },
      }),
    );
    h.store.deferNextClaim();
    const pending = h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1", { stream: true }),
    });
    await waitFor(() => h.store.hasDeferredClaim());

    const rejected = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-2", { stream: true }),
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.headers["content-type"]).toContain("text/event-stream");
    expect(jsonEvents(rejected.body).at(-1)).toEqual(CAPACITY_BODY);
    expect(dataPayloads(rejected.body).at(-1)).toBe("[DONE]");
    expect(rejected.body).not.toContain('"finish_reason":"stop"');

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await pending).statusCode).toBe(200);
  });

  it("registers no native-title correlation for a stream that failed at capacity", async () => {
    const h = use(build());
    h.store.alwaysClaim({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, [SESSION_HEADER]: SESSION_ID },
      payload: body("marker-1", { stream: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(h.titles).toEqual([]);
  });
});

describe("shared capacity: interaction with cross-replica rate limiting", () => {
  const LIMITED = {
    withRateLimiter: true,
    config: { RATE_LIMIT_ENABLED: true },
  } as const;

  it("issues NO capacity claim for a rate-limited request", async () => {
    const h = use(build(LIMITED));
    h.limiter.always({ kind: "limited", retryAfterSeconds: 7 });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(429);
    expect(errorCodeOf(response.body)).toBe("gateway_rate_limit_exceeded");
    expect(response.headers["retry-after"]).toBe("7");
    expect(h.store.claims).toEqual([]);
    expect(h.upstream.created).toEqual([]);
  });

  it("meters the rate limit BEFORE the capacity claim is issued", async () => {
    const h = use(build(LIMITED));
    h.limiter.onNextConsume(() => {
      expect(h.store.claims).toEqual([]);
    });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    expect(response.statusCode).toBe(200);
    expect(h.limiter.calls.count).toBe(1);
    expect(h.store.claims).toHaveLength(1);
  });

  it("does NOT refund the consumed unit when capacity answers unavailable", async () => {
    const h = use(build(LIMITED));
    h.store.alwaysClaim({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(503);
    expect(errorCodeOf(response.body)).toBe("capacity_unavailable");
    // The quota was spent before capacity was even attempted, and quota is never
    // given back by a later failure.
    expect(h.limiter.consumed).toHaveLength(1);
  });

  it("does NOT refund the consumed unit when capacity answers 429", async () => {
    const h = use(
      build({
        ...LIMITED,
        config: {
          RATE_LIMIT_ENABLED: true,
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
          MAX_QUEUED_REQUESTS: 0,
        },
      }),
    );
    h.store.deferNextClaim();
    const pending = h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    await waitFor(() => h.store.hasDeferredClaim());

    const rejected = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-2"),
    });
    expect(rejected.statusCode).toBe(429);
    expect(errorCodeOf(rejected.body)).toBe("gateway_capacity_exceeded");
    expect(h.limiter.consumed).toHaveLength(2);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await pending).statusCode).toBe(200);
  });
});

describe("shared capacity: interaction with idempotency", () => {
  it("takes exactly one permit for the owner and none for a cached replay", async () => {
    const h = use(build({ withIdempotency: true }));
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: keyedA,
      payload: body("marker-1"),
    });
    const replay = await h.app.inject({
      method: "POST",
      url,
      headers: keyedA,
      payload: body("marker-1"),
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    // One completion, one shared permit: a replay serves stored bytes and needs
    // no place in the cluster's active budget.
    expect(h.upstream.submitted).toHaveLength(1);
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.releases).toHaveLength(1);
  });

  it("takes no permit for a same-key WAITER", async () => {
    const h = use(build({ withIdempotency: true }));
    const releaseOwner = h.hold("marker-1");

    const owner = h.app.inject({ method: "POST", url, headers: keyedA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);

    const waiter = h.app.inject({
      method: "POST",
      url,
      headers: keyedA,
      payload: body("marker-1"),
    });
    // The waiter is genuinely polling the shared record by the time we assert.
    await waitFor(() => h.idempotencyStore.calls.some((call) => call.startsWith("read:")));
    expect(h.store.claims).toHaveLength(1);
    expect(h.capacity.queuedCount).toBe(0);

    releaseOwner();
    expect((await owner).statusCode).toBe(200);
    expect((await waiter).statusCode).toBe(200);
    expect(h.store.claims).toHaveLength(1);
    expect(h.store.releases).toHaveLength(1);
  });

  it("releases the claim when capacity fails before processing, so a retry can proceed", async () => {
    const h = use(build({ withIdempotency: true }));
    h.store.alwaysClaim({ kind: "unavailable" });

    const failed = await h.app.inject({
      method: "POST",
      url,
      headers: keyedA,
      payload: body("marker-1"),
    });
    expect(failed.statusCode).toBe(503);
    expect(errorCodeOf(failed.body)).toBe("capacity_unavailable");
    // Capacity is decided BEFORE `reserved -> processing`, so this is a proven
    // pre-processing failure: the claim is compare-and-deleted, not left
    // ambiguous, and the key is not blocked for the TTL.
    expect(storedIdempotencyState(h.idempotencyStore)).toBeNull();
    expect(h.idempotencyStore.calls.some((call) => call.startsWith("release:reserved:"))).toBe(
      true,
    );

    h.store.alwaysClaim(null);
    const retry = await h.app.inject({
      method: "POST",
      url,
      headers: keyedA,
      payload: body("marker-1"),
    });
    expect(retry.statusCode).toBe(200);
    expect(answerOf(retry.body)).toBe(ANSWER);
    expect(h.upstream.submitted).toHaveLength(1);
  });
});

describe("shared capacity: interaction with OpenCode thread reuse", () => {
  const REUSING = {
    withThreadReuse: true,
    config: { OPENCODE_THREAD_REUSE_ENABLED: true },
  } as const;

  it("restores the session mapping when capacity fails before any submit", async () => {
    const h = use(build(REUSING));
    const headers = { ...authA, [SESSION_HEADER]: SESSION_ID };

    const firstTurn = await h.app.inject({
      method: "POST",
      url,
      headers,
      payload: directBody("marker-1"),
    });
    expect(firstTurn.statusCode).toBe(200);
    expect(h.upstream.created).toEqual(["thread-1"]);
    expect(h.reuseStore.peekRecord(reuseKey())?.s).toBe("active");

    // The lease is taken BEFORE capacity, so this failure happens with the
    // mapping already reserved and provably before any `process_message`.
    h.store.alwaysClaim({ kind: "unavailable" });
    const blocked = await h.app.inject({
      method: "POST",
      url,
      headers,
      payload: directBody("marker-2"),
    });
    expect(blocked.statusCode).toBe(503);
    expect(errorCodeOf(blocked.body)).toBe("capacity_unavailable");
    // Restored, not tombstoned: the session keeps its thread.
    expect(h.reuseStore.peekRecord(reuseKey())?.s).toBe("active");
    expect(h.upstream.created).toEqual(["thread-1"]);

    h.store.alwaysClaim(null);
    const thirdTurn = await h.app.inject({
      method: "POST",
      url,
      headers,
      payload: directBody("marker-3"),
    });
    expect(thirdTurn.statusCode).toBe(200);
    // Still exactly one upstream thread, continued rather than replaced.
    expect(h.upstream.created).toEqual(["thread-1"]);
    expect(h.upstream.submitted.at(-1)).toEqual({ threadId: "thread-1", marker: "marker-3" });
    expect(h.reuseStore.peekRecord(reuseKey())?.s).toBe("active");
  });

  it("does not leave a held lease behind after a capacity rejection", async () => {
    const h = use(build(REUSING));
    h.store.alwaysClaim({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, [SESSION_HEADER]: SESSION_ID },
      payload: directBody("marker-1"),
    });
    expect(response.statusCode).toBe(503);
    // A first turn that never bound a thread owes the session nothing, so its
    // reservation is deleted outright rather than left blocking.
    expect(h.reuseStore.calls).toContain(`acquire:${reuseKey()}`);
    expect(h.reuseStore.keys()).toEqual([]);
  });
});

describe("shared capacity: lifecycle", () => {
  it("removes a client that disconnects while queued, delivering neither permit nor body", async () => {
    // `inject` cannot model a real disconnect, so this one runs over a loopback
    // listener: the first request holds the only cluster-wide permit while the
    // second waits, and the second's socket is then destroyed.
    const h = build({
      config: { MAX_CONCURRENT_REQUESTS: 1, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 },
    });
    const app = h.app;
    const releaseFirst = h.hold("marker-1");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
      const first = app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
      await waitFor(() => h.upstream.submitted.length === 1);

      const request = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: url,
        headers: { authorization: `Bearer ${GATEWAY_KEY_A}`, "content-type": "application/json" },
      });
      let responded = false;
      request.on("response", () => {
        responded = true;
      });
      request.on("error", () => {
        /* ECONNRESET after destroy is expected */
      });
      request.write(JSON.stringify(body("marker-2")));
      request.end();

      await waitFor(() => h.capacity.queuedCount === 1);
      request.destroy();

      // The waiter leaves the queue rather than being handed a permit later.
      await waitFor(() => h.capacity.queuedCount === 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(responded).toBe(false);
      expect(h.capacity.activeCount).toBe(1);
      // Only the first request's member is held, and no second thread was created.
      expect(h.store.members.size).toBe(1);
      expect(h.upstream.created).toEqual(["thread-1"]);
      expect(h.store.releases).toEqual([]);

      releaseFirst();
      expect((await first).statusCode).toBe(200);
      expect(h.store.members.size).toBe(0);
    } finally {
      await app.close();
    }
  }, 15_000);

  it("gives a queued request the EXISTING 429 once admission closes, not the new 503", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 1, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 } }),
    );
    const releaseFirst = h.hold("marker-1");
    const first = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);
    const queued = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });
    await waitFor(() => h.capacity.queuedCount === 1);

    h.capacity.closeAdmission();

    const rejected = await queued;
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("5");
    expect(rejected.json()).toEqual(CAPACITY_BODY);
    expect(errorCodeOf(rejected.body)).not.toBe("capacity_unavailable");

    releaseFirst();
    expect((await first).statusCode).toBe(200);
  });

  it("releases a grant that is confirmed after admission closed, rather than leaking it", async () => {
    const h = use(
      build({ config: { MAX_CONCURRENT_REQUESTS: 1, MAX_CONCURRENT_REQUESTS_PER_KEY: 1 } }),
    );
    h.store.deferNextClaim();
    const pending = h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    await waitFor(() => h.store.hasDeferredClaim());

    h.capacity.closeAdmission();
    const rejected = await pending;
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toEqual(CAPACITY_BODY);

    // Redis then confirms the grant for a request that has already departed.
    expect(h.store.settleDeferredClaim()).toBe(true);
    await waitFor(() => h.store.releases.length === 1);
    expect(h.store.members.size).toBe(0);
    expect(h.capacity.activeCount).toBe(0);
    // Nothing was delivered to the client either.
    expect(h.upstream.created).toEqual([]);
  });

  it("keeps an already successful response when the release itself fails", async () => {
    const h = use(build());
    h.store.alwaysRelease({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });

    expect(response.statusCode).toBe(200);
    expect(answerOf(response.body)).toBe(ANSWER);
    expect(h.store.releases).toHaveLength(1);
    // The member is left to expire with its own lease, which conservatively
    // under-admits this replica until then; local accounting still freed the slot.
    expect(h.store.members.size).toBe(1);
    expect(h.capacity.activeCount).toBe(0);
  });

  it("keeps an already successful response when the release throws SYNCHRONOUSLY", async () => {
    // The route calls `Permit.release()` from a `finally`, and that call is
    // synchronous. A store that threw while its arguments were being evaluated
    // would escape before any promise existed to catch it, turning a completed
    // `200` into the route's fixed `500`. Only a ROUTE-level test can show that
    // the response survives, because the failure's blast radius is the response
    // itself. The real store is total and never throws; this is defence in depth.
    const h = use(build());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      h.store.failReleaseWith(new Error("release exploded — must never surface"), "sync");
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: authA,
        payload: body("marker-1"),
      });

      expect(response.statusCode).toBe(200);
      expect(answerOf(response.body)).toBe(ANSWER);
      // The failure text must not reach the client on any path.
      expect(response.body).not.toContain("release exploded");

      // The completion really did run, and the release really was attempted once.
      expect(h.upstream.submitted.map((entry) => entry.marker)).toEqual(["marker-1"]);
      expect(h.store.releases).toHaveLength(1);
      // Local accounting freed the slot exactly once despite the throw, so a
      // second release cannot happen and the replica is not wedged at its limit.
      expect(h.capacity.activeCount).toBe(0);
      expect(h.capacity.queuedCount).toBe(0);
      // The member survives, exactly as in the async-failure case above: it
      // expires with its own lease and under-admits this replica until then.
      expect(h.store.members.size).toBe(1);

      // The replica is not wedged at its limit: clearing the fault lets the next
      // request claim and release normally. This arrives on an EMPTY queue, so it
      // claims through the arrival trigger and deliberately does not prove that a
      // release wakes a QUEUED waiter — the unit suite's "never lets a
      // synchronous release throw escape a claim settlement" owns that. What it
      // does prove is that local accounting was not corrupted and that the first
      // permit was never released a second time.
      h.store.failReleaseWith(null);
      const next = await h.app.inject({
        method: "POST",
        url,
        headers: authA,
        payload: body("marker-2"),
      });
      expect(next.statusCode).toBe(200);
      expect(answerOf(next.body)).toBe(ANSWER);
      expect(h.store.releases).toHaveLength(2);
      expect(h.capacity.activeCount).toBe(0);
      // Exactly one member remains: the stranded first one. The second was
      // released successfully.
      expect(h.store.members.size).toBe(1);

      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("shared capacity: observability", () => {
  const WITH_METRICS = { config: { METRICS_ENABLED: true } } as const;

  it("records a capacity_unavailable failure under its own closed error category", async () => {
    const h = use(build(WITH_METRICS));
    h.store.alwaysClaim({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    expect(response.statusCode).toBe(503);

    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        `${METRIC_NAMES.errorsTotal}{endpoint="/v1/chat/completions",error_category="capacity_unavailable"}`,
      ),
    ).toBe(1);
    // Exactly one error series: a distinct category, not the `other` fallback a
    // missed call site would produce, and not double-counted.
    expect(exposition.match(/^collectiviq_gateway_errors_total\{/gm)).toHaveLength(1);
    expect(
      sample(
        exposition,
        `${METRIC_NAMES.requestsTotal}{endpoint="/v1/chat/completions",status_family="5xx",model="${TEXT_MODEL.id}",transport="json"}`,
      ),
    ).toBe(1);
  });

  it("keeps a capacity 429 under the existing gateway_capacity_exceeded category", async () => {
    const h = use(
      build({
        config: {
          METRICS_ENABLED: true,
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
          MAX_QUEUED_REQUESTS: 0,
        },
      }),
    );
    h.store.deferNextClaim();
    const pending = h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-1"),
    });
    await waitFor(() => h.store.hasDeferredClaim());
    const rejected = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body("marker-2"),
    });
    expect(rejected.statusCode).toBe(429);

    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        `${METRIC_NAMES.errorsTotal}{endpoint="/v1/chat/completions",error_category="gateway_capacity_exceeded"}`,
      ),
    ).toBe(1);

    expect(h.store.settleDeferredClaim()).toBe(true);
    expect((await pending).statusCode).toBe(200);
  });

  it("adds no new metric family for the shared capacity layer", async () => {
    const h = use(build(WITH_METRICS));
    await h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    h.store.alwaysClaim({ kind: "unavailable" });
    await h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });

    const exposition = await h.exposition();
    const known = new Set<string>(Object.values(METRIC_NAMES));
    const families = metricFamilies(exposition);
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) expect(known.has(family)).toBe(true);
  });

  it("reports the shared controller's own counts through the EXISTING capacity gauges", async () => {
    const h = use(
      build({
        config: {
          METRICS_ENABLED: true,
          MAX_CONCURRENT_REQUESTS: 1,
          MAX_CONCURRENT_REQUESTS_PER_KEY: 1,
        },
      }),
    );
    const releaseFirst = h.hold("marker-1");
    const first = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-1") });
    await waitFor(() => h.upstream.submitted.length === 1);
    const queued = h.app.inject({ method: "POST", url, headers: authA, payload: body("marker-2") });
    await waitFor(() => h.capacity.queuedCount === 1);

    const exposition = await h.exposition();
    // Still a PER-INSTANCE view: no replica can observe cluster occupancy.
    expect(sample(exposition, METRIC_NAMES.activeRequests)).toBe(1);
    expect(sample(exposition, METRIC_NAMES.queuedRequests)).toBe(1);

    releaseFirst();
    expect((await first).statusCode).toBe(200);
    expect((await queued).statusCode).toBe(200);
    const settled = await h.exposition();
    expect(sample(settled, METRIC_NAMES.activeRequests)).toBe(0);
    expect(sample(settled, METRIC_NAMES.queuedRequests)).toBe(0);
  });
});
