/**
 * `POST /v1/chat/completions` with an `Idempotency-Key` (Phase 4A;
 * specification section 18).
 *
 * Hermetic end-to-end coverage over the real route, the real coordinator, and
 * an INJECTED in-memory store standing in for Redis. No socket, no Redis, no
 * CollectivIQ call, and no real credential — only synthetic values.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createReadinessState } from "../../src/api/health-route.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import {
  ChatCompletionError,
  RequestCancelledError,
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
import { decodeRecord } from "../../src/idempotency/records.js";
import {
  COMPLETION_TIMEOUT_ERROR,
  UPSTREAM_AUTHENTICATION_ERROR,
} from "../../src/openai/errors.js";
import type { TitleBridge, TitleRegistration } from "../../src/opencode/title-bridge.js";
import { buildServer, type GatewayServer } from "../../src/server.js";
import {
  createFakeIdempotencyStore,
  type FakeIdempotencyStore,
} from "../support/fake-idempotency-store.js";

const GATEWAY_KEY_A = "gw-fake-key-alpha";
const GATEWAY_KEY_B = "gw-fake-key-bravo";
const MASTER_KEY = randomBytes(32).toString("base64url");
const IDEMPOTENCY_KEY = "idem-fake-0001";
const ANSWER = "the original synthetic answer";
const THREAD_ID = "thread-sentinel-9";

const url = "/v1/chat/completions";
const authA = { authorization: `Bearer ${GATEWAY_KEY_A}` };
const authB = { authorization: `Bearer ${GATEWAY_KEY_B}` };
const keyed = { ...authA, "idempotency-key": IDEMPOTENCY_KEY };

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
    // Present so `buildServer` derives a non-null idempotency SCOPE. It never
    // creates a Redis client: the store is injected below.
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY,
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: "test-ns",
    RATE_LIMIT_ENABLED: false,
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
  readonly store: FakeIdempotencyStore;
  readonly runs: { count: number };
  readonly titles: TitleRegistration[];
  readonly shutdown: AbortController;
  readonly ids: string[];
}

/** Build the route over the real coordinator plus a fake completion service. */
function build(
  run: RunFn,
  options: {
    readonly withIdempotency?: boolean;
    readonly config?: Partial<AppConfig>;
    /** Virtual ms each waiter sleep advances the shared clock. */
    readonly sleepAdvancesMs?: number;
  } = {},
): Harness {
  let nowMs = 1_700_000_000_000;
  const store = createFakeIdempotencyStore({ nowMs: () => nowMs });
  const runs = { count: 0 };
  const titles: TitleRegistration[] = [];
  const ids: string[] = [];
  const shutdown = new AbortController();
  let seq = 0;

  const clock: Clock = { nowMs: () => nowMs };
  // Virtual sleeper: waiter backoff advances a fake clock instead of real time,
  // so a deadline is reachable deterministically and instantly.
  const sleeper: Sleeper = {
    sleep: (ms, signal) => {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      nowMs += options.sleepAdvancesMs ?? ms;
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
    // Renewal is driven explicitly by the tests that need it.
    scheduleRenewal: () => ({ cancel: () => undefined }),
  });

  const chatService: ChatCompletionService = {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => {
      seq += 1;
      const id = `chatcmpl_ciq_${String(seq)}`;
      ids.push(id);
      return {
        id,
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
  });
  return { app, store, runs, titles, shutdown, ids };
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

/** A completion that succeeds immediately, honouring any lifecycle hook. */
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
  return {
    model: "collectiviq-consensus",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  };
}

/** The ordered `data:` payloads of an SSE body. */
function dataPayloads(raw: string): string[] {
  return raw
    .split("\n\n")
    .filter((record) => record.startsWith("data: "))
    .map((record) => record.slice("data: ".length));
}
function jsonEvents(raw: string): Record<string, unknown>[] {
  return dataPayloads(raw)
    .filter((p) => p !== "[DONE]")
    .map((p) => JSON.parse(p) as Record<string, unknown>);
}

/** The single stored record's state, or `null`. */
function storedState(store: FakeIdempotencyStore, key = onlyKey(store)): string | null {
  const raw = key === null ? null : store.peek(key);
  if (raw === null) return null;
  const decoded = decodeRecord(raw);
  return decoded.ok ? decoded.record.s : "corrupt";
}
/** The storage key the coordinator used, recovered from the call log. */
function onlyKey(store: FakeIdempotencyStore): string | null {
  const claim = store.calls.find((c) => c.startsWith("claim:"));
  return claim === undefined ? null : claim.slice("claim:".length);
}

describe("idempotency: unkeyed requests are unchanged", () => {
  it("performs the completion normally with no Redis interaction (JSON)", async () => {
    const h = use(build(succeeds));
    const response = await h.app.inject({ method: "POST", url, headers: authA, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ choices: { message: { content: string } }[] }>().choices[0]?.message.content,
    ).toBe(ANSWER);
    expect(h.runs.count).toBe(1);
    expect(h.store.calls).toEqual([]);
  });

  it("performs the completion normally with no Redis interaction (SSE)", async () => {
    const h = use(build(succeeds));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: authA,
      payload: body({ stream: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    expect(h.store.calls).toEqual([]);
  });
});

describe("idempotency: header validation and unavailability", () => {
  it("rejects an invalid header with a stable 400 that never reflects the value", async () => {
    const h = use(build(succeeds));
    for (const value of ["", "has space", "x".repeat(256), "tab\there"]) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: { ...authA, "idempotency-key": value },
        payload: body(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: "The Idempotency-Key header is invalid for this request.",
          type: "invalid_request_error",
          param: "Idempotency-Key",
          code: "invalid_idempotency_key",
        },
      });
      expect(response.body).not.toContain(value.trim() || "\u0000");
    }
    // No completion work and no Redis interaction occurred.
    expect(h.runs.count).toBe(0);
    expect(h.store.calls).toEqual([]);
  });

  it("returns 503 with Retry-After: 2 and does NO work when Redis is disabled", async () => {
    const h = use(build(succeeds, { withIdempotency: false }));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual({
      error: {
        message: "Idempotent request handling is currently unavailable.",
        type: "server_error",
        param: null,
        code: "idempotency_unavailable",
      },
    });
    expect(h.runs.count).toBe(0);
  });

  it("returns 503 and does NO work when Redis is configured but unavailable", async () => {
    const h = use(build(succeeds));
    h.store.setReady(false);
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(h.runs.count).toBe(0);
    expect(h.store.calls).toEqual([]);
  });

  it("keeps the disabled-Redis 503 on the SSE path as a JSON error (pre-header)", async () => {
    const h = use(build(succeeds, { withIdempotency: false }));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body({ stream: true }),
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(h.runs.count).toBe(0);
  });

  it("still returns ordinary validation errors for an invalid body", async () => {
    const h = use(build(succeeds));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: { model: "collectiviq-consensus", messages: [], response_format: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).not.toBe(
      "invalid_idempotency_key",
    );
    expect(h.store.calls).toEqual([]);
  });
});

