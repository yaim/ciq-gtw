/**
 * Hermetic OpenAI-compatibility suite (pinned `ai` / `@ai-sdk/openai-compatible`,
 * matching OpenCode 1.18.18). It drives the SDK's public `streamText` /
 * `generateText` against an ephemeral loopback gateway backed by a FAKE
 * completion implementation. It never contacts CollectivIQ, never reads a real
 * credential, and never uses repository content — the "upstream" answer is a
 * synthetic constant returned by the fake service.
 *
 * Run only via `npm run test:compatibility` (kept out of `validate`/CI).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, streamText, tool } from "ai";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import type {
  ChatCompletionRequestContext,
  ChatCompletionService,
  CompletionResult,
  PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import type { TitleBridge } from "../../src/opencode/title-bridge.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

// A synthetic, multi-sentence answer (well over one content chunk) that lets the
// SDK's incremental parsing and our deterministic split be verified together.
const ANSWER =
  "The gateway buffers the complete answer and only then splits it into deltas. " +
  "Synthetic streaming keeps the connection alive; it cannot speed up the first token. " +
  "Polling remains authoritative, and no upstream event stream is consumed. " +
  "This sentence pushes the answer comfortably past a single content chunk boundary.";

const GATEWAY_KEY = "gw-compat-fake-key";

const MODEL: VirtualModel = {
  id: "collectiviq-consensus",
  displayName: "Consensus",
  selectedLlms: ["gpt"],
  generateCombined: false,
  answerSource: "gpt",
  toolMode: "disabled",
  promptMode: "protocol",
  requestTimeoutMs: 30_000,
  pollIntervalMs: 1_000,
  maxPollIntervalMs: 1_000,
  maximumPromptBytes: 6_291_456,
};

function config(): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 0,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake-upstream-never-used",
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
    models: [MODEL],
  };
}

/** A fake completion service that returns a constant answer — no upstream I/O. */
const fakeService: ChatCompletionService = {
  prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => ({
    id: "chatcmpl_ciq_compat",
    created: 1_785_933_840,
    model: ctx.request.model,
    prompt: "PROMPT",
    policy: ctx.model,
    selectedLlms: ctx.model.selectedLlms,
    keyId: ctx.keyId,
  }),
  run: (): Promise<CompletionResult> =>
    Promise.resolve({ kind: "text", upstreamThreadId: "thread-test", content: ANSWER }),
};

/** A no-op title bridge: the compatibility suite does not exercise native titles. */
const noopTitleBridge: TitleBridge = {
  register: () => {},
  lookup: () => Promise.resolve({ kind: "unavailable" }),
};

let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function startGateway(): Promise<string> {
  app = buildServer({
    config: config(),
    readiness: createReadinessState(true),
    completion: {
      chatService: fakeService,
      titleBridge: noopTitleBridge,
      shutdownSignal: new AbortController().signal,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

function providerFor(baseURL: string) {
  return createOpenAICompatible({
    name: "collectiviq",
    baseURL,
    apiKey: GATEWAY_KEY,
  });
}

describe("@ai-sdk/openai-compatible against the gateway", () => {
  it("reconstructs the answer via streamText and reports finishReason 'stop'", async () => {
    const baseURL = await startGateway();
    const provider = providerFor(baseURL);

    const result = streamText({
      model: provider("collectiviq-consensus"),
      messages: [{ role: "user", content: "Explain synthetic streaming." }],
      maxRetries: 0,
    });

    let streamed = "";
    for await (const delta of result.textStream) streamed += delta;

    expect(streamed).toBe(ANSWER);
    expect(await result.text).toBe(ANSWER);
    expect(await result.finishReason).toBe("stop");
  });

  it("returns the answer via a non-streamed generateText call", async () => {
    const baseURL = await startGateway();
    const provider = providerFor(baseURL);

    const result = await generateText({
      model: provider("collectiviq-consensus"),
      messages: [{ role: "user", content: "Explain synthetic streaming." }],
      maxRetries: 0,
    });

    expect(result.text).toBe(ANSWER);
    expect(result.finishReason).toBe("stop");
  });

  it("reconstructs text via streamText when a function tool + toolChoice auto are sent", async () => {
    // OpenCode attaches tool definitions automatically; a text-only model must
    // tolerate them and still stream ordinary text with no tool call.
    const baseURL = await startGateway();
    const provider = providerFor(baseURL);

    const result = streamText({
      model: provider("collectiviq-consensus"),
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: {
        get_weather: tool({
          description: "Get the current weather for a city.",
          inputSchema: jsonSchema<{ city: string }>({
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
            additionalProperties: false,
          }),
        }),
      },
      toolChoice: "auto",
      maxRetries: 0,
    });

    let streamed = "";
    for await (const delta of result.textStream) streamed += delta;

    expect(streamed).toBe(ANSWER);
    expect(await result.text).toBe(ANSWER);
    expect(await result.finishReason).toBe("stop");
    expect(await result.toolCalls).toEqual([]);
  });

  it("returns text via generateText with a function tool (no 'tools is not supported yet')", async () => {
    const baseURL = await startGateway();
    const provider = providerFor(baseURL);

    const result = await generateText({
      model: provider("collectiviq-consensus"),
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: {
        get_weather: tool({
          description: "Get the current weather for a city.",
          inputSchema: jsonSchema<{ city: string }>({
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
            additionalProperties: false,
          }),
        }),
      },
      toolChoice: "auto",
      maxRetries: 0,
    });

    expect(result.text).toBe(ANSWER);
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });

  it("surfaces a model-not-found as an SDK error (unknown virtual model)", async () => {
    const baseURL = await startGateway();
    const provider = providerFor(baseURL);
    await expect(
      generateText({
        model: provider("no-such-model"),
        messages: [{ role: "user", content: "hi" }],
        maxRetries: 0,
      }),
    ).rejects.toBeDefined();
  });
});
