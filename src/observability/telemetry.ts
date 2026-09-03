/**
 * Telemetry composition (specification sections 23.2, 23.3, 31.3).
 *
 * Turns validated configuration into the two observability ports the rest of
 * the gateway depends on. Both are OFF by default, and "off" means genuinely
 * inert: no Prometheus registry, no tracer provider, no exporter, no timer, no
 * socket, and no per-request allocation.
 *
 * Ownership mirrors the Redis composition root:
 *
 *  - {@link createMetricsFromConfig} is PURE and socket-free (a private
 *    `@prometheus-io/client` registry is nothing but objects), so `buildServer` may build
 *    it on its default path exactly as it builds the model catalog.
 *  - {@link createTracingFromConfig} constructs an OTLP exporter, which is a
 *    live resource that must be flushed and shut down. Only the process
 *    composition root builds it, and only that root calls {@link
 *    TelemetryRuntime.close}.
 *
 * Telemetry is best-effort observability, never a correctness control: an
 * enabled-but-unwired tracer degrades to the no-op rather than failing
 * requests. That is the deliberate difference from the rate limiter and the
 * thread-reuse coordinator, whose absence must fail closed.
 */
import type { AppConfig } from "../config/schema.js";
import { createMetrics, createNoopMetrics, type GatewayMetrics } from "./metrics.js";
import { createNoopTracing, createTracing, type GatewayTracing } from "./tracing.js";

/** The two observability ports threaded through the application. */
export interface Telemetry {
  readonly metrics: GatewayMetrics;
  readonly tracing: GatewayTracing;
}

/** Telemetry plus the bounded close step owned by the process root. */
export interface TelemetryRuntime extends Telemetry {
  /**
   * Flush and release every telemetry resource. Bounded and NON-REJECTING by
   * contract: a failing or unreachable collector must never delay or fail
   * shutdown, and no dynamic exception text may escape.
   */
  close(): Promise<void>;
}

/** Fully inert telemetry: both ports are no-ops and nothing is constructed. */
export const DISABLED_TELEMETRY: Telemetry = Object.freeze({
  metrics: createNoopMetrics(),
  tracing: createNoopTracing(),
});

/**
 * Build the metrics port from validated configuration. Pure and socket-free;
 * returns the no-op when `METRICS_ENABLED` is false.
 */
export function createMetricsFromConfig(config: AppConfig): GatewayMetrics {
  if (!config.METRICS_ENABLED) return createNoopMetrics();
  return createMetrics({ modelIds: config.models.map((model) => model.id) });
}

/**
 * Build the tracing port from validated configuration. Returns the no-op when
 * `TRACING_ENABLED` is false, or (defensively) when configuration validation
 * somehow admitted an enabled tracer without an endpoint. Construction creates
 * the exporter but opens no connection — the first export does.
 */
export function createTracingFromConfig(config: AppConfig): GatewayTracing {
  if (!config.TRACING_ENABLED) return createNoopTracing();
  const endpoint = config.TRACING_OTLP_ENDPOINT;
  if (endpoint === undefined) return createNoopTracing();
  return createTracing({
    otlpEndpoint: endpoint,
    sampleRatio: config.TRACING_SAMPLE_RATIO,
    environment: config.ENVIRONMENT,
    modelIds: config.models.map((model) => model.id),
  });
}

/**
 * The telemetry `buildServer` uses when the process root injected none (tests,
 * the compiled-import smoke, and any in-process consumer).
 *
 * Metrics are honoured because building them is pure; tracing is deliberately
 * left as the no-op even when `TRACING_ENABLED=true`, because an exporter is a
 * live resource with a shutdown obligation and only the process root can
 * discharge it. Losing traces on that path is acceptable — telemetry is not a
 * correctness control — whereas silently owning an unflushed exporter is not.
 */
export function createServerDefaultTelemetry(config: AppConfig): Telemetry {
  return { metrics: createMetricsFromConfig(config), tracing: createNoopTracing() };
}

/**
 * Attach the bounded close step to a pair of already-built ports.
 *
 * Separate from {@link createTelemetryRuntime} so the lifecycle can be reasoned
 * about — and exercised — independently of how the ports were configured: the
 * close contract is a property of the ports it is handed, not of an `AppConfig`.
 */
export function composeTelemetryRuntime(telemetry: Telemetry): TelemetryRuntime {
  const { metrics, tracing } = telemetry;
  return {
    metrics,
    tracing,
    close: async (): Promise<void> => {
      // EVERYTHING sits inside the swallow, including the `enabled` read: this
      // method may not reject, and a port exposing `enabled` as an accessor would
      // otherwise leave exactly one statement able to break that promise.
      try {
        // Disabled tracing owns nothing to flush, so shutdown is SKIPPED rather
        // than delegated to a no-op: "an off port is never called" is the same
        // invariant the request path keeps, and it has to hold at shutdown too.
        if (!tracing.enabled) return;
        // `shutdown()` is bounded, idempotent, and non-rejecting by its own
        // contract; this catch is defence in depth so a future port can never
        // break the shutdown sequence, and it deliberately discards the value
        // without inspecting it.
        await tracing.shutdown();
      } catch {
        /* telemetry must never delay or fail shutdown */
      }
    },
  };
}

/**
 * Compose every enabled telemetry port for the process. Called once by the
 * composition root, which also owns {@link TelemetryRuntime.close}.
 */
export function createTelemetryRuntime(config: AppConfig): TelemetryRuntime {
  return composeTelemetryRuntime({
    metrics: createMetricsFromConfig(config),
    tracing: createTracingFromConfig(config),
  });
}
