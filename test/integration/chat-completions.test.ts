import { afterEach, describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import { createLogger } from "../../src/observability/logger.js";
import type { AuthResult, GatewayAuthenticator } from "../../src/api/gateway-auth.js";
import {
  ChatCompletionError,
  RequestCancelledError,
  type ChatCompletionRequestContext,
  type ChatCompletionService,
  type CompletionResult,
  type PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import type { TitleBridge } from "../../src/opencode/title-bridge.js";
import {
  COMPLETION_TIMEOUT_ERROR,
  GATEWAY_CAPACITY_EXCEEDED_ERROR,
  UPSTREAM_AUTHENTICATION_ERROR,
  UPSTREAM_QUOTA_EXCEEDED_ERROR,
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
    promptMode: "protocol",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
    ...over,
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
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: "collectiviq-gateway",
    models: [model("collectiviq-consensus"), model("collectiviq-fast")],
    ...over,
  };
}

/** The run behaviour under test; prepare is fixed so identity is deterministic. */
type RunFn = (prepared: PreparedCompletion, signal: AbortSignal) => Promise<CompletionResult>;

function fakeService(run: RunFn): ChatCompletionService {
  return {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => ({
      id: "chatcmpl_ciq_fixed",
      created: 1_785_933_840,
      model: ctx.request.model,
      prompt: "PROMPT",
      policy: ctx.model,
      selectedLlms: ctx.model.selectedLlms,
      keyId: ctx.keyId,
    }),
    run,
  };
}

const okAnswer: RunFn = () =>
  Promise.resolve({ kind: "text", upstreamThreadId: "thread-test", content: "hello answer" });

/** A no-op title bridge: these tests do not exercise native-title correlation. */
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

function build(handler: RunFn = okAnswer, configOver: Partial<AppConfig> = {}): GatewayServer {
  const readiness = createReadinessState(true);
  return buildServer({
    config: makeConfig(configOver),
    readiness,
    completion: {
      chatService: fakeService(handler),
      titleBridge: noopTitleBridge,
      shutdownSignal: new AbortController().signal,
    },
  });
}

/** Build the server with a custom authenticator (to exercise the auth hook). */
function buildWithAuth(authenticator: GatewayAuthenticator): GatewayServer {
  return buildServer({
    config: makeConfig(),
    readiness: createReadinessState(true),
    authenticator,
    completion: {
      chatService: fakeService(okAnswer),
      titleBridge: noopTitleBridge,
      shutdownSignal: new AbortController().signal,
    },
  });
}

const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const okBody = { model: "collectiviq-consensus", messages: [{ role: "user", content: "hi" }] };

describe("POST /v1/chat/completions — auth boundary", () => {
  it("authenticates before parsing the body (malformed body, no auth → 401)", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
  });

  it("rejects a valid request without credentials", async () => {
    app = build();
    const response = await app.inject({ method: "POST", url, payload: okBody });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /v1/chat/completions — success", () => {
  it("returns a non-streamed completion", async () => {
    app = build();
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      id: "chatcmpl_ciq_fixed",
      object: "chat.completion",
      created: 1_785_933_840,
      model: "collectiviq-consensus",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  it("emits the ignored-parameters header only when parameters were ignored", async () => {
    app = build();
    const withIgnored = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, temperature: 0.5, top_p: 0.9 },
    });
    expect(withIgnored.headers["x-collectiviq-ignored-parameters"]).toBe("temperature,top_p");

    const withoutIgnored = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: okBody,
    });
    expect(withoutIgnored.headers["x-collectiviq-ignored-parameters"]).toBeUndefined();
  });
});

describe("POST /v1/chat/completions — request rejections", () => {
  it("returns 404 for an unknown or case-mismatched model without calling the service", async () => {
    let called = false;
    app = build(() => {
      called = true;
      return Promise.resolve({
        kind: "text",
        upstreamThreadId: "thread-test",
        content: "unreachable",
      });
    });
    const unknown = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, model: "nope" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "model_not_found" } });

    const mismatch = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, model: "Collectiviq-Consensus" },
    });
    expect(mismatch.statusCode).toBe(404);
    expect(called).toBe(false);
  });

  it("returns 400 for malformed JSON with credentials", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, "content-type": "application/json" },
      payload: "{ nope",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("returns 400 for an unsupported content type", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, "content-type": "text/plain" },
      payload: "hello",
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 400 unsupported_content_type for an image part", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-consensus",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "unsupported_content_type" } });
  });

  it("returns 400 for an invalid (non-boolean) stream value and n!=1", async () => {
    app = build();
    const stream = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, stream: "yes" },
    });
    expect(stream.statusCode).toBe(400);
    expect(stream.json()).toMatchObject({ error: { param: "stream" } });

    const n = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, n: 2 },
    });
    expect(n.statusCode).toBe(400);
    expect(n.json()).toMatchObject({ error: { param: "n" } });
  });

  it("returns 413 when the body exceeds the configured limit", async () => {
    app = build(okAnswer, { MAX_REQUEST_BODY_BYTES: 1024 });
    const big = "x".repeat(2000);
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { model: "collectiviq-consensus", messages: [{ role: "user", content: big }] },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "request_too_large" } });
  });
});

