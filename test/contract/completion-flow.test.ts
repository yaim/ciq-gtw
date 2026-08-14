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
import { RequestCancelledError } from "../../src/generation/chat-completion.js";
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
    SHUTDOWN_DRAIN_MS: 30_000,
    models: [MODEL],
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

const createOk = (res: ServerResponse): void => void replyJson(res, { thread_id: 42 });
const processOk = (res: ServerResponse): void => void replyJson(res, { status: "ok" }, 202);

describe("completion flow — success", () => {
  it("creates a thread, submits once, polls, and returns the combined answer", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) =>
        replyJson(res, { messages: [{ source: "combined", content: "the combined answer" }] }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "collectiviq-consensus",
      choices: [{ message: { content: "the combined answer" }, finish_reason: "stop" }],
    });

    // The upstream saw exactly one create and one submit, correctly encoded.
    const create = mock?.requests.find((r) => r.path === "/create_thread");
    expect(create?.method).toBe("POST");
    expect(create?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(create?.text()).toContain("is_title_from_user=false");
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
        if (polls < 2)
          return void replyJson(res, { messages: [{ source: "gpt", content: "partial" }] });
        return void replyJson(res, { messages: [{ source: "combined", content: "final" }] });
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
            { source: "combined", content: "older", create_time: "2026-08-11T10:00:00Z" },
            { source: "combined", content: "newer", create_time: "2026-08-11T10:05:00Z" },
          ],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.json()).toMatchObject({ choices: [{ message: { content: "newer" } }] });
  });

  it("retries a transient (503) polling read and then succeeds", async () => {
    let polls = 0;
    const server = await startWith({
      "/create_thread": (_req, res) => createOk(res),
      "/process_message": (_req, res) => processOk(res),
      "/get_messages": (_req, res) => {
        polls += 1;
        if (polls < 2) return void replyRaw(res, "upstream busy", 503, "text/plain");
        return void replyJson(res, { messages: [{ source: "combined", content: "recovered" }] });
      },
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ choices: [{ message: { content: "recovered" } }] });
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
        replyJson(res, { messages: [{ source: "combined", content: "ordinary text answer" }] }),
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
      if (req.path === "/process_message") return void replyJson(res, { status: "ok" }, 202);
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
