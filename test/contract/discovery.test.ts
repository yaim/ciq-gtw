import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModelSelection,
  buildPreflightReport,
  DISCOVERY_ORIGIN,
  DiscoverySessionRunner,
  exitCodeForBaseline,
  parseCombinedLlms,
  parseSingleLlm,
  projectCounts,
  readSseEvidence,
  type DiscoveryModelSelection,
  type DiscoveryObservation,
  type DiscoverySseLimits,
} from "../../src/collectiviq/discovery.js";
import { parseDiscoveryArgs } from "../../src/collectiviq/discovery-cli.js";
import { InMemoryRecoveryJournal } from "../../src/collectiviq/recovery-journal.js";
import {
  replyJson,
  startMockServer,
  type CapturedRequest,
  type MockHandler,
  type MockServer,
} from "./support/mock-server.js";
import { testTransportConfig } from "./support/adapter.js";
import type {
  CollectivIQCredentialProvider,
  CredentialLease,
  FetchLike,
} from "../../src/collectiviq/types.js";

/**
 * Run a baseline with recovery-journal approval and a synthetic in-memory
 * journal, so existing scenarios exercise the new mandatory approval without
 * touching disk. Tests that need to inspect the journal pass their own via
 * `runner.executeBaseline` directly.
 */
function baseline(
  r: DiscoverySessionRunner,
  opts: {
    selection: DiscoveryModelSelection;
    cleanupApproved: boolean;
    observeNotFoundApproved: boolean;
    signal?: AbortSignal;
  },
): Promise<Awaited<ReturnType<DiscoverySessionRunner["executeBaseline"]>>> {
  return r.executeBaseline({
    ...opts,
    recoveryJournalApproved: true,
    recoveryJournal: new InMemoryRecoveryJournal(),
  });
}

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

// --- Mock upstream ------------------------------------------------------------

/** A full baseline-capable mock upstream. `onDelete` overrides delete handling. */
function baselineHandler(options: { deleteStatus?: number } = {}): MockHandler {
  let nextThread = 1000;
  const deleted = new Set<string>();
  return (req, res) => {
    if (req.path === "/available_llms") {
      const authz = req.headers["authorization"];
      // An empty bearer ("Bearer " / trimmed to "Bearer") is the auth-error probe.
      if (typeof authz === "string" && authz.trim() === "Bearer") {
        return replyJson(res, { error: "denied" }, 401);
      }
      // A structurally-valid inventory: an `llms` object whose entries are objects.
      // Values are still content the capture must mask.
      return replyJson(res, { llms: { "m-SECRET": { display: "SECRET-MODEL" } } });
    }
    if (req.path === "/get_messages") {
      const threadId = req.query.get("thread_id");
      // No thread id => the intentional validation probe (raw error captured).
      if (threadId === null) return replyJson(res, { detail: "invalid request" }, 422);
      return replyJson(res, {
        messages: [{ source: "gpt", content: "SECRET ANSWER TEXT", percent_usage: 12 }],
      });
    }
    if (req.path === "/create_thread" && req.method === "POST") {
      nextThread += 1;
      return replyJson(res, { thread_id: nextThread });
    }
    if (req.path === "/process_message" && req.method === "POST") {
      // The raw response carries a run id that discovery must capture structurally
      // (never by value) rather than discard during normalization.
      return replyJson(res, { run_id: 5000 });
    }
    if (req.path.startsWith("/delete_thread/") && req.method === "DELETE") {
      if (options.deleteStatus !== undefined) return replyJson(res, {}, options.deleteStatus);
      const id = decodeURIComponent(req.path.slice("/delete_thread/".length));
      if (deleted.has(id)) return replyJson(res, { detail: "not found" }, 404);
      deleted.add(id);
      return replyJson(res, {});
    }
    if (req.path === "/user/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: tick\ndata: {"seq":1,"token":"SECRET"}\n\n');
      res.end();
      return;
    }
    return replyJson(res, {}, 404);
  };
}

function multipartField(text: string, name: string): string | null {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(text);
  return match ? (match[1] ?? null) : null;
}

function processMessageBodies(requests: readonly CapturedRequest[]): string[] {
  return requests.filter((r) => r.path === "/process_message").map((r) => r.text());
}

// --- SSE synthetic-stream helpers --------------------------------------------

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i];
      i += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

function sseResponse(chunks: Uint8Array[], contentType = "text/event-stream"): Response {
  return new Response(streamOf(chunks), { headers: { "content-type": contentType } });
}

const SSE_LIMITS: DiscoverySseLimits = {
  headerTimeoutMs: 1_000,
  bodyTimeoutMs: 1_000,
  maxEvents: 5,
  maxEventBytes: 8_192,
  maxBytes: 65_536,
};

// --- Preflight ---------------------------------------------------------------

describe("discovery preflight", () => {
  it("reports projected counts, fixed origin, and approvals without ids", () => {
    const report = buildPreflightReport(
      { CIQ_DISCOVERY_SINGLE_LLM: "m1", CIQ_DISCOVERY_COMBINED_LLMS: "a,b,c" },
      { cleanupApproved: true, notFoundObservationApproved: false, recoveryJournalApproved: true },
    );
    expect(report.session).toBe("baseline");
    expect(report.destinationOrigin).toBe(DISCOVERY_ORIGIN);
    expect(report.destinationOrigin).toBe("https://api.prod.collectiviq.ai");
    expect(report.projectedCounts).toEqual({
      maxThreads: 2,
      maxMessageSubmissions: 2,
      singleStageSelectedJobs: 1,
      combinedStageSelectedJobs: 3,
      maxSynthesisJobs: 1,
    });
    expect(report.cleanupApproved).toBe(true);
    expect(report.notFoundObservationApproved).toBe(false);
    // Preflight reports the recovery-journal approval boolean for transparency,
    // but performs no journal I/O (covered by the credential/no-network test).
    expect(report.recoveryJournalApproved).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("m1");
    expect(serialized).not.toContain("a,b,c");
  });

  it("makes zero network calls and never reads the credential env var", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const guardedEnv = new Proxy<NodeJS.ProcessEnv>(
      {},
      {
        get(_target, key) {
          // Guard EVERY upstream credential variable, not just the bearer key, so
          // preflight is proven credential-free in both auth modes.
          if (
            key === "COLLECTIVIQ_API_KEY" ||
            key === "COLLECTIVIQ_USERNAME" ||
            key === "COLLECTIVIQ_PASSWORD"
          ) {
            throw new Error("credential read during preflight");
          }
          if (key === "CIQ_DISCOVERY_SINGLE_LLM") return "m1";
          if (key === "CIQ_DISCOVERY_COMBINED_LLMS") return "a,b";
          return undefined;
        },
      },
    );
    const report = buildPreflightReport(guardedEnv, {
      cleanupApproved: false,
      notFoundObservationApproved: false,
    });
    expect(report.projectedCounts.combinedStageSelectedJobs).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid model selection", () => {
    expect(() =>
      buildPreflightReport({}, { cleanupApproved: false, notFoundObservationApproved: false }),
    ).toThrow();
  });
});

