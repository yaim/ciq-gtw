/**
 * Adapter + normalization contract tests for the OBSERVED-ONLY `get_threads`
 * native-title lookup. These drive the REAL adapter (shared bounded transport +
 * credential provider + normalizer) against the hermetic mock HTTP server. No
 * network and no credentials.
 *
 * The lookup reads ONLY the single target thread entry (keyed by the normalized
 * thread id); unrelated entries are never inspected, retained, or leaked, and a
 * normalized error never carries a raw upstream body/title/identifier.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, replyRaw, type MockServer } from "./support/mock-server.js";
import { testTransportConfig } from "./support/adapter.js";
import { CollectivIQHttpAdapter } from "../../src/collectiviq/adapter.js";
import type { OperationTimeouts } from "../../src/collectiviq/types.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const FAST: OperationTimeouts = {
  headerTimeoutMs: 2_000,
  bodyTimeoutMs: 2_000,
  maxResponseBytes: 1_048_576,
};

function makeAdapter(baseUrl: string, getThreadsTimeouts: OperationTimeouts = FAST) {
  return new CollectivIQHttpAdapter(testTransportConfig(baseUrl, { getThreadsTimeouts }));
}

/** A `get_threads` body whose `threads` map is keyed by thread-id strings. */
function threadsBody(entries: Record<string, unknown>): { threads: Record<string, unknown> } {
  return { threads: entries };
}

describe("getThreadTitle — request shape", () => {
  it("issues a bare GET to /get_threads (no query, no body)", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(res, threadsBody({ "42": { title: "New Thread" } })),
    );
    const adapter = makeAdapter(server.baseUrl);
    await adapter.getThreadTitle("42");
    const request = server.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.path).toBe("/get_threads");
    expect([...(request?.query.keys() ?? [])]).toHaveLength(0);
    expect(request?.rawBody.byteLength).toBe(0);
  });

  it("rejects an empty thread id before making any request", async () => {
    server = await startMockServer((_req, res) => replyJson(res, threadsBody({})));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("")).rejects.toMatchObject({ category: "validation" });
    expect(server.requests).toHaveLength(0);
  });
});

describe("getThreadTitle — pending vs ready", () => {
  it("returns ready with the trimmed provider title for the target entry", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(res, threadsBody({ "42": { title: "  Refactor the auth module  " } })),
    );
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).resolves.toEqual({
      kind: "ready",
      title: "Refactor the auth module",
    });
  });

  it("treats the fixed `New Thread` placeholder (even padded) as pending", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(res, threadsBody({ "42": { title: "  New Thread  " } })),
    );
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).resolves.toEqual({ kind: "pending" });
  });

  it("treats a target absent from the threads map as pending", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(res, threadsBody({ "99": { title: "Some other thread" } })),
    );
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).resolves.toEqual({ kind: "pending" });
  });

  it("reads only the target entry and ignores unrelated entries (no dup thread_id needed)", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(
        res,
        threadsBody({
          // Unrelated entries are malformed on purpose: they must NOT be inspected.
          "1": 12345,
          "2": { title: 999 },
          "42": { title: "Target ready title", extra: "ignored" },
          "3": null,
        }),
      ),
    );
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).resolves.toEqual({
      kind: "ready",
      title: "Target ready title",
    });
  });
});

describe("getThreadTitle — malformed structures map to a normalized error", () => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: "non-object top level", body: [] },
    { name: "missing threads", body: { notThreads: {} } },
    { name: "threads is an array", body: { threads: [] } },
    { name: "threads is null", body: { threads: null } },
    { name: "target entry not an object", body: threadsBody({ "42": "a string" }) },
    { name: "target entry missing title", body: threadsBody({ "42": { name: "x" } }) },
    { name: "title not a string", body: threadsBody({ "42": { title: 7 } }) },
    { name: "empty title after trim", body: threadsBody({ "42": { title: "   " } }) },
    { name: "multiline title", body: threadsBody({ "42": { title: "line1\nline2" } }) },
    {
      name: "interior U+2028 line separator title",
      body: threadsBody({ "42": { title: "line1 line2" } }),
    },
    {
      name: "interior U+2029 paragraph separator title",
      body: threadsBody({ "42": { title: "para1 para2" } }),
    },
    { name: "control-character title", body: threadsBody({ "42": { title: "badtitle" } }) },
  ];
  for (const { name, body } of cases) {
    it(`maps ${name} to an upstream protocol error`, async () => {
      server = await startMockServer((_req, res) => replyJson(res, body));
      const adapter = makeAdapter(server.baseUrl);
      await expect(adapter.getThreadTitle("42")).rejects.toMatchObject({
        category: "upstream_protocol",
      });
    });
  }

  it("maps a top-level `detail` error shape to an unexpected-upstream error", async () => {
    server = await startMockServer((_req, res) => replyJson(res, { threads: {}, detail: "nope" }));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).rejects.toMatchObject({
      category: "unexpected_upstream",
    });
  });

  it("rejects an oversized (>512 UTF-8 bytes) title as a protocol error", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(res, threadsBody({ "42": { title: "x".repeat(513) } })),
    );
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).rejects.toMatchObject({
      category: "upstream_protocol",
    });
  });

  it("accepts a title exactly at the 512-byte boundary", async () => {
    server = await startMockServer((_req, res) =>
      replyJson(res, threadsBody({ "42": { title: "y".repeat(512) } })),
    );
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).resolves.toEqual({
      kind: "ready",
      title: "y".repeat(512),
    });
  });
});

describe("getThreadTitle — transport bounds and status mapping (content-free)", () => {
  it("maps a 401 to a normalized authentication error", async () => {
    server = await startMockServer((_req, res) => replyRaw(res, "nope", 401, "text/plain"));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).rejects.toMatchObject({
      category: "authentication",
    });
  });

  it("maps a 403 to a normalized authentication error", async () => {
    server = await startMockServer((_req, res) => replyRaw(res, "forbidden", 403, "text/plain"));
    const adapter = makeAdapter(server.baseUrl);
    await expect(adapter.getThreadTitle("42")).rejects.toMatchObject({
      category: "authentication",
    });
  });

  it("enforces the response-size cap without exposing the body", async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(threadsBody({ "42": { title: "z".repeat(4_000) } })));
    });
    // A tiny cap forces the incremental reader to abort before the body completes.
    const adapter = makeAdapter(server.baseUrl, { ...FAST, maxResponseBytes: 64 });
    const error = await adapter.getThreadTitle("42").catch((e: unknown) => e);
    expect(error).toMatchObject({ category: "response_too_large" });
    expect(JSON.stringify(error)).not.toContain("zzzz");
  });

  it("times out (header deadline) without leaking a raw value", async () => {
    server = await startMockServer(() => {
      // Never respond: the header deadline fires.
    });
    const adapter = makeAdapter(server.baseUrl, {
      headerTimeoutMs: 60,
      bodyTimeoutMs: 60,
      maxResponseBytes: 1_048_576,
    });
    await expect(adapter.getThreadTitle("42")).rejects.toMatchObject({ category: "timeout" });
  });

  it("propagates caller cancellation before issuing the request", async () => {
    server = await startMockServer((_req, res) => replyJson(res, threadsBody({})));
    const adapter = makeAdapter(server.baseUrl);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.getThreadTitle("42", controller.signal)).rejects.toMatchObject({
      category: "cancellation",
    });
  });
});
