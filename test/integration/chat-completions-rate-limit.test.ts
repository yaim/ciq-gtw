/**
 * `POST /v1/chat/completions` under cross-replica rate limiting (Phase 4B;
 * specification section 19.1).
 *
 * Hermetic end-to-end coverage over the real route, the real gateway
 * authenticator (with real HMAC-derived scopes), the real idempotency
 * coordinator, and INJECTED in-memory stand-ins for Redis. No socket, no Redis,
 * no CollectivIQ call, and no real credential — only synthetic values.
 *
 * The load-bearing question these tests answer is WHERE the gate sits: which
 * attempts spend a unit, which do not, and what has already happened (or must
 * NOT yet have happened) at the moment a request is rejected.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createReadinessState } from "../../src/api/health-route.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import {
  ChatCompletionError,
  type ChatCompletionRequestContext,
  type ChatCompletionService,
  type CompletionResult,
  type CompletionRunOptions,
  type PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import type { Clock, Sleeper } from "../../src/generation/types.js";
import {
  createIdempotencyCoordinator,
  deriveIdempotencyKeyring,
  type IdempotencyCoordinator,
} from "../../src/idempotency/index.js";
import {
  CONTEXT_LENGTH_EXCEEDED_ERROR,
  GATEWAY_CAPACITY_EXCEEDED_ERROR,
} from "../../src/openai/errors.js";
import type { TitleBridge, TitleRegistration } from "../../src/opencode/title-bridge.js";
import { buildServer, type GatewayServer } from "../../src/server.js";
import {
  createFakeIdempotencyStore,
  type FakeIdempotencyStore,
} from "../support/fake-idempotency-store.js";
import { createFakeRateLimiter, type FakeRateLimiter } from "../support/fake-rate-limiter.js";

const GATEWAY_KEY_A = "gw-fake-key-alpha";
const GATEWAY_KEY_B = "gw-fake-key-bravo";
const MASTER_KEY = randomBytes(32).toString("base64url");
const IDEMPOTENCY_KEY = "idem-fake-0001";
const ANSWER = "the synthetic answer";
const THREAD_ID = "thread-sentinel-9";

const url = "/v1/chat/completions";
const authA = { authorization: `Bearer ${GATEWAY_KEY_A}` };
const authB = { authorization: `Bearer ${GATEWAY_KEY_B}` };

const LIMITED_BODY = {
  error: {
    message: "The gateway rate limit for this API key has been exceeded.",
    type: "rate_limit_error",
    param: null,
    code: "gateway_rate_limit_exceeded",
  },
};
const UNAVAILABLE_BODY = {
  error: {
    message: "Gateway rate limiting is currently unavailable.",
    type: "server_error",
    param: null,
    code: "rate_limit_unavailable",
  },
};

function model(id: string): VirtualModel {
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
  };
}

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake",
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_A, GATEWAY_KEY_B],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHUTDOWN_DRAIN_MS: 30_000,
    // Present so `buildServer` derives REAL, non-null idempotency and
    // rate-limit scopes. It never creates a Redis client: both back ends are
    // injected below.
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY,
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: "test-ns",
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    METRICS_ENABLED: false,
    TRACING_ENABLED: false,
    TRACING_SAMPLE_RATIO: 1,
    models: [model("collectiviq-consensus")],
    ...over,
  };
}

type RunFn = (
  prepared: PreparedCompletion,
  signal: AbortSignal,
  hooks?: CompletionRunOptions,
) => Promise<CompletionResult>;

interface Harness {
  readonly app: GatewayServer;
  readonly limiter: FakeRateLimiter;
  readonly store: FakeIdempotencyStore;
  readonly runs: { count: number };
  readonly prepares: { count: number };
  readonly titles: TitleRegistration[];
  readonly shutdown: AbortController;
}

/** Build the route over the real coordinator plus injected fakes. */
function build(
  run: RunFn,
  options: {
    /**
     * Omit limiter dependency injection only. It does NOT disable Phase 4B —
     * `config.RATE_LIMIT_ENABLED` independently controls that. Omitting the
     * limiter while configuration ENABLES the feature is an unavailable
     * dependency and fails closed with `503`, not disabled behaviour; the
     * consistent disabled state needs both.
     */
    readonly withRateLimiter?: boolean;
    readonly withIdempotency?: boolean;
    readonly config?: Partial<AppConfig>;
    /** Throw from `prepare`, to prove a preparation failure spends nothing. */
    readonly failPrepare?: boolean;
  } = {},
): Harness {
  let nowMs = 1_700_000_000_000;
  const store = createFakeIdempotencyStore({ nowMs: () => nowMs });
  const limiter = createFakeRateLimiter();
  const runs = { count: 0 };
  const prepares = { count: 0 };
  const titles: TitleRegistration[] = [];
  const shutdown = new AbortController();
  let seq = 0;

  const clock: Clock = { nowMs: () => nowMs };
  const sleeper: Sleeper = {
    sleep: (ms, signal) => {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      nowMs += ms;
      return Promise.resolve();
    },
  };
  const coordinator: IdempotencyCoordinator = createIdempotencyCoordinator({
    store,
    keyring: deriveIdempotencyKeyring(MASTER_KEY),
    namespace: "test-ns",
    ttlMs: 600_000,
    clock,
    sleeper,
    random: () => 0,
    scheduleRenewal: () => ({ cancel: () => undefined }),
  });

  const chatService: ChatCompletionService = {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => {
      prepares.count += 1;
      if (options.failPrepare === true)
        throw new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR);
      seq += 1;
      return {
        id: `chatcmpl_ciq_${String(seq)}`,
        created: 1_700_000_000 + seq,
        model: ctx.request.model,
        prompt: "PROMPT",
        policy: ctx.model,
        selectedLlms: ctx.model.selectedLlms,
        keyId: ctx.keyId,
      };
    },
    run: async (prepared, signal, hooks) => {
      runs.count += 1;
      return run(prepared, signal, hooks);
    },
  };

  const titleBridge: TitleBridge = {
    register: (registration) => {
      titles.push(registration);
    },
    lookup: () => Promise.resolve({ kind: "unavailable" }),
  };

  const app = buildServer({
    config: makeConfig(options.config),
    readiness: createReadinessState(true),
    completion: { chatService, titleBridge, shutdownSignal: shutdown.signal },
    ...(options.withIdempotency === false ? {} : { idempotency: coordinator }),
    ...(options.withRateLimiter === false ? {} : { rateLimiter: limiter }),
  });
  return { app, limiter, store, runs, prepares, titles, shutdown };
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

