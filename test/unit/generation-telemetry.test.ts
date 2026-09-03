/**
 * Generation-layer instrumentation (specification section 23).
 *
 * Exercises the REAL completion runtime — the adapter decorator, the real
 * poller, the real capacity controller, and the real orchestration — over a
 * fake CollectivIQ adapter, so the assertions describe production wiring rather
 * than a re-implementation of it. No network, credential, or CollectivIQ call
 * occurs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { compileToolset, type CompiledToolset } from "../../src/tools/index.js";
import { createCompletionRuntime } from "../../src/generation/runtime.js";
import { instrumentAdapter } from "../../src/generation/adapter-telemetry.js";
import { isChatCompletionError } from "../../src/generation/chat-completion.js";
import {
  createMetrics,
  createNoopMetrics,
  type GatewayMetrics,
} from "../../src/observability/metrics.js";
import {
  createNoopTracing,
  createTracing,
  type GatewayTracing,
} from "../../src/observability/tracing.js";
import type { Telemetry } from "../../src/observability/telemetry.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import type { CapacityAcquisition } from "../../src/generation/types.js";
import type { NormalizedChatRequest } from "../../src/openai/chat-types.js";
import type {
  CollectivIQAdapter,
  GetMessagesResult,
  UpstreamMessage,
} from "../../src/collectiviq/types.js";

const MODEL_ID = "collectiviq-consensus";
const TOOL_MODEL_ID = "collectiviq-claude-tools";
const RUN_ID = "run-current";

/** A minimal synthetic tool, compiled through the real Phase 3 engine. */
function compileTestToolset(): CompiledToolset {
  const compiled = compileToolset([
    {
      name: "read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ]);
  if (!compiled.ok) throw new Error("test toolset must compile");
  return compiled.toolset;
}

/** A normalized emulated-tool request with a REQUIRED choice (no text fallback). */
function toolRequest(): NormalizedChatRequest {
  return {
    model: TOOL_MODEL_ID,
    messages: [{ role: "user", content: "read the file" }],
    ignoredParameters: [],
    stream: false,
    tools: [
      {
        name: "read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    toolChoice: { kind: "required" },
    parallelToolCalls: false,
  };
}

/** A valid §12.2 tool-call envelope for the synthetic `read` tool. */
function toolEnvelope(): string {
  return JSON.stringify({
    gateway_protocol: "1.0",
    type: "tool_calls",
    calls: [{ name: "read", arguments: { path: "notes.txt" } }],
  });
}

function model(over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: MODEL_ID,
    displayName: "Consensus",
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
    promptMode: "protocol",
    requestTimeoutMs: 5_000,
    pollIntervalMs: 1,
    maxPollIntervalMs: 1,
    maximumPromptBytes: 100_000,
    ...over,
  };
}

function makeConfig(models: readonly VirtualModel[]): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake",
    COLLECTIVIQ_GATEWAY_KEYS: ["gw-fake"],
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
    METRICS_ENABLED: true,
    TRACING_ENABLED: true,
    TRACING_SAMPLE_RATIO: 1,
    models,
  };
}

const REQUEST: NormalizedChatRequest = {
  model: MODEL_ID,
  messages: [{ role: "user", content: "hi" }],
  ignoredParameters: [],
  stream: false,
};

function answer(content: string): UpstreamMessage {
  return {
    id: "m1",
    source: "gpt",
    content,
    createdAt: 1,
    percentUsage: null,
    combinedRunId: RUN_ID,
  };
}

interface AdapterCalls {
  readonly created: number;
  readonly submitted: number;
  readonly polled: number;
}

/**
 * A fake adapter whose `get_messages` returns `emptyPolls` empty snapshots
 * before the answer, so the number of real poll attempts is deterministic.
 */
function fakeAdapter(opts: { emptyPolls: number; content?: string; failSubmit?: Error }): {
  adapter: CollectivIQAdapter;
  calls: () => AdapterCalls;
} {
  let created = 0;
  let submitted = 0;
  let polled = 0;
  const adapter: CollectivIQAdapter = {
    createThread: () => {
      created += 1;
      return Promise.resolve({ threadId: "t1", rawStatus: 200 });
    },
    processMessage: () => {
      submitted += 1;
      if (opts.failSubmit) return Promise.reject(opts.failSubmit);
      return Promise.resolve({ accepted: true, combinedRunId: RUN_ID, rawStatus: 202 });
    },
    getMessages: (): Promise<GetMessagesResult> => {
      polled += 1;
      const messages = polled > opts.emptyPolls ? [answer(opts.content ?? "the answer")] : [];
      return Promise.resolve({ messages, rawStatus: 200 });
    },
    getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
  };
  return { adapter, calls: () => ({ created, submitted, polled }) };
}

interface Harness {
  readonly telemetry: Telemetry;
  readonly metrics: GatewayMetrics;
  readonly tracing: GatewayTracing;
  readonly spans: () => readonly ReadableSpan[];
}

const openTracers: GatewayTracing[] = [];

function harness(models: readonly VirtualModel[]): Harness {
  const exporter = new InMemorySpanExporter();
  const metrics = createMetrics({ modelIds: models.map((m) => m.id) });
  const tracing = createTracing({
    otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
    sampleRatio: 1,
    environment: "development",
    modelIds: models.map((m) => m.id),
    exporter,
    useSimpleProcessor: true,
  });
  openTracers.push(tracing);
  return {
    telemetry: { metrics, tracing },
    metrics,
    tracing,
    spans: () => exporter.getFinishedSpans(),
  };
}

afterEach(async () => {
  while (openTracers.length > 0) {
    const tracing = openTracers.pop();
    if (tracing) await tracing.shutdown();
  }
});

/** The numeric value of one exposition sample line, or `undefined`. */
function sample(exposition: string, prefix: string): number | undefined {
  for (const line of exposition.split("\n")) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(line.lastIndexOf(" ") + 1);
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function spanNames(spans: readonly ReadableSpan[]): string[] {
  return spans.map((s) => s.name);
}

function findSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((s) => s.name === name);
  expect(found, `expected a ${name} span`).toBeDefined();
  return found as ReadableSpan;
}

describe("generation telemetry — a successful completion", () => {
  it("records upstream metrics per operation, including every individual poll", async () => {
    const models = [model()];
    const t = harness(models);
    const { adapter, calls } = fakeAdapter({ emptyPolls: 2 });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });

    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
    });
    const result = await runtime.chatService.run(prepared, new AbortController().signal);
    expect(result).toMatchObject({ kind: "text", content: "the answer" });
    expect(calls()).toEqual({ created: 1, submitted: 1, polled: 3 });

    const exposition = await t.metrics.collect();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_upstream_requests_total{operation="create_thread",outcome="success"}',
      ),
    ).toBe(1);
    expect(
      sample(
        exposition,
        'collectiviq_gateway_upstream_requests_total{operation="process_message",outcome="success"}',
      ),
    ).toBe(1);
    // Every individual `get_messages` is counted, which is the only place the
    // failed and successful poll attempts are both visible.
    expect(
      sample(
        exposition,
        'collectiviq_gateway_upstream_requests_total{operation="get_messages",outcome="success"}',
      ),
    ).toBe(3);
    expect(
      sample(
        exposition,
        'collectiviq_gateway_upstream_request_duration_seconds_count{operation="get_messages",outcome="success"}',
      ),
    ).toBe(3);
  });

  it("records the polling phase exactly once with the real attempt count", async () => {
    const models = [model()];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: 2 });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
    });
    await runtime.chatService.run(prepared, new AbortController().signal);

    const exposition = await t.metrics.collect();
    expect(sample(exposition, `collectiviq_gateway_poll_count{model="${MODEL_ID}"}`)).toBe(3);
    expect(
      sample(
        exposition,
        `collectiviq_gateway_poll_duration_seconds_count{model="${MODEL_ID}",outcome="answer"}`,
      ),
    ).toBe(1);
    // A successful completion is not a timeout.
    expect(exposition).not.toContain("collectiviq_gateway_timeouts_total{");
  });

  it("emits the specification §23.3 spans as children of the supplied request span", async () => {
    const models = [model()];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: 0 });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });

    const requestSpan = t.tracing.startSpan("gateway.request", {
      attributes: { endpoint: "/v1/chat/completions" },
    });
    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
      requestSpan,
    });
    await runtime.chatService.run(prepared, new AbortController().signal);
    requestSpan.end();

    const spans = t.spans();
    expect(spanNames(spans)).toEqual(
      expect.arrayContaining([
        "gateway.serialize",
        "collectiviq.create_thread",
        "collectiviq.process_message",
        "collectiviq.poll",
        "gateway.parse",
        "gateway.request",
      ]),
    );

    const root = findSpan(spans, "gateway.request");
    const rootSpanId = root.spanContext().spanId;
    for (const name of [
      "gateway.serialize",
      "collectiviq.create_thread",
      "collectiviq.process_message",
      "collectiviq.poll",
      "gateway.parse",
    ]) {
      const child = findSpan(spans, name);
      expect(child.parentSpanContext?.spanId, `${name} must be a child of gateway.request`).toBe(
        rootSpanId,
      );
      expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    }

    // Closed attributes only, with the configured model id.
    expect(findSpan(spans, "collectiviq.poll").attributes).toEqual({
      "collectiviq.model": MODEL_ID,
      "collectiviq.upstream_operation": "get_messages",
      "collectiviq.poll_outcome": "answer",
      "collectiviq.poll_count": 1,
    });
    expect(findSpan(spans, "gateway.serialize").attributes).toEqual({
      "collectiviq.model": MODEL_ID,
      "collectiviq.prompt_mode": "protocol",
      "collectiviq.tool_mode": "disabled",
    });
  });

  it("reports the live capacity snapshot through the pull-based gauges", async () => {
    const models = [model()];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: 0 });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });

    const idle = await t.metrics.collect();
    expect(sample(idle, "collectiviq_gateway_active_requests")).toBe(0);
    expect(sample(idle, "collectiviq_gateway_queued_requests")).toBe(0);

    // Hold two permits, then read the gauges while they are held.
    const permit = (keyId: string): Promise<CapacityAcquisition> =>
      runtime.capacity.acquire({
        keyId,
        capacityScopeId: null,
        requestTimeoutMs: 30_000,
        signal: new AbortController().signal,
      });
    const first = await permit("k0");
    const second = await permit("k1");
    expect(first.ok && second.ok).toBe(true);
    const busy = await t.metrics.collect();
    expect(sample(busy, "collectiviq_gateway_active_requests")).toBe(2);

    if (first.ok) first.permit.release();
    if (second.ok) second.permit.release();
    const drained = await t.metrics.collect();
    expect(sample(drained, "collectiviq_gateway_active_requests")).toBe(0);
  });
});

