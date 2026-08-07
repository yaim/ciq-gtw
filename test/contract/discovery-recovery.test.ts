import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRecoveryArgs,
  runRecoveryCleanup,
} from "../../src/collectiviq/discovery-recovery-cli.js";
import {
  __setRecoveryJournalFsForTests,
  readRecoveryJournal,
  writeRecoveryJournal,
  RECOVERY_JOURNAL_FORMAT,
} from "../../src/collectiviq/recovery-journal.js";
import {
  startMockServer,
  replyJson,
  type MockHandler,
  type MockServer,
} from "./support/mock-server.js";
import { TEST_API_KEY, FAST_TIMEOUTS } from "./support/adapter.js";
import type { CollectivIQTransportConfig } from "../../src/collectiviq/types.js";

let server: MockServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ciq-recovery-"));
  dirs.push(dir);
  return dir;
}

// Synthetic ids only.
const ID_A = "t-recover-a";
const ID_B = "t-recover-b";

/** A delete-only mock; `deleteStatus(i)` maps the i-th delete to a status. */
function deleteMock(deleteStatus: (i: number) => number): MockHandler {
  let i = 0;
  return (req, res) => {
    if (req.path.startsWith("/delete_thread/") && req.method === "DELETE") {
      i += 1;
      return replyJson(res, {}, deleteStatus(i));
    }
    return replyJson(res, {}, 404);
  };
}

function seedJournal(dir: string, origin: string, ids: string[]): void {
  writeRecoveryJournal(dir, {
    formatVersion: RECOVERY_JOURNAL_FORMAT,
    destinationOrigin: origin,
    threadIds: ids,
  });
}

describe("recovery CLI argument parsing", () => {
  it("requires all three approval flags", () => {
    expect(() => parseRecoveryArgs([])).toThrow();
    expect(() => parseRecoveryArgs(["--execute-approved"])).toThrow();
    expect(() => parseRecoveryArgs(["--execute-approved", "--cleanup-approved"])).toThrow();
    expect(() =>
      parseRecoveryArgs(["--cleanup-approved", "--recovery-journal-approved"]),
    ).toThrow();
    expect(() => parseRecoveryArgs(["--execute-approved", "--unknown"])).toThrow();
    expect(
      parseRecoveryArgs([
        "--execute-approved",
        "--cleanup-approved",
        "--recovery-journal-approved",
      ]),
    ).toEqual({ executeApproved: true, cleanupApproved: true, recoveryJournalApproved: true });
  });
});

describe("runRecoveryCleanup", () => {
  it("deletes all journal ids, removes the journal, and reports value-free success", async () => {
    server = await startMockServer(deleteMock(() => 200));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A, ID_B]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const report = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(report).toEqual({
      attempted: 2,
      resolved: 2,
      unresolved: 0,
      remaining: 0,
      attempts: [
        {
          ok: true,
          status: 200,
          errorCode: null,
          resolved: true,
          resolution: "deleted",
          persisted: true,
        },
        {
          ok: true,
          status: 200,
          errorCode: null,
          resolved: true,
          resolution: "deleted",
          persisted: true,
        },
      ],
    });
    // Journal removed once empty; no id leaks into the report.
    expect(readRecoveryJournal(dir)).toBeNull();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(ID_A);
    expect(serialized).not.toContain(ID_B);
  });

  it("resolves a stale id on an exact 404 (already absent) without relabeling HTTP truth", async () => {
    server = await startMockServer(deleteMock(() => 404));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const report = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(report.resolved).toBe(1);
    expect(report.unresolved).toBe(0);
    expect(report.remaining).toBe(0);
    // HTTP truth preserved: a 404 is not an HTTP success even though it resolves.
    expect(report.attempts[0]).toEqual({
      ok: false,
      status: 404,
      errorCode: "upstream_unexpected_error",
      resolved: true,
      resolution: "already_absent",
      persisted: true,
    });
    expect(readRecoveryJournal(dir)).toBeNull();
  });

  it("retains the undeleted id when a delete fails", async () => {
    server = await startMockServer(deleteMock((i) => (i === 1 ? 200 : 500)));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A, ID_B]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const report = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(report.resolved).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(report.remaining).toBe(1);
    // The still-owned id stays recoverable in the journal.
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_B]);
  });

  it("does not resolve non-404 failures (403, 410) and keeps them pending", async () => {
    server = await startMockServer(deleteMock((i) => (i === 1 ? 403 : 410)));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A, ID_B]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const report = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(report.resolved).toBe(0);
    expect(report.unresolved).toBe(2);
    expect(report.remaining).toBe(2);
    expect(report.attempts.every((a) => !a.resolved && a.resolution === null)).toBe(true);
    expect(report.attempts[0]?.status).toBe(403);
    expect(report.attempts[1]?.status).toBe(410);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A, ID_B]);
  });

  it("resolves mixed outcomes: a 200 delete and a 403 failure", async () => {
    server = await startMockServer(deleteMock((i) => (i === 1 ? 200 : 403)));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A, ID_B]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const report = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(report.resolved).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_B]);
  });

  it("keeps all ids when every delete fails", async () => {
    server = await startMockServer(deleteMock(() => 500));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A, ID_B]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const report = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(report.unresolved).toBe(2);
    expect(report.remaining).toBe(2);
    expect(report.attempts.every((a) => !a.ok && !a.resolved)).toBe(true);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A, ID_B]);
  });

  it("refuses a missing, empty, or origin-mismatched journal", async () => {
    const config: CollectivIQTransportConfig = {
      baseUrl: "https://api.prod.collectiviq.ai",
      apiKey: TEST_API_KEY,
      // A fetch that must never be called on the refusal paths.
      fetch: vi.fn(() => Promise.reject(new Error("should not fetch"))),
    };
    const missing = tempDir();
    await expect(runRecoveryCleanup(config, missing)).rejects.toThrow();

    const empty = tempDir();
    seedJournal(empty, "https://api.prod.collectiviq.ai", []);
    await expect(runRecoveryCleanup(config, empty)).rejects.toThrow();

    const wrongOrigin = tempDir();
    seedJournal(wrongOrigin, "https://example.invalid", [ID_A]);
    await expect(runRecoveryCleanup(config, wrongOrigin)).rejects.toThrow();

    expect(config.fetch).not.toHaveBeenCalled();
  });

  it("refuses an invalid journal file", async () => {
    const dir = tempDir();
    // Write a malformed journal directly (private mode so only the content is at issue).
    writeFileSync(join(dir, "recovery-journal.json"), "{ not json", { mode: 0o600 });
    const config: CollectivIQTransportConfig = {
      baseUrl: "https://api.prod.collectiviq.ai",
      apiKey: TEST_API_KEY,
    };
    await expect(runRecoveryCleanup(config, dir)).rejects.toThrow();
  });
});

