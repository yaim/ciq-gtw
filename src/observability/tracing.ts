/**
 * Manual-span distributed tracing port (specification section 23.3).
 *
 * This module owns the ONLY OpenTelemetry tracing surface in the gateway, and
 * it is deliberately minimal: the caller starts a named span, attaches bounded
 * metadata, and ends it. There is no automatic instrumentation, no global
 * registration, and no environment reading here.
 *
 * Boundary decisions, and why each one exists:
 *
 * - **No global registration.** `provider.register()` is never called, because
 *   registering would install a global context manager and propagator. The
 *   gateway does not want ambient context: `AsyncLocalStorage`-based parentage
 *   would silently attach spans to whatever happened to be active, which is
 *   exactly the kind of implicit coupling that makes a request's span tree
 *   depend on scheduling. Parentage is therefore EXPLICIT — a caller passes the
 *   parent span, and everything else starts at `ROOT_CONTEXT`. `context.active()`
 *   is never consulted.
 *
 * - **No automatic instrumentation.** Nothing patches `http`, `fetch`, Fastify,
 *   or Redis. Auto-instrumentation would capture full URLs, headers, and query
 *   strings — i.e. gateway keys, idempotency keys, session ids, and model
 *   content — into span attributes. The nine span names of specification
 *   section 23.3 are the entire vocabulary.
 *
 * - **No environment self-configuration AT CONSTRUCTION.** The SDK normally
 *   treats `OTEL_*` variables as a fallback for anything the caller did not set.
 *   Every telemetry object here is therefore built with those variables hidden
 *   (see {@link withoutOtelEnvironment}), so an ambient exporter header, client
 *   certificate, timeout, or batch-processor tuning value cannot reach the
 *   exporter as it is built. Configuration comes from validated application
 *   configuration only. Scope this claim to CONSTRUCTION: it cannot bind a
 *   future SDK version that reads the environment lazily at export time.
 *
 * - **Closed attributes.** A span may only carry the bounded metadata in
 *   {@link SpanAttributes}, and every field is re-validated against the closed
 *   vocabularies in `./labels.js` before it is emitted. An unrecognized value is
 *   silently DROPPED rather than passed through, so a request id, thread id,
 *   session id, tool-call id, gateway key or scope, idempotency key, path, URL,
 *   prompt, answer, tool name/argument/result, credential, or exception text
 *   can never reach a span attribute, a span name, or a status message. A span
 *   name outside {@link SPAN_NAMES} produces no span at all.
 *
 * - **No exception recording.** `setError` records a CLOSED error category and
 *   an empty ERROR status. `recordException` is never called — it would
 *   serialize an exception message and stack into a span event — and the
 *   configured span limits additionally forbid events and links outright.
 *
 * - **Total and non-throwing.** Telemetry must never fail a request, so every
 *   method on {@link GatewaySpan} and {@link GatewayTracing} swallows failures
 *   and returns normally. `end()` is idempotent and `shutdown()` is bounded,
 *   idempotent, and never rejects.
 *
 * Trace context is never propagated to CollectivIQ: specification section 23.3
 * permits that only if upstream officially supports correlation headers, which
 * is unverified.
 */

import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span as OtelSpan,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanExporter,
  type SpanLimits,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  ENDPOINT_LABELS,
  ERROR_CATEGORIES,
  MODEL_LABEL_NONE,
  PARSER_SOURCES,
  POLL_OUTCOMES,
  STATUS_FAMILIES,
  TELEMETRY_SERVICE_NAME,
  TOOL_MODE_LABELS,
  TRANSPORTS,
  UPSTREAM_OPERATIONS,
  UPSTREAM_OUTCOMES,
  type EndpointLabel,
  type ErrorCategory,
  type ParserSourceLabel,
  type PollOutcomeLabel,
  type StatusFamily,
  type ToolModeLabel,
  type TransportLabel,
  type UpstreamOperation,
  type UpstreamOutcome,
} from "./labels.js";

/** The spans of specification section 23.3. This list is the whole vocabulary. */
export const SPAN_NAMES = [
  "gateway.request",
  "gateway.validate",
  "gateway.serialize",
  "collectiviq.create_thread",
  "collectiviq.process_message",
  "collectiviq.poll",
  "gateway.parse",
  "gateway.encode",
  "gateway.stream",
] as const;
export type SpanName = (typeof SPAN_NAMES)[number];

