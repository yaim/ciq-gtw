/**
 * Hermetic tests for the approval-gated live tool evaluator. Every collaborator
 * is injected: a fake transport (a smart in-memory adapter), fake credentials, a
 * recording in-memory journal, an in-memory checkpoint store, and a controllable
 * interruption seam. NO real network, NO real credential, and the fixed
 * production origin is never contacted.
 */
import { describe, expect, it } from "vitest";
import {
  buildPreflightReport,
  defaultToolsEvalDeps,
  parseEvalArgs,
  runToolsEval,
  EVAL_ORIGIN,
  type BuiltProvider,
  type CheckpointStore,
  type ToolsEvalDeps,
} from "../../src/eval/tools-eval-cli.js";
import {
  ABORT_REASONS,
  BLOCKED_REASONS,
  type BlockedReport,
  type EvalOutput,
  type ExecutedReport,
  type PreflightReport,
  type ProgressEvent,
} from "../../src/eval/report.js";
import { corpusFingerprint, buildEvalCases } from "../../src/eval/cases.js";
import type { CheckpointData } from "../../src/eval/checkpoint.js";
import type {
  CollectivIQAdapter,
  CollectivIQCredentialProvider,
  CredentialLease,
  FetchLike,
  TransportBase,
} from "../../src/collectiviq/types.js";
import type { DeleteDiagnostics } from "../../src/collectiviq/cleanup.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import { deleteThreadPath } from "../../src/collectiviq/endpoints.js";
import type { RecoveryJournalSink } from "../../src/collectiviq/recovery-journal.js";

const CRED_SENTINEL = "SECRET-EVAL-PASSWORD-9c1f";
const OK: DeleteDiagnostics = { ok: true, status: 200, errorCode: null };

/** Extract the last user-message content from a serialized protocol prompt. */
function lastUserContent(prompt: string): string {
  const begin = prompt.indexOf("BEGIN_CONVERSATION_JSON\n");
  const end = prompt.indexOf("\nEND_CONVERSATION_JSON");
  if (begin === -1 || end === -1) return "";
  try {
    const conv = JSON.parse(prompt.slice(begin + "BEGIN_CONVERSATION_JSON\n".length, end)) as {
      messages: { role: string; content: string | null }[];
    };
    return [...conv.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  } catch {
    return "";
  }
}

/** A smart in-memory adapter: returns the tool matching the last user instruction. */
function smartAdapter(): CollectivIQAdapter {
  let n = 0;
  let lastPrompt = "";
  const envelopeFor = (prompt: string): string => {
    const instruction = lastUserContent(prompt);
    if (/bump|edit/i.test(instruction)) {
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "tool_calls",
        calls: [{ name: "edit", arguments: { path: "synthetic/x", text: "v2" } }],
      });
    }
    if (/test suite/i.test(instruction)) {
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "tool_calls",
        calls: [{ name: "test", arguments: {} }],
      });
    }
    if (/summarize/i.test(instruction)) {
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "final",
        content: "synthetic summary",
      });
    }
    return JSON.stringify({
      gateway_protocol: "1.0",
      type: "tool_calls",
      calls: [{ name: "read", arguments: { path: "synthetic/x" } }],
    });
  };
  return {
    createThread: () => Promise.resolve({ threadId: `t${(n += 1)}`, rawStatus: 200 }),
    processMessage: (input) => {
      lastPrompt = input.prompt;
      return Promise.resolve({ accepted: true, rawStatus: 202 });
    },
    getMessages: () =>
      Promise.resolve({
        messages: [
          {
            source: "claude",
            content: envelopeFor(lastPrompt),
            percentUsage: null,
            createdAt: 1,
            id: 1,
          },
        ],
        rawStatus: 200,
      }),
    getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
  };
}

/** A recording in-memory journal (ID-only) that appends lifecycle events to a ledger. */
function recordingJournal(ledger: string[]): RecoveryJournalSink & { owned: Set<string> } {
  const owned = new Set<string>();
  return {
    owned,
    init: () => {
      ledger.push("journal.init");
      return Promise.resolve();
    },
    recordCreated: (id) => {
      owned.add(id);
      return Promise.resolve();
    },
    recordDeleted: (id) => {
      owned.delete(id);
      return Promise.resolve();
    },
    finalize: () => {
      ledger.push("journal.finalize");
      return Promise.resolve();
    },
    ownedThreadIds: () => [...owned],
  };
}

/** An in-memory checkpoint store recording writes/reads/deletes. */
interface MemStore extends CheckpointStore {
  data: CheckpointData | null;
  writes: number;
  deletes: number;
  failWrite: boolean;
  failRead: boolean;
}
function memCheckpointStore(initial: CheckpointData | null = null): MemStore {
  const store: MemStore = {
    data: initial,
    writes: 0,
    deletes: 0,
    failWrite: false,
    failRead: false,
    read: () => {
      if (store.failRead) throw new Error("checkpoint read fail");
      return store.data;
    },
    exists: () => store.data !== null,
    write: (d) => {
      if (store.failWrite) throw new Error("checkpoint write fail");
      store.writes += 1;
      store.data = d;
    },
    delete: () => {
      store.deletes += 1;
      store.data = null;
    },
  };
  return store;
}

/** A controllable interruption seam: `fire()` triggers the installed handler. */
interface InterruptControl {
  fire(): void;
  installed(): boolean;
  removed: boolean;
  seam: ToolsEvalDeps["installInterruptHandler"];
}
function interruptSeam(): InterruptControl {
  let cb: (() => void) | null = null;
  const control: InterruptControl = {
    removed: false,
    installed: () => cb !== null,
    fire: () => cb?.(),
    seam: (onInterrupt) => {
      cb = onInterrupt;
      return () => {
        control.removed = true;
      };
    },
  };
  return control;
}

const fakeProvider: CollectivIQCredentialProvider = {} as unknown as CollectivIQCredentialProvider;

interface Harness {
  readonly deps: ToolsEvalDeps;
  readonly emitted: EvalOutput[];
  readonly ledger: string[];
  readonly journal: RecoveryJournalSink & { owned: Set<string> };
  readonly store: MemStore;
  readonly interrupt: InterruptControl;
}