const succeeds: RunFn = async (_prepared, signal, hooks) => {
  await hooks?.onCapacityAcquired?.(signal);
  return {
    kind: "text",
    content: ANSWER,
    upstreamThreadId: THREAD_ID,
    upstreamThreadCreated: true,
  };
};

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "collectiviq-consensus", messages: [{ role: "user", content: "hi" }], ...over };
}

/** Poll `predicate` until true or the deadline; throw on timeout (no hang). */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The ordered `data:` payloads of an SSE body. */
function dataPayloads(raw: string): string[] {
  return raw
    .split("\n\n")
    .filter((record) => record.startsWith("data: "))
    .map((record) => record.slice("data: ".length));
}

/** The CONSISTENT disabled state: configuration off AND no limiter injected. */
const DISABLED = { withRateLimiter: false, config: { RATE_LIMIT_ENABLED: false } } as const;

describe("rate limiting: disabled behaviour is unchanged", () => {
  it("performs the completion with ZERO limiter interaction (JSON)", async () => {
    const h = use(build(succeeds, DISABLED));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(h.runs.count).toBe(1);
    expect(h.limiter.calls.count).toBe(0);
  });

  it("performs the completion with ZERO limiter interaction (SSE)", async () => {
    const h = use(build(succeeds, DISABLED));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body({ stream: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    expect(h.limiter.calls.count).toBe(0);
  });

  it("does NOT treat an enabled-but-unwired limiter as disabled", async () => {
    // Regression: keying the gate on the injected limiter rather than on
    // configuration made this request succeed unmetered. Configuration says the
    // quota applies, so a missing limiter is an unavailable dependency.
    const h = use(build(succeeds, { withRateLimiter: false }));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).not.toBe(200);
    expect(h.runs.count).toBe(0);
  });

  it("does not derive a rate-limit scope when the feature is off in config", async () => {
    // With RATE_LIMIT_ENABLED=false no scope exists, so nothing identifies a
    // key to a limiter even if one were wired by mistake.
    const h = use(
      build(succeeds, {
        withRateLimiter: false,
        config: { RATE_LIMIT_ENABLED: false },
      }),
    );
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(200);
  });
});

describe("rate limiting: ENABLED but unwired fails closed", () => {
  /**
   * `RATE_LIMIT_ENABLED=true` with no limiter injected. Configuration derives a
   * real scope, so the only thing missing is the dependency itself — the exact
   * shape of a misconfigured or partially composed deployment. Treating that as
   * "disabled" would serve completely unmetered traffic while the operator
   * believed a quota was being enforced, so every one of these assertions is a
   * regression guard rather than a description of the code.
   */
  const ENABLED_UNWIRED = { withRateLimiter: false } as const;

  it("returns 503 rate_limit_unavailable with Retry-After: 2 (JSON)", async () => {
    const h = use(build(succeeds, ENABLED_UNWIRED));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
  });

  it("returns the same JSON 503 for a STREAMED request, never SSE", async () => {
    const h = use(build(succeeds, ENABLED_UNWIRED));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body({ stream: true }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    // No SSE headers, no assistant-role opener, no frames at all: the gate runs
    // before the transport commits its 200.
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.body).not.toContain("data:");
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
  });

  it("performs no completion, capacity, upstream, or title work", async () => {
    const h = use(build(succeeds, ENABLED_UNWIRED));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, "x-collectiviq-opencode-session-id": "sess-unwired" },
      payload: body(),
    });

    expect(response.statusCode).toBe(503);
    // `run` is where capacity is acquired and upstream work happens, so a zero
    // run count covers all three.
    expect(h.runs.count).toBe(0);
    expect(h.titles).toEqual([]);
    // The absent limiter is never reached for a call it cannot serve.
    expect(h.limiter.calls.count).toBe(0);
  });

  it("creates no idempotency claim for a keyed request", async () => {
    const h = use(build(succeeds, ENABLED_UNWIRED));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, "idempotency-key": IDEMPOTENCY_KEY },
      payload: body(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("rate_limit_unavailable");
    // A request rejected at the gate must not block its own key for the TTL.
    expect(h.store.calls).toEqual([]);
  });

  it("fails closed for every gateway key, not just the first", async () => {
    const h = use(build(succeeds, ENABLED_UNWIRED));
    for (const headers of [authA, authB]) {
      const response = await h.app.inject({ method: "POST", url, headers, payload: body() });
      expect(response.statusCode).toBe(503);
    }
    expect(h.runs.count).toBe(0);
  });
});

