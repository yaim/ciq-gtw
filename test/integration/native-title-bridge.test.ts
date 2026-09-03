/**
 * Completion-path integration for native-title correlation registration.
 *
 * A fake chat service returns a distinctive upstream thread id; a spy title
 * bridge records `register` calls. These prove: a valid OpenCode session header
 * registers exactly once on success (JSON) and only after a fully delivered
 * stream ([DONE]) (SSE); an absent/malformed header or a failed completion
 * registers nothing; and the internal upstream thread id never appears in the
 * public JSON or SSE output.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import {
  ChatCompletionError,
  type ChatCompletionRequestContext,
  type ChatCompletionService,
  type CompletionResult,
  type PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import { COMPLETION_TIMEOUT_ERROR } from "../../src/openai/errors.js";
import type { TitleBridge, TitleRegistration } from "../../src/opencode/title-bridge.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-fake-key";
const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const SESSION_HEADER = "x-collectiviq-opencode-session-id";
const THREAD_ID = "UPSTREAM-THREAD-XYZ";

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
    models: [model("collectiviq-consensus")],
  };
}

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

const okRun: RunFn = () =>
  Promise.resolve({
    kind: "text",
    content: "the answer",
    upstreamThreadId: THREAD_ID,
    upstreamThreadCreated: true,
  });
const failRun: RunFn = () => Promise.reject(new ChatCompletionError(COMPLETION_TIMEOUT_ERROR));

function spyBridge(): { bridge: TitleBridge; registrations: TitleRegistration[] } {
  const registrations: TitleRegistration[] = [];
  const bridge: TitleBridge = {
    register: (r) => void registrations.push(r),
    lookup: () => Promise.resolve({ kind: "unavailable" }),
  };
  return { bridge, registrations };
}

let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(run: RunFn, bridge: TitleBridge): GatewayServer {
  return buildServer({
    config: makeConfig(),
    readiness: createReadinessState(true),
    completion: {
      chatService: fakeService(run),
      titleBridge: bridge,
      shutdownSignal: new AbortController().signal,
    },
  });
}

const body = { model: "collectiviq-consensus", messages: [{ role: "user", content: "hi" }] };

describe("native-title correlation — non-streamed JSON", () => {
  it("registers exactly once with a valid session header, and never leaks the thread id", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(okRun, bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, [SESSION_HEADER]: "sess-123" },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(registrations).toEqual([
      { keyId: "k0", sessionId: "sess-123", upstreamThreadId: THREAD_ID },
    ]);
    // The internal upstream thread id is never present in the public JSON.
    expect(response.body).not.toContain(THREAD_ID);
    expect(JSON.stringify(response.json())).not.toContain(THREAD_ID);
  });

  it("does not register when the session header is absent (ordinary completion)", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(okRun, bridge);
    const response = await app.inject({ method: "POST", url, headers: auth, payload: body });
    expect(response.statusCode).toBe(200);
    expect(registrations).toHaveLength(0);
  });

  it("does not register when the session header is malformed", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(okRun, bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, [SESSION_HEADER]: "bad session!" },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(registrations).toHaveLength(0);
  });

  it("does not register when the completion fails", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(failRun, bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, [SESSION_HEADER]: "sess-123" },
      payload: body,
    });
    expect(response.statusCode).toBe(504);
    expect(registrations).toHaveLength(0);
  });
});

describe("native-title correlation — synthetic SSE", () => {
  it("registers once after a fully delivered stream ([DONE]) and never leaks the thread id", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(okRun, bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, [SESSION_HEADER]: "sess-123" },
      payload: { ...body, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(registrations).toEqual([
      { keyId: "k0", sessionId: "sess-123", upstreamThreadId: THREAD_ID },
    ]);
    expect(response.body).not.toContain(THREAD_ID);
  });

  it("does not register a failed stream", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(failRun, bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, [SESSION_HEADER]: "sess-123" },
      payload: { ...body, stream: true },
    });
    // A post-header failure is encoded as an SSE error record; nothing registers.
    expect(response.statusCode).toBe(200);
    expect(registrations).toHaveLength(0);
  });

  it("does not register a streamed success when the session header is absent", async () => {
    const { bridge, registrations } = spyBridge();
    app = build(okRun, bridge);
    const response = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(registrations).toHaveLength(0);
  });
});
