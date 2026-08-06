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
import type { CollectivIQTransportConfig, FetchLike, OperationTimeouts } from "./types.js";

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
 * Shared bounded transport core for both JSON paths. Builds the URL, composes
 * caller cancellation with a header deadline, attaches the bearer/accept
 * headers, performs the `redirect:"error"` fetch, and returns the response with
 * its lifecycle handles once headers arrive. A fetch failure is classified and
 * thrown after cleanup; header-timer teardown happens before returning.
 */
async function beginBoundedRequest(
  config: CollectivIQTransportConfig,
  request: UpstreamJsonRequest,
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
    // Redaction depends on the header name being `authorization`.
    authorization: `Bearer ${config.apiKey}`,
    accept: "application/json",
  };
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
 * Perform a JSON upstream request with full deadline, size, and cancellation
 * enforcement. Resolves with the parsed body only for a 2xx JSON response;
 * every other outcome throws a normalized {@link UpstreamError}. A non-2xx
 * body is discarded unread and never parsed or returned.
 */
export async function requestUpstreamJson(
  config: CollectivIQTransportConfig,
  request: UpstreamJsonRequest,
): Promise<UpstreamJsonResponse> {
  const { response, controller, startBodyTimer, classifyReadFailure, cleanup } =
    await beginBoundedRequest(config, request);

  if (!response.ok) {
    await discardBody(response);
    cleanup();
    throw upstreamErrorForStatus(response.status, request.method);
  }

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
  const { response, controller, startBodyTimer, classifyReadFailure, cleanup } =
    await beginBoundedRequest(config, request);
  const ok = response.ok;

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