describe("rate limiting: an admitted request", () => {
  it("charges exactly one unit and completes normally (JSON)", async () => {
    const h = use(build(succeeds));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ choices: { message: { content: string } }[] }>().choices[0]?.message.content,
    ).toBe(ANSWER);
    expect(h.limiter.calls.count).toBe(1);
    expect(h.limiter.consumed).toHaveLength(1);
    // No quota headers are emitted in this phase.
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(Object.keys(response.headers).filter((k) => k.includes("ratelimit"))).toEqual([]);
  });

  it("charges exactly one unit and streams normally (SSE)", async () => {
    const h = use(build(succeeds));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body({ stream: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    expect(h.limiter.consumed).toHaveLength(1);
  });

  it("charges one unit per attempt, not per key lifetime", async () => {
    const h = use(build(succeeds));
    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    }
    expect(h.limiter.consumed).toHaveLength(3);
  });
});

describe("rate limiting: a limited request", () => {
  it("returns the fixed 429 envelope with the limiter's DYNAMIC Retry-After", async () => {
    const h = use(build(succeeds));
    h.limiter.next({ kind: "limited", retryAfterSeconds: 37 });
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });

    expect(response.statusCode).toBe(429);
    // Dynamic, NOT the fixed 5 that capacity and upstream quota use.
    expect(response.headers["retry-after"]).toBe("37");
    expect(response.json()).toEqual(LIMITED_BODY);
  });

  it("reflects a different computed delay per response", async () => {
    const h = use(build(succeeds));
    for (const seconds of [1, 2, 3_600]) {
      h.limiter.next({ kind: "limited", retryAfterSeconds: seconds });
      const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
      expect(response.headers["retry-after"]).toBe(String(seconds));
    }
  });

  it("does no claim, no capacity, no upstream work, and no title correlation", async () => {
    const h = use(build(succeeds));
    h.limiter.always({ kind: "limited", retryAfterSeconds: 5 });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: {
        ...authA,
        "idempotency-key": IDEMPOTENCY_KEY,
        "x-collectiviq-opencode-session-id": "sess-1",
      },
      payload: body(),
    });

    expect(response.statusCode).toBe(429);
    // The idempotency claim happens AFTER the gate, so no record was created —
    // a limited request must never block its own key for the TTL.
    expect(h.store.calls).toEqual([]);
    expect(h.runs.count).toBe(0);
    expect(h.titles).toEqual([]);
  });

  it("rejects a STREAMED request before any SSE header or frame is written", async () => {
    const h = use(build(succeeds));
    h.limiter.always({ kind: "limited", retryAfterSeconds: 9 });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body({ stream: true }),
    });

    // A normal JSON error, NOT an SSE error record: the gate runs before the
    // transport commits its 200 and its assistant-role opener.
    expect(response.statusCode).toBe(429);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.body).not.toContain("data:");
    expect(response.json()).toEqual(LIMITED_BODY);
    expect(h.runs.count).toBe(0);
  });

  it("reveals nothing about the configured limit, the scope, or the key", async () => {
    const h = use(build(succeeds));
    h.limiter.next({ kind: "limited", retryAfterSeconds: 4 });
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    for (const secret of [GATEWAY_KEY_A, MASTER_KEY, "test-ns", "k0", "60", "8"]) {
      expect(response.body).not.toContain(secret);
    }
  });
});

