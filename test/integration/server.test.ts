import { afterEach, describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createReadinessState } from "../../src/api/health-route.js";
import type { AppConfig } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-fake-secret-key";
const UPSTREAM_KEY = "sk-fake-upstream-secret";

const config: AppConfig = {
  ENVIRONMENT: "development",
  HOST: "127.0.0.1",
  PORT: 8787,
  COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
  COLLECTIVIQ_AUTH_MODE: "bearer",
  COLLECTIVIQ_API_KEY: UPSTREAM_KEY,
  COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY],
  MODEL_CONFIG_PATH: "./config/models.yaml",
  LOG_LEVEL: "info",
  LOG_CONTENT: false,
  MAX_REQUEST_BODY_BYTES: 8_388_608,
  MAX_CONCURRENT_REQUESTS: 4,
  MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
  MAX_QUEUED_REQUESTS: 20,
  MAX_QUEUE_WAIT_MS: 5_000,
  SHUTDOWN_DRAIN_MS: 30_000,
  IDEMPOTENCY_TTL_MS: 600_000,
  REDIS_KEY_PREFIX: "collectiviq-gateway",
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_REQUESTS: 60,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_BURST: 8,
  OPENCODE_THREAD_REUSE_ENABLED: false,
  OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
  models: [],
};

let app: GatewayServer | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

/** Build a server using the real application logger, capturing its output. */
function buildWithCapturedLogs(ready: boolean): { server: GatewayServer; lines: string[] } {
  const lines: string[] = [];
  const stream: DestinationStream = { write: (chunk: string) => lines.push(chunk) };
  const logger = createLogger({ LOG_LEVEL: config.LOG_LEVEL }, stream);
  const readiness = createReadinessState(ready);
  const server = buildServer({ config, readiness, logger });
  return { server, lines };
}

describe("health and readiness routes", () => {
  it("returns the exact liveness body with JSON content type", async () => {
    const readiness = createReadinessState(false);
    app = buildServer({ config, readiness });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports 503 not_ready before readiness is set", async () => {
    const readiness = createReadinessState(false);
    app = buildServer({ config, readiness });

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
  });

  it("reports 200 ready once readiness is set", async () => {
    const readiness = createReadinessState(false);
    app = buildServer({ config, readiness });
    readiness.setReady(true);

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("does not open a real listening socket when constructed", async () => {
    const readiness = createReadinessState(false);
    app = buildServer({ config, readiness });
    await app.ready();
    expect(app.server.listening).toBe(false);
  });

  it("keeps credentials out of logs across requests", async () => {
    const { server, lines } = buildWithCapturedLogs(true);
    app = server;

    await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    });
    await app.inject({ method: "GET", url: "/readyz" });

    const output = lines.join("");
    expect(output).not.toContain(GATEWAY_KEY);
    expect(output).not.toContain(UPSTREAM_KEY);
  });
});
