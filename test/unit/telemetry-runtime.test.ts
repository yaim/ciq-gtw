/**
 * Telemetry composition and lifecycle (specification sections 23, 31.3).
 *
 * Proves the ownership split between `buildServer` and the process root, and
 * that a DISABLED gateway constructs nothing and contacts nothing. Hermetic: no
 * collector, network, credential, or CollectivIQ call.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { createTracing, type GatewayTracing } from "../../src/observability/tracing.js";
import { createNoopMetrics } from "../../src/observability/metrics.js";
import {
  DISABLED_TELEMETRY,
  composeTelemetryRuntime,
  createMetricsFromConfig,
  createServerDefaultTelemetry,
  createTelemetryRuntime,
  createTracingFromConfig,
} from "../../src/observability/telemetry.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

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

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
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
    ...over,
  };
}

const TRACING_ON = {
  TRACING_ENABLED: true,
  TRACING_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spy on every outbound request primitive for the duration of `body`. */
async function withNetworkSpies(body: () => Promise<void> | void): Promise<{ calls: number }> {
  let calls = 0;
  const count = (): never => {
    calls += 1;
    throw new Error("unexpected outbound request");
  };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(count);
  const httpSpy = vi.spyOn(http, "request").mockImplementation(count);
  const httpsSpy = vi.spyOn(https, "request").mockImplementation(count);
  try {
    await body();
  } finally {
    fetchSpy.mockRestore();
    httpSpy.mockRestore();
    httpsSpy.mockRestore();
  }
  return { calls };
}

