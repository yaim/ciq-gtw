import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, replyRaw, type MockServer } from "./support/mock-server.js";
import { makeAdapter, FAST_TIMEOUTS, TEST_API_KEY } from "./support/adapter.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import type { OperationTimeouts } from "../../src/collectiviq/types.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A full FastAPI-style validation error carrying content-bearing fields. */
const httpValidationError = {
  detail: [
    {
      loc: ["body", "thread_id"],
      msg: "SENSITIVE-MSG-should-never-be-retained",
      type: "value_error",
      input: "SENSITIVE-INPUT-should-never-be-retained",
      ctx: { secret: "SENSITIVE-CTX" },
    },
  ],
};

describe("transport error normalization", () => {
  it("maps 401 to authentication", async () => {
    server = await startMockServer((_req, res) => replyJson(res, { detail: "no" }, 401));
    await expect(makeAdapter(server.baseUrl).createThread({ title: "t" })).rejects.toMatchObject({
      category: "authentication",
      code: "upstream_authentication_failed",
      rawStatus: 401,
    });
  });

  it("maps 429 to quota", async () => {
    server = await startMockServer((_req, res) => replyJson(res, {}, 429));
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "quota",
      rawStatus: 429,
    });
  });

  it("maps 422 to validation and never retains HTTPValidationError content", async () => {
    server = await startMockServer((_req, res) => replyJson(res, httpValidationError, 422));
    let caught: UpstreamError | undefined;
    try {
      await makeAdapter(server.baseUrl).getMessages("t");
    } catch (error) {
      caught = error as UpstreamError;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect(caught).toMatchObject({ category: "validation", rawStatus: 422 });
    const serialized = JSON.stringify({ ...caught, message: caught?.message });
    expect(serialized).not.toContain("SENSITIVE-MSG");
    expect(serialized).not.toContain("SENSITIVE-INPUT");
    expect(serialized).not.toContain("SENSITIVE-CTX");
    expect(serialized).not.toContain("detail");
  });

  it("maps 503 to a retryable transient error and 500 to a non-retryable one", async () => {
    server = await startMockServer((_req, res) => replyJson(res, {}, 503));
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "transient_http",
      retryable: true,
    });
    await server.close();

    server = await startMockServer((_req, res) => replyJson(res, {}, 500));
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "unexpected_upstream",
      retryable: false,
    });
  });

  it("treats malformed JSON as an upstream protocol error", async () => {
    server = await startMockServer((_req, res) =>
      replyRaw(res, "{not json", 200, "application/json"),
    );
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "upstream_protocol",
    });
  });

  it("rejects a non-JSON content type on a 2xx response", async () => {
    server = await startMockServer((_req, res) => replyRaw(res, "plain text", 200, "text/plain"));
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "upstream_protocol",
    });
  });

  it("does not retry a POST after a transient upstream status, and marks it non-retryable", async () => {
    server = await startMockServer((_req, res) => replyJson(res, {}, 503));
    await expect(makeAdapter(server.baseUrl).createThread({ title: "t" })).rejects.toMatchObject({
      category: "transient_http",
      retryable: false,
      method: "POST",
    });
    expect(server.requests).toHaveLength(1);
  });
});

describe("method-aware retryability", () => {
  it("marks a GET network failure retryable but never retries automatically", async () => {
    server = await startMockServer((_req, res) => {
      res.socket?.destroy();
    });
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "network",
      retryable: true,
      method: "GET",
    });
    // Even though retryable, the adapter itself performs no retry.
    expect(server.requests.length).toBeLessThanOrEqual(1);
  });

  it("marks a GET transient status retryable", async () => {
    server = await startMockServer((_req, res) => replyJson(res, {}, 503));
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "transient_http",
      retryable: true,
      method: "GET",
    });
    expect(server.requests).toHaveLength(1);
  });

  it("marks a POST network failure non-retryable and issues a single request", async () => {
    server = await startMockServer((_req, res) => {
      res.socket?.destroy();
    });
    await expect(makeAdapter(server.baseUrl).createThread({ title: "t" })).rejects.toMatchObject({
      category: "network",
      retryable: false,
      method: "POST",
    });
    expect(server.requests.length).toBeLessThanOrEqual(1);
  });

  it("marks a POST 502 transient failure non-retryable", async () => {
    server = await startMockServer((_req, res) => replyJson(res, {}, 502));
    await expect(makeAdapter(server.baseUrl).createThread({ title: "t" })).rejects.toMatchObject({
      category: "transient_http",
      retryable: false,
      method: "POST",
    });
    expect(server.requests).toHaveLength(1);
  });
});
// DELETE-method retryability is covered directly in errors.test.ts, since the
// production adapter surface issues only GET and POST.

