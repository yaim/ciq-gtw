import { Type } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";

/** Read-only readiness view consumed by the readiness route. */
export interface ReadinessState {
  isReady(): boolean;
}

/** Readiness state with a setter, owned by the process composition root. */
export interface MutableReadinessState extends ReadinessState {
  setReady(ready: boolean): void;
}

/** Create an in-memory readiness flag, not ready until explicitly marked. */
export function createReadinessState(initial = false): MutableReadinessState {
  let ready = initial;
  return {
    isReady: () => ready,
    setReady: (value: boolean) => {
      ready = value;
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
