/**
 * API-lifecycle observability (specification sections 8.1, 23.2, 23.3).
 *
 * Covers the `/metrics` endpoint's existence rules, exactly-once request
 * settlement on both transports, closed error categories, replay accounting,
 * client cancellation, the stream gauge, span parentage, and the guarantee that
 * no content, credential, or identifier reaches telemetry. Everything runs
 * in-process against fakes: no network, credential, or CollectivIQ call.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { createCompletionRuntime } from "../../src/generation/runtime.js";
import {
  createIdempotencyCoordinator,
  deriveIdempotencyKeyring,
} from "../../src/idempotency/index.js";
import { createFakeIdempotencyStore } from "../support/fake-idempotency-store.js";
import type { CollectivIQAdapter } from "../../src/collectiviq/types.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import { register as globalPromRegistry } from "@prometheus-io/client";
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
import type { TitleBridge } from "../../src/opencode/title-bridge.js";
import {
  GATEWAY_CAPACITY_EXCEEDED_ERROR,
  IDEMPOTENCY_UNAVAILABLE_ERROR,
  THREAD_REUSE_UNAVAILABLE_ERROR,
} from "../../src/openai/errors.js";
import { createMetrics, type GatewayMetrics } from "../../src/observability/metrics.js";
import {
  createNoopTracing,
  createTracing,
  type GatewayTracing,
} from "../../src/observability/tracing.js";
import type { Telemetry } from "../../src/observability/telemetry.js";
import type { RateLimiter } from "../../src/rate-limit/index.js";
import { createFakeRateLimiter } from "../support/fake-rate-limiter.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-fake-key";
const MODEL_ID = "collectiviq-consensus";
const REUSE_MODEL_ID = "collectiviq-claude-direct";
const TOOL_MODEL_ID = "collectiviq-claude-tools";

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

const MODELS: readonly VirtualModel[] = [
  model(MODEL_ID),
  model(REUSE_MODEL_ID, { promptMode: "direct" }),
];

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
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    METRICS_ENABLED: true,
    TRACING_ENABLED: false,
    TRACING_SAMPLE_RATIO: 1,
    models: MODELS,
    ...over,
  };
}

type RunFn = (prepared: PreparedCompletion, signal: AbortSignal) => Promise<CompletionResult>;

function fakeService(run: RunFn): ChatCompletionService {
  return {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => ({
      id: "chatcmpl_ciq_obs",
      created: 1_785_933_840,
      model: ctx.request.model,
      prompt: "PROMPT",
      policy: ctx.model,
      selectedLlms: ctx.model.selectedLlms,
      keyId: ctx.keyId,
      ...(ctx.requestSpan !== undefined ? { requestSpan: ctx.requestSpan } : {}),
    }),
    run,
  };
}

const noopTitleBridge: TitleBridge = {
  register: () => {},
  lookup: () => Promise.resolve({ kind: "unavailable" }),
};

const textResult: CompletionResult = {
  kind: "text",
  content: "hello",
  upstreamThreadId: "thread-obs",
  upstreamThreadCreated: true,
};

interface Harness {
  readonly app: GatewayServer;
  readonly metrics: GatewayMetrics;
  readonly tracing: GatewayTracing;
  readonly spans: () => readonly ReadableSpan[];
  readonly exposition: () => Promise<string>;
}

let active: Harness | undefined;

afterEach(async () => {
  if (active) {
    await active.app.close();
    await active.tracing.shutdown();
  }
  active = undefined;
});

function build(
  options: {
    readonly run?: RunFn;
    readonly config?: Partial<AppConfig>;
    readonly tracingEnabled?: boolean;
    readonly rateLimiter?: RateLimiter;
    readonly shutdownSignal?: AbortSignal;
  } = {},
): Harness {
  const config = makeConfig(options.config);
  const metrics = createMetrics({ modelIds: MODELS.map((m) => m.id) });
  const exporter = new InMemorySpanExporter();
  const tracing =
    options.tracingEnabled === true
      ? createTracing({
          otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
          sampleRatio: 1,
          environment: "development",
          modelIds: MODELS.map((m) => m.id),
          exporter,
          useSimpleProcessor: true,
        })
      : createNoopTracing();
  const telemetry: Telemetry = { metrics, tracing };
  const app = buildServer({
    config,
    readiness: createReadinessState(true),
    telemetry,
    completion: {
      chatService: fakeService(options.run ?? (() => Promise.resolve(textResult))),
      titleBridge: noopTitleBridge,
      shutdownSignal: options.shutdownSignal ?? new AbortController().signal,
    },
    ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
  });
  const harness: Harness = {
    app,
    metrics,
    tracing,
    spans: () => exporter.getFinishedSpans(),
    exposition: () => metrics.collect(),
  };
  active = harness;
  return harness;
}

const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/chat/completions";
const jsonBody = { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] };
const streamBody = { ...jsonBody, stream: true };

/** The numeric value of one exposition sample line, or `undefined`. */
function sample(exposition: string, prefix: string): number | undefined {
  for (const line of exposition.split("\n")) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(prefix)) continue;
    const parsed = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