describe("generation telemetry — failure paths", () => {
  it("counts a completion timeout exactly once", async () => {
    const models = [model({ requestTimeoutMs: 1_000 })];
    const t = harness(models);
    // The answer never arrives, so the poller exhausts the deadline.
    const { adapter } = fakeAdapter({ emptyPolls: Number.MAX_SAFE_INTEGER });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
    });

    await expect(runtime.chatService.run(prepared, new AbortController().signal)).rejects.toSatisfy(
      (error: unknown) =>
        isChatCompletionError(error) && error.apiError.body.error.code === "completion_timeout",
    );

    const exposition = await t.metrics.collect();
    expect(sample(exposition, `collectiviq_gateway_timeouts_total{model="${MODEL_ID}"}`)).toBe(1);
    expect(
      sample(
        exposition,
        `collectiviq_gateway_poll_duration_seconds_count{model="${MODEL_ID}",outcome="timeout"}`,
      ),
    ).toBe(1);
  });

  it("labels a failed upstream submit as an error and still ends its span", async () => {
    const models = [model()];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: 0, failSubmit: new Error("boom") });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const requestSpan = t.tracing.startSpan("gateway.request");
    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
      requestSpan,
    });
    await expect(
      runtime.chatService.run(prepared, new AbortController().signal),
    ).rejects.toBeInstanceOf(Error);
    requestSpan.end();

    const exposition = await t.metrics.collect();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_upstream_requests_total{operation="process_message",outcome="error"}',
      ),
    ).toBe(1);
    // No poll ran, so the phase reports nothing at all.
    expect(exposition).not.toContain("collectiviq_gateway_poll_duration_seconds_count{");
    const submitSpan = findSpan(t.spans(), "collectiviq.process_message");
    expect(submitSpan.attributes).toEqual({
      "collectiviq.model": MODEL_ID,
      "collectiviq.upstream_operation": "process_message",
      "collectiviq.upstream_outcome": "error",
      // The precise envelope is decided later by the orchestrator, so the closed
      // fallback is recorded here rather than a guess.
      "collectiviq.error_category": "other",
    });
    // Specification §23.3: a failed span carries ERROR with NO status message.
    expect(submitSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(submitSpan.status.message).toBeUndefined();
  });

  it("marks a poll timeout as a failed span with the completion_timeout category", async () => {
    const models = [model({ requestTimeoutMs: 1_000 })];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: Number.MAX_SAFE_INTEGER });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const requestSpan = t.tracing.startSpan("gateway.request");
    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
      requestSpan,
    });
    await expect(
      runtime.chatService.run(prepared, new AbortController().signal),
    ).rejects.toBeInstanceOf(Error);
    requestSpan.end();

    const pollSpan = findSpan(t.spans(), "collectiviq.poll");
    expect(pollSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(pollSpan.status.message).toBeUndefined();
    // A deadline is the one upstream outcome whose public envelope is already
    // known where the span is closed.
    expect(pollSpan.attributes["collectiviq.error_category"]).toBe("completion_timeout");
    expect(pollSpan.attributes["collectiviq.poll_outcome"]).toBe("timeout");
  });

  it("marks an oversized prompt as a failed serialize span and ends it once", () => {
    const models = [model({ maximumPromptBytes: 1_024 })];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: 0 });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    expect(() =>
      runtime.chatService.prepare({
        request: { ...REQUEST, messages: [{ role: "user", content: "x".repeat(5_000) }] },
        model: models[0] as VirtualModel,
        keyId: "k0",
        signal: new AbortController().signal,
      }),
    ).toThrow();

    const serializeSpans = t.spans().filter((s) => s.name === "gateway.serialize");
    // Ended exactly once, despite the throw.
    expect(serializeSpans).toHaveLength(1);
    const serializeSpan = serializeSpans[0] as ReadableSpan;
    expect(serializeSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(serializeSpan.status.message).toBeUndefined();
    expect(serializeSpan.attributes["collectiviq.error_category"]).toBe("context_length_exceeded");
  });

  it("marks a required-choice parse failure as a failed span and counts it once", async () => {
    const models = [
      model({
        id: TOOL_MODEL_ID,
        toolMode: "emulated",
        promptMode: "protocol",
      }),
    ];
    const t = harness(models);
    // The upstream answers with ordinary prose, so a REQUIRED tool choice finds
    // no valid call and the completion fails with `invalid_tool_response`.
    const { adapter } = fakeAdapter({ emptyPolls: 0, content: "just prose, no envelope" });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const requestSpan = t.tracing.startSpan("gateway.request");
    const prepared = runtime.chatService.prepare({
      request: toolRequest(),
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
      toolset: compileTestToolset(),
      requestSpan,
    });
    await expect(runtime.chatService.run(prepared, new AbortController().signal)).rejects.toSatisfy(
      (error: unknown) =>
        isChatCompletionError(error) && error.apiError.body.error.code === "invalid_tool_response",
    );
    requestSpan.end();

    const exposition = await t.metrics.collect();
    expect(
      sample(exposition, `collectiviq_gateway_tool_parse_failures_total{model="${TOOL_MODEL_ID}"}`),
    ).toBe(1);
    const parseSpans = t.spans().filter((s) => s.name === "gateway.parse");
    // Ended exactly once: the failure path leaves the span through a `catch`
    // that also has to not re-end it, which finding "the first one" cannot show.
    expect(parseSpans).toHaveLength(1);
    const parseSpan = parseSpans[0] as ReadableSpan;
    expect(parseSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(parseSpan.status.message).toBeUndefined();
    expect(parseSpan.attributes["collectiviq.error_category"]).toBe("invalid_tool_response");
  });

  it("counts an emulated tool-call success through the real generation wiring", async () => {
    const models = [
      model({
        id: TOOL_MODEL_ID,
        toolMode: "emulated",
        promptMode: "protocol",
      }),
    ];
    const t = harness(models);
    const { adapter } = fakeAdapter({ emptyPolls: 0, content: toolEnvelope() });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const requestSpan = t.tracing.startSpan("gateway.request");
    const prepared = runtime.chatService.prepare({
      request: toolRequest(),
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
      toolset: compileTestToolset(),
      requestSpan,
    });
    const result = await runtime.chatService.run(prepared, new AbortController().signal);
    requestSpan.end();
    expect(result.kind).toBe("tool_calls");

    const exposition = await t.metrics.collect();
    expect(
      sample(
        exposition,
        `collectiviq_gateway_tool_responses_total{model="${TOOL_MODEL_ID}",tool_mode="emulated",parser_source="desired-source"}`,
      ),
    ).toBe(1);
    // A successful parse is not a failed span.
    const parseSpan = findSpan(t.spans(), "gateway.parse");
    expect(parseSpan.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(parseSpan.attributes["collectiviq.parser_source"]).toBe("desired-source");
    expect(parseSpan.attributes["collectiviq.tool_call_count"]).toBe(1);
  });
});

