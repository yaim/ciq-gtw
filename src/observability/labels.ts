/**
 * Closed telemetry label vocabularies (specification section 23.2).
 *
 * Every dimension a metric or span attribute may carry is enumerated here, and
 * every mapping function is TOTAL: an unrecognized input collapses to a fixed
 * fallback member rather than becoming a new label value. That is the single
 * mechanism keeping metric cardinality bounded and keeping request-, thread-,
 * session-, and tool-derived values out of telemetry entirely.
 *
 * Nothing in this module may accept a free-form string into an emitted value.
 * Raw paths, URLs, prompts, answers, tool names/arguments/results, credentials,
 * gateway keys or scopes, idempotency keys, identifiers of any kind, and
 * exception text are all excluded by construction: the only string that can be
 * emitted is a member of one of the frozen arrays below, or a configured
 * virtual-model id, which the metrics registry additionally re-checks against
 * the ids it was constructed with.
 */

/**
 * Endpoint TEMPLATES the gateway registers. A request whose route template is
 * unknown (a 404, or a route added without updating this list) is reported as
 * `other`, so a hostile or mistyped path can never create a new series.
 */
export const ENDPOINT_LABELS = [
  "/healthz",
  "/readyz",
  "/metrics",
  "/v1/models",
  "/v1/models/:model",
  "/v1/chat/completions",
  "/v1/opencode/session-title",
  "other",
] as const;
export type EndpointLabel = (typeof ENDPOINT_LABELS)[number];

const ENDPOINT_LABEL_SET: ReadonlySet<string> = new Set(ENDPOINT_LABELS);

/**
 * Map a Fastify route TEMPLATE (`request.routeOptions.url`, never the raw URL)
 * to a closed label. Anything absent or unrecognized becomes `other`.
 */
export function toEndpointLabel(routeTemplate: string | undefined): EndpointLabel {
  if (routeTemplate === undefined) return "other";
  return ENDPOINT_LABEL_SET.has(routeTemplate) ? (routeTemplate as EndpointLabel) : "other";
}

/** HTTP status families (specification section 23.2). */
export const STATUS_FAMILIES = ["2xx", "4xx", "5xx", "other"] as const;
export type StatusFamily = (typeof STATUS_FAMILIES)[number];

/** Reduce a numeric status to its family; anything unexpected becomes `other`. */
export function toStatusFamily(status: number): StatusFamily {
  if (!Number.isFinite(status)) return "other";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

/**
 * The closed set of public OpenAI error `code` values the gateway can emit
 * (`src/openai/errors.ts`), used directly as the error category. Using the code
 * keeps capacity, rate-limit, idempotency, and thread-reuse failures
 * individually distinguishable without inventing a second taxonomy that could
 * drift from the public contract.
 *
 * The category is always read from an envelope the gateway itself constructed —
 * never from an inspected thrown value — and any value outside this list
 * collapses to `other`.
 */
export const ERROR_CATEGORIES = [
  "invalid_api_key",
  "model_not_found",
  "internal_error",
  "invalid_request",
  "unsupported_content_type",
  "context_length_exceeded",
  "request_too_large",
  "gateway_capacity_exceeded",
  "upstream_quota_exceeded",
  "upstream_authentication_failed",
  "invalid_upstream_response",
  "upstream_request_failed",
  "invalid_tool_response",
  "completion_timeout",
  "service_unavailable",
  "invalid_idempotency_key",
  "idempotency_key_conflict",
  "idempotency_unavailable",
  "gateway_rate_limit_exceeded",
  "rate_limit_unavailable",
  "invalid_opencode_session_id",
  "unsupported_parameter",
  "thread_reuse_busy",
  "thread_reuse_unavailable",
  "other",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(ERROR_CATEGORIES);

/** Map a gateway-constructed public error code to a closed category. */
export function toErrorCategory(code: string): ErrorCategory {
  return ERROR_CATEGORY_SET.has(code) ? (code as ErrorCategory) : "other";
}

/** The upstream CollectivIQ operations the adapter exposes. */
export const UPSTREAM_OPERATIONS = [
  "create_thread",
  "process_message",
  "get_messages",
  "get_threads",
] as const;
export type UpstreamOperation = (typeof UPSTREAM_OPERATIONS)[number];

/** Terminal outcome of one upstream operation or polling phase. */
export const UPSTREAM_OUTCOMES = ["success", "error", "cancelled"] as const;
export type UpstreamOutcome = (typeof UPSTREAM_OUTCOMES)[number];

/** Terminal outcome of a completion's whole polling phase. */
export const POLL_OUTCOMES = ["answer", "timeout", "error", "cancelled"] as const;
export type PollOutcomeLabel = (typeof POLL_OUTCOMES)[number];

/** The response transport a completion used. */
export const TRANSPORTS = ["json", "sse"] as const;
export type TransportLabel = (typeof TRANSPORTS)[number];

/** Virtual-model tool policy (mirrors `TOOL_MODES` in `src/config/schema.ts`). */
export const TOOL_MODE_LABELS = ["disabled", "emulated", "native"] as const;
export type ToolModeLabel = (typeof TOOL_MODE_LABELS)[number];

/**
 * Which parser path produced a tool generation. Mirrors `ToolParseSource` in
 * `src/tools/types.ts`; kept as an independent closed list so the observability
 * boundary never imports the tool engine.
 */
export const PARSER_SOURCES = [
  "desired-source",
  "individual-consensus",
  "individual-single",
] as const;
export type ParserSourceLabel = (typeof PARSER_SOURCES)[number];

const PARSER_SOURCE_SET: ReadonlySet<string> = new Set(PARSER_SOURCES);

/** Map a tool-parse source to a closed label, or `null` when unrecognized. */
export function toParserSource(source: string): ParserSourceLabel | null {
  return PARSER_SOURCE_SET.has(source) ? (source as ParserSourceLabel) : null;
}

/**
 * Label used whenever no CONFIGURED virtual model applies to a request — a
 * health check, a model-metadata read, a request rejected before resolution, or
 * (defensively) an id the metrics registry was not constructed with. It is
 * deliberately a single fallback so an unrecognized id can never create a
 * series of its own.
 */
export const MODEL_LABEL_NONE = "none";

/** Fixed service identity reported on every span. Never derived from input. */
export const TELEMETRY_SERVICE_NAME = "collectiviq-gateway";
