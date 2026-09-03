/**
 * Adapter-backed contract tests for EMULATED tool calling. These drive the REAL
 * completion runtime against the hermetic mock CollectivIQ server, so the full
 * create → process → get_messages → parse → tool_calls flow is exercised end to
 * end. No external network and no credentials.
 *
 * Note: in emulated mode the validated tool schemas ARE serialized into the
 * upstream prompt by design (specification section 11.2), so the tool schema is
 * EXPECTED to appear in the `/process_message` body. What must NOT happen is the
 * schema/answer leaking into LOGS or the public response body.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import type { ServerResponse } from "node:http";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import { createLogger } from "../../src/observability/logger.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import { startMockServer, replyJson, type CapturedRequest } from "./support/mock-server.js";

const GATEWAY_KEY = "gw-fake-key";
const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const SENTINEL = "SENTINEL_TOOL_SCHEMA_7f3a";

/**
 * The synthetic run id the mock upstream reports from `process_message` and
 * echoes on the entries it returns. Both the desired-source answer and the
 * per-source consensus candidates are correlated to this run.
 */
const RUN_ID = "synthetic-run-tools-flow";

const TOOLS_MODEL: VirtualModel = {
  id: "collectiviq-claude-tools",
  displayName: "Tools",
  selectedLlms: ["claude"],
  generateCombined: false,
  answerSource: "claude",
  toolMode: "emulated",
  promptMode: "protocol",
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
    LOG_LEVEL: "trace",
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
    models: [TOOLS_MODEL],
  };
}

type Routes = Record<string, (req: CapturedRequest, res: ServerResponse) => void>;

let mock: Awaited<ReturnType<typeof startMockServer>> | undefined;
let app: GatewayServer | undefined;
let logLines: string[] = [];

afterEach(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
  logLines = [];
});

async function startWith(routes: Routes): Promise<GatewayServer> {
  mock = await startMockServer((req, res) => {
    const handler = routes[req.path];
    if (handler) return handler(req, res);
    res.writeHead(404).end();
  });
  logLines = [];
  const stream: DestinationStream = { write: (chunk) => void logLines.push(chunk) };
  const logger = createLogger({ LOG_LEVEL: "trace" }, stream);
  app = buildServer({
    config: configFor(mock.baseUrl),
    readiness: createReadinessState(true),
    logger,
  });
  return app;
}

const readTool = {
  type: "function",
  function: {
    name: "read",
    description: `Read a file. ${SENTINEL}`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const toolBody = {
  model: "collectiviq-claude-tools",
  messages: [{ role: "user", content: "read src/index.ts" }],
  tools: [readTool],
  tool_choice: "auto",
};

const envelope = JSON.stringify({
  gateway_protocol: "1.0",
  type: "tool_calls",
  calls: [{ name: "read", arguments: { path: "src/index.ts" } }],
});

describe("completion flow — emulated tool calls", () => {
  it("parses an upstream tool envelope into OpenAI tool_calls with one create + one submit", async () => {
    const server = await startWith({
      "/create_thread": (_req, res) => void replyJson(res, { thread_id: 7 }),
      "/process_message": (_req, res) =>
        void replyJson(res, { status: "ok", combined_run_id: RUN_ID }, 202),
      "/get_messages": (_req, res) =>
        void replyJson(res, {
          messages: [{ source: "claude", content: envelope, combined_run_id: RUN_ID }],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: toolBody });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "read", arguments: '{"path":"src/index.ts"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    // Exactly one create + one submit.
    expect(mock?.requests.filter((r) => r.path === "/create_thread")).toHaveLength(1);
    const submits = mock?.requests.filter((r) => r.path === "/process_message") ?? [];
    expect(submits).toHaveLength(1);
    // The tool protocol + tool definitions ARE serialized into the prompt (by design).
    const submitBody = submits[0]?.text() ?? "";
    expect(submitBody).toContain("BEGIN_AVAILABLE_TOOLS_JSON");
    expect(submitBody).toContain("tool-or-final");
    expect(submitBody).toContain(SENTINEL); // tool schema is in the prompt (expected)

    // The gateway-owned call id is used (never an upstream id), and the tool
    // schema / answer never leak into the PUBLIC response or the LOGS.
    const body = response.json<{ choices: { message: { tool_calls: { id: string }[] } }[] }>();
    const id = body.choices[0]?.message.tool_calls[0]?.id ?? "";
    expect(id.startsWith("call_ciq_")).toBe(true);
    expect(response.body).not.toContain(SENTINEL);
    expect(logLines.join("")).not.toContain(SENTINEL);
    expect(logLines.join("")).not.toContain("src/index.ts");
  });

  it("maps a required tool_choice with no valid upstream tool call to 502 invalid_tool_response", async () => {
    const finalEnvelope = JSON.stringify({
      gateway_protocol: "1.0",
      type: "final",
      content: "I won't call a tool",
    });
    const server = await startWith({
      "/create_thread": (_req, res) => void replyJson(res, { thread_id: 8 }),
      "/process_message": (_req, res) =>
        void replyJson(res, { status: "ok", combined_run_id: RUN_ID }, 202),
      "/get_messages": (_req, res) =>
        void replyJson(res, {
          messages: [{ source: "claude", content: finalEnvelope, combined_run_id: RUN_ID }],
        }),
    });
    const response = await server.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...toolBody, tool_choice: "required" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_tool_response",
        type: "upstream_protocol_error",
        param: "tool_choice",
      },
    });
  });

  it("falls back to text under auto when the upstream returns a final answer", async () => {
    const finalEnvelope = JSON.stringify({
      gateway_protocol: "1.0",
      type: "final",
      content: "here is the answer",
    });
    const server = await startWith({
      "/create_thread": (_req, res) => void replyJson(res, { thread_id: 9 }),
      "/process_message": (_req, res) =>
        void replyJson(res, { status: "ok", combined_run_id: RUN_ID }, 202),
      "/get_messages": (_req, res) =>
        void replyJson(res, {
          messages: [{ source: "claude", content: finalEnvelope, combined_run_id: RUN_ID }],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: toolBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ message: { content: "here is the answer" }, finish_reason: "stop" }],
    });
  });

  it("ignores a tool envelope left over from an earlier run of the same thread", async () => {
    // The tool path reads the SAME snapshot the poller ranked, so a stale
    // envelope — here a syntactically perfect tool call from a previous turn —
    // must be ineligible for both the desired answer and consensus voting.
    const staleEnvelope = JSON.stringify({
      gateway_protocol: "1.0",
      type: "tool_calls",
      calls: [{ name: "read", arguments: { path: "STALE_PATH_FROM_EARLIER_RUN" } }],
    });
    const server = await startWith({
      "/create_thread": (_req, res) => void replyJson(res, { thread_id: 10 }),
      "/process_message": (_req, res) =>
        void replyJson(res, { status: "ok", combined_run_id: RUN_ID }, 202),
      "/get_messages": (_req, res) =>
        void replyJson(res, {
          messages: [
            {
              source: "claude",
              content: staleEnvelope,
              create_time: "2026-08-11T10:00:00Z",
              combined_run_id: "synthetic-run-earlier-turn",
            },
            { source: "claude", content: envelope, combined_run_id: RUN_ID },
          ],
        }),
    });
    const response = await server.inject({ method: "POST", url, headers: auth, payload: toolBody });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: "read", arguments: '{"path":"src/index.ts"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(response.body).not.toContain("STALE_PATH_FROM_EARLIER_RUN");
  });
});
