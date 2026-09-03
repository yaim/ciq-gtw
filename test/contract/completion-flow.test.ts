/**
 * Adapter-backed contract tests for `POST /v1/chat/completions`.
 *
 * These drive the REAL completion runtime (credential provider → adapter →
 * capacity → poller → serializer) against the hermetic mock CollectivIQ HTTP
 * server, so the full create → process → get_messages → answer flow, selection
 * policy, retryable polling, and error mapping are exercised end to end. No
 * external network and no credentials.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import { createCompletionRuntime } from "../../src/generation/runtime.js";
import {
  RequestCancelledError,
  type PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import type { NormalizedChatRequest } from "../../src/openai/chat-types.js";
import {
  startMockServer,
  replyJson,
  replyRaw,
  type CapturedRequest,
} from "./support/mock-server.js";

const GATEWAY_KEY = "gw-fake-key";
const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const okBody = { model: "collectiviq-consensus", messages: [{ role: "user", content: "hi" }] };

const MODEL: VirtualModel = {
  id: "collectiviq-consensus",
  displayName: "Consensus",
  selectedLlms: ["gpt", "claude"],
  generateCombined: true,
  answerSource: "combined",
  toolMode: "disabled",
  promptMode: "protocol",
  requestTimeoutMs: 1_000,
  pollIntervalMs: 100,
  maxPollIntervalMs: 100,
  maximumPromptBytes: 6_291_456,
};

/** A Claude direct-profile model: latest-user-only prompt, single Claude source. */
const DIRECT_MODEL: VirtualModel = {
  id: "collectiviq-claude-direct",
  displayName: "CollectivIQ Claude Direct",
  selectedLlms: ["claude"],
  generateCombined: false,
  answerSource: "claude",
  toolMode: "disabled",
  promptMode: "direct",
  requestTimeoutMs: 1_000,
  pollIntervalMs: 100,
  maxPollIntervalMs: 100,
  maximumPromptBytes: 6_291_456,
};

function configFor(baseUrl: string): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: baseUrl,
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake-upstream",
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY],
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
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: "collectiviq-gateway",
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    METRICS_ENABLED: false,
    TRACING_ENABLED: false,
    TRACING_SAMPLE_RATIO: 1,
    models: [MODEL, DIRECT_MODEL],
  };
}

type Routes = Record<string, (req: CapturedRequest, res: ServerResponse) => void>;

let mock: Awaited<ReturnType<typeof startMockServer>> | undefined;
let app: GatewayServer | undefined;