describe("GET /metrics", () => {
  it("does not exist when METRICS_ENABLED is false", async () => {
    const h = build({ config: { METRICS_ENABLED: false } });
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
  });

  it("serves the Prometheus exposition with the registry content type and no credential", async () => {
    const h = build();
    // Deliberately NO Authorization header: the endpoint carries no application
    // authentication and must be isolated at the network layer instead.
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(h.metrics.contentType);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("# TYPE collectiviq_gateway_requests_total counter");
  });

  it("ignores a gateway credential entirely (the endpoint is not authenticated)", async () => {
    const h = build();
    const withKey = await h.app.inject({ method: "GET", url: "/metrics", headers: auth });
    const withBadKey = await h.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer nope" },
    });
    expect(withKey.statusCode).toBe(200);
    expect(withBadKey.statusCode).toBe(200);
  });

  it("registers nothing on the Prometheus client's global default registry", async () => {
    const h = build();
    await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    const globalExposition = await globalPromRegistry.metrics();
    expect(globalExposition).not.toContain("collectiviq_gateway_");
  });
});

describe("request settlement", () => {
  it("settles a JSON completion exactly once with its endpoint, status, model, and transport", async () => {
    const h = build();
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(res.statusCode).toBe(200);

    const exposition = await h.exposition();
    const labels = `{endpoint="/v1/chat/completions",status_family="2xx",model="${MODEL_ID}",transport="json"}`;
    expect(sample(exposition, `collectiviq_gateway_requests_total${labels}`)).toBe(1);
    expect(sample(exposition, `collectiviq_gateway_request_duration_seconds_count${labels}`)).toBe(
      1,
    );
    // A successful request contributes no error series at all.
    expect(exposition).not.toContain("collectiviq_gateway_errors_total{");
  });

  it("settles a hijacked SSE completion exactly once, as the sse transport", async () => {
    const h = build();
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("data: [DONE]");

    const exposition = await h.exposition();
    const labels = `{endpoint="/v1/chat/completions",status_family="2xx",model="${MODEL_ID}",transport="sse"}`;
    expect(sample(exposition, `collectiviq_gateway_requests_total${labels}`)).toBe(1);
    expect(sample(exposition, `collectiviq_gateway_request_duration_seconds_count${labels}`)).toBe(
      1,
    );
    // Exactly one settlement in total, on exactly one transport.
    expect(
      sample(
        exposition,
        `collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="2xx",model="${MODEL_ID}",transport="json"}`,
      ),
    ).toBeUndefined();
  });

  it("settles unauthenticated and health requests under their own closed endpoints", async () => {
    const h = build();
    await h.app.inject({ method: "GET", url: "/healthz" });
    await h.app.inject({ method: "POST", url, payload: jsonBody });

    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_requests_total{endpoint="/healthz",status_family="2xx",model="none",transport="json"}',
      ),
    ).toBe(1);
    expect(
      sample(
        exposition,
        'collectiviq_gateway_errors_total{endpoint="/v1/chat/completions",error_category="invalid_api_key"}',
      ),
    ).toBe(1);
  });

  // The DELIVERED-stream counterpart lives in the real-runtime block below,
  // which can actually produce a successful stream.
  it("settles a post-header stream failure as a 2xx request that still counts one error", async () => {
    // The whole contract in one place, because the parts are only meaningful
    // together: once the SSE header is committed the status line reads `200`
    // FOREVER, so the failure has to be visible through `errors_total` and the
    // span rather than through the status family. Asserting the pieces in
    // separate tests would let the pair drift into "2xx and no error recorded".
    const h = build({
      tracingEnabled: true,
      run: () => Promise.reject(new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR)),
    });
    const failed = await h.app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toContain("gateway_capacity_exceeded");

    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        `collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="2xx",model="${MODEL_ID}",transport="sse"}`,
      ),
    ).toBe(1);
    // Exactly one error, under the closed category the envelope carried — not
    // the `other` fallback a missed call site would produce.
    expect(
      sample(
        exposition,
        'collectiviq_gateway_errors_total{endpoint="/v1/chat/completions",error_category="gateway_capacity_exceeded"}',
      ),
    ).toBe(1);
    expect(exposition.match(/^collectiviq_gateway_errors_total\{/gm)).toHaveLength(1);
    // A post-header failure still ends the stream, so the gauge must return to 0.
    expect(sample(exposition, "collectiviq_gateway_stream_connections")).toBe(0);

    const spans = h.spans();
    const streamSpans = spans.filter((s) => s.name === "gateway.stream");
    // Ended exactly once, even though the failure path also runs the `finally`.
    expect(streamSpans).toHaveLength(1);
    const stream = streamSpans[0] as ReadableSpan;
    expect(stream.attributes).toMatchObject({
      "collectiviq.transport": "sse",
      "collectiviq.model": MODEL_ID,
      "collectiviq.error_category": "gateway_capacity_exceeded",
    });
    // Specification §23.3: ERROR status, and NO status message.
    expect(stream.status.code).toBe(SpanStatusCode.ERROR);
    expect(stream.status.message).toBeUndefined();

    const root = spans.find((s) => s.name === "gateway.request");
    expect(root).toBeDefined();
    expect(root?.attributes["collectiviq.error_category"]).toBe("gateway_capacity_exceeded");
    expect(root?.attributes["collectiviq.transport"]).toBe("sse");
    // The status line was already `200` when the failure happened, which is the
    // documented consequence of a post-header SSE failure.
    expect(root?.attributes["collectiviq.status_family"]).toBe("2xx");
  });
});

