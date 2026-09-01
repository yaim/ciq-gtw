import { afterEach, describe, expect, it, vi } from "vitest";
import type { DestinationStream } from "pino";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createReadinessState } from "../../src/api/health-route.js";
import type { ModelCatalog } from "../../src/generation/model-catalog.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY_A = "gw-fake-secret-alpha";
const GATEWAY_KEY_B = "gw-fake-secret-bravo";
const UPSTREAM_KEY = "sk-fake-upstream-secret";
const CREATED = 1_785_933_840;

function model(id: string): VirtualModel {
  return {
    id,
    displayName: `Display ${id}`,
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
    promptMode: "protocol",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 2_048,
  };
}

// Includes an id with an internal space so the URL-encoded path segment case is
// exercised (it must still resolve after Fastify decodes it).
const MODELS: readonly VirtualModel[] = [
  model("collectiviq-consensus"),
  model("collectiviq-coder"),
  model("collectiviq fast"),
];

const config: AppConfig = {
  ENVIRONMENT: "development",
  HOST: "127.0.0.1",
  PORT: 8787,
  COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
  COLLECTIVIQ_AUTH_MODE: "bearer",
  COLLECTIVIQ_API_KEY: UPSTREAM_KEY,
  COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_A, GATEWAY_KEY_B],
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
  models: MODELS,
};

let app: GatewayServer | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function build(overrides: { catalog?: ModelCatalog } = {}): GatewayServer {
  const readiness = createReadinessState(true);
  return buildServer({ config, readiness, now: () => CREATED, ...overrides });
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe("health routes remain unauthenticated", () => {
  it("serves /healthz and /readyz without credentials", async () => {
    app = build();
    const healthz = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual({ status: "ok" });

    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toEqual({ status: "ready" });
  });
});

describe("GET /v1/models — authentication", () => {
  const fixed401 = {
    error: {
      message: "Invalid gateway API key.",
      type: "authentication_error",
      param: null,
      code: "invalid_api_key",
    },
  };

  it("returns the same fixed 401 for missing/invalid credentials", async () => {
    app = build();
    const cases: (Record<string, string> | undefined)[] = [
      undefined, // no header
      { authorization: "" }, // empty header
      { authorization: GATEWAY_KEY_A }, // no scheme
      { authorization: "Bearer " }, // empty token
      { authorization: "Basic " + GATEWAY_KEY_A }, // wrong scheme
      { authorization: "Bearer gw-wrong" }, // wrong token
      { authorization: `Bearer ${GATEWAY_KEY_A} ` }, // trailing whitespace
      { authorization: `Bearer ${"a".repeat(9000)}` }, // oversized token
    ];
    for (const headers of cases) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        ...(headers ? { headers } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual(fixed401);
    }
  });

  it("rejects /v1/models/:model without valid credentials", async () => {
    app = build();
    const response = await app.inject({ method: "GET", url: "/v1/models/collectiviq-coder" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(fixed401);
  });

  it("accepts every configured gateway key on both endpoints", async () => {
    app = build();
    for (const key of [GATEWAY_KEY_A, GATEWAY_KEY_B]) {
      const list = await app.inject({ method: "GET", url: "/v1/models", headers: auth(key) });
      expect(list.statusCode).toBe(200);
      const one = await app.inject({
        method: "GET",
        url: "/v1/models/collectiviq-coder",
        headers: auth(key),
      });
      expect(one.statusCode).toBe(200);
    }
  });
});

describe("GET /v1/models — success shapes", () => {
  it("lists models in configuration order with the exact shape", async () => {
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: auth(GATEWAY_KEY_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "collectiviq-consensus",
          object: "model",
          created: CREATED,
          owned_by: "collectiviq-gateway",
        },
        {
          id: "collectiviq-coder",
          object: "model",
          created: CREATED,
          owned_by: "collectiviq-gateway",
        },
        {
          id: "collectiviq fast",
          object: "model",
          created: CREATED,
          owned_by: "collectiviq-gateway",
        },
      ],
    });
  });

  it("retrieves a single model with the exact shape", async () => {
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/models/collectiviq-consensus",
      headers: auth(GATEWAY_KEY_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      id: "collectiviq-consensus",
      object: "model",
      created: CREATED,
      owned_by: "collectiviq-gateway",
    });
  });

  it("resolves a URL-encoded model path segment per the id contract", async () => {
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/models/collectiviq%20fast",
      headers: auth(GATEWAY_KEY_A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "collectiviq fast", object: "model" });
  });
});

describe("GET /v1/models/:model — not found", () => {
  const fixed404 = {
    error: {
      message: "The requested model does not exist.",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };

  it("returns the exact 404 for an unknown id", async () => {
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/models/does-not-exist",
      headers: auth(GATEWAY_KEY_A),
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(fixed404);
  });

  it("returns the exact 404 for a case-mismatched id without reflecting it", async () => {
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/models/Collectiviq-Consensus",
      headers: auth(GATEWAY_KEY_A),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(fixed404);
    expect(response.body).not.toContain("Collectiviq-Consensus");
  });
});

describe("GET /v1 — internal error boundary", () => {
  it("maps an injected catalog failure to the fixed 500 envelope", async () => {
    const failing: ModelCatalog = {
      created: CREATED,
      list: () => {
        throw new Error("boom-should-never-surface");
      },
      resolve: () => {
        throw new Error("boom-should-never-surface");
      },
      resolveModel: () => {
        throw new Error("boom-should-never-surface");
      },
    };
    app = build({ catalog: failing });
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: auth(GATEWAY_KEY_A),
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      error: {
        message: "The gateway encountered an internal error.",
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    });
    expect(response.body).not.toContain("boom-should-never-surface");
  });
});

describe("logging and network safety", () => {
  it("keeps credentials out of logs across authenticated and rejected requests", async () => {
    const lines: string[] = [];
    const stream: DestinationStream = { write: (chunk: string) => lines.push(chunk) };
    const logger = createLogger({ LOG_LEVEL: config.LOG_LEVEL }, stream);
    const readiness = createReadinessState(true);
    app = buildServer({ config, readiness, logger, now: () => CREATED });

    await app.inject({ method: "GET", url: "/v1/models", headers: auth(GATEWAY_KEY_A) });
    await app.inject({ method: "GET", url: "/v1/models", headers: auth("gw-wrong") });
    await app.inject({ method: "GET", url: "/v1/models" });

    const output = lines.join("");
    expect(output).not.toContain(GATEWAY_KEY_A);
    expect(output).not.toContain(GATEWAY_KEY_B);
    expect(output).not.toContain(UPSTREAM_KEY);
  });

  it("opens no socket and performs no upstream request when built or serving", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    app = build();
    await app.ready();
    expect(app.server.listening).toBe(false);

    await app.inject({ method: "GET", url: "/v1/models", headers: auth(GATEWAY_KEY_A) });
    await app.inject({
      method: "GET",
      url: "/v1/models/collectiviq-coder",
      headers: auth(GATEWAY_KEY_A),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
