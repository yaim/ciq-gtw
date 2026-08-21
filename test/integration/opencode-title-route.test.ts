/**
 * Integration tests for `GET /v1/opencode/session-title` — the authenticated
 * native-title extension route. A fake {@link TitleBridge} drives the ready /
 * pending / unavailable outcomes; the chat service is an unused stub. These
 * assert the exact status/body/header contract, that gateway auth applies, and
 * that the opaque session id + per-key identity reach the bridge unchanged and
 * are never reflected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import type { ChatCompletionService } from "../../src/generation/chat-completion.js";
import type {
  CorrelationKey,
  TitleBridge,
  TitleLookupOutcome,
} from "../../src/opencode/title-bridge.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-fake-key";
const auth = { authorization: `Bearer ${GATEWAY_KEY}` };
const url = "/v1/opencode/session-title";
const HEADER = "x-collectiviq-opencode-session-id";

function model(id: string): VirtualModel {
  return {
    id,
    displayName: id,
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
    promptMode: "protocol",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
  };
}

function makeConfig(): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake",
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHUTDOWN_DRAIN_MS: 30_000,
    models: [model("collectiviq-consensus")],
  };
}

/** The chat service is never invoked by this route; a throwing stub proves it. */
const stubChatService: ChatCompletionService = {
  prepare: () => {
    throw new Error("chat service must not be used by the title route");
  },
  run: () => Promise.reject(new Error("chat service must not be used by the title route")),
};

interface FakeBridge extends TitleBridge {
  readonly calls: CorrelationKey[];
}

function fakeBridge(outcome: (key: CorrelationKey) => TitleLookupOutcome): FakeBridge {
  const calls: CorrelationKey[] = [];
  return {
    calls,
    register: () => {},
    lookup: (key) => {
      calls.push({ keyId: key.keyId, sessionId: key.sessionId });
      return Promise.resolve(outcome(key));
    },
  };
}

let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

function build(bridge: TitleBridge): GatewayServer {
  return buildServer({
    config: makeConfig(),
    readiness: createReadinessState(true),
    completion: {
      chatService: stubChatService,
      titleBridge: bridge,
      shutdownSignal: new AbortController().signal,
    },
  });
}

describe("GET /v1/opencode/session-title — auth", () => {
  it("returns 401 without a valid gateway key (before the bridge is consulted)", async () => {
    const bridge = fakeBridge(() => ({ kind: "ready", title: "x" }));
    app = build(bridge);
    const response = await app.inject({ method: "GET", url, headers: { [HEADER]: "sess1" } });
    expect(response.statusCode).toBe(401);
    expect(bridge.calls).toHaveLength(0);
  });
});

describe("GET /v1/opencode/session-title — header validation", () => {
  it("returns 400 unavailable + no-store when the session header is missing", async () => {
    const bridge = fakeBridge(() => ({ kind: "ready", title: "x" }));
    app = build(bridge);
    const response = await app.inject({ method: "GET", url, headers: auth });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bridge.calls).toHaveLength(0);
  });

  it("returns 400 unavailable when the session header is malformed", async () => {
    const bridge = fakeBridge(() => ({ kind: "ready", title: "x" }));
    app = build(bridge);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...auth, [HEADER]: "has spaces & !" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(bridge.calls).toHaveLength(0);
  });
});

describe("GET /v1/opencode/session-title — lookup outcomes", () => {
  it("maps ready to 200 with the title and no-store", async () => {
    const bridge = fakeBridge(() => ({ kind: "ready", title: "Refactor the parser" }));
    app = build(bridge);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...auth, [HEADER]: "sess1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", title: "Refactor the parser" });
    expect(response.headers["cache-control"]).toBe("no-store");
    // The opaque session id reached the bridge verbatim, with the per-key identity.
    expect(bridge.calls).toEqual([{ keyId: "k0", sessionId: "sess1" }]);
  });

  it("maps pending to 202 with Retry-After: 2 and no-store", async () => {
    const bridge = fakeBridge(() => ({ kind: "pending" }));
    app = build(bridge);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...auth, [HEADER]: "sess1" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "pending" });
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("maps unavailable to 404 with no-store", async () => {
    const bridge = fakeBridge(() => ({ kind: "unavailable" }));
    app = build(bridge);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...auth, [HEADER]: "sess1" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("does not reflect the session id in a non-ready response body", async () => {
    const bridge = fakeBridge(() => ({ kind: "unavailable" }));
    app = build(bridge);
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...auth, [HEADER]: "SECRET_SESSION_ZZ9" },
    });
    expect(response.body).not.toContain("SECRET_SESSION_ZZ9");
  });
});