function harness(over: {
  argv: readonly string[];
  deleteThread?: ToolsEvalDeps["deleteThread"];
  makeAdapter?: () => CollectivIQAdapter;
  journal?: RecoveryJournalSink & { owned: Set<string> };
  store?: MemStore;
  buildProvider?: ToolsEvalDeps["buildProvider"];
  authObservation?: BuiltProvider["authObservation"];
}): Harness {
  const emitted: EvalOutput[] = [];
  const ledger: string[] = [];
  const journal = over.journal ?? recordingJournal(ledger);
  const store = over.store ?? memCheckpointStore();
  const interrupt = interruptSeam();
  const deps: ToolsEvalDeps = {
    argv: over.argv,
    env: {
      COLLECTIVIQ_AUTH_MODE: "password",
      COLLECTIVIQ_USERNAME: "u",
      COLLECTIVIQ_PASSWORD: CRED_SENTINEL,
    },
    buildProvider:
      over.buildProvider ??
      ((env, base: TransportBase) => {
        void env["COLLECTIVIQ_PASSWORD"];
        ledger.push(`buildProvider:${base.baseUrl}`);
        return {
          provider: fakeProvider,
          authObservation:
            over.authObservation ??
            (() => ({
              mode: "password" as const,
              loginAttempts: 1,
              status: 200,
              normalized: true,
            })),
        };
      }),
    makeAdapter: over.makeAdapter ?? (() => smartAdapter()),
    deleteThread: over.deleteThread ?? (() => Promise.resolve(OK)),
    makeJournal: () => journal,
    makeCheckpointStore: () => store,
    installInterruptHandler: interrupt.seam,
    emit: (report) => emitted.push(report),
  };
  return { deps, emitted, ledger, journal, store, interrupt };
}

const fullArgv = [
  "--execute-approved",
  "--cost-approved",
  "--cleanup-approved",
  "--recovery-journal-approved",
];
const resumeArgv = [...fullArgv, "--resume-approved"];

/** Find the single executed report in the emitted stream. */
function executed(emitted: EvalOutput[]): ExecutedReport {
  const report = emitted.find((r) => r.mode === "executed");
  if (report === undefined) throw new Error("no executed report emitted");
  return report;
}
function progressEvents(emitted: EvalOutput[]): ProgressEvent[] {
  return emitted.filter((r): r is ProgressEvent => r.mode === "progress");
}

/** Build a seed checkpoint pointing at `nextCaseIndex` with the real corpus fingerprint. */
function seedCheckpoint(nextCaseIndex: number, over: Partial<CheckpointData> = {}): CheckpointData {
  return {
    formatVersion: 1,
    origin: EVAL_ORIGIN,
    authMode: "password",
    corpusFingerprint: corpusFingerprint(),
    resumeState: "resumable",
    abort: null,
    nextCaseIndex,
    runSegments: 1,
    attemptedRounds: nextCaseIndex,
    completedRounds: nextCaseIndex,
    completedSingleRoundCases: Math.min(nextCaseIndex, 200),
    completedMultiStepScenarios: 0,
    cleanup: { attempted: nextCaseIndex, deleted: nextCaseIndex, failed: 0, journalFailures: 0 },
    gates: {
      expectedCall: {
        total: Math.min(nextCaseIndex, 200),
        schemaValid: Math.min(nextCaseIndex, 200),
        nameAccurate: Math.min(nextCaseIndex, 200),
        argValid: Math.min(nextCaseIndex, 200),
      },
      single: { total: Math.min(nextCaseIndex, 200), success: Math.min(nextCaseIndex, 200) },
      multi: { total: 0, success: 0 },
    },
    invariants: { noSilentFallback: true, injectionResistance: true },
    ...over,
  };
}

describe("eval:tools — argument parsing", () => {
  it("rejects any unknown argument", () => {
    expect(() => parseEvalArgs(["--go-live"])).toThrow();
    expect(() => parseEvalArgs(["--execute-approved", "--oops"])).toThrow();
  });
  it("parses the closed flag set including --resume-approved", () => {
    expect(parseEvalArgs(["--execute-approved", "--resume-approved"])).toEqual({
      executeApproved: true,
      costApproved: false,
      cleanupApproved: false,
      recoveryJournalApproved: false,
      resumeApproved: true,
    });
  });
});

describe("eval:tools — preflight (default, credential-free, network-free)", () => {
  it("emits a preflight report and reads no credential / touches no journal or checkpoint", async () => {
    const h = harness({ argv: [] });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    expect(h.emitted).toHaveLength(1);
    const report = h.emitted[0] as PreflightReport;
    expect(report.mode).toBe("preflight");
    expect(report.origin).toBe(EVAL_ORIGIN);
    expect(report.plannedSingleRoundCases).toBe(200);
    expect(report.plannedMultiStepScenarios).toBe(20);
    expect(report.plannedUpstreamRounds).toBe(280);
    expect(h.ledger).toEqual([]);
    expect(h.store.writes).toBe(0);
  });

  it("buildPreflightReport reflects the approvals given", () => {
    const report = buildPreflightReport({
      executeApproved: true,
      costApproved: true,
      cleanupApproved: false,
      recoveryJournalApproved: false,
      resumeApproved: true,
    });
    expect(report.approvalsGiven).toEqual([
      "--execute-approved",
      "--cost-approved",
      "--resume-approved",
    ]);
    expect(report.resumeApproved).toBe(true);
  });
});

describe("eval:tools — execution requires every approval", () => {
  it("rejects --execute-approved without the other approvals (before any credential/journal)", async () => {
    const h = harness({ argv: ["--execute-approved"] });
    await expect(runToolsEval(h.deps)).rejects.toThrow();
    expect(h.ledger).toEqual([]);
    expect(h.store.writes).toBe(0);
  });
});

