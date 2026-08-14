import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import {
  ChatCompletionError,
  RequestCancelledError,
  type ChatCompletionRequestContext,
  type ChatCompletionService,
  type CompletionResult,
  type PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import {
  COMPLETION_TIMEOUT_ERROR,
  CONTEXT_LENGTH_EXCEEDED_ERROR,
  GATEWAY_CAPACITY_EXCEEDED_ERROR,
  UPSTREAM_AUTHENTICATION_ERROR,
} from "../../src/openai/errors.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-fake-key";

function model(id: string, over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id,
    displayName: id,
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
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
    models: [model("collectiviq-consensus")],
  };
}

type RunFn = (prepared: PreparedCompletion, signal: AbortSignal) => Promise<CompletionResult>;

/** Fake service with a fixed, deterministic prepared identity. */
function fakeService(run: RunFn, prepareThrows?: () => never): ChatCompletionService {
  return {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => {
      if (prepareThrows) prepareThrows();
      return {
        id: "chatcmpl_ciq_stream",
        created: 1_785_933_840,
        model: ctx.request.model,
        prompt: "PROMPT",
        policy: ctx.model,
        keyId: ctx.keyId,
      };
    },
    run,
  };
}

let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(run: RunFn, prepareThrows?: () => never): GatewayServer {
  return buildServer({
    config: makeConfig(),
    readiness: createReadinessState(true),
    completion: {
      chatService: fakeService(run, prepareThrows),
      shutdownSignal: new AbortController().signal,
    },
  });
}