/**
 * The complete set of attribute keys a span may carry. Exported so tests and
 * reviewers can see the closed set without reading the emit logic.
 */
export const SPAN_ATTRIBUTE_KEYS = Object.freeze({
  endpoint: "collectiviq.endpoint",
  statusFamily: "collectiviq.status_family",
  transport: "collectiviq.transport",
  model: "collectiviq.model",
  promptMode: "collectiviq.prompt_mode",
  toolMode: "collectiviq.tool_mode",
  errorCategory: "collectiviq.error_category",
  upstreamOperation: "collectiviq.upstream_operation",
  upstreamOutcome: "collectiviq.upstream_outcome",
  pollOutcome: "collectiviq.poll_outcome",
  parserSource: "collectiviq.parser_source",
  pollCount: "collectiviq.poll_count",
  toolCallCount: "collectiviq.tool_call_count",
  threadReused: "collectiviq.thread_reused",
} as const);

/** Bounded flush + shutdown budget; a slow or wedged collector cannot block exit. */
export const TRACING_SHUTDOWN_TIMEOUT_MS = 2000;

/** Prompt serialization profiles (mirrors `PROMPT_MODES` in `src/config/schema.ts`). */
const PROMPT_MODE_LABELS = ["protocol", "direct"] as const;

/** Upper bound for every numeric span attribute, so a runaway counter stays bounded. */
const MAX_COUNT_ATTRIBUTE_VALUE = 100_000;

/** Category recorded when `setError` is handed a value outside `ERROR_CATEGORIES`. */
const FALLBACK_ERROR_CATEGORY: ErrorCategory = "other";

const SPAN_NAME_SET: ReadonlySet<string> = new Set(SPAN_NAMES);
const ENDPOINT_LABEL_SET: ReadonlySet<string> = new Set(ENDPOINT_LABELS);
const STATUS_FAMILY_SET: ReadonlySet<string> = new Set(STATUS_FAMILIES);
const TRANSPORT_SET: ReadonlySet<string> = new Set(TRANSPORTS);
const PROMPT_MODE_SET: ReadonlySet<string> = new Set(PROMPT_MODE_LABELS);
const TOOL_MODE_SET: ReadonlySet<string> = new Set(TOOL_MODE_LABELS);
const ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(ERROR_CATEGORIES);
const UPSTREAM_OPERATION_SET: ReadonlySet<string> = new Set(UPSTREAM_OPERATIONS);
const UPSTREAM_OUTCOME_SET: ReadonlySet<string> = new Set(UPSTREAM_OUTCOMES);
const POLL_OUTCOME_SET: ReadonlySet<string> = new Set(POLL_OUTCOMES);
const PARSER_SOURCE_SET: ReadonlySet<string> = new Set(PARSER_SOURCES);

/**
 * Hard structural limits applied to every span. Events and links are forbidden
 * outright (limit `0`), which is what makes it impossible for exception text or
 * a correlated remote context to be attached even by a future mistake. The
 * attribute count comfortably exceeds the closed key set, and the value length
 * bounds the only caller-supplied string that can be emitted (a configured
 * virtual-model id).
 */
const SPAN_LIMITS: SpanLimits = {
  attributeCountLimit: 32,
  attributeValueLengthLimit: 256,
  eventCountLimit: 0,
  linkCountLimit: 0,
  attributePerEventCountLimit: 0,
  attributePerLinkCountLimit: 0,
};

/** Closed span attributes. Every field is bounded metadata; nothing else may be set. */
export interface SpanAttributes {
  readonly endpoint?: EndpointLabel;
  readonly statusFamily?: StatusFamily;
  readonly transport?: TransportLabel;
  /** A CONFIGURED virtual-model id; anything else collapses to `MODEL_LABEL_NONE`. */
  readonly model?: string;
  readonly promptMode?: "protocol" | "direct";
  readonly toolMode?: ToolModeLabel;
  readonly errorCategory?: ErrorCategory;
  readonly upstreamOperation?: UpstreamOperation;
  readonly upstreamOutcome?: UpstreamOutcome;
  readonly pollOutcome?: PollOutcomeLabel;
  readonly parserSource?: ParserSourceLabel;
  readonly pollCount?: number;
  readonly toolCallCount?: number;
  readonly threadReused?: boolean;
}