describe("rate limiting: an unavailable limiter fails CLOSED", () => {
  it("returns 503 rate_limit_unavailable with Retry-After: 2 (JSON)", async () => {
    const h = use(build(succeeds));
    h.limiter.always({ kind: "unavailable" });
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    // Never admitted: an undecidable request is not unmetered traffic.
    expect(h.runs.count).toBe(0);
    expect(h.store.calls).toEqual([]);
  });

  it("returns the same JSON 503 on the streamed path (pre-header)", async () => {
    const h = use(build(succeeds));
    h.limiter.always({ kind: "unavailable" });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body({ stream: true }),
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
  });

  it("fails closed when the limiter throws instead of returning an outcome", async () => {
    // The real limiter is total, but a broken one must never become a 500 or,
    // worse, be treated as an admission.
    const h = use(build(succeeds));
    h.limiter.rejectWith(new Error("boom"));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    expect(h.runs.count).toBe(0);
  });

  it("fails closed when a limiter is wired but no scope was derived", async () => {
    // An inconsistent wiring (limiter present, feature disabled in config so no
    // scope exists) must not admit unmetered traffic.
    const h = use(build(succeeds, { config: { RATE_LIMIT_ENABLED: false } }));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    // The limiter was never even consulted; there was nothing to charge.
    expect(h.limiter.calls.count).toBe(0);
    expect(h.runs.count).toBe(0);
  });

  it("keeps the shutdown 503 for a cancellation while the client is connected", async () => {
    const h = use(build(succeeds));
    h.shutdown.abort();
    h.limiter.always({ kind: "cancelled" });
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: "The gateway is shutting down.",
        type: "server_error",
        param: null,
        code: "service_unavailable",
      },
    });
    expect(h.runs.count).toBe(0);
  });
});