describe("eval:tools — checkpoint resume gating (before credential/network)", () => {
  it("blocks when a checkpoint exists without --resume-approved, before reading any credential", async () => {
    const h = harness({ argv: fullArgv, store: memCheckpointStore(seedCheckpoint(100)) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("checkpoint-resume-not-approved");
    expect(report.stage).toBe("checkpoint-init");
    // No credential read, no journal init, no checkpoint write.
    expect(h.ledger).toEqual([]);
    expect(h.store.writes).toBe(0);
  });

  it("blocks on an unreadable/incompatible checkpoint before credentials", async () => {
    const store = memCheckpointStore(seedCheckpoint(50));
    store.failRead = true;
    const h = harness({ argv: resumeArgv, store });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("checkpoint-incompatible");
    expect(h.ledger).toEqual([]);
  });

  it("blocks when the checkpoint anchor write fails, before credentials", async () => {
    const store = memCheckpointStore();
    store.failWrite = true;
    const h = harness({ argv: fullArgv, store });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("checkpoint-write-failed");
    // journal.init ran (before creds) but no provider was built.
    expect(h.ledger).toContain("journal.init");
    expect(h.ledger.find((e) => e.startsWith("buildProvider:"))).toBeUndefined();
  });

  it("blocks when the recovery journal holds unrecovered threads", async () => {
    const blockingJournal: RecoveryJournalSink & { owned: Set<string> } = {
      owned: new Set(),
      init: () => Promise.reject(new Error("unrecovered threads")),
      recordCreated: () => Promise.resolve(),
      recordDeleted: () => Promise.resolve(),
      finalize: () => Promise.resolve(),
      ownedThreadIds: () => [],
    };
    const h = harness({ argv: fullArgv, journal: blockingJournal });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("recovery-journal-unrecovered");
    expect(report.stage).toBe("recovery-journal-init");
    expect(h.ledger.find((e) => e.startsWith("buildProvider:"))).toBeUndefined();
  });
});

describe("eval:tools — fully-approved executed path (fakes)", () => {
  it("runs exactly 280 bounded completions, cleans up, passes every gate, and finalizes the checkpoint", async () => {
    const h = harness({ argv: fullArgv });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.attemptedRounds).toBe(280);
    expect(report.completedRounds).toBe(280);
    expect(report.completedSingleRoundCases).toBe(200);
    expect(report.completedMultiStepScenarios).toBe(20);
    expect(report.cleanup).toEqual({
      attempted: 280,
      deleted: 280,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
    expect(report.passed).toBe(true);
    // Every gate passed, with explicit numerators/denominators/planned totals.
    for (const key of [
      "schemaValidity",
      "toolNameAccuracy",
      "argValidity",
      "singleRoundSuccess",
      "multiStepSuccess",
    ] as const) {
      const g = report.gates[key];
      expect(g.status).toBe("passed");
      expect(g.denominator).toBe(g.plannedDenominator);
      expect(typeof g.numerator).toBe("number");
    }
    expect(report.gates.noSilentFallback).toBe("passed");
    expect(report.gates.injectionResistance).toBe("passed");
    expect(report.gates.parserDeterminism).toBe("passed");
    // The journal ended empty; the checkpoint was finalized (removed).
    expect(h.journal.owned.size).toBe(0);
    expect(report.checkpoint.finalized).toBe(true);
    expect(h.store.data).toBeNull();
    expect(h.store.deletes).toBe(1);
    // Auth observation surfaced (value-free).
    expect(report.auth).toEqual({
      mode: "password",
      loginAttempts: 1,
      status: 200,
      normalized: true,
    });
    // The interrupt handler was removed on exit.
    expect(h.interrupt.removed).toBe(true);
  });

  it("initializes the journal BEFORE reading any credential (journal-before-secret)", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    const initIdx = h.ledger.indexOf("journal.init");
    const provIdx = h.ledger.findIndex((e) => e.startsWith("buildProvider:"));
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(provIdx).toBeGreaterThan(initIdx);
    expect(h.ledger[provIdx]).toBe(`buildProvider:${EVAL_ORIGIN}`);
  });

  it("never emits the credential value in any output record", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    expect(JSON.stringify(h.emitted)).not.toContain(CRED_SENTINEL);
  });

  it("emits a progress event per completed unit, each after a durable checkpoint write, with no secrets", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    const progress = progressEvents(h.emitted);
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) {
      expect(p.checkpointPersisted).toBe(true);
      expect(p.origin).toBe(EVAL_ORIGIN);
      expect(p.authMode).toBe("password");
    }
    // One progress event for each single-round case at minimum.
    expect(progress.filter((p) => p.phase === "single")).toHaveLength(200);
    expect(JSON.stringify(progress)).not.toContain(CRED_SENTINEL);
  });

  it("never invokes the deleter twice for one round (exactly-once) and never replays create/submit", async () => {
    const perThread = new Map<string, number>();
    const counts = { created: 0, submitted: 0 };
    const base = smartAdapter();
    const countingAdapter: CollectivIQAdapter = {
      createThread: (input) => {
        counts.created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        counts.submitted += 1;
        return base.processMessage(input);
      },
      getMessages: (id, signal) => base.getMessages(id, signal),
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
    };
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => countingAdapter,
      deleteThread: (_b, _p, threadId) => {
        perThread.set(threadId, (perThread.get(threadId) ?? 0) + 1);
        return Promise.resolve(OK);
      },
    });
    await runToolsEval(h.deps);
    for (const [, count] of perThread) expect(count).toBe(1);
    expect(perThread.size).toBe(280);
    // Exactly one create + one submit per created thread; nothing replayed.
    expect(counts.created).toBe(280);
    expect(counts.submitted).toBe(280);
  });
});

describe("eval:tools — checkpoint resume advances/skips committed cases", () => {
  it("resumes from the persisted cursor, skipping already-committed single-round cases", async () => {
    // Seed a checkpoint after all 200 single-round cases; only the 20 scenarios remain.
    const h = harness({ argv: resumeArgv, store: memCheckpointStore(seedCheckpoint(200)) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.checkpoint.resumed).toBe(true);
    expect(report.checkpoint.startCaseIndex).toBe(200);
    expect(report.checkpoint.runSegments).toBe(2);
    // Single-round scores were carried, not re-run: still exactly 200 single cases.
    expect(report.gates.singleRoundSuccess.denominator).toBe(200);
    expect(report.completedSingleRoundCases).toBe(200);
    // Only the 20 scenarios ran this segment (80 rounds); cumulative attempts = 200 + 80.
    expect(report.completedMultiStepScenarios).toBe(20);
    expect(report.attemptedRounds).toBe(280);
    expect(report.passed).toBe(true);
    expect(report.checkpoint.finalized).toBe(true);
  });

  it("advances the checkpoint cursor after each single-round case", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    // The store observed monotonic cursor advancement across many writes.
    expect(h.store.writes).toBeGreaterThan(200);
  });
});

