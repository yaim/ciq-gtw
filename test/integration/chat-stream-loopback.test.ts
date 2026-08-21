/**
 * Real-socket synthetic-SSE regressions.
 *
 * The full app runs on a loopback ephemeral port with the REAL completion
 * runtime pointed at a mock CollectivIQ server. These prove the end-to-end wire
 * behaviour that in-process `inject` cannot: an actual `text/event-stream`
 * response the client reads incrementally, exactly one thread + one submit per
 * streamed request, and capacity release when a streaming client disconnects
 * mid-poll. Localhost only; deterministic and bounded (cannot hang).
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

function modelWith(over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: "collectiviq-consensus",
    displayName: "Consensus",
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
    promptMode: "protocol",
    requestTimeoutMs: 30_000,
    pollIntervalMs: 50,
    maxPollIntervalMs: 50,
    maximumPromptBytes: 6_291_456,
    ...over,
  };
}

function configFor(baseUrl: string, model = modelWith()): AppConfig {
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
    SHUTDOWN_DRAIN_MS: 30_000,
    models: [model],
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(20);
  }
}

interface StreamedResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** POST a JSON payload and buffer the full (SSE or JSON) response. */
function post(port: number, payload: unknown): Promise<StreamedResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function dataPayloads(body: string): string[] {
  return body
    .split("\n\n")
    .filter((r) => r.length > 0 && r.startsWith("data: "))
    .map((r) => r.slice("data: ".length));
}

let mock: Awaited<ReturnType<typeof startMockServer>> | undefined;
let app: GatewayServer | undefined;
afterEach(async () => {
  if (app) await app.close();
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function listen(
  config: AppConfig,
  shutdown: AbortController = new AbortController(),
): Promise<{ port: number; runtime: CompletionRuntime }> {
  const runtime = createCompletionRuntime(config);
  app = buildServer({
    config,
    readiness: createReadinessState(true),
    completion: {
      chatService: runtime.chatService,
      titleBridge: runtime.titleBridge,
      shutdownSignal: shutdown.signal,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { port, runtime };
}

/** Resolve `promise`, or reject if it does not settle within `ms` (no hang). */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms).unref(),
    ),
  ]);
}

