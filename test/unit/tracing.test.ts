import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { MODEL_LABEL_NONE, TELEMETRY_SERVICE_NAME } from "../../src/observability/labels.js";
import {
  createNoopTracing,
  createTracing,
  SPAN_ATTRIBUTE_KEYS,
  SPAN_NAMES,
  TRACING_SHUTDOWN_TIMEOUT_MS,
  type GatewayTracing,
  type SpanAttributes,
} from "../../src/observability/tracing.js";

const OTLP_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
const MODEL_ID = "collectiviq-claude-direct";

/** Values that must never survive validation and reach an exported span. */
const SECRET_SENTINEL = "sk-secret-sentinel";
const PATH_SENTINEL = "/etc/passwd";
const SENTINELS = [
  SECRET_SENTINEL,
  PATH_SENTINEL,
  "thread_01ABCDEF",
  "prompt sentinel",
  "--tool-arg",
];

/** One value for every supported field, all of them valid. */
const FULL_ATTRIBUTES: SpanAttributes = {
  endpoint: "/v1/chat/completions",
  statusFamily: "2xx",
  transport: "sse",
  model: MODEL_ID,
  promptMode: "direct",
  toolMode: "emulated",
  errorCategory: "completion_timeout",
  upstreamOperation: "process_message",
  upstreamOutcome: "success",
  pollOutcome: "answer",
  parserSource: "individual-consensus",
  pollCount: 3,
  toolCallCount: 2,
  threadReused: true,
};

const openTracings: GatewayTracing[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (openTracings.length > 0) {
    const tracing = openTracings.pop();
    if (tracing !== undefined) await tracing.shutdown();
  }
});

interface Harness {
  readonly tracing: GatewayTracing;
  spans(): ReadableSpan[];
  named(name: string): ReadableSpan;
}

/**
 * An enabled port writing to an in-memory exporter through the synchronous
 * processor, so an ended span is visible immediately.
 */
function harness(options: { sampleRatio?: number; modelIds?: readonly string[] } = {}): Harness {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({
    otlpEndpoint: OTLP_ENDPOINT,
    sampleRatio: options.sampleRatio ?? 1,
    environment: "development",
    modelIds: options.modelIds ?? [MODEL_ID],
    exporter,
    useSimpleProcessor: true,
  });
  openTracings.push(tracing);
  return {
    tracing,
    spans: () => exporter.getFinishedSpans(),
    named: (name: string) => {
      const matches = exporter.getFinishedSpans().filter((span) => span.name === name);
      const [first] = matches;
      if (first === undefined || matches.length !== 1) {
        throw new Error(`expected exactly one ${name} span, saw ${matches.length}`);
      }
      return first;
    },
  };
}

function only(spans: readonly ReadableSpan[]): ReadableSpan {
  const [first] = spans;
  if (first === undefined || spans.length !== 1) {
    throw new Error(`expected exactly one exported span, saw ${spans.length}`);
  }
  return first;
}

interface NetworkWatch {
  readonly calls: string[];
  restore(): void;
}

/**
 * Replace every outbound entry point for the duration of a test. A trap records
 * the attempt and throws, so a stray export is both recorded and loud.
 */
function watchNetwork(): NetworkWatch {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;

  const trap = (label: string) => (): never => {
    calls.push(label);
    throw new Error(`unexpected ${label} call`);
  };

  globalThis.fetch = trap("fetch");
  http.request = trap("http.request");
  http.get = trap("http.get");
  https.request = trap("https.request");
  https.get = trap("https.get");

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      http.request = originalHttpRequest;
      http.get = originalHttpGet;
      https.request = originalHttpsRequest;
      https.get = originalHttpsGet;
    },
  };
}

describe("span names", () => {
  it("starts and ends a span under each specification-section-23.3 name", () => {
    const h = harness();
    for (const name of SPAN_NAMES) h.tracing.startSpan(name).end();
    expect(h.spans().map((span) => span.name)).toEqual([...SPAN_NAMES]);
  });

  it("produces no span at all for a name outside the closed vocabulary", () => {
    const h = harness();
    h.tracing.startSpan("gateway.exfiltrate" as never).end();
    h.tracing.startSpan(SECRET_SENTINEL as never).end();
    expect(h.spans()).toHaveLength(0);
  });
});

