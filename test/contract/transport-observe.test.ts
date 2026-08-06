import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, replyRaw, type MockServer } from "./support/mock-server.js";
import { FAST_TIMEOUTS, TEST_API_KEY } from "./support/adapter.js";
import {
  observeUpstreamJson,
  requestUpstreamJson,
  type UpstreamJsonRequest,
} from "../../src/collectiviq/http.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import type { CollectivIQTransportConfig, OperationTimeouts } from "../../src/collectiviq/types.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function config(baseUrl: string): CollectivIQTransportConfig {
  return { baseUrl, apiKey: TEST_API_KEY };
}

function getRequest(overrides: Partial<UpstreamJsonRequest> = {}): UpstreamJsonRequest {
  return { method: "GET", path: "/get_messages", timeouts: FAST_TIMEOUTS, ...overrides };
}

describe("observeUpstreamJson vs requestUpstreamJson on error bodies", () => {
  it("observe parses a non-2xx JSON body and reports ok:false with the status", async () => {
    const errorBody = { detail: "why-it-failed", code: 4001 };
    server = await startMockServer((_req, res) => replyJson(res, errorBody, 422));

    const observation = await observeUpstreamJson(config(server.baseUrl), getRequest());

    expect(observation.status).toBe(422);
    expect(observation.ok).toBe(false);
    expect(observation.json).toEqual(errorBody);
  });

  it("production requestUpstreamJson throws on the SAME non-2xx body and never returns it", async () => {
    const errorBody = { detail: "SENSITIVE-ERROR-BODY-must-not-be-retained" };
    server = await startMockServer((_req, res) => replyJson(res, errorBody, 422));

    let caught: unknown;
    try {
      await requestUpstreamJson(config(server.baseUrl), getRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect(caught).toMatchObject({ category: "validation", rawStatus: 422 });

    // The discarded non-2xx body never reaches the thrown error.
    const serialized = JSON.stringify({
      ...(caught as object),
      message: (caught as Error).message,
    });
    expect(serialized).not.toContain("SENSITIVE-ERROR-BODY");
    expect(serialized).not.toContain("detail");
  });

  it("observe enforces the size cap on an oversized ERROR body", async () => {
    const tiny: OperationTimeouts = { ...FAST_TIMEOUTS, maxResponseBytes: 64 };
    server = await startMockServer((_req, res) => replyJson(res, { detail: "x".repeat(500) }, 500));
    await expect(
      observeUpstreamJson(config(server.baseUrl), getRequest({ timeouts: tiny })),
    ).rejects.toMatchObject({ category: "response_too_large" });
  });

  it("observe returns json:undefined for a non-JSON content type without throwing", async () => {
    server = await startMockServer((_req, res) => replyRaw(res, "plain text", 500, "text/plain"));
    const observation = await observeUpstreamJson(config(server.baseUrl), getRequest());
    expect(observation.status).toBe(500);
    expect(observation.ok).toBe(false);
    expect(observation.json).toBeUndefined();
  });

  it("observe returns json:undefined when a JSON body is unparseable", async () => {
    server = await startMockServer((_req, res) =>
      replyRaw(res, "{not json", 200, "application/json"),
    );
    const observation = await observeUpstreamJson(config(server.baseUrl), getRequest());
    expect(observation.status).toBe(200);
    expect(observation.ok).toBe(true);
    expect(observation.json).toBeUndefined();
  });

  it("observe throws upstream_protocol on a strict-UTF-8 violation", async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // 0xff is never valid in UTF-8; the strict decoder must reject it.
      res.end(Buffer.from([0x7b, 0xff, 0x7d]));
    });
    await expect(observeUpstreamJson(config(server.baseUrl), getRequest())).rejects.toMatchObject({
      category: "upstream_protocol",
    });
  });
});

describe("observeUpstreamJson cancellation vs timeout classification", () => {
  it("classifies caller cancellation as request_cancelled and carries the method", async () => {
    const controller = new AbortController();
    server = await startMockServer(async (_req, res) => {
      await delay(400);
      replyJson(res, { ok: true });
    });
    const pending = observeUpstreamJson(
      config(server.baseUrl),
      getRequest({ method: "POST", path: "/process_message", signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 60);
    await expect(pending).rejects.toMatchObject({
      category: "cancellation",
      code: "request_cancelled",
      method: "POST",
    });
  });

  it("classifies a header deadline as upstream_timeout and carries the method", async () => {
    const tiny: OperationTimeouts = { ...FAST_TIMEOUTS, headerTimeoutMs: 120 };
    server = await startMockServer(async (_req, res) => {
      await delay(600);
      replyJson(res, { ok: true });
    });
    await expect(
      observeUpstreamJson(config(server.baseUrl), getRequest({ timeouts: tiny })),
    ).rejects.toMatchObject({ category: "timeout", code: "upstream_timeout", method: "GET" });
  });

  it("classifies a body deadline as upstream_timeout", async () => {
    const tiny: OperationTimeouts = { ...FAST_TIMEOUTS, bodyTimeoutMs: 120 };
    server = await startMockServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"messages":');
      await delay(600);
      res.end("[]}");
    });
    await expect(
      observeUpstreamJson(config(server.baseUrl), getRequest({ timeouts: tiny })),
    ).rejects.toMatchObject({ category: "timeout", code: "upstream_timeout" });
  });
});

describe("observeUpstreamJson and requestUpstreamJson agree on a 2xx JSON body", () => {
  it("parses the same success body identically", async () => {
    const okBody = { messages: [{ source: "gpt", content: "hi" }] };
    server = await startMockServer((_req, res) => replyJson(res, okBody));

    const observation = await observeUpstreamJson(config(server.baseUrl), getRequest());
    expect(observation).toEqual({ status: 200, ok: true, json: okBody });

    const response = await requestUpstreamJson(config(server.baseUrl), getRequest());
    expect(response).toEqual({ status: 200, json: okBody });
    expect(observation.json).toEqual(response.json);
  });
});