describe("eval:tools — structured, value-free abort diagnostics", () => {
  /** An adapter whose Nth (1-based) round fails at a chosen stage. */
  function failingAtCase(opts: {
    failCase: number; // 1-based single-round case ordinal
    stage: "create" | "submit" | "poll";
    error: Error;
  }): CollectivIQAdapter {
    let created = 0;
    const base = smartAdapter();
    return {
      createThread: (input) => {
        created += 1;
        if (opts.stage === "create" && created === opts.failCase) return Promise.reject(opts.error);
        return base.createThread(input);
      },
      processMessage: (input) => {
        if (opts.stage === "submit" && created === opts.failCase) return Promise.reject(opts.error);
        return base.processMessage(input);
      },
      getMessages: (id, signal) => {
        if (opts.stage === "poll" && created === opts.failCase) return Promise.reject(opts.error);
        return base.getMessages(id, signal);
      },
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
    };
  }

  it("reports a create-stage failure as non-resumable (ambiguous), value-free", async () => {
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => failingAtCase({ failCase: 1, stage: "create", error: new Error("boom") }),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).not.toBeNull();
    expect(report.aborted?.stage).toBe("create-thread");
    expect(report.aborted?.resumable).toBe(false);
    // Nothing was created, so no cleanup attempt.
    expect(report.cleanup.attempted).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("reports a submit-stage failure with the upstream code/status and marks it resumable after cleanup", async () => {
    const err = new UpstreamError("authentication", 401, "POST");
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => failingAtCase({ failCase: 3, stage: "submit", error: err }),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("process-message");
    expect(report.aborted?.code).toBe("upstream_authentication_failed");
    expect(report.aborted?.status).toBe(401);
    expect(report.aborted?.resumable).toBe(true);
    // The created thread was still cleaned exactly once; cursor did NOT advance past it.
    expect(report.cleanup.attempted).toBe(3);
    expect(report.cleanup.deleted).toBe(3);
    expect(report.checkpoint.nextCaseIndex).toBe(2); // 0-based: cases 0,1 done; case 2 failed
    // A resumable abort leaves a durable checkpoint at the failing cursor.
    expect(h.store.data?.nextCaseIndex).toBe(2);
    // Partial threshold metrics are incomplete, and untouched multi is not_evaluated.
    expect(report.gates.singleRoundSuccess.status).toBe("incomplete");
    expect(report.gates.multiStepSuccess.status).toBe("not_evaluated");
    expect(report.gates.multiStepSuccess.pct).toBeNull();
  });

  it("reports a non-retryable poll-stage failure resumably with the safe upstream code", async () => {
    // A non-retryable GET error surfaces from the poller immediately (a retryable
    // GET error would instead be retried until the deadline → a scored timeout,
    // which is polling.test.ts's domain, not an operational abort).
    const err = new UpstreamError("authentication", 401, "GET");
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => failingAtCase({ failCase: 2, stage: "poll", error: err }),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("get-messages");
    expect(report.aborted?.status).toBe(401);
    expect(report.aborted?.resumable).toBe(true);
  });

  it("reports a cleanup-delete failure non-resumably, preserving safe status/code without ids", async () => {
    let calls = 0;
    const h = harness({
      argv: fullArgv,
      deleteThread: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            ok: false,
            status: 403,
            errorCode: "upstream_authentication_failed",
          });
        }
        return Promise.resolve(OK);
      },
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("cleanup-delete");
    expect(report.aborted?.resumable).toBe(false);
    expect(report.aborted?.status).toBe(403);
    expect(report.aborted?.code).toBe("upstream_authentication_failed");
    expect(report.cleanup.failed).toBeGreaterThanOrEqual(1);
    // No thread id leaked anywhere.
    expect(JSON.stringify(report)).not.toMatch(/\bt1\b/);
  });

  it("never inspects a hostile thrown value: code/status stay null and no trap fires", async () => {
    let trap = 0;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          trap += 1;
          return undefined;
        },
        has: () => {
          trap += 1;
          return true;
        },
        getPrototypeOf: () => {
          trap += 1;
          return null;
        },
      },
    );
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => {
        const base = smartAdapter();
        let created = 0;
        return {
          createThread: (input) => {
            created += 1;
            return base.createThread(input);
          },
          processMessage: () => {
            // Deliberately reject a hostile NON-Error value to prove it is never inspected.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            if (created === 1) return Promise.reject(hostile);
            return Promise.resolve({ accepted: true, rawStatus: 202 });
          },
          getMessages: (id, signal) => base.getMessages(id, signal),
          getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
        };
      },
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("process-message");
    expect(report.aborted?.code).toBeNull();
    expect(report.aborted?.status).toBeNull();
    expect(trap).toBe(0);
  });

  it("aborts non-resumably when a mid-run per-round checkpoint write fails", async () => {
    const store = memCheckpointStore();
    let writes = 0;
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      writes += 1;
      if (writes === 3) throw new Error("disk full"); // fail a mid-run per-round write
      realWrite(d);
    };
    const h = harness({ argv: fullArgv, store });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("checkpoint-persist");
    expect(report.aborted?.resumable).toBe(false);
    expect(report.checkpoint.persistFailed).toBe(true);
  });
});

describe("eval:tools — operational failure persists attempt/cleanup without advancing the case", () => {
  it("counts the failed round's attempt+cleanup but keeps the cursor at that case", async () => {
    const err = new UpstreamError("network", undefined, "POST");
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        if (created === 5) return Promise.reject(err);
        return base.processMessage(input);
      },
      getMessages: (id, signal) => base.getMessages(id, signal),
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    await runToolsEval(h.deps);
    const report = executed(h.emitted);
    // Cases 0..3 completed (advanced to 4); case index 4 (5th) failed operationally.
    expect(report.checkpoint.nextCaseIndex).toBe(4);
    expect(report.completedSingleRoundCases).toBe(4);
    expect(report.attemptedRounds).toBe(5); // the failing round was attempted
    expect(report.cleanup.attempted).toBe(5); // and cleaned
    expect(h.store.data?.nextCaseIndex).toBe(4);
  });
});