describe("explicit parentage", () => {
  it("nests a child under the parent it was given", () => {
    const h = harness();
    const parent = h.tracing.startSpan("gateway.request");
    const child = h.tracing.startSpan("collectiviq.poll", { parent });
    child.end();
    parent.end();

    const parentSpan = h.named("gateway.request");
    const childSpan = h.named("collectiviq.poll");
    expect(childSpan.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
    expect(childSpan.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
    expect(childSpan.spanContext().spanId).not.toBe(parentSpan.spanContext().spanId);
  });

  it("starts a root span with its own trace when no parent is given", () => {
    const h = harness();
    h.tracing.startSpan("gateway.request").end();
    h.tracing.startSpan("gateway.encode").end();

    const first = h.named("gateway.request");
    const second = h.named("gateway.encode");
    expect(first.parentSpanContext).toBeUndefined();
    expect(second.parentSpanContext).toBeUndefined();
    expect(first.spanContext().traceId).not.toBe(second.spanContext().traceId);
  });

  it("falls back to a root span when the parent is not one of its own spans", () => {
    const h = harness();
    const foreign = createNoopTracing().startSpan("gateway.request");
    h.tracing.startSpan("gateway.validate", { parent: foreign }).end();
    expect(only(h.spans()).parentSpanContext).toBeUndefined();
  });
});

describe("closed attributes", () => {
  it("emits every supported field under its exact collectiviq.* key", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes(FULL_ATTRIBUTES);
    span.end();

    expect(only(h.spans()).attributes).toEqual({
      "collectiviq.endpoint": "/v1/chat/completions",
      "collectiviq.status_family": "2xx",
      "collectiviq.transport": "sse",
      "collectiviq.model": MODEL_ID,
      "collectiviq.prompt_mode": "direct",
      "collectiviq.tool_mode": "emulated",
      "collectiviq.error_category": "completion_timeout",
      "collectiviq.upstream_operation": "process_message",
      "collectiviq.upstream_outcome": "success",
      "collectiviq.poll_outcome": "answer",
      "collectiviq.parser_source": "individual-consensus",
      "collectiviq.poll_count": 3,
      "collectiviq.tool_call_count": 2,
      "collectiviq.thread_reused": true,
    });
  });

  it("emits start-time attributes through the same validation", () => {
    const h = harness();
    h.tracing.startSpan("gateway.stream", { attributes: { transport: "sse" } }).end();
    expect(only(h.spans()).attributes).toEqual({ "collectiviq.transport": "sse" });
  });

  it("exposes the emitted key set as the exported closed map", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes(FULL_ATTRIBUTES);
    span.end();

    const emitted = Object.keys(only(h.spans()).attributes).sort();
    expect(emitted).toEqual([...Object.values(SPAN_ATTRIBUTE_KEYS)].sort());
    expect(emitted.every((key) => key.startsWith("collectiviq."))).toBe(true);
  });

  it("drops every unrecognized enum value instead of emitting it", () => {
    const h = harness();
    const hostile = {
      endpoint: "/v1/admin/keys",
      statusFamily: "6xx",
      transport: "grpc",
      promptMode: "verbatim",
      toolMode: "simulated",
      errorCategory: "kaboom",
      upstreamOperation: "delete_thread",
      upstreamOutcome: "maybe",
      pollOutcome: "partial",
      parserSource: "guess",
    } as unknown as SpanAttributes;

    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes(hostile);
    span.end();
    expect(only(h.spans()).attributes).toEqual({});
  });

  it("drops a field that is present but not a string", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes({ endpoint: 42, transport: null } as unknown as SpanAttributes);
    span.end();
    expect(only(h.spans()).attributes).toEqual({});
  });

  it("collapses a model outside the configured ids to the fallback label", () => {
    const h = harness({ modelIds: [MODEL_ID] });
    for (const model of ["collectiviq-unconfigured", "", SECRET_SENTINEL]) {
      const span = h.tracing.startSpan("gateway.request");
      span.setAttributes({ model });
      span.end();
    }
    const emitted = h.spans().map((span) => span.attributes["collectiviq.model"]);
    expect(emitted).toEqual([MODEL_LABEL_NONE, MODEL_LABEL_NONE, MODEL_LABEL_NONE]);
  });

  it("collapses a non-string model to the fallback label", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes({ model: { id: MODEL_ID } } as unknown as SpanAttributes);
    span.end();
    expect(only(h.spans()).attributes).toEqual({ "collectiviq.model": MODEL_LABEL_NONE });
  });

  it("omits the model key entirely when no model is supplied", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes({ transport: "json" });
    span.end();
    expect(Object.keys(only(h.spans()).attributes)).toEqual(["collectiviq.transport"]);
  });

  it("emits a configured model id unchanged", () => {
    const h = harness({ modelIds: ["collectiviq-claude-tools", MODEL_ID] });
    const span = h.tracing.startSpan("gateway.request");
    span.setAttributes({ model: "collectiviq-claude-tools" });
    span.end();
    expect(only(h.spans()).attributes).toEqual({
      "collectiviq.model": "collectiviq-claude-tools",
    });
  });

  it("bounds count fields and drops the ones with no honest integer", () => {
    const h = harness();
    const cases: { input: SpanAttributes; expected: number | undefined }[] = [
      { input: { pollCount: Number.NaN }, expected: undefined },
      { input: { pollCount: Number.POSITIVE_INFINITY }, expected: undefined },
      { input: { pollCount: "7" as unknown as number }, expected: undefined },
      { input: { pollCount: -1 }, expected: 0 },
      { input: { pollCount: 1.5 }, expected: 1 },
      { input: { pollCount: 1e9 }, expected: 100_000 },
      { input: { pollCount: 0 }, expected: 0 },
      { input: { pollCount: 4 }, expected: 4 },
    ];

    for (const testCase of cases) {
      const span = h.tracing.startSpan("collectiviq.poll");
      span.setAttributes(testCase.input);
      span.end();
    }

    expect(h.spans().map((span) => span.attributes["collectiviq.poll_count"])).toEqual(
      cases.map((testCase) => testCase.expected),
    );
  });

  it("applies the same bounds to the tool-call count", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.parse");
    span.setAttributes({ toolCallCount: 5e9 });
    span.end();
    expect(only(h.spans()).attributes).toEqual({ "collectiviq.tool_call_count": 100_000 });
  });

  it("emits threadReused only for a real boolean", () => {
    const h = harness();
    const cases: SpanAttributes[] = [
      { threadReused: true },
      { threadReused: false },
      { threadReused: "true" as unknown as boolean },
      { threadReused: 1 as unknown as boolean },
    ];

    for (const attributes of cases) {
      const span = h.tracing.startSpan("gateway.request");
      span.setAttributes(attributes);
      span.end();
    }

    expect(h.spans().map((span) => span.attributes["collectiviq.thread_reused"])).toEqual([
      true,
      false,
      undefined,
      undefined,
    ]);
  });
});