describe("synthetic SSE over a real socket", () => {
  it("delivers an event-stream and creates exactly one thread and one submit", async () => {
    mock = await startMockServer((req, res: ServerResponse) => {
      if (req.path === "/create_thread") return void replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message") return void replyJson(res, { status: "ok" }, 202);
      if (req.path === "/get_messages")
        return void replyJson(res, { messages: [{ source: "gpt", content: "streamed answer" }] });
      res.writeHead(404).end();
    });
    const { port } = await listen(configFor(mock.baseUrl));

    const res = await post(port, {
      model: "collectiviq-consensus",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    type Chunk = {
      choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
    };
    const payloads = dataPayloads(res.body);
    expect(payloads.at(-1)).toBe("[DONE]");
    const events = payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p) as Chunk);
    expect(events[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    const content = events.map((e) => e.choices[0]?.delta.content ?? "").join("");
    expect(content).toBe("streamed answer");
    expect(events.at(-1)?.choices[0]?.finish_reason).toBe("stop");

    // Exactly one thread creation and one submit for the streamed request.
    expect(mock.requests.filter((r) => r.path === "/create_thread")).toHaveLength(1);
    expect(mock.requests.filter((r) => r.path === "/process_message")).toHaveLength(1);
  }, 15_000);

  it("aborts polling and releases capacity when a streaming client disconnects", async () => {
    mock = await startMockServer((req, res: ServerResponse) => {
      if (req.path === "/create_thread") return void replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message") return void replyJson(res, { status: "ok" }, 202);
      // /get_messages: never respond, so only a disconnect stops the work.
    });
    const { port, runtime } = await listen(configFor(mock.baseUrl));

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
    // The role chunk should arrive promptly (before any answer content).
    let firstChunk = "";
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (firstChunk += c));
    });
    req.write(
      JSON.stringify({
        model: "collectiviq-consensus",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    req.end();

    await waitFor(() => runtime.capacity.activeCount === 1);
    const getMessages = () => mock?.requests.filter((r) => r.path === "/get_messages").length ?? 0;
    await waitFor(() => getMessages() >= 1); // polling started
    // The assistant-role opener was already delivered before any answer content.
    await waitFor(() => firstChunk.includes('"role":"assistant"'));
    const pollsAtDisconnect = getMessages();

    req.destroy();

    // Capacity is released and polling stops after the disconnect.
    await waitFor(() => runtime.capacity.activeCount === 0);
    await delay(300);
    expect(getMessages()).toBe(pollsAtDisconnect);
    expect(runtime.capacity.queuedCount).toBe(0);
  }, 15_000);

  it("keeps a stream:true oversized prompt a pre-header JSON 400 (no upstream call)", async () => {
    mock = await startMockServer((_req, res: ServerResponse) => {
      res.writeHead(500).end(); // must never be reached
    });
    const { port } = await listen(configFor(mock.baseUrl, modelWith({ maximumPromptBytes: 1024 })));

    const res = await post(port, {
      model: "collectiviq-consensus",
      messages: [{ role: "user", content: "x".repeat(4000) }],
      stream: true,
    });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "context_length_exceeded" } });
    // Preparation failed before any thread was created.
    expect(mock.requests.filter((r) => r.path === "/create_thread")).toHaveLength(0);
  }, 15_000);

  it("shutdown while a reading client streams: polling stops, capacity releases, safe 503 + [DONE], app.close() completes", async () => {
    // get_messages hangs, so the stream sits in the authoritative poll until the
    // shared shutdown signal cancels it. The client keeps reading (writable), so
    // the safe 503 SSE error record must still be delivered.
    mock = await startMockServer((req, res: ServerResponse) => {
      if (req.path === "/create_thread") return void replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message") return void replyJson(res, { status: "ok" }, 202);
      // /get_messages: never respond.
    });
    const shutdown = new AbortController();
    const { port, runtime } = await listen(configFor(mock.baseUrl), shutdown);

    let body = "";
    let ended = false;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_KEY}`, "content-type": "application/json" },
    });
    req.on("error", () => {
      /* a mid-stream reset is acceptable */
    });
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c)); // keep reading → transport stays writable
      res.on("end", () => (ended = true));
      res.on("close", () => (ended = true));
    });
    req.write(
      JSON.stringify({
        model: "collectiviq-consensus",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    req.end();

    // Wait until the request holds a capacity permit and polling has begun.
    await waitFor(() => runtime.capacity.activeCount === 1);
    const getMessages = () => mock?.requests.filter((r) => r.path === "/get_messages").length ?? 0;
    await waitFor(() => getMessages() >= 1);
    await waitFor(() => body.includes('"role":"assistant"'));
    const pollsAtShutdown = getMessages();

    // Fire the shared shutdown signal (the same path production aborts on drain).
    shutdown.abort();

    // Polling stops and the capacity permit is released as run() is cancelled.
    await waitFor(() => runtime.capacity.activeCount === 0);
    await delay(200);
    expect(getMessages()).toBe(pollsAtShutdown);
    expect(runtime.capacity.queuedCount).toBe(0);

    // The reading client received the safe 503 error record and [DONE], no stop.
    await waitFor(() => ended, 5_000);
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain("service_unavailable");
    expect(body).toContain("data: [DONE]");
    expect(body).not.toContain('"finish_reason":"stop"');

    // app.close() completes promptly (the SSE socket was closed, not left as an
    // idle keep-alive) — it must not hang on the drained connection.
    await withDeadline(app?.close() ?? Promise.resolve(), 4_000, "app.close()");
    app = undefined; // afterEach must not close it twice
  }, 15_000);
});