describe("eval:tools — controlled interruption", () => {
  it("cleans a recorded thread using an INDEPENDENT (non-aborted) cleanup signal, resumably", async () => {
    const cleanupSignals: boolean[] = [];
    const control = interruptSeam();
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        if (created === 2) control.fire(); // interrupt mid-round, after the thread exists
        return base.processMessage(input);
      },
      getMessages: (id, signal) => base.getMessages(id, signal),
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    const deps: ToolsEvalDeps = {
      ...h.deps,
      installInterruptHandler: control.seam,
      deleteThread: (_b, _p, _id, signal) => {
        cleanupSignals.push(signal.aborted);
        return Promise.resolve(OK);
      },
    };
    const code = await runToolsEval(deps);
    expect(code).toBe(1);
    const report = h.emitted.find((r) => r.mode === "executed") as ExecutedReport;
    expect(report.aborted?.stage).toBe("interrupted");
    expect(report.aborted?.resumable).toBe(true);
    // Every cleanup delete saw a NON-aborted (independent) signal.
    expect(cleanupSignals.every((aborted) => aborted === false)).toBe(true);
    // The interrupted thread was still cleaned; nothing left owned.
    expect(h.journal.owned.size).toBe(0);
    expect(control.removed).toBe(true);
  });

  it("reports an interruption DURING create as non-resumable (ambiguous)", async () => {
    const control = interruptSeam();
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      createThread: (input) => {
        created += 1;
        if (created === 2) {
          control.fire();
          return Promise.reject(new UpstreamError("cancellation", undefined, "POST"));
        }
        return base.createThread(input);
      },
      processMessage: (input) => base.processMessage(input),
      getMessages: (id, signal) => base.getMessages(id, signal),
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    const deps: ToolsEvalDeps = { ...h.deps, installInterruptHandler: control.seam };
    const code = await runToolsEval(deps);
    expect(code).toBe(1);
    const report = h.emitted.find((r) => r.mode === "executed") as ExecutedReport;
    expect(report.aborted?.stage).toBe("create-thread");
    expect(report.aborted?.resumable).toBe(false);
  });

  it("interruption at a case boundary is resumable and does not double-count", async () => {
    const control = interruptSeam();
    const h = harness({ argv: fullArgv });
    let singleProgress = 0;
    // Fire the interrupt AFTER case index 2 fully commits (its progress emit), so the
    // next iteration observes the interrupt at the boundary — nothing in flight.
    const deps: ToolsEvalDeps = {
      ...h.deps,
      installInterruptHandler: control.seam,
      emit: (report) => {
        h.emitted.push(report);
        if (report.mode === "progress" && report.phase === "single") {
          singleProgress += 1;
          if (singleProgress === 3) control.fire();
        }
      },
    };
    const code = await runToolsEval(deps);
    expect(code).toBe(1);
    const report = h.emitted.find((r) => r.mode === "executed") as ExecutedReport;
    expect(report.aborted?.stage).toBe("interrupted");
    expect(report.aborted?.resumable).toBe(true);
    // Cases 0,1,2 completed and advanced; the boundary interrupt stopped case 3.
    expect(report.completedSingleRoundCases).toBe(3);
    expect(report.checkpoint.nextCaseIndex).toBe(3);
  });
});

describe("eval:tools — mid-scenario interruption restarts the whole scenario", () => {
  it("does not commit multi gate measurements or advance the case for a partial scenario", async () => {
    // Resume at the first multi-step scenario (index 200) so we exercise a scenario.
    const control = interruptSeam();
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        // Interrupt during the 2nd round of the scenario.
        if (created === 2) control.fire();
        return base.processMessage(input);
      },
      getMessages: (id, signal) => base.getMessages(id, signal),
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
    };
    const h = harness({
      argv: resumeArgv,
      store: memCheckpointStore(seedCheckpoint(200)),
      makeAdapter: () => adapter,
    });
    const deps: ToolsEvalDeps = { ...h.deps, installInterruptHandler: control.seam };
    const code = await runToolsEval(deps);
    expect(code).toBe(1);
    const report = h.emitted.find((r) => r.mode === "executed") as ExecutedReport;
    expect(report.aborted?.stage).toBe("interrupted");
    expect(report.aborted?.resumable).toBe(true);
    // No scenario committed; cursor unchanged at the scenario's case index.
    expect(report.completedMultiStepScenarios).toBe(0);
    expect(report.gates.multiStepSuccess.status).toBe("not_evaluated");
    expect(report.checkpoint.nextCaseIndex).toBe(200);
    // The scenario's deferred expected-call scores were NOT merged.
    expect(report.gates.schemaValidity.denominator).toBe(200); // only the seeded single cases
    // Partial-round threads were counted as attempts + cleanup only.
    expect(report.cleanup.attempted).toBeGreaterThanOrEqual(1);
  });
});

describe("eval:tools — gate metrics give no false credit / no false pass", () => {
  it("scores explicit numerators/denominators and cannot pass with an abort or incomplete corpus", async () => {
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => {
        // Always returns final text: under `auto` → text, under required/named → error.
        let tid = 0;
        return {
          createThread: () => Promise.resolve({ threadId: `t${(tid += 1)}`, rawStatus: 200 }),
          processMessage: () => Promise.resolve({ accepted: true, rawStatus: 202 }),
          getMessages: () =>
            Promise.resolve({
              messages: [
                {
                  source: "claude",
                  content: JSON.stringify({
                    gateway_protocol: "1.0",
                    type: "final",
                    content: "no tools",
                  }),
                  percentUsage: null,
                  createdAt: 1,
                  id: 1,
                },
              ],
              rawStatus: 200,
            }),
          getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
        };
      },
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    // Complete corpus but failing gates → failed (not incomplete, not passed).
    expect(report.gates.schemaValidity.status).toBe("failed");
    expect(report.gates.schemaValidity.numerator).toBe(0);
    expect(report.gates.schemaValidity.pct).toBe(0);
    expect(report.gates.singleRoundSuccess.status).toBe("failed");
    expect(report.passed).toBe(false);
    // The required/named cases errored rather than silently downgrading.
    expect(report.gates.noSilentFallback).toBe("passed");
    expect(report.gates.parserDeterminism).toBe("passed");
    // Even a clean, complete run does not pass when gates fail; the checkpoint is
    // still finalized (the corpus is exhausted).
    expect(report.checkpoint.finalized).toBe(true);
  });
});

