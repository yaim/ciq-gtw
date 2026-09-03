/**
 * `GET /metrics` — the Prometheus exposition endpoint (specification sections
 * 8.1, 23.2).
 *
 * Registered on the ROOT instance, outside the authenticated `/v1` group, and
 * ONLY when `METRICS_ENABLED=true`. When metrics are disabled the route does not
 * exist at all, so the endpoint returns the framework `404` rather than an empty
 * or misleading body.
 *
 * The endpoint carries NO application authentication. That is a deliberate,
 * documented decision: a Prometheus scrape credential would be a second secret
 * to distribute and rotate, and the process cannot verify whether the interface
 * it is bound to is private. Operators MUST therefore isolate it with loopback
 * binding, a private network, or firewall rules (specification sections 21.2,
 * 31.2). The exposition itself is bounded, closed-label operational data — it
 * contains no prompt, answer, path, tool, credential, or identifier — but it
 * does disclose traffic volumes, latencies, error categories, and the
 * configured virtual-model ids, which is exactly why it needs isolation.
 */
import type { GatewayServer } from "../server.js";
import type { GatewayMetrics } from "../observability/metrics.js";

/** Register the unauthenticated metrics endpoint on the root instance. */
export function registerMetricsRoute(app: GatewayServer, metrics: GatewayMetrics): void {
  app.get("/metrics", async (_request, reply) => {
    const body = await metrics.collect();
    // Scrapes must never be cached by an intermediary, and the exposition
    // content type is owned by the registry so it stays version-correct. The
    // fallback only applies to a no-op port, which cannot occur while the route
    // is registered; it exists so a future wiring mistake still sends a valid
    // header rather than an empty one.
    reply.header("cache-control", "no-store");
    reply.type(metrics.contentType === "" ? "text/plain; charset=utf-8" : metrics.contentType);
    return body;
  });
}