describe("generation telemetry — privacy and disabled behaviour", () => {
  it("keeps prompts, answers, thread ids, and credentials out of metrics and spans", async () => {
    const models = [model()];
    const t = harness(models);
    const { adapter } = fakeAdapter({
      emptyPolls: 0,
      content: "ANSWER-SENTINEL-9f2a and a path /etc/passwd",
    });
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: t.telemetry,
    });
    const requestSpan = t.tracing.startSpan("gateway.request");
    const prepared = runtime.chatService.prepare({
      request: {
        ...REQUEST,
        messages: [{ role: "user", content: "PROMPT-SENTINEL-4c81 sk-secret-sentinel" }],
      },
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
      requestSpan,
    });
    await runtime.chatService.run(prepared, new AbortController().signal);
    requestSpan.end();

    const sentinels = [
      "PROMPT-SENTINEL-4c81",
      "ANSWER-SENTINEL-9f2a",
      "sk-secret-sentinel",
      "/etc/passwd",
      "t1",
      "run-current",
      "k0",
    ];
    const exposition = await t.metrics.collect();
    const serializedSpans = JSON.stringify(
      t.spans().map((s) => ({ name: s.name, attributes: s.attributes, status: s.status })),
    );
    for (const sentinel of sentinels) {
      expect(exposition, `metrics must not contain ${sentinel}`).not.toContain(sentinel);
      expect(serializedSpans, `spans must not contain ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("returns the adapter untouched and records nothing when metrics are disabled", async () => {
    const metrics = createNoopMetrics();
    const { adapter, calls } = fakeAdapter({ emptyPolls: 0 });
    // No decoration at all: the disabled path adds no wrapper, no timing, and
    // no indirection to the upstream boundary.
    expect(instrumentAdapter(adapter, metrics)).toBe(adapter);

    const models = [model()];
    const runtime = createCompletionRuntime(makeConfig(models), {
      adapter,
      telemetry: { metrics, tracing: createNoopTracing() },
    });
    const prepared = runtime.chatService.prepare({
      request: REQUEST,
      model: models[0] as VirtualModel,
      keyId: "k0",
      signal: new AbortController().signal,
    });
    await runtime.chatService.run(prepared, new AbortController().signal);

    expect(calls()).toEqual({ created: 1, submitted: 1, polled: 1 });
    expect(await metrics.collect()).toBe("");
  });
});