describe("closed error categories", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly run: RunFn;
    readonly category: string;
    readonly statusFamily: string;
  }> = [
    {
      name: "process-local capacity",
      run: () => Promise.reject(new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR)),
      category: "gateway_capacity_exceeded",
      statusFamily: "4xx",
    },
    {
      name: "idempotency",
      run: () => Promise.reject(new ChatCompletionError(IDEMPOTENCY_UNAVAILABLE_ERROR)),
      category: "idempotency_unavailable",
      statusFamily: "5xx",
    },
    {
      name: "thread reuse",
      run: () => Promise.reject(new ChatCompletionError(THREAD_REUSE_UNAVAILABLE_ERROR)),
      category: "thread_reuse_unavailable",
      statusFamily: "5xx",
    },
  ];

  for (const testCase of cases) {
    it(`distinguishes a ${testCase.name} failure`, async () => {
      const h = build({ run: testCase.run });
      await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
      const exposition = await h.exposition();
      expect(
        sample(
          exposition,
          `collectiviq_gateway_errors_total{endpoint="/v1/chat/completions",error_category="${testCase.category}"}`,
        ),
      ).toBe(1);
      expect(
        sample(
          exposition,
          `collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="${testCase.statusFamily}",model="${MODEL_ID}",transport="json"}`,
        ),
      ).toBe(1);
    });
  }

  it("distinguishes a cross-replica rate-limit rejection", async () => {
    const limiter = createFakeRateLimiter();
    limiter.always({ kind: "limited", retryAfterSeconds: 3 });
    const h = build({
      rateLimiter: limiter,
      config: {
        RATE_LIMIT_ENABLED: true,
        // The scope deriver is pure HKDF over these two values; no Redis client
        // is created by `buildServer`.
        REDIS_URL: "redis://127.0.0.1:6379",
        IDEMPOTENCY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(res.statusCode).toBe(429);
    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_errors_total{endpoint="/v1/chat/completions",error_category="gateway_rate_limit_exceeded"}',
      ),
    ).toBe(1);
  });

  it("records a shutdown cancellation as service_unavailable without a client cancellation", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const h = build({
      shutdownSignal: shutdown.signal,
      run: () => Promise.reject(new RequestCancelledError()),
    });
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(res.statusCode).toBe(503);
    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_errors_total{endpoint="/v1/chat/completions",error_category="service_unavailable"}',
      ),
    ).toBe(1);
    // The client never went away, so nothing is counted as a cancellation.
    expect(exposition).not.toContain("collectiviq_gateway_client_cancellations_total{");
  });

  it("categorises a model-metadata 404 without ever reflecting the submitted id", async () => {
    const h = build();
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/models/NOT-A-REAL-MODEL-SENTINEL",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_errors_total{endpoint="/v1/models/:model",error_category="model_not_found"}',
      ),
    ).toBe(1);
    expect(exposition).not.toContain("NOT-A-REAL-MODEL-SENTINEL");
  });
});

describe("upstream accounting", () => {
  it("counts a completion as a gateway request without inventing upstream work", async () => {
    // The injected service performs no upstream call at all, which is exactly
    // the shape of an idempotent replay: the request is still settled, but no
    // upstream counter may move.
    const h = build();
    await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        `collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="2xx",model="${MODEL_ID}",transport="json"}`,
      ),
    ).toBe(1);
    expect(exposition).not.toContain("collectiviq_gateway_upstream_requests_total{");
    expect(exposition).not.toContain("collectiviq_gateway_poll_count{");
  });
});

describe("tracing at the API lifecycle", () => {
  // `gateway.serialize` belongs to the generation layer, which this harness
  // fakes out; its parentage is asserted in `test/unit/generation-telemetry.test.ts`.
  it("parents the validate and encode spans under gateway.request", async () => {
    const h = build({ tracingEnabled: true });
    await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });

    const spans = h.spans();
    const names = spans.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["gateway.validate", "gateway.encode", "gateway.request"]),
    );

    const root = spans.find((s) => s.name === "gateway.request");
    expect(root).toBeDefined();
    const rootId = root?.spanContext().spanId;
    for (const name of ["gateway.validate", "gateway.encode"]) {
      const child = spans.find((s) => s.name === name);
      expect(child?.parentSpanContext?.spanId, `${name} parent`).toBe(rootId);
    }
    expect(root?.attributes).toEqual({
      "collectiviq.endpoint": "/v1/chat/completions",
      "collectiviq.status_family": "2xx",
      "collectiviq.transport": "json",
      "collectiviq.model": MODEL_ID,
      "collectiviq.tool_mode": "disabled",
    });
  });

  // The `gateway.stream` failure span is asserted alongside the metric
  // settlement it has to agree with, in "request settlement" above.
});

