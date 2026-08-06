import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, type MockServer } from "./support/mock-server.js";
import { makeAdapter } from "./support/adapter.js";
import {
  messagesCombined,
  messagesDuplicateSource,
  messagesEmpty,
  messagesNotArray,
  messagesNullContent,
  messagesPartial,
} from "./fixtures/collectiviq/responses.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("getMessages", () => {
  it("GETs with an encoded thread_id and omits since_id", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesEmpty));
    const adapter = makeAdapter(server.baseUrl);
    await adapter.getMessages("thread/with space&weird=1");

    const request = server.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe("/get_messages");
    // URLSearchParams round-trips the exact id and percent-encodes on the wire.
    expect(request?.query.get("thread_id")).toBe("thread/with space&weird=1");
    expect(request?.query.has("since_id")).toBe(false);
  });

  it("rejects an empty thread id before making any request", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesEmpty));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getMessages("")).rejects.toMatchObject({ category: "validation" });
    expect(server.requests).toHaveLength(0);
  });

  it("returns an empty message list", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesEmpty));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages).toHaveLength(0);
  });

  it("returns partial model responses and ignores unknown top-level fields", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesPartial));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ source: "gpt", percentUsage: 50 });
  });

  it("normalizes source/content/metadata and ignores unknown message fields", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesCombined));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages).toEqual([
      {
        source: "gpt",
        content: "individual answer",
        percentUsage: 30,
        createdAt: "2026-01-01T00:00:00Z",
        id: 1,
      },
      {
        source: "combined",
        content: "combined answer",
        percentUsage: null,
        createdAt: "2026-01-01T00:00:05Z",
        id: 2,
      },
    ]);
  });

  it("preserves duplicate-source messages with their timestamp/id metadata", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesDuplicateSource));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.id)).toEqual([10, 11]);
    expect(result.messages.map((m) => m.createdAt)).toEqual([
      "2026-01-01T00:00:01Z",
      "2026-01-01T00:00:09Z",
    ]);
  });

  it("accepts an explicit null content", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesNullContent));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages[0]).toMatchObject({ source: "combined", content: null });
  });

  it("treats a non-array messages field as an upstream protocol error", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesNotArray));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getMessages("t")).rejects.toMatchObject({ category: "upstream_protocol" });
  });
});
