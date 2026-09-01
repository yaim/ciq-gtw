import { Type } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";

/** Read-only readiness view consumed by the readiness route. */
export interface ReadinessState {
  isReady(): boolean;
}

/**
 * A bounded, synchronous dependency probe (specification section 28.2).
 *
 * A probe must return a FIXED, already-known safe state: it may not perform
 * I/O, block, or throw. A probe that throws is treated as not ready. Probes are
 * used only for dependencies the instance genuinely cannot serve without — an
 * optional, disabled dependency simply registers no probe. CollectivIQ is
 * deliberately NOT a probe: an upstream outage may be temporary and must not
 * make the instance unready.
 */
export interface ReadinessProbe {
  isReady(): boolean;
}

/** Readiness state with lifecycle setters, owned by the process composition root. */
export interface MutableReadinessState extends ReadinessState {
  /** Record whether the listener/local state is serving. */
  setReady(ready: boolean): void;
  /**
   * Latch the instance permanently not-ready. Shutdown always forces
   * not-ready, and no later dependency recovery can flip it back.
   */
  markShuttingDown(): void;
}

/** Optional construction inputs for {@link createReadinessState}. */
export interface ReadinessOptions {
  /**
   * Dependency probes that must ALL report ready. An empty/omitted list keeps
   * the pre-Phase-4A behaviour (the local flag alone decides).
   */
  readonly dependencies?: readonly ReadinessProbe[];
}

/** Evaluate one probe defensively; any anomaly counts as not ready. */
function probeReady(probe: ReadinessProbe): boolean {
  try {
    return probe.isReady() === true;
  } catch {
    return false;
  }
}

/**
 * Create the readiness view: not ready until explicitly marked, never ready
 * once shutting down, and ready only while every registered dependency probe
 * also reports ready.
 */
export function createReadinessState(
  initial = false,
  options: ReadinessOptions = {},
): MutableReadinessState {
  const dependencies = options.dependencies ?? [];
  let ready = initial;
  let shuttingDown = false;
  return {
    isReady: () => {
      if (shuttingDown || !ready) return false;
      for (const dependency of dependencies) {
        if (!probeReady(dependency)) return false;
      }
      return true;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    markShuttingDown: () => {
      shuttingDown = true;
      ready = false;
    },
  };
}

const HealthzResponse = Type.Object({ status: Type.Literal("ok") });
const ReadyResponse = Type.Object({ status: Type.Literal("ready") });
const NotReadyResponse = Type.Object({ status: Type.Literal("not_ready") });

/**
 * Register liveness and readiness routes.
 *
 * Neither route calls CollectivIQ or any dependency, and neither returns
 * configuration values or credentials. Responses are fixed, bounded JSON.
 */
export function registerHealthRoutes(app: GatewayServer, readiness: ReadinessState): void {
  app.get(
    "/healthz",
    { schema: { response: { 200: HealthzResponse } } },
    () => ({ status: "ok" }) as const,
  );

  app.get(
    "/readyz",
    { schema: { response: { 200: ReadyResponse, 503: NotReadyResponse } } },
    (_request, reply) => {
      if (readiness.isReady()) {
        return { status: "ready" } as const;
      }
      reply.code(503);
      return { status: "not_ready" } as const;
    },
  );
}