describe("client cancellation over a real socket", () => {
  /** Resolve when `predicate` holds, or fail fast; never hangs the suite. */
  async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - start > 5_000) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Start a completion whose `run` only settles when the request is aborted. */
  function hangingHarness(tracingEnabled = false): {
    readonly harness: Harness;
    readonly started: () => boolean;
  } {
    let begun = false;
    const harness = build({
      tracingEnabled,
      run: (_prepared, signal) =>
        new Promise<CompletionResult>((_resolve, reject) => {
          begun = true;
          signal.addEventListener("abort", () => reject(new RequestCancelledError()), {
            once: true,
          });
        }),
    });
    return { harness, started: () => begun };
  }

  async function post(h: Harness, payload: unknown): Promise<http.ClientRequest> {
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: url,
      headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
    });
    // An ECONNRESET after `destroy()` is the point of the test, not a failure.
    req.on("error", () => {});
    req.write(JSON.stringify(payload));
    req.end();
    return req;
  }

  it("records exactly one JSON cancellation and settles the request once", async () => {
    const { harness: h, started } = hangingHarness();
    const req = await post(h, jsonBody);
    await waitFor(started);
    req.destroy();

    await waitFor(async () =>
      (await h.exposition()).includes("collectiviq_gateway_client_cancellations_total{"),
    );
    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_client_cancellations_total{endpoint="/v1/chat/completions",transport="json"}',
      ),
    ).toBe(1);
    // Exactly one settlement, asserted on the counter VALUE and not merely on
    // the number of rendered lines: a request settled twice with identical
    // labels renders as one line with the value `2`, so a line count would not
    // catch the `finish`/`close` race this test exists to pin down.
    const settlements = exposition
      .split("\n")
      .filter((line) => line.startsWith("collectiviq_gateway_requests_total{"));
    expect(settlements).toHaveLength(1);
    expect(
      sample(
        exposition,
        'collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="2xx",model="collectiviq-consensus",transport="json"}',
      ),
    ).toBe(1);
  }, 15_000);

  it("closes the stream gauge and records one sse cancellation on a mid-stream disconnect", async () => {
    const { harness: h, started } = hangingHarness();
    const req = await post(h, streamBody);
    await waitFor(started);
    // The role opener is already written, so the gauge is open.
    expect(sample(await h.exposition(), "collectiviq_gateway_stream_connections")).toBe(1);
    req.destroy();

    await waitFor(async () =>
      (await h.exposition()).includes("collectiviq_gateway_client_cancellations_total{"),
    );
    const exposition = await h.exposition();
    expect(
      sample(
        exposition,
        'collectiviq_gateway_client_cancellations_total{endpoint="/v1/chat/completions",transport="sse"}',
      ),
    ).toBe(1);
    expect(sample(exposition, "collectiviq_gateway_stream_connections")).toBe(0);
    // The disconnect must settle the request exactly once, asserted on the
    // counter VALUE: the SSE path settles from the raw `close`, so a regression
    // in the one-shot guard would double it under identical labels.
    expect(
      sample(
        exposition,
        'collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="2xx",model="collectiviq-consensus",transport="sse"}',
      ),
    ).toBe(1);
  }, 15_000);

  /**
   * A cancelled request keeps its `200` status line — on the streamed path the
   * header is committed long before the body — so nothing about the status tells
   * a reader the request failed. The root span must therefore say so itself.
   */
  for (const transport of ["json", "sse"] as const) {
    it(`marks the ${transport} root span ERROR when the client disconnects`, async () => {
      const { harness: h, started } = hangingHarness(true);
      const req = await post(h, transport === "sse" ? streamBody : jsonBody);
      await waitFor(started);
      req.destroy();

      await waitFor(() => h.spans().some((s) => s.name === "gateway.request"));
      const requestSpans = h.spans().filter((s) => s.name === "gateway.request");
      // Exported and ended exactly once.
      expect(requestSpans).toHaveLength(1);
      const root = requestSpans[0] as ReadableSpan;
      expect(root.status.code).toBe(SpanStatusCode.ERROR);
      // Specification §23.3: a failed span carries no status message.
      expect(root.status.message).toBeUndefined();
      // No public envelope exists for a disconnect, so the closed fallback.
      expect(root.attributes["collectiviq.error_category"]).toBe("other");
      expect(root.attributes["collectiviq.transport"]).toBe(transport);

      const exposition = await h.exposition();
      expect(
        sample(
          exposition,
          `collectiviq_gateway_client_cancellations_total{endpoint="/v1/chat/completions",transport="${transport}"}`,
        ),
      ).toBe(1);
      expect(
        sample(
          exposition,
          `collectiviq_gateway_requests_total{endpoint="/v1/chat/completions",status_family="2xx",model="collectiviq-consensus",transport="${transport}"}`,
        ),
      ).toBe(1);
      // A disconnect is NOT a gateway error: it is already counted as a
      // cancellation, so `errors_total` must stay untouched.
      expect(exposition).not.toContain("collectiviq_gateway_errors_total{");
      if (transport === "sse") {
        expect(sample(exposition, "collectiviq_gateway_stream_connections")).toBe(0);
      }
    }, 15_000);
  }

  it("keeps a normally completed request's root span successful", async () => {
    // The counterpart to the two cases above: `finish` must not be mistaken for
    // a disconnect, or every request would report ERROR.
    const h = build({ tracingEnabled: true });
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(res.statusCode).toBe(200);
    const root = h.spans().find((s) => s.name === "gateway.request");
    // Asserted BEFORE the negative checks below: both of those would pass
    // vacuously on an `undefined` span, which is exactly the failure this test
    // is meant to catch.
    expect(root).toBeDefined();
    expect(root?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(root?.attributes["collectiviq.error_category"]).toBeUndefined();
  });
});