// --- Model modes -------------------------------------------------------------

describe("discovery model modes", () => {
  it("rejects an empty, whitespace, or comma-bearing single model", () => {
    expect(() => parseSingleLlm("")).toThrow();
    expect(() => parseSingleLlm("   ")).toThrow();
    expect(() => parseSingleLlm(undefined)).toThrow();
    expect(() => parseSingleLlm("a,b")).toThrow();
    expect(parseSingleLlm("  solo ")).toBe("solo");
  });

  it("rejects duplicate combined models rather than silently deduplicating", () => {
    expect(() => parseCombinedLlms("a,b,a")).toThrow();
    expect(() => parseCombinedLlms("")).toThrow();
    expect(() => parseCombinedLlms("a,,b")).toThrow();
    const tooMany = Array.from({ length: 33 }, (_v, i) => `m${i}`).join(",");
    expect(() => parseCombinedLlms(tooMany)).toThrow();
    const max = Array.from({ length: 32 }, (_v, i) => `m${i}`).join(",");
    expect(parseCombinedLlms(max)).toHaveLength(32);
    expect(parseCombinedLlms("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("derives projected counts from a validated selection", () => {
    const selection = buildModelSelection({
      CIQ_DISCOVERY_SINGLE_LLM: "solo",
      CIQ_DISCOVERY_COMBINED_LLMS: "a,b,c,d",
    });
    expect(projectCounts(selection).combinedStageSelectedJobs).toBe(4);
  });
});

// --- Authenticated execution -------------------------------------------------

describe("discovery baseline execution", () => {
  it("submits the deterministic single and combined stages without leaking ids", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));

    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a", "b", "c"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });

    const bodies = processMessageBodies(server.requests);
    expect(bodies).toHaveLength(2);
    const singleBody = bodies[0] ?? "";
    const combinedBody = bodies[1] ?? "";
    expect(multipartField(singleBody, "generate_combined")).toBe("false");
    expect(multipartField(singleBody, "selected_llms")).toBe("solo");
    expect(multipartField(combinedBody, "generate_combined")).toBe("true");
    expect(multipartField(combinedBody, "selected_llms")).toBe("a,b,c");

    // Raw upstream identifiers, model names, and answers never appear.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("1001");
    expect(serialized).not.toContain("1002");
    expect(serialized).not.toContain("5000");
    expect(serialized).not.toContain("SECRET-MODEL");
    expect(serialized).not.toContain("SECRET ANSWER TEXT");
    expect(report.evidenceFormatVersion).toBe(2);
  });

  it("captures raw process_message run_id structurally (name kept, value gone)", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const submit = report.observations.find((o) => o.stage === "single_submit");
    expect(submit?.ok).toBe(true);
    // The safe field name survives as a structural marker; the value does not.
    expect(submit?.structure).toEqual({ run_id: "<number>" });
    expect(JSON.stringify(submit)).not.toContain("5000");
  });

  it("captures raw auth and validation error bodies structurally", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const auth = report.observations.find((o) => o.stage === "auth_error");
    expect(auth?.ok).toBe(false);
    expect(auth?.errorCode).toBe("upstream_authentication_failed");
    expect(auth?.structure).not.toBeNull();
    const validation = report.observations.find((o) => o.stage === "validation_error");
    expect(validation?.errorCode).toBe("upstream_validation_failed");
    // The validation error's raw shape is captured (its `detail` field name kept).
    expect(validation?.structure).toEqual({ detail: "<string>" });
    expect(JSON.stringify(report)).not.toContain("invalid request");
  });

  it("cleans up only session-owned threads when approved, reporting remaining", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
    });
    expect(report.cleanup).toEqual({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      remaining: 0,
      journalPersistenceFailed: 0,
      attempts: [
        { phase: "final-cleanup", ok: true, status: 200, errorCode: null, journalPersisted: true },
        { phase: "final-cleanup", ok: true, status: 200, errorCode: null, journalPersisted: true },
      ],
    });
    expect(runner.pendingThreadCount()).toBe(0);
  });

  it("reports failure and retains ownership when an approved cleanup delete fails", async () => {
    server = await startMockServer(baselineHandler({ deleteStatus: 500 }));
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
    });
    expect(report.cleanup?.attempted).toBe(2);
    expect(report.cleanup?.failed).toBe(2);
    expect(report.cleanup?.remaining).toBe(2);
    // The failed deletes retain their HTTP status and safe error code (value-free).
    expect(report.cleanup?.attempts).toEqual([
      {
        phase: "final-cleanup",
        ok: false,
        status: 500,
        errorCode: "upstream_unexpected_error",
        journalPersisted: null,
      },
      {
        phase: "final-cleanup",
        ok: false,
        status: 500,
        errorCode: "upstream_unexpected_error",
        journalPersisted: null,
      },
    ]);
    expect(report.cleanup?.journalPersistenceFailed).toBe(0);
    expect(runner.pendingThreadCount()).toBe(2);
  });

  it("does not clean up when cleanup is not approved", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.cleanup).toBeNull();
    expect(runner.pendingThreadCount()).toBe(2);
  });
});

// --- Recovery-journal integration --------------------------------------------

