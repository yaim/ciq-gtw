import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import type {
  ChatCompletionRequestContext,
  ChatCompletionService,
  CompletionResult,
  PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import type { TitleBridge, TitleRegistration } from "../../src/opencode/title-bridge.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import type { ParsedToolCall } from "../../src/tools/index.js";

const GATEWAY_KEY = "gw-fake-key";

function model(id: string, over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id,
    displayName: id,
    selectedLlms: ["claude"],
    generateCombined: false,
    answerSource: "claude",
    toolMode: "disabled",
    promptMode: "protocol",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
    ...over,
  };
}

function makeConfig(): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake",
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
    models: [model("collectiviq-claude-tools", { toolMode: "emulated" })],
  };
}

const TOOL_CALLS: ParsedToolCall[] = [
  { id: "call_ciq_FIXED", name: "read", argumentsJson: '{"path":"src/index.ts"}' },
];

type RunFn = (prepared: PreparedCompletion, signal: AbortSignal) => Promise<CompletionResult>;

function fakeService(run: RunFn): ChatCompletionService {
  return {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => ({
      id: "chatcmpl_ciq_fixed",
      created: 1_785_933_840,
      model: ctx.request.model,
      prompt: "PROMPT",
      policy: ctx.model,
      keyId: ctx.keyId,
      selectedLlms: ctx.model.selectedLlms,
    }),
    run,
  };
}

const toolResult: RunFn = () =>
  Promise.resolve({ kind: "tool_calls", toolCalls: TOOL_CALLS, upstreamThreadId: "t1" });

const noopTitleBridge: TitleBridge = {
  register: () => {},
  lookup: () => Promise.resolve({ kind: "unavailable" }),
};

let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function build(run: RunFn = toolResult): GatewayServer {
  return buildServer({
    config: makeConfig(),
    readiness: createReadinessState(true),
    completion: {
      chatService: fakeService(run),
      titleBridge: noopTitleBridge,
      shutdownSignal: new AbortController().signal,
    },
  });
}

const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const readTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};
const baseBody = {
  model: "collectiviq-claude-tools",
  messages: [{ role: "user", content: "read src/index.ts" }],
  tools: [readTool],
};

function dataPayloads(body: string): string[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => line.slice("data: ".length));
}

function jsonEvents(body: string): unknown[] {
  return dataPayloads(body)
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as unknown);
}

describe("POST /v1/chat/completions — emulated tool calls (JSON)", () => {
  it("returns an OpenAI tool_calls response with finish_reason tool_calls", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...baseBody, tool_choice: "auto" },
    });
    expect(response.statusCode).toBe(200);
    const json = response.json<Record<string, unknown>>();
    expect(json).toMatchObject({
      model: "collectiviq-claude-tools",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_ciq_FIXED",
                type: "function",
                function: { name: "read", arguments: '{"path":"src/index.ts"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  it("does not report consumed tools/tool_choice/parallel_tool_calls as ignored parameters", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...baseBody, tool_choice: "auto", parallel_tool_calls: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-collectiviq-ignored-parameters"]).toBeUndefined();
  });

  it("accepts a named tool_choice that references a declared tool", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...baseBody, tool_choice: { type: "function", function: { name: "read" } } },
    });
    expect(response.statusCode).toBe(200);
  });

  it("accepts an OpenCode draft-2020-12 tool schema and returns tool_calls", async () => {
    app = build();
    const read2020 = {
      type: "function",
      function: {
        name: "read",
        description: "Read a file.",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    };
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-claude-tools",
        messages: [{ role: "user", content: "read src/index.ts" }],
        tools: [read2020],
        tool_choice: "auto",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
    });
  });

  it("rejects an unsupported $schema dialect with a content-free 400 BEFORE any run", async () => {
    app = build(() => {
      throw new Error("run must not be reached");
    });
    const badDialect = {
      type: "function",
      function: {
        name: "read",
        parameters: { $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" },
      },
    };
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-claude-tools",
        messages: [{ role: "user", content: "hi" }],
        tools: [badDialect],
        tool_choice: "auto",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      error: { code: "unsupported_parameter", param: "tools" },
    });
  });

  it("rejects required tool_choice with no declared tools BEFORE any run (JSON 400)", async () => {
    app = build(() => {
      throw new Error("run must not be reached");
    });
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-claude-tools",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "required",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      error: { code: "unsupported_parameter", param: "tool_choice" },
    });
  });
});

describe("POST /v1/chat/completions — emulated tool calls (SSE)", () => {
  it("streams one indexed tool-call delta, a tool_calls terminal, then [DONE], with no usage", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...baseBody, tool_choice: "auto", stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const payloads = dataPayloads(response.body);
    expect(payloads.at(-1)).toBe("[DONE]");

    const events = jsonEvents(response.body) as Array<{
      choices: { delta: { role?: string; tool_calls?: unknown[] }; finish_reason: string | null }[];
    }>;
    // First frame: assistant role opener.
    expect(events[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    // A tool-call delta is present with the trusted id.
    const toolDelta = events.find((e) => e.choices[0]?.delta.tool_calls !== undefined);
    expect(toolDelta?.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_ciq_FIXED",
        type: "function",
        function: { name: "read", arguments: '{"path":"src/index.ts"}' },
      },
    ]);
    // Terminal chunk uses finish_reason tool_calls.
    expect(events.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
    // No usage is emitted on a stream.
    expect(response.body).not.toContain("usage");
  });
});

describe("POST /v1/chat/completions — native-title correlation after a tool-call success", () => {
  function buildWithBridge(bridge: TitleBridge): GatewayServer {
    return buildServer({
      config: makeConfig(),
      readiness: createReadinessState(true),
      completion: {
        chatService: fakeService(toolResult),
        titleBridge: bridge,
        shutdownSignal: new AbortController().signal,
      },
    });
  }

  it("registers the upstream thread id exactly once for a tool-call result, without leaking it", async () => {
    const registrations: TitleRegistration[] = [];
    const bridge: TitleBridge = {
      register: (r) => void registrations.push(r),
      lookup: () => Promise.resolve({ kind: "unavailable" }),
    };
    app = buildWithBridge(bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, "x-collectiviq-opencode-session-id": "sess-tools-1" },
      payload: { ...baseBody, tool_choice: "auto" },
    });
    expect(response.statusCode).toBe(200);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ sessionId: "sess-tools-1", upstreamThreadId: "t1" });
    // The upstream thread id never appears in the public response body.
    expect(response.body).not.toContain("t1");
  });
});