export interface GatewaySpan {
  setAttributes(attributes: SpanAttributes): void;
  /** Mark the span as failed with a CLOSED error category (never exception text). */
  setError(category: ErrorCategory): void;
  /** Idempotent: a second call is a no-op. */
  end(): void;
}

export interface StartSpanOptions {
  /** Explicit parent; omitted/undefined starts a root span. */
  readonly parent?: GatewaySpan | undefined;
  readonly attributes?: SpanAttributes;
}

export interface GatewayTracing {
  readonly enabled: boolean;
  startSpan(name: SpanName, options?: StartSpanOptions): GatewaySpan;
  /** Bounded flush + shutdown. NEVER rejects and never hangs. */
  shutdown(): Promise<void>;
}

export interface TracingOptions {
  /** Canonical absolute http(s) OTLP/HTTP traces endpoint (already validated by config). */
  readonly otlpEndpoint: string;
  /** Root sampling ratio in [0, 1] (already validated by config); clamp defensively. */
  readonly sampleRatio: number;
  /** Deployment environment: exactly `development` | `staging` | `production`. */
  readonly environment: "development" | "staging" | "production";
  /** The configured virtual-model ids; any other id collapses to `none`. */
  readonly modelIds: readonly string[];
  /** TEST-ONLY seam: use this exporter instead of constructing the OTLP/HTTP exporter. */
  readonly exporter?: SpanExporter;
  /** TEST-ONLY seam: use a synchronous SimpleSpanProcessor instead of BatchSpanProcessor. */
  readonly useSimpleProcessor?: boolean;
}

/**
 * Maps a live {@link GatewaySpan} to the OTel span backing it. Kept module-private
 * (and off the public interface) so a caller can express parentage without ever
 * touching the raw span — no `spanContext()`, no `recordException`, no
 * `updateName`, and no way to write an attribute that bypasses validation.
 */
const OTEL_SPANS = new WeakMap<GatewaySpan, OtelSpan>();

/** Emit a value only when it is a member of its closed vocabulary. */
function setClosed(
  target: Attributes,
  key: string,
  value: unknown,
  allowed: ReadonlySet<string>,
): void {
  if (typeof value === "string" && allowed.has(value)) target[key] = value;
}

/**
 * Emit a count as a non-negative integer bounded by {@link MAX_COUNT_ATTRIBUTE_VALUE}.
 * A non-number or non-finite value is dropped rather than coerced, because there
 * is no honest integer to report for it.
 */
function setCount(target: Attributes, key: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target[key] = Math.min(Math.max(Math.floor(value), 0), MAX_COUNT_ATTRIBUTE_VALUE);
}

/**
 * Translate caller metadata into emitted attributes. The input is typed, but it
 * is treated as untrusted: a cast, a plugin, or a future refactor can deliver
 * anything, so every field is re-checked at runtime.
 */
function buildAttributes(input: SpanAttributes, models: ReadonlySet<string>): Attributes {
  const attributes: Attributes = {};

  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.endpoint, input.endpoint, ENDPOINT_LABEL_SET);
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.statusFamily, input.statusFamily, STATUS_FAMILY_SET);
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.transport, input.transport, TRANSPORT_SET);
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.promptMode, input.promptMode, PROMPT_MODE_SET);
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.toolMode, input.toolMode, TOOL_MODE_SET);
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.errorCategory, input.errorCategory, ERROR_CATEGORY_SET);
  setClosed(
    attributes,
    SPAN_ATTRIBUTE_KEYS.upstreamOperation,
    input.upstreamOperation,
    UPSTREAM_OPERATION_SET,
  );
  setClosed(
    attributes,
    SPAN_ATTRIBUTE_KEYS.upstreamOutcome,
    input.upstreamOutcome,
    UPSTREAM_OUTCOME_SET,
  );
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.pollOutcome, input.pollOutcome, POLL_OUTCOME_SET);
  setClosed(attributes, SPAN_ATTRIBUTE_KEYS.parserSource, input.parserSource, PARSER_SOURCE_SET);

  // A model is reported only when the caller supplied one, but a supplied id
  // that is not configured collapses to the single fallback label rather than
  // being dropped: "which model" stays answerable without an unknown id ever
  // reaching telemetry.
  if (input.model !== undefined) {
    const model = input.model;
    attributes[SPAN_ATTRIBUTE_KEYS.model] =
      typeof model === "string" && model.length > 0 && models.has(model) ? model : MODEL_LABEL_NONE;
  }

  setCount(attributes, SPAN_ATTRIBUTE_KEYS.pollCount, input.pollCount);
  setCount(attributes, SPAN_ATTRIBUTE_KEYS.toolCallCount, input.toolCallCount);

  if (typeof input.threadReused === "boolean") {
    attributes[SPAN_ATTRIBUTE_KEYS.threadReused] = input.threadReused;
  }

  return attributes;
}

