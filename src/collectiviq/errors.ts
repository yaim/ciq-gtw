/**
 * Normalized upstream error model for the CollectivIQ adapter.
 *
 * These errors are the ONLY failure representation the adapter exposes. They
 * carry a closed category/code union, an optional safe raw HTTP status, and a
 * method-aware retryability hint. They never retain or expose raw response
 * bodies, headers, the API key, prompts, answers, `HTTPValidationError` fields
 * (`input`, `msg`, `ctx`, `detail`), paths, account/request/thread identifiers,
 * or model names.
 *
 * Retryability is advisory metadata (the adapter never auto-retries). It is
 * safe ONLY for idempotent reads: a failure is marked retryable only when the
 * request method is `GET` and the failure is a network error or one of the
 * selected transient statuses (502/503/504). A `POST`/`DELETE` failure is never
 * retryable, because after an ambiguous transmission the request may already
 * have taken effect upstream and we cannot prove it was never transmitted.
 *
 * The message is a fixed, generic string per category. The existing log
 * sanitizer (`sanitizeLogValue`) already reduces any Error to `{ name: "Error",
 * code? }`, so even if one of these is logged, only the safe `code` escapes.
 */

/** Closed set of normalized upstream failure categories. */
export type UpstreamErrorCategory =
  | "authentication"
  | "quota"
  | "validation"
  | "transient_http"
  | "network"
  | "timeout"
  | "cancellation"
  | "response_too_large"
  | "upstream_protocol"
  | "unexpected_upstream";

/** Closed set of stable, safe codes (searchable; no dynamic content). */
export type UpstreamErrorCode =
  | "upstream_authentication_failed"
  | "upstream_quota_exceeded"
  | "upstream_validation_failed"
  | "upstream_transient_http"
  | "upstream_network_error"
  | "upstream_timeout"
  | "request_cancelled"
  | "upstream_response_too_large"
  | "invalid_upstream_response"
  | "upstream_unexpected_error";

/** HTTP methods the adapter/transport issues. */
export type UpstreamHttpMethod = "GET" | "POST" | "DELETE";

/** Fixed, value-free code and message per category. */
const CATEGORY: Record<UpstreamErrorCategory, { code: UpstreamErrorCode; message: string }> = {
  authentication: {
    code: "upstream_authentication_failed",
    message: "Upstream authentication failed.",
  },
  quota: { code: "upstream_quota_exceeded", message: "Upstream quota exceeded." },
  validation: {
    code: "upstream_validation_failed",
    message: "Upstream rejected the request as invalid.",
  },
  transient_http: {
    code: "upstream_transient_http",
    message: "Upstream returned a transient error.",
  },
  network: { code: "upstream_network_error", message: "Upstream could not be reached." },
  timeout: { code: "upstream_timeout", message: "Upstream request timed out." },
  cancellation: { code: "request_cancelled", message: "The request was cancelled." },
  response_too_large: {
    code: "upstream_response_too_large",
    message: "Upstream response exceeded the allowed size.",
  },
  upstream_protocol: {
    code: "invalid_upstream_response",
    message: "Upstream returned a malformed response.",
  },
  unexpected_upstream: {
    code: "upstream_unexpected_error",
    message: "Upstream returned an unexpected failure.",
  },
};

/**
 * Method-aware retryability. Only an idempotent `GET` may be retried, and only
 * for a network error or a selected transient status. Every `POST`/`DELETE`
 * failure, and every non-transient category, is non-retryable. When the method
 * is unknown (an error not raised by the transport, e.g. a local guard), the
 * failure is treated as non-retryable.
 */
function computeRetryable(
  category: UpstreamErrorCategory,
  method: UpstreamHttpMethod | undefined,
): boolean {
  if (method !== "GET") return false;
  return category === "network" || category === "transient_http";
}

/**
 * Branded registry of the adapter's own {@link UpstreamError} instances.
 * Membership is tested by object IDENTITY via {@link isUpstreamError}, so a
 * caught value can be recognized WITHOUT `instanceof` — which would invoke a
 * hostile Proxy's `getPrototypeOf` trap — and without reading any property of an
 * untrusted thrown value.
 */
const upstreamErrors = new WeakSet<object>();

/** A normalized, content-free upstream failure. */
export class UpstreamError extends Error {
  readonly category: UpstreamErrorCategory;
  readonly code: UpstreamErrorCode;
  readonly retryable: boolean;
  /** Safe HTTP status when the failure carried one; otherwise undefined. */
  readonly rawStatus?: number;
  /** The request method, when known; drives {@link retryable}. */
  readonly method?: UpstreamHttpMethod;

  constructor(category: UpstreamErrorCategory, rawStatus?: number, method?: UpstreamHttpMethod) {
    const descriptor = CATEGORY[category];
    super(descriptor.message);
    this.name = "Error";
    this.category = category;
    this.code = descriptor.code;
    this.retryable = computeRetryable(category, method);
    if (typeof rawStatus === "number" && Number.isInteger(rawStatus)) {
      this.rawStatus = rawStatus;
    }
    if (method !== undefined) this.method = method;
    upstreamErrors.add(this);
  }
}

/**
 * True only for an adapter-created {@link UpstreamError}. Trap-safe: it reads no
 * property of `value` and never invokes `instanceof`, a prototype lookup,
 * serialization, or coercion, so an arbitrary thrown value (including a hostile
 * Proxy) is classified purely by identity. Callers must establish identity with
 * this guard BEFORE reading `category`, `retryable`, `rawStatus`, or `code`.
 */
export function isUpstreamError(value: unknown): value is UpstreamError {
  return typeof value === "object" && value !== null && upstreamErrors.has(value);
}

/**
 * Build an authentication/quota/validation/transient/etc. error from a status.
 * The method is carried through so retryability is decided once, here, rather
 * than re-inferred later.
 */
export function upstreamErrorForStatus(status: number, method?: UpstreamHttpMethod): UpstreamError {
  if (status === 401 || status === 403) return new UpstreamError("authentication", status, method);
  if (status === 429) return new UpstreamError("quota", status, method);
  if (status === 400 || status === 422) return new UpstreamError("validation", status, method);
  if (status === 502 || status === 503 || status === 504) {
    return new UpstreamError("transient_http", status, method);
  }
  return new UpstreamError("unexpected_upstream", status, method);
}

/**
 * Classify a thrown transport/fetch failure into a normalized category.
 * `cancelled`/`timedOut` disambiguate an `AbortError` that could be either
 * caller cancellation or a deadline. The method is carried through for
 * retryability. Never inspects the error's message.
 */
export function classifyTransportFailure(options: {
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly method?: UpstreamHttpMethod;
}): UpstreamError {
  if (options.cancelled) return new UpstreamError("cancellation", undefined, options.method);
  if (options.timedOut) return new UpstreamError("timeout", undefined, options.method);
  return new UpstreamError("network", undefined, options.method);
}