describe("discovery recovery-journal integration", () => {
  it("rejects a run without recovery-journal approval before any request", async () => {
    const fetch = vi.fn<FetchLike>();
    const runner = new DiscoverySessionRunner(
      testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
    );
    await expect(
      runner.executeBaseline({
        selection: { single: "solo", combined: ["a"] },
        cleanupApproved: false,
        observeNotFoundApproved: false,
        recoveryJournalApproved: false,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an approved run that supplies no journal sink before any request", async () => {
    const fetch = vi.fn<FetchLike>();
    const runner = new DiscoverySessionRunner(
      testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
    );
    await expect(
      runner.executeBaseline({
        selection: { single: "solo", combined: ["a"] },
        cleanupApproved: false,
        observeNotFoundApproved: false,
        recoveryJournalApproved: true,
        // No recoveryJournal sink: this creating flow must be rejected.
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("initializes the journal before the first request and fails closed if init throws", async () => {
    const fetch = vi.fn<FetchLike>();
    const runner = new DiscoverySessionRunner(
      testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
    );
    const journal = new InMemoryRecoveryJournal();
    journal.init = (): Promise<void> => Promise.reject(new Error("journal not writable"));
    await expect(
      runner.executeBaseline({
        selection: { single: "solo", combined: ["a"] },
        cleanupApproved: false,
        observeNotFoundApproved: false,
        recoveryJournalApproved: true,
        recoveryJournal: journal,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records created ids and drops them after a successful cleanup", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const journal = new InMemoryRecoveryJournal();
    const report = await runner.executeBaseline({
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      recoveryJournal: journal,
    });
    expect(journal.initialized).toBe(true);
    // Two threads created then both deleted: the journal ends empty.
    expect(journal.ownedThreadIds()).toEqual([]);
    expect(report.cleanup?.remaining).toBe(0);
  });

  it("retains ids in the journal when cleanup fails, so they stay recoverable", async () => {
    server = await startMockServer(baselineHandler({ deleteStatus: 500 }));
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const journal = new InMemoryRecoveryJournal();
    const report = await runner.executeBaseline({
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      recoveryJournal: journal,
    });
    // Both deletes fail, so both ids remain in the journal for recovery.
    expect(journal.ownedThreadIds()).toHaveLength(2);
    expect(report.cleanup?.remaining).toBe(2);
  });

  it("retains only the undeleted id in the journal when cleanup partially fails", async () => {
    // First delete (single thread) succeeds; the second (combined thread) fails.
    let nextThread = 1000;
    let deletes = 0;
    const handler: MockHandler = (req, res) => {
      if (req.path === "/available_llms") return replyJson(res, { models: [] });
      if (req.path === "/get_messages") {
        return req.query.get("thread_id") === null
          ? replyJson(res, { detail: "x" }, 422)
          : replyJson(res, { messages: [] });
      }
      if (req.path === "/create_thread") {
        nextThread += 1;
        return replyJson(res, { thread_id: nextThread });
      }
      if (req.path === "/process_message") return replyJson(res, {});
      if (req.path.startsWith("/delete_thread/")) {
        deletes += 1;
        return replyJson(res, {}, deletes === 1 ? 200 : 500);
      }
      if (req.path === "/user/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end();
        return;
      }
      return replyJson(res, {}, 404);
    };
    server = await startMockServer(handler);
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const journal = new InMemoryRecoveryJournal();
    const report = await runner.executeBaseline({
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      recoveryJournal: journal,
    });
    expect(report.cleanup?.succeeded).toBe(1);
    expect(report.cleanup?.failed).toBe(1);
    expect(journal.ownedThreadIds()).toHaveLength(1);
  });
});

// --- available_llms structural gate ------------------------------------------

describe("discovery available_llms structural gate", () => {
  it("accepts a well-formed llms inventory as a successful observation", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const llms = report.observations.find((o) => o.stage === "available_llms");
    expect(llms?.ok).toBe(true);
    expect(llms?.status).toBe(200);
    expect(llms?.errorCode).toBeNull();
  });

  it("rejects a malformed 2xx inventory as invalid_upstream_response and fails completeness", async () => {
    // Every other stage is a valid happy path; only the inventory is malformed.
    const malformed = [
      { models: [] }, // no `llms` property
      { llms: [] }, // `llms` is an array
      { llms: {} }, // `llms` has no entries
      { llms: { "m-1": 5 } }, // an entry is not an object
      { llms: { "m-1": null } }, // an entry is null
    ];
    for (const body of malformed) {
      const s = await startMockServer(regressionHandler({ available: () => ({ body }) }));
      try {
        const runner = new DiscoverySessionRunner(testTransportConfig(s.baseUrl));
        const report = await baseline(runner, {
          selection: { single: "solo", combined: ["a"] },
          cleanupApproved: false,
          observeNotFoundApproved: false,
        });
        const llms = report.observations.find((o) => o.stage === "available_llms");
        expect(llms?.ok).toBe(false);
        expect(llms?.status).toBe(200);
        expect(llms?.errorCode).toBe("invalid_upstream_response");
        // The sanitized structure is still retained (value-free).
        expect(llms?.structure).not.toBeNull();
        expect(exitCodeForBaseline(report)).not.toBe(0);
      } finally {
        await s.close();
      }
    }
  });

  it("rejects an inherited (non-own) llms property", async () => {
    // Pollute Object.prototype so every parsed object INHERITS a valid-looking
    // `llms`; a body without its OWN `llms` must still be rejected. Restored in
    // `finally` so no other test observes the pollution.
    Object.defineProperty(Object.prototype, "llms", {
      value: { "m-inherited": {} },
      configurable: true,
      enumerable: false,
      writable: true,
    });
    server = await startMockServer(regressionHandler({ available: () => ({ body: {} }) }));
    try {
      const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
      const report = await baseline(runner, {
        selection: { single: "solo", combined: ["a"] },
        cleanupApproved: false,
        observeNotFoundApproved: false,
      });
      const llms = report.observations.find((o) => o.stage === "available_llms");
      expect(llms?.ok).toBe(false);
      expect(llms?.errorCode).toBe("invalid_upstream_response");
      expect(exitCodeForBaseline(report)).not.toBe(0);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["llms"];
    }
  });
});

// --- Fatal recovery-journal persistence failure ------------------------------

describe("discovery fatal journal-persistence abort", () => {
  it("aborts after a failed recordCreated: one create, no submit, cleanup attempted, content-free", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const journal = new InMemoryRecoveryJournal();
    // Persisting the first created id fails durably; the injected message must
    // never appear in the sanitized report.
    journal.recordCreated = (): Promise<void> =>
      Promise.reject(new Error("SECRET-JOURNAL-PATH /Users/x/.agent"));

    const report = await runner.executeBaseline({
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      recoveryJournal: journal,
    });

    // The run aborted with a fixed, content-free reason and is non-zero.
    expect(report.aborted).toBe("journal-persistence-failed");
    expect(exitCodeForBaseline(report)).not.toBe(0);

    // Exactly one thread was created; no submission and no second create ran.
    const creates = server.requests.filter((r) => r.path === "/create_thread");
    expect(creates).toHaveLength(1);
    expect(server.requests.some((r) => r.path === "/process_message")).toBe(false);
    // Cleanup of the in-memory-owned thread was attempted (the created id 1001).
    const deletes = server.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual(["/delete_thread/1001"]);
    // No aborted-stage success observation was recorded for the created thread.
    expect(report.observations.some((o) => o.stage === "single_thread_create" && o.ok)).toBe(false);
    expect(report.observations.some((o) => o.stage === "combined_thread_create")).toBe(false);

    // Neither the created id nor the injected filesystem error text leaks.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("1001");
    expect(serialized).not.toContain("SECRET-JOURNAL-PATH");
    expect(serialized).not.toContain(".agent");
  });

  it("still returns a structured abort report when the cleanup DELETE's journal removal also fails", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const journal = new InMemoryRecoveryJournal();
    // BOTH the create-time record and the cleanup-time removal fail durably.
    journal.recordCreated = (): Promise<void> =>
      Promise.reject(new Error("SECRET-CREATE /Users/x/.agent/a"));
    journal.recordDeleted = (): Promise<void> =>
      Promise.reject(new Error("SECRET-DELETE /Users/x/.agent/b"));

    // Must resolve with a structured report, NOT reject.
    const report = await runner.executeBaseline({
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      recoveryJournal: journal,
    });

    expect(report.aborted).toBe("journal-persistence-failed");
    expect(exitCodeForBaseline(report)).not.toBe(0);

    // Exactly one create, one cleanup DELETE, no submission, no second create.
    expect(server.requests.filter((r) => r.path === "/create_thread")).toHaveLength(1);
    expect(server.requests.some((r) => r.path === "/process_message")).toBe(false);
    const deletes = server.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual(["/delete_thread/1001"]);

    // The cleanup DELETE succeeded over HTTP but its journal removal did not.
    expect(report.cleanup?.succeeded).toBe(1);
    expect(report.cleanup?.failed).toBe(0);
    expect(report.cleanup?.remaining).toBe(0);
    expect(report.cleanup?.journalPersistenceFailed).toBe(1);
    expect(report.cleanup?.attempts).toEqual([
      { phase: "final-cleanup", ok: true, status: 200, errorCode: null, journalPersisted: false },
    ]);
    // The thread is dropped from the in-memory ledger despite the journal failure.
    expect(runner.pendingThreadCount()).toBe(0);

    // No raw injected error, path, or id leaks.
    const serialized = JSON.stringify(report);
    for (const leak of ["1001", "SECRET-CREATE", "SECRET-DELETE", ".agent"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("keeps a normal cleanup structured and non-zero when a journal removal fails", async () => {
    // No abort (recordCreated succeeds); a full baseline runs, then each cleanup
    // DELETE's journal removal fails. The run must still return a structured,
    // non-zero report rather than reject.
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const journal = new InMemoryRecoveryJournal();
    journal.recordDeleted = (): Promise<void> =>
      Promise.reject(new Error("SECRET-DELETE /Users/x/.agent"));

    const report = await runner.executeBaseline({
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      recoveryJournal: journal,
    });

    expect(report.aborted).toBeUndefined();
    expect(report.cleanup?.succeeded).toBe(2);
    expect(report.cleanup?.failed).toBe(0);
    expect(report.cleanup?.remaining).toBe(0);
    expect(report.cleanup?.journalPersistenceFailed).toBe(2);
    expect(report.cleanup?.attempts.every((a) => a.ok && a.journalPersisted === false)).toBe(true);
    expect(exitCodeForBaseline(report)).not.toBe(0);
    expect(runner.pendingThreadCount()).toBe(0);
    expect(JSON.stringify(report)).not.toContain("SECRET-DELETE");
  });

  it("makes zero network calls when journal init fails before any create", async () => {
    const fetch = vi.fn<FetchLike>();
    const runner = new DiscoverySessionRunner(
      testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
    );
    const journal = new InMemoryRecoveryJournal();
    journal.init = (): Promise<void> => Promise.reject(new Error("not writable"));
    await expect(
      runner.executeBaseline({
        selection: { single: "solo", combined: ["a"] },
        cleanupApproved: true,
        observeNotFoundApproved: false,
        recoveryJournalApproved: true,
        recoveryJournal: journal,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// --- Approval invariants (runner-level, before any request) ------------------

describe("discovery runner approval invariants", () => {
  it("rejects not-found approval without cleanup approval before any fetch", async () => {
    const fetch = vi.fn<FetchLike>();
    const runner = new DiscoverySessionRunner(
      testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
    );
    await expect(
      baseline(runner, {
        selection: { single: "solo", combined: ["a"] },
        cleanupApproved: false,
        observeNotFoundApproved: true,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a duplicate combined selection before any fetch", async () => {
    const fetch = vi.fn<FetchLike>();
    const runner = new DiscoverySessionRunner(
      testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
    );
    await expect(
      baseline(runner, {
        selection: { single: "solo", combined: ["a", "a"] },
        cleanupApproved: false,
        observeNotFoundApproved: false,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// --- Not-found observation ---------------------------------------------------

describe("discovery not-found observation", () => {
  it("re-deletes the same session-owned id and never a guessed id", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: true,
    });

    expect(report.notFoundRequested).toBe(true);
    expect(report.notFound?.stage).toBe("not_found");
    // The re-delete yields an HTTP response (404), i.e. evidence obtained.
    expect(report.notFound?.status).toBe(404);
    const deletePaths = server.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    // The first created thread (1001) is deleted twice: once as cleanup work,
    // once for the not-found re-delete of the SAME id.
    expect(deletePaths.filter((p) => p === "/delete_thread/1001")).toHaveLength(2);
    expect(deletePaths.some((p) => p.includes("nonexistent"))).toBe(false);
    // The second (already-deleted) observation is NOT counted as cleanup work:
    // one first-delete (1001) + one final cleanup (1002) = two attempts, and the
    // phases are reported accurately.
    expect(report.cleanup).toEqual({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      remaining: 0,
      journalPersistenceFailed: 0,
      attempts: [
        {
          phase: "not-found-initial",
          ok: true,
          status: 200,
          errorCode: null,
          journalPersisted: true,
        },
        { phase: "final-cleanup", ok: true, status: 200, errorCode: null, journalPersisted: true },
      ],
    });
  });

  it("skips the second delete and retains ownership when the first delete fails", async () => {
    // Every delete returns 500, so the not-found first deletion fails.
    server = await startMockServer(baselineHandler({ deleteStatus: 500 }));
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: true,
      observeNotFoundApproved: true,
    });
    // The not-found evidence is incomplete (no successful first delete → no re-delete).
    expect(report.notFound?.status).toBeNull();
    // The failed first deletion is a recorded failure; the id is retried by
    // final cleanup (also failing here), and the failure count is never erased.
    expect(report.cleanup?.failed).toBeGreaterThan(0);
    expect(report.cleanup?.remaining).toBeGreaterThan(0);
  });

  it("is unavailable in the CLI unless cleanup is also approved", () => {
    expect(() =>
      parseDiscoveryArgs(["--session=baseline", "--observe-not-found-approved"]),
    ).toThrow();
    expect(
      parseDiscoveryArgs([
        "--session=baseline",
        "--execute-approved",
        "--recovery-journal-approved",
        "--cleanup-approved",
        "--observe-not-found-approved",
      ]).observeNotFoundApproved,
    ).toBe(true);
  });
});

// --- Token / abort unreachability --------------------------------------------

describe("discovery token/abort unreachability", () => {
  it("never touches token or abort endpoints and exposes no such method", async () => {
    server = await startMockServer(baselineHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    await baseline(runner, {
      selection: { single: "solo", combined: ["a", "b"] },
      cleanupApproved: true,
      observeNotFoundApproved: true,
    });
    const paths = server.requests.map((r) => r.path);
    expect(paths.some((p) => p.includes("thread_tokens"))).toBe(false);
    expect(paths.some((p) => p.includes("abort_run"))).toBe(false);
    expect(Reflect.get(runner, "tokenReporting")).toBeUndefined();
    expect(Reflect.get(runner, "cooperativeAbort")).toBeUndefined();
  });
});

// --- SSE evidence: content type, framing, sanitization -----------------------

describe("discovery SSE evidence", () => {
  it("requires a text/event-stream content type and retains nothing otherwise", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc('event: tick\ndata: {"a":1}\n\n')], "application/json"),
      SSE_LIMITS,
    );
    expect(obs.termination).toBe("invalid-content-type");
    expect(obs.events).toEqual([]);
  });

  it("parses LF-separated records and sanitizes data JSON", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc('event: tick\ndata: {"seq":1,"token":"SECRET"}\n\n')]),
      SSE_LIMITS,
    );
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]?.eventName).toBe("tick");
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("token");
    expect(serialized).toContain("<number>");
  });

  it("parses CRLF-separated records", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc("event: tick\r\ndata: {}\r\n\r\n")]),
      SSE_LIMITS,
    );
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]?.eventName).toBe("tick");
  });

  it("handles a record separator split across chunk boundaries", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc("event: tick\r\ndata: {}\r\n"), enc("\r\nevent:done\r\ndata:{}\r\n\r\n")]),
      SSE_LIMITS,
    );
    expect(obs.events.length).toBeGreaterThanOrEqual(1);
    expect(obs.events[0]?.eventName).toBe("tick");
    expect(obs.termination).toBe("completed");
  });

  it("terminates on mid-stream malformed UTF-8", async () => {
    const obs = await readSseEvidence(
      sseResponse([new Uint8Array([0xff, 0xfe, 0xff])]),
      SSE_LIMITS,
    );
    expect(obs.termination).toBe("malformed-utf8");
  });

  it("terminates on a truncated terminal multibyte sequence at EOF", async () => {
    // Valid text followed by a lone UTF-8 lead byte, then a clean stream end.
    const chunk = new Uint8Array([...enc("data: x"), 0xe2]);
    const obs = await readSseEvidence(sseResponse([chunk]), SSE_LIMITS);
    expect(obs.termination).toBe("malformed-utf8");
  });

  it("terminates with body-limit on an oversized unterminated record", async () => {
    const chunk = enc("data: " + "y".repeat(200)); // no blank-line terminator
    const obs = await readSseEvidence(sseResponse([chunk]), {
      ...SSE_LIMITS,
      maxEventBytes: 16,
      maxBytes: 65_536,
    });
    expect(obs.termination).toBe("body-limit");
  });

  it("terminates with body-limit when the total size cap is exceeded", async () => {
    const obs = await readSseEvidence(sseResponse([enc("event: tick\ndata: {}\n\n")]), {
      ...SSE_LIMITS,
      maxBytes: 4,
    });
    expect(obs.termination).toBe("body-limit");
    expect(obs.events).toEqual([]);
  });

  it("terminates with event-limit when the event count cap is reached", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc("event: a\ndata: {}\n\nevent: b\ndata: {}\n\n")]),
      { ...SSE_LIMITS, maxEvents: 1 },
    );
    expect(obs.termination).toBe("event-limit");
    expect(obs.events).toHaveLength(1);
  });

  it("terminates with body-limit when a single completed event exceeds the per-event cap", async () => {
    const big = `event: tick\ndata: {"x":"${"y".repeat(200)}"}\n\n`;
    const obs = await readSseEvidence(sseResponse([enc(big)]), {
      ...SSE_LIMITS,
      maxEventBytes: 16,
    });
    expect(obs.termination).toBe("body-limit");
  });

  it("retains only safe event names, marking weird names unsupported", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc("event: weird name!\ndata: {}\n\n")]),
      SSE_LIMITS,
    );
    expect(obs.events[0]?.eventName).toBe("<unsupported-event-name>");
  });
});

