import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, type MockServer } from "./support/mock-server.js";
import { makeAdapter, TEST_API_KEY } from "./support/adapter.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import {
  createThreadMissingId,
  createThreadNumeric,
  createThreadString,
} from "./fixtures/collectiviq/responses.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createThread", () => {
  it("POSTs urlencoded thread_title and is_title_from_user=false", async () => {
    server = await startMockServer((_req, res) => replyJson(res, createThreadNumeric));
    const adapter = makeAdapter(server.baseUrl);

    const result = await adapter.createThread({ title: "gateway request 01" });

    expect(result.threadId).toBe("4242");
    expect(result.rawStatus).toBe(200);

    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/create_thread");
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(request?.text());
    expect(body.get("thread_title")).toBe("gateway request 01");
    expect(body.get("is_title_from_user")).toBe("false");
    expect(body.has("project_id")).toBe(false);
  });

  it("sends the Authorization bearer header", async () => {
    server = await startMockServer((_req, res) => replyJson(res, createThreadNumeric));
    const adapter = makeAdapter(server.baseUrl);
    await adapter.createThread({ title: "t" });
    expect(server.requests[0]?.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it("normalizes a numeric thread_id to a string", async () => {
    server = await startMockServer((_req, res) => replyJson(res, createThreadNumeric));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.createThread({ title: "t" });
    expect(result.threadId).toBe("4242");
  });

  it("accepts a non-empty string thread_id", async () => {
    server = await startMockServer((_req, res) => replyJson(res, createThreadString));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.createThread({ title: "t" });
    expect(result.threadId).toBe("thread-abc");
  });

  it("treats a missing thread_id as an upstream protocol error", async () => {
    server = await startMockServer((_req, res) => replyJson(res, createThreadMissingId));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.createThread({ title: "t" })).rejects.toMatchObject({
      code: "invalid_upstream_response",
      category: "upstream_protocol",
    });
    await expect(adapter.createThread({ title: "t" })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects a zero or negative integer thread_id", async () => {
    server = await startMockServer((_req, res) => replyJson(res, { thread_id: 0 }));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.createThread({ title: "t" })).rejects.toMatchObject({
      category: "upstream_protocol",
    });
  });
});