describe("wiring over the real completion runtime", () => {
  const MASTER_KEY = randomBytes(32).toString("base64url");

  interface RealHarness {
    readonly app: GatewayServer;
    readonly metrics: GatewayMetrics;
    readonly tracing: GatewayTracing;
    readonly spans: () => readonly ReadableSpan[];
    readonly exposition: () => Promise<string>;
    readonly upstream: () => { created: number; submitted: number; polled: number };
  }

  /**
   * The REAL completion runtime (real orchestration, poller, capacity, adapter
   * decorator) over a fake CollectivIQ adapter, optionally with a real
   * idempotency coordinator over the shared in-memory fake store.
   */
  function buildReal(
    options: { readonly withIdempotency?: boolean; readonly tracingEnabled?: boolean } = {},
  ): RealHarness {
    const models: readonly VirtualModel[] = [
      model(MODEL_ID, { pollIntervalMs: 1, maxPollIntervalMs: 1, requestTimeoutMs: 5_000 }),
    ];
    const config = makeConfig({
      models,
      ...(options.withIdempotency === true
        ? { REDIS_URL: "redis://127.0.0.1:6379", IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY }
        : {}),
    });
    const metrics = createMetrics({ modelIds: models.map((m) => m.id) });
    const exporter = new InMemorySpanExporter();
    const tracing =
      options.tracingEnabled === true
        ? createTracing({
            otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
            sampleRatio: 1,
            environment: "development",
            modelIds: models.map((m) => m.id),
            exporter,
            useSimpleProcessor: true,
          })
        : createNoopTracing();
    const telemetry: Telemetry = { metrics, tracing };

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
        return Promise.resolve({ accepted: true, combinedRunId: "run-1", rawStatus: 202 });
      },
      getMessages: () => {
        polled += 1;
        return Promise.resolve({
          messages: [
            {
              id: "m1",
              source: "gpt",
              content: "hello",
              createdAt: 1,
              percentUsage: null,
              combinedRunId: "run-1",
            },
          ],
          rawStatus: 200,
        });
      },
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };

    const runtime = createCompletionRuntime(config, { adapter, telemetry });
    const nowMs = 1_700_000_000_000;
    const coordinator = createIdempotencyCoordinator({
      store: createFakeIdempotencyStore({ nowMs: () => nowMs }),
      keyring: deriveIdempotencyKeyring(MASTER_KEY),
      namespace: "test-ns",
      ttlMs: 600_000,
      clock: { nowMs: () => nowMs },
      sleeper: { sleep: () => Promise.resolve() },
      random: () => 0,
      scheduleRenewal: () => ({ cancel: () => undefined }),
    });

    const app = buildServer({
      config,
      readiness: createReadinessState(true),
      telemetry,
      completion: {
        chatService: runtime.chatService,
        titleBridge: noopTitleBridge,
        shutdownSignal: new AbortController().signal,
      },
      ...(options.withIdempotency === true ? { idempotency: coordinator } : {}),
    });

    const harness: RealHarness = {
      app,
      metrics,
      tracing,
      spans: () => exporter.getFinishedSpans(),
      exposition: () => metrics.collect(),
      upstream: () => ({ created, submitted, polled }),
    };
    active = harness;
    return harness;
  }

  it("counts an idempotent replay as a request without repeating upstream work", async () => {
    const h = buildReal({ withIdempotency: true });
    const keyed = { ...auth, "idempotency-key": "replay-key-1" };

    const first = await h.app.inject({ method: "POST", url, headers: keyed, payload: jsonBody });
    expect(first.statusCode).toBe(200);
    const afterFirst = await h.exposition();
    const upstreamAfterFirst = h.upstream();
    expect(upstreamAfterFirst.created).toBe(1);

    // Same key, same body: served from the cached completion.
    const replay = await h.app.inject({ method: "POST", url, headers: keyed, payload: jsonBody });
    expect(replay.statusCode).toBe(200);
    // Proof it really was a replay: identical completion id, and no new
    // upstream call of any kind.
    expect(replay.json()).toEqual(first.json());
    expect(h.upstream()).toEqual(upstreamAfterFirst);

    const afterReplay = await h.exposition();
    const requestLabels = `{endpoint="/v1/chat/completions",status_family="2xx",model="${MODEL_ID}",transport="json"}`;
    expect(sample(afterFirst, `collectiviq_gateway_requests_total${requestLabels}`)).toBe(1);
    // The gateway request is counted again...
    expect(sample(afterReplay, `collectiviq_gateway_requests_total${requestLabels}`)).toBe(2);
    // ...while every upstream and poll metric stands still.
    for (const metric of [
      'collectiviq_gateway_upstream_requests_total{operation="create_thread",outcome="success"}',
      'collectiviq_gateway_upstream_requests_total{operation="process_message",outcome="success"}',
      'collectiviq_gateway_upstream_requests_total{operation="get_messages",outcome="success"}',
      `collectiviq_gateway_poll_count{model="${MODEL_ID}"}`,
      `collectiviq_gateway_poll_duration_seconds_count{model="${MODEL_ID}",outcome="answer"}`,
    ]) {
      expect(sample(afterReplay, metric), metric).toBe(sample(afterFirst, metric));
    }
  });

  it("returns the stream gauge to zero after a SUCCESSFUL stream", async () => {
    const h = buildReal();
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("data: [DONE]");
    expect(sample(await h.exposition(), "collectiviq_gateway_stream_connections")).toBe(0);
  });

  it("nests a successful SSE encode under gateway.stream under gateway.request", async () => {
    const h = buildReal({ tracingEnabled: true });
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.body).toContain("data: [DONE]");

    const spans = h.spans();
    const request = spans.find((s) => s.name === "gateway.request");
    const stream = spans.find((s) => s.name === "gateway.stream");
    const encode = spans.find((s) => s.name === "gateway.encode");
    expect(request).toBeDefined();
    expect(stream).toBeDefined();
    expect(encode).toBeDefined();
    expect(stream?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(encode?.parentSpanContext?.spanId).toBe(stream?.spanContext().spanId);
    expect(encode?.spanContext().traceId).toBe(request?.spanContext().traceId);
    // A delivered stream is not a failed span.
    expect(stream?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("counts a request-boundary tool-schema rejection", async () => {
    const h = buildReal();
    // A `tools` entry that is not an object cannot be bounded or compiled, so the
    // request is rejected with `param: "tools"` before any upstream work.
    const res = await h.app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { ...jsonBody, tools: "not-an-array" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { param: "tools" } });

    const exposition = await h.exposition();
    expect(sample(exposition, 'collectiviq_gateway_tool_schema_failures_total{model="none"}')).toBe(
      1,
    );
    expect(h.upstream()).toEqual({ created: 0, submitted: 0, polled: 0 });
  });
});

