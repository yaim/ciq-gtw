import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, type MockServer } from "./support/mock-server.js";
import { makeAdapter } from "./support/adapter.js";
import {
  messagesCombined,
  messagesCreateTime,
  messagesDuplicateSource,
  messagesEmpty,
  messagesEmptyRunId,
  messagesNotArray,
  messagesNullContent,
  messagesPartial,
  messagesRunIdWrongType,
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
    // An entry naming no run is well-formed; it simply carries a null run id and
    // can never be correlated to a submission downstream.
    expect(result.messages[0]).toMatchObject({
      source: "gpt",
      percentUsage: 50,
      combinedRunId: null,
    });
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
        combinedRunId: "synthetic-run",
        id: 1,
      },
      {
        source: "combined",
        content: "combined answer",
        percentUsage: null,
        createdAt: "2026-01-01T00:00:05Z",
        combinedRunId: "synthetic-run",
        id: 2,
      },
    ]);
  });

  it("maps the observed `create_time` field to createdAt (2026-08-11 baselines)", async () => {
    server = await startMockServer((_req, res) => replyJson(res, messagesCreateTime));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    // The observed creation-time field name is `create_time`, not `created_at`.
    expect(result.messages[0]).toMatchObject({
      source: "gpt",
      percentUsage: null,
      createdAt: "2026-01-02T00:00:00Z",
      id: 21,
    });
  });

  it("maps the observed `combined_run_id` entry field (2026-08-11 baselines)", async () => {
    // The same safe field name the `process_message` 202 carries also appears on
    // message entries; that pairing is what makes run correlation possible.
    server = await startMockServer((_req, res) => replyJson(res, messagesCreateTime));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages[0]).toMatchObject({ combinedRunId: "synthetic-run" });
  });

  it("normalizes an absent or null combined_run_id to null", async () => {
    const bodies = [
      { messages: [{ source: "combined", content: "x" }] },
      { messages: [{ source: "combined", content: "x", combined_run_id: null }] },
    ];
    for (const body of bodies) {
      const current = await startMockServer((_req, res) => replyJson(res, body));
      server = current;
      const result = await makeAdapter(current.baseUrl).getMessages("t");
      expect(result.messages[0]).toMatchObject({ combinedRunId: null });
      await current.close();
      server = undefined;
    }
  });

  it("treats a wrong-typed or empty combined_run_id as a malformed entry", async () => {
    // A present-but-unusable run id is a broken entry, not an un-correlatable
    // one: silently normalizing it to null would let a malformed snapshot look
    // ordinary, so the whole response fails as an upstream protocol error.
    for (const body of [messagesRunIdWrongType, messagesEmptyRunId]) {
      const current = await startMockServer((_req, res) => replyJson(res, body));
      server = current;
      await expect(makeAdapter(current.baseUrl).getMessages("t")).rejects.toMatchObject({
        category: "upstream_protocol",
      });
      await current.close();
      server = undefined;
    }
  });

  it("still accepts the provisional `created_at` field as a fallback", async () => {
    // Backward compatibility: an entry using only `created_at` keeps mapping.
    const legacy = {
      messages: [{ source: "combined", content: "x", created_at: "2026-01-03T00:00:00Z", id: 5 }],
    };
    server = await startMockServer((_req, res) => replyJson(res, legacy));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.getMessages("t");
    expect(result.messages[0]).toMatchObject({ createdAt: "2026-01-03T00:00:00Z", id: 5 });
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
