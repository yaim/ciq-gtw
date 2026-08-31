/**
 * Hermetic tests for the approval-gated live tool evaluator. Every collaborator
 * is injected: a fake transport (a smart in-memory adapter), fake credentials, a
 * recording in-memory journal, an in-memory checkpoint store, and a controllable
 * interruption seam. NO real network, NO real credential, and the fixed
 * production origin is never contacted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPreflightReport,
  classifyRoundFailure,
  defaultToolsEvalDeps,
  parseEvalArgs,
  runToolsEval,
  EVAL_ORIGIN,
  type BuiltProvider,
  type CheckpointStore,
  type RoundDecision,
  type ToolsEvalDeps,
} from "../../src/eval/tools-eval-cli.js";
import {
  ABORT_REASONS,
  BLOCKED_REASONS,
  EVAL_FAILURE_REASON_CODES,
  EVAL_FAILURE_REASON_SCOPE,
  EVAL_REPORT_VERSION,
  type BlockedReport,
  type EvalFailureReason,
  type EvalOutput,
  type ExecutedReport,
  type PreflightReport,
  type ProgressEvent,
} from "../../src/eval/report.js";
import {
  corpusFingerprint,
  buildEvalCases,
  buildEvalCorpusProjection,
  MULTI_STEP_SCENARIOS,
  SINGLE_ROUND_CASES,
} from "../../src/eval/cases.js";
import {
  CHECKPOINT_FORMAT_VERSION,
  validateResumableCheckpoint,
  type CheckpointData,
  type CheckpointScenarioEvidence,
} from "../../src/eval/checkpoint.js";
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

/**
 * Count the number of assistant `tool_calls` messages already present in the
 * serialized conversation envelope. A multi-step scenario accumulates history
 * through prior assistant tool_calls + linked tool-result messages (never a
 * fresh user instruction), so the count is the scenario's 0-based ROUND index:
 * 0 → first round, 1 → second round, and so on. Single-round cases always see 0.
 *
 * It names the round only — NOT the expected tool. Under the state-aware engine
 * the expectation comes from the transitions that actually succeeded, so a fake
 * upstream that intends to advance a transition has to send arguments that
 * genuinely match the scenario (see {@link scenarioAdapter}).
 */
function priorAssistantToolCallCount(prompt: string): number {
  const begin = prompt.indexOf("BEGIN_CONVERSATION_JSON\n");
  const end = prompt.indexOf("\nEND_CONVERSATION_JSON");
  if (begin === -1 || end === -1) return 0;
  try {
    const conv = JSON.parse(prompt.slice(begin + "BEGIN_CONVERSATION_JSON\n".length, end)) as {
      messages: { role: string; tool_calls?: unknown[] }[];
    };
    return conv.messages.filter(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    ).length;
  } catch {
    return 0;
  }
}

/**
 * The corpus's synthetic replacement text (`cases.ts` builds every scenario with
 * `version=1` → `version=2`). A fake `edit` must send EXACTLY this text, on the
 * scenario's own path, for the state-aware engine to complete the transition.
 */
const SCENARIO_FINAL_CONTENT = "version=2";
/** A replacement text no scenario expects (a semantically wrong `edit`). */
const SCENARIO_WRONG_CONTENT = "version=3";
/** A synthetic path belonging to no scenario (a `read`/`edit` that cannot land). */
const FOREIGN_PATH = "synthetic/absent.txt";
/** The schema-valid throwaway argument a single-round `read` may use. */
const SINGLE_ROUND_ARG_PATH = "synthetic/x";