describe("idempotency: single execution, replay, and conflict", () => {
  it("executes the completion ONCE for two concurrent same-key/same-body requests (JSON)", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
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

    const first = h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    // Let the first request claim and enter `processing` before the second starts.
    await new Promise((resolve) => setImmediate(resolve));
    const second = h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    await new Promise((resolve) => setImmediate(resolve));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // Exactly one upstream completion for the pair.
    expect(h.runs.count).toBe(1);
    // Both responses carry the ORIGINAL identity and answer.
    expect(a.json()).toEqual(b.json());
    const payload = a.json<{
      id: string;
      created: number;
      choices: { message: { content: string } }[];
    }>();
    expect(payload.id).toBe(h.ids[0]);
    expect(payload.choices[0]?.message.content).toBe(ANSWER);
    // The duplicate's discarded prepared id is never returned.
    expect(payload.id).not.toBe(h.ids[1]);
  });

  it("replays a committed result with the original id, timestamp, model, and usage", async () => {
    const h = use(build(succeeds));
    const first = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    const second = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.runs.count).toBe(1);
    const payload = second.json<{
      id: string;
      created: number;
      model: string;
      choices: { finish_reason: string; message: { content: string } }[];
      usage: Record<string, number>;
    }>();
    expect(payload.id).toBe(h.ids[0]);
    expect(payload.created).toBe(1_700_000_001);
    expect(payload.model).toBe("collectiviq-consensus");
    expect(payload.choices[0]?.finish_reason).toBe("stop");
    expect(payload.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("replays a tool-call result unchanged", async () => {
    const h = use(
      build(async (_p, signal, hooks) => {
        await hooks?.onCapacityAcquired?.(signal);
        return {
          kind: "tool_calls",
          toolCalls: [{ id: "call_ciq_01", name: "read", argumentsJson: '{"path":"a.txt"}' }],
          upstreamThreadId: THREAD_ID,
          upstreamThreadCreated: true,
        };
      }),
    );
    const first = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    const second = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(first.json()).toEqual(second.json());
    const payload = second.json<{
      choices: { finish_reason: string; message: { content: null; tool_calls: unknown[] } }[];
    }>();
    expect(payload.choices[0]?.finish_reason).toBe("tool_calls");
    expect(payload.choices[0]?.message.tool_calls).toEqual([
      {
        id: "call_ciq_01",
        type: "function",
        function: { name: "read", arguments: '{"path":"a.txt"}' },
      },
    ]);
    expect(h.runs.count).toBe(1);
  });

  it("replays deterministic SSE frames built from the ORIGINAL metadata", async () => {
    const h = use(build(succeeds));
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body({ stream: true }),
    });
    const second = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body({ stream: true }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["content-type"]).toContain("text/event-stream");
    expect(h.runs.count).toBe(1);
    // Same frames, same ids, same terminal sequence.
    expect(dataPayloads(second.body)).toEqual(dataPayloads(first.body));
    const events = jsonEvents(second.body);
    expect(events.every((event) => event["id"] === h.ids[0])).toBe(true);
    expect(events.every((event) => event["created"] === 1_700_000_001)).toBe(true);
    expect(dataPayloads(second.body).at(-1)).toBe("[DONE]");
    // No usage is emitted on a stream.
    expect(events.some((event) => "usage" in event)).toBe(false);
  });

  it("treats a keyed SSE retry of a non-streamed original as a different body", async () => {
    // `stream` is a submitted field, so flipping it changes the canonical body.
    // That is a conflict, not a cross-transport replay.
    const h = use(build(succeeds));
    const jsonFirst = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    const sseRetry = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authA, "idempotency-key": IDEMPOTENCY_KEY },
      // A different `stream` value is a DIFFERENT body, so this is a conflict.
      payload: body({ stream: true }),
    });
    expect(jsonFirst.statusCode).toBe(200);
    expect(sseRetry.statusCode).toBe(409);
    expect(sseRetry.json<{ error: { code: string } }>().error.code).toBe(
      "idempotency_key_conflict",
    );
  });

  it("returns 409 for the same key with a different body", async () => {
    const h = use(build(succeeds));
    await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    const conflict = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body({ messages: [{ role: "user", content: "different" }] }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        message: "This Idempotency-Key was already used with a different request body.",
        type: "invalid_request_error",
        param: "Idempotency-Key",
        code: "idempotency_key_conflict",
      },
    });
    expect(conflict.headers["retry-after"]).toBeUndefined();
    expect(h.runs.count).toBe(1);
  });

  it("treats reordered keys and whitespace as the SAME body", async () => {
    const h = use(build(succeeds));
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: { ...keyed, "content-type": "application/json" },
      payload: '{"model":"collectiviq-consensus","messages":[{"role":"user","content":"hi"}]}',
    });
    const second = await h.app.inject({
      method: "POST",
      url,
      headers: { ...keyed, "content-type": "application/json" },
      payload:
        '{\n  "messages" : [ { "content" : "hi", "role" : "user" } ],\n  "model" : "collectiviq-consensus"\n}',
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.runs.count).toBe(1);
  });

  it("treats a changed IGNORED tool-metadata field as a different body", async () => {
    const h = use(build(succeeds));
    const tools = (name: string): Record<string, unknown> => ({
      tools: [
        {
          type: "function",
          function: { name, description: "d", parameters: { type: "object" } },
        },
      ],
      tool_choice: "auto",
    });
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body(tools("read")),
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body(tools("edit")),
    });
    expect(second.statusCode).toBe(409);
  });

  it("returns 409 for bodies differing only by a lone UTF-16 surrogate", async () => {
    // A UTF-8-lossy fingerprint would map "\ud800" and "\ud801" onto the same
    // replacement bytes and REPLAY the first answer for the second body. The
    // public contract must be a conflict.
    const h = use(build(succeeds));
    const withSurrogate = (surrogate: string): Record<string, unknown> =>
      body({ messages: [{ role: "user", content: surrogate }] });

    const first = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: withSurrogate("\ud800"),
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: withSurrogate("\ud801"),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("idempotency_key_conflict");

    // A literal U+FFFD is a third distinct body, not a match for either.
    const third = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: withSurrogate("\ufffd"),
    });
    expect(third.statusCode).toBe(409);

    // Only the FIRST body ever ran a completion.
    expect(h.runs.count).toBe(1);
  });

  it("still replays when a surrogate-bearing body is repeated exactly", async () => {
    const h = use(build(succeeds));
    const payload = body({ messages: [{ role: "user", content: "\ud800 tail" }] });
    const first = await h.app.inject({ method: "POST", url, headers: keyed, payload });
    const second = await h.app.inject({ method: "POST", url, headers: keyed, payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.runs.count).toBe(1);
  });

  it("keeps separate gateway keys from colliding on the same client key", async () => {
    const h = use(build(succeeds));
    const first = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    const other = await h.app.inject({
      method: "POST",
      url,
      headers: { ...authB, "idempotency-key": IDEMPOTENCY_KEY },
      payload: body(),
    });
    expect(first.statusCode).toBe(200);
    expect(other.statusCode).toBe(200);
    // A separate scope means a separate record and a genuinely new completion.
    expect(h.runs.count).toBe(2);
    expect(other.json<{ id: string }>().id).not.toBe(first.json<{ id: string }>().id);
  });
});

