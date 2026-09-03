/**
 * Bounded Prometheus metrics (specification section 23.2).
 *
 * Each instance owns a PRIVATE `@prometheus-io/client` registry. Nothing is registered on
 * the library's global default registry, default process metrics are never
 * collected, and two instances created in the same process cannot observe or
 * corrupt each other's series.
 *
 * Cardinality is the governing constraint. Every emitted label value is either
 * a member of a frozen vocabulary in `./labels.js` or a virtual-model id this
 * registry was CONSTRUCTED with, and both are re-checked here at write time
 * rather than trusted from the caller. A value failing its re-check collapses
 * to a fixed fallback, so a mistyped route, an unexpected upstream code, or an
 * unconfigured model id can add bounded error to an existing series but can
 * never create a new one. The total series count is therefore a product of
 * small closed sets and the configured catalog, which the configuration layer
 * bounds independently.
 *
 * That same rule is the privacy boundary. Request, thread, session, and
 * tool-call identifiers, paths, URLs, headers, prompts, answers, tool names,
 * arguments and results, credentials, gateway keys and scopes, idempotency
 * keys, and exception text have no representation in this API, and a caller
 * that smuggles one into a label field has it discarded by the re-check rather
 * than exposed on `/metrics`. Only counts, durations, and closed labels are
 * stored.
 *
 * Every observation is total. Durations and counts are coerced before use, and
 * no method throws for any input: the callers are request paths, error
 * handlers, and `finally` blocks that must not fail because telemetry did.
 */
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import {
  ENDPOINT_LABELS,
  ERROR_CATEGORIES,
  MODEL_LABEL_NONE,
  PARSER_SOURCES,
  POLL_OUTCOMES,
  STATUS_FAMILIES,
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

/** Exact metric names required by specification section 23.2. */
export const METRIC_NAMES = {
  requestsTotal: "collectiviq_gateway_requests_total",
  requestDurationSeconds: "collectiviq_gateway_request_duration_seconds",
  activeRequests: "collectiviq_gateway_active_requests",
  queuedRequests: "collectiviq_gateway_queued_requests",
  upstreamRequestsTotal: "collectiviq_gateway_upstream_requests_total",
  upstreamRequestDurationSeconds: "collectiviq_gateway_upstream_request_duration_seconds",
  pollCount: "collectiviq_gateway_poll_count",
  pollDurationSeconds: "collectiviq_gateway_poll_duration_seconds",
  timeoutsTotal: "collectiviq_gateway_timeouts_total",
  errorsTotal: "collectiviq_gateway_errors_total",
  toolResponsesTotal: "collectiviq_gateway_tool_responses_total",
  toolParseFailuresTotal: "collectiviq_gateway_tool_parse_failures_total",
  toolSchemaFailuresTotal: "collectiviq_gateway_tool_schema_failures_total",
  streamConnections: "collectiviq_gateway_stream_connections",
  clientCancellationsTotal: "collectiviq_gateway_client_cancellations_total",
} as const;

/**
 * Fixed buckets covering the ~90 s upstream completion deadline, so a saturated
 * or timing-out completion lands in a real bucket instead of only in `+Inf`.
 */
export const REQUEST_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120, 180,
]);

/** One upstream call; starts finer because a single call should be sub-second. */
export const UPSTREAM_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 90,
]);

/** A whole completion's polling phase; starts at roughly one poll interval. */
export const POLL_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.5, 1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120, 180,
]);

export interface CapacitySnapshotSource {
  readonly activeCount: number;
  readonly queuedCount: number;
}

export interface RequestSample {
  readonly endpoint: EndpointLabel;
  readonly statusFamily: StatusFamily;
  /** A CONFIGURED virtual-model id, or `null` when none applies. */
  readonly model: string | null;
  readonly transport: TransportLabel;
  readonly durationSeconds: number;
  /** Present only for a request that returned a gateway error envelope. */
  readonly errorCategory: ErrorCategory | null;
}

export interface UpstreamSample {
  readonly operation: UpstreamOperation;
  readonly outcome: UpstreamOutcome;
  readonly durationSeconds: number;
}

export interface PollPhaseSample {
  readonly model: string | null;
  readonly outcome: PollOutcomeLabel;
  readonly durationSeconds: number;
  /** Number of `get_messages` attempts this completion issued. */
  readonly pollCount: number;
}

export interface ToolResponseSample {
  readonly model: string | null;
  readonly toolMode: ToolModeLabel;
  readonly parserSource: ParserSourceLabel;
}