describe("eval:tools — cleanup failure and finalization", () => {
  it("ABORTS immediately when a cleanup delete fails and cannot pass", async () => {
    let calls = 0;
    const h = harness({
      argv: fullArgv,
      deleteThread: () => {
        calls += 1;
        return Promise.resolve(
          calls > 1 ? OK : { ok: false, status: 500, errorCode: "upstream_unexpected_error" },
        );
      },
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("cleanup-delete");
    expect(report.passed).toBe(false);
    expect(report.cleanup.failed).toBeGreaterThanOrEqual(1);
    expect(report.attemptedRounds).toBeLessThan(280);
  });

  it("cannot pass when the final checkpoint finalize (delete) fails", async () => {
    const store = memCheckpointStore();
    store.delete = () => {
      throw new Error("finalize failed");
    };
    const h = harness({ argv: fullArgv, store });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("checkpoint-persist");
    expect(report.checkpoint.persistFailed).toBe(true);
    expect(report.passed).toBe(false);
  });
});

describe("eval:tools — genuine multi-step transcript continuity", () => {
  it("carries prior assistant tool_calls and matching tool results into later rounds", async () => {
    const prompts: string[] = [];
    let n = 0;
    let lastPrompt = "";
    const lastUser = (prompt: string): string => lastUserContent(prompt);
    const envelopeFor = (prompt: string): string => {
      const instruction = lastUser(prompt);
      if (/bump|edit/i.test(instruction)) {
        return JSON.stringify({
          gateway_protocol: "1.0",
          type: "tool_calls",
          calls: [{ name: "edit", arguments: { path: "synthetic/x", text: "v2" } }],
        });
      }
      if (/test suite/i.test(instruction)) {
        return JSON.stringify({
          gateway_protocol: "1.0",
          type: "tool_calls",
          calls: [{ name: "test", arguments: {} }],
        });
      }
      if (/summarize/i.test(instruction)) {
        return JSON.stringify({ gateway_protocol: "1.0", type: "final", content: "s" });
      }
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "tool_calls",
        calls: [{ name: "read", arguments: { path: "synthetic/x" } }],
      });
    };
    const capturing: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: `t${(n += 1)}`, rawStatus: 200 }),
      processMessage: (input) => {
        prompts.push(input.prompt);
        lastPrompt = input.prompt;
        return Promise.resolve({ accepted: true, rawStatus: 202 });
      },
      getMessages: () =>
        Promise.resolve({
          messages: [
            {
              source: "claude",
              content: envelopeFor(lastPrompt),
              percentUsage: null,
              createdAt: 1,
              id: 1,
            },
          ],
          rawStatus: 200,
        }),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => capturing });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    const continuation = prompts.find(
      (p) => p.includes('"tool_calls"') && p.includes('"tool_call_id"') && p.includes("call_ciq_"),
    );
    expect(continuation).toBeDefined();
    if (continuation === undefined) return;
    const parsedBegin = continuation.indexOf("BEGIN_CONVERSATION_JSON\n");
    const parsedEnd = continuation.indexOf("\nEND_CONVERSATION_JSON");
    const conv = JSON.parse(
      continuation.slice(parsedBegin + "BEGIN_CONVERSATION_JSON\n".length, parsedEnd),
    ) as { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] };
    const callIds = new Set(conv.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
    const resultIds = conv.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id ?? "");
    expect(resultIds.length).toBeGreaterThan(0);
    for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  });
});

describe("eval:tools — corpus fingerprint is deterministic and content-free", () => {
  it("produces a stable 64-char hex digest over the invented corpus", () => {
    const a = corpusFingerprint();
    const b = corpusFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // The corpus has the expected shape.
    expect(buildEvalCases()).toHaveLength(220);
  });
});

/** An adapter whose createThread always rejects (an ambiguous-create failure). */
function createFailingAdapter(): CollectivIQAdapter {
  return {
    createThread: () => Promise.reject(new Error("create boom")),
    processMessage: () => Promise.resolve({ accepted: true, rawStatus: 202 }),
    getMessages: () => Promise.resolve({ messages: [], rawStatus: 200 }),
    getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
  };
}

/** A submit-failing adapter for the Nth (1-based) created thread. */
function submitFailingAdapter(failCase: number): CollectivIQAdapter {
  let created = 0;
  const base = smartAdapter();
  return {
    createThread: (input) => {
      created += 1;
      return base.createThread(input);
    },
    processMessage: (input) => {
      if (created === failCase)
        return Promise.reject(new UpstreamError("network", undefined, "POST"));
      return base.processMessage(input);
    },
    getMessages: (id, signal) => base.getMessages(id, signal),
    getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
  };
}

function finalizeCount(ledger: string[]): number {
  return ledger.filter((e) => e === "journal.finalize").length;
}

describe("eval:tools — checkpoint semantic integrity (finding 1)", () => {
  it("rejects a forged complete + passing checkpoint before any credential/network", async () => {
    // cursor == corpus length claims a complete corpus, which a genuine run would
    // have removed. Rejected as inconsistent before journal init or credentials.
    const forged = seedCheckpoint(220);
    const h = harness({ argv: resumeArgv, store: memCheckpointStore(forged) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("checkpoint-inconsistent");
    expect(h.ledger).toEqual([]); // no journal init, no credential read
    expect(h.store.writes).toBe(0);
  });

  it("rejects a zero-attempt checkpoint that claims committed cases", async () => {
    const forged = seedCheckpoint(5, {
      attemptedRounds: 0,
      completedRounds: 0,
      cleanup: { attempted: 0, deleted: 0, failed: 0, journalFailures: 0 },
    });
    const h = harness({ argv: resumeArgv, store: memCheckpointStore(forged) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    expect((h.emitted[0] as BlockedReport).reason).toBe("checkpoint-inconsistent");
    expect(h.ledger).toEqual([]);
  });

  it("rejects a numerator-above-denominator forgery", async () => {
    const forged = seedCheckpoint(5, {
      gates: {
        expectedCall: { total: 5, schemaValid: 5, nameAccurate: 5, argValid: 5 },
        single: { total: 5, success: 200 },
        multi: { total: 0, success: 0 },
      },
    });
    const h = harness({ argv: resumeArgv, store: memCheckpointStore(forged) });
    expect(await runToolsEval(h.deps)).toBe(1);
    expect((h.emitted[0] as BlockedReport).reason).toBe("checkpoint-inconsistent");
  });
});

describe("eval:tools — durable blocked tombstone (finding 2)", () => {
  it("rejects a blocked tombstone on resume before credentials/network", async () => {
    const tomb = seedCheckpoint(5, {
      resumeState: "blocked",
      abort: { stage: "cleanup-delete", reason: "cleanup-failed" },
    });
    const h = harness({ argv: resumeArgv, store: memCheckpointStore(tomb) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("checkpoint-blocked");
    expect(h.ledger).toEqual([]);
    expect(h.store.writes).toBe(0);
  });

  it("writes a blocked tombstone on an ambiguous create abort (no resumable anchor left)", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => createFailingAdapter() });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("create-thread");
    expect(report.aborted?.resumable).toBe(false);
    // The checkpoint on disk is a durable blocked tombstone — NOT a resumable anchor.
    expect(h.store.data?.resumeState).toBe("blocked");
    expect(h.store.data?.abort).toEqual({ stage: "create-thread", reason: "create-failed" });
  });

  it("writes a blocked tombstone on a cleanup-delete abort", async () => {
    const h = harness({
      argv: fullArgv,
      deleteThread: () =>
        Promise.resolve({ ok: false, status: 500, errorCode: "upstream_unexpected_error" }),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    expect(executed(h.emitted).aborted?.stage).toBe("cleanup-delete");
    expect(h.store.data?.resumeState).toBe("blocked");
    expect(h.store.data?.abort?.stage).toBe("cleanup-delete");
  });

  it("keeps a resumable checkpoint (not blocked) on a resumable submit failure", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(3) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.resumable).toBe(true);
    expect(h.store.data?.resumeState).toBe("resumable");
    expect(h.store.data?.abort).toBeNull();
    expect(h.store.data?.nextCaseIndex).toBe(2);
  });
});

describe("eval:tools — recovery journal finalization (finding 4)", () => {
  it("finalizes the journal exactly once on success, resumable abort, and non-resumable abort", async () => {
    const success = harness({ argv: fullArgv });
    await runToolsEval(success.deps);
    expect(finalizeCount(success.ledger)).toBe(1);

    const resumable = harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(2) });
    await runToolsEval(resumable.deps);
    expect(finalizeCount(resumable.ledger)).toBe(1);

    const nonResumable = harness({ argv: fullArgv, makeAdapter: () => createFailingAdapter() });
    await runToolsEval(nonResumable.deps);
    expect(finalizeCount(nonResumable.ledger)).toBe(1);
  });

  it("classifies a journal-finalization failure and cannot pass, blocking the checkpoint", async () => {
    const ledger: string[] = [];
    const journal: RecoveryJournalSink & { owned: Set<string> } = {
      owned: new Set(),
      init: () => {
        ledger.push("journal.init");
        return Promise.resolve();
      },
      recordCreated: () => Promise.resolve(),
      recordDeleted: () => Promise.resolve(),
      finalize: () => Promise.reject(new Error("finalize failed")),
      ownedThreadIds: () => [],
    };
    const h = harness({ argv: fullArgv, journal });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("recovery-journal-finalize");
    expect(report.aborted?.reason).toBe("recovery-journal-finalize-failed");
    expect(report.aborted?.resumable).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.checkpoint.finalized).toBe(false);
    // A journal-finalize failure durably blocks the checkpoint.
    expect(h.store.data?.resumeState).toBe("blocked");
  });
});

