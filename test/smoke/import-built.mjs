// Build smoke test: import the compiled application and confirm that importing
// it neither opens a listening socket nor keeps the event loop alive.
//
// Run after `npm run build` via `npm run test:build`. If importing `index.js`
// started a listener, this process would hang and the test would time out.
import assert from "node:assert/strict";

const server = await import("../../dist/server.js");
const index = await import("../../dist/index.js");

assert.equal(typeof server.buildServer, "function", "dist/server.js must export buildServer");
assert.equal(typeof index.main, "function", "dist/index.js must export main");

// Construct the server from compiled output and prove it is not listening.
const config = {
  ENVIRONMENT: "development",
  HOST: "127.0.0.1",
  PORT: 8787,
  COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
  COLLECTIVIQ_API_KEY: "sk-fake",
  COLLECTIVIQ_GATEWAY_KEYS: ["gw-fake"],
  MODEL_CONFIG_PATH: "./config/models.yaml",
  LOG_LEVEL: "silent",
  LOG_CONTENT: false,
  MAX_REQUEST_BODY_BYTES: 8_388_608,
  models: [],
};

const app = server.buildServer({ config, readiness: { isReady: () => false } });
await app.ready();
assert.equal(app.server.listening, false, "buildServer must not open a listening socket");
await app.close();

console.log("build smoke OK");