describe("transport bounds and lifecycle", () => {
  it("rejects an oversized response body", async () => {
    const tiny: OperationTimeouts = { ...FAST_TIMEOUTS, maxResponseBytes: 64 };
    server = await startMockServer((_req, res) =>
      replyJson(res, { messages: [], padding: "x".repeat(500) }),
    );
    await expect(makeAdapter(server.baseUrl, tiny).getMessages("t")).rejects.toMatchObject({
      category: "response_too_large",
    });
  });

  it("times out when headers are too slow", async () => {
    const tiny: OperationTimeouts = { ...FAST_TIMEOUTS, headerTimeoutMs: 120 };
    server = await startMockServer(async (_req, res) => {
      await delay(600);
      replyJson(res, { messages: [] });
    });
    await expect(makeAdapter(server.baseUrl, tiny).getMessages("t")).rejects.toMatchObject({
      category: "timeout",
    });
  });

  it("times out when the body streams too slowly", async () => {
    const tiny: OperationTimeouts = { ...FAST_TIMEOUTS, bodyTimeoutMs: 120 };
    server = await startMockServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"messages":');
      await delay(600);
      res.end("[]}");
    });
    await expect(makeAdapter(server.baseUrl, tiny).getMessages("t")).rejects.toMatchObject({
      category: "timeout",
    });
  });

  it("classifies a mid-flight connection reset as a network error", async () => {
    server = await startMockServer((_req, res) => {
      res.socket?.destroy();
    });
    await expect(makeAdapter(server.baseUrl).getMessages("t")).rejects.toMatchObject({
      category: "network",
    });
  });

  it("classifies a pre-aborted caller signal as cancellation and makes no request", async () => {
    server = await startMockServer((_req, res) => replyJson(res, { messages: [] }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeAdapter(server.baseUrl).getMessages("t", controller.signal),
    ).rejects.toMatchObject({
      category: "cancellation",
    });
    expect(server.requests).toHaveLength(0);
  });

  it("classifies a mid-flight caller abort as cancellation, then recovers on a fresh request", async () => {
    const controller = new AbortController();
    server = await startMockServer(async (_req, res) => {
      await delay(400);
      replyJson(res, { messages: [] });
    });
    const adapter = makeAdapter(server.baseUrl);
    const pending = adapter.getMessages("t", controller.signal);
    setTimeout(() => controller.abort(), 60);
    await expect(pending).rejects.toMatchObject({ category: "cancellation" });

    // A subsequent normal request on a fresh server succeeds (no leaked state).
    await server.close();
    server = await startMockServer((_req, res) => replyJson(res, { messages: [] }));
    const ok = await makeAdapter(server.baseUrl).getMessages("t");
    expect(ok.messages).toHaveLength(0);
  });

  it("keeps the Authorization value out of thrown errors", async () => {
    server = await startMockServer((_req, res) => replyRaw(res, "{bad", 200, "application/json"));
    let caught: unknown;
    try {
      await makeAdapter(server.baseUrl).getMessages("t");
    } catch (error) {
      caught = error;
    }
    const serialized = JSON.stringify({
      ...(caught as object),
      message: (caught as Error).message,
    });
    expect(serialized).not.toContain(TEST_API_KEY);
    expect(serialized.toLowerCase()).not.toContain("bearer");
  });
});