afterEach(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function startWith(routes: Routes): Promise<GatewayServer> {
  mock = await startMockServer((req, res) => {
    const handler = routes[req.path];
    if (handler) return handler(req, res);
    res.writeHead(404).end();
  });
  app = buildServer({ config: configFor(mock.baseUrl), readiness: createReadinessState(true) });
  return app;
}

/**
 * The synthetic run id the mock upstream reports from `process_message` and
 * echoes on the entries it returns from `get_messages`. Answer selection is
 * correlated to the run this completion submitted, so an entry must carry the
 * same id to be eligible at all.
 */
const RUN_ID = "synthetic-run-completion-flow";

const createOk = (res: ServerResponse): void => void replyJson(res, { thread_id: 42 });
const processOk = (res: ServerResponse): void =>
  void replyJson(res, { status: "ok", combined_run_id: RUN_ID }, 202);

/** A `get_messages` entry produced by the current run. */
function entry(
  source: string,
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { source, content, combined_run_id: RUN_ID, ...extra };
}

describe("completion flow — success", () => {
  it("creates a thread, submits once, polls, and returns the combined answer", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, { messages: [entry("combined", "the combined answer")] }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "collectiviq-consensus",
      choices: [{ message: { content: "the combined answer" }, finish_reason: "stop" }],
    });

    // The upstream saw exactly one create and one submit, correctly encoded.
    const creates = mock?.requests.filter((r) => r.path === "/create_thread") ?? [];
    expect(creates).toHaveLength(1);
    const create = creates[0];
    expect(create?.method).toBe("POST");
    expect(create?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    // The URL-encoded create body carries the fixed `New Thread` placeholder and
    // `is_title_from_user=false` — parse it rather than substring-matching so the
    // exact wire title is bound (CollectivIQ replaces it server-side afterwards).
    const createParams = new URLSearchParams(create?.text() ?? "");
    expect(createParams.get("thread_title")).toBe("New Thread");
    expect(createParams.get("is_title_from_user")).toBe("false");
    const submits = mock?.requests.filter((r) => r.path === "/process_message") ?? [];
    expect(submits).toHaveLength(1);
    const submitBody = submits[0]?.text() ?? "";
    expect(submits[0]?.headers["content-type"]).toContain("multipart/form-data");
    expect(submitBody).toContain('name="selected_llms"');
    expect(submitBody).toContain("gpt,claude");
    expect(submitBody).toContain('name="generate_combined"');
    expect(submitBody).toContain("BEGIN_CONVERSATION_JSON");
  });

  it("keeps polling through partial (wrong-source) responses", async () => {
    let polls = 0;
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) => {
        polls += 1;
        if (polls < 2) return void replyJson(res, { messages: [entry("gpt", "partial")] });
        return void replyJson(res, { messages: [entry("combined", "final")] });
      },
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ choices: [{ message: { content: "final" } }] });
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("selects the latest-timestamp message among duplicate combined sources", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, {
          messages: [
            entry("combined", "older", { create_time: "2026-08-11T10:00:00Z" }),
            entry("combined", "newer", { create_time: "2026-08-11T10:05:00Z" }),
          ],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.json()).toMatchObject({ choices: [{ message: { content: "newer" } }] });
  });

  it("ignores a message that does not belong to this run, even when it outranks", async () => {
    // MUTATION GUARD, end to end over the real runtime. A thread may already hold
    // an earlier turn's answer (reuse) or unrelated content, and the ordering
    // policy prefers a dated message over an undated one — so the stale entry
    // would win outright if selection were not correlated to this submission.
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, {
          messages: [
            {
              source: "combined",
              content: "the PREVIOUS answer",
              create_time: "2026-08-11T10:00:00Z",
              combined_run_id: "synthetic-run-earlier-turn",
            },
            entry("combined", "this run's answer"),
          ],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ message: { content: "this run's answer" } }],
    });
    expect(response.body).not.toContain("the PREVIOUS answer");
  });

  it("times out rather than returning an answer from another run", async () => {
    // Never a fallback to older or uncorrelated content: with nothing from this
    // run, the request must reach the authoritative deadline and fail with 504.
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, {
          messages: [
            {
              source: "combined",
              content: "the PREVIOUS answer",
              create_time: "2026-08-11T10:00:00Z",
              combined_run_id: "synthetic-run-earlier-turn",
            },
            // An entry naming no run is just as ineligible as a foreign one.
            { source: "combined", content: "an unattributable answer" },
          ],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: { code: "completion_timeout" } });
    expect(response.body).not.toContain("the PREVIOUS answer");
  });

  it("retries a transient (503) polling read and then succeeds", async () => {
    let polls = 0;
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) => {
        polls += 1;
        if (polls < 2) return void replyRaw(res, "upstream busy", 503, "text/plain");
        return void replyJson(res, { messages: [entry("combined", "recovered")] });
      },
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ choices: [{ message: { content: "recovered" } }] });
  });
});