// --- SSE evidence: termination-reason distinctions ---------------------------

describe("discovery SSE termination reasons", () => {
  it("distinguishes external cancellation from a clean end", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueues; only cancellation resolves the pending read.
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    controller.abort();
    const obs = await readSseEvidence(response, SSE_LIMITS, controller.signal);
    expect(cancelled).toBe(true);
    expect(obs.termination).toBe("cancelled");
    expect(obs.events).toEqual([]);
  });

  it("reports a body-read timeout distinctly from cancellation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueues; the body timer must fire.
      },
    });
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const obs = await readSseEvidence(response, { ...SSE_LIMITS, bodyTimeoutMs: 20 });
    expect(obs.termination).toBe("timeout");
  });

  it("reports a mid-stream reset as stream-error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const obs = await readSseEvidence(response, SSE_LIMITS);
    expect(obs.termination).toBe("stream-error");
  });

  it("reports a clean EOF when the stream ends without a terminal event", async () => {
    const obs = await readSseEvidence(sseResponse([enc("event: tick\ndata: {}\n\n")]), SSE_LIMITS);
    expect(obs.termination).toBe("eof");
  });
});

// --- SSE evidence: value-free correlation ------------------------------------

describe("discovery SSE correlation (value-free)", () => {
  it("reports matched when the stream echoes a requested id, without leaking it", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc('data: {"thread_id":"t-secret","run_id":"r-secret"}\n\n')]),
      SSE_LIMITS,
      undefined,
      undefined,
      { threadId: "t-secret", runId: "r-secret", combinedRunId: null },
    );
    expect(obs.correlation).toEqual({ thread: "matched", run: "matched" });
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain("t-secret");
    expect(serialized).not.toContain("r-secret");
  });

  it("reports not-matched when a candidate of that kind differed", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc('data: {"thread_id":"other"}\n\n')]),
      SSE_LIMITS,
      undefined,
      undefined,
      { threadId: "t-1", runId: null, combinedRunId: null },
    );
    expect(obs.correlation.thread).toBe("not-matched");
  });

  it("reports not-observed when no candidate of that kind appeared", async () => {
    const obs = await readSseEvidence(
      sseResponse([enc('data: {"seq":1}\n\n')]),
      SSE_LIMITS,
      undefined,
      undefined,
      { threadId: "t-1", runId: "r-1", combinedRunId: null },
    );
    expect(obs.correlation).toEqual({ thread: "not-observed", run: "not-observed" });
  });
});