describe("rate limiting: what does and does not consume quota", () => {
  it("does NOT charge an unauthenticated request", async () => {
    const h = use(build(succeeds));
    for (const headers of [
      {},
      { authorization: "Bearer gw-wrong" },
      { authorization: "Basic x" },
    ]) {
      const response = await h.app.inject({ method: "POST", url, headers, payload: body() });
      expect(response.statusCode).toBe(401);
    }
    expect(h.limiter.calls.count).toBe(0);
  });

  it("does NOT charge an invalid request or an unknown model", async () => {
    const h = use(build(succeeds));
    for (const payload of [
      {},
      { model: "collectiviq-consensus" },
      { model: "collectiviq-consensus", messages: [] },
      { model: "collectiviq-unknown", messages: [{ role: "user", content: "hi" }] },
      body({ n: 2 }),
      body({ stream: "yes" }),
    ]) {
      const response = await h.app.inject({ method: "POST", url, headers: authA, payload });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(h.limiter.calls.count).toBe(0);
  });

  it("does NOT charge a preparation failure", async () => {
    // Preparation runs BEFORE the gate, so an oversized prompt costs nothing.
    const h = use(build(succeeds, { failPrepare: true }));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("context_length_exceeded");
    expect(h.prepares.count).toBe(1);
    expect(h.limiter.calls.count).toBe(0);
  });

  it("does NOT charge an invalid Idempotency-Key header", async () => {
    const h = use(build(succeeds));
    for (const value of ["", "has space", "x".repeat(256)]) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: { ...authA, "idempotency-key": value },
        payload: body(),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(h.limiter.calls.count).toBe(0);
  });

  it("does NOT charge a keyed request whose idempotency is unavailable", async () => {
    // The existing keyed-request precedence wins: the client is told its
    // idempotency guarantee cannot be honoured, and it is not metered for it.
    const h = use(build(succeeds));
    h.store.setReady(false);
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, "idempotency-key": IDEMPOTENCY_KEY },
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("idempotency_unavailable");
    expect(h.limiter.calls.count).toBe(0);
  });

  it("DOES charge the idempotency owner", async () => {
    const h = use(build(succeeds));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, "idempotency-key": IDEMPOTENCY_KEY },
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(h.limiter.consumed).toHaveLength(1);
  });

  it("DOES charge a cached REPLAY, which performs no upstream work", async () => {
    const h = use(build(succeeds));
    const headers = { ...authA, "idempotency-key": IDEMPOTENCY_KEY };
    const first = await h.app.inject({ method: "POST", url, headers, payload: body() });
    const replay = await h.app.inject({ method: "POST", url, headers, payload: body() });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    // One upstream completion, but TWO quota units: a replay is still a request
    // the gateway served, and a client must not be able to buy free calls by
    // repeating a key.
    expect(h.runs.count).toBe(1);
    expect(h.limiter.consumed).toHaveLength(2);
  });

  it("DOES charge a body CONFLICT on the same key", async () => {
    const h = use(build(succeeds));
    const headers = { ...authA, "idempotency-key": IDEMPOTENCY_KEY };
    await h.app.inject({ method: "POST", url, headers, payload: body() });
    const conflict = await h.app.inject({
      method: "POST",
      url,
      headers,
      payload: body({ messages: [{ role: "user", content: "different" }] }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(h.limiter.consumed).toHaveLength(2);
  });

  it("DOES charge a same-body WAITER", async () => {
    // A waiter takes no capacity and makes no upstream call, but it still holds
    // a connection and polls Redis, so it must count.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = use(
      build(async (_prepared, signal, hooks) => {
        await hooks?.onCapacityAcquired?.(signal);
        await gate;
        return {
          kind: "text",
          content: ANSWER,
          upstreamThreadId: THREAD_ID,
          upstreamThreadCreated: true,
        };
      }),
    );
    const headers = { ...authA, "idempotency-key": IDEMPOTENCY_KEY };
    const owner = h.app.inject({ method: "POST", url, headers, payload: body() });
    // Let the owner claim and enter `processing` before the waiter arrives.
    await new Promise((resolve) => setImmediate(resolve));
    const waiter = h.app.inject({ method: "POST", url, headers, payload: body() });
    await new Promise((resolve) => setImmediate(resolve));
    release?.();

    expect((await owner).statusCode).toBe(200);
    expect((await waiter).statusCode).toBe(200);
    expect(h.runs.count).toBe(1);
    expect(h.limiter.consumed).toHaveLength(2);
  });

  it("does NOT refund a unit when capacity rejects the admitted request", async () => {
    const h = use(
      build(() => Promise.reject(new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR))),
    );
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });

    expect(response.statusCode).toBe(429);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "gateway_capacity_exceeded",
    );
    // REGRESSION GUARD: process-local capacity keeps its long-standing fixed
    // Retry-After: 5 even though the limiter now supplies dynamic values.
    expect(response.headers["retry-after"]).toBe("5");
    // The unit was already spent before capacity was even attempted.
    expect(h.limiter.consumed).toHaveLength(1);
  });

  it("does NOT refund a unit when the completion itself fails", async () => {
    const h = use(build(() => Promise.reject(new Error("upstream exploded"))));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(500);
    expect(h.limiter.consumed).toHaveLength(1);
  });
});