describe("completion flow — direct prompt mode", () => {
  const directBody = {
    model: "collectiviq-claude-direct",
    messages: [
      { role: "system", content: "SENTINEL_SYSTEM_ZZ1" },
      { role: "developer", content: "SENTINEL_DEVELOPER_ZZ2" },
      { role: "user", content: "SENTINEL_USER_OLD_ZZ3" },
      { role: "assistant", content: "SENTINEL_ASSISTANT_ZZ4" },
      { role: "user", content: "the only content that should be submitted" },
    ],
  };

  it("submits only the latest user content, without the protocol wrapper", async () => {
    let polledThreadId: string | null = null;
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (req, res) => {
        polledThreadId = req.query.get("thread_id");
        return void replyJson(res, { messages: [entry("claude", "direct answer")] });
      },
    });
    const response = await server.inject({
      method: "POST",
      url,
      headers: auth,
      payload: directBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: "collectiviq-claude-direct",
      choices: [{ message: { content: "direct answer" }, finish_reason: "stop" }],
    });
    // Correlation confirms polling ran against the created thread.
    expect(polledThreadId).toBe("42");

    // Exactly one thread + one submit; single Claude source, no combined.
    const creates = mock?.requests.filter((r) => r.path === "/create_thread") ?? [];
    const submits = mock?.requests.filter((r) => r.path === "/process_message") ?? [];
    expect(creates).toHaveLength(1);
    expect(submits).toHaveLength(1);
    const submitBody = submits[0]?.text() ?? "";
    expect(submitBody).toContain('name="selected_llms"');
    expect(submitBody).toContain("claude");
    expect(submitBody).not.toContain("gpt");
    expect(submitBody).toContain('name="generate_combined"');

    // The submitted prompt is EXACTLY the latest user content — no protocol
    // header, no JSON envelope/markers, and none of the other messages.
    expect(submitBody).toContain("the only content that should be submitted");
    expect(submitBody).not.toContain("COLLECTIVIQ GATEWAY PROTOCOL");
    expect(submitBody).not.toContain("BEGIN_CONVERSATION_JSON");
    expect(submitBody).not.toContain("END_CONVERSATION_JSON");
    for (const sentinel of [
      "SENTINEL_SYSTEM_ZZ1",
      "SENTINEL_DEVELOPER_ZZ2",
      "SENTINEL_USER_OLD_ZZ3",
      "SENTINEL_ASSISTANT_ZZ4",
    ]) {
      expect(submitBody).not.toContain(sentinel);
    }
  });

  it("polls for the model's answer source (claude) and streams the same text", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, {
          messages: [entry("gpt", "wrong source"), entry("claude", "direct streamed answer")],
        }),
    });
    const response = await server.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...directBody, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("direct streamed answer");
    expect(response.body).not.toContain("wrong source");
    expect(response.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("rejects a direct-mode request with no user message before any upstream call", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) => replyJson(res, { messages: [] }),
    });
    const response = await server.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-claude-direct",
        messages: [{ role: "system", content: "no user here" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "messages", code: "invalid_request" },
    });
    // No upstream request was made at all.
    expect(mock?.requests ?? []).toHaveLength(0);
  });
});

describe("completion flow — tool metadata is discarded before upstream", () => {
  it("tolerates tool metadata, keeps one thread + one submit, and never leaks the tool schema", async () => {
    // A unique marker embedded in the tool definition must not appear in the
    // serialized prompt, the multipart submit, any upstream request, or the
    // public response — the definition is discarded at the OpenAI boundary.
    const SENTINEL = "SENTINEL_TOOL_SCHEMA_MARKER_ZZQ9";
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, { messages: [entry("combined", "ordinary text answer")] }),
    });
    const payload = {
      ...okBody,
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: SENTINEL,
            parameters: {
              type: "object",
              properties: { [SENTINEL]: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
    };
    const response = await server.inject({ method: "POST", url, headers: auth, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ message: { content: "ordinary text answer" }, finish_reason: "stop" }],
    });
    expect(response.headers["x-collectiviq-ignored-parameters"]).toBe("tool_choice,tools");
    expect(response.body).not.toContain(SENTINEL);

    // Exactly one create and one submit — the flow is unchanged by tool metadata.
    const creates = mock?.requests.filter((r) => r.path === "/create_thread") ?? [];
    const submits = mock?.requests.filter((r) => r.path === "/process_message") ?? [];
    expect(creates).toHaveLength(1);
    expect(submits).toHaveLength(1);

    // The multipart submit carries the serialized conversation but NOT the schema.
    const submitBody = submits[0]?.text() ?? "";
    expect(submitBody).toContain("BEGIN_CONVERSATION_JSON");
    expect(submitBody).not.toContain(SENTINEL);

    // No captured upstream request anywhere carries the sentinel.
    for (const captured of mock?.requests ?? []) {
      expect(captured.text()).not.toContain(SENTINEL);
    }
  });
});

describe("completion flow — error mapping", () => {
  it("maps a malformed get_messages body to 502 invalid_upstream_response", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) => replyJson(res, { not_messages: true }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "invalid_upstream_response" } });
  });

  it("maps a process_message body carrying `detail` to 502", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => replyJson(res, { detail: "rejected" }, 202),
      "/get_messages": (_req, res) => replyJson(res, { messages: [] }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(502);
    // The upstream `detail` value is never reflected to the client.
    expect(response.body).not.toContain("rejected");
  });

  it("maps an upstream 401 on create to 502 upstream_authentication_failed", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => replyRaw(res, "nope", 401, "text/plain"),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "upstream_authentication_failed" } });
  });

  it("maps an upstream 429 on create to 429 upstream_quota_exceeded", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => replyRaw(res, "slow down", 429, "text/plain"),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: "upstream_quota_exceeded" } });
    expect(response.headers["retry-after"]).toBe("5");
  });

  it("times out with 504 when no desired answer ever arrives", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) => replyJson(res, { messages: [] }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: { code: "completion_timeout" } });
  });
});