// --- SSE evidence: non-2xx through the runner --------------------------------

describe("discovery SSE non-2xx handling", () => {
  it("rejects a non-2xx SSE response instead of reporting ok", async () => {
    const handler: MockHandler = (req, res) => {
      if (req.path === "/user/events") return replyJson(res, { detail: "unauthorized" }, 401);
      if (req.path === "/available_llms") return replyJson(res, { models: [] });
      if (req.path === "/get_messages") {
        return req.query.get("thread_id") === null
          ? replyJson(res, { detail: "x" }, 422)
          : replyJson(res, { messages: [] });
      }
      if (req.path === "/create_thread") return replyJson(res, { thread_id: 7 });
      if (req.path === "/process_message") return replyJson(res, {});
      if (req.path.startsWith("/delete_thread/")) return replyJson(res, {});
      return replyJson(res, {}, 404);
    };
    server = await startMockServer(handler);
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const sse = report.observations.find((o) => o.stage === "sse_structure");
    expect(sse?.ok).toBe(false);
    expect(sse?.status).toBe(401);
    expect(sse?.structure).toBeNull();
  });
});

// --- SSE bespoke lease behavior (401 invalidation, 403 no-invalidation) ------

/**
 * A spy credential provider that records an ORDERED, value-free ledger of its
 * lifecycle events and always returns one fixed lease. Unlike the static bearer
 * provider it lets a test prove the transport's exact acquire -> invalidate ->
 * reacquire causality across the SSE stage, not merely aggregate counts.
 *
 * The ledger pushes `"acquire"` on every {@link acquire} and
 * `"invalidate:<generation>"` on every {@link invalidate} (using the exact
 * lease's `generation`, so a late invalidation of a stale generation would be
 * distinguishable). The lease/generation/token never change: genuine token
 * re-minting is proven separately in `auth.test.ts`; here we only prove the
 * transport's invalidate-then-reacquire ordering.
 */
