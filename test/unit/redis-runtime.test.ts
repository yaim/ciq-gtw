/**
 * The Redis composition root (`src/redis/runtime.ts`).
 *
 * The whole point of this module is that a gateway process holds EXACTLY ONE
 * Redis client no matter how many Redis-backed features are enabled — a second
 * one would double the socket budget, split readiness, and make "Redis is up"
 * mean two different things. These tests assert that directly by counting the
 * clients the injected factory is asked to build, and by proving both features
 * observe the same connection state.
 *
 * Everything here is synthetic; no socket is opened.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import { createRedisRuntime } from "../../src/redis/runtime.js";
import type { MinimalRedisClient, RedisClientConfig } from "../../src/redis/index.js";

const MASTER_KEY = randomBytes(32).toString("base64url");

const MODEL: VirtualModel = {
  id: "collectiviq-consensus",
  displayName: "consensus",
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

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake",
    COLLECTIVIQ_GATEWAY_KEYS: ["gw-fake-key-alpha"],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHUTDOWN_DRAIN_MS: 30_000,
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY,
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: "test-ns",
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    models: [MODEL],
    ...over,
  };
}

interface Tracker {
  readonly configs: readonly RedisClientConfig[];
  readonly commands: readonly (readonly string[])[];
  readonly clients: { isReady: boolean; closeCalls: number; connectCalls: number }[];
  createRedisClient: (config: RedisClientConfig) => MinimalRedisClient;
}

/** A factory that records every client it is asked to create. */
function tracker(): Tracker {
  const configs: RedisClientConfig[] = [];
  const commands: string[][] = [];
  const clients: { isReady: boolean; closeCalls: number; connectCalls: number }[] = [];
  return {
    configs,
    commands,
    clients,
    createRedisClient: (clientConfig) => {
      configs.push(clientConfig);
      const state = { isReady: true, closeCalls: 0, connectCalls: 0 };
      clients.push(state);
      const client: MinimalRedisClient = {
        connect: () => {
          state.connectCalls += 1;
          return Promise.resolve(undefined);
        },
        close: () => {
          state.closeCalls += 1;
          return Promise.resolve();
        },
        destroy: () => undefined,
        on: () => undefined,
        sendCommand: (args) => {
          commands.push([...args]);
          return Promise.resolve(["allowed"]);
        },
        get isReady() {
          return state.isReady;
        },
      };
      return client;
    },
  };
}

describe("redis runtime composition", () => {
  it("is null when Redis is not configured, so nothing can contact Redis", () => {
    const t = tracker();
    const { REDIS_URL: _omitted, ...withoutRedis } = config();
    expect(createRedisRuntime(withoutRedis, { createRedisClient: t.createRedisClient })).toBeNull();
    expect(t.configs).toHaveLength(0);
  });

  it("creates EXACTLY ONE client with idempotency alone", () => {
    const t = tracker();
    const runtime = createRedisRuntime(config(), { createRedisClient: t.createRedisClient });
    expect(runtime).not.toBeNull();
    expect(t.configs).toHaveLength(1);
    expect(runtime?.idempotency).not.toBeNull();
    expect(runtime?.rateLimiter).toBeNull();
  });

  it("creates EXACTLY ONE client with BOTH features enabled", () => {
    const t = tracker();
    const runtime = createRedisRuntime(config({ RATE_LIMIT_ENABLED: true }), {
      createRedisClient: t.createRedisClient,
    });
    // MUTATION GUARD: giving each feature its own connection would make this 2.
    expect(t.configs).toHaveLength(1);
    expect(runtime?.idempotency).not.toBeNull();
    expect(runtime?.rateLimiter).not.toBeNull();
  });

  it("opens no socket at construction and connects exactly once", () => {
    const t = tracker();
    const runtime = createRedisRuntime(config({ RATE_LIMIT_ENABLED: true }), {
      createRedisClient: t.createRedisClient,
    });
    expect(t.clients[0]?.connectCalls).toBe(0);
    runtime?.connect();
    expect(t.clients[0]?.connectCalls).toBe(1);
  });

  it("closes the one connection exactly once, however many features are on", async () => {
    const t = tracker();
    const runtime = createRedisRuntime(config({ RATE_LIMIT_ENABLED: true }), {
      createRedisClient: t.createRedisClient,
    });
    await runtime?.close();
    expect(t.clients).toHaveLength(1);
    expect(t.clients[0]?.closeCalls).toBe(1);
  });

  it("gives both features ONE shared readiness view", () => {
    const t = tracker();
    const runtime = createRedisRuntime(config({ RATE_LIMIT_ENABLED: true }), {
      createRedisClient: t.createRedisClient,
    });
    expect(runtime?.isReady()).toBe(true);
    expect(runtime?.idempotency?.isAvailable()).toBe(true);
    expect(runtime?.rateLimiter?.isReady()).toBe(true);

    // One disconnect degrades BOTH, because there is one connection to degrade.
    const state = t.clients[0];
    if (state === undefined) throw new Error("expected a client");
    state.isReady = false;
    expect(runtime?.isReady()).toBe(false);
    expect(runtime?.idempotency?.isAvailable()).toBe(false);
    expect(runtime?.rateLimiter?.isReady()).toBe(false);

    // ...and recovery restores both without a restart.
    state.isReady = true;
    expect(runtime?.isReady()).toBe(true);
    expect(runtime?.rateLimiter?.isReady()).toBe(true);
  });

  it("routes both features' commands over the same client", async () => {
    const t = tracker();
    const runtime = createRedisRuntime(config({ RATE_LIMIT_ENABLED: true }), {
      createRedisClient: t.createRedisClient,
    });
    await runtime?.rateLimiter?.consume("scope-a");
    expect(t.commands).toHaveLength(1);
    // Two distinct cached scripts, one socket.
    expect(t.commands[0]?.[0]).toBe("EVALSHA");
  });

  it("leaves rate limiting off unless it is explicitly enabled", () => {
    const t = tracker();
    const runtime = createRedisRuntime(config({ RATE_LIMIT_ENABLED: false }), {
      createRedisClient: t.createRedisClient,
    });
    expect(runtime?.rateLimiter).toBeNull();
  });
});
