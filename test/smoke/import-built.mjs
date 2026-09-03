// Build smoke test: import the compiled application and confirm that importing
// it neither opens a listening socket nor keeps the event loop alive.
//
// Run after `npm run build` via `npm run test:build`. If importing `index.js`
// started a listener, this process would hang and the test would time out.
import assert from "node:assert/strict";

// Fail loudly if importing or constructing the app performs ANY network call
// (including a password-mode login). The gateway must be fully constructable
// offline; only a real request may contact CollectivIQ.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  fetchCalls += 1;
  return realFetch ? realFetch(...args) : Promise.reject(new Error("fetch disabled in smoke test"));
};

const server = await import("../../dist/server.js");
const index = await import("../../dist/index.js");

assert.equal(typeof server.buildServer, "function", "dist/server.js must export buildServer");
assert.equal(typeof index.main, "function", "dist/index.js must export main");

// Construct the server from compiled output and prove it is not listening. The
// default completion runtime (adapter + capacity + poller) is built from config,
// which must not make any network/login call at construction time.
const config = {
  ENVIRONMENT: "development",
  HOST: "127.0.0.1",
  PORT: 8787,
  COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
  COLLECTIVIQ_AUTH_MODE: "bearer",
  COLLECTIVIQ_API_KEY: "sk-fake",
  COLLECTIVIQ_GATEWAY_KEYS: ["gw-fake"],
  MODEL_CONFIG_PATH: "./config/models.yaml",
  LOG_LEVEL: "silent",
  LOG_CONTENT: false,
  MAX_REQUEST_BODY_BYTES: 8_388_608,
  MAX_CONCURRENT_REQUESTS: 4,
  MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
  MAX_QUEUED_REQUESTS: 20,
  MAX_QUEUE_WAIT_MS: 5_000,
  SHUTDOWN_DRAIN_MS: 30_000,
  // Redis-backed idempotency AND rate limiting CONFIGURED but not wired:
  // `buildServer` must still open no socket. The Redis client is owned by the
  // process composition root, never by construction (specification §31.3), and
  // both features share that one connection.
  REDIS_URL: "redis://127.0.0.1:6379",
  IDEMPOTENCY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  IDEMPOTENCY_TTL_MS: 600_000,
  REDIS_KEY_PREFIX: "collectiviq-gateway",
  RATE_LIMIT_ENABLED: true,
  RATE_LIMIT_REQUESTS: 60,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_BURST: 8,
  OPENCODE_THREAD_REUSE_ENABLED: false,
  OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
  // Observability CONFIGURED but owned by the process root: `buildServer` may
  // build the (pure, socket-free) Prometheus registry and register `/metrics`,
  // but it must never construct an OTLP exporter or contact a collector.
  METRICS_ENABLED: true,
  TRACING_ENABLED: true,
  TRACING_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
  TRACING_SAMPLE_RATIO: 1,
  models: [],
};

/** Names of TCP-related libuv handles; none may exist during construction. */
const tcpHandles = () => process.getActiveResourcesInfo().filter((name) => name.startsWith("TCP"));

assert.deepEqual(tcpHandles(), [], "no TCP handle may exist before constructing the server");

const app = server.buildServer({ config, readiness: { isReady: () => false } });
await app.ready();
assert.equal(app.server.listening, false, "buildServer must not open a listening socket");
assert.equal(fetchCalls, 0, "constructing the server must not make any network/login call");
// Covers both CollectivIQ and Redis: neither may be connected at construction,
// even though the configuration above enables idempotency.
assert.deepEqual(
  tcpHandles(),
  [],
  "constructing the server must not open any TCP connection (CollectivIQ or Redis)",
);
await app.close();

globalThis.fetch = realFetch;
console.log("build smoke OK");