class SseSpyProvider implements CollectivIQCredentialProvider {
  acquires = 0;
  readonly invalidations: CredentialLease[] = [];
  /** Ordered, value-free event ledger: "acquire" | "invalidate:<generation>". */
  readonly ledger: string[] = [];
  readonly lease: CredentialLease = { generation: 1, token: "spy-token" };
  acquire(): Promise<CredentialLease> {
    this.acquires += 1;
    this.ledger.push("acquire");
    return Promise.resolve(this.lease);
  }
  invalidate(lease: CredentialLease): void {
    this.invalidations.push(lease);
    this.ledger.push(`invalidate:${lease.generation}`);
  }
}

/**
 * A full baseline-capable mock whose `/user/events` returns a fixed non-2xx
 * status. Every JSON stage returns a normalizer-valid body (mirroring
 * `baselineHandler`) so the run reaches the SSE stage; the auth-error probe's
 * empty-bearer request still receives its 401.
 */
function sseLeaseHandler(userEventsStatus: number): MockHandler {
  let nextThread = 1000;
  return (req, res) => {
    if (req.path === "/available_llms") {
      const authz = req.headers["authorization"];
      if (typeof authz === "string" && authz.trim() === "Bearer") {
        return replyJson(res, { error: "denied" }, 401);
      }
      return replyJson(res, { llms: { "m-1": {} } });
    }
    if (req.path === "/get_messages") {
      return req.query.get("thread_id") === null
        ? replyJson(res, { detail: "invalid request" }, 422)
        : replyJson(res, { messages: [] });
    }
    if (req.path === "/create_thread" && req.method === "POST") {
      nextThread += 1;
      return replyJson(res, { thread_id: nextThread });
    }
    if (req.path === "/process_message" && req.method === "POST") {
      return replyJson(res, { run_id: 5000 });
    }
    if (req.path.startsWith("/delete_thread/") && req.method === "DELETE") {
      return replyJson(res, {});
    }
    if (req.path === "/user/events") {
      return replyJson(res, { detail: "denied" }, userEventsStatus);
    }
    return replyJson(res, {}, 404);
  };
}

describe("discovery SSE lease lifecycle", () => {
  it("invalidates the exact SSE lease on 401, issues /user/events once, and keeps acquiring after", async () => {
    server = await startMockServer(sseLeaseHandler(401));
    const spy = new SseSpyProvider();
    const runner = new DiscoverySessionRunner(
      testTransportConfig(server.baseUrl, { credentials: spy }),
    );

    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });

    const sse = report.observations.find((o) => o.stage === "sse_structure");
    expect(sse?.ok).toBe(false);
    expect(sse?.status).toBe(401);
    expect(sse?.structure).toBeNull();

    // The SSE request was issued exactly once and never replayed.
    expect(server.requests.filter((r) => r.path === "/user/events")).toHaveLength(1);

    // The 401 invalidated exactly the lease used for that SSE request, once.
    expect(spy.invalidations).toHaveLength(1);
    expect(spy.invalidations[0]).toBe(spy.lease);
    // The ledger records exactly one invalidation, of the SSE lease's generation.
    const invalidateEvents = spy.ledger.filter((e) => e.startsWith("invalidate:"));
    expect(invalidateEvents).toEqual(["invalidate:1"]);

    // Causal ordering, not just counts: the single invalidation happens AFTER an
    // acquire (the SSE lease acquisition) and BEFORE at least one further acquire
    // (the subsequent messages_state request re-authenticating).
    const invalidateIdx = spy.ledger.indexOf("invalidate:1");
    expect(invalidateIdx).toBeGreaterThan(0);
    // At least one acquire precedes the invalidation (the SSE lease acquire).
    expect(spy.ledger.slice(0, invalidateIdx)).toContain("acquire");
    // ...and at least one distinct acquire follows it (the messages_state probe).
    expect(spy.ledger.slice(invalidateIdx + 1)).toContain("acquire");

    // That subsequent distinct request (messages_state) still succeeds.
    const messages = report.observations.find((o) => o.stage === "messages_state");
    expect(messages?.ok).toBe(true);

    // No bearer token value ever leaks into the sanitized report.
    expect(JSON.stringify(report)).not.toContain("spy-token");
  });

  it("does NOT invalidate the lease on an SSE 403 and issues /user/events once", async () => {
    server = await startMockServer(sseLeaseHandler(403));
    const spy = new SseSpyProvider();
    const runner = new DiscoverySessionRunner(
      testTransportConfig(server.baseUrl, { credentials: spy }),
    );

    const report = await baseline(runner, {
      selection: { single: "solo", combined: ["a"] },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });

    const sse = report.observations.find((o) => o.stage === "sse_structure");
    expect(sse?.ok).toBe(false);
    expect(sse?.status).toBe(403);
    expect(sse?.structure).toBeNull();

    expect(server.requests.filter((r) => r.path === "/user/events")).toHaveLength(1);
    // A 403 is an authorization signal, not a stale-credential one: no invalidation.
    expect(spy.invalidations).toHaveLength(0);
    // The ordered ledger corroborates it: no invalidation event was ever recorded.
    expect(spy.ledger.some((e) => e.startsWith("invalidate:"))).toBe(false);

    expect(JSON.stringify(report)).not.toContain("spy-token");
  });
});

