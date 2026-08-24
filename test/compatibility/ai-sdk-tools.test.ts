/**
 * Hermetic OpenAI-compatibility suite for EMULATED tool calling (pinned `ai` /
 * `@ai-sdk/openai-compatible`). It drives the SDK's public `generateText` /
 * `streamText` — including the SDK's own multi-step tool loop — against an
 * ephemeral loopback gateway backed by a SCRIPTED fake completion. The fake tools
 * operate only on synthetic in-memory state; there is NO shell, filesystem, MCP,
 * external tool, or network execution, and no CollectivIQ call.
 *
 * The gateway's REAL request normalization (tool definitions, tool_choice, and
 * prior tool-call/result history linkage + schema validation) runs on every
 * round; only prepare/run (upstream + parse/select) is faked so the tool/text
 * sequence is deterministic.
 *
 * Run only via `npm run test:compatibility` (kept out of `validate`/CI).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import type {
  ChatCompletionRequestContext,
  ChatCompletionService,
  CompletionResult,
  PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import type { TitleBridge } from "../../src/opencode/title-bridge.js";
import type { ParsedToolCall } from "../../src/tools/index.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-compat-tools-key";

const MODEL: VirtualModel = {
  id: "collectiviq-claude-tools",
  displayName: "Tools",
  selectedLlms: ["claude"],
  generateCombined: false,
  answerSource: "claude",
  toolMode: "emulated",
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
    models: [MODEL],
  };
}

const textResult = (content: string): CompletionResult => ({
  kind: "text",
  content,
  upstreamThreadId: "t",
});
const toolResult = (calls: ParsedToolCall[]): CompletionResult => ({
  kind: "tool_calls",
  toolCalls: calls,
  upstreamThreadId: "t",
});

/**
 * A SCRIPTED completion service. `script` is consumed one `run()` at a time, so a
 * test can drive an exact tool → tool → tool → final sequence. Its prepare is a
 * fixed identity (no upstream I/O).
 */
function scriptedService(script: CompletionResult[]): ChatCompletionService {
  let step = 0;
  return {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => ({
      id: `chatcmpl_ciq_${step}`,
      created: 1_785_933_840,
      model: ctx.request.model,
      prompt: "PROMPT",
      policy: ctx.model,
      selectedLlms: ctx.model.selectedLlms,
      keyId: ctx.keyId,
    }),
    run: (): Promise<CompletionResult> => {
      const next = script[step] ?? textResult("done");
      step += 1;
      return Promise.resolve(next);
    },
  };
}

const noopTitleBridge: TitleBridge = {
  register: () => {},
  lookup: () => Promise.resolve({ kind: "unavailable" }),
};

