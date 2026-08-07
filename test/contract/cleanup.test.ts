import { afterEach, describe, expect, it } from "vitest";
import { observeThreadDeletion, resolveThreadDeletion } from "../../src/collectiviq/cleanup.js";
import { startMockServer, replyJson, type MockServer } from "./support/mock-server.js";
import { TEST_API_KEY, FAST_TIMEOUTS } from "./support/adapter.js";
import type { CollectivIQTransportConfig, FetchLike } from "../../src/collectiviq/types.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

// A synthetic id; never a real thread identifier.
const SYNTHETIC_ID = "t-synthetic";

describe("cleanup delete diagnostics", () => {
  it("returns a value-free success for a 2xx delete", async () => {
    server = await startMockServer((req, res) => {
      if (req.method === "DELETE") return replyJson(res, {});
      return replyJson(res, {}, 404);
    });
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };
    const diag = await observeThreadDeletion(config, SYNTHETIC_ID, FAST_TIMEOUTS);
    expect(diag).toEqual({ ok: true, status: 200, errorCode: null });
    expect(JSON.stringify(diag)).not.toContain(SYNTHETIC_ID);
  });

  it("distinguishes a 403 from a network and a timeout failure, all value-free", async () => {
    // 403 via a real response keeps its status and normalized safe code.
    server = await startMockServer((req, res) => {
      if (req.method === "DELETE") return replyJson(res, { detail: "forbidden" }, 403);
      return replyJson(res, {}, 404);
    });
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };
    const forbidden = await observeThreadDeletion(config, SYNTHETIC_ID, FAST_TIMEOUTS);
    expect(forbidden).toEqual({
      ok: false,
      status: 403,
      errorCode: "upstream_authentication_failed",
    });
    expect(JSON.stringify(forbidden)).not.toContain("forbidden");

    // A network failure has no status and the network code.
    const throwingFetch: FetchLike = () => Promise.reject(new Error("boom"));
    const network = await observeThreadDeletion(
      { baseUrl: "https://api.prod.collectiviq.ai", apiKey: TEST_API_KEY, fetch: throwingFetch },
      SYNTHETIC_ID,
      FAST_TIMEOUTS,
    );
    expect(network).toEqual({ ok: false, status: null, errorCode: "upstream_network_error" });

    // A header-deadline timeout is distinct from the network failure.
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    const timeout = await observeThreadDeletion(
      { baseUrl: "https://api.prod.collectiviq.ai", apiKey: TEST_API_KEY, fetch: hangingFetch },
      SYNTHETIC_ID,
      { headerTimeoutMs: 20, bodyTimeoutMs: 20, maxResponseBytes: 1_048_576 },
    );
    expect(timeout).toEqual({ ok: false, status: null, errorCode: "upstream_timeout" });
  });
});

describe("recovery delete resolution", () => {
  it("resolves a 2xx delete as deleted (HTTP truth preserved)", async () => {
    server = await startMockServer((req, res) => {
      if (req.method === "DELETE") return replyJson(res, {});
      return replyJson(res, {}, 404);
    });
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };
    const outcome = await resolveThreadDeletion(config, SYNTHETIC_ID, FAST_TIMEOUTS);
    expect(outcome).toEqual({
      diagnostics: { ok: true, status: 200, errorCode: null },
      resolved: true,
      resolution: "deleted",
    });
  });

  it("resolves an exact 404 as already_absent without relabeling HTTP truth", async () => {
    server = await startMockServer((_req, res) => replyJson(res, { detail: "gone" }, 404));
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };
    const outcome = await resolveThreadDeletion(config, SYNTHETIC_ID, FAST_TIMEOUTS);
    // A 404 is not an HTTP success: ok stays false, status stays 404.
    expect(outcome.diagnostics.ok).toBe(false);
    expect(outcome.diagnostics.status).toBe(404);
    expect(outcome.resolved).toBe(true);
    expect(outcome.resolution).toBe("already_absent");
    expect(JSON.stringify(outcome)).not.toContain("gone");
  });

  it("does not resolve a 403, a 410, or a network failure", async () => {
    server = await startMockServer((_req, res) => replyJson(res, {}, 403));
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };
    const forbidden = await resolveThreadDeletion(config, SYNTHETIC_ID, FAST_TIMEOUTS);
    expect(forbidden.resolved).toBe(false);
    expect(forbidden.resolution).toBeNull();
    expect(forbidden.diagnostics.status).toBe(403);

    await server.close();
    server = await startMockServer((_req, res) => replyJson(res, {}, 410));
    const config2: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };
    const gone = await resolveThreadDeletion(config2, SYNTHETIC_ID, FAST_TIMEOUTS);
    expect(gone.resolved).toBe(false);

    const throwingFetch: FetchLike = () => Promise.reject(new Error("boom"));
    const network = await resolveThreadDeletion(
      { baseUrl: "https://api.prod.collectiviq.ai", apiKey: TEST_API_KEY, fetch: throwingFetch },
      SYNTHETIC_ID,
      FAST_TIMEOUTS,
    );
    expect(network.resolved).toBe(false);
    expect(network.diagnostics.errorCode).toBe("upstream_network_error");
  });
});