describe("setError", () => {
  it("marks the span failed with a closed category and no status message", () => {
    const h = harness();
    const span = h.tracing.startSpan("collectiviq.process_message");
    span.setError("upstream_request_failed");
    span.end();

    const exported = only(h.spans());
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    expect(exported.status.message).toBeUndefined();
    expect(exported.attributes["collectiviq.error_category"]).toBe("upstream_request_failed");
    expect(exported.events).toEqual([]);
  });

  it("collapses a category outside the closed set to the fallback", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.request");
    span.setError("Error: sk-secret-sentinel at /etc/passwd" as never);
    span.end();

    const exported = only(h.spans());
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    expect(exported.status.message).toBeUndefined();
    expect(exported.attributes["collectiviq.error_category"]).toBe("other");
  });

  it("leaves an unmarked span with an unset status", () => {
    const h = harness();
    h.tracing.startSpan("gateway.request").end();
    expect(only(h.spans()).status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe("span lifecycle", () => {
  it("exports exactly one span when end is called twice", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.encode");
    span.end();
    span.end();
    span.end();
    expect(h.spans()).toHaveLength(1);
  });

  it("ignores attributes and errors recorded after the span ended", () => {
    const h = harness();
    const span = h.tracing.startSpan("gateway.encode");
    span.setAttributes({ transport: "json" });
    span.end();
    span.setAttributes({ transport: "sse", pollCount: 9 });
    span.setError("internal_error");

    const exported = only(h.spans());
    expect(exported.attributes).toEqual({ "collectiviq.transport": "json" });
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("reports the port as enabled independently of the sampling ratio", () => {
    expect(harness({ sampleRatio: 1 }).tracing.enabled).toBe(true);
    expect(harness({ sampleRatio: 0 }).tracing.enabled).toBe(true);
  });
});

describe("sampling", () => {
  it("records no root span at a zero ratio", () => {
    const h = harness({ sampleRatio: 0 });
    for (const name of SPAN_NAMES) h.tracing.startSpan(name).end();
    for (let i = 0; i < 25; i += 1) h.tracing.startSpan("gateway.request").end();
    expect(h.spans()).toHaveLength(0);
  });

  it("records every root span at a full ratio", () => {
    const h = harness({ sampleRatio: 1 });
    for (let i = 0; i < 25; i += 1) h.tracing.startSpan("gateway.request").end();
    expect(h.spans()).toHaveLength(25);
  });

  it("clamps an out-of-range or non-finite ratio", () => {
    const above = harness({ sampleRatio: 7 });
    for (let i = 0; i < 10; i += 1) above.tracing.startSpan("gateway.request").end();
    expect(above.spans()).toHaveLength(10);

    for (const ratio of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const h = harness({ sampleRatio: ratio });
      for (let i = 0; i < 10; i += 1) h.tracing.startSpan("gateway.request").end();
      expect(h.spans()).toHaveLength(0);
    }
  });

  it("keeps a child span with its sampled parent", () => {
    const h = harness({ sampleRatio: 1 });
    const parent = h.tracing.startSpan("gateway.request");
    h.tracing.startSpan("collectiviq.create_thread", { parent }).end();
    parent.end();
    expect(h.spans()).toHaveLength(2);
  });
});

describe("resource", () => {
  it("reports exactly the fixed service identity", () => {
    const h = harness();
    h.tracing.startSpan("gateway.request").end();
    expect(only(h.spans()).resource.attributes).toEqual({
      "service.name": TELEMETRY_SERVICE_NAME,
      "deployment.environment.name": "development",
    });
  });

  it("carries the configured deployment environment", () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({
      otlpEndpoint: OTLP_ENDPOINT,
      sampleRatio: 1,
      environment: "production",
      modelIds: [MODEL_ID],
      exporter,
      useSimpleProcessor: true,
    });
    openTracings.push(tracing);
    tracing.startSpan("gateway.request").end();
    expect(
      only(exporter.getFinishedSpans()).resource.attributes["deployment.environment.name"],
    ).toBe("production");
  });
});

describe("shutdown", () => {
  it("resolves and is idempotent", async () => {
    const h = harness();
    h.tracing.startSpan("gateway.request").end();
    await expect(h.tracing.shutdown()).resolves.toBeUndefined();
    await expect(h.tracing.shutdown()).resolves.toBeUndefined();
  });

  it("never rejects when the exporter shutdown rejects", async () => {
    const rejecting: SpanExporter = {
      export: () => {
        // No span is exported in this test.
      },
      shutdown: () => Promise.reject(new Error("exporter shutdown sentinel")),
    };
    const tracing = createTracing({
      otlpEndpoint: OTLP_ENDPOINT,
      sampleRatio: 1,
      environment: "development",
      modelIds: [MODEL_ID],
      exporter: rejecting,
      useSimpleProcessor: true,
    });
    openTracings.push(tracing);

    await expect(tracing.shutdown()).resolves.toBeUndefined();
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });

  it("resolves through the bounded budget when the exporter shutdown hangs", async () => {
    expect(TRACING_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
    vi.useFakeTimers();
    const hanging: SpanExporter = {
      export: () => {
        // No span is exported in this test.
      },
      shutdown: () => new Promise<void>(() => undefined),
    };
    const tracing = createTracing({
      otlpEndpoint: OTLP_ENDPOINT,
      sampleRatio: 1,
      environment: "development",
      modelIds: [MODEL_ID],
      exporter: hanging,
      useSimpleProcessor: true,
    });

    let settled = false;
    const pending = tracing.shutdown().then(() => {
      settled = true;
    });

    // The budget is a real bound: nothing resolves before it elapses.
    await vi.advanceTimersByTimeAsync(TRACING_SHUTDOWN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("keeps startSpan safe after shutdown", async () => {
    const h = harness();
    await h.tracing.shutdown();
    const span = h.tracing.startSpan("gateway.request", { attributes: FULL_ATTRIBUTES });
    span.setError("internal_error");
    expect(() => span.end()).not.toThrow();
  });
});

describe("disabled port", () => {
  it("is disabled, total, and free of network activity", async () => {
    const watch = watchNetwork();
    let shutdown: Promise<void>;
    try {
      const tracing = createNoopTracing();
      expect(tracing.enabled).toBe(false);

      const parent = tracing.startSpan("gateway.request", { attributes: FULL_ATTRIBUTES });
      const child = tracing.startSpan("collectiviq.poll", { parent, attributes: { pollCount: 2 } });
      for (const name of SPAN_NAMES) tracing.startSpan(name).end();
      child.setAttributes(FULL_ATTRIBUTES);
      child.setAttributes({ model: SECRET_SENTINEL });
      child.setError("upstream_request_failed");
      child.setError(PATH_SENTINEL as never);
      child.end();
      child.end();
      parent.end();
      shutdown = tracing.shutdown();
    } finally {
      watch.restore();
    }

    expect(watch.calls).toEqual([]);
    await expect(shutdown).resolves.toBeUndefined();
  });

  it("returns the same shared no-op span for every call", () => {
    const tracing = createNoopTracing();
    expect(tracing.startSpan("gateway.request")).toBe(tracing.startSpan("gateway.encode"));
    expect(Object.isFrozen(tracing.startSpan("gateway.request"))).toBe(true);
  });
});

describe("no connection on construction", () => {
  // Without this, every "no network" assertion below could pass vacuously
  // because the traps were never actually installed on the modules an exporter
  // would reach for.
  it("installs traps that observe a real outbound call", async () => {
    const dynamicHttp = await import("node:http");
    expect(dynamicHttp.default).toBe(http);

    const watch = watchNetwork();
    const trapped = http.request;
    try {
      for (const attempt of [
        () => globalThis.fetch("http://127.0.0.1:4318/v1/traces"),
        () => http.request("http://127.0.0.1:4318/v1/traces"),
        () => https.request("https://127.0.0.1:4318/v1/traces"),
        () => dynamicHttp.default.request("http://127.0.0.1:4318/v1/traces"),
      ]) {
        expect(attempt).toThrow(/unexpected/);
      }
    } finally {
      watch.restore();
    }

    expect(watch.calls).toEqual(["fetch", "http.request", "https.request", "http.request"]);
    expect(http.request).not.toBe(trapped);
  });

  it("makes no request while constructing and recording with an injected exporter", () => {
    const watch = watchNetwork();
    try {
      const tracing = createTracing({
        otlpEndpoint: OTLP_ENDPOINT,
        sampleRatio: 1,
        environment: "production",
        modelIds: [MODEL_ID],
        exporter: new InMemorySpanExporter(),
        useSimpleProcessor: true,
      });
      openTracings.push(tracing);
      const span = tracing.startSpan("gateway.request", { attributes: FULL_ATTRIBUTES });
      span.setError("service_unavailable");
      span.end();
    } finally {
      watch.restore();
    }
    expect(watch.calls).toEqual([]);
  });

  it("makes no request while constructing the real OTLP/HTTP exporter", () => {
    const watch = watchNetwork();
    try {
      // Nothing is sampled, so no span can be queued for export either.
      const tracing = createTracing({
        otlpEndpoint: OTLP_ENDPOINT,
        sampleRatio: 0,
        environment: "production",
        modelIds: [MODEL_ID],
      });
      openTracings.push(tracing);
      tracing.startSpan("gateway.request", { attributes: FULL_ATTRIBUTES }).end();
    } finally {
      watch.restore();
    }
    expect(watch.calls).toEqual([]);
  });
});

describe("privacy", () => {
  it("never lets a hostile value reach a span name, attribute, or status", () => {
    const h = harness();

    for (const sentinel of SENTINELS) {
      const hostile = {
        endpoint: sentinel,
        statusFamily: sentinel,
        transport: sentinel,
        model: sentinel,
        promptMode: sentinel,
        toolMode: sentinel,
        errorCategory: sentinel,
        upstreamOperation: sentinel,
        upstreamOutcome: sentinel,
        pollOutcome: sentinel,
        parserSource: sentinel,
        pollCount: sentinel,
        toolCallCount: sentinel,
        threadReused: sentinel,
      } as unknown as SpanAttributes;

      const span = h.tracing.startSpan("gateway.request", { attributes: hostile });
      span.setAttributes(hostile);
      span.setError(sentinel as never);
      span.end();

      const unnamed = h.tracing.startSpan(sentinel as never, { attributes: hostile });
      unnamed.setError(sentinel as never);
      unnamed.end();
    }

    const spans = h.spans();
    expect(spans).toHaveLength(SENTINELS.length);
    for (const span of spans) {
      expect(span.attributes).toEqual({
        "collectiviq.model": MODEL_LABEL_NONE,
        "collectiviq.error_category": "other",
      });
      const serialized = JSON.stringify({
        name: span.name,
        attributes: span.attributes,
        status: span.status,
        events: span.events,
        links: span.links,
        resource: span.resource.attributes,
      });
      for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
    }
  });
});
