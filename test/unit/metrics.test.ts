import { register } from "@prometheus-io/client";
import { describe, expect, it } from "vitest";
import {
  createMetrics,
  createNoopMetrics,
  METRIC_NAMES,
  POLL_DURATION_BUCKETS_SECONDS,
  REQUEST_DURATION_BUCKETS_SECONDS,
  UPSTREAM_DURATION_BUCKETS_SECONDS,
  type GatewayMetrics,
} from "../../src/observability/metrics.js";
import type {
  EndpointLabel,
  ErrorCategory,
  ParserSourceLabel,
  StatusFamily,
  ToolModeLabel,
  TransportLabel,
  UpstreamOperation,
  UpstreamOutcome,
} from "../../src/observability/labels.js";

const MODEL_A = "collectiviq-claude-direct";
const MODEL_B = "collectiviq-claude-tools";

/** Values a caller must never be able to turn into a label. */
const SENTINELS = [
  "sk-secret-sentinel",
  "/etc/passwd",
  "thread_01ABCDEF",
  "prompt sentinel text",
  "--tool-arg-sentinel",
] as const;

interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: string;
}

const SAMPLE_LINE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})? (.+)$/;

/**
 * Parse exposition sample lines. Label order is not asserted anywhere, so a
 * changed emission order can never silently pass or fail a test.
 */
function parseExposition(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = SAMPLE_LINE.exec(line);
    if (match === null) continue;
    const name = match[1];
    const value = match[3];
    if (name === undefined || value === undefined) continue;
    const labels: Record<string, string> = {};
    const rawLabels = match[2];
    if (rawLabels !== undefined && rawLabels.length > 0) {
      for (const pair of rawLabels.split(",")) {
        const separator = pair.indexOf("=");
        if (separator === -1) continue;
        labels[pair.slice(0, separator)] = pair.slice(separator + 1).replace(/^"|"$/g, "");
      }
    }
    samples.push({ name, labels, value });
  }
  return samples;
}

function samplesFor(text: string, name: string): Sample[] {
  return parseExposition(text).filter((sample) => sample.name === name);
}

function onlySample(text: string, name: string): Sample {
  const samples = samplesFor(text, name);
  expect(samples).toHaveLength(1);
  const sample = samples[0];
  if (sample === undefined) throw new Error(`no sample emitted for ${name}`);
  return sample;
}

function singleValueOf(text: string, name: string): string {
  return onlySample(text, name).value;
}

/** Group one metric's samples by a single label, asserting nothing about order. */
function valuesByLabel(text: string, name: string, label: string): Map<string | undefined, string> {
  return new Map(
    samplesFor(text, name).map((sample) => [sample.labels[label], sample.value] as const),
  );
}

function metrics(modelIds: readonly string[] = [MODEL_A, MODEL_B]): GatewayMetrics {
  return createMetrics({ modelIds });
}

/** Touch every metric exactly once. */
function observeEveryMetric(target: GatewayMetrics): void {
  target.observeRequest({
    endpoint: "/v1/chat/completions",
    statusFamily: "5xx",
    model: MODEL_A,
    transport: "sse",
    durationSeconds: 1.5,
    errorCategory: "upstream_request_failed",
  });
  target.observeClientCancellation("/v1/chat/completions", "sse");
  target.observeUpstreamRequest({
    operation: "create_thread",
    outcome: "success",
    durationSeconds: 0.2,
  });
  target.observePollPhase({
    model: MODEL_A,
    outcome: "answer",
    durationSeconds: 12,
    pollCount: 5,
  });
  target.observeTimeout(MODEL_A);
  target.observeToolResponse({
    model: MODEL_B,
    toolMode: "emulated",
    parserSource: "desired-source",
  });
  target.observeToolParseFailure(MODEL_B);
  target.observeToolSchemaFailure(MODEL_B);
  target.streamOpened();
}