/** A recording span. Every method is total: a failure inside OTel is swallowed. */
class RecordingSpan implements GatewaySpan {
  private ended = false;

  constructor(
    private readonly span: OtelSpan,
    private readonly models: ReadonlySet<string>,
  ) {}

  setAttributes(attributes: SpanAttributes): void {
    if (this.ended) return;
    try {
      this.span.setAttributes(buildAttributes(attributes, this.models));
    } catch {
      // Telemetry never fails a request.
    }
  }

  setError(category: ErrorCategory): void {
    if (this.ended) return;
    try {
      // Unlike `setAttributes`, an unrecognized category is collapsed rather
      // than dropped: the span is being marked failed, so the category must
      // still be answerable, and `other` is the closed fallback for that.
      const label = ERROR_CATEGORY_SET.has(category) ? category : FALLBACK_ERROR_CATEGORY;
      this.span.setAttribute(SPAN_ATTRIBUTE_KEYS.errorCategory, label);
      // No status message: a message is the one field that would otherwise
      // carry exception text.
      this.span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // Telemetry never fails a request.
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this.span.end();
    } catch {
      // Telemetry never fails a request.
    }
  }
}

/**
 * The shared disabled span. Frozen and stateless so the disabled path allocates
 * nothing at all and is safe to call from a hot path.
 */
const NOOP_SPAN: GatewaySpan = Object.freeze({
  setAttributes(): void {
    // Tracing is disabled; nothing is recorded.
  },
  setError(): void {
    // Tracing is disabled; nothing is recorded.
  },
  end(): void {
    // Tracing is disabled; nothing is recorded.
  },
});

/** The shared disabled port: no provider, no exporter, no processor, no timer. */
const NOOP_TRACING: GatewayTracing = Object.freeze({
  enabled: false,
  startSpan(): GatewaySpan {
    return NOOP_SPAN;
  },
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
});

/**
 * Build telemetry objects with every `OTEL_*` variable hidden from the SDK.
 *
 * The OpenTelemetry SDK is designed to self-configure from the environment, and
 * `getNodeHttpConfigurationFromEnvironment` is consulted as a FALLBACK for the
 * exporter even when an explicit `url` is supplied. Left alone, an ambient
 * `OTEL_EXPORTER_OTLP_HEADERS` would attach an arbitrary (potentially
 * secret-bearing) header to every export, `OTEL_EXPORTER_OTLP_CLIENT_KEY` and
 * its siblings would `readFileSync` at construction, and `OTEL_BSP_*` would
 * retune the batch processor — none of which the gateway's validated
 * configuration expresses or bounds.
 *
 * The gateway therefore takes its telemetry configuration from application
 * configuration ONLY. Hiding the variables for the duration of construction is
 * what makes that structural rather than a claim: it covers every environment
 * read the installed SDK performs while BUILDING these objects, which
 * enumerating override options could not. It does not, and cannot, cover a
 * future SDK version that re-reads the environment lazily at export time — the
 * durable control against that is the deployment rule that the gateway's
 * environment carries no `OTEL_*` variables at all.
 *
 * `build` must stay synchronous — it is, and every SDK read happens during it —
 * so no other task can observe the temporarily reduced environment, and the
 * exact original entries are restored in a `finally`.
 */
function withoutOtelEnvironment<T>(build: () => T): T {
  const saved = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("OTEL_")) continue;
    const value = process.env[key];
    if (value !== undefined) saved.set(key, value);
    delete process.env[key];
  }
  try {
    return build();
  } finally {
    for (const [key, value] of saved) process.env[key] = value;
  }
}