describe("rate limiting: per-key isolation", () => {
  it("charges a DIFFERENT scope per gateway key", async () => {
    const h = use(build(succeeds));
    await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    await h.app.inject({ method: "POST", url, headers: authB, payload: body() });

    expect(h.limiter.consumed).toHaveLength(2);
    const [a, b] = h.limiter.consumed;
    expect(a).not.toBe(b);
    // The same key always resolves to the same scope.
    await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(h.limiter.consumed[2]).toBe(a);
  });

  it("charges an opaque scope that is neither the raw key nor the capacity identity", async () => {
    const h = use(build(succeeds));
    await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    const scope = h.limiter.consumed[0] as string;
    expect(scope).not.toContain(GATEWAY_KEY_A);
    expect(scope).not.toContain(MASTER_KEY);
    expect(scope).not.toBe("k0");
    expect(scope).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not reflect the scope in any response header or body", async () => {
    const h = use(build(succeeds));
    await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    const scope = h.limiter.consumed[0] as string;
    h.limiter.next({ kind: "limited", retryAfterSeconds: 3 });
    const limited = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(limited.body).not.toContain(scope);
    expect(JSON.stringify(limited.headers)).not.toContain(scope);
  });

  it("one key being limited does not affect another", async () => {
    const h = use(build(succeeds));
    h.limiter.next({ kind: "limited", retryAfterSeconds: 3 });
    const limited = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    const other = await h.app.inject({ method: "POST", url, headers: authB, payload: body() });
    expect(limited.statusCode).toBe(429);
    expect(other.statusCode).toBe(200);
  });
});

describe("rate limiting: a real client disconnect while awaiting the limiter", () => {
  it("sends NO response body when the socket is destroyed mid-decision", async () => {
    // `inject` cannot model a real disconnect, so this one runs over a loopback
    // listener: the limiter blocks until the client is gone, then reports the
    // cancellation the route must translate into silence rather than a status.
    let released: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      released = resolve;
    });
    let consuming = false;

    const h = build(succeeds);
    const app = h.app;
    h.limiter.onNextConsume(() => {
      consuming = true;
    });
    h.limiter.always({ kind: "cancelled" });
    const original = h.limiter.consume.bind(h.limiter);
    // Hold the decision open until the client goes away.
    (h.limiter as { consume: FakeRateLimiter["consume"] }).consume = async (scope, signal) => {
      const result = original(scope, signal);
      await blocked;
      return result;
    };

    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
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
      request.write(JSON.stringify(body()));
      request.end();

      await waitFor(() => consuming);
      request.destroy();
      // Give the socket close event time to reach the route, then let the
      // limiter settle.
      await new Promise((resolve) => setTimeout(resolve, 50));
      released?.();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The gate really ran (so this is not passing vacuously), the client got
      // no body, and no completion work was started.
      expect(h.limiter.calls.count).toBe(1);
      expect(responded).toBe(false);
      expect(h.runs.count).toBe(0);
    } finally {
      await app.close();
    }
  }, 15_000);
});

describe("rate limiting: scope of the gate", () => {
  it("does not limit health, readiness, model metadata, or the title extension", async () => {
    const h = use(build(succeeds));
    h.limiter.always({ kind: "limited", retryAfterSeconds: 60 });

    const healthz = await h.app.inject({ method: "GET", url: "/healthz" });
    const readyz = await h.app.inject({ method: "GET", url: "/readyz" });
    const models = await h.app.inject({ method: "GET", url: "/v1/models", headers: authA });
    const one = await h.app.inject({
      method: "GET",
      url: "/v1/models/collectiviq-consensus",
      headers: authA,
    });
    const title = await h.app.inject({
      method: "GET",
      url: "/v1/opencode/session-title?session_id=sess-unknown",
      headers: authA,
    });

    expect(healthz.statusCode).toBe(200);
    expect(readyz.statusCode).toBe(200);
    expect(models.statusCode).toBe(200);
    expect(one.statusCode).toBe(200);
    // Whatever the title route answers for an unknown session, it is never a
    // rate-limit rejection.
    expect(title.statusCode).not.toBe(429);
    // Not one of them consulted the limiter.
    expect(h.limiter.calls.count).toBe(0);
  });
});