describe("idempotency: failure handling", () => {
  it("releases the claim when the completion fails BEFORE processing", async () => {
    const h = use(
      build(() => Promise.reject(new ChatCompletionError(UPSTREAM_AUTHENTICATION_ERROR))),
    );
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(502);
    // The record is compare-and-deleted, so a retry is not blocked.
    expect(storedState(h.store)).toBeNull();
    expect(h.store.calls).toContain(`release:reserved:${onlyKey(h.store) as string}`);

    const retry = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(retry.statusCode).toBe(502);
    expect(h.runs.count).toBe(2);
  });

  it("blocks with an ambiguous record when the completion fails AFTER processing", async () => {
    const h = use(
      build(async (_p, signal, hooks) => {
        await hooks?.onCapacityAcquired?.(signal);
        throw new ChatCompletionError(UPSTREAM_AUTHENTICATION_ERROR);
      }),
    );
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(502);
    expect(storedState(h.store)).toBe("ambiguous");

    // A retry is blocked for the TTL rather than risking a duplicate upstream
    // completion, because the side effect may already have happened.
    const retry = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(retry.statusCode).toBe(503);
    expect(retry.headers["retry-after"]).toBe("2");
    expect(h.runs.count).toBe(1);
  });

  it("releases capacity and performs NO upstream call when marking processing fails", async () => {
    let upstreamCalls = 0;
    const h = use(
      build(async (_p, signal, hooks) => {
        await hooks?.onCapacityAcquired?.(signal);
        upstreamCalls += 1;
        return {
          kind: "text",
          content: ANSWER,
          upstreamThreadId: THREAD_ID,
          upstreamThreadCreated: true,
        };
      }),
    );
    h.store.failNext("transition", "unavailable");
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("idempotency_unavailable");
    expect(upstreamCalls).toBe(0);
    // Proven pre-processing failure: the claim is released.
    expect(storedState(h.store)).toBeNull();
  });

  it("does NOT emit a success when the final persistence fails (JSON)", async () => {
    const h = use(build(succeeds));
    // The `reserved -> processing` transition succeeds; the `processing ->
    // final` one fails.
    let transitions = 0;
    const original = h.store.transition.bind(h.store);
    (h.store as { transition: FakeIdempotencyStore["transition"] }).transition = async (
      ...args
    ) => {
      transitions += 1;
      if (transitions === 2) return { kind: "unavailable" };
      return original(...args);
    };
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("idempotency_unavailable");
    expect(response.body).not.toContain(ANSWER);
    expect(storedState(h.store)).toBe("ambiguous");
  });

  it("does NOT emit a success when the final persistence fails (SSE)", async () => {
    const h = use(build(succeeds));
    let transitions = 0;
    const original = h.store.transition.bind(h.store);
    (h.store as { transition: FakeIdempotencyStore["transition"] }).transition = async (
      ...args
    ) => {
      transitions += 1;
      if (transitions === 2) return { kind: "unavailable" };
      return original(...args);
    };
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body({ stream: true }),
    });
    expect(response.statusCode).toBe(200); // headers were already committed
    // The answer is never written; a safe error record ends the stream instead.
    expect(response.body).not.toContain(ANSWER);
    const events = jsonEvents(response.body);
    expect(events.at(-1)).toEqual({
      error: {
        message: "Idempotent request handling is currently unavailable.",
        type: "server_error",
        param: null,
        code: "idempotency_unavailable",
      },
    });
    expect(dataPayloads(response.body).at(-1)).toBe("[DONE]");
    // No terminal `stop` chunk was emitted.
    expect(events.some((e) => JSON.stringify(e).includes('"finish_reason":"stop"'))).toBe(false);
  });

  it("fails closed on a corrupt or tampered record without replaying it", async () => {
    const h = use(build(succeeds));
    await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    const key = onlyKey(h.store) as string;
    h.store.poke(
      key,
      '{"v":1,"s":"final","f":"AAA","o":"BBB","e":1,"p":{"i":"a","c":"b","t":"c"}}',
    );
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(409); // fingerprint no longer matches
    h.store.poke(key, "not json at all");
    const corrupt = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(corrupt.statusCode).toBe(503);
    expect(h.runs.count).toBe(1);
  });

  it("maps a waiter that reaches the request deadline to the ordinary 504", async () => {
    // The owner holds the claim for the whole test; the waiter's own deadline
    // (the model's `requestTimeoutMs`) is what ends the wait. The model timeout
    // is set BELOW the active lease so the deadline, not a lease expiry, is what
    // the waiter observes.
    const h = use(
      build(
        async (_p, signal, hooks) => {
          await hooks?.onCapacityAcquired?.(signal);
          return new Promise<CompletionResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new RequestCancelledError()), {
              once: true,
            });
          });
        },
        {
          // Each virtual sleep advances 5 s, so the 20 s deadline is reached in
          // four polls with no wall-clock delay.
          sleepAdvancesMs: 5_000,
          config: { models: [{ ...model("collectiviq-consensus"), requestTimeoutMs: 20_000 }] },
        },
      ),
    );
    const owner = h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    await new Promise((resolve) => setImmediate(resolve));

    const waiter = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(waiter.statusCode).toBe(504);
    expect(waiter.json<{ error: { code: string } }>().error.code).toBe("completion_timeout");
    // The waiter never started a second completion.
    expect(h.runs.count).toBe(1);

    // Release the owner so the suite's afterEach close cannot hang.
    h.shutdown.abort();
    expect((await owner).statusCode).toBe(503);
  });

  it("does not duplicate work when the owner is cancelled by shutdown", async () => {
    const h = use(
      build(async (_p, signal, hooks) => {
        await hooks?.onCapacityAcquired?.(signal);
        throw new RequestCancelledError();
      }),
    );
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(503);
    // The completion may have reached upstream, so the key stays blocked.
    expect(storedState(h.store)).toBe("ambiguous");
    expect(h.runs.count).toBe(1);
  });

  it("propagates an ordinary completion timeout unchanged", async () => {
    const h = use(
      build(async (_p, signal, hooks) => {
        await hooks?.onCapacityAcquired?.(signal);
        throw new ChatCompletionError(COMPLETION_TIMEOUT_ERROR);
      }),
    );
    const response = await h.app.inject({ method: "POST", url, headers: keyed, payload: body() });
    expect(response.statusCode).toBe(504);
    expect(storedState(h.store)).toBe("ambiguous");
  });
});