// --- Regression: production normalization gates required stages --------------

/** A baseline-valid mock whose create/process/messages/SSE can be overridden. */
function regressionHandler(
  o: {
    available?: () => { body: unknown; status?: number };
    create?: (n: number) => { body: unknown; status?: number };
    process?: (n: number) => { body: unknown; status?: number };
    messages?: () => { body: unknown; status?: number };
    sse?: string;
  } = {},
): MockHandler {
  let createN = 0;
  let procN = 0;
  let threadSeq = 1000;
  return (req, res) => {
    if (req.path === "/available_llms") {
      const a = o.available?.() ?? { body: { llms: { "m-1": {} } } };
      return replyJson(res, a.body, a.status ?? 200);
    }
    if (req.path === "/get_messages") {
      if (req.query.get("thread_id") === null) return replyJson(res, { detail: "x" }, 422);
      const m = o.messages?.() ?? { body: { messages: [] } };
      return replyJson(res, m.body, m.status ?? 200);
    }
    if (req.path === "/create_thread" && req.method === "POST") {
      createN += 1;
      threadSeq += 1;
      const c = o.create?.(createN) ?? { body: { thread_id: threadSeq } };
      return replyJson(res, c.body, c.status ?? 200);
    }
    if (req.path === "/process_message" && req.method === "POST") {
      procN += 1;
      const p = o.process?.(procN) ?? { body: {} };
      return replyJson(res, p.body, p.status ?? 200);
    }
    if (req.path.startsWith("/delete_thread/") && req.method === "DELETE") {
      return replyJson(res, {});
    }
    if (req.path === "/user/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (o.sse !== undefined) res.write(o.sse);
      res.end();
      return;
    }
    return replyJson(res, {}, 404);
  };
}

function obs(
  report: { observations: readonly DiscoveryObservation[] },
  stage: DiscoveryObservation["stage"],
): DiscoveryObservation {
  const found = report.observations.find((o) => o.stage === stage);
  if (found === undefined) throw new Error(`missing observation for ${stage}`);
  return found;
}

const OK_SELECTION = { single: "solo", combined: ["a"] } as const;

