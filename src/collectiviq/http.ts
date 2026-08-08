/**
 * Bounded, cancellation-aware HTTP transport for the CollectivIQ adapter.
 *
 * This is the sole bearer-attaching path for the production adapter's JSON
 * operations (the opt-in discovery SSE probe in `discovery.ts` attaches it
 * separately), and it never logs it. It composes caller cancellation with a
 * header deadline and a body deadline, reads the response body incrementally
 * against a byte cap
 * (never calling `response.json()` before the size is enforced), decodes strict
 * UTF-8, and requires a JSON content type for JSON operations. Every path
 * releases the reader, timers, and the caller-signal listener.
 *
 * Endpoint paths are fixed constants supplied by the adapter/discovery client;
 * callers outside this package cannot inject arbitrary paths or hosts.
 */
import { classifyTransportFailure, UpstreamError, upstreamErrorForStatus } from "./errors.js";
import type {
  CollectivIQTransportConfig,
  FetchLike,
  OperationTimeouts,
  TransportBase,
} from "./types.js";

export interface UpstreamJsonRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** Fixed path beginning with `/`. Never derived from external input. */
  readonly path: string;
  readonly query?: URLSearchParams;
  /** Request body (`URLSearchParams` or `FormData`); omit for GET/DELETE. */
  readonly body?: URLSearchParams | FormData;
  /** Explicit content type for urlencoded bodies; omit for `FormData`. */
  readonly bodyContentType?: string;
  readonly timeouts: OperationTimeouts;
  readonly signal?: AbortSignal;
}

export interface UpstreamJsonResponse {
  readonly status: number;
  readonly json: unknown;
}

/**
 * A bounded JSON body observation for the discovery-only path. Unlike
 * {@link UpstreamJsonResponse}, this is produced for ANY HTTP status and never
 * throws on a non-2xx status, a non-JSON content type, or unparseable JSON; in
 * those cases `json` is `undefined`. Size-cap, strict-UTF-8, and transport
 * failures still throw a normalized {@link UpstreamError}. It is internal to the
 * package (discovery use only) and is intentionally NOT re-exported.
 */
export interface UpstreamJsonObservation {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON for any status; undefined when the body was absent, non-JSON, or unparseable. */
  readonly json: unknown;
}

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** Join a validated base URL with a fixed path and optional query string. */
function buildUrl(baseUrl: string, path: string, query?: URLSearchParams): string {
  const base = baseUrl.replace(/\/+$/, "");
  const queryString = query && [...query.keys()].length > 0 ? `?${query.toString()}` : "";
  return `${base}${path}${queryString}`;
}

/** Cancel and discard a response body without parsing it. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The socket is being torn down; nothing safe or useful to surface.
  }
}

/**
 * Read a response body incrementally under a byte cap with strict UTF-8
 * decoding. Throws `UpstreamError("response_too_large")` when the cap is
 * exceeded and `UpstreamError("upstream_protocol")` on invalid UTF-8; a read
 * rejection (abort/reset) propagates raw for the caller to classify.
 */
async function readBoundedUtf8(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new UpstreamError("response_too_large", response.status);
      }
      try {
        out += decoder.decode(value, { stream: true });
      } catch {
        throw new UpstreamError("upstream_protocol", response.status);
      }
    }
    try {
      out += decoder.decode();
    } catch {
      throw new UpstreamError("upstream_protocol", response.status);
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The response of {@link beginBoundedRequest}: the received {@link Response}
 * plus the lifecycle handles both JSON paths share. `startBodyTimer` arms the
 * body deadline before reading, `classifyReadFailure` maps a body-read
 * rejection using the live cancel/timeout flags, and `cleanup` clears every
 * timer and removes the caller-signal listener; it must run exactly once.
 */
interface BoundedRequestContext {
  readonly response: Response;
  readonly controller: AbortController;
  readonly startBodyTimer: () => void;
  readonly classifyReadFailure: () => UpstreamError;
  readonly cleanup: () => void;
}

/**
 * Shared bounded transport core for the authenticated and unauthenticated JSON
 * paths. Builds the URL, composes caller cancellation with a header deadline,
 * attaches the accept header and an optional pre-resolved Authorization header
 * (`null` for the unauthenticated login path so credentials are never requested
 * recursively), performs the `redirect:"error"` fetch, and returns the response
 * with its lifecycle handles once headers arrive. A fetch failure is classified
 * and thrown after cleanup; header-timer teardown happens before returning.
 *
 * It takes only {@link TransportBase} (origin + injected fetch) and never reads
 * a credential itself: the caller acquires a lease and passes the header value.
 */
async function beginBoundedRequest(
  config: TransportBase,
  request: UpstreamJsonRequest,
  authHeader: string | null,
): Promise<BoundedRequestContext> {
  const fetchImpl: FetchLike = config.fetch ?? globalThis.fetch;
  const url = buildUrl(config.baseUrl, request.path, request.query);

  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();
  const startTimer = (ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    activeTimers.add(timer);
    return timer;
  };
  const stopTimer = (timer: ReturnType<typeof setTimeout>): void => {
    clearTimeout(timer);
    activeTimers.delete(timer);
  };

  const onCallerAbort = (): void => {
    cancelled = true;
    controller.abort();
  };
  const callerSignal = request.signal;
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const cleanup = (): void => {
    for (const timer of activeTimers) clearTimeout(timer);
    activeTimers.clear();
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  const headers: Record<string, string> = {
    accept: "application/json",
  };
  // Redaction depends on the header name being `authorization`. The login path
  // passes `null` so no Authorization header is attached.
  if (authHeader !== null) headers["authorization"] = authHeader;
  if (request.bodyContentType) headers["content-type"] = request.bodyContentType;

  const headerTimer = startTimer(request.timeouts.headerTimeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    cleanup();
    throw classifyTransportFailure({ cancelled, timedOut, method: request.method });
  }
  stopTimer(headerTimer);

  return {
    response,
    controller,
    startBodyTimer: () => {
      startTimer(request.timeouts.bodyTimeoutMs);
    },
    classifyReadFailure: () =>
      classifyTransportFailure({ cancelled, timedOut, method: request.method }),
    cleanup,
  };
}

/**
 * Complete the 2xx JSON read for an already-received response: enforce the JSON
 * content type, arm the body deadline, read under the size cap with strict
 * UTF-8, and parse. Runs `cleanup` exactly once on every path. Shared by the
 * authenticated and unauthenticated JSON request functions.
 */
async function completeJsonResponse(
  ctx: BoundedRequestContext,
  request: UpstreamJsonRequest,
): Promise<UpstreamJsonResponse> {
  const { response, controller, startBodyTimer, classifyReadFailure, cleanup } = ctx;

  const contentType = response.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    await discardBody(response);
    cleanup();
    throw new UpstreamError("upstream_protocol", response.status);
  }

  startBodyTimer();

  let text: string;
  try {
    text = await readBoundedUtf8(response, request.timeouts.maxResponseBytes, controller);
  } catch (error) {
    cleanup();
    if (error instanceof UpstreamError) throw error;
    throw classifyReadFailure();
  }
  cleanup();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError("upstream_protocol", response.status);
  }
  return { status: response.status, json };
}