let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function startGateway(service: ChatCompletionService): Promise<string> {
  app = buildServer({
    config: config(),
    readiness: createReadinessState(true),
    completion: {
      chatService: service,
      titleBridge: noopTitleBridge,
      shutdownSignal: new AbortController().signal,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

function providerFor(baseURL: string) {
  return createOpenAICompatible({ name: "collectiviq", baseURL, apiKey: GATEWAY_KEY });
}

// Fake tools over synthetic in-memory state only (no shell/fs/network).
function makeTools(fs: Map<string, string>) {
  const calls: string[] = [];
  const tools = {
    read: tool({
      description: "Read a file from the in-memory workspace.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: ({ path }) => {
        calls.push(`read:${path}`);
        return Promise.resolve(fs.get(path) ?? "");
      },
    }),
    edit: tool({
      description: "Overwrite a file in the in-memory workspace.",
      inputSchema: jsonSchema<{ path: string; text: string }>({
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
        additionalProperties: false,
      }),
      execute: ({ path, text }) => {
        fs.set(path, text);
        calls.push(`edit:${path}`);
        return Promise.resolve("ok");
      },
    }),
    test: tool({
      description: "Run the in-memory test suite.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        additionalProperties: false,
      }),
      execute: () => {
        calls.push("test");
        return Promise.resolve("pass");
      },
    }),
  };
  return { tools, calls };
}

describe("@ai-sdk/openai-compatible tool calling against the gateway", () => {
  it("generateText surfaces a single tool call with parsed arguments", async () => {
    const service = scriptedService([
      toolResult([{ id: "call_ciq_r1", name: "read", argumentsJson: '{"path":"a.ts"}' }]),
      textResult("read complete"),
    ]);
    const baseURL = await startGateway(service);
    const fs = new Map<string, string>([["a.ts", "export const x = 1;"]]);
    const { tools } = makeTools(fs);

    const result = await generateText({
      model: providerFor(baseURL)("collectiviq-claude-tools"),
      tools,
      toolChoice: "auto",
      maxRetries: 0,
      messages: [{ role: "user", content: "read a.ts" }],
    });
    expect(result.toolCalls.map((c) => c.toolName)).toEqual(["read"]);
    expect(result.toolCalls[0]?.input).toEqual({ path: "a.ts" });
    expect(result.finishReason).toBe("tool-calls");
  });

  it("accepts a tool whose schema explicitly declares JSON Schema draft 2020-12", async () => {
    // OpenCode 1.18.21 stamps its built-in tool schemas with draft 2020-12. The
    // gateway's REAL request normalization compiles the incoming schema before any
    // scripted run, so a 200 with a surfaced tool call proves 2020-12 compiled.
    const service = scriptedService([
      toolResult([{ id: "call_ciq_r1", name: "read", argumentsJson: '{"filePath":"a.ts"}' }]),
      textResult("read complete"),
    ]);
    const baseURL = await startGateway(service);
    const tools2020 = {
      read: tool({
        description: "Read a file (draft 2020-12 schema).",
        inputSchema: jsonSchema<{ filePath: string }>({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            filePath: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 0 },
          },
          required: ["filePath"],
          additionalProperties: false,
        }),
        execute: ({ filePath }) => Promise.resolve(`content:${filePath}`),
      }),
    };

    const result = await generateText({
      model: providerFor(baseURL)("collectiviq-claude-tools"),
      tools: tools2020,
      toolChoice: "auto",
      maxRetries: 0,
      messages: [{ role: "user", content: "read a.ts" }],
    });
    expect(result.toolCalls.map((c) => c.toolName)).toEqual(["read"]);
    expect(result.toolCalls[0]?.input).toEqual({ filePath: "a.ts" });
    expect(result.finishReason).toBe("tool-calls");
  });

  it("streamText surfaces a single tool call", async () => {
    const service = scriptedService([
      toolResult([{ id: "call_ciq_r1", name: "read", argumentsJson: '{"path":"a.ts"}' }]),
      textResult("done"),
    ]);
    const baseURL = await startGateway(service);
    const { tools } = makeTools(new Map([["a.ts", "x"]]));

    const result = streamText({
      model: providerFor(baseURL)("collectiviq-claude-tools"),
      tools,
      toolChoice: "auto",
      maxRetries: 0,
      messages: [{ role: "user", content: "read a.ts" }],
    });
    // Drain the stream.
    for await (const _ of result.textStream) {
      /* consume */
    }
    const toolCalls = await result.toolCalls;
    expect(toolCalls.map((c) => c.toolName)).toEqual(["read"]);
    expect(await result.finishReason).toBe("tool-calls");
  });

  it("completes an in-memory three-step read → edit → test loop, then a final answer", async () => {
    const service = scriptedService([
      toolResult([{ id: "call_ciq_read", name: "read", argumentsJson: '{"path":"a.ts"}' }]),
      toolResult([
        {
          id: "call_ciq_edit",
          name: "edit",
          argumentsJson: '{"path":"a.ts","text":"export const x = 2;"}',
        },
      ]),
      toolResult([{ id: "call_ciq_test", name: "test", argumentsJson: "{}" }]),
      textResult("All three steps completed."),
    ]);
    const baseURL = await startGateway(service);
    const fs = new Map<string, string>([["a.ts", "export const x = 1;"]]);
    const { tools, calls } = makeTools(fs);

    const result = await generateText({
      model: providerFor(baseURL)("collectiviq-claude-tools"),
      tools,
      toolChoice: "auto",
      maxRetries: 0,
      stopWhen: stepCountIs(10),
      messages: [{ role: "user", content: "read a.ts, bump the constant, and run the tests" }],
    });

    // The SDK executed all three fake tools in order against in-memory state.
    expect(calls).toEqual(["read:a.ts", "edit:a.ts", "test"]);
    expect(fs.get("a.ts")).toBe("export const x = 2;");
    expect(result.text).toBe("All three steps completed.");
    expect(result.finishReason).toBe("stop");
    expect(result.steps.length).toBe(4);
  });
});