describe("eval:tools — progress ordering & dedupe (finding 4)", () => {
  it("emits every progress event before the final report, each after a durable checkpoint write", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(4) });
    await runToolsEval(h.deps);
    const executedIdx = h.emitted.findIndex((r) => r.mode === "executed");
    const lastProgressIdx = h.emitted.map((r) => r.mode).lastIndexOf("progress");
    expect(executedIdx).toBeGreaterThanOrEqual(0);
    expect(lastProgressIdx).toBeLessThan(executedIdx); // checkpoint→progress→report
    for (const p of progressEvents(h.emitted)) expect(p.checkpointPersisted).toBe(true);
    // The executed report is the terminal record.
    expect(h.emitted[h.emitted.length - 1]?.mode).toBe("executed");
  });

  it("emits no duplicate progress for a completed multi-step case", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    const multi = progressEvents(h.emitted).filter((p) => p.phase === "multi");
    // 20 scenarios × (3 intra-scenario + 1 scenario-end) = 80, and the scenario-end
    // ordinal (4) appears exactly once per case (no duplicate at the final round).
    expect(multi).toHaveLength(80);
    const finalRounds = multi.filter((p) => p.roundOrdinal === 4);
    expect(finalRounds).toHaveLength(20);
    const ordinals = finalRounds.map((p) => p.caseOrdinal);
    expect(new Set(ordinals).size).toBe(20); // one per scenario, no duplicates
  });

  it("emits no resumability progress after a checkpoint persistence failure", async () => {
    const store = memCheckpointStore();
    let writes = 0;
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      writes += 1;
      if (writes === 3) throw new Error("disk full"); // fail case 1's persist
      realWrite(d);
    };
    const h = harness({ argv: fullArgv, store });
    await runToolsEval(h.deps);
    // Only case 0 committed + emitted progress; the failed case 1 emits none.
    expect(progressEvents(h.emitted)).toHaveLength(1);
    expect(executed(h.emitted).aborted?.stage).toBe("checkpoint-persist");
  });
});