// Convergence across the crash window: a DELETE resolved upstream but the journal
// removal failed. The id must stay pending and a later run must converge. The
// journal-removal fault is injected deterministically via the filesystem seam
// (not directory permissions), so these run under both root and non-root.
describe("runRecoveryCleanup crash-window convergence", () => {
  it("keeps a 200-deleted id pending when the journal removal fails, then converges on retry", async () => {
    // The thread is deleted (200) the first time, then already absent (404) on retry.
    server = await startMockServer(deleteMock((i) => (i === 1 ? 200 : 404)));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    // Inject a failing journal removal (unlink) for the first run only.
    const restore = __setRecoveryJournalFsForTests({
      unlinkSync: () => {
        throw new Error("unlink denied");
      },
    });
    let first;
    try {
      first = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    } finally {
      restore();
    }
    // Upstream is clean, but the journal update failed: the id stays pending.
    expect(first.resolved).toBe(0);
    expect(first.unresolved).toBe(1);
    expect(first.remaining).toBe(1);
    expect(first.attempts[0]).toMatchObject({
      ok: true,
      status: 200,
      resolved: false,
      persisted: false,
    });
    // The journal still holds the id (recoverable).
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);

    // Retry with the seam restored: the removal now succeeds and recovery converges.
    const second = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(second.resolved).toBe(1);
    expect(second.remaining).toBe(0);
    expect(readRecoveryJournal(dir)).toBeNull();
  });

  it("keeps a 404-resolved id pending when the journal removal fails, then converges on retry", async () => {
    server = await startMockServer(deleteMock(() => 404));
    const dir = tempDir();
    seedJournal(dir, server.baseUrl, [ID_A]);
    const config: CollectivIQTransportConfig = { baseUrl: server.baseUrl, apiKey: TEST_API_KEY };

    const restore = __setRecoveryJournalFsForTests({
      unlinkSync: () => {
        throw new Error("unlink denied");
      },
    });
    let first;
    try {
      first = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    } finally {
      restore();
    }
    expect(first.unresolved).toBe(1);
    expect(first.remaining).toBe(1);
    expect(first.attempts[0]).toMatchObject({
      ok: false,
      status: 404,
      resolved: false,
      persisted: false,
    });
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);

    const second = await runRecoveryCleanup(config, dir, FAST_TIMEOUTS);
    expect(second.resolved).toBe(1);
    expect(second.remaining).toBe(0);
    expect(readRecoveryJournal(dir)).toBeNull();
  });
});

describe("recovery module import safety", () => {
  it("imports without opening a socket or reading credentials", async () => {
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const guardedEnv = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "COLLECTIVIQ_API_KEY") throw new Error("credential read at import");
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
      const mod = await import("../../src/collectiviq/discovery-recovery-cli.js");
      expect(typeof mod.parseRecoveryArgs).toBe("function");
      expect(typeof mod.runRecoveryCleanup).toBe("function");
    } finally {
      setEnv(originalEnv);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