const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const streamBody = {
  model: "collectiviq-consensus",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

/** The ordered `data:` payloads (raw strings; `[DONE]` stays a literal). */
function dataPayloads(body: string): string[] {
  return body
    .split("\n\n")
    .filter((r) => r.length > 0)
    .filter((r) => r.startsWith("data: "))
    .map((r) => r.slice("data: ".length));
}
/** The parsed JSON chunk/error objects (excludes the `[DONE]` sentinel). */
function jsonEvents(body: string): unknown[] {
  return dataPayloads(body)
    .filter((p) => p !== "[DONE]")
    .map((p) => JSON.parse(p) as unknown);
}

describe("POST /v1/chat/completions — synthetic SSE success", () => {
  it("streams role → content → terminal → [DONE] with a stable identity", async () => {
    app = build(() => Promise.resolve({ content: "Hello, world" }));
    const res = await app.inject({ method: "POST", url, headers: auth, payload: streamBody });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = jsonEvents(res.body) as {
      id: string;
      object: string;
      created: number;
      model: string;
      choices: {
        index: number;
        delta: { role?: string; content?: string };
        finish_reason: string | null;
      }[];
    }[];

    // First frame: assistant role opener with a null finish_reason.
    expect(events[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(events[0]?.choices[0]?.finish_reason).toBeNull();
    // Middle frames: content deltas.
    const content = events.map((e) => e.choices[0]?.delta.content ?? "").join("");
    expect(content).toBe("Hello, world");
    // Last chunk before [DONE]: empty delta with finish_reason "stop".
    const last = events.at(-1);
    expect(last?.choices[0]?.delta).toEqual({});
    expect(last?.choices[0]?.finish_reason).toBe("stop");
    // The stream ends with exactly one [DONE].
    expect(dataPayloads(res.body).at(-1)).toBe("[DONE]");

    // Stable id / created / model / object / choice index across every frame.
    for (const e of events) {
      expect(e.id).toBe("chatcmpl_ciq_stream");
      expect(e.created).toBe(1_785_933_840);
      expect(e.model).toBe("collectiviq-consensus");
      expect(e.object).toBe("chat.completion.chunk");
      expect(e.choices[0]?.index).toBe(0);
    }
  });

  it("emits role, terminal, and [DONE] but no content frame for an empty answer", async () => {
    app = build(() => Promise.resolve({ content: "" }));
    const res = await app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.statusCode).toBe(200);
    const events = jsonEvents(res.body) as {
      choices: { delta: object; finish_reason: string | null }[];
    }[];
    expect(events).toHaveLength(2); // role + terminal only
    expect(events[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(events[1]?.choices[0]?.finish_reason).toBe("stop");
    expect(dataPayloads(res.body).at(-1)).toBe("[DONE]");
  });

  it("emits the ignored-parameters header on the streamed response", async () => {
    app = build(() => Promise.resolve({ content: "hi" }));
    const res = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...streamBody, temperature: 0.4 },
    });
    expect(res.headers["x-collectiviq-ignored-parameters"]).toBe("temperature");
  });
});

describe("POST /v1/chat/completions — tool metadata on the stream path", () => {
  const toolDef = [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];

  it("tolerates tool metadata and streams ordinary text with the ignored header", async () => {
    app = build(() => Promise.resolve({ content: "Hello, world" }));
    const res = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...streamBody, tools: toolDef, tool_choice: "auto" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-collectiviq-ignored-parameters"]).toBe("tool_choice,tools");

    const events = jsonEvents(res.body) as {
      choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
    }[];
    expect(events[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    const content = events.map((e) => e.choices[0]?.delta.content ?? "").join("");
    expect(content).toBe("Hello, world");
    expect(events.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(dataPayloads(res.body).at(-1)).toBe("[DONE]");
  });

  it("rejects a required tool_choice as a pre-header JSON 400, never opening an SSE stream", async () => {
    let called = false;
    app = build(() => {
      called = true;
      return Promise.resolve({ content: "unreachable" });
    });
    const res = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...streamBody, tools: toolDef, tool_choice: "required" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({
      error: { param: "tool_choice", code: "unsupported_parameter" },
    });
    expect(res.body).not.toContain("event-stream");
    expect(called).toBe(false);
  });
});

describe("POST /v1/chat/completions — post-header failures become SSE error records", () => {
  const cases = [
    {
      name: "capacity",
      make: () => new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR),
      code: "gateway_capacity_exceeded",
    },
    {
      name: "timeout",
      make: () => new ChatCompletionError(COMPLETION_TIMEOUT_ERROR),
      code: "completion_timeout",
    },
    {
      name: "upstream auth",
      make: () => new ChatCompletionError(UPSTREAM_AUTHENTICATION_ERROR),
      code: "upstream_authentication_failed",
    },
    {
      name: "shutdown cancel",
      make: () => new RequestCancelledError(),
      code: "service_unavailable",
    },
    {
      name: "unexpected",
      make: () => new Error("boom-should-never-surface"),
      code: "internal_error",
    },
  ] as const;

  for (const c of cases) {
    it(`encodes a ${c.name} failure as a safe error record + [DONE] (HTTP 200)`, async () => {
      app = build(() => Promise.reject(c.make()));
      const res = await app.inject({ method: "POST", url, headers: auth, payload: streamBody });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      const events = jsonEvents(res.body);
      // role opener first, then exactly the safe error record — no terminal stop.
      expect((events[0] as { choices: { delta: object }[] }).choices[0]?.delta).toEqual({
        role: "assistant",
      });
      expect(events[1]).toMatchObject({ error: { code: c.code } });
      expect(res.body).not.toContain('"stop"');
      expect(res.body).not.toContain("boom-should-never-surface");
      expect(dataPayloads(res.body).at(-1)).toBe("[DONE]");
    });
  }

  it("maps an upstream UpstreamError from run to its safe SSE envelope", async () => {
    app = build(() =>
      Promise.reject(
        new ChatCompletionError({
          status: 502,
          body: {
            error: {
              message: "x",
              type: "upstream_error",
              param: null,
              code: "upstream_request_failed",
            },
          },
        }),
      ),
    );
    const res = await app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.statusCode).toBe(200);
    expect(jsonEvents(res.body)[1]).toMatchObject({ error: { code: "upstream_request_failed" } });
  });
});

describe("POST /v1/chat/completions — preparation errors stay pre-header JSON on the stream path", () => {
  it("returns a JSON 400 (not SSE) when prepare rejects an oversized prompt", async () => {
    app = build(
      () => Promise.resolve({ content: "unreachable" }),
      () => {
        throw new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR);
      },
    );
    const res = await app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({ error: { code: "context_length_exceeded" } });
    expect(res.body).not.toContain("event-stream");
  });
});