describe("eval:tools — terminal cleaned-attempt progress (finding 3)", () => {
  it("emits terminal progress for a cleaned submit failure, after the resumable checkpoint persists, with an unadvanced cursor", async () => {
    // failCase 4 → the 4th created thread (case index 3) submit-fails; cases 0..2 commit.
    const h = harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(4) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const progress = progressEvents(h.emitted);
    const last = progress[progress.length - 1];
    expect(last?.phase).toBe("single");
    expect(last?.caseOrdinal).toBe(4); // the cleaned-but-uncommitted failed case
    expect(last?.roundOrdinal).toBe(1);
    // The cursor did NOT advance past the failed case; the event says so truthfully.
    expect(last?.completedSingleRoundCases).toBe(3);
    expect(last?.checkpointPersisted).toBe(true);
    expect(h.store.data?.nextCaseIndex).toBe(3);
    // Exactly one terminal event beyond the three committed cases.
    expect(progress.filter((p) => p.phase === "single")).toHaveLength(4);
    // The terminal progress precedes the executed report.
    const lastProgressIdx = h.emitted.map((r) => r.mode).lastIndexOf("progress");
    const executedIdx = h.emitted.findIndex((r) => r.mode === "executed");
    expect(lastProgressIdx).toBeLessThan(executedIdx);
  });

  it("orders terminal lifecycle as journal.finalize → checkpoint.write → progress → executed", async () => {
    const timeline: string[] = [];
    const owned = new Set<string>();
    const journal: RecoveryJournalSink & { owned: Set<string> } = {
      owned,
      init: () => Promise.resolve(),
      recordCreated: (id) => {
        owned.add(id);
        return Promise.resolve();
      },
      recordDeleted: (id) => {
        owned.delete(id);
        return Promise.resolve();
      },
      finalize: () => {
        timeline.push("journal.finalize");
        return Promise.resolve();
      },
      ownedThreadIds: () => [...owned],
    };
    const store = memCheckpointStore();
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      timeline.push("checkpoint.write");
      realWrite(d);
    };
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => submitFailingAdapter(4),
      journal,
      store,
    });
    const deps: ToolsEvalDeps = {
      ...h.deps,
      emit: (r) => {
        h.emitted.push(r);
        timeline.push(r.mode);
      },
    };
    await runToolsEval(deps);
    expect(timeline.filter((x) => x === "journal.finalize")).toHaveLength(1);
    const fin = timeline.indexOf("journal.finalize");
    const lastWrite = timeline.lastIndexOf("checkpoint.write");
    const lastProgress = timeline.lastIndexOf("progress");
    const exec = timeline.indexOf("executed");
    expect(fin).toBeGreaterThanOrEqual(0);
    expect(fin).toBeLessThan(lastWrite); // finalize precedes the resumable persist
    expect(lastWrite).toBeLessThan(lastProgress); // persist precedes the terminal progress
    expect(lastProgress).toBeLessThan(exec); // progress precedes the executed report
  });

  it("emits no terminal progress when journal finalization fails, and blocks the checkpoint", async () => {
    const owned = new Set<string>();
    const journal: RecoveryJournalSink & { owned: Set<string> } = {
      owned,
      init: () => Promise.resolve(),
      recordCreated: (id) => {
        owned.add(id);
        return Promise.resolve();
      },
      recordDeleted: (id) => {
        owned.delete(id);
        return Promise.resolve();
      },
      finalize: () => Promise.reject(new Error("finalize failed")),
      ownedThreadIds: () => [...owned],
    };
    // Case index 1 (2nd thread) submit-fails resumably; case 0 commits one progress.
    const h = harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(2), journal });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    // Only the committed case emitted progress; the cleaned failed attempt did NOT,
    // because journal finalization failed (making the run non-resumable).
    expect(progressEvents(h.emitted)).toHaveLength(1);
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("recovery-journal-finalize");
    expect(report.aborted?.resumable).toBe(false);
    expect(report.passed).toBe(false);
    expect(h.store.data?.resumeState).toBe("blocked");
  });

  it("emits no terminal progress when the final resumable checkpoint persist fails", async () => {
    const store = memCheckpointStore();
    let writes = 0;
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      writes += 1;
      // anchor(1), case 0 per-round(2), then the finalizeAndReport resumable persist(3).
      if (writes === 3) throw new Error("disk full");
      realWrite(d);
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(2), store });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    expect(progressEvents(h.emitted)).toHaveLength(1); // only case 0
    const report = executed(h.emitted);
    expect(report.aborted?.stage).toBe("checkpoint-persist");
    expect(report.checkpoint.persistFailed).toBe(true);
  });

  it("finalizes the journal exactly once on an initial-anchor write failure", async () => {
    const store = memCheckpointStore();
    store.failWrite = true;
    const h = harness({ argv: fullArgv, store });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("checkpoint-write-failed");
    expect(finalizeCount(h.ledger)).toBe(1);
    // No credential was read.
    expect(h.ledger.find((e) => e.startsWith("buildProvider:"))).toBeUndefined();
  });

  it("classifies an anchor-write + journal-finalize failure through a closed reason, no credential/network", async () => {
    const store = memCheckpointStore();
    store.failWrite = true;
    let finalizeCalls = 0;
    const journal: RecoveryJournalSink & { owned: Set<string> } = {
      owned: new Set(),
      init: () => Promise.resolve(),
      recordCreated: () => Promise.resolve(),
      recordDeleted: () => Promise.resolve(),
      finalize: () => {
        finalizeCalls += 1;
        return Promise.reject(new Error("finalize failed"));
      },
      ownedThreadIds: () => [],
    };
    const h = harness({ argv: fullArgv, store, journal });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as BlockedReport;
    expect(report.mode).toBe("blocked");
    expect(report.reason).toBe("recovery-journal-finalize-failed");
    expect(BLOCKED_REASONS).toContain(report.reason);
    expect(report.stage).toBe("recovery-journal-finalize");
    expect(finalizeCalls).toBe(1); // exactly once
    // Nothing upstream: no credential read.
    expect(h.ledger.find((e) => e.startsWith("buildProvider:"))).toBeUndefined();
  });
});

describe("eval:tools — closed reason allowlists (finding 4)", () => {
  it("every emitted blocked/abort reason is drawn from the closed unions", async () => {
    const scenarios: Array<() => Harness> = [
      () => harness({ argv: resumeArgv, store: memCheckpointStore(seedCheckpoint(220)) }), // inconsistent
      () =>
        harness({
          argv: resumeArgv,
          store: memCheckpointStore(
            seedCheckpoint(5, {
              resumeState: "blocked",
              abort: { stage: "cleanup-delete", reason: "cleanup-failed" },
            }),
          ),
        }), // blocked
      () => harness({ argv: fullArgv, makeAdapter: () => createFailingAdapter() }), // create abort
      () => harness({ argv: fullArgv, makeAdapter: () => submitFailingAdapter(2) }), // resumable abort
      () =>
        harness({
          argv: fullArgv,
          deleteThread: () =>
            Promise.resolve({
              ok: false,
              status: 403,
              errorCode: "upstream_authentication_failed",
            }),
        }), // cleanup abort
    ];
    for (const make of scenarios) {
      const h = make();
      await runToolsEval(h.deps);
      for (const record of h.emitted) {
        if (record.mode === "blocked") {
          expect(BLOCKED_REASONS).toContain(record.reason);
        } else if (record.mode === "executed" && record.aborted !== null) {
          expect(ABORT_REASONS).toContain(record.aborted.reason);
        }
      }
    }
  });
});

describe("eval:tools — production default deleter wiring (hermetic)", () => {
  const SENTINEL = "SYNTH-UPSTREAM-TOKEN-4b2e";
  const THREAD_ID = "thread/with space#1";

  function syntheticProvider(): CollectivIQCredentialProvider & { acquires: number } {
    const provider = {
      acquires: 0,
      acquire: (): Promise<CredentialLease> => {
        provider.acquires += 1;
        return Promise.resolve({ generation: 1, token: SENTINEL });
      },
      invalidate: () => undefined,
    };
    return provider;
  }

  interface Call {
    readonly url: string;
    readonly method: string | undefined;
    readonly authorization: string | undefined;
  }
  function recordingFetch(status: number, calls: Call[]): FetchLike {
    return (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: input, method: init?.method, authorization: headers["authorization"] });
      return Promise.resolve(
        new Response("{}", { status, headers: { "content-type": "application/json" } }),
      );
    };
  }

  it("issues exactly one DELETE to the fixed encoded path, reusing the provider, on 2xx → ok", async () => {
    const calls: Call[] = [];
    const provider = syntheticProvider();
    const base: TransportBase = { baseUrl: EVAL_ORIGIN, fetch: recordingFetch(200, calls) };
    const result = await defaultToolsEvalDeps().deleteThread(
      base,
      provider,
      THREAD_ID,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${EVAL_ORIGIN}${deleteThreadPath(THREAD_ID)}`);
    expect(calls[0]?.url).toContain("with%20space%231");
    expect(provider.acquires).toBe(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${SENTINEL}`);
  });

  it("returns ok:false on a non-2xx and does NOT retry", async () => {
    const calls: Call[] = [];
    const base: TransportBase = { baseUrl: EVAL_ORIGIN, fetch: recordingFetch(403, calls) };
    const result = await defaultToolsEvalDeps().deleteThread(
      base,
      syntheticProvider(),
      THREAD_ID,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("the fixed origin is the production one and is never injectable", () => {
    expect(EVAL_ORIGIN).toBe("https://api.prod.collectiviq.ai");
  });
});