describe("telemetry composition", () => {
  it("is fully inert by default", async () => {
    const runtime = createTelemetryRuntime(makeConfig());
    expect(runtime.metrics.enabled).toBe(false);
    expect(runtime.tracing.enabled).toBe(false);
    expect(await runtime.metrics.collect()).toBe("");
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("builds each port independently from its own switch", () => {
    expect(createMetricsFromConfig(makeConfig({ METRICS_ENABLED: true })).enabled).toBe(true);
    expect(createMetricsFromConfig(makeConfig()).enabled).toBe(false);
    expect(createTracingFromConfig(makeConfig({ ...TRACING_ON })).enabled).toBe(true);
    expect(createTracingFromConfig(makeConfig()).enabled).toBe(false);
    // Metrics do not imply tracing, and tracing does not imply metrics.
    const metricsOnly = createTelemetryRuntime(makeConfig({ METRICS_ENABLED: true }));
    expect(metricsOnly.metrics.enabled).toBe(true);
    expect(metricsOnly.tracing.enabled).toBe(false);
  });

  it("falls back to the no-op tracer when an enabled endpoint is somehow absent", () => {
    // Configuration validation makes this unreachable; the guard exists so a
    // future loader change degrades to no traces rather than throwing.
    expect(createTracingFromConfig(makeConfig({ TRACING_ENABLED: true })).enabled).toBe(false);
  });

  it("keeps tracing a no-op on the buildServer default path even when enabled", () => {
    // An OTLP exporter has a shutdown obligation only the process root can
    // discharge, so `buildServer`'s default path never constructs one.
    const telemetry = createServerDefaultTelemetry(
      makeConfig({ METRICS_ENABLED: true, ...TRACING_ON }),
    );
    expect(telemetry.metrics.enabled).toBe(true);
    expect(telemetry.tracing.enabled).toBe(false);
  });

  it("shares one frozen disabled instance", async () => {
    expect(DISABLED_TELEMETRY.metrics.enabled).toBe(false);
    expect(DISABLED_TELEMETRY.tracing.enabled).toBe(false);
    expect(Object.isFrozen(DISABLED_TELEMETRY)).toBe(true);
    await expect(DISABLED_TELEMETRY.tracing.shutdown()).resolves.toBeUndefined();
  });
});

describe("telemetry lifecycle", () => {
  it("opens no connection while constructing or closing an ENABLED runtime", async () => {
    let runtime: ReturnType<typeof createTelemetryRuntime> | undefined;
    const { calls } = await withNetworkSpies(async () => {
      runtime = createTelemetryRuntime(makeConfig({ METRICS_ENABLED: true, ...TRACING_ON }));
      expect(runtime.tracing.enabled).toBe(true);
      // No span is ever started, so the exporter has nothing to send.
      await runtime.close();
    });
    expect(calls).toBe(0);
  });

  it("opens no connection while a DISABLED runtime is exercised", async () => {
    const { calls } = await withNetworkSpies(async () => {
      const runtime = createTelemetryRuntime(makeConfig());
      const span = runtime.tracing.startSpan("gateway.request", {
        attributes: { endpoint: "/v1/chat/completions" },
      });
      span.setAttributes({ statusFamily: "2xx" });
      span.setError("internal_error");
      span.end();
      runtime.metrics.observeRequest({
        endpoint: "/v1/chat/completions",
        statusFamily: "2xx",
        model: "collectiviq-consensus",
        transport: "json",
        durationSeconds: 1,
        errorCategory: null,
      });
      await runtime.close();
    });
    expect(calls).toBe(0);
  });

  it("closes idempotently and never rejects", async () => {
    const runtime = createTelemetryRuntime(makeConfig({ ...TRACING_ON }));
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

describe("telemetry close never touches a DISABLED port", () => {
  /**
   * A tracing port that RECORDS every call instead of trusting a no-op to be
   * harmless. "Disabled telemetry calls no port" is the invariant the whole
   * feature rests on, and a no-op `shutdown()` would satisfy every observable
   * assertion while still breaking it — so the port has to be able to tell.
   */
  function recordingTracing(
    enabled: boolean,
    shutdown?: () => Promise<void>,
  ): {
    readonly port: GatewayTracing;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    const port: GatewayTracing = {
      enabled,
      startSpan: (name) => {
        calls.push(`startSpan:${name}`);
        return { setAttributes: () => {}, setError: () => {}, end: () => {} };
      },
      shutdown: () => {
        calls.push("shutdown");
        return shutdown === undefined ? Promise.resolve() : shutdown();
      },
    };
    return { port, calls };
  }

  it("does not call shutdown() on a disabled tracing port", async () => {
    const { port, calls } = recordingTracing(false);
    const runtime = composeTelemetryRuntime({ metrics: createNoopMetrics(), tracing: port });
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does not call shutdown() in metrics-only mode", async () => {
    // Metrics own no closeable resource, so enabling them must not drag the
    // tracing port into the shutdown sequence.
    const { port, calls } = recordingTracing(false);
    const metrics = createMetricsFromConfig(makeConfig({ METRICS_ENABLED: true }));
    const runtime = composeTelemetryRuntime({ metrics, tracing: port });
    expect(runtime.metrics.enabled).toBe(true);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("calls shutdown() exactly once per close on an ENABLED port", async () => {
    const { port, calls } = recordingTracing(true);
    const runtime = composeTelemetryRuntime({ metrics: createNoopMetrics(), tracing: port });
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toEqual(["shutdown"]);
  });

  it("stays non-rejecting even when reading `enabled` throws", async () => {
    // Unreachable through either real port — both are frozen objects carrying
    // `enabled` as a plain data property — but `close()` promises never to
    // reject, and the `enabled` read is the one statement that could break that
    // if it drifted back outside the swallow.
    const calls: string[] = [];
    const port: GatewayTracing = {
      get enabled(): boolean {
        throw new Error("hostile accessor");
      },
      startSpan: () => ({ setAttributes: () => {}, setError: () => {}, end: () => {} }),
      shutdown: () => {
        calls.push("shutdown");
        return Promise.resolve();
      },
    };
    const runtime = composeTelemetryRuntime({ metrics: createNoopMetrics(), tracing: port });
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("stays non-rejecting when an enabled port's shutdown rejects", async () => {
    const { port, calls } = recordingTracing(true, () => Promise.reject(new Error("collector")));
    const runtime = composeTelemetryRuntime({ metrics: createNoopMetrics(), tracing: port });
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toEqual(["shutdown"]);
  });

  it("routes createTelemetryRuntime through the same composition", async () => {
    // The seam is only meaningful if the production factory uses it, so the
    // config-built disabled runtime must behave identically.
    const runtime = createTelemetryRuntime(makeConfig());
    expect(runtime.tracing.enabled).toBe(false);
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

describe("OTEL_* environment isolation", () => {
  /**
   * The SDK treats `OTEL_*` variables as a fallback for anything the caller did
   * not set, so an ambient exporter header would be attached to every export and
   * an ambient client-key path would be read from disk at construction. The
   * gateway hides them for the duration of construction; these cases prove the
   * variables are genuinely invisible then and exactly restored afterwards.
   */
  const OTEL_VARS = {
    OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=OTEL-HEADER-SENTINEL",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=OTEL-AUTH-SENTINEL",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.invalid:4318/v1/traces",
    OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: "/nonexistent/OTEL-KEY-SENTINEL.pem",
    OTEL_BSP_MAX_QUEUE_SIZE: "1",
    OTEL_SERVICE_NAME: "OTEL-SERVICE-SENTINEL",
  } as const;

  function withOtelVars<T>(body: () => T): T {
    const restore = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(OTEL_VARS)) {
      restore.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return body();
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("does not read the client-certificate file an ambient OTEL_* variable names", async () => {
    // This is the behavioural proof that the variables really are hidden: with
    // `OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY` visible, the SDK's own
    // `readFileFromEnv` would `readFileSync` that path while building the
    // exporter. The spy must therefore never see the sentinel path — and, as a
    // control, the same spy DOES observe a deliberate read.
    const readSpy = vi.spyOn(fs, "readFileSync");
    const tracing = withOtelVars(() =>
      createTracing({
        otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
        sampleRatio: 0,
        environment: "development",
        modelIds: [],
      }),
    );
    const readPaths = readSpy.mock.calls.map((call) => String(call[0]));
    expect(readPaths.some((path) => path.includes("OTEL-KEY-SENTINEL"))).toBe(false);

    // Control: the spy is real and would have caught such a read.
    expect(() => fs.readFileSync("/nonexistent/OTEL-KEY-SENTINEL.pem")).toThrow();
    expect(
      readSpy.mock.calls
        .map((call) => String(call[0]))
        .some((p) => p.includes("OTEL-KEY-SENTINEL")),
    ).toBe(true);

    readSpy.mockRestore();
    await tracing.shutdown();
  });

  it("restores the exact environment after construction", () => {
    withOtelVars(() => {
      const before = { ...process.env };
      createTracing({
        otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
        sampleRatio: 1,
        environment: "development",
        modelIds: [],
      });
      expect({ ...process.env }).toEqual(before);
      for (const [key, value] of Object.entries(OTEL_VARS)) {
        expect(process.env[key]).toBe(value);
      }
    });
  });

  it("keeps the gateway's own fixed service identity despite OTEL_SERVICE_NAME", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = withOtelVars(() =>
      createTracing({
        otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
        sampleRatio: 1,
        environment: "staging",
        modelIds: [],
        exporter,
        useSimpleProcessor: true,
      }),
    );
    tracing.startSpan("gateway.request").end();
    const span = exporter.getFinishedSpans()[0];
    expect(span?.resource.attributes["service.name"]).toBe("collectiviq-gateway");
    expect(span?.resource.attributes["deployment.environment.name"]).toBe("staging");
    expect(JSON.stringify(span?.resource.attributes)).not.toContain("OTEL-SERVICE-SENTINEL");
    await tracing.shutdown();
  });

  it("constructs the REAL OTLP exporter under hostile OTEL_* variables without I/O", async () => {
    // The client-key variable would make the SDK `readFileSync` at construction
    // and the header variables would attach a credential to every export.
    const { calls } = await withNetworkSpies(async () => {
      const tracing = withOtelVars(() =>
        createTracing({
          otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
          sampleRatio: 0,
          environment: "development",
          modelIds: [],
        }),
      );
      await tracing.shutdown();
    });
    expect(calls).toBe(0);
  });
});