const EXPECTED_TYPES: ReadonlyArray<readonly [string, string]> = [
  [METRIC_NAMES.requestsTotal, "counter"],
  [METRIC_NAMES.requestDurationSeconds, "histogram"],
  [METRIC_NAMES.activeRequests, "gauge"],
  [METRIC_NAMES.queuedRequests, "gauge"],
  [METRIC_NAMES.upstreamRequestsTotal, "counter"],
  [METRIC_NAMES.upstreamRequestDurationSeconds, "histogram"],
  [METRIC_NAMES.pollCount, "counter"],
  [METRIC_NAMES.pollDurationSeconds, "histogram"],
  [METRIC_NAMES.timeoutsTotal, "counter"],
  [METRIC_NAMES.errorsTotal, "counter"],
  [METRIC_NAMES.toolResponsesTotal, "counter"],
  [METRIC_NAMES.toolParseFailuresTotal, "counter"],
  [METRIC_NAMES.toolSchemaFailuresTotal, "counter"],
  [METRIC_NAMES.streamConnections, "gauge"],
  [METRIC_NAMES.clientCancellationsTotal, "counter"],
];

describe("createMetrics exposition", () => {
  it("exposes all fifteen specification section 23.2 metrics with their declared types", async () => {
    const target = metrics();
    observeEveryMetric(target);
    const text = await target.collect();

    expect(Object.values(METRIC_NAMES)).toHaveLength(15);
    expect(EXPECTED_TYPES).toHaveLength(Object.values(METRIC_NAMES).length);
    for (const [name, type] of EXPECTED_TYPES) {
      expect(text).toContain(`# TYPE ${name} ${type}`);
      const emitted = samplesFor(text, name).length + samplesFor(text, `${name}_bucket`).length;
      expect(emitted).toBeGreaterThan(0);
    }
  });

  it("reports the Prometheus content type and enabled flag", () => {
    const target = metrics();
    expect(target.enabled).toBe(true);
    expect(target.contentType).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("exposes exactly the declared request-duration buckets, including 90 seconds", async () => {
    const target = metrics();
    target.observeRequest({
      endpoint: "/v1/chat/completions",
      statusFamily: "2xx",
      model: MODEL_A,
      transport: "json",
      durationSeconds: 0.3,
      errorCategory: null,
    });
    const text = await target.collect();

    const boundaries = samplesFor(text, `${METRIC_NAMES.requestDurationSeconds}_bucket`).map(
      (sample) => sample.labels["le"],
    );
    expect(boundaries).toEqual([
      ...REQUEST_DURATION_BUCKETS_SECONDS.map((bound) => String(bound)),
      "+Inf",
    ]);
    expect(boundaries).toContain("90");
    for (const bound of REQUEST_DURATION_BUCKETS_SECONDS) {
      expect(text).toContain(`le="${String(bound)}"`);
    }
  });

  it("exposes the declared upstream and poll buckets", async () => {
    const target = metrics();
    target.observeUpstreamRequest({
      operation: "get_messages",
      outcome: "success",
      durationSeconds: 0.02,
    });
    target.observePollPhase({
      model: MODEL_A,
      outcome: "answer",
      durationSeconds: 3,
      pollCount: 2,
    });
    const text = await target.collect();

    const upstream = samplesFor(text, `${METRIC_NAMES.upstreamRequestDurationSeconds}_bucket`).map(
      (sample) => sample.labels["le"],
    );
    expect(upstream).toEqual([
      ...UPSTREAM_DURATION_BUCKETS_SECONDS.map((bound) => String(bound)),
      "+Inf",
    ]);

    const poll = samplesFor(text, `${METRIC_NAMES.pollDurationSeconds}_bucket`).map(
      (sample) => sample.labels["le"],
    );
    expect(poll).toEqual([...POLL_DURATION_BUCKETS_SECONDS.map((bound) => String(bound)), "+Inf"]);
    expect(upstream).toContain("90");
    expect(poll).toContain("90");
  });
});

describe("createMetrics labels", () => {
  it("labels a settled request with exactly endpoint, status family, model, and transport", async () => {
    const target = metrics();
    target.observeRequest({
      endpoint: "/v1/chat/completions",
      statusFamily: "2xx",
      model: MODEL_A,
      transport: "sse",
      durationSeconds: 2,
      errorCategory: null,
    });
    const text = await target.collect();

    const sample = onlySample(text, METRIC_NAMES.requestsTotal);
    expect(sample.labels).toEqual({
      endpoint: "/v1/chat/completions",
      status_family: "2xx",
      model: MODEL_A,
      transport: "sse",
    });
    expect(sample.value).toBe("1");
  });

  it("does not touch errors_total for a request without an error category", async () => {
    const target = metrics();
    target.observeRequest({
      endpoint: "/v1/models",
      statusFamily: "2xx",
      model: null,
      transport: "json",
      durationSeconds: 0.01,
      errorCategory: null,
    });
    const text = await target.collect();

    expect(samplesFor(text, METRIC_NAMES.errorsTotal)).toHaveLength(0);
    expect(text).not.toContain(`${METRIC_NAMES.errorsTotal}{`);
  });

  it("increments errors_total with only endpoint and error category", async () => {
    const target = metrics();
    target.observeRequest({
      endpoint: "/v1/chat/completions",
      statusFamily: "4xx",
      model: MODEL_A,
      transport: "json",
      durationSeconds: 0.5,
      errorCategory: "gateway_rate_limit_exceeded",
    });
    const text = await target.collect();

    expect(onlySample(text, METRIC_NAMES.errorsTotal).labels).toEqual({
      endpoint: "/v1/chat/completions",
      error_category: "gateway_rate_limit_exceeded",
    });
  });

  it("labels cancellations, upstream calls, polling, and tool outcomes with their closed sets", async () => {
    const target = metrics();
    target.observeClientCancellation("/v1/chat/completions", "sse");
    target.observeUpstreamRequest({
      operation: "process_message",
      outcome: "cancelled",
      durationSeconds: 0.4,
    });
    target.observePollPhase({
      model: MODEL_A,
      outcome: "timeout",
      durationSeconds: 90,
      pollCount: 9,
    });
    target.observeTimeout(MODEL_A);
    target.observeToolResponse({
      model: MODEL_B,
      toolMode: "emulated",
      parserSource: "individual-consensus",
    });
    target.observeToolParseFailure(MODEL_B);
    target.observeToolSchemaFailure(MODEL_B);
    const text = await target.collect();

    expect(onlySample(text, METRIC_NAMES.clientCancellationsTotal).labels).toEqual({
      endpoint: "/v1/chat/completions",
      transport: "sse",
    });
    expect(onlySample(text, METRIC_NAMES.upstreamRequestsTotal).labels).toEqual({
      operation: "process_message",
      outcome: "cancelled",
    });
    expect(onlySample(text, METRIC_NAMES.pollCount).labels).toEqual({ model: MODEL_A });
    expect(onlySample(text, `${METRIC_NAMES.pollDurationSeconds}_count`).labels).toEqual({
      model: MODEL_A,
      outcome: "timeout",
    });
    expect(onlySample(text, METRIC_NAMES.timeoutsTotal).labels).toEqual({ model: MODEL_A });
    expect(onlySample(text, METRIC_NAMES.toolResponsesTotal).labels).toEqual({
      model: MODEL_B,
      tool_mode: "emulated",
      parser_source: "individual-consensus",
    });
    expect(onlySample(text, METRIC_NAMES.toolParseFailuresTotal).labels).toEqual({
      model: MODEL_B,
    });
    expect(onlySample(text, METRIC_NAMES.toolSchemaFailuresTotal).labels).toEqual({
      model: MODEL_B,
    });
  });

  it("collapses a null, empty, or unconfigured model id to none", async () => {
    const target = metrics();
    for (const model of [null, "", "not-configured"]) {
      target.observeRequest({
        endpoint: "/v1/chat/completions",
        statusFamily: "2xx",
        model,
        transport: "json",
        durationSeconds: 1,
        errorCategory: null,
      });
    }
    target.observeRequest({
      endpoint: "/v1/chat/completions",
      statusFamily: "2xx",
      model: MODEL_A,
      transport: "json",
      durationSeconds: 1,
      errorCategory: null,
    });
    const text = await target.collect();

    const byModel = valuesByLabel(text, METRIC_NAMES.requestsTotal, "model");
    expect(byModel.size).toBe(2);
    expect(byModel.get("none")).toBe("3");
    expect(byModel.get(MODEL_A)).toBe("1");
  });

  it("collapses an out-of-vocabulary label to its fixed fallback", async () => {
    const target = metrics();
    target.observeRequest({
      endpoint: "/etc/passwd" as unknown as EndpointLabel,
      statusFamily: "9xx" as unknown as StatusFamily,
      model: null,
      transport: "websocket" as unknown as TransportLabel,
      durationSeconds: 1,
      errorCategory: "TypeError: leaked exception text" as unknown as ErrorCategory,
    });
    target.observeToolResponse({
      model: null,
      toolMode: "wide-open" as unknown as ToolModeLabel,
      parserSource: "hand-written-regex" as unknown as ParserSourceLabel,
    });
    const text = await target.collect();

    expect(onlySample(text, METRIC_NAMES.requestsTotal).labels).toEqual({
      endpoint: "other",
      status_family: "other",
      model: "none",
      transport: "json",
    });
    expect(onlySample(text, METRIC_NAMES.errorsTotal).labels).toEqual({
      endpoint: "other",
      error_category: "other",
    });
    expect(onlySample(text, METRIC_NAMES.toolResponsesTotal).labels).toEqual({
      model: "none",
      tool_mode: "disabled",
      parser_source: "desired-source",
    });
    for (const leak of ["/etc/passwd", "9xx", "websocket", "leaked exception text", "wide-open"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("drops an upstream observation whose operation is outside the closed set", async () => {
    const target = metrics();
    target.observeUpstreamRequest({
      operation: "delete_everything" as unknown as UpstreamOperation,
      outcome: "success",
      durationSeconds: 1,
    });
    target.observeUpstreamRequest({
      operation: "get_threads",
      outcome: "totally-fine" as unknown as UpstreamOutcome,
      durationSeconds: 1,
    });
    const text = await target.collect();

    expect(onlySample(text, METRIC_NAMES.upstreamRequestsTotal).labels).toEqual({
      operation: "get_threads",
      outcome: "error",
    });
    expect(text).not.toContain("delete_everything");
    expect(text).not.toContain("totally-fine");
  });
});

describe("createMetrics isolation", () => {
  it("keeps two instances independent", async () => {
    const first = metrics();
    const second = metrics();
    observeEveryMetric(first);

    const firstText = await first.collect();
    const secondText = await second.collect();

    expect(samplesFor(firstText, METRIC_NAMES.requestsTotal)).toHaveLength(1);
    for (const name of [
      METRIC_NAMES.requestsTotal,
      METRIC_NAMES.errorsTotal,
      METRIC_NAMES.upstreamRequestsTotal,
      METRIC_NAMES.pollCount,
      METRIC_NAMES.timeoutsTotal,
      METRIC_NAMES.toolResponsesTotal,
      METRIC_NAMES.toolParseFailuresTotal,
      METRIC_NAMES.toolSchemaFailuresTotal,
      METRIC_NAMES.clientCancellationsTotal,
    ]) {
      expect(samplesFor(secondText, name)).toHaveLength(0);
      expect(secondText).not.toContain(`${name}{`);
    }
    expect(singleValueOf(secondText, METRIC_NAMES.streamConnections)).toBe("0");
  });

  it("never registers a series on the Prometheus client's default registry", async () => {
    const target = metrics();
    observeEveryMetric(target);
    await target.collect();

    for (const name of Object.values(METRIC_NAMES)) {
      expect(register.getSingleMetric(name)).toBeUndefined();
    }
    expect(await register.metrics()).not.toContain("collectiviq_gateway_");
  });
});

describe("createMetrics capacity gauges", () => {
  it("reports zero while no capacity source is bound", async () => {
    const text = await metrics().collect();
    expect(singleValueOf(text, METRIC_NAMES.activeRequests)).toBe("0");
    expect(singleValueOf(text, METRIC_NAMES.queuedRequests)).toBe("0");
  });

  it("re-reads the bound source on every collect, and the last binding wins", async () => {
    const target = metrics();
    const source = { activeCount: 3, queuedCount: 7 };
    target.bindCapacitySource(source);

    const first = await target.collect();
    expect(singleValueOf(first, METRIC_NAMES.activeRequests)).toBe("3");
    expect(singleValueOf(first, METRIC_NAMES.queuedRequests)).toBe("7");

    source.activeCount = 5;
    source.queuedCount = 0;
    const second = await target.collect();
    expect(singleValueOf(second, METRIC_NAMES.activeRequests)).toBe("5");
    expect(singleValueOf(second, METRIC_NAMES.queuedRequests)).toBe("0");

    target.bindCapacitySource({ activeCount: 1, queuedCount: 2 });
    const third = await target.collect();
    expect(singleValueOf(third, METRIC_NAMES.activeRequests)).toBe("1");
    expect(singleValueOf(third, METRIC_NAMES.queuedRequests)).toBe("2");
  });

  it("coerces a hostile capacity snapshot to zero", async () => {
    const target = metrics();
    target.bindCapacitySource({ activeCount: Number.NaN, queuedCount: -4 });
    const text = await target.collect();

    expect(singleValueOf(text, METRIC_NAMES.activeRequests)).toBe("0");
    expect(singleValueOf(text, METRIC_NAMES.queuedRequests)).toBe("0");
    expect(text).not.toContain("Nan");
  });
});

describe("createMetrics stream connections", () => {
  it("never drops below zero on an unpaired close", async () => {
    const target = metrics();
    target.streamClosed();
    target.streamClosed();
    expect(singleValueOf(await target.collect(), METRIC_NAMES.streamConnections)).toBe("0");
  });

  it("tracks concurrent open streams", async () => {
    const target = metrics();
    target.streamOpened();
    target.streamOpened();
    expect(singleValueOf(await target.collect(), METRIC_NAMES.streamConnections)).toBe("2");
    target.streamClosed();
    expect(singleValueOf(await target.collect(), METRIC_NAMES.streamConnections)).toBe("1");
  });
});

describe("createMetrics numeric hygiene", () => {
  it("records a non-finite or negative duration as zero", async () => {
    const target = metrics();
    for (const durationSeconds of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      target.observeRequest({
        endpoint: "/v1/chat/completions",
        statusFamily: "2xx",
        model: MODEL_A,
        transport: "json",
        durationSeconds,
        errorCategory: null,
      });
    }
    const text = await target.collect();

    expect(singleValueOf(text, `${METRIC_NAMES.requestDurationSeconds}_sum`)).toBe("0");
    expect(singleValueOf(text, `${METRIC_NAMES.requestDurationSeconds}_count`)).toBe("3");
    const smallest = samplesFor(text, `${METRIC_NAMES.requestDurationSeconds}_bucket`).find(
      (sample) => sample.labels["le"] === "0.05",
    );
    expect(smallest?.value).toBe("3");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Nan");
    // `le="+Inf"` is legitimate; an infinite VALUE would follow a space.
    expect(text).not.toContain(" +Inf");
  });

  it("ignores a poll count that is zero, negative, fractional, or not a number", async () => {
    const target = metrics();
    for (const pollCount of [0, -3, 1.5, Number.NaN]) {
      target.observePollPhase({
        model: MODEL_A,
        outcome: "answer",
        durationSeconds: 4,
        pollCount,
      });
    }
    const text = await target.collect();

    expect(samplesFor(text, METRIC_NAMES.pollCount)).toHaveLength(0);
    expect(text).not.toContain(`${METRIC_NAMES.pollCount}{`);
    // The polling phase itself is still timed for all four completions.
    expect(singleValueOf(text, `${METRIC_NAMES.pollDurationSeconds}_count`)).toBe("4");
  });

  it("accumulates real poll attempts and clamps an absurd count", async () => {
    const target = metrics();
    target.observePollPhase({
      model: MODEL_A,
      outcome: "answer",
      durationSeconds: 4,
      pollCount: 4,
    });
    expect(singleValueOf(await target.collect(), METRIC_NAMES.pollCount)).toBe("4");

    target.observePollPhase({
      model: MODEL_A,
      outcome: "error",
      durationSeconds: 4,
      pollCount: 5_000_000,
    });
    expect(singleValueOf(await target.collect(), METRIC_NAMES.pollCount)).toBe("100004");
  });
});

describe("createMetrics privacy", () => {
  it("never emits a caller-supplied value through the model field", async () => {
    const target = metrics();
    for (const sentinel of SENTINELS) {
      target.observeRequest({
        endpoint: "/v1/chat/completions",
        statusFamily: "2xx",
        model: sentinel,
        transport: "json",
        durationSeconds: 1,
        errorCategory: null,
      });
      target.observePollPhase({
        model: sentinel,
        outcome: "answer",
        durationSeconds: 1,
        pollCount: 2,
      });
      target.observeTimeout(sentinel);
      target.observeToolResponse({
        model: sentinel,
        toolMode: "emulated",
        parserSource: "individual-single",
      });
      target.observeToolParseFailure(sentinel);
      target.observeToolSchemaFailure(sentinel);
    }
    const text = await target.collect();

    for (const sentinel of SENTINELS) {
      expect(text).not.toContain(sentinel);
    }
    expect(onlySample(text, METRIC_NAMES.timeoutsTotal)).toEqual({
      name: METRIC_NAMES.timeoutsTotal,
      labels: { model: "none" },
      value: String(SENTINELS.length),
    });
    expect(onlySample(text, METRIC_NAMES.pollCount).labels).toEqual({ model: "none" });
  });

  it("keeps a configured model id usable while collapsing everything else", async () => {
    const target = metrics([MODEL_A]);
    target.observeTimeout(MODEL_A);
    target.observeTimeout(MODEL_B);
    const text = await target.collect();

    const byModel = valuesByLabel(text, METRIC_NAMES.timeoutsTotal, "model");
    expect(byModel.get(MODEL_A)).toBe("1");
    expect(byModel.get("none")).toBe("1");
    expect(byModel.size).toBe(2);
  });
});

describe("createNoopMetrics", () => {
  it("is inert, frozen, and accepts every call", async () => {
    const noop = createNoopMetrics();

    expect(noop.enabled).toBe(false);
    expect(noop.contentType).toBe("");
    expect(Object.isFrozen(noop)).toBe(true);

    expect(() => {
      observeEveryMetric(noop);
      noop.bindCapacitySource({ activeCount: 4, queuedCount: 2 });
      noop.streamClosed();
      noop.streamClosed();
      noop.observeTimeout(SENTINELS[0]);
      noop.observeUpstreamRequest({
        operation: "delete_everything" as unknown as UpstreamOperation,
        outcome: "success",
        durationSeconds: Number.NaN,
      });
    }).not.toThrow();

    await expect(noop.collect()).resolves.toBe("");
  });

  it("registers nothing anywhere", async () => {
    createNoopMetrics().streamOpened();
    expect(await register.metrics()).not.toContain("collectiviq_gateway_");
  });
});