describe("POST /v1/chat/completions — tool-metadata compatibility (disabled model)", () => {
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

  it("tolerates realistic tool metadata, returns ordinary text, and reports the ignored names", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, tools: toolDef, tool_choice: "auto", parallel_tool_calls: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ message: { role: "assistant", content: "hello answer" }, finish_reason: "stop" }],
    });
    // The definitions are never reflected; only the parameter names are recorded.
    expect(response.headers["x-collectiviq-ignored-parameters"]).toBe(
      "parallel_tool_calls,tool_choice,tools",
    );
  });

  it("rejects a required tool_choice with a stable 400 (never a silent text fallback)", async () => {
    let called = false;
    app = build(() => {
      called = true;
      return Promise.resolve({
        kind: "text",
        upstreamThreadId: "thread-test",
        content: "unreachable",
      });
    });
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...okBody, tools: toolDef, tool_choice: "required" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "unsupported_parameter", param: "tool_choice" },
    });
    expect(called).toBe(false);
  });

  it("rejects a named-function tool_choice with a stable 400", async () => {
    app = build();
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        ...okBody,
        tools: toolDef,
        tool_choice: { type: "function", function: { name: "read" } },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { param: "tool_choice" } });
  });
});

describe("POST /v1/chat/completions — tool metadata does not leak into logs", () => {
  it("keeps a tool-schema sentinel out of all captured logs (disabled model, ordinary text)", () => {
    // A capturing logger at the most verbose level; automatic request logging is
    // already disabled by buildServer, so no new logging seam is introduced.
    const lines: string[] = [];
    const stream: DestinationStream = {
      write: (chunk: string) => void lines.push(chunk),
    };
    const logger = createLogger({ LOG_LEVEL: "trace" }, stream);

    app = buildServer({
      config: makeConfig(),
      readiness: createReadinessState(true),
      logger,
      completion: {
        chatService: fakeService(okAnswer),
        titleBridge: noopTitleBridge,
        shutdownSignal: new AbortController().signal,
      },
    });

    const SENTINEL = "SENTINEL_TOOL_LOG_LEAK_MARKER_QZ7";
    return app
      .inject({
        method: "POST",
        url,
        headers: auth,
        payload: {
          ...okBody,
          tools: [
            {
              type: "function",
              function: {
                name: `tool_${SENTINEL}`,
                description: `describes ${SENTINEL}`,
                parameters: {
                  type: "object",
                  properties: { [SENTINEL]: { type: "string", description: SENTINEL } },
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: "auto",
        },
      })
      .then((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          choices: [{ message: { role: "assistant", content: "hello answer" } }],
        });
        // The sentinel appears nowhere in any captured log line.
        expect(lines.join("")).not.toContain(SENTINEL);
      });
  });
});

describe("POST /v1/chat/completions — error mapping", () => {
  const cases = [
    { name: "capacity", error: GATEWAY_CAPACITY_EXCEEDED_ERROR, status: 429, retryAfter: true },
    { name: "upstream quota", error: UPSTREAM_QUOTA_EXCEEDED_ERROR, status: 429, retryAfter: true },
    { name: "upstream auth", error: UPSTREAM_AUTHENTICATION_ERROR, status: 502, retryAfter: false },
    { name: "timeout", error: COMPLETION_TIMEOUT_ERROR, status: 504, retryAfter: false },
  ] as const;

  for (const c of cases) {
    it(`maps a ${c.name} completion error to ${c.status}`, async () => {
      app = build(() => Promise.reject(new ChatCompletionError(c.error)));
      const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
      expect(response.statusCode).toBe(c.status);
      expect(response.json()).toEqual(c.error.body);
      if (c.retryAfter) {
        expect(response.headers["retry-after"]).toBe("5");
      }
    });
  }

  it("maps an unexpected error to the fixed 500", async () => {
    app = build(() => Promise.reject(new Error("boom-should-never-surface")));
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        message: "The gateway encountered an internal error.",
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    });
    expect(response.body).not.toContain("boom-should-never-surface");
  });

  it("maps a shutdown cancellation (client still connected) to 503", async () => {
    app = build(() => Promise.reject(new RequestCancelledError()));
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "service_unavailable" } });
  });

  it("fails closed to 500 for a service rejection with a forged Fastify-like code", async () => {
    // A raw object that impersonates a Fastify parser error must NOT be able to
    // spoof a 400 — once the handler has begun, the error boundary fails closed.
    app = build(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the adversarial case IS a non-Error value forging a parser error
      Promise.reject({ code: "FST_ERR_CTP_INVALID_JSON", statusCode: 400, message: "spoofed" }),
    );
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(response.body).not.toContain("spoofed");
  });

  it("invokes no getter/trap on a hostile Proxy error and returns 500", async () => {
    let trapInvocations = 0;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          trapInvocations += 1;
          return "FST_ERR_CTP_INVALID_JSON";
        },
        getPrototypeOf: () => {
          trapInvocations += 1;
          return Object.prototype;
        },
        has: () => {
          trapInvocations += 1;
          return true;
        },
      },
    );
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the adversarial case IS a hostile non-Error Proxy value
    app = build(() => Promise.reject(hostile));
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(trapInvocations).toBe(0);
  });
});