describe("discovery production-normalization gate", () => {
  it("fails create on a 2xx body lacking a valid top-level thread_id, keeping raw structure", async () => {
    server = await startMockServer(
      regressionHandler({ create: () => ({ body: { meta: { thread_id: 123 } } }) }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });

    const create = obs(report, "single_thread_create");
    expect(create.ok).toBe(false);
    expect(create.errorCode).toBe("invalid_upstream_response");
    expect(create.status).toBe(200);
    expect(create.structure).not.toBeNull();
    // The nested raw id value never leaks (only a structural marker survives).
    expect(JSON.stringify(report)).not.toContain("123");
    // No submission runs for the un-created thread; nothing is owned or deleted.
    expect(server.requests.some((r) => r.path === "/process_message")).toBe(false);
    expect(runner.pendingThreadCount()).toBe(0);
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(obs(report, "single_submit").ok).toBe(false);
    expect(exitCodeForBaseline(report)).not.toBe(0);
  });

  it("fails submit on a 2xx body with an own detail (incl. null) and never adopts its run id", async () => {
    server = await startMockServer(
      regressionHandler({
        process: () => ({ body: { detail: null, run_id: 8888 } }),
        sse: 'data: {"run_id":8888}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });

    const submit = obs(report, "single_submit");
    expect(submit.ok).toBe(false);
    expect(submit.errorCode).toBe("upstream_unexpected_error");
    expect(submit.status).toBe(200);
    expect(submit.structure).not.toBeNull();
    // The failed submission's run id is never used as a correlation target.
    expect(report.correlation.run).toBe("not-observed");
    expect(JSON.stringify(report)).not.toContain("8888");
    expect(exitCodeForBaseline(report)).not.toBe(0);
  });

  it("fails messages on a 2xx body without a valid messages array, keeping raw structure", async () => {
    server = await startMockServer(regressionHandler({ messages: () => ({ body: {} }) }));
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const messages = obs(report, "messages_state");
    expect(messages.ok).toBe(false);
    expect(messages.errorCode).toBe("invalid_upstream_response");
    expect(messages.status).toBe(200);
    expect(messages.structure).not.toBeNull();
    expect(exitCodeForBaseline(report)).not.toBe(0);
  });

  it("fails messages on a 2xx body with a malformed entry", async () => {
    server = await startMockServer(
      regressionHandler({ messages: () => ({ body: { messages: [{ nope: 1 }] } }) }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const messages = obs(report, "messages_state");
    expect(messages.ok).toBe(false);
    expect(messages.errorCode).toBe("invalid_upstream_response");
    expect(exitCodeForBaseline(report)).not.toBe(0);
  });
});

// --- Regression: SSE correlates the combined-stage pair ----------------------

describe("discovery combined-stage SSE correlation", () => {
  it("matches when SSE echoes the combined thread + run (distinct stage ids)", async () => {
    server = await startMockServer(
      regressionHandler({
        process: (n) => ({ body: n === 1 ? { run_id: 7001 } : { combined_run_id: 7002 } }),
        sse: 'data: {"thread_id":1002,"combined_run_id":7002}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.correlation).toEqual({ thread: "matched", run: "matched" });
    const serialized = JSON.stringify(report);
    for (const id of ["1001", "1002", "7001", "7002"]) {
      expect(serialized).not.toContain(id);
    }
  });

  it("does not match when SSE echoes only the single-stage pair", async () => {
    server = await startMockServer(
      regressionHandler({
        process: (n) => ({ body: n === 1 ? { run_id: 7001 } : { combined_run_id: 7002 } }),
        sse: 'data: {"thread_id":1001,"run_id":7001}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.correlation.thread).toBe("not-matched");
    expect(report.correlation.run).toBe("not-matched");
  });

  it("reports run not-observed when the combined submission exposes no run id, without single fallback", async () => {
    server = await startMockServer(
      regressionHandler({
        // Single stage has a run id; combined stage exposes none.
        process: (n) => ({ body: n === 1 ? { run_id: 7001 } : {} }),
        // SSE even echoes the SINGLE run id — it must not be treated as the target.
        sse: 'data: {"thread_id":1002,"run_id":7001}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.correlation.thread).toBe("matched");
    expect(report.correlation.run).toBe("not-observed");
  });

  it("reports both not-observed when combined thread creation fails", async () => {
    server = await startMockServer(
      regressionHandler({
        // Combined create (2nd create) returns no valid thread id.
        create: (n) => ({ body: n === 2 ? { meta: {} } : { thread_id: 1000 + n } }),
        sse: 'data: {"thread_id":1001}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.correlation).toEqual({ thread: "not-observed", run: "not-observed" });
  });

  it("matches when the combined submission returns both run ids and SSE echoes run_id", async () => {
    server = await startMockServer(
      regressionHandler({
        // Single stage: run 7001; combined stage: BOTH run ids.
        process: (n) => ({
          body: n === 1 ? { run_id: 7001 } : { run_id: 7101, combined_run_id: 7102 },
        }),
        sse: 'data: {"thread_id":1002,"run_id":7101}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.correlation).toEqual({ thread: "matched", run: "matched" });
    const serialized = JSON.stringify(report);
    for (const id of ["1001", "1002", "7001", "7101", "7102"]) {
      expect(serialized).not.toContain(id);
    }
  });

  it("matches when the combined submission returns both run ids and SSE echoes combined_run_id", async () => {
    server = await startMockServer(
      regressionHandler({
        process: (n) => ({
          body: n === 1 ? { run_id: 7001 } : { run_id: 7101, combined_run_id: 7102 },
        }),
        sse: 'data: {"thread_id":1002,"combined_run_id":7102}\n\n',
      }),
    );
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const report = await baseline(runner, {
      selection: OK_SELECTION,
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    expect(report.correlation).toEqual({ thread: "matched", run: "matched" });
    const serialized = JSON.stringify(report);
    for (const id of ["1001", "1002", "7001", "7101", "7102"]) {
      expect(serialized).not.toContain(id);
    }
  });
});

// --- Regression: canonical runner selection ----------------------------------

describe("discovery canonical runner selection", () => {
  it("canonicalizes padded combined ids before transmission without mutating the caller array", async () => {
    server = await startMockServer(regressionHandler());
    const runner = new DiscoverySessionRunner(testTransportConfig(server.baseUrl));
    const combined = [" a ", "b "];
    await baseline(runner, {
      selection: { single: " solo ", combined },
      cleanupApproved: false,
      observeNotFoundApproved: false,
    });
    const bodies = processMessageBodies(server.requests);
    expect(multipartField(bodies[0] ?? "", "selected_llms")).toBe("solo");
    expect(multipartField(bodies[1] ?? "", "selected_llms")).toBe("a,b");
    // The caller's own array is never mutated.
    expect(combined).toEqual([" a ", "b "]);
  });

  it("rejects malformed direct selections before any fetch", async () => {
    const cases: DiscoveryModelSelection[] = [
      { single: "s", combined: ["a", " a"] }, // duplicate after trim
      { single: "s", combined: ["a,b"] }, // comma inside one element
      { single: "s", combined: [] }, // empty array
      { single: "s", combined: [""] }, // empty id
      { single: "s", combined: ["  "] }, // whitespace-only id
      { single: "s", combined: Array.from({ length: 33 }, (_v, i) => `m${i}`) }, // > 32
      { single: "s", combined: ["a", 1 as unknown as string] }, // non-string element
      { single: "s", combined: "a,b" as unknown as string[] }, // not an array
      { single: "s,x", combined: ["a"] }, // single contains a comma
      { single: "   ", combined: ["a"] }, // empty single
    ];
    for (const selection of cases) {
      const fetch = vi.fn<FetchLike>();
      const runner = new DiscoverySessionRunner(
        testTransportConfig("https://api.prod.collectiviq.ai", { fetch }),
      );
      await expect(
        baseline(runner, {
          selection,
          cleanupApproved: false,
          observeNotFoundApproved: false,
        }),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

// --- CLI argument parsing ----------------------------------------------------

describe("discovery CLI argument parsing", () => {
  it("defaults to preflight and accepts the closed flag set", () => {
    expect(parseDiscoveryArgs(["--session=baseline"])).toEqual({
      session: "baseline",
      executeApproved: false,
      cleanupApproved: false,
      observeNotFoundApproved: false,
      recoveryJournalApproved: false,
      write: false,
    });
    expect(
      parseDiscoveryArgs([
        "--session=baseline",
        "--execute-approved",
        "--recovery-journal-approved",
        "--cleanup-approved",
        "--write",
      ]),
    ).toEqual({
      session: "baseline",
      executeApproved: true,
      cleanupApproved: true,
      observeNotFoundApproved: false,
      recoveryJournalApproved: true,
      write: true,
    });
  });

  it("requires recovery-journal approval whenever execution is approved", () => {
    expect(() =>
      parseDiscoveryArgs(["--session=baseline", "--execute-approved", "--cleanup-approved"]),
    ).toThrow();
    expect(
      parseDiscoveryArgs([
        "--session=baseline",
        "--execute-approved",
        "--recovery-journal-approved",
      ]).recoveryJournalApproved,
    ).toBe(true);
  });

  it("rejects unknown sessions, unknown args, and a missing session", () => {
    expect(() => parseDiscoveryArgs(["--session=other"])).toThrow();
    expect(() => parseDiscoveryArgs(["--session=baseline", "--url=http://evil"])).toThrow();
    expect(() => parseDiscoveryArgs(["--case=available_llms"])).toThrow();
    expect(() => parseDiscoveryArgs([])).toThrow();
  });
});

// --- Import safety -----------------------------------------------------------

describe("discovery module import safety", () => {
  it("re-imports without opening a socket or reading credentials", async () => {
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const guardedEnv = new Proxy(
      {},
      {
        get(_target, key) {
          // Any upstream credential variable read at import is a failure.
          if (
            key === "COLLECTIVIQ_API_KEY" ||
            key === "COLLECTIVIQ_USERNAME" ||
            key === "COLLECTIVIQ_PASSWORD"
          ) {
            throw new Error("credential read at import");
          }
          return undefined;
        },
      },
    );
    const originalEnv = process.env;
    const setEnv = (value: unknown): void => {
      Reflect.set(process, "env", value);
    };
    setEnv(guardedEnv);
    try {
      const cli = await import("../../src/collectiviq/discovery-cli.js");
      const discovery = await import("../../src/collectiviq/discovery.js");
      expect(typeof cli.parseDiscoveryArgs).toBe("function");
      expect(typeof discovery.DiscoverySessionRunner).toBe("function");
    } finally {
      setEnv(originalEnv);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