/**
 * Perform an AUTHENTICATED JSON upstream request with full deadline, size, and
 * cancellation enforcement. Acquires a credential lease (honouring caller
 * cancellation), attaches its bearer token, and never replays the request. On a
 * `401` the lease is invalidated (so the next DISTINCT request obtains a fresh
 * token) before the normalized failure is thrown; a `403` never invalidates the
 * lease. Resolves with the parsed body only for a 2xx JSON response; every other
 * outcome throws a normalized {@link UpstreamError}. A non-2xx body is discarded
 * unread and never parsed or returned.
 */
export async function requestUpstreamJson(
  config: CollectivIQTransportConfig,
  request: UpstreamJsonRequest,
): Promise<UpstreamJsonResponse> {
  const lease = await config.credentials.acquire(request.signal);
  const ctx = await beginBoundedRequest(config, request, `Bearer ${lease.token}`);

  if (!ctx.response.ok) {
    await discardBody(ctx.response);
    ctx.cleanup();
    // A 401 invalidates the token lease used by THIS request; a 403 does not.
    // The request itself is never replayed here — the next distinct request may
    // reauthenticate.
    if (ctx.response.status === 401) config.credentials.invalidate(lease);
    throw upstreamErrorForStatus(ctx.response.status, request.method);
  }

  return completeJsonResponse(ctx, request);
}

/**
 * Perform an UNAUTHENTICATED bounded JSON request (the OAuth `POST /login`
 * exchange). No Authorization header is attached and no credential provider is
 * consulted, so a login can never recursively request credentials. Bounds,
 * size cap, strict UTF-8, JSON content type, and cancellation are enforced
 * identically to {@link requestUpstreamJson}. A non-2xx status throws a
 * normalized {@link UpstreamError} (never a raw body).
 */
export async function requestUnauthenticatedJson(
  base: TransportBase,
  request: UpstreamJsonRequest,
): Promise<UpstreamJsonResponse> {
  const ctx = await beginBoundedRequest(base, request, null);

  if (!ctx.response.ok) {
    await discardBody(ctx.response);
    ctx.cleanup();
    throw upstreamErrorForStatus(ctx.response.status, request.method);
  }

  return completeJsonResponse(ctx, request);
}

/**
 * Discovery-only bounded JSON observation. Reuses the same bounded transport
 * core as {@link requestUpstreamJson} but may parse a JSON body for ANY HTTP
 * status, so a probe can inspect error shapes. It never throws on a non-2xx
 * status, a non-JSON content type, or unparseable JSON — those yield
 * `json: undefined`. A size-cap overflow, a strict-UTF-8 violation, and an
 * aborted/reset/timed-out transport still throw a normalized
 * {@link UpstreamError}, and no raw text is ever placed in an error.
 */
export async function observeUpstreamJson(
  config: CollectivIQTransportConfig,
  request: UpstreamJsonRequest,
): Promise<UpstreamJsonObservation> {
  const lease = await config.credentials.acquire(request.signal);
  const { response, controller, startBodyTimer, classifyReadFailure, cleanup } =
    await beginBoundedRequest(config, request, `Bearer ${lease.token}`);
  const ok = response.ok;
  // A 401 observation invalidates the lease so the next distinct request
  // reauthenticates; the observation itself is still returned (never thrown),
  // and the request is never replayed.
  if (response.status === 401) config.credentials.invalidate(lease);

  const contentType = response.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    await discardBody(response);
    cleanup();
    return { status: response.status, ok, json: undefined };
  }

  startBodyTimer();

  let text: string;
  try {
    text = await readBoundedUtf8(response, request.timeouts.maxResponseBytes, controller);
  } catch (error) {
    cleanup();
    if (error instanceof UpstreamError) throw error;
    throw classifyReadFailure();
  }
  cleanup();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: response.status, ok, json: undefined };
  }
  return { status: response.status, ok, json };
}