describe("POST /v1/chat/completions — auth-hook provenance", () => {
  it("fails closed to 500 when the auth hook throws an Error forged with a Fastify parser code", async () => {
    // A pre-handler auth failure carrying a genuine Fastify parser code/status must
    // NOT be classified as a 400 — provenance (auth never completed) fails closed.
    const forged = Object.assign(new Error("spoofed parser"), {
      code: "FST_ERR_CTP_INVALID_JSON",
      statusCode: 400,
    });
    const authenticator: GatewayAuthenticator = {
      authenticate(): AuthResult {
        throw forged;
      },
    };
    app = buildWithAuth(authenticator);
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(response.body).not.toContain("spoofed");
  });

  it("fails closed to 500 with zero traps when the auth hook throws a hostile Proxy", async () => {
    let trapInvocations = 0;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          trapInvocations += 1;
          return "FST_ERR_CTP_INVALID_JSON";
        },
        getPrototypeOf: () => {
          trapInvocations += 1;
          return Object.prototype;
        },
        has: () => {
          trapInvocations += 1;
          return true;
        },
      },
    );
    const authenticator: GatewayAuthenticator = {
      authenticate(): AuthResult {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the adversarial case IS a hostile non-Error Proxy value
        throw hostile;
      },
    };
    app = buildWithAuth(authenticator);
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(trapInvocations).toBe(0);
  });

  it("still returns the fixed 401 for a normal authentication failure", async () => {
    const authenticator: GatewayAuthenticator = {
      authenticate(): AuthResult {
        return { ok: false };
      },
    };
    app = buildWithAuth(authenticator);
    const response = await app.inject({ method: "POST", url, headers: auth, payload: okBody });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
  });
});

describe("health and model endpoints remain intact", () => {
  it("keeps health unauthenticated and model listing working", async () => {
    app = build();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ object: "list" });
  });
});

describe("POST /v1/chat/completions — direct prompt mode", () => {
  const directConfig: Partial<AppConfig> = {
    models: [
      model("collectiviq-consensus"),
      model("collectiviq-claude-direct", { promptMode: "direct", answerSource: "gpt" }),
    ],
  };

  it("returns 400 (param messages) for a direct model with no user message, without running", async () => {
    let ran = false;
    const spy: RunFn = () => {
      ran = true;
      return Promise.resolve({
        kind: "text",
        upstreamThreadId: "thread-test",
        content: "should not happen",
      });
    };
    app = build(spy, directConfig);
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-claude-direct",
        messages: [{ role: "system", content: "no user" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "messages", code: "invalid_request" },
    });
    expect(ran).toBe(false);
  });

  it("accepts a direct model with a user message and returns ordinary text", async () => {
    app = build(okAnswer, directConfig);
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: "collectiviq-claude-direct",
        messages: [
          { role: "system", content: "ignored" },
          { role: "user", content: "hi" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: "collectiviq-claude-direct",
      choices: [{ message: { content: "hello answer" }, finish_reason: "stop" }],
    });
  });
});