/** One synthetic tool call a fake upstream can propose. */
interface ToolCallSpec {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
/** One fake upstream reply: a parallel batch of tool calls, or final text. */
type ScenarioReply = readonly ToolCallSpec[] | "final";

const readSpec = (path: string): ToolCallSpec => ({ name: "read", arguments: { path } });
const editSpec = (path: string, text: string): ToolCallSpec => ({
  name: "edit",
  arguments: { path, text },
});
const TEST_SPEC: ToolCallSpec = { name: "test", arguments: {} };

/** Serialize a reply into the upstream tool-or-final protocol envelope. */
function replyEnvelope(reply: ScenarioReply): string {
  if (reply === "final") {
    return JSON.stringify({
      gateway_protocol: "1.0",
      type: "final",
      content: "synthetic summary",
    });
  }
  return JSON.stringify({ gateway_protocol: "1.0", type: "tool_calls", calls: reply });
}

/**
 * Recover a multi-step scenario's own synthetic document path from the ONE
 * initial user message carried in the serialized conversation, or null for a
 * single-round case. The corpus states the path literally
 * (`synthetic/module-<j>.txt`), which is what lets a fake upstream build
 * arguments that ACTUALLY satisfy a transition — the state-aware engine advances
 * a step only when the call's arguments match the scenario, so a positional
 * schedule of tool names is no longer enough.
 */
function scenarioPathFromPrompt(prompt: string): string | null {
  return /synthetic\/module-\d+\.txt/.exec(prompt)?.[0] ?? null;
}

/**
 * A fake upstream driven by a per-round multi-step SCRIPT. Every single-round
 * case is answered with a correctly-named, schema-valid `read` call (a
 * single-round case has no transition state, so only the tool NAME is scored),
 * while each multi-step round is answered by `script(round, path)` where `round`
 * is the 0-based round index derived from the accumulated assistant tool_calls
 * messages and `path` is that scenario's own synthetic document path.
 *
 * All arguments are invented synthetic corpus values, no tool is ever executed,
 * and nothing here touches the network.
 */
function scenarioAdapter(
  script: (round: number, path: string) => ScenarioReply,
): CollectivIQAdapter {
  let n = 0;
  let lastPrompt = "";
  const envelopeFor = (prompt: string): string => {
    const path = scenarioPathFromPrompt(prompt);
    if (path === null) return replyEnvelope([readSpec(SINGLE_ROUND_ARG_PATH)]);
    return replyEnvelope(script(priorAssistantToolCallCount(prompt), path));
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

/** The four-round sequential workflow: read → edit → test → final text. */
function sequentialSuccess(round: number, path: string): ScenarioReply {
  if (round === 0) return [readSpec(path)];
  if (round === 1) return [editSpec(path, SCENARIO_FINAL_CONTENT)];
  if (round === 2) return [TEST_SPEC];
  return "final";
}

/**
 * The default fake upstream: correct single-round `read` calls plus a fully
 * successful four-round scenario whose arguments genuinely satisfy every
 * transition.
 */
function smartAdapter(): CollectivIQAdapter {
  return scenarioAdapter(sequentialSuccess);
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

/** Build a seed checkpoint pointing at `nextCaseIndex` with the real corpus fingerprint.
 *
 * The tests exercise cursors up to the single/multi boundary (200); the seed
 * therefore covers only committed SINGLE cases and leaves the format-4
 * `scenarioEvidence` ledger empty (no committed multi scenarios).
 * Multi-committed seeds construct their own evidence tuples via `over`.
 */
function seedCheckpoint(nextCaseIndex: number, over: Partial<CheckpointData> = {}): CheckpointData {
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
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
    scenarioEvidence: [],
    diagnosticFailures: [],
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
    // The scenario runs the real four-round workflow with arguments that actually
    // satisfy each transition, so the accumulated transcript is the one a
    // successful scenario really builds.
    const prompts: string[] = [];
    const base = scenarioAdapter(sequentialSuccess);
    const capturing: CollectivIQAdapter = {
      createThread: (input) => base.createThread(input),
      processMessage: (input) => {
        prompts.push(input.prompt);
        return base.processMessage(input);
      },
      getMessages: (id, signal) => base.getMessages(id, signal),
      getThreadTitle: (id, signal) => base.getThreadTitle(id, signal),
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
    ) as {
      messages: {
        role: string;
        content?: string | null;
        tool_calls?: { id: string }[];
        tool_call_id?: string;
      }[];
    };
    // Exactly ONE user message across the whole scenario history (spec §30):
    // no fresh user instruction is injected between tool results.
    const userMessages = conv.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
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

  it("Finding 1: fingerprint(cases) matches fingerprint() when cases === buildEvalCases()", () => {
    // The executed evaluator now builds `cases` ONCE and passes the same
    // array to `corpusFingerprint(cases)` and `evalPlan(cases)`. Confirm the
    // supplied form agrees with the zero-arg form byte-for-byte — a fresh
    // rebuild inside those helpers would have been a redundant build, but the
    // digest must remain stable for existing resumable checkpoints.
    const cases = buildEvalCases();
    expect(corpusFingerprint(cases)).toBe(corpusFingerprint());
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
    // 20 scenarios × 3 intra-scenario events, plus one scenario-end event for
    // each scenario EXCEPT the last: the final case's commit is kept in memory
    // and persists no checkpoint, so it must emit no progress record claiming
    // a durable write. 60 + 19 = 79.
    expect(multi).toHaveLength(20 * 3 + 19);
    const finalRounds = multi.filter((p) => p.roundOrdinal === 4);
    expect(finalRounds).toHaveLength(19);
    const ordinals = finalRounds.map((p) => p.caseOrdinal);
    expect(new Set(ordinals).size).toBe(19); // one per scenario, no duplicates
    // The omitted scenario-end event is precisely the LAST corpus case.
    expect(ordinals).not.toContain(220);
    expect(Math.max(...ordinals)).toBe(219);
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

// ---------------------------------------------------------------------------
// Failure diagnostics (report v5 / checkpoint v4 / classifier + resume)
// ---------------------------------------------------------------------------

/**
 * The sentinel values below are SYNTHETIC and match no real customer content.
 * They exist only to prove absence-scans catch any leak into report/checkpoint.
 */
const NAME_SENTINEL = "read";
const ARG_SENTINEL = "SYNTH-ARG-VALUE-eef2";
const PROMPT_SENTINEL = "Synthetic single-round task"; // literal from cases.ts

/** A poll-outcome-shaped synthetic response with a single Claude message. */
function claudeMessage(envelope: string) {
  return {
    messages: [
      {
        source: "claude" as const,
        content: envelope,
        percentUsage: null,
        createdAt: 1,
        id: 1,
      },
    ],
    rawStatus: 200,
  };
}

/**
 * An adapter that returns per-round envelopes based on a 1-based upstream-round
 * ordinal (thread id counter). Single-round cases occupy ordinals 1..200
 * exactly; multi-step scenario rounds occupy ordinals 201+. The chooser also
 * receives the serialized prompt, which is how a multi-step round can recover
 * its own scenario path and round index (the state-aware engine advances a
 * transition only when the call's ARGUMENTS match the scenario).
 */
function ordinalAdapter(
  envelopePerOrdinal: (ordinal: number, prompt: string) => string,
): CollectivIQAdapter {
  let created = 0;
  let lastPrompt = "";
  return {
    createThread: () => {
      created += 1;
      return Promise.resolve({ threadId: `t${created}`, rawStatus: 200 });
    },
    processMessage: (input) => {
      lastPrompt = input.prompt;
      return Promise.resolve({ accepted: true, rawStatus: 202 });
    },
    getMessages: () => Promise.resolve(claudeMessage(envelopePerOrdinal(created, lastPrompt))),
    getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
  };
}

const readCallEnvelope = replyEnvelope([readSpec(SINGLE_ROUND_ARG_PATH)]);
const editCallEnvelope = replyEnvelope([editSpec(SINGLE_ROUND_ARG_PATH, "v2")]);
const finalEnvelope = replyEnvelope("final");
const malformedEnvelope = "not a valid envelope at all";

/**
 * The scoring adapter used by the six-miss arithmetic and passing-run scans.
 * Single-round cases map by 1-based ordinal:
 *   1: auto     → final       → decision:text          (expected-tool-returned-text)
 *   2: required → final       → decision:no_valid_call (expected-tool-no-valid-call)
 *   3: function → final       → decision:no_valid_call (expected-tool-no-valid-call)
 *   4: auto     → edit call   → decision:tool_calls allowed w/o expected (expected-tool-not-invoked)
 *   5: required → edit call   → decision:tool_calls allowed w/o expected (expected-tool-not-invoked)
 *   7: auto     → edit call   → decision:tool_calls allowed w/o expected (expected-tool-not-invoked)
 * Every other single-round case returns the expected `read` call, and every
 * multi-step scenario runs the successful four-round workflow with arguments
 * that genuinely satisfy each transition. This yields exactly 6 diagnostics,
 * gates schemaValid=257, nameAccurate=254, argValid=257 over the 260
 * expected-step denominator, single=194/200 (passes 90%), multi=20/20 (passes
 * 85%), and toolNameAccuracy 254/260 = 97.7% fails the 98% threshold.
 */
function sixMissAdapter(): CollectivIQAdapter {
  const missByOrdinal = new Map<number, string>([
    [1, finalEnvelope],
    [2, finalEnvelope],
    [3, finalEnvelope],
    [4, editCallEnvelope],
    [5, editCallEnvelope],
    [7, editCallEnvelope],
  ]);
  const forOrdinal = (ordinal: number, prompt: string): string => {
    const injected = missByOrdinal.get(ordinal);
    if (injected !== undefined) return injected;
    const path = scenarioPathFromPrompt(prompt);
    // A multi-step round drives the successful workflow from its own state.
    if (path !== null) {
      return replyEnvelope(sequentialSuccess(priorAssistantToolCallCount(prompt), path));
    }
    return readCallEnvelope;
  };
  return ordinalAdapter(forOrdinal);
}

/** All expected-tool rounds miss because the model always returns final text. */
function alwaysFinalAdapter(): CollectivIQAdapter {
  return ordinalAdapter(() => finalEnvelope);
}

/** All expected-tool rounds miss because the model always returns malformed output. */
function alwaysMalformedAdapter(): CollectivIQAdapter {
  return ordinalAdapter(() => malformedEnvelope);
}

describe("eval:tools — report version 5 across every mode", () => {
  it("preflight emits version 5", async () => {
    const h = harness({ argv: [] });
    await runToolsEval(h.deps);
    expect((h.emitted[0] as PreflightReport).version).toBe(5);
    expect(EVAL_REPORT_VERSION).toBe(5);
  });

  it("blocked emits version 5 (with no failures collection)", async () => {
    const h = harness({ argv: fullArgv, store: memCheckpointStore(seedCheckpoint(100)) });
    await runToolsEval(h.deps);
    const record = h.emitted[0] as BlockedReport;
    expect(record.version).toBe(5);
    // Blocked reports carry no diagnostics collection (only executed does).
    expect(Object.hasOwn(record, "diagnostics")).toBe(false);
  });

  it("progress + executed emit version 5", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    for (const record of h.emitted) expect(record.version).toBe(5);
    const record = executed(h.emitted);
    expect(record.version).toBe(5);
  });

  it("persists checkpoint format 4 with the state-aware per-scenario evidence ledger", async () => {
    // Capture the durable writes: a complete passing run removes the checkpoint,
    // so the last write is the SECOND-TO-LAST case's commit — the final case is
    // held in memory so no complete-corpus cursor is ever persisted.
    const store = memCheckpointStore();
    const writes: CheckpointData[] = [];
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      writes.push(d);
      realWrite(d);
    };
    const h = harness({ argv: fullArgv, store });
    await runToolsEval(h.deps);
    expect(CHECKPOINT_FORMAT_VERSION).toBe(4);
    const last = writes[writes.length - 1];
    expect(last?.formatVersion).toBe(4);
    // Format 4 replaced the positional `executedScenarioRounds` integer ledger.
    expect(Object.hasOwn(last ?? {}, "executedScenarioRounds")).toBe(false);
    expect(last?.scenarioEvidence).toHaveLength(19);
    expect(last?.nextCaseIndex).toBe(219);
  });
});

describe("eval:tools — passing run emits an empty diagnostics.failures array", () => {
  it("a fully-clean, fully-passing corpus has zero diagnostics", async () => {
    const h = harness({ argv: fullArgv });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.passed).toBe(true);
    expect(report.diagnostics).toEqual({ failures: [] });
    // Not a proxy or hidden accessor: it is a genuine own array.
    expect(Array.isArray(report.diagnostics.failures)).toBe(true);
  });
});

describe("eval:tools — deterministic classifier precedence", () => {
  const toolCallsDecision = (
    over: Partial<Extract<RoundDecision, { kind: "tool_calls" }>> = {},
  ): RoundDecision => ({
    kind: "tool_calls",
    calls: [] as never,
    allAllowed: true,
    expectedInvoked: true,
    unauthorized: false,
    ...over,
  });

  it("expected-tool round: unavailable → expected-tool-unavailable", () => {
    expect(classifyRoundFailure({ kind: "unavailable" }, true)).toBe("expected-tool-unavailable");
  });
  it("expected-tool round: no_valid_call → expected-tool-no-valid-call", () => {
    expect(classifyRoundFailure({ kind: "no_valid_call" }, true)).toBe(
      "expected-tool-no-valid-call",
    );
  });
  it("expected-tool round: text → expected-tool-returned-text", () => {
    expect(classifyRoundFailure({ kind: "text" }, true)).toBe("expected-tool-returned-text");
  });
  it("expected-tool round: tool_calls unauthorized → unauthorized-tool-call", () => {
    expect(
      classifyRoundFailure(
        toolCallsDecision({ allAllowed: false, unauthorized: true, expectedInvoked: false }),
        true,
      ),
    ).toBe("unauthorized-tool-call");
  });
  it("expected-tool round: allowed but expected-not-invoked → expected-tool-not-invoked", () => {
    expect(classifyRoundFailure(toolCallsDecision({ expectedInvoked: false }), true)).toBe(
      "expected-tool-not-invoked",
    );
  });
  it("expected-tool round: expected-invoked + allowed → null (caller checks transcript linkage)", () => {
    expect(classifyRoundFailure(toolCallsDecision(), true)).toBeNull();
  });

  it("final round: text → null (correct outcome)", () => {
    expect(classifyRoundFailure({ kind: "text" }, false)).toBeNull();
  });
  it("final round: unavailable → final-unavailable", () => {
    expect(classifyRoundFailure({ kind: "unavailable" }, false)).toBe("final-unavailable");
  });
  it("final round: no_valid_call → final-no-valid-call", () => {
    expect(classifyRoundFailure({ kind: "no_valid_call" }, false)).toBe("final-no-valid-call");
  });
  it("final round: unauthorized tool_calls → unauthorized-tool-call", () => {
    expect(
      classifyRoundFailure(toolCallsDecision({ allAllowed: false, unauthorized: true }), false),
    ).toBe("unauthorized-tool-call");
  });
  it("final round: any other tool_calls → unexpected-tool-call-on-final", () => {
    expect(classifyRoundFailure(toolCallsDecision(), false)).toBe("unexpected-tool-call-on-final");
  });

  it("classifier precedence: unauthorized beats expected-tool-not-invoked", () => {
    // Both flags set — the closed union prioritizes the authorization violation.
    expect(
      classifyRoundFailure(
        toolCallsDecision({
          allAllowed: false,
          unauthorized: true,
          expectedInvoked: false,
        }),
        true,
      ),
    ).toBe("unauthorized-tool-call");
  });

  it("classifier precedence: unauthorized wins even when the expected tool WAS also invoked", () => {
    // The model produced two tool_calls — one is the correctly-named expected
    // call AND another is not in the toolset (unauthorized). `allAllowed`
    // becomes false and `unauthorized` becomes true even though
    // `expectedInvoked` is true. The classifier's closed precedence must
    // still return `unauthorized-tool-call` — never `expected-tool-not-invoked`
    // and never `null`. Note that `null` here would allow the loop's
    // transcript re-check to overwrite the reason with `transcript-invalid`;
    // the transcript override in `tools-eval-cli.ts` is now guarded by
    // `if (reason === null)` so the primary `unauthorized-tool-call` reason
    // is preserved even if a later transcript re-validation would have
    // failed.
    expect(
      classifyRoundFailure(
        toolCallsDecision({
          allAllowed: false,
          unauthorized: true,
          expectedInvoked: true,
        }),
        true,
      ),
    ).toBe("unauthorized-tool-call");
  });

  it("transcript-invalid override preserves any earlier primary reason", () => {
    // Documented rule in the multi-step loop:
    //   if (!transcriptValid(history, tools)) {
    //     scenarioOk = false;
    //     if (reason === null) reason = "transcript-invalid";
    //   }
    // Simulate the loop's precedence for every non-null classifier output
    // and prove `transcript-invalid` NEVER wins over an earlier primary
    // reason. This is a narrow re-test of the runner's precedence step 6
    // without a live upstream call.
    const priorityReasons: readonly EvalFailureReason[] = [
      "expected-tool-unavailable",
      "expected-tool-no-valid-call",
      "expected-tool-returned-text",
      "unauthorized-tool-call",
      "expected-tool-not-invoked",
    ];
    for (const prior of priorityReasons) {
      let reason: EvalFailureReason | null = prior;
      const transcriptOk = false;
      if (!transcriptOk) {
        if (reason === null) reason = "transcript-invalid";
      }
      expect(reason).toBe(prior);
    }
    // And when the classifier returned null (a successful expected call
    // whose transcript then fails re-validation), transcript-invalid is
    // filled in.
    let reason: EvalFailureReason | null = null;
    const transcriptOk = false;
    if (!transcriptOk) {
      if (reason === null) reason = "transcript-invalid";
    }
    expect(reason).toBe("transcript-invalid");
  });

  it("every closed reason has a fixed numeric code, with 10 APPENDED and 1..9 unchanged", () => {
    const codes: readonly EvalFailureReason[] = [
      "expected-tool-returned-text",
      "expected-tool-no-valid-call",
      "expected-tool-unavailable",
      "expected-tool-not-invoked",
      "unauthorized-tool-call",
      "transcript-invalid",
      "unexpected-tool-call-on-final",
      "final-no-valid-call",
      "final-unavailable",
      "scenario-round-budget-exhausted",
    ];
    // The union has exactly TEN members and the map covers all of them.
    expect(codes).toHaveLength(10);
    expect(new Set(Object.keys(EVAL_FAILURE_REASON_CODES))).toEqual(new Set(codes));
    for (const reason of codes) {
      expect(typeof EVAL_FAILURE_REASON_CODES[reason]).toBe("number");
    }
    // Codes 1..9 keep their pre-v5 meaning byte-for-byte; a renumbering would
    // silently rewrite every persisted checkpoint ledger entry.
    expect(EVAL_FAILURE_REASON_CODES).toEqual({
      "expected-tool-returned-text": 1,
      "expected-tool-no-valid-call": 2,
      "expected-tool-unavailable": 3,
      "expected-tool-not-invoked": 4,
      "unauthorized-tool-call": 5,
      "transcript-invalid": 6,
      "unexpected-tool-call-on-final": 7,
      "final-no-valid-call": 8,
      "final-unavailable": 9,
      // APPENDED for report v5.
      "scenario-round-budget-exhausted": 10,
    });
    // Codes are unique and are exactly 1..10.
    const codeValues = Object.values(EVAL_FAILURE_REASON_CODES);
    expect(new Set(codeValues).size).toBe(codes.length);
    expect([...codeValues].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("scopes the appended whole-scenario reason to EITHER round category", () => {
    // A budget-exhausted scenario has no single failing round category, so its
    // scope must be `any` — the only honest classification once a round's
    // position no longer determines what it expected.
    expect(EVAL_FAILURE_REASON_SCOPE["scenario-round-budget-exhausted"]).toBe("any");
    // The pre-v5 scopes are unchanged.
    expect(EVAL_FAILURE_REASON_SCOPE["expected-tool-not-invoked"]).toBe("expected");
    expect(EVAL_FAILURE_REASON_SCOPE["unexpected-tool-call-on-final"]).toBe("final");
    expect(EVAL_FAILURE_REASON_SCOPE["unauthorized-tool-call"]).toBe("any");
  });
});

describe("eval:tools — six-miss arithmetic and diagnostic classification", () => {
  it("produces exactly the story counts and one diagnostic per failed round", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => sixMissAdapter() });
    const code = await runToolsEval(h.deps);
    // toolNameAccuracy fails → passed = false.
    expect(code).toBe(1);
    const report = executed(h.emitted);
    // Gate arithmetic matches the sanitized 2026-08-26 story shape.
    expect(report.gates.schemaValidity.numerator).toBe(257);
    expect(report.gates.schemaValidity.denominator).toBe(260);
    expect(report.gates.schemaValidity.status).toBe("passed");
    expect(report.gates.toolNameAccuracy.numerator).toBe(254);
    expect(report.gates.toolNameAccuracy.denominator).toBe(260);
    expect(report.gates.toolNameAccuracy.status).toBe("failed");
    expect(report.gates.argValidity.numerator).toBe(257);
    expect(report.gates.argValidity.denominator).toBe(260);
    expect(report.gates.argValidity.status).toBe("passed");
    // Diagnostics: exactly six primary reasons.
    const failures = report.diagnostics.failures;
    expect(failures).toHaveLength(6);
    // Exactly one entry per failed round (unique (caseOrdinal, roundOrdinal)).
    const keys = failures.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`);
    expect(new Set(keys).size).toBe(6);
    // Byte-for-byte closed unions with no other keys.
    for (const d of failures) {
      expect(new Set(Object.keys(d))).toEqual(
        new Set(["phase", "caseOrdinal", "roundOrdinal", "choiceKind", "reason"]),
      );
      expect(d.phase).toBe("single");
      expect(d.roundOrdinal).toBe(1);
    }
    // Sorted by classifier attribution:
    //  cases 1,2,3 → 3 schema-invalid diagnostics; cases 4,5,7 → 3 wrong-name diagnostics.
    const byOrdinal = new Map(failures.map((d) => [d.caseOrdinal, d]));
    expect(byOrdinal.get(1)?.reason).toBe("expected-tool-returned-text");
    expect(byOrdinal.get(1)?.choiceKind).toBe("auto");
    expect(byOrdinal.get(2)?.reason).toBe("expected-tool-no-valid-call");
    expect(byOrdinal.get(2)?.choiceKind).toBe("required");
    expect(byOrdinal.get(3)?.reason).toBe("expected-tool-no-valid-call");
    expect(byOrdinal.get(3)?.choiceKind).toBe("function");
    for (const ord of [4, 5, 7] as const) {
      expect(byOrdinal.get(ord)?.reason).toBe("expected-tool-not-invoked");
    }
    // Single-round success = 194/200 (six missed rounds), multi = 20/20.
    expect(report.gates.singleRoundSuccess.numerator).toBe(194);
    expect(report.gates.singleRoundSuccess.denominator).toBe(200);
    expect(report.gates.singleRoundSuccess.status).toBe("passed");
    expect(report.gates.multiStepSuccess.numerator).toBe(20);
    expect(report.gates.multiStepSuccess.denominator).toBe(20);
    expect(report.gates.multiStepSuccess.status).toBe("passed");
  });

  it("existing gate results are byte-for-byte identical to a diagnostics-blind snapshot", async () => {
    // Prove that diagnostics do NOT influence gate accumulators or overall pass/fail.
    const h = harness({ argv: fullArgv, makeAdapter: () => sixMissAdapter() });
    await runToolsEval(h.deps);
    const report = executed(h.emitted);
    // Build a `diagnostics-blind` clone stripped of failures + reserialized.
    const withoutDiags = JSON.parse(
      JSON.stringify({ ...report, diagnostics: undefined }),
    ) as ExecutedReport;
    for (const key of [
      "schemaValidity",
      "toolNameAccuracy",
      "argValidity",
      "singleRoundSuccess",
      "multiStepSuccess",
    ] as const) {
      expect(withoutDiags.gates[key]).toEqual(report.gates[key]);
    }
    expect(withoutDiags.passed).toBe(report.passed);
  });

  it("diagnostic entries never expose prompts, answers, tool names, model names, arguments, ids, or credentials", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => sixMissAdapter() });
    await runToolsEval(h.deps);
    const report = executed(h.emitted);
    const serialized = JSON.stringify(report.diagnostics.failures);
    for (const sentinel of [
      NAME_SENTINEL,
      "edit",
      "test",
      ARG_SENTINEL,
      PROMPT_SENTINEL,
      "synthetic/doc",
      "call_ciq_",
      CRED_SENTINEL,
      "claude",
      "synthetic summary",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    // Nor the full emitted stream.
    const full = JSON.stringify(h.emitted);
    expect(full).not.toContain(CRED_SENTINEL);
  });
});

describe("eval:tools — multi-step transcript and early-termination diagnostics (spec §30)", () => {
  it("terminates a scenario at its first terminal failure and records exactly one primary diagnostic (no cascade)", async () => {
    // RE-EXPRESSED for the state-aware engine. Round 1 performs a genuinely
    // successful `read` (correct path → transition 0 completes), so the pending
    // transition becomes `edit`. Round 2 repeats `read`: the tool is allowed and
    // schema-valid, but it is not the pending transition's tool →
    // `expected-tool-not-invoked`. Under early-termination semantics the
    // scenario STOPS at round 2 (rounds 3 and 4 are never issued and no cascade
    // diagnostics are fabricated). The repeated `read` also must not advance the
    // already-satisfied transition a second time.
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => scenarioAdapter((_round, path) => [readSpec(path)]),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    // Exactly one diagnostic per scenario, at round 2 (the first terminal failure).
    const multiFailures = report.diagnostics.failures.filter((d) => d.phase === "multi");
    expect(multiFailures).toHaveLength(20);
    for (const d of multiFailures) {
      expect(d.roundOrdinal).toBe(2);
      expect(d.reason).toBe("expected-tool-not-invoked");
    }
    // The final round (round 4) never produced a diagnostic — it was never attempted.
    const round4Diags = report.diagnostics.failures.filter(
      (d) => d.phase === "multi" && d.roundOrdinal === 4,
    );
    expect(round4Diags).toHaveLength(0);
    // Multi-step success is 0/20 (every scenario terminated with a wrong tool).
    expect(report.gates.multiStepSuccess.numerator).toBe(0);
    expect(report.gates.multiStepSuccess.denominator).toBe(20);
    expect(report.gates.multiStepSuccess.status).toBe("failed");
    // Under early termination, actual upstream attempts fall below the planned
    // 280: the 20 scenarios attempted rounds 1+2 only (40) instead of 4 each (80),
    // so `attemptedRounds = 200 + 20*2 = 240 < 280 = plannedUpstreamRounds`.
    expect(report.plannedUpstreamRounds).toBe(280);
    expect(report.attemptedRounds).toBe(240);
    // Expected-step denominator is unchanged: every committed scenario contributes
    // 3 planned transitions regardless of how many rounds were actually attempted.
    expect(report.gates.schemaValidity.plannedDenominator).toBe(260);
    expect(report.gates.schemaValidity.denominator).toBe(260);
    // Per-transition evidence, credited exactly once each: transition 0 fully
    // satisfied by round 1, transition 1 schema/argument-valid but wrongly named
    // at round 2, transition 2 never reached.
    expect(report.gates.schemaValidity.numerator).toBe(200 + 20 * 2);
    expect(report.gates.argValidity.numerator).toBe(200 + 20 * 2);
    expect(report.gates.toolNameAccuracy.numerator).toBe(200 + 20 * 1);
  });

  it("terminates a scenario immediately when round 1 returns final text (no cascade), counting missed rounds as denominator only", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => alwaysFinalAdapter() });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    // 200 single-round diagnostics (67 auto → returned-text, 133 required/function
    // → no-valid-call). Multi scenarios all terminate at round 1 (auto expected
    // `read` → the model returned final text → `expected-tool-returned-text`), so
    // exactly 20 multi diagnostics, each at round 1.
    const returnedText = report.diagnostics.failures.filter(
      (d) => d.reason === "expected-tool-returned-text",
    );
    const noValid = report.diagnostics.failures.filter(
      (d) => d.reason === "expected-tool-no-valid-call",
    );
    // Every single-round `auto` (67) + every multi-step round 1 (20) → returned-text.
    expect(returnedText.length).toBe(67 + 20); // 87
    expect(noValid.length).toBe(200 - 67); // 133 required/function singles
    // No cascade diagnostics past round 1 in any scenario.
    const multiDiags = report.diagnostics.failures.filter((d) => d.phase === "multi");
    expect(multiDiags).toHaveLength(20);
    for (const d of multiDiags) expect(d.roundOrdinal).toBe(1);
    expect(report.diagnostics.failures).toHaveLength(200 + 20); // 220 total
    // Denominators are complete: gates.expectedCall.total still equals 260 (200 singles +
    // 20 scenarios × 3 expected-tool rounds each), even though 40 of those 60
    // multi-step expected-tool rounds were NEVER attempted.
    expect(report.gates.schemaValidity.denominator).toBe(260);
    expect(report.gates.schemaValidity.plannedDenominator).toBe(260);
    // Actual attempts: 200 singles + 20 scenarios × 1 round each = 220.
    expect(report.attemptedRounds).toBe(220);
    expect(report.plannedUpstreamRounds).toBe(280);
    // Multi-step success = 0/20 (every scenario terminated); denominator complete.
    expect(report.gates.multiStepSuccess.numerator).toBe(0);
    expect(report.gates.multiStepSuccess.denominator).toBe(20);
    expect(report.gates.multiStepSuccess.status).toBe("failed");
  });

  it("does not credit a final round twice: choiceKind is a member of the closed narrow set", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => alwaysMalformedAdapter() });
    await runToolsEval(h.deps);
    const report = executed(h.emitted);
    for (const d of report.diagnostics.failures) {
      expect(["auto", "required", "function"]).toContain(d.choiceKind);
    }
  });
});

// ---------------------------------------------------------------------------
// State-aware multi-step transitions (report v5 / checkpoint v4)
// ---------------------------------------------------------------------------

/** `[read, edit]` in one parallel batch, then `test`, then final text (3 rounds). */
function parallelReadEditSuccess(round: number, path: string): ScenarioReply {
  if (round === 0) return [readSpec(path), editSpec(path, SCENARIO_FINAL_CONTENT)];
  if (round === 1) return [TEST_SPEC];
  return "final";
}

/**
 * A semantically failed `edit` (correct tool name, wrong replacement text) that
 * a later round retries correctly, recovering inside the four-round budget by
 * pairing the retry with `test`.
 */
function editRetryRecovery(round: number, path: string): ScenarioReply {
  if (round === 0) return [readSpec(path)];
  if (round === 1) return [editSpec(path, SCENARIO_WRONG_CONTENT)];
  if (round === 2) return [editSpec(path, SCENARIO_FINAL_CONTENT), TEST_SPEC];
  return "final";
}

/** A successful `read`, then `test` while `edit` is still the pending transition. */
function prematureTest(round: number, path: string): ScenarioReply {
  if (round === 0) return [readSpec(path)];
  return [TEST_SPEC];
}

/** A successful `read`, then ordinary text while `edit` is still pending. */
function textWhilePending(round: number, path: string): ScenarioReply {
  if (round === 0) return [readSpec(path)];
  return "final";
}

/** One batch completing all three transitions, then a stray tool call. */
function callAfterComplete(round: number, path: string): ScenarioReply {
  if (round === 0) return [readSpec(path), editSpec(path, SCENARIO_FINAL_CONTENT), TEST_SPEC];
  return [TEST_SPEC];
}

/** The result of a scenario-only run (see {@link runScenarios}). */
interface ScenarioRun {
  readonly code: number;
  readonly report: ExecutedReport;
  readonly emitted: EvalOutput[];
  /** Every durable checkpoint payload written during the run, in order. */
  readonly writes: CheckpointData[];
}

/**
 * Run ONLY the 20 multi-step scenarios, by resuming from a seeded cursor at the
 * single/multi boundary and driving every scenario from `script`. The 200 seeded
 * single-round cases are already committed at 200/200, so the corpus still
 * COMPLETES with full gate denominators (200 single rounds + 20 × 3 planned
 * transitions = 260) while the segment itself issues at most 80 upstream rounds.
 */
async function runScenarios(
  script: (round: number, path: string) => ScenarioReply,
): Promise<ScenarioRun> {
  const store = memCheckpointStore(seedCheckpoint(200));
  const writes: CheckpointData[] = [];
  const realWrite = store.write.bind(store);
  store.write = (d) => {
    writes.push(d);
    realWrite(d);
  };
  const h = harness({ argv: resumeArgv, store, makeAdapter: () => scenarioAdapter(script) });
  const code = await runToolsEval(h.deps);
  return { code, report: executed(h.emitted), emitted: h.emitted, writes };
}

/**
 * Multi-step scenarios visible in the LAST DURABLE checkpoint of a complete
 * scenario-only run.
 *
 * The runner keeps the FINAL case's commit in memory and never persists
 * `nextCaseIndex === cases.length`, because `validateResumableCheckpoint`
 * refuses that cursor by design. So a complete 20-scenario run's last durable
 * checkpoint carries evidence for the first NINETEEN scenarios; the twentieth
 * exists only in the executed report, which every test below also asserts.
 */
const DURABLE_MULTI_SCENARIOS = 20 - 1;

/** The per-scenario evidence ledger persisted by the run's last durable write. */
function lastScenarioEvidence(
  writes: readonly CheckpointData[],
): readonly CheckpointScenarioEvidence[] {
  return writes[writes.length - 1]?.scenarioEvidence ?? [];
}

/** Count the set bits of a three-step evidence mask. */
function maskBits(mask: number): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1);
}

/** The multi-step diagnostics of a scenario-only run. */
function multiFailures(report: ExecutedReport) {
  return report.diagnostics.failures.filter((d) => d.phase === "multi");
}

/** The three per-transition threshold gates, in a fixed order. */
function stepGates(report: ExecutedReport) {
  return [report.gates.schemaValidity, report.gates.argValidity, report.gates.toolNameAccuracy];
}

describe("eval:tools — state-aware multi-step transitions (report v5)", () => {
  it("credits all three transitions exactly once for a sequential read → edit → test → final", async () => {
    const run = await runScenarios(sequentialSuccess);
    expect(run.code).toBe(0);
    expect(run.report.passed).toBe(true);
    expect(run.report.diagnostics.failures).toEqual([]);
    expect(run.report.completedMultiStepScenarios).toBe(20);
    expect(run.report.gates.multiStepSuccess.numerator).toBe(20);
    expect(run.report.gates.multiStepSuccess.denominator).toBe(20);
    expect(run.report.gates.multiStepSuccess.status).toBe("passed");
    // 200 seeded single rounds + 20 × 3 planned transitions, each credited ONCE.
    for (const gate of stepGates(run.report)) {
      expect(gate.denominator).toBe(260);
      expect(gate.numerator).toBe(260);
      expect(gate.status).toBe("passed");
    }
    // Four upstream rounds per scenario on top of the 200 committed singles.
    expect(run.report.attemptedRounds).toBe(200 + 20 * 4);
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      expect(entry).toEqual([4, 3, 0b111, 0b111, 0b111]);
    }
  });

  it("succeeds in THREE rounds when a parallel [read, edit] batch completes two transitions at once", async () => {
    // The headline v5 behavior: the previous positional schedule scored this
    // scenario's correct `test` round against a stale round-2 `edit` expectation
    // and reported a failure. State-aware scoring accepts it and emits NO
    // diagnostic, while still crediting each planned transition exactly once.
    const run = await runScenarios(parallelReadEditSuccess);
    expect(run.code).toBe(0);
    expect(run.report.passed).toBe(true);
    expect(run.report.diagnostics.failures).toEqual([]);
    expect(run.report.gates.multiStepSuccess.numerator).toBe(20);
    expect(run.report.gates.multiStepSuccess.denominator).toBe(20);
    for (const gate of stepGates(run.report)) {
      expect(gate.denominator).toBe(260);
      expect(gate.numerator).toBe(260);
    }
    // THREE upstream rounds per scenario — below the four-round budget.
    expect(run.report.attemptedRounds).toBe(200 + 20 * 3);
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      expect(entry).toEqual([3, 3, 0b111, 0b111, 0b111]);
    }
  });

  it("keeps a semantically failed edit PENDING (non-terminal) and credits the recovered step once", async () => {
    // A correctly-named `edit` carrying the wrong replacement text is accepted as
    // a round but does not complete its transition, so the step simply stays
    // pending and a later round retries it successfully.
    const run = await runScenarios(editRetryRecovery);
    expect(run.code).toBe(0);
    expect(run.report.diagnostics.failures).toEqual([]);
    expect(run.report.gates.multiStepSuccess.numerator).toBe(20);
    for (const gate of stepGates(run.report)) {
      expect(gate.denominator).toBe(260);
      expect(gate.numerator).toBe(260);
    }
    expect(run.report.attemptedRounds).toBe(200 + 20 * 4);
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      // Four rounds, all three transitions satisfied, ONE bit per transition —
      // the retried `edit` step is credited once, never twice.
      expect(entry).toEqual([4, 3, 0b111, 0b111, 0b111]);
    }
  });

  it("treats a premature future call without its prerequisite as terminal expected-tool-not-invoked", async () => {
    // `test` while `edit` is the pending transition: an allowed, schema-valid
    // call that is nonetheless not what the scenario state expects.
    const run = await runScenarios(prematureTest);
    expect(run.code).toBe(1);
    const failures = multiFailures(run.report);
    expect(failures).toHaveLength(20);
    for (const d of failures) {
      expect(d.roundOrdinal).toBe(2);
      expect(d.reason).toBe("expected-tool-not-invoked");
    }
    expect(run.report.gates.multiStepSuccess.numerator).toBe(0);
    expect(run.report.gates.multiStepSuccess.status).toBe("failed");
    expect(run.report.attemptedRounds).toBe(200 + 20 * 2);
    // `read` fully satisfied; the pending `edit` step earned schema + argument
    // evidence but no expected-name credit; `test` was never reached.
    expect(run.report.gates.schemaValidity.numerator).toBe(200 + 20 * 2);
    expect(run.report.gates.argValidity.numerator).toBe(200 + 20 * 2);
    expect(run.report.gates.toolNameAccuracy.numerator).toBe(200 + 20 * 1);
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      expect(entry).toEqual([2, 1, 0b011, 0b001, 0b011]);
    }
  });

  it("classifies a repeated prior tool and an allowed-but-unrelated tool as transition failures", async () => {
    // (1) Repeating the already-satisfied `read` never re-advances transition 0.
    const repeated = await runScenarios((_round, path) => [readSpec(path)]);
    expect(repeated.code).toBe(1);
    const repeatedFailures = multiFailures(repeated.report);
    expect(repeatedFailures).toHaveLength(20);
    for (const d of repeatedFailures) {
      expect(d.roundOrdinal).toBe(2);
      expect(d.reason).toBe("expected-tool-not-invoked");
    }
    const repeatedEvidence = lastScenarioEvidence(repeated.writes);
    expect(repeatedEvidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of repeatedEvidence) {
      // Still exactly ONE satisfied transition after two successful `read` calls.
      expect(entry).toEqual([2, 1, 0b011, 0b001, 0b011]);
    }

    // (2) An allowed tool that is neither the pending transition nor a prior one.
    const unrelated = await runScenarios(() => [TEST_SPEC]);
    expect(unrelated.code).toBe(1);
    const unrelatedFailures = multiFailures(unrelated.report);
    expect(unrelatedFailures).toHaveLength(20);
    for (const d of unrelatedFailures) {
      expect(d.roundOrdinal).toBe(1);
      expect(d.reason).toBe("expected-tool-not-invoked");
    }
    const unrelatedEvidence = lastScenarioEvidence(unrelated.writes);
    expect(unrelatedEvidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of unrelatedEvidence) {
      expect(entry).toEqual([1, 0, 0b001, 0b000, 0b001]);
    }
    // An allowed-but-wrong call is never an authorization violation.
    expect(unrelated.report.gates.injectionResistance).toBe("passed");
  });

  it("fails with expected-tool-returned-text when the model answers with text while a transition is pending", async () => {
    const run = await runScenarios(textWhilePending);
    expect(run.code).toBe(1);
    const failures = multiFailures(run.report);
    expect(failures).toHaveLength(20);
    for (const d of failures) {
      expect(d.roundOrdinal).toBe(2);
      expect(d.reason).toBe("expected-tool-returned-text");
    }
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      // The pending transition earned NO evidence from a text answer.
      expect(entry).toEqual([2, 1, 0b001, 0b001, 0b001]);
    }
    // Multi-step rounds use `auto`, so ordinary text is not a silent fallback.
    expect(run.report.gates.noSilentFallback).toBe("passed");
  });

  it("fails with unexpected-tool-call-on-final when a tool is called after every transition succeeded", async () => {
    const run = await runScenarios(callAfterComplete);
    expect(run.code).toBe(1);
    const failures = multiFailures(run.report);
    expect(failures).toHaveLength(20);
    for (const d of failures) {
      expect(d.roundOrdinal).toBe(2);
      expect(d.reason).toBe("unexpected-tool-call-on-final");
    }
    // One batch completed all three transitions, so every step is fully credited…
    for (const gate of stepGates(run.report)) {
      expect(gate.denominator).toBe(260);
      expect(gate.numerator).toBe(260);
    }
    // …and the scenario still FAILS: no final answer was ever accepted.
    expect(run.report.gates.multiStepSuccess.numerator).toBe(0);
    expect(run.report.gates.multiStepSuccess.status).toBe("failed");
    expect(run.report.attemptedRounds).toBe(200 + 20 * 2);
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      expect(entry).toEqual([2, 3, 0b111, 0b111, 0b111]);
    }
  });

  it("emits EXACTLY ONE scenario-round-budget-exhausted diagnostic per scenario, with no cascade", async () => {
    // Every round names the pending `read` correctly but points at a path no
    // scenario owns, so the transition never completes, no round is terminal,
    // and the four-round budget simply runs out.
    const run = await runScenarios(() => [readSpec(FOREIGN_PATH)]);
    expect(run.code).toBe(1);
    const failures = multiFailures(run.report);
    expect(failures).toHaveLength(20);
    for (const d of failures) {
      expect(d.roundOrdinal).toBe(4); // the LAST executed round
      expect(d.reason).toBe("scenario-round-budget-exhausted");
    }
    // Exactly one per scenario: no cascade across the other three rounds.
    expect(new Set(failures.map((d) => d.caseOrdinal)).size).toBe(20);
    expect(run.report.attemptedRounds).toBe(200 + 20 * 4);
    expect(run.report.gates.multiStepSuccess.numerator).toBe(0);
    const evidence = lastScenarioEvidence(run.writes);
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    for (const entry of evidence) {
      // Four rounds, zero transitions; the pending `read` step's schema/argument/
      // expected-name evidence is merged across all four attempts into ONE bit.
      expect(entry).toEqual([4, 0, 0b001, 0b001, 0b001]);
    }
    expect(run.report.gates.schemaValidity.numerator).toBe(200 + 20);
    expect(run.report.gates.argValidity.numerator).toBe(200 + 20);
    expect(run.report.gates.toolNameAccuracy.numerator).toBe(200 + 20);
  });

  it("never double-counts a transition or a metric across retries, repeats, and parallel batches", async () => {
    for (const script of [sequentialSuccess, parallelReadEditSuccess, editRetryRecovery]) {
      const run = await runScenarios(script);
      // Whatever the round shape, each scenario contributes EXACTLY three units
      // to the expected-step denominator and at most three to every numerator.
      for (const gate of stepGates(run.report)) {
        expect(gate.denominator).toBe(260);
        expect(gate.numerator).toBe(260);
      }
      expect(run.report.gates.multiStepSuccess.numerator).toBe(20);
      expect(run.report.gates.multiStepSuccess.denominator).toBe(20);
      const evidence = lastScenarioEvidence(run.writes);
      expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
      for (const [, satisfied, schemaMask, nameMask, argMask] of evidence) {
        expect(satisfied).toBe(3);
        for (const mask of [schemaMask, nameMask, argMask]) expect(maskBits(mask)).toBe(3);
      }
    }
  });

  it("persists per-scenario evidence whose popcounts reproduce the credited metrics", async () => {
    const run = await runScenarios(prematureTest);
    const evidence = lastScenarioEvidence(run.writes);
    // The last durable checkpoint holds every scenario EXCEPT the final one,
    // whose commit is kept in memory so no complete-corpus cursor is written.
    expect(evidence).toHaveLength(DURABLE_MULTI_SCENARIOS);
    expect(run.writes[run.writes.length - 1]?.completedMultiStepScenarios).toBe(
      DURABLE_MULTI_SCENARIOS,
    );
    // Every scenario ran the SAME script, so the ledger is uniform and its one
    // entry describes all 20 — including the in-memory final case. Asserting
    // uniformity first is what makes the ×20 extrapolation below sound.
    const entry = evidence[0];
    expect(entry).toBeDefined();
    for (const e of evidence) expect(e).toEqual(entry);
    const [executedRounds, satisfied, schemaMask, nameMask, argMask] =
      entry ?? ([0, 0, 0, 0, 0] as const);
    // The persisted ledger reproduces the report's multi-step contribution on top
    // of the 200 seeded single-round units, and its executed-round count
    // reproduces this segment's upstream attempts.
    expect(run.report.gates.schemaValidity.numerator).toBe(200 + 20 * maskBits(schemaMask));
    expect(run.report.gates.toolNameAccuracy.numerator).toBe(200 + 20 * maskBits(nameMask));
    expect(run.report.gates.argValidity.numerator).toBe(200 + 20 * maskBits(argMask));
    expect(run.report.attemptedRounds).toBe(200 + 20 * executedRounds);
    // No scenario completed its three transitions, so none is a multi success.
    expect(satisfied).toBe(1);
    expect(run.report.gates.multiStepSuccess.numerator).toBe(0);
  });

  it("leaves single-round scoring unchanged: name-based and argument-independent", async () => {
    // A single-round case has NO transition state, so a schema-valid `read`
    // whose path argument matches no scenario is still a full success — exactly
    // the pre-v5 behavior.
    const h = harness({ argv: fullArgv });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.gates.singleRoundSuccess.numerator).toBe(200);
    expect(report.gates.singleRoundSuccess.denominator).toBe(200);
    expect(report.gates.singleRoundSuccess.status).toBe("passed");
    expect(report.completedSingleRoundCases).toBe(200);
    expect(report.diagnostics.failures.filter((d) => d.phase === "single")).toEqual([]);
    expect(progressEvents(h.emitted).filter((p) => p.phase === "single")).toHaveLength(200);
  });
});

describe("eval:tools — resume persists diagnostics exactly once", () => {
  it("prior-segment diagnostics survive resume without duplication", async () => {
    // Segment 1: run the always-final adapter (all rounds miss).
    const store = memCheckpointStore();
    let created = 0;
    // Fail the 100th `process_message` with an UpstreamError to trigger a
    // resumable submit failure; segments 2..N will resume from the checkpoint.
    const adapter: CollectivIQAdapter = {
      createThread: () => {
        created += 1;
        return Promise.resolve({ threadId: `t${created}`, rawStatus: 200 });
      },
      processMessage: () => {
        if (created === 100) return Promise.reject(new UpstreamError("network", undefined, "POST"));
        return Promise.resolve({ accepted: true, rawStatus: 202 });
      },
      getMessages: () => Promise.resolve(claudeMessage(finalEnvelope)),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const seg1 = harness({ argv: fullArgv, store, makeAdapter: () => adapter });
    await runToolsEval(seg1.deps);
    const executed1 = executed(seg1.emitted);
    expect(executed1.aborted?.resumable).toBe(true);
    // Segment 1 committed diagnostics for cases 1..99 (single-round misses).
    const seg1Count = executed1.diagnostics.failures.length;
    expect(seg1Count).toBe(99);
    expect(store.data?.diagnosticFailures.length).toBe(99);

    // Segment 2: resume with an adapter that returns malformed text for everything.
    const seg2 = harness({
      argv: resumeArgv,
      store,
      makeAdapter: () => alwaysMalformedAdapter(),
    });
    const code = await runToolsEval(seg2.deps);
    expect(code).toBe(1); // gates still fail
    const executed2 = executed(seg2.emitted);
    // Every diagnostic is unique per (caseOrdinal, roundOrdinal).
    const keys = executed2.diagnostics.failures.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Segment 1's diagnostics are preserved verbatim in the combined report.
    const seg1Keys = new Set(
      executed1.diagnostics.failures.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`),
    );
    for (const key of seg1Keys) expect(keys).toContain(key);
    // Under early-termination semantics (spec §30), each of the 20 multi-step
    // scenarios terminates at its FIRST failed round (round 1, `auto`
    // expected → the model returned final text or a malformed envelope), so
    // exactly 20 multi diagnostics — not 60 — reach the combined report.
    // Combined: 200 single diagnostics + 20 multi = 220.
    expect(executed2.diagnostics.failures).toHaveLength(220);
    const multiCombined = executed2.diagnostics.failures.filter((d) => d.phase === "multi");
    expect(multiCombined).toHaveLength(20);
    for (const d of multiCombined) expect(d.roundOrdinal).toBe(1);
  });

  it("discards mid-scenario pending diagnostics on an OPERATIONAL abort mid-flight", async () => {
    // Round 1 of the first multi-step scenario succeeds (`read` call, correct
    // expected tool). Round 2 is interrupted DURING processMessage → the
    // scenario aborts operationally, so nothing about that scenario reaches
    // `diagnostics.failures` (spec §30 lifecycle: mid-scenario abort discards
    // pending diagnostics). A truthful EARLY TERMINATION (a terminal failure
    // classified by the scoring engine, e.g. wrong tool at round 2) instead
    // COMMITS its one primary diagnostic; the two lifecycle paths are distinct.
    const control = interruptSeam();
    let created = 0;
    // The scenario runs the genuinely successful workflow, so round 1 really
    // completes the `read` transition and round 2 really is the pending `edit`.
    // No round produces a terminal failure — only the interrupt stops the run.
    const base = scenarioAdapter(sequentialSuccess);
    const adapter: CollectivIQAdapter = {
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        // Fire the interrupt during round 2's processMessage (after the first
        // thread's round succeeded and this scenario's second thread exists).
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
    const report = executed(h.emitted);
    // No multi-scenario diagnostic was committed (scenario aborted mid-flight).
    for (const d of report.diagnostics.failures) expect(d.phase).toBe("single");
    // Nothing about case 201 (1-based) leaked into the checkpoint either.
    for (const [co] of h.store.data?.diagnosticFailures ?? []) {
      expect(co).toBeLessThanOrEqual(200);
    }
    // The scenario cursor did NOT advance past 200 (mid-scenario abort
    // restarts the whole scenario on resume).
    expect(report.completedMultiStepScenarios).toBe(0);
    expect(report.checkpoint.nextCaseIndex).toBe(200);
  });
});

describe("eval:tools — credential-before-network guard still holds on v5/v4 rejection", () => {
  it("blocks an invalid v4 checkpoint before any credential read or network call", async () => {
    // A v4 checkpoint whose diagnosticFailures references an uncommitted case
    // is semantically inconsistent and rejected by validateResumableCheckpoint
    // BEFORE any credential build.
    const forged = seedCheckpoint(5, {
      diagnosticFailures: [[6, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
    });
    const h = harness({ argv: resumeArgv, store: memCheckpointStore(forged) });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    expect((h.emitted[0] as BlockedReport).reason).toBe("checkpoint-inconsistent");
    expect(h.ledger.find((e) => e.startsWith("buildProvider:"))).toBeUndefined();
  });
});

describe("eval:tools — serialized report + checkpoint contain no live content", () => {
  it("neither report nor persisted checkpoint carries prompts, names, args, ids, or credentials", async () => {
    const h = harness({ argv: fullArgv, makeAdapter: () => sixMissAdapter() });
    await runToolsEval(h.deps);
    const report = executed(h.emitted);
    // Serialize the ENTIRE emitted stream + the on-disk checkpoint the run
    // would have persisted (via the memory store's captured last write, if any).
    const dumps: string[] = [JSON.stringify(h.emitted), JSON.stringify(report)];
    if (h.store.data !== null) dumps.push(JSON.stringify(h.store.data));
    const forbidden = [
      NAME_SENTINEL,
      "edit",
      "test",
      ARG_SENTINEL,
      PROMPT_SENTINEL,
      "synthetic/doc",
      // The state-aware scenario values a fake upstream now sends as arguments.
      "synthetic/module",
      SCENARIO_FINAL_CONTENT,
      "call_ciq_",
      CRED_SENTINEL,
      "gateway_protocol",
      "claude",
      "synthetic summary",
    ];
    for (const dump of dumps) {
      for (const sentinel of forbidden) expect(dump).not.toContain(sentinel);
    }
  });
});

describe("eval:tools — the final case never persists a complete resumable cursor", () => {
  /** Run the whole corpus, capturing every durable checkpoint write in order. */
  async function runCapturingWrites(): Promise<{
    readonly code: number;
    readonly emitted: EvalOutput[];
    readonly writes: CheckpointData[];
    readonly store: MemStore;
  }> {
    const store = memCheckpointStore();
    const writes: CheckpointData[] = [];
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      writes.push(d);
      realWrite(d);
    };
    const h = harness({ argv: fullArgv, store });
    const code = await runToolsEval(h.deps);
    return { code, emitted: h.emitted, writes, store };
  }

  it("never writes nextCaseIndex === corpus length, and every write its own validator accepts", async () => {
    const { writes } = await runCapturingWrites();
    const corpusLength = SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS;
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      // The invariant itself: a resumable cursor is always strictly inside.
      expect(write.resumeState).toBe("resumable");
      expect(write.nextCaseIndex).toBeLessThan(corpusLength);
      // Stronger: the runner's own validator must accept everything it durably
      // wrote, so a stop at ANY point leaves a resumable checkpoint.
      expect(() =>
        validateResumableCheckpoint(write, buildEvalCorpusProjection(buildEvalCases())),
      ).not.toThrow();
    }
  });

  it("leaves the last durable checkpoint pointing at the final, still-uncommitted case", async () => {
    const { writes } = await runCapturingWrites();
    const corpusLength = SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS;
    const last = writes[writes.length - 1];
    // Cursor 219 == "case 220 has not been committed", so an approved resume
    // replays exactly that one case.
    expect(last?.nextCaseIndex).toBe(corpusLength - 1);
    expect(last?.completedSingleRoundCases).toBe(SINGLE_ROUND_CASES);
    expect(last?.completedMultiStepScenarios).toBe(MULTI_STEP_SCENARIOS - 1);
    expect(last?.scenarioEvidence).toHaveLength(MULTI_STEP_SCENARIOS - 1);
  });

  it("emits no progress record for the final case, which persisted no checkpoint", async () => {
    const { emitted, writes } = await runCapturingWrites();
    const corpusLength = SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS;
    const scenarioEnd = progressEvents(emitted).filter(
      (p) => p.phase === "multi" && p.roundOrdinal === 4,
    );
    const ordinals = scenarioEnd.map((p) => p.caseOrdinal);
    expect(ordinals).not.toContain(corpusLength);
    // Every progress record claims a durable write, so there must be at least
    // as many writes as progress events — no record outruns the disk.
    expect(progressEvents(emitted).length).toBeLessThanOrEqual(writes.length);
    for (const p of progressEvents(emitted)) expect(p.checkpointPersisted).toBe(true);
  });

  it("still reports the in-memory COMPLETE cursor and removes the checkpoint on success", async () => {
    const { code, emitted, store } = await runCapturingWrites();
    const corpusLength = SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS;
    const report = executed(emitted);
    expect(code).toBe(0);
    expect(report.passed).toBe(true);
    // The cursor the REPORT carries is the complete one, even though it was
    // never persisted, and the checkpoint is gone.
    expect(report.checkpoint.nextCaseIndex).toBe(corpusLength);
    expect(report.checkpoint.finalized).toBe(true);
    expect(report.checkpoint.persistFailed).toBe(false);
    expect(report.completedSingleRoundCases).toBe(SINGLE_ROUND_CASES);
    expect(report.completedMultiStepScenarios).toBe(MULTI_STEP_SCENARIOS);
    expect(store.data).toBeNull();
    expect(store.deletes).toBe(1);
  });

  it("resumes from the last durable checkpoint by replaying ONLY the final case", async () => {
    const first = await runCapturingWrites();
    const last = first.writes[first.writes.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;

    // Simulate a stop between that durable write and the removal: hand the
    // exact bytes back to a fresh approved resume.
    const store = memCheckpointStore(last);
    const h = harness({ argv: resumeArgv, store });
    const code = await runToolsEval(h.deps);
    const report = executed(h.emitted);

    expect(code).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.checkpoint.resumed).toBe(true);
    expect(report.checkpoint.startCaseIndex).toBe(SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS - 1);
    // Exactly ONE case replayed: four upstream rounds on top of the committed
    // total, and no duplicated commit.
    expect(report.attemptedRounds).toBe((last.attemptedRounds ?? 0) + 4);
    expect(report.completedSingleRoundCases).toBe(SINGLE_ROUND_CASES);
    expect(report.completedMultiStepScenarios).toBe(MULTI_STEP_SCENARIOS);
    expect(report.gates.multiStepSuccess.denominator).toBe(MULTI_STEP_SCENARIOS);
    expect(report.gates.schemaValidity.denominator).toBe(260);
    // No duplicated diagnostics or evidence from the replay.
    expect(report.diagnostics.failures).toEqual([]);
    const keys = report.diagnostics.failures.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(store.data).toBeNull();
  });

  it("routes BOTH the single-round and multi-step commits through one shared guard", () => {
    // The production corpus always ends with a multi-step case, so the
    // single-round final-case layout cannot be exercised behaviorally through
    // the existing seams. Prove structurally that the branches cannot drift:
    // exactly one guard exists and both commits go through it.
    const source = readFileSync(
      new URL("../../src/eval/tools-eval-cli.ts", import.meta.url),
      "utf8",
    );
    // Exactly one PERSIST guard (the `scoredComplete` computation reads the
    // same cursor for a different purpose and is matched more narrowly here).
    const guards = source.match(/if \(nextCaseIndex >= cases\.length\) return null;/g) ?? [];
    expect(guards).toHaveLength(1);
    const calls = source.match(/commitCaseCursor\(i, "(single|multi)"/g) ?? [];
    expect(calls.sort()).toEqual(['commitCaseCursor(i, "multi"', 'commitCaseCursor(i, "single"']);
    // Neither branch may advance the cursor or persist on its own any more.
    expect(source).not.toMatch(/\n\s*nextCaseIndex = i \+ 1;/);
  });
});