export interface GatewayMetrics {
  /** `false` for the no-op implementation; callers may skip work when false. */
  readonly enabled: boolean;
  /** Prometheus exposition content type (empty string on the no-op). */
  readonly contentType: string;
  /** Register (or replace) the pull source backing the two capacity gauges. */
  bindCapacitySource(source: CapacitySnapshotSource): void;
  /** Settle ONE request: requests_total + request_duration_seconds, plus errors_total when `errorCategory` is set. */
  observeRequest(sample: RequestSample): void;
  observeClientCancellation(endpoint: EndpointLabel, transport: TransportLabel): void;
  observeUpstreamRequest(sample: UpstreamSample): void;
  /** Settle ONE completion's polling phase: poll_count += pollCount and poll_duration_seconds. */
  observePollPhase(sample: PollPhaseSample): void;
  observeTimeout(model: string | null): void;
  observeToolResponse(sample: ToolResponseSample): void;
  observeToolParseFailure(model: string | null): void;
  observeToolSchemaFailure(model: string | null): void;
  streamOpened(): void;
  streamClosed(): void;
  /** Render the exposition text (refreshing the pull-based capacity gauges first). */
  collect(): Promise<string>;
}

export interface MetricsOptions {
  /** The configured virtual-model ids; any other id collapses to `none`. */
  readonly modelIds: readonly string[];
}

const ENDPOINT_SET: ReadonlySet<string> = new Set(ENDPOINT_LABELS);
const STATUS_FAMILY_SET: ReadonlySet<string> = new Set(STATUS_FAMILIES);
const ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(ERROR_CATEGORIES);
const TRANSPORT_SET: ReadonlySet<string> = new Set(TRANSPORTS);
const UPSTREAM_OPERATION_SET: ReadonlySet<string> = new Set(UPSTREAM_OPERATIONS);
const UPSTREAM_OUTCOME_SET: ReadonlySet<string> = new Set(UPSTREAM_OUTCOMES);
const POLL_OUTCOME_SET: ReadonlySet<string> = new Set(POLL_OUTCOMES);
const TOOL_MODE_SET: ReadonlySet<string> = new Set(TOOL_MODE_LABELS);
const PARSER_SOURCE_SET: ReadonlySet<string> = new Set(PARSER_SOURCES);

/*
 * Values emitted when a label fails its closed-set re-check. `endpoint`,
 * `status_family`, and `error_category` have a designated `other` member. The
 * rest do not, so each fallback is chosen to be safe rather than plausible: a
 * transport defaults to the non-streamed path so the request is still counted,
 * an unrecognized outcome is reported as a failure rather than a success, a
 * tool response attributed to `disabled` is deliberately impossible and so
 * makes a fired fallback visible instead of blending into real emulated
 * traffic, and `desired-source` is the only parser fallback that cannot imply a
 * consensus vote that never happened. `operation` has no defensible stand-in —
 * every member names a real upstream call whose series is read during incident
 * diagnosis — so `observeUpstreamRequest` drops such an observation instead.
 */
const ENDPOINT_FALLBACK: EndpointLabel = "other";
const STATUS_FAMILY_FALLBACK: StatusFamily = "other";
const ERROR_CATEGORY_FALLBACK: ErrorCategory = "other";
const TRANSPORT_FALLBACK: TransportLabel = "json";
const UPSTREAM_OUTCOME_FALLBACK: UpstreamOutcome = "error";
const POLL_OUTCOME_FALLBACK: PollOutcomeLabel = "error";
const TOOL_MODE_FALLBACK: ToolModeLabel = "disabled";
const PARSER_SOURCE_FALLBACK: ParserSourceLabel = "desired-source";

/** Upper bound on one completion's reported poll attempts. */
const MAX_POLL_ATTEMPTS = 100_000;

/**
 * Re-check a caller-supplied label against its closed vocabulary. The parameter
 * is `unknown` on purpose: the compiler already constrains callers, and this is
 * the runtime half of the same guarantee for anything reaching the port through
 * untyped or compiled-away code.
 */
function boundedLabel<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: T,
): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback;
}

/** Non-finite and negative durations are recorded as zero, never skipped. */
function durationSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Poll attempts must be a bounded non-negative integer; `0` records nothing. */
function pollAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, MAX_POLL_ATTEMPTS);
}