/** Resolve the sampling ratio into `[0, 1]`; anything non-finite samples nothing. */
function clampRatio(ratio: number): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 0;
  return Math.min(Math.max(ratio, 0), 1);
}

/**
 * Build the parent context. A missing parent, or one this module did not create
 * (a disabled span, a foreign object), deterministically starts a root span
 * instead of silently inheriting whatever context happens to be ambient.
 */
function parentContextOf(parent: GatewaySpan | undefined): Context {
  if (parent === undefined) return ROOT_CONTEXT;
  const otelParent = OTEL_SPANS.get(parent);
  return otelParent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, otelParent);
}

/**
 * Race the provider's own flush-and-shutdown against a bounded timer so a slow,
 * unreachable, or wedged collector cannot delay process exit, and resolve `void`
 * either way — a telemetry failure is not a shutdown failure.
 */
function shutdownProvider(provider: BasicTracerProvider): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    // Hoisted so it can clear the timer it is itself scheduled on; a timer
    // cannot fire before its own assignment completes.
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }

    const timer = setTimeout(finish, TRACING_SHUTDOWN_TIMEOUT_MS);
    // `unref` so the shutdown budget can never itself hold the process open.
    if (typeof timer.unref === "function") timer.unref();

    try {
      // `provider.shutdown()` flushes the pending batch before closing.
      void provider.shutdown().then(finish, finish);
    } catch {
      finish();
    }
  });
}

/**
 * Build the enabled tracing port.
 *
 * Construction is I/O-free: the OTLP/HTTP exporter only contacts the collector
 * when spans are actually exported, and the provider is never registered
 * globally. `enabled` reports that the port is wired, not that any particular
 * span will be sampled — a `sampleRatio` of `0` is an enabled port that records
 * no root spans.
 */
export function createTracing(options: TracingOptions): GatewayTracing {
  const models = new Set<string>();
  for (const id of options.modelIds) {
    if (typeof id === "string" && id.length > 0) models.add(id);
  }

  // Everything the SDK could self-configure from is built inside this callback,
  // so the exporter, the batch processor, and the provider all see an
  // environment with no `OTEL_*` entry at all: the endpoint, sampling, resource,
  // and span limits below are the only inputs.
  const provider = withoutOtelEnvironment(() => {
    const exporter = options.exporter ?? new OTLPTraceExporter({ url: options.otlpEndpoint });
    const processor: SpanProcessor =
      options.useSimpleProcessor === true
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter);

    return new BasicTracerProvider({
      // Fixed identity only. No detectors, no caller-supplied resource
      // attributes, and nothing read from the environment: host, process, OS,
      // and container metadata are all deliberately absent.
      resource: resourceFromAttributes({
        "service.name": TELEMETRY_SERVICE_NAME,
        "deployment.environment.name": options.environment,
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(clampRatio(options.sampleRatio)),
      }),
      spanLimits: SPAN_LIMITS,
      spanProcessors: [processor],
    });
  });
  const tracer = provider.getTracer(TELEMETRY_SERVICE_NAME);

  let shutdownPromise: Promise<void> | undefined;

  return Object.freeze({
    enabled: true,

    startSpan(name: SpanName, spanOptions?: StartSpanOptions): GatewaySpan {
      try {
        // A name outside the closed vocabulary produces no span at all, so a
        // caller cannot smuggle content into a span name.
        if (!SPAN_NAME_SET.has(name)) return NOOP_SPAN;

        const otelSpan = tracer.startSpan(name, undefined, parentContextOf(spanOptions?.parent));
        const span = new RecordingSpan(otelSpan, models);
        OTEL_SPANS.set(span, otelSpan);
        if (spanOptions?.attributes !== undefined) span.setAttributes(spanOptions.attributes);
        return span;
      } catch {
        // Telemetry never fails a request: fall back to a span that does nothing.
        return NOOP_SPAN;
      }
    },

    shutdown(): Promise<void> {
      shutdownPromise ??= shutdownProvider(provider);
      return shutdownPromise;
    },
  });
}

/**
 * The disabled tracing port. Constructs no provider, exporter, processor, or
 * timer and opens no socket, so it is safe to call unconditionally in a hot
 * path when tracing is off.
 */
export function createNoopTracing(): GatewayTracing {
  return NOOP_TRACING;
}