describe("idempotency: native-title correlation", () => {
  const withSession = { ...keyed, "x-collectiviq-opencode-session-id": "ses_fake_1" };

  it("registers a correlation for the ORIGINAL owner only", async () => {
    const h = use(build(succeeds));
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: withSession,
      payload: body(),
    });
    expect(first.statusCode).toBe(200);
    expect(h.titles).toHaveLength(1);
    expect(h.titles[0]).toMatchObject({ sessionId: "ses_fake_1", upstreamThreadId: THREAD_ID });

    // A replay must NOT register: the thread id is deliberately not cached.
    const replay = await h.app.inject({
      method: "POST",
      url,
      headers: withSession,
      payload: body(),
    });
    expect(replay.statusCode).toBe(200);
    expect(h.titles).toHaveLength(1);
  });

  it("registers no correlation for a streamed replay", async () => {
    const h = use(build(succeeds));
    await h.app.inject({
      method: "POST",
      url,
      headers: withSession,
      payload: body({ stream: true }),
    });
    expect(h.titles).toHaveLength(1);
    await h.app.inject({
      method: "POST",
      url,
      headers: withSession,
      payload: body({ stream: true }),
    });
    expect(h.titles).toHaveLength(1);
  });
});

describe("idempotency: stored state safety", () => {
  it("stores no prompt, answer, gateway key, or client idempotency key", async () => {
    const h = use(build(succeeds));
    await h.app.inject({
      method: "POST",
      url,
      headers: keyed,
      payload: body({ messages: [{ role: "user", content: "PROMPT-SENTINEL" }] }),
    });
    const key = onlyKey(h.store) as string;
    const raw = h.store.peek(key) as string;
    for (const sentinel of [
      ANSWER,
      "PROMPT-SENTINEL",
      GATEWAY_KEY_A,
      IDEMPOTENCY_KEY,
      THREAD_ID,
      "collectiviq-consensus",
    ]) {
      expect(raw).not.toContain(sentinel);
      expect(key).not.toContain(sentinel);
    }
    // The key is namespaced but otherwise an opaque HMAC.
    expect(key.startsWith("test-ns:idem:")).toBe(true);
  });
});
