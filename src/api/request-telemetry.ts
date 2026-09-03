/**
 * Per-request telemetry at the API lifecycle (specification sections 23.2,
 * 23.3).
 *
 * This module is the SINGLE owner of four signals — `requests_total`,
 * `request_duration_seconds`, `errors_total`, and
 * `client_cancellations_total` — plus the root `gateway.request` span. Nothing
 * else in the gateway may emit them, which is what makes "exactly once per
 * request" a structural property rather than a convention.
 *
 * Settlement is driven from the raw Node response rather than Fastify's
 * `onResponse` hook, because the streamed completion path hijacks the reply and
 * may be force-destroyed without ever being "sent". A `ServerResponse` always
 * emits `finish` (it was ended) or `close` (it was destroyed), so listening for
 * both — behind a one-shot guard — settles a JSON reply, a fully delivered SSE
 * stream, an SSE stream cut short by a disconnect, and a force-closed socket
 * exactly once each.
 *
 * A client disconnect is recognised as a `close` with nothing ended, so it is
 * likewise recorded at most once, on either transport.
 *
 * Everything recorded here is closed metadata: a route TEMPLATE (never the
 * request URL or its parameters), a status family, a configured virtual-model
 * id, the transport, and a gateway-constructed error code. The thrown value
 * behind a failure is never inspected.
 */
import type { GatewayServer } from "../server.js";
import {
  toEndpointLabel,
  toStatusFamily,
  type EndpointLabel,
  type ErrorCategory,
  type TransportLabel,
} from "../observability/labels.js";
import type { GatewaySpan } from "../observability/tracing.js";
import type { Telemetry } from "../observability/telemetry.js";
import { elapsedSeconds } from "../shared/elapsed.js";

/** The per-request handle routes use to enrich and fail-mark their request. */
export interface RequestTelemetry {
  /** The closed endpoint template this request was routed to. */
  readonly endpoint: EndpointLabel;
  /**
   * The root `gateway.request` span, or `null` when tracing is disabled.
   *
   * Deliberately nullable rather than a shared no-op span: a caller must be able
   * to skip building span options and child spans entirely, which it cannot do
   * if every request appears to have a span.
   */
  readonly span: GatewaySpan | null;
  /** Record the resolved virtual model (only after successful validation). */
  setModel(modelId: string): void;
  /** Record which transport served the response (`json` by default). */
  setTransport(transport: TransportLabel): void;
  /**
   * Record the CLOSED category of the public error envelope being returned.
   * Last call wins, and the category always comes from an envelope the gateway
   * itself constructed — never from inspecting a thrown value.
   */
  recordError(category: ErrorCategory): void;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Per-request telemetry handle, assigned by the root hook, or `null`
     * whenever telemetry is disabled.
     *
     * There is deliberately NO shared no-op handle to fall back on. A no-op
     * object would make every call site look harmless while still invoking a
     * method on every authentication failure, model miss, and error envelope —
     * telemetry-shaped work on a path that is supposed to be inert. Callers
     * therefore reach it through {@link requestTelemetry} and use optional
     * access, so a disabled request performs one nullish check and nothing else.
     */
    telemetry: RequestTelemetry | null;
  }
}

/**
 * The request's telemetry handle, or `null` when telemetry is disabled.
 *
 * Always call through optional access (`requestTelemetry(request)?.…`): the
 * `null` result is the mechanism that keeps a disabled request free of
 * telemetry calls, not an inconvenience to paper over with a no-op.
 */
export function requestTelemetry(request: {
  telemetry: RequestTelemetry | null;
}): RequestTelemetry | null {
  return request.telemetry;
}

/**
 * Register the root request-telemetry hook.
 *
 * When BOTH ports are disabled nothing is installed beyond the decorator
 * default: no hook runs, no listener is attached, and no object is allocated
 * per request.
 */
export function registerRequestTelemetry(app: GatewayServer, telemetry: Telemetry): void {
  app.decorateRequest("telemetry", null);

  const { metrics, tracing } = telemetry;
  if (!metrics.enabled && !tracing.enabled) return;

  // Resolved once, at registration, so the per-request path branches on a
  // boolean instead of calling into a port that would do nothing.
  const metricsOn = metrics.enabled;
  const tracingOn = tracing.enabled;

  app.addHook("onRequest", (request, reply, done) => {
    // Only metrics need a duration, so the clock is read only for metrics.
    const startNs = metricsOn ? process.hrtime.bigint() : 0n;
    // The route TEMPLATE, never `request.url`: a raw path would put arbitrary
    // client-controlled text into a label.
    const endpoint = toEndpointLabel(request.routeOptions.url);
    const span = tracingOn
      ? tracing.startSpan("gateway.request", { attributes: { endpoint } })
      : null;

    let model: string | null = null;
    let transport: TransportLabel = "json";
    let errorCategory: ErrorCategory | null = null;
    let settled = false;
    // Tracked independently of metrics: the SPAN needs to know the client went
    // away even when only tracing is enabled.
    let clientGone = false;

    const handle: RequestTelemetry = {
      endpoint,
      span,
      setModel: (modelId: string): void => {
        model = modelId;
      },
      setTransport: (value: TransportLabel): void => {
        transport = value;
      },
      recordError: (category: ErrorCategory): void => {
        errorCategory = category;
      },
    };
    request.telemetry = handle;

    const res = reply.raw;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      const statusFamily = toStatusFamily(res.statusCode);
      // A failing response always contributes to `errors_total`. Routes that
      // report their envelope's code give it a precise category; anything else
      // that ended 4xx/5xx still counts, as `other`, so no error can go
      // unobserved just because a call site was missed.
      const metricCategory: ErrorCategory | null =
        errorCategory ?? (statusFamily === "4xx" || statusFamily === "5xx" ? "other" : null);
      if (metricsOn) {
        metrics.observeRequest({
          endpoint,
          statusFamily,
          model,
          transport,
          durationSeconds: elapsedSeconds(startNs),
          errorCategory: metricCategory,
        });
      }
      if (span !== null) {
        span.setAttributes({
          statusFamily,
          transport,
          ...(model !== null ? { model } : {}),
        });
        // A request the client abandoned did not succeed, even though its status
        // line may still read `200` — on the streamed path the header is
        // committed long before the body. The span is therefore marked failed
        // with the closed fallback, while `errors_total` deliberately does NOT
        // gain a synthetic error: a disconnect is already counted by
        // `client_cancellations_total`, and inventing a gateway error for it
        // would misreport the service's own failure rate.
        const spanCategory: ErrorCategory | null = metricCategory ?? (clientGone ? "other" : null);
        if (spanCategory !== null) span.setError(spanCategory);
        span.end();
      }
    };

    function onFinish(): void {
      settle();
    }

    function onClose(): void {
      // A close with nothing ended is a client that went away mid-response —
      // the same condition the completion route treats as a disconnect. The
      // flag is set before `settle()` so the span can be marked failed, and it
      // is one-shot so the counter cannot move twice.
      if (!res.writableEnded && !clientGone) {
        clientGone = true;
        if (metricsOn) metrics.observeClientCancellation(endpoint, transport);
      }
      settle();
    }

    res.once("finish", onFinish);
    res.once("close", onClose);
    done();
  });
}
