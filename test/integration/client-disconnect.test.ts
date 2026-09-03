/**
 * Real client-disconnect regression.
 *
 * Runs the full app on a loopback ephemeral port with the REAL completion
 * runtime pointed at a mock CollectivIQ server whose `get_messages` hangs. A raw
 * client socket begins a completion and is then destroyed; the request's abort
 * must propagate so polling stops and the acquired capacity permit is released.
 * Localhost only; deterministic and bounded (cannot hang).
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { buildServer, type GatewayServer } from "../../src/server.js";
import { createReadinessState } from "../../src/api/health-route.js";
import { createCompletionRuntime, type CompletionRuntime } from "../../src/generation/runtime.js";
import { startMockServer, replyJson } from "../contract/support/mock-server.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";

const GATEWAY_KEY = "gw-fake-key";

const MODEL: VirtualModel = {
  id: "collectiviq-consensus",
  displayName: "Consensus",
  selectedLlms: ["gpt"],
  generateCombined: false,
  answerSource: "gpt",
  toolMode: "disabled",
  promptMode: "protocol",
  // High deadline so only a disconnect (not a timeout) can release capacity here.
  requestTimeoutMs: 30_000,
  pollIntervalMs: 100,
  maxPollIntervalMs: 100,
  maximumPromptBytes: 6_291_456,
};

function configFor(baseUrl: string): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 0,
    COLLECTIVIQ_BASE_URL: baseUrl,
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake-upstream",
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHARED_CAPACITY_ENABLED: false,
    SHUTDOWN_DRAIN_MS: 30_000,
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: "collectiviq-gateway",
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    METRICS_ENABLED: false,
    TRACING_ENABLED: false,
    TRACING_SAMPLE_RATIO: 1,
    models: [MODEL],
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `predicate` until true or the deadline; throw on timeout (no hang). */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(20);
  }
}

let mock: Awaited<ReturnType<typeof startMockServer>> | undefined;
let app: GatewayServer | undefined;

afterEach(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

describe("real client disconnect", () => {
  it("aborts polling and releases capacity when the client socket is destroyed", async () => {
    // get_messages hangs forever; the disconnect is the only way work stops.
    mock = await startMockServer((req, res: ServerResponse) => {
      if (req.path === "/create_thread") return void replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message")
        return void replyJson(res, { status: "ok", combined_run_id: "synthetic-run" }, 202);
      // /get_messages: never respond.
    });

    const runtime: CompletionRuntime = createCompletionRuntime(configFor(mock.baseUrl));
    app = buildServer({
      config: configFor(mock.baseUrl),
      readiness: createReadinessState(true),
      completion: {
        chatService: runtime.chatService,
        titleBridge: runtime.titleBridge,
        shutdownSignal: new AbortController().signal,
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    // Begin a completion over a raw socket.
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
    });
    req.on("error", () => {
      /* ECONNRESET after destroy is expected */
    });
    req.write(
      JSON.stringify({
        model: "collectiviq-consensus",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    req.end();

    // The request reaches the service and acquires one capacity permit.
    await waitFor(() => runtime.capacity.activeCount === 1);
    const getMessages = () => mock?.requests.filter((r) => r.path === "/get_messages").length ?? 0;
    await waitFor(() => getMessages() >= 1); // polling started
    const pollsAtDisconnect = getMessages();

    // Destroy the client socket mid-flight.
    req.destroy();

    // The abort propagates: capacity is released...
    await waitFor(() => runtime.capacity.activeCount === 0);
    // ...and polling has stopped (no further upstream reads after a grace window).
    await delay(300);
    expect(getMessages()).toBe(pollsAtDisconnect);

    // The upstream saw the create + submit + at least one poll before stopping.
    expect(mock?.requests.some((r) => r.path === "/create_thread")).toBe(true);
    expect(mock?.requests.some((r) => r.path === "/process_message")).toBe(true);
    expect(pollsAtDisconnect).toBeGreaterThanOrEqual(1);
    expect(runtime.capacity.activeCount).toBe(0);
    expect(runtime.capacity.queuedCount).toBe(0);
  }, 15_000);
});