/** Gauge inputs are coerced the same way as durations. */
function gaugeValue(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read the bound capacity source. Its counts are property getters on a live
 * controller, so the read itself is guarded and an unavailable source reports
 * zero rather than failing the scrape.
 */
function readCapacity(source: CapacitySnapshotSource | null): {
  readonly active: number;
  readonly queued: number;
} {
  if (source === null) return { active: 0, queued: 0 };
  try {
    return { active: gaugeValue(source.activeCount), queued: gaugeValue(source.queuedCount) };
  } catch {
    return { active: 0, queued: 0 };
  }
}

/** Run one observation; a telemetry defect must never fail a request. */
function record(action: () => void): void {
  try {
    action();
  } catch {
    // Deliberately swallowed: see the module docblock.
  }
}

export function createMetrics(options: MetricsOptions): GatewayMetrics {
  const registry = new Registry();
  // Empty ids are dropped so a blank configuration entry cannot become a label.
  const configuredModelIds: ReadonlySet<string> = new Set(
    options.modelIds.filter((id) => typeof id === "string" && id.length > 0),
  );

  const requestsTotal = new Counter({
    name: METRIC_NAMES.requestsTotal,
    help: "Settled gateway requests by endpoint, status family, virtual model, and transport.",
    labelNames: ["endpoint", "status_family", "model", "transport"] as const,
    registers: [registry],
  });

  const requestDurationSeconds = new Histogram({
    name: METRIC_NAMES.requestDurationSeconds,
    help: "End-to-end gateway request duration in seconds.",
    labelNames: ["endpoint", "status_family", "model", "transport"] as const,
    buckets: [...REQUEST_DURATION_BUCKETS_SECONDS],
    registers: [registry],
  });

  const activeRequests = new Gauge({
    name: METRIC_NAMES.activeRequests,
    help: "Completions holding process-local capacity right now.",
    registers: [registry],
  });

  const queuedRequests = new Gauge({
    name: METRIC_NAMES.queuedRequests,
    help: "Completions waiting in the process-local admission queue right now.",
    registers: [registry],
  });

  const upstreamRequestsTotal = new Counter({
    name: METRIC_NAMES.upstreamRequestsTotal,
    help: "CollectivIQ adapter calls by operation and terminal outcome.",
    labelNames: ["operation", "outcome"] as const,
    registers: [registry],
  });

  const upstreamRequestDurationSeconds = new Histogram({
    name: METRIC_NAMES.upstreamRequestDurationSeconds,
    help: "Duration of one CollectivIQ adapter call in seconds.",
    labelNames: ["operation", "outcome"] as const,
    buckets: [...UPSTREAM_DURATION_BUCKETS_SECONDS],
    registers: [registry],
  });

  const pollCount = new Counter({
    name: METRIC_NAMES.pollCount,
    help: "get_messages attempts issued while waiting for completions.",
    labelNames: ["model"] as const,
    registers: [registry],
  });

  const pollDurationSeconds = new Histogram({
    name: METRIC_NAMES.pollDurationSeconds,
    help: "Duration of one completion's whole polling phase in seconds.",
    labelNames: ["model", "outcome"] as const,
    buckets: [...POLL_DURATION_BUCKETS_SECONDS],
    registers: [registry],
  });

  const timeoutsTotal = new Counter({
    name: METRIC_NAMES.timeoutsTotal,
    help: "Completions that exhausted their total deadline.",
    labelNames: ["model"] as const,
    registers: [registry],
  });

  const errorsTotal = new Counter({
    name: METRIC_NAMES.errorsTotal,
    help: "Gateway error envelopes returned, by endpoint and public error code.",
    labelNames: ["endpoint", "error_category"] as const,
    registers: [registry],
  });

  const toolResponsesTotal = new Counter({
    name: METRIC_NAMES.toolResponsesTotal,
    help: "Model-proposed tool generations returned, by tool mode and parser path.",
    labelNames: ["model", "tool_mode", "parser_source"] as const,
    registers: [registry],
  });

  const toolParseFailuresTotal = new Counter({
    name: METRIC_NAMES.toolParseFailuresTotal,
    help: "Completions whose upstream answer yielded no valid required tool call.",
    labelNames: ["model"] as const,
    registers: [registry],
  });

  const toolSchemaFailuresTotal = new Counter({
    name: METRIC_NAMES.toolSchemaFailuresTotal,
    help: "Requests rejected because their submitted tool definitions failed validation.",
    labelNames: ["model"] as const,
    registers: [registry],
  });

  const streamConnections = new Gauge({
    name: METRIC_NAMES.streamConnections,
    help: "Open synthetic SSE responses right now.",
    registers: [registry],
  });

  const clientCancellationsTotal = new Counter({
    name: METRIC_NAMES.clientCancellationsTotal,
    help: "Requests abandoned by the client before a response completed.",
    labelNames: ["endpoint", "transport"] as const,
    registers: [registry],
  });

  let capacitySource: CapacitySnapshotSource | null = null;
  let openStreams = 0;

  function modelLabel(model: string | null): string {
    return typeof model === "string" && configuredModelIds.has(model) ? model : MODEL_LABEL_NONE;
  }

  return {
    enabled: true,
    contentType: registry.contentType,

    bindCapacitySource(source: CapacitySnapshotSource): void {
      capacitySource = source;
    },

    observeRequest(sample: RequestSample): void {
      record(() => {
        const labels = {
          endpoint: boundedLabel(sample.endpoint, ENDPOINT_SET, ENDPOINT_FALLBACK),
          status_family: boundedLabel(
            sample.statusFamily,
            STATUS_FAMILY_SET,
            STATUS_FAMILY_FALLBACK,
          ),
          model: modelLabel(sample.model),
          transport: boundedLabel(sample.transport, TRANSPORT_SET, TRANSPORT_FALLBACK),
        };
        requestsTotal.inc(labels);
        requestDurationSeconds.observe(labels, durationSeconds(sample.durationSeconds));

        const category = sample.errorCategory;
        if (typeof category === "string") {
          errorsTotal.inc({
            endpoint: labels.endpoint,
            error_category: boundedLabel(category, ERROR_CATEGORY_SET, ERROR_CATEGORY_FALLBACK),
          });
        }
      });
    },

    observeClientCancellation(endpoint: EndpointLabel, transport: TransportLabel): void {
      record(() => {
        clientCancellationsTotal.inc({
          endpoint: boundedLabel(endpoint, ENDPOINT_SET, ENDPOINT_FALLBACK),
          transport: boundedLabel(transport, TRANSPORT_SET, TRANSPORT_FALLBACK),
        });
      });
    },

    observeUpstreamRequest(sample: UpstreamSample): void {
      record(() => {
        if (!UPSTREAM_OPERATION_SET.has(sample.operation)) return;
        const labels = {
          operation: sample.operation,
          outcome: boundedLabel(sample.outcome, UPSTREAM_OUTCOME_SET, UPSTREAM_OUTCOME_FALLBACK),
        };
        upstreamRequestsTotal.inc(labels);
        upstreamRequestDurationSeconds.observe(labels, durationSeconds(sample.durationSeconds));
      });
    },

    observePollPhase(sample: PollPhaseSample): void {
      record(() => {
        const model = modelLabel(sample.model);
        const attempts = pollAttempts(sample.pollCount);
        if (attempts > 0) pollCount.inc({ model }, attempts);
        pollDurationSeconds.observe(
          {
            model,
            outcome: boundedLabel(sample.outcome, POLL_OUTCOME_SET, POLL_OUTCOME_FALLBACK),
          },
          durationSeconds(sample.durationSeconds),
        );
      });
    },

    observeTimeout(model: string | null): void {
      record(() => {
        timeoutsTotal.inc({ model: modelLabel(model) });
      });
    },

    observeToolResponse(sample: ToolResponseSample): void {
      record(() => {
        toolResponsesTotal.inc({
          model: modelLabel(sample.model),
          tool_mode: boundedLabel(sample.toolMode, TOOL_MODE_SET, TOOL_MODE_FALLBACK),
          parser_source: boundedLabel(
            sample.parserSource,
            PARSER_SOURCE_SET,
            PARSER_SOURCE_FALLBACK,
          ),
        });
      });
    },

    observeToolParseFailure(model: string | null): void {
      record(() => {
        toolParseFailuresTotal.inc({ model: modelLabel(model) });
      });
    },

    observeToolSchemaFailure(model: string | null): void {
      record(() => {
        toolSchemaFailuresTotal.inc({ model: modelLabel(model) });
      });
    },

    streamOpened(): void {
      record(() => {
        openStreams += 1;
        streamConnections.set(openStreams);
      });
    },

    streamClosed(): void {
      record(() => {
        // An unpaired close (a transport torn down twice) must not report a
        // negative number of open streams.
        if (openStreams > 0) openStreams -= 1;
        streamConnections.set(openStreams);
      });
    },

    async collect(): Promise<string> {
      // The capacity gauges are pull-based: the controller owns the counts and
      // this is the only moment they are copied into the registry.
      const snapshot = readCapacity(capacitySource);
      activeRequests.set(snapshot.active);
      queuedRequests.set(snapshot.queued);
      try {
        return await registry.metrics();
      } catch {
        // An empty exposition is a visible scrape failure; a rejected /metrics
        // response would not be more informative and can affect the caller.
        return "";
      }
    },
  };
}

/**
 * The disabled implementation. It holds no state and registers nothing, so it
 * is safe to share: `METRICS_ENABLED=false` must cost nothing beyond the call.
 */
const NOOP_METRICS: GatewayMetrics = Object.freeze({
  enabled: false,
  contentType: "",
  bindCapacitySource(): void {},
  observeRequest(): void {},
  observeClientCancellation(): void {},
  observeUpstreamRequest(): void {},
  observePollPhase(): void {},
  observeTimeout(): void {},
  observeToolResponse(): void {},
  observeToolParseFailure(): void {},
  observeToolSchemaFailure(): void {},
  streamOpened(): void {},
  streamClosed(): void {},
  collect(): Promise<string> {
    return Promise.resolve("");
  },
});

export function createNoopMetrics(): GatewayMetrics {
  return NOOP_METRICS;
}