describe("disabled telemetry does no telemetry work", () => {
  /**
   * Ports that report `enabled: false`, RECORD every call, and then throw.
   *
   * Recording matters as much as throwing. Some call sites run in a `finally`
   * AFTER the response has already been ended — `streamClosed` is the clearest
   * case — so a throw there changes neither the status nor the body, and a
   * response-only assertion would miss it. Every case below therefore asserts
   * the recorded list is EMPTY, which catches a call wherever it happens.
   */
  function recordingPorts(): { readonly telemetry: Telemetry; readonly calls: string[] } {
    const calls: string[] = [];
    const boom = (name: string) => (): never => {
      calls.push(name);
      throw new Error(`telemetry method called while disabled: ${name}`);
    };
    const metrics: GatewayMetrics = {
      enabled: false,
      contentType: "",
      bindCapacitySource: boom("bindCapacitySource"),
      observeRequest: boom("observeRequest"),
      observeClientCancellation: boom("observeClientCancellation"),
      observeUpstreamRequest: boom("observeUpstreamRequest"),
      observePollPhase: boom("observePollPhase"),
      observeTimeout: boom("observeTimeout"),
      observeToolResponse: boom("observeToolResponse"),
      observeToolParseFailure: boom("observeToolParseFailure"),
      observeToolSchemaFailure: boom("observeToolSchemaFailure"),
      streamOpened: boom("streamOpened"),
      streamClosed: boom("streamClosed"),
      collect: boom("collect"),
    };
    const tracing: GatewayTracing = {
      enabled: false,
      startSpan: boom("startSpan"),
      shutdown: boom("shutdown"),
    };
    return { telemetry: { metrics, tracing }, calls };
  }

  interface DisabledHarness {
    readonly app: GatewayServer;
    readonly calls: readonly string[];
  }

  /** `upstream: "fail"` rejects the submit; `"stall"` never yields an answer. */
  function buildDisabled(
    options: { readonly upstream?: "ok" | "fail" | "stall"; readonly toolModel?: boolean } = {},
  ): DisabledHarness {
    const models: readonly VirtualModel[] = [
      model(MODEL_ID, {
        pollIntervalMs: 1,
        maxPollIntervalMs: 1,
        requestTimeoutMs: options.upstream === "stall" ? 1_000 : 5_000,
      }),
      ...(options.toolModel === true
        ? [
            model(TOOL_MODEL_ID, {
              toolMode: "emulated" as const,
              promptMode: "protocol" as const,
              pollIntervalMs: 1,
              maxPollIntervalMs: 1,
            }),
          ]
        : []),
    ];
    const config = makeConfig({ models, METRICS_ENABLED: false, TRACING_ENABLED: false });
    const adapter: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: "t1", rawStatus: 200 }),
      processMessage: () =>
        options.upstream === "fail"
          ? Promise.reject(new UpstreamError("network"))
          : Promise.resolve({ accepted: true, combinedRunId: "run-1", rawStatus: 202 }),
      getMessages: () =>
        Promise.resolve({
          messages:
            options.upstream === "stall"
              ? []
              : [
                  {
                    id: "m1",
                    source: "gpt",
                    content: "hello",
                    createdAt: 1,
                    percentUsage: null,
                    combinedRunId: "run-1",
                  },
                ],
          rawStatus: 200,
        }),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const { telemetry, calls } = recordingPorts();
    // The runtime binds the capacity source and decorates the adapter here; both
    // must be skipped, or construction alone would record a call.
    const runtime = createCompletionRuntime(config, { adapter, telemetry });
    const app = buildServer({
      config,
      readiness: createReadinessState(true),
      telemetry,
      completion: {
        chatService: runtime.chatService,
        titleBridge: noopTitleBridge,
        shutdownSignal: new AbortController().signal,
      },
    });
    return { app, calls };
  }

  let disabled: GatewayServer | undefined;
  afterEach(async () => {
    if (disabled) await disabled.close();
    disabled = undefined;
  });

  it("serves a JSON completion end to end without touching a telemetry port", async () => {
    const h = buildDisabled();
    disabled = h.app;
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ object: "chat.completion" });
    expect(h.calls).toEqual([]);
  });

  it("serves an SSE completion end to end without touching a telemetry port", async () => {
    const h = buildDisabled();
    disabled = h.app;
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("data: [DONE]");
    // Catches `streamOpened`/`streamClosed`, the latter of which runs in a
    // `finally` after the response has already ended.
    expect(h.calls).toEqual([]);
  });

  it("returns request-boundary errors without touching a telemetry port", async () => {
    const h = buildDisabled();
    disabled = h.app;
    // Unauthenticated (401), unknown model (404), and a tool-schema rejection
    // (400) each pass through a different telemetry call site.
    expect((await h.app.inject({ method: "POST", url, payload: jsonBody })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/models/nope", headers: auth })).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app.inject({
          method: "POST",
          url,
          headers: auth,
          payload: { ...jsonBody, tools: "not-an-array" },
        })
      ).statusCode,
    ).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("survives an UPSTREAM failure without touching a telemetry port", async () => {
    // Drives the adapter decorator, `failUpstreamSpan`, and the orchestrator's
    // outer catch — none of which the success paths reach.
    const h = buildDisabled({ upstream: "fail" });
    disabled = h.app;
    const json = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(json.statusCode).toBe(502);
    // The same failure AFTER the SSE header is committed takes the post-header
    // error-record path instead.
    const sse = await h.app.inject({ method: "POST", url, headers: auth, payload: streamBody });
    expect(sse.body).toContain('"error"');
    expect(h.calls).toEqual([]);
  });

  it("survives a completion TIMEOUT without touching a telemetry port", async () => {
    // Drives the poll phase, `observeTimeout`, and the poll span's failure exit.
    const h = buildDisabled({ upstream: "stall" });
    disabled = h.app;
    const res = await h.app.inject({ method: "POST", url, headers: auth, payload: jsonBody });
    expect(res.statusCode).toBe(504);
    expect(h.calls).toEqual([]);
  }, 15_000);

  it("survives a required-choice tool PARSE failure without touching a telemetry port", async () => {
    // Drives `observeToolParseFailure` and the parse span's failure exit.
    const h = buildDisabled({ toolModel: true });
    disabled = h.app;
    const res = await h.app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        model: TOOL_MODEL_ID,
        messages: [{ role: "user", content: "read it" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        ],
        tool_choice: "required",
      },
    });
    // The upstream answers with prose, so a required choice finds no valid call.
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "invalid_tool_response" } });
    expect(h.calls).toEqual([]);
  });

  it("survives a real-socket client CANCELLATION without touching a telemetry port", async () => {
    // The cancellation path runs from the raw `close` listener, outside the
    // request/response cycle, so an unguarded call there could not be caught by
    // any status- or body-based assertion.
    let begun = false;
    const models: readonly VirtualModel[] = [model(MODEL_ID)];
    const config = makeConfig({ models, METRICS_ENABLED: false, TRACING_ENABLED: false });
    const { telemetry, calls } = recordingPorts();
    const app = buildServer({
      config,
      readiness: createReadinessState(true),
      telemetry,
      completion: {
        chatService: fakeService(
          (_prepared, signal) =>
            new Promise<CompletionResult>((_resolve, reject) => {
              begun = true;
              signal.addEventListener("abort", () => reject(new RequestCancelledError()), {
                once: true,
              });
            }),
        ),
        titleBridge: noopTitleBridge,
        shutdownSignal: new AbortController().signal,
      },
    });
    disabled = app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: url,
      headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.write(JSON.stringify(jsonBody));
    req.end();
    for (let i = 0; i < 500 && !begun; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(begun).toBe(true);
    req.destroy();
    // Give the raw `close` listener a turn to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toEqual([]);
  }, 15_000);

  it("does not touch the metrics port on cancellation when only TRACING is enabled", async () => {
    // The fully-disabled cases above cannot isolate the per-call-site guards,
    // because the root hook is not installed at all. This mixed configuration
    // DOES install it, so a missing `metricsOn` guard on the cancellation path
    // is caught here — and it also proves the span is still marked failed.
    let begun = false;
    const models: readonly VirtualModel[] = [model(MODEL_ID)];
    const config = makeConfig({ models, METRICS_ENABLED: false, TRACING_ENABLED: true });
    const { telemetry: recording, calls } = recordingPorts();
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({
      otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
      sampleRatio: 1,
      environment: "development",
      modelIds: models.map((m) => m.id),
      exporter,
      useSimpleProcessor: true,
    });
    const app = buildServer({
      config,
      readiness: createReadinessState(true),
      // Metrics stay the recording (disabled) port; tracing is genuinely live.
      telemetry: { metrics: recording.metrics, tracing },
      completion: {
        chatService: fakeService(
          (_prepared, signal) =>
            new Promise<CompletionResult>((_resolve, reject) => {
              begun = true;
              signal.addEventListener("abort", () => reject(new RequestCancelledError()), {
                once: true,
              });
            }),
        ),
        titleBridge: noopTitleBridge,
        shutdownSignal: new AbortController().signal,
      },
    });
    disabled = app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: url,
      headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.write(JSON.stringify(jsonBody));
    req.end();
    for (let i = 0; i < 500 && !begun; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(begun).toBe(true);
    req.destroy();
    // Wait for the ROOT span specifically: child spans such as
    // `gateway.validate` finish long before it, so waiting for "any span" would
    // race and read an exporter that has not seen `gateway.request` yet.
    const rootSpan = (): ReadableSpan | undefined =>
      exporter.getFinishedSpans().find((s) => s.name === "gateway.request");
    for (let i = 0; i < 500 && rootSpan() === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(calls).toEqual([]);
    const root = rootSpan();
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    expect(root?.attributes["collectiviq.error_category"]).toBe("other");
    await tracing.shutdown();
  }, 15_000);

  it("survives an idempotent REPLAY without touching a telemetry port", async () => {
    const models: readonly VirtualModel[] = [
      model(MODEL_ID, { pollIntervalMs: 1, maxPollIntervalMs: 1, requestTimeoutMs: 5_000 }),
    ];
    const masterKey = randomBytes(32).toString("base64url");
    const config = makeConfig({
      models,
      METRICS_ENABLED: false,
      TRACING_ENABLED: false,
      REDIS_URL: "redis://127.0.0.1:6379",
      IDEMPOTENCY_ENCRYPTION_KEY: masterKey,
    });
    const adapter: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: "t1", rawStatus: 200 }),
      processMessage: () =>
        Promise.resolve({ accepted: true, combinedRunId: "run-1", rawStatus: 202 }),
      getMessages: () =>
        Promise.resolve({
          messages: [
            {
              id: "m1",
              source: "gpt",
              content: "hello",
              createdAt: 1,
              percentUsage: null,
              combinedRunId: "run-1",
            },
          ],
          rawStatus: 200,
        }),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const { telemetry, calls } = recordingPorts();
    const runtime = createCompletionRuntime(config, { adapter, telemetry });
    const nowMs = 1_700_000_000_000;
    const app = buildServer({
      config,
      readiness: createReadinessState(true),
      telemetry,
      completion: {
        chatService: runtime.chatService,
        titleBridge: noopTitleBridge,
        shutdownSignal: new AbortController().signal,
      },
      idempotency: createIdempotencyCoordinator({
        store: createFakeIdempotencyStore({ nowMs: () => nowMs }),
        keyring: deriveIdempotencyKeyring(masterKey),
        namespace: "test-ns",
        ttlMs: 600_000,
        clock: { nowMs: () => nowMs },
        sleeper: { sleep: () => Promise.resolve() },
        random: () => 0,
        scheduleRenewal: () => ({ cancel: () => undefined }),
      }),
    });
    disabled = app;
    const keyed = { ...auth, "idempotency-key": "disabled-replay-1" };
    const first = await app.inject({ method: "POST", url, headers: keyed, payload: jsonBody });
    const replay = await app.inject({ method: "POST", url, headers: keyed, payload: jsonBody });
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(calls).toEqual([]);
  });

  it("does not register GET /metrics", async () => {
    const h = buildDisabled();
    disabled = h.app;
    expect((await h.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe("privacy", () => {
  it("keeps prompts, answers, headers, credentials, and ids out of metrics and spans", async () => {
    const h = build({
      tracingEnabled: true,
      run: () =>
        Promise.resolve({
          kind: "text",
          content: "ANSWER-SENTINEL-7b31",
          upstreamThreadId: "thread-SENTINEL-id",
          upstreamThreadCreated: true,
        }),
    });
    // Two requests on purpose. The keyed one exercises the header sentinels but
    // fails closed at the idempotency gate (no coordinator is wired), so it
    // never reaches `run()`; the unkeyed one is what actually produces an answer
    // and an upstream thread id. Combining them would make the answer and
    // thread sentinels unfalsifiable.
    await h.app.inject({
      method: "POST",
      url,
      headers: {
        ...auth,
        "x-collectiviq-opencode-session-id": "session-SENTINEL-id",
        "idempotency-key": "idem-SENTINEL-key",
      },
      payload: {
        ...jsonBody,
        messages: [{ role: "user", content: "PROMPT-SENTINEL-2d54 /etc/passwd" }],
      },
    });
    const answered = await h.app.inject({
      method: "POST",
      url,
      headers: { ...auth, "x-collectiviq-opencode-session-id": "session-SENTINEL-id" },
      payload: {
        ...jsonBody,
        messages: [{ role: "user", content: "PROMPT-SENTINEL-2d54 /etc/passwd" }],
      },
    });
    // Guard the guard: the sentinel-bearing answer really was produced, so the
    // assertions below are testing absence from telemetry rather than absence
    // from the run.
    expect(answered.statusCode).toBe(200);
    expect(answered.body).toContain("ANSWER-SENTINEL-7b31");

    const sentinels = [
      "PROMPT-SENTINEL-2d54",
      "ANSWER-SENTINEL-7b31",
      "thread-SENTINEL-id",
      "session-SENTINEL-id",
      "idem-SENTINEL-key",
      GATEWAY_KEY,
      "/etc/passwd",
    ];
    const exposition = await h.exposition();
    const serialized = JSON.stringify(
      h.spans().map((s) => ({ name: s.name, attributes: s.attributes, status: s.status })),
    );
    for (const sentinel of sentinels) {
      expect(exposition, `metrics must not contain ${sentinel}`).not.toContain(sentinel);
      expect(serialized, `spans must not contain ${sentinel}`).not.toContain(sentinel);
    }
  });
});