describe("completion flow — cancellation", () => {
  it("aborts polling and raises RequestCancelledError on client cancellation", async () => {
    mock = await startMockServer((req, res) => {
      if (req.path === "/create_thread") return void replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message") return void processOk(res);
      if (req.path === "/get_messages") return void replyJson(res, { messages: [] });
      res.writeHead(404).end();
    });
    const runtime = createCompletionRuntime(configFor(mock.baseUrl));
    const controller = new AbortController();
    const request: NormalizedChatRequest = {
      model: "collectiviq-consensus",
      messages: [{ role: "user", content: "hi" }],
      ignoredParameters: [],
      stream: false,
    };
    const prepared = runtime.chatService.prepare({
      request,
      model: MODEL,
      keyId: "k0",
      signal: controller.signal,
    });
    const promise = runtime.chatService.run(prepared, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);
  });
});

describe("completion flow — capacity lifecycle hook", () => {
  /** Drive the REAL completion service against the mock server. */
  function prepareReal(runtime: ReturnType<typeof createCompletionRuntime>): PreparedCompletion {
    const request: NormalizedChatRequest = {
      model: "collectiviq-consensus",
      messages: [{ role: "user", content: "hi" }],
      ignoredParameters: [],
      stream: false,
    };
    return runtime.chatService.prepare({
      request,
      model: MODEL,
      keyId: "k0",
      signal: new AbortController().signal,
    });
  }

  /** Start the happy-path mock and return its base URL. */
  async function startHappyMock(): Promise<string> {
    const started = await startMockServer((req, res) => {
      if (req.path === "/create_thread") return void replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message") return void processOk(res);
      if (req.path === "/get_messages") {
        return void replyJson(res, {
          messages: [entry("combined", "answer", { create_time: "2026-01-01T00:00:00Z" })],
        });
      }
      res.writeHead(404).end();
    });
    mock = started;
    return started.baseUrl;
  }

  /** Upstream requests captured so far, for ordering assertions. */
  const capturedPaths = (path: string): readonly CapturedRequest[] =>
    (mock?.requests ?? []).filter((request) => request.path === path);

  it("runs the hook AFTER capacity and BEFORE create_thread", async () => {
    // The hook is the single seam the idempotency layer uses to move a claim to
    // `processing`. Its ordering is a load-bearing guarantee, so it is asserted
    // against the real service — not against a fake that calls the hook itself.
    const baseUrl = await startHappyMock();
    const runtime = createCompletionRuntime(configFor(baseUrl));
    const observed: { active: number; creates: number } = { active: -1, creates: -1 };

    const result = await runtime.chatService.run(
      prepareReal(runtime),
      new AbortController().signal,
      {
        onCapacityAcquired: () => {
          // A permit is already held...
          observed.active = runtime.capacity.activeCount;
          // ...and no upstream request has been issued yet.
          observed.creates = capturedPaths("/create_thread").length;
          return Promise.resolve();
        },
      },
    );

    expect(result).toEqual({
      kind: "text",
      content: "answer",
      upstreamThreadId: "7",
      upstreamThreadCreated: true,
    });
    expect(observed.active).toBe(1);
    expect(observed.creates).toBe(0);
    // The permit is released once the completion finishes.
    expect(runtime.capacity.activeCount).toBe(0);
  });

  it("makes NO upstream call and releases capacity when the hook rejects", async () => {
    const baseUrl = await startHappyMock();
    const runtime = createCompletionRuntime(configFor(baseUrl));
    const failure = new Error("hook rejected");

    await expect(
      runtime.chatService.run(prepareReal(runtime), new AbortController().signal, {
        onCapacityAcquired: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);

    // Nothing whatsoever reached CollectivIQ.
    expect(mock?.requests ?? []).toHaveLength(0);
    // And the permit was released, so the next request can still be admitted.
    expect(runtime.capacity.activeCount).toBe(0);
    const second = await runtime.chatService.run(
      prepareReal(runtime),
      new AbortController().signal,
    );
    expect(second.kind).toBe("text");
    expect(capturedPaths("/create_thread")).toHaveLength(1);
  });

  it("behaves exactly as before when no hook is supplied", async () => {
    const baseUrl = await startHappyMock();
    const runtime = createCompletionRuntime(configFor(baseUrl));
    const result = await runtime.chatService.run(
      prepareReal(runtime),
      new AbortController().signal,
    );
    expect(result.kind).toBe("text");
    expect(capturedPaths("/create_thread")).toHaveLength(1);
  });
});
