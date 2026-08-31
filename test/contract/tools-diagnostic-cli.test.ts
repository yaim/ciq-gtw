/**
 * Hermetic tests for the approval-gated live MULTI-STEP TRANSITION DIAGNOSTIC
 * (`npm run eval:tools:diagnose`).
 *
 * Every collaborator is injected: a fake transport (smart in-memory adapters),
 * fake credentials, a recording in-memory recovery journal, an in-memory
 * diagnostic checkpoint store, and a controllable interruption seam. NO real
 * network, NO real credential, and the fixed production origin is never
 * contacted. Every prompt, tool name, and scenario value is synthetic.
 *
 * The suite also covers the SHARED `live-round.ts` lifecycle extracted from the
 * release evaluator, and asserts that the release evaluator's own report and
 * checkpoint contracts are unchanged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildDiagnosticPreflightReport,
  defaultToolsDiagnosticDeps,
  parseDiagnosticArgs,
  runToolsDiagnostic,
  DIAGNOSTIC_ORIGIN,
  MAX_DIAGNOSTIC_UPSTREAM_ROUNDS,
  type DiagnosticBuiltProvider,
  type DiagnosticCheckpointStore,
  type ToolsDiagnosticDeps,
} from "../../src/eval/tools-diagnostic-cli.js";
import {
  classifyAllowedCallRelation,
  transitionDiagnosticDimensionErrors,
  DIAGNOSTIC_PROFILE,
  DIAGNOSTIC_REPORT_VERSION,
  type AllowedCallRelation,
  type DiagnosticExecutedReport,
  type DiagnosticOutput,
  type DiagnosticPreflightReport,
  type DiagnosticProgressEvent,
} from "../../src/eval/diagnostic-report.js";
import {
  buildDiagnosticCorpusProjection,
  selectDiagnosticScenarios,
  validateResumableDiagnosticCheckpoint,
  DIAGNOSTIC_CHECKPOINT_FILENAME,
  DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
  type DiagnosticCheckpointData,
  type DiagnosticScenarioEvidence,
} from "../../src/eval/diagnostic-checkpoint.js";
import {
  MIN_SUCCESSFUL_SCENARIO_ROUNDS,
  SCENARIO_STEP_COUNT,
} from "../../src/eval/scenario-engine.js";
import { runLiveRound, buildRoundRequest } from "../../src/eval/live-round.js";
import { buildEvalCases, corpusFingerprint } from "../../src/eval/cases.js";
import { EVAL_REPORT_VERSION } from "../../src/eval/report.js";
import { CHECKPOINT_FILENAME, CHECKPOINT_FORMAT_VERSION } from "../../src/eval/checkpoint.js";
import { EVAL_ORIGIN } from "../../src/eval/tools-eval-cli.js";
import type {
  CollectivIQAdapter,
  CollectivIQCredentialProvider,
  UpstreamMessage,
} from "../../src/collectiviq/types.js";
import type { DeleteDiagnostics } from "../../src/collectiviq/cleanup.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import type { RecoveryJournalSink } from "../../src/collectiviq/recovery-journal.js";
import type { Poller } from "../../src/generation/types.js";

const CRED_SENTINEL = "SECRET-DIAGNOSTIC-PASSWORD-4a7e";
const OK: DeleteDiagnostics = { ok: true, status: 200, errorCode: null };

/** Synthetic tool names; the corpus's toolset is exactly these three. */
const READ = "read";
const EDIT = "edit";
const TEST = "test";

const SCENARIO_COUNT = 20;
const ROUNDS_PER_SCENARIO = 4;
const FIRST_ORDINAL = 201;
const LAST_ORDINAL = 220;

/**
 * Count the assistant `tool_calls` messages already in the serialized envelope.
 * The agent loop accumulates history through prior assistant tool_calls + linked
 * tool results, so the count names the current round: 0 → round 1, 1 → round 2,
 * 2 → round 3, 3 → round 4 (final).
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
 * The synthetic replacement text the corpus's `edit` step must write. The
 * shared transition engine only ADVANCES a step when the call's arguments match
 * the scenario's own synthetic state, so the fake model has to use the real
 * path and text rather than a placeholder.
 */
const EXPECTED_FINAL_CONTENT = "version=2";

/** Recover a scenario's synthetic document path from its initial user message. */
function scenarioPath(prompt: string): string {
  return /synthetic\/module-\d+\.txt/.exec(prompt)?.[0] ?? "synthetic/unknown.txt";
}

function toolCallsEnvelope(calls: { name: string; arguments: unknown }[]): string {
  return JSON.stringify({ gateway_protocol: "1.0", type: "tool_calls", calls });
}
function finalEnvelope(content: string): string {
  return JSON.stringify({ gateway_protocol: "1.0", type: "final", content });
}
function argsFor(name: string, path: string): unknown {
  if (name === READ) return { path };
  if (name === EDIT) return { path, text: EXPECTED_FINAL_CONTENT };
  return {};
}

/** One round's upstream answer, built from the scenario's synthetic path. */
type RoundAnswer = (path: string) => string;

/** Propose the named tools with arguments the transition engine accepts. */
function callsFor(...names: readonly string[]): RoundAnswer {
  return (path) =>
    toolCallsEnvelope(names.map((name) => ({ name, arguments: argsFor(name, path) })));
}

/** Return one fixed upstream answer regardless of the scenario. */
function raw(content: string): RoundAnswer {
  return () => content;
}

/**
 * A schema-valid `edit` whose arguments do NOT match the scenario's synthetic
 * state. The expected tool IS invoked, so the round is accepted, but the
 * transition never completes and the workflow does not advance.
 */
const UNPRODUCTIVE_EDIT: RoundAnswer = raw(
  toolCallsEnvelope([{ name: EDIT, arguments: { path: "synthetic/other.txt", text: "x" } }]),
);

/** The successful sequential loop answer for a round, keyed by prior tool-call count. */
function successEnvelope(prior: number, path: string): string {
  if (prior === 0) return toolCallsEnvelope([{ name: READ, arguments: argsFor(READ, path) }]);
  if (prior === 1) return toolCallsEnvelope([{ name: EDIT, arguments: argsFor(EDIT, path) }]);
  if (prior === 2) return toolCallsEnvelope([{ name: TEST, arguments: argsFor(TEST, path) }]);
  return finalEnvelope("synthetic summary");
}

interface AdapterOptions {
  /**
   * Answer override for round 1. Used to model PARALLEL tool calls, which the
   * round request enables: one accepted round can COMPLETE several transitions,
   * so the scenario's satisfied state diverges from the static plan.
   */
  readonly round1?: RoundAnswer;
  /** Answer override for round 2 (the read → edit transition). */
  readonly round2?: RoundAnswer;
  /** Answer override for round 3 (the final answer after a parallel batch). */
  readonly round3?: RoundAnswer;
  /** Answer override for round 4 (the last round of the scenario's budget). */
  readonly round4?: RoundAnswer;
  /**
   * When set, round 2's messages place the valid envelope on NON-desired
   * individual sources (the desired `claude` message is unparsable prose), so the
   * selector must reach individual-source consensus.
   */
  readonly round2Individuals?: readonly string[];
}

interface CountingAdapter extends CollectivIQAdapter {
  readonly counts: { creates: number; submits: number; polls: number };
  readonly prompts: string[];
  readonly deletedPerThread: Map<string, number>;
}

/**
 * A smart in-memory adapter that drives the synthetic read → edit → test → final
 * loop and can inject a specific round-2 outcome.
 */
function smartAdapter(opts: AdapterOptions = {}): CountingAdapter {
  const counts = { creates: 0, submits: 0, polls: 0 };
  const prompts: string[] = [];
  const deletedPerThread = new Map<string, number>();
  let lastPrompt = "";
  return {
    counts,
    prompts,
    deletedPerThread,
    createThread: () => {
      counts.creates += 1;
      return Promise.resolve({ threadId: `t${counts.creates}`, rawStatus: 200 });
    },
    processMessage: (input) => {
      counts.submits += 1;
      lastPrompt = input.prompt;
      prompts.push(input.prompt);
      return Promise.resolve({ accepted: true, rawStatus: 202 });
    },
    getMessages: () => {
      counts.polls += 1;
      const prior = priorAssistantToolCallCount(lastPrompt);
      const path = scenarioPath(lastPrompt);
      const isRound2 = prior === 1;
      const override = [opts.round1, opts.round2, opts.round3, opts.round4][prior];
      const envelope = override?.(path) ?? successEnvelope(prior, path);
      const messages: UpstreamMessage[] = [];
      if (isRound2 && opts.round2Individuals !== undefined) {
        // The desired (`claude`) candidate is unparsable prose, so selection must
        // fall through to individual-source voting.
        messages.push({
          source: "claude",
          content: "ordinary prose with no protocol envelope",
          percentUsage: null,
          createdAt: 1,
          id: 1,
        });
        let id = 2;
        for (const source of opts.round2Individuals) {
          messages.push({ source, content: envelope, percentUsage: null, createdAt: 1, id });
          id += 1;
        }
      } else {
        messages.push({
          source: "claude",
          content: envelope,
          percentUsage: null,
          createdAt: 1,
          id: 1,
        });
      }
      return Promise.resolve({ messages, rawStatus: 200 });
    },
    getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
  };
}

/** A recording in-memory journal (ID-only) appending lifecycle events to a ledger. */
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

/** An in-memory diagnostic checkpoint store recording writes/reads/deletes. */
interface MemStore extends DiagnosticCheckpointStore {
  data: DiagnosticCheckpointData | null;
  reads: number;
  existsCalls: number;
  writes: number;
  deletes: number;
  failWrite: boolean;
  failRead: boolean;
}
function memStore(initial: DiagnosticCheckpointData | null = null): MemStore {
  const store: MemStore = {
    data: initial,
    reads: 0,
    existsCalls: 0,
    writes: 0,
    deletes: 0,
    failWrite: false,
    failRead: false,
    read: () => {
      store.reads += 1;
      if (store.failRead) throw new Error("checkpoint read fail");
      return store.data;
    },
    exists: () => {
      store.existsCalls += 1;
      return store.data !== null;
    },
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
  removed: boolean;
  seam: ToolsDiagnosticDeps["installInterruptHandler"];
}
function interruptSeam(): InterruptControl {
  let cb: (() => void) | null = null;
  const control: InterruptControl = {
    removed: false,
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
  readonly deps: ToolsDiagnosticDeps;
  readonly emitted: DiagnosticOutput[];
  readonly ledger: string[];
  readonly journal: RecoveryJournalSink & { owned: Set<string> };
  readonly store: MemStore;
  readonly interrupt: InterruptControl;
  readonly providerCalls: () => number;
}

function harness(over: {
  argv: readonly string[];
  deleteThread?: ToolsDiagnosticDeps["deleteThread"];
  makeAdapter?: () => CollectivIQAdapter;
  journal?: RecoveryJournalSink & { owned: Set<string> };
  store?: MemStore;
  interrupt?: InterruptControl;
  authObservation?: DiagnosticBuiltProvider["authObservation"];
}): Harness {
  const emitted: DiagnosticOutput[] = [];
  const ledger: string[] = [];
  const journal = over.journal ?? recordingJournal(ledger);
  const store = over.store ?? memStore();
  const interrupt = over.interrupt ?? interruptSeam();
  let providerCalls = 0;
  const deps: ToolsDiagnosticDeps = {
    argv: over.argv,
    env: {
      COLLECTIVIQ_AUTH_MODE: "password",
      COLLECTIVIQ_USERNAME: "u",
      COLLECTIVIQ_PASSWORD: CRED_SENTINEL,
    },
    buildProvider: (env, base) => {
      providerCalls += 1;
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
    },
    makeAdapter: over.makeAdapter ?? (() => smartAdapter()),
    deleteThread: over.deleteThread ?? (() => Promise.resolve(OK)),
    makeJournal: () => journal,
    makeCheckpointStore: () => store,
    installInterruptHandler: interrupt.seam,
    emit: (output) => emitted.push(output),
  };
  return { deps, emitted, ledger, journal, store, interrupt, providerCalls: () => providerCalls };
}

const fullArgv = [
  "--execute-approved",
  "--cost-approved",
  "--cleanup-approved",
  "--recovery-journal-approved",
];
const resumeArgv = [...fullArgv, "--resume-approved"];

function executed(emitted: DiagnosticOutput[]): DiagnosticExecutedReport {
  const report = emitted.find((r) => r.mode === "executed");
  if (report === undefined) throw new Error("no executed diagnostic report emitted");
  return report;
}
function progressEvents(emitted: DiagnosticOutput[]): DiagnosticProgressEvent[] {
  return emitted.filter((r): r is DiagnosticProgressEvent => r.mode === "progress");
}

/**
 * A truthful all-successful resumable diagnostic checkpoint at scenario cursor
 * `k`: every committed scenario ran its whole round budget and completed all
 * three transitions (format 3's `[executedRounds, satisfiedSteps]` evidence).
 */
function seed(k: number, over: Partial<DiagnosticCheckpointData> = {}): DiagnosticCheckpointData {
  const rounds = ROUNDS_PER_SCENARIO * k;
  return {
    formatVersion: DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
    origin: DIAGNOSTIC_ORIGIN,
    authMode: "password",
    profile: DIAGNOSTIC_PROFILE,
    corpusFingerprint: corpusFingerprint(),
    resumeState: "resumable",
    abort: null,
    nextScenarioIndex: k,
    runSegments: 1,
    attemptedRounds: rounds,
    completedRounds: rounds,
    completedScenarios: k,
    successfulScenarios: k,
    cleanup: { attempted: rounds, deleted: rounds, failed: 0, journalFailures: 0 },
    scenarioEvidence: Array.from(
      { length: k },
      () => [ROUNDS_PER_SCENARIO, SCENARIO_STEP_COUNT] as DiagnosticScenarioEvidence,
    ),
    diagnostics: [],
    ...over,
  };
}

describe("eval:tools:diagnose — argument parsing", () => {
  it("rejects every unknown argument", () => {
    expect(() => parseDiagnosticArgs(["--go-live"])).toThrow();
    expect(() => parseDiagnosticArgs(["--execute-approved", "--oops"])).toThrow();
    expect(() => parseDiagnosticArgs([""])).toThrow();
    expect(() => parseDiagnosticArgs(["-e"])).toThrow();
    expect(() => parseDiagnosticArgs(["--execute-approved=true"])).toThrow();
  });

  it("parses exactly the closed flag set", () => {
    expect(parseDiagnosticArgs([])).toEqual({
      executeApproved: false,
      costApproved: false,
      cleanupApproved: false,
      recoveryJournalApproved: false,
      resumeApproved: false,
    });
    expect(parseDiagnosticArgs(resumeArgv)).toEqual({
      executeApproved: true,
      costApproved: true,
      cleanupApproved: true,
      recoveryJournalApproved: true,
      resumeApproved: true,
    });
  });
});

describe("eval:tools:diagnose — default preflight", () => {
  it("reports the fixed plan without any credential, journal, checkpoint, or socket", async () => {
    const h = harness({ argv: [] });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(0);
    expect(h.emitted).toHaveLength(1);
    const report = h.emitted[0] as DiagnosticPreflightReport;
    expect(report).toMatchObject({
      version: DIAGNOSTIC_REPORT_VERSION,
      mode: "preflight",
      profile: DIAGNOSTIC_PROFILE,
      origin: DIAGNOSTIC_ORIGIN,
      authMode: "password",
      plannedScenarios: SCENARIO_COUNT,
      globalOrdinalRange: { first: FIRST_ORDINAL, last: LAST_ORDINAL },
      plannedUpstreamRounds: MAX_DIAGNOSTIC_UPSTREAM_ROUNDS,
      approvalsGiven: [],
      resumeApproved: false,
    });
    expect(report.approvalsRequired).toEqual([
      "--execute-approved",
      "--cost-approved",
      "--cleanup-approved",
      "--recovery-journal-approved",
    ]);
    // No credential read, no journal init, no checkpoint access.
    expect(h.providerCalls()).toBe(0);
    expect(h.ledger).toEqual([]);
    expect(h.store.existsCalls).toBe(0);
    expect(h.store.reads).toBe(0);
    expect(h.store.writes).toBe(0);
    expect(h.store.deletes).toBe(0);
    expect(JSON.stringify(h.emitted)).not.toContain(CRED_SENTINEL);
  });

  it("reports supplied approvals and a resume flag without executing", async () => {
    const h = harness({ argv: ["--cost-approved", "--resume-approved"] });
    await runToolsDiagnostic(h.deps);
    const report = h.emitted[0] as DiagnosticPreflightReport;
    expect(report.approvalsGiven).toEqual(["--cost-approved", "--resume-approved"]);
    expect(report.resumeApproved).toBe(true);
    expect(h.providerCalls()).toBe(0);
  });

  it("derives the plan from the corpus, not from hardcoded numbers", () => {
    const scenarios = selectDiagnosticScenarios(buildEvalCases());
    const projection = buildDiagnosticCorpusProjection(scenarios);
    const report = buildDiagnosticPreflightReport(parseDiagnosticArgs([]));
    expect(report.plannedScenarios).toBe(scenarios.length);
    expect(report.plannedUpstreamRounds).toBe(projection.plannedUpstreamRounds);
    expect(report.globalOrdinalRange).toEqual({
      first: scenarios[0]?.caseOrdinal,
      last: scenarios[scenarios.length - 1]?.caseOrdinal,
    });
  });
});

describe("eval:tools:diagnose — approval gating", () => {
  it("rejects partial approvals without reading a credential or touching the journal", async () => {
    const partials = [
      ["--execute-approved"],
      ["--execute-approved", "--cost-approved"],
      ["--execute-approved", "--cost-approved", "--cleanup-approved"],
      ["--execute-approved", "--cleanup-approved", "--recovery-journal-approved"],
    ];
    for (const argv of partials) {
      const h = harness({ argv });
      await expect(runToolsDiagnostic(h.deps)).rejects.toThrow();
      expect(h.providerCalls()).toBe(0);
      expect(h.ledger).toEqual([]);
      expect(h.store.writes).toBe(0);
      expect(h.emitted).toEqual([]);
    }
  });
});

describe("eval:tools:diagnose — bounded multi-step-only execution", () => {
  it("runs exactly the 20 multi-step scenarios at ordinals 201–220 and no single-round case", async () => {
    const adapter = smartAdapter();
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.plannedScenarios).toBe(SCENARIO_COUNT);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    expect(report.successfulScenarios).toBe(SCENARIO_COUNT);
    expect(report.attemptedRounds).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(report.completedRounds).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(report.completed).toBe(true);
    expect(report.aborted).toBeNull();
    expect(report.diagnostics.failures).toEqual([]);
    // Exactly one create + one submit per round; never more (no POST retry).
    expect(adapter.counts.creates).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(adapter.counts.submits).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    // Every scenario ordinal is inside the multi-step slice.
    const ordinals = new Set(progressEvents(h.emitted).map((p) => p.caseOrdinal));
    for (const ordinal of ordinals) {
      expect(ordinal).toBeGreaterThanOrEqual(FIRST_ORDINAL);
      expect(ordinal).toBeLessThanOrEqual(LAST_ORDINAL);
    }
    expect(ordinals.size).toBe(SCENARIO_COUNT);
    // No single-round prompt was ever submitted.
    for (const prompt of adapter.prompts) {
      expect(prompt).not.toContain("Synthetic single-round task");
      expect(prompt).toContain("Synthetic multi-step scenario");
    }
  });

  it("never exceeds the 80-round upper bound", async () => {
    const adapter = smartAdapter();
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    await runToolsDiagnostic(h.deps);
    expect(executed(h.emitted).attemptedRounds).toBeLessThanOrEqual(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(adapter.counts.creates).toBeLessThanOrEqual(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
  });

  it("deletes every created thread exactly once and leaves nothing owned", async () => {
    const perThread = new Map<string, number>();
    const h = harness({
      argv: fullArgv,
      deleteThread: (_b, _p, threadId) => {
        perThread.set(threadId, (perThread.get(threadId) ?? 0) + 1);
        return Promise.resolve(OK);
      },
    });
    await runToolsDiagnostic(h.deps);
    const report = executed(h.emitted);
    expect(perThread.size).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect([...perThread.values()].every((n) => n === 1)).toBe(true);
    expect(report.cleanup).toEqual({
      attempted: MAX_DIAGNOSTIC_UPSTREAM_ROUNDS,
      deleted: MAX_DIAGNOSTIC_UPSTREAM_ROUNDS,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
    expect(h.journal.owned.size).toBe(0);
  });

  it("writes only RESUMABLE checkpoints that its OWN validator accepts", async () => {
    // Every durable write at a resumable cursor must be self-consistent: if the
    // process died right after it, an approved resume must not reject the file
    // the run just wrote. This pins counter/cursor agreement at every
    // persistence point (anchor, mid-scenario, and scenario commit).
    //
    // There is NO exception: a complete-corpus cursor is never written as
    // resumable, because the final scenario's commit is deliberately kept in
    // memory and disposed of by finalization instead.
    const projection = buildDiagnosticCorpusProjection(selectDiagnosticScenarios(buildEvalCases()));

    async function auditWrites(over: AdapterOptions): Promise<{
      rejected: string[];
      completeCursorWrites: number;
      resumableWrites: number;
      store: MemStore;
    }> {
      const store = memStore();
      const realWrite = store.write.bind(store);
      const rejected: string[] = [];
      let completeCursorWrites = 0;
      let resumableWrites = 0;
      store.write = (d) => {
        if (d.resumeState === "resumable") {
          resumableWrites += 1;
          if (d.nextScenarioIndex >= SCENARIO_COUNT) completeCursorWrites += 1;
          try {
            validateResumableDiagnosticCheckpoint(d, projection);
          } catch (error) {
            rejected.push(
              `cursor=${d.nextScenarioIndex} attempted=${d.attemptedRounds} completed=${d.completedRounds}: ${(error as Error).message}`,
            );
          }
        }
        realWrite(d);
      };
      const h = harness({ argv: fullArgv, store, makeAdapter: () => smartAdapter(over) });
      expect(await runToolsDiagnostic(h.deps)).toBe(0);
      return { rejected, completeCursorWrites, resumableWrites, store };
    }

    // A fully successful corpus (evidence entries of `[4, 3]`), one where every
    // scenario terminates early at round 2 (`[2, 1]`), and one where a parallel
    // `[read, edit]` batch finishes each scenario in three rounds (`[3, 3]`).
    for (const over of [
      {},
      { round2: callsFor(READ) },
      { round1: callsFor(READ, EDIT), round2: callsFor(TEST), round3: raw(finalEnvelope("ok")) },
    ]) {
      const audit = await auditWrites(over);
      expect(audit.rejected).toEqual([]);
      expect(audit.resumableWrites).toBeGreaterThan(SCENARIO_COUNT);
      // NO resumable write may encode a complete corpus.
      expect(audit.completeCursorWrites).toBe(0);
      expect(audit.store.data).toBeNull();
      expect(audit.store.deletes).toBe(1);
    }
  });

  it("leaves the last durable checkpoint at the final scenario, never the complete cursor", async () => {
    // The crash window this remediation closes: if the process stops between the
    // final scenario's commit and the successful checkpoint removal, the file on
    // disk must still be one an approved resume accepts.
    const projection = buildDiagnosticCorpusProjection(selectDiagnosticScenarios(buildEvalCases()));
    const store = memStore();
    // A holder, so the closure assignment is visible to the type checker.
    const preDelete: { value: DiagnosticCheckpointData | null } = { value: null };
    store.delete = () => {
      preDelete.value = store.data;
      throw new Error("finalize failed");
    };
    const h = harness({ argv: fullArgv, store });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);

    const captured = preDelete.value;
    expect(captured).not.toBeNull();
    // The PRIOR valid cursor — the final scenario is still uncommitted on disk.
    expect(captured?.nextScenarioIndex).toBe(SCENARIO_COUNT - 1);
    expect(captured?.completedScenarios).toBe(SCENARIO_COUNT - 1);
    expect(captured?.resumeState).toBe("resumable");
    expect(captured?.nextScenarioIndex).not.toBe(SCENARIO_COUNT);
    expect(() =>
      validateResumableDiagnosticCheckpoint(captured as DiagnosticCheckpointData, projection),
    ).not.toThrow();

    // The failed finalization is surfaced truthfully and blocks a later resume.
    const report = executed(h.emitted);
    expect(report.checkpoint.persistFailed).toBe(true);
    expect(report.checkpoint.finalized).toBe(false);
    expect(report.completed).toBe(false);
    expect(store.data?.resumeState).toBe("blocked");
  });

  it("replays ONLY the final scenario when a resume starts from that last durable checkpoint", async () => {
    // Segment 1 runs the whole corpus. Its LAST durable resumable write is the
    // final scenario's mid-scenario per-round persist (which keeps cleanup
    // counters durable) — still at cursor 19, because the final scenario's commit
    // is deliberately never persisted. Either way the final scenario is the only
    // uncommitted one, so a resume replays exactly it.
    const store = memStore();
    const lastResumable: { value: DiagnosticCheckpointData | null } = { value: null };
    const realWrite = store.write.bind(store);
    store.write = (d) => {
      if (d.resumeState === "resumable") lastResumable.value = d;
      realWrite(d);
    };
    const first = harness({
      argv: fullArgv,
      store,
      makeAdapter: () => smartAdapter({ round2: callsFor(READ) }),
    });
    expect(await runToolsDiagnostic(first.deps)).toBe(0);
    const firstReport = executed(first.emitted);
    expect(firstReport.completedScenarios).toBe(SCENARIO_COUNT);
    expect(firstReport.diagnostics.failures).toHaveLength(SCENARIO_COUNT);

    const durable = lastResumable.value;
    expect(durable).not.toBeNull();
    expect(durable?.nextScenarioIndex).toBe(SCENARIO_COUNT - 1);
    expect(durable?.completedScenarios).toBe(SCENARIO_COUNT - 1);
    expect(durable?.diagnostics).toHaveLength(SCENARIO_COUNT - 1);
    const durableAttempted = durable?.attemptedRounds ?? 0;

    // Resume from exactly that file, as an interrupted run would.
    const adapter = smartAdapter({
      round2: callsFor(READ),
    });
    const resumeStore = memStore(durable);
    const second = harness({ argv: resumeArgv, store: resumeStore, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(second.deps)).toBe(0);
    const report = executed(second.emitted);

    // EXACTLY the final scenario replayed: 2 upstream rounds this segment, on top
    // of whatever the durable checkpoint had already accounted for.
    expect(adapter.counts.creates).toBe(2);
    expect(report.checkpoint.startScenarioIndex).toBe(SCENARIO_COUNT - 1);
    expect(report.checkpoint.runSegments).toBe(2);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    expect(report.attemptedRounds).toBe(durableAttempted + 2);
    // No duplicate committed diagnostics across the two segments.
    const keys = report.diagnostics.failures.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`);
    expect(keys).toHaveLength(SCENARIO_COUNT);
    expect(new Set(keys).size).toBe(SCENARIO_COUNT);
    // Cleanup accounting stays truthful (every counted attempt was deleted) and
    // the checkpoint is finally removed.
    expect(report.cleanup).toEqual({
      attempted: durableAttempted + 2,
      deleted: durableAttempted + 2,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
    expect(report.completed).toBe(true);
    expect(resumeStore.data).toBeNull();
  });

  it("initializes the journal BEFORE reading any credential and finalizes it once", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsDiagnostic(h.deps);
    expect(h.ledger[0]).toBe("journal.init");
    expect(h.ledger[1]).toBe(`buildProvider:${DIAGNOSTIC_ORIGIN}`);
    expect(h.ledger.filter((e) => e === "journal.finalize")).toHaveLength(1);
    expect(h.interrupt.removed).toBe(true);
  });
});

describe("eval:tools:diagnose — transition classification", () => {
  /**
   * Run the whole diagnostic against a fixed round-2 outcome and return the
   * first committed diagnostic (all 20 scenarios fail identically).
   */
  async function diagnoseRound2(opts: AdapterOptions): Promise<DiagnosticExecutedReport> {
    const h = harness({ argv: fullArgv, makeAdapter: () => smartAdapter(opts) });
    const code = await runToolsDiagnostic(h.deps);
    // Every scenario terminated at round 2, but the DIAGNOSTIC itself completed.
    expect(code).toBe(0);
    return executed(h.emitted);
  }

  it("classifies a repeated prior tool as prior-only, single, desired-source", async () => {
    const report = await diagnoseRound2({
      round2: callsFor(READ),
    });
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
    for (const d of report.diagnostics.failures) {
      expect(d).toMatchObject({
        roundOrdinal: 2,
        choiceKind: "auto",
        reason: "expected-tool-not-invoked",
        allowedCallRelation: "prior-only",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      });
      expect(d.caseOrdinal).toBeGreaterThanOrEqual(FIRST_ORDINAL);
      expect(d.caseOrdinal).toBeLessThanOrEqual(LAST_ORDINAL);
    }
    // Truthful early termination: 2 rounds per scenario, not 4.
    expect(report.attemptedRounds).toBe(SCENARIO_COUNT * 2);
    expect(report.successfulScenarios).toBe(0);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    expect(report.completed).toBe(true);
    // A MODEL-terminal failure still cleans its thread: every attempted round's
    // thread was created and confirmed deleted before the scenario terminated.
    expect(report.cleanup).toEqual({
      attempted: SCENARIO_COUNT * 2,
      deleted: SCENARIO_COUNT * 2,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
  });

  it("classifies a skipped-ahead tool as future-only", async () => {
    const report = await diagnoseRound2({
      round2: callsFor(TEST),
    });
    expect(report.diagnostics.failures[0]).toMatchObject({
      reason: "expected-tool-not-invoked",
      allowedCallRelation: "future-only",
      callMultiplicity: "single",
    });
  });

  it("classifies a prior+future mixture as prior-and-future with multiple calls", async () => {
    const report = await diagnoseRound2({ round2: callsFor(READ, TEST) });
    expect(report.diagnostics.failures[0]).toMatchObject({
      reason: "expected-tool-not-invoked",
      allowedCallRelation: "prior-and-future",
      callMultiplicity: "multiple",
    });
  });

  it("carries individual-single from the trusted selector", async () => {
    const report = await diagnoseRound2({
      round2: callsFor(READ),
      round2Individuals: ["alt-a"],
    });
    expect(report.diagnostics.failures[0]).toMatchObject({
      allowedCallRelation: "prior-only",
      selectionSource: "individual-single",
    });
  });

  it("carries individual-consensus from the trusted selector", async () => {
    const report = await diagnoseRound2({
      round2: callsFor(READ),
      round2Individuals: ["alt-a", "alt-b"],
    });
    expect(report.diagnostics.failures[0]).toMatchObject({
      allowedCallRelation: "prior-only",
      selectionSource: "individual-consensus",
    });
  });

  it("uses not-applicable dimensions when the round returned ordinary text", async () => {
    const report = await diagnoseRound2({ round2: raw(finalEnvelope("I will stop here.")) });
    expect(report.diagnostics.failures[0]).toMatchObject({
      reason: "expected-tool-returned-text",
      allowedCallRelation: "not-applicable",
      selectionSource: "not-applicable",
      callMultiplicity: "not-applicable",
    });
  });

  it("uses not-applicable dimensions when no valid call could be selected", async () => {
    // Neither the desired candidate nor any individual parses, and the round's
    // choice is `auto`, so selection falls back to ordinary text.
    const report = await diagnoseRound2({ round2: raw("not an envelope at all") });
    expect(report.diagnostics.failures[0]?.allowedCallRelation).toBe("not-applicable");
    expect(report.diagnostics.failures[0]?.selectionSource).toBe("not-applicable");
    expect(report.diagnostics.failures[0]?.callMultiplicity).toBe("not-applicable");
  });

  it("completes a [read, edit] parallel batch, then test, then final text with NO diagnostic", async () => {
    // THE HEADLINE FIX, and the exact shape 13 of 20 live scenarios took.
    // Round 1 returns [read, edit] in ONE accepted assistant message and BOTH
    // transitions complete, so round 2 correctly runs `test` and round 3
    // returns the final answer. The old positional schedule scored round 2
    // against a stale `edit` expectation and recorded
    // `expected-tool-not-invoked` (relation `expected-already-invoked`) for a
    // scenario that had in fact done everything right. State-aware scoring
    // records NOTHING: the scenario simply succeeded, in three rounds.
    const report = await diagnoseRound2({
      round1: callsFor(READ, EDIT),
      round2: callsFor(TEST),
      round3: raw(finalEnvelope("synthetic summary")),
    });
    expect(report.diagnostics.failures).toEqual([]);
    expect(report.successfulScenarios).toBe(SCENARIO_COUNT);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    // Three rounds per scenario — fewer than the four-round budget, which is
    // only possible because a parallel batch completed two transitions at once.
    expect(report.attemptedRounds).toBe(SCENARIO_COUNT * 3);
    expect(report.attemptedRounds).toBeLessThan(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(report.attemptedRounds / SCENARIO_COUNT).toBeGreaterThanOrEqual(
      MIN_SUCCESSFUL_SCENARIO_ROUNDS,
    );
    expect(report.completed).toBe(true);
    expect(report.aborted).toBeNull();
    expect(report.cleanup).toEqual({
      attempted: SCENARIO_COUNT * 3,
      deleted: SCENARIO_COUNT * 3,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
  });

  it("never expects a transition an accepted parallel batch already completed", async () => {
    // The complement of the case above: after [read, edit] the expectation is
    // `test`, so a round that REPEATS `edit` is judged against the state the
    // batch produced — finished work — rather than being excused as a stale
    // expectation. The removed v2 member has no successor here.
    const report = await diagnoseRound2({
      round1: callsFor(READ, EDIT),
      round2: callsFor(EDIT),
    });
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
    for (const d of report.diagnostics.failures) {
      expect(d.roundOrdinal).toBe(2);
      // The reason is whatever the RELEASE classifier produces — unchanged.
      expect(d.reason).toBe("expected-tool-not-invoked");
      expect(d.allowedCallRelation).toBe("prior-only");
      expect(d.allowedCallRelation).not.toBe("future-only");
    }
  });

  it("judges prior by SUCCESSFUL transitions, not by names that merely ran", async () => {
    // Round 1 returns [read, test]: `read` completes, but `test` runs before its
    // `edit` prerequisite, so its transition FAILS and the workflow does not
    // advance past `read`. Round 2 repeating `test` is therefore still a genuine
    // skip-ahead — v2, which bucketed by invocation history, called it
    // `prior-only` and hid the real behavior.
    const report = await diagnoseRound2({
      round1: callsFor(READ, TEST),
      round2: callsFor(TEST),
    });
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
    for (const d of report.diagnostics.failures) {
      expect(d.reason).toBe("expected-tool-not-invoked");
      expect(d.allowedCallRelation).toBe("future-only");
      expect(d.allowedCallRelation).not.toBe("prior-only");
    }
  });

  it("keeps a failed edit pending instead of promoting it to prior", async () => {
    // Round 1 completes `read`; round 2 calls `edit` with the WRONG text, so the
    // call is accepted (the expected tool WAS invoked) but the transition does
    // not advance. Round 3 then skips to `test` while `edit` is still the
    // pending expectation.
    const report = await diagnoseRound2({
      round2: UNPRODUCTIVE_EDIT,
      round3: callsFor(TEST),
    });
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
    for (const d of report.diagnostics.failures) {
      // The scenario ran a third round: round 2 was accepted, just unproductive.
      expect(d.roundOrdinal).toBe(3);
      expect(d.reason).toBe("expected-tool-not-invoked");
      expect(d.allowedCallRelation).toBe("future-only");
    }
    expect(report.attemptedRounds).toBe(SCENARIO_COUNT * 3);
    expect(report.successfulScenarios).toBe(0);
  });

  it("emits exactly one budget-exhausted diagnostic when the loop never finishes", async () => {
    // Every round after the first repeats an accepted-but-unproductive `edit`:
    // the expected tool IS invoked, so no round fails terminally, yet the
    // workflow never advances and the scenario burns its whole four-round budget
    // without a final answer. That is a WHOLE-SCENARIO failure, recorded once,
    // at the last executed round, with all three dimensions not-applicable.
    const report = await diagnoseRound2({
      round2: UNPRODUCTIVE_EDIT,
      round3: UNPRODUCTIVE_EDIT,
      round4: UNPRODUCTIVE_EDIT,
    });
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
    for (const d of report.diagnostics.failures) {
      expect(d).toMatchObject({
        roundOrdinal: ROUNDS_PER_SCENARIO,
        reason: "scenario-round-budget-exhausted",
        allowedCallRelation: "not-applicable",
        selectionSource: "not-applicable",
        callMultiplicity: "not-applicable",
      });
      expect(transitionDiagnosticDimensionErrors(d)).toEqual([]);
    }
    expect(report.attemptedRounds).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(report.successfulScenarios).toBe(0);
    expect(report.completed).toBe(true);
  });

  it("still reports a GENUINE skip-ahead as future-only after an ordinary round 1", async () => {
    // Round 1 returns only [read], so `test` has genuinely not run yet.
    const report = await diagnoseRound2({
      round2: callsFor(TEST),
    });
    for (const d of report.diagnostics.failures) {
      expect(d.reason).toBe("expected-tool-not-invoked");
      expect(d.allowedCallRelation).toBe("future-only");
    }
  });

  it("still reports a repeat of the previous step as prior-only after an ordinary round 1", async () => {
    const report = await diagnoseRound2({
      round2: callsFor(READ),
    });
    for (const d of report.diagnostics.failures) {
      expect(d.reason).toBe("expected-tool-not-invoked");
      expect(d.allowedCallRelation).toBe("prior-only");
    }
  });

  it("classifies the failing round against the state that existed BEFORE it ran", async () => {
    // Round 2 returns [test, read]: `read`'s transition already succeeded so it
    // is prior, `test`'s has not, so the set is mixed — and crucially the
    // round's OWN calls must not be folded into the state before it is
    // classified (which would make `test` look prior too and mask the
    // skip-ahead half of the mixture).
    const report = await diagnoseRound2({ round2: callsFor(TEST, READ) });
    for (const d of report.diagnostics.failures) {
      expect(d.allowedCallRelation).toBe("prior-and-future");
      expect(d.callMultiplicity).toBe("multiple");
    }
  });

  it("keeps transition state scenario-local: one scenario never carries into the next", async () => {
    // Every scenario terminates at round 2, so each one is classified from a
    // FRESH, fully unsatisfied state plus only its own round 1. If the state
    // leaked across scenarios, later scenarios would see `edit` as already
    // satisfied and report `test` as the current expectation instead of a
    // skip-ahead.
    const report = await diagnoseRound2({
      round2: callsFor(TEST),
    });
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
    expect(new Set(report.diagnostics.failures.map((d) => d.allowedCallRelation))).toEqual(
      new Set(["future-only"]),
    );
  });

  it("marks an unauthorized tool name not-applicable for the relation but keeps the call dimensions", async () => {
    // An out-of-allowlist name is rejected by the parser itself, so selection
    // yields no valid call and the round is classified without a relation.
    const report = await diagnoseRound2({ round2: callsFor("rm-rf") });
    expect(report.diagnostics.failures[0]?.allowedCallRelation).toBe("not-applicable");
  });

  it("never emits a tool name, prompt, argument, path, id, or credential", async () => {
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => smartAdapter({ round2: callsFor(READ) }),
    });
    await runToolsDiagnostic(h.deps);
    const serialized = JSON.stringify(h.emitted);
    for (const forbidden of [
      `"${READ}"`,
      `"${EDIT}"`,
      `"${TEST}"`,
      "synthetic/",
      "version=1",
      "version=2",
      "Synthetic",
      "gateway_protocol",
      "claude",
      "alt-a",
      "call_ciq_",
      CRED_SENTINEL,
      "BEGIN_CONVERSATION_JSON",
      '"t1"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The fixed public origin is the ONLY url present anywhere in the output.
    expect(serialized).toContain(DIAGNOSTIC_ORIGIN);
    const urls = serialized.match(/https?:\/\/[^"]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toBe(DIAGNOSTIC_ORIGIN);
  });

  it("emits no gate collection and no `passed` field", async () => {
    // True for a clean corpus AND for one where every scenario failed the
    // transition: this command gathers evidence and establishes no gate.
    for (const over of [{}, { round2: callsFor(READ) }]) {
      const h = harness({ argv: fullArgv, makeAdapter: () => smartAdapter(over) });
      await runToolsDiagnostic(h.deps);
      const report = executed(h.emitted) as unknown as Record<string, unknown>;
      expect(report["gates"]).toBeUndefined();
      expect(report["passed"]).toBeUndefined();
      expect(Object.hasOwn(report, "gates")).toBe(false);
      expect(Object.hasOwn(report, "passed")).toBe(false);
      expect(Object.hasOwn(report, "completed")).toBe(true);
    }
  });
});

describe("eval:tools:diagnose — relation classifier categories the production corpus cannot produce", () => {
  // The synthetic toolset is exactly {read, edit, test} and all three belong to
  // the workflow, so `other-allowed` and `mixed-other` are unreachable through
  // the live loop. The classifier is pure, so they are proven directly.
  //
  // The scenario view is the one a sequential (non-parallel) round 1 leaves
  // behind: `read`'s transition succeeded, `edit` is the live expectation, and
  // `test` is still ahead.
  const base = {
    reason: "expected-tool-not-invoked" as const,
    allAllowed: true,
    satisfiedTools: [READ],
    pendingTools: [EDIT, TEST],
  };

  it("classifies an unrelated allowed tool as other-allowed", () => {
    expect(classifyAllowedCallRelation({ ...base, selectedCallNames: ["grep"] })).toBe(
      "other-allowed",
    );
  });

  it("classifies an unrelated allowed tool alongside a prior tool as mixed-other", () => {
    expect(classifyAllowedCallRelation({ ...base, selectedCallNames: [READ, "grep"] })).toBe(
      "mixed-other",
    );
    expect(classifyAllowedCallRelation({ ...base, selectedCallNames: [TEST, "grep"] })).toBe(
      "mixed-other",
    );
  });

  it("covers every relation category across the classifier and the live loop", () => {
    const viaClassifier: AllowedCallRelation[] = [
      classifyAllowedCallRelation({ ...base, selectedCallNames: [READ] }),
      classifyAllowedCallRelation({ ...base, selectedCallNames: [TEST] }),
      classifyAllowedCallRelation({ ...base, selectedCallNames: [READ, TEST] }),
      classifyAllowedCallRelation({ ...base, selectedCallNames: ["grep"] }),
      classifyAllowedCallRelation({ ...base, selectedCallNames: [READ, "grep"] }),
      classifyAllowedCallRelation({ ...base, selectedCallNames: null }),
    ];
    expect(new Set(viaClassifier)).toEqual(
      new Set([
        "prior-only",
        "future-only",
        "prior-and-future",
        "other-allowed",
        "mixed-other",
        "not-applicable",
      ]),
    );
    // Exactly six members: the v2 `expected-already-invoked` bucket is gone.
    expect(new Set(viaClassifier).size).toBe(6);
  });

  it("fails closed on a mispaired scenario view rather than guessing", () => {
    // The two views must describe the whole workflow exactly once. A wrong
    // total, a duplicate, or an overlap would otherwise yield a confident wrong
    // relation in the one command whose purpose is diagnostic accuracy.
    expect(base.satisfiedTools.length + base.pendingTools.length).toBe(SCENARIO_STEP_COUNT);
    expect(() =>
      classifyAllowedCallRelation({ ...base, pendingTools: [EDIT], selectedCallNames: [READ] }),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation({
        ...base,
        satisfiedTools: [READ, READ],
        pendingTools: [EDIT],
        selectedCallNames: [READ],
      }),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation({
        ...base,
        pendingTools: [READ, EDIT],
        selectedCallNames: [READ],
      }),
    ).toThrow();
  });

  it("refuses not-applicable for expected-tool-not-invoked and requires it for transcript-invalid", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "expected-tool-not-invoked",
        allowedCallRelation: "not-applicable",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      }),
    ).toContain("relation-must-be-applicable");
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "transcript-invalid",
        allowedCallRelation: "prior-only",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      }),
    ).toContain("relation-must-be-not-applicable");
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "expected-tool-unavailable",
        allowedCallRelation: "not-applicable",
        selectionSource: "not-applicable",
        callMultiplicity: "not-applicable",
      }),
    ).toEqual([]);
  });
});

describe("eval:tools:diagnose — checkpoint preconditions before credentials or network", () => {
  it("blocks an existing checkpoint without --resume-approved", async () => {
    const h = harness({ argv: fullArgv, store: memStore(seed(3)) });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(1);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      mode: "blocked",
      reason: "checkpoint-resume-not-approved",
      stage: "checkpoint-init",
      profile: DIAGNOSTIC_PROFILE,
      version: DIAGNOSTIC_REPORT_VERSION,
    });
    expect(h.providerCalls()).toBe(0);
    expect(h.ledger).toEqual([]);
  });

  it("blocks an unreadable/incompatible checkpoint", async () => {
    const store = memStore(seed(3));
    store.failRead = true;
    const h = harness({ argv: resumeArgv, store });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(1);
    expect(h.emitted[0]).toMatchObject({ mode: "blocked", reason: "checkpoint-incompatible" });
    expect(h.providerCalls()).toBe(0);
  });

  it("blocks a durable blocked tombstone (no automatic destructive restart)", async () => {
    const store = memStore(
      seed(3, {
        resumeState: "blocked",
        abort: { stage: "cleanup-delete", reason: "cleanup-failed" },
      }),
    );
    const h = harness({ argv: resumeArgv, store });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(1);
    expect(h.emitted[0]).toMatchObject({ mode: "blocked", reason: "checkpoint-blocked" });
    expect(h.providerCalls()).toBe(0);
    // The tombstone is left in place for deliberate operator archival/removal.
    expect(store.data?.resumeState).toBe("blocked");
    expect(store.deletes).toBe(0);
  });

  it("blocks a semantically forged checkpoint before any credential read", async () => {
    const forgeries: Partial<DiagnosticCheckpointData>[] = [
      { successfulScenarios: 20 }, // impossible at cursor 3
      { completedScenarios: 9 }, // disagrees with the cursor
      {
        scenarioEvidence: [
          [4, 3],
          [4, 3],
        ],
      }, // ledger length mismatch
      {
        scenarioEvidence: [
          [4, 3],
          [4, 3],
          [4, 2],
        ],
      }, // a success with a pending transition
      {
        scenarioEvidence: [
          [1, 3],
          [4, 3],
          [4, 3],
        ],
      }, // a success with no final-answer round
      { attemptedRounds: 999, completedRounds: 999 }, // inflated counters
      { cleanup: { attempted: 12, deleted: 11, failed: 1, journalFailures: 0 } },
      { nextScenarioIndex: 20 }, // a complete corpus can never be resumable
    ];
    // Origin / auth-mode / profile / corpus-fingerprint binding is enforced by
    // the STORE's read path (it throws, which the CLI maps to
    // `checkpoint-incompatible` — see the "unreadable/incompatible" case above);
    // `eval-diagnostic-checkpoint.test.ts` covers those rejections directly.
    for (const over of forgeries) {
      const h = harness({ argv: resumeArgv, store: memStore(seed(3, over)) });
      const code = await runToolsDiagnostic(h.deps);
      expect(code).toBe(1);
      expect(h.emitted[0]).toMatchObject({ mode: "blocked" });
      expect((h.emitted[0] as { reason: string }).reason).toMatch(
        /^checkpoint-(inconsistent|incompatible)$/,
      );
      expect(h.providerCalls()).toBe(0);
      expect(h.ledger).toEqual([]);
    }
  });

  it("blocks when the recovery journal cannot confirm recovery", async () => {
    const ledger: string[] = [];
    const journal = recordingJournal(ledger);
    const blocking = {
      ...journal,
      init: () => Promise.reject(new Error("unrecovered ids")),
    };
    const h = harness({ argv: fullArgv, journal: blocking });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(1);
    expect(h.emitted[0]).toMatchObject({
      mode: "blocked",
      reason: "recovery-journal-unrecovered",
      stage: "recovery-journal-init",
    });
    expect(h.providerCalls()).toBe(0);
  });

  it("blocks when the initial checkpoint anchor cannot be written, after finalizing the journal", async () => {
    const store = memStore();
    store.failWrite = true;
    const h = harness({ argv: fullArgv, store });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(1);
    expect(h.emitted[0]).toMatchObject({
      mode: "blocked",
      reason: "checkpoint-write-failed",
      stage: "checkpoint-init",
    });
    expect(h.providerCalls()).toBe(0);
    expect(h.ledger.filter((e) => e === "journal.finalize")).toHaveLength(1);
  });
});

describe("eval:tools:diagnose — resume", () => {
  it("skips committed scenarios and runs only the remainder", async () => {
    const adapter = smartAdapter();
    const store = memStore(seed(18));
    const h = harness({ argv: resumeArgv, store, makeAdapter: () => adapter });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.checkpoint.resumed).toBe(true);
    expect(report.checkpoint.startScenarioIndex).toBe(18);
    expect(report.checkpoint.runSegments).toBe(2);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    // Only the last two scenarios ran this segment (8 rounds), on top of 72.
    expect(adapter.counts.creates).toBe(2 * ROUNDS_PER_SCENARIO);
    expect(report.attemptedRounds).toBe(MAX_DIAGNOSTIC_UPSTREAM_ROUNDS);
    expect(report.completed).toBe(true);
    expect(report.checkpoint.finalized).toBe(true);
    // Only the DIAGNOSTIC checkpoint was removed.
    expect(store.deletes).toBe(1);
    expect(store.data).toBeNull();
    // The resumed segment reports the committed scenario ordinals it ran.
    const ordinals = progressEvents(h.emitted).map((p) => p.caseOrdinal);
    expect(new Set(ordinals)).toEqual(new Set([219, 220]));
  });

  it("resumes a v3 checkpoint whose committed scenarios finished in three rounds", async () => {
    // The state-aware success shape ON DISK: each committed scenario recorded
    // `[3, 3]` — three upstream rounds with all three transitions satisfied —
    // which format 2's plain executed-round ledger could not express and the
    // old four-round success floor would have rejected outright.
    const committed = 18;
    const rounds = 3 * committed;
    const store = memStore(
      seed(committed, {
        attemptedRounds: rounds,
        completedRounds: rounds,
        cleanup: { attempted: rounds, deleted: rounds, failed: 0, journalFailures: 0 },
        scenarioEvidence: Array.from(
          { length: committed },
          () => [3, SCENARIO_STEP_COUNT] as DiagnosticScenarioEvidence,
        ),
      }),
    );
    const adapter = smartAdapter({
      round1: callsFor(READ, EDIT),
      round2: callsFor(TEST),
      round3: raw(finalEnvelope("synthetic summary")),
    });
    const h = harness({ argv: resumeArgv, store, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(h.deps)).toBe(0);
    const report = executed(h.emitted);
    expect(report.checkpoint.resumed).toBe(true);
    expect(report.checkpoint.startScenarioIndex).toBe(committed);
    expect(report.checkpoint.runSegments).toBe(2);
    // Only the last two scenarios ran, three rounds each.
    expect(adapter.counts.creates).toBe(2 * 3);
    expect(report.attemptedRounds).toBe(rounds + 6);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    expect(report.successfulScenarios).toBe(SCENARIO_COUNT);
    expect(report.diagnostics.failures).toEqual([]);
    expect(report.cleanup).toEqual({
      attempted: rounds + 6,
      deleted: rounds + 6,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
    // Finalization removes ONLY the diagnostic checkpoint.
    expect(report.completed).toBe(true);
    expect(report.checkpoint.finalized).toBe(true);
    expect(store.deletes).toBe(1);
    expect(store.data).toBeNull();
  });

  it("restarts an uncommitted scenario without duplicating its diagnostic", async () => {
    // Segment 1: scenario 202 (index 1) fails operationally mid-scenario at its
    // round 2, so the scenario does NOT commit and the cursor stays at 1.
    let created = 0;
    const failing = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...failing,
      createThread: (input) => {
        created += 1;
        return failing.createThread(input);
      },
      processMessage: (input) => {
        if (created === 6) {
          return Promise.reject(new UpstreamError("authentication", 401, "POST"));
        }
        return failing.processMessage(input);
      },
    };
    const store = memStore();
    const first = harness({ argv: fullArgv, store, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(first.deps)).toBe(1);
    const firstReport = executed(first.emitted);
    expect(firstReport.aborted?.resumable).toBe(true);
    expect(firstReport.completedScenarios).toBe(1);
    expect(store.data?.nextScenarioIndex).toBe(1);
    expect(store.data?.diagnostics).toEqual([]);

    // Segment 2: resume; scenario 202 restarts from its first round. Give it a
    // wrong round-2 tool so it commits exactly ONE diagnostic.
    const second = harness({
      argv: resumeArgv,
      store,
      makeAdapter: () => smartAdapter({ round2: callsFor(READ) }),
    });
    expect(await runToolsDiagnostic(second.deps)).toBe(0);
    const report = executed(second.emitted);
    expect(report.completedScenarios).toBe(SCENARIO_COUNT);
    // 19 scenarios failed at round 2 this segment; scenario 201 succeeded in
    // segment 1 and its diagnostic set stays empty. No duplicates anywhere.
    const keys = report.diagnostics.failures.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(report.diagnostics.failures.filter((d) => d.caseOrdinal === 202)).toHaveLength(1);
    // No duplicate progress record for any scenario in this segment.
    const ordinals = progressEvents(second.emitted).map((p) => p.caseOrdinal);
    expect(new Set(ordinals).size).toBeLessThanOrEqual(ordinals.length);
  });

  it("re-emits every prior segment's committed diagnostics exactly once", async () => {
    // Segment 1 commits one diagnostic for scenario 201, then aborts resumably.
    const store = memStore();
    let created = 0;
    const base = smartAdapter({
      round2: callsFor(READ),
    });
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        // Rounds 1-2 belong to scenario 201 (committed, terminated early);
        // round 3 is scenario 202's first round and fails operationally.
        if (created === 3) {
          return Promise.reject(new UpstreamError("authentication", 401, "POST"));
        }
        return base.processMessage(input);
      },
    };
    const first = harness({ argv: fullArgv, store, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(first.deps)).toBe(1);
    expect(executed(first.emitted).diagnostics.failures).toHaveLength(1);
    expect(store.data?.diagnostics).toHaveLength(1);

    const second = harness({
      argv: resumeArgv,
      store,
      makeAdapter: () => smartAdapter(),
    });
    expect(await runToolsDiagnostic(second.deps)).toBe(0);
    const report = executed(second.emitted);
    const forFirstScenario = report.diagnostics.failures.filter((d) => d.caseOrdinal === 201);
    expect(forFirstScenario).toHaveLength(1);
    expect(forFirstScenario[0]).toMatchObject({
      allowedCallRelation: "prior-only",
      selectionSource: "desired-source",
      callMultiplicity: "single",
    });
  });
});

describe("eval:tools:diagnose — cleanup, abort, and finalization truth", () => {
  it("cleans the created thread on a submit failure and stays resumable", async () => {
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        if (created === 3) {
          return Promise.reject(new UpstreamError("authentication", 401, "POST"));
        }
        return base.processMessage(input);
      },
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "process-message",
      code: "upstream_authentication_failed",
      status: 401,
      resumable: true,
    });
    expect(report.cleanup).toEqual({
      attempted: 3,
      deleted: 3,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
    expect(report.completed).toBe(false);
    expect(h.journal.owned.size).toBe(0);
    expect(h.store.data?.resumeState).toBe("resumable");
  });

  it("cleans the created thread on a poll failure and stays resumable", async () => {
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      getMessages: (id, signal) => {
        if (created === 2) {
          return Promise.reject(new UpstreamError("authentication", 401, "GET"));
        }
        return base.getMessages(id, signal);
      },
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({ stage: "get-messages", resumable: true });
    expect(report.cleanup.deleted).toBe(2);
    expect(report.cleanup.remaining).toBe(0);
  });

  it("reports a create-stage failure as non-resumable with no cleanup attempt", async () => {
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: () => Promise.reject(new Error("boom")),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "create-thread",
      resumable: false,
      code: null,
      status: null,
    });
    expect(report.cleanup.attempted).toBe(0);
    expect(report.completed).toBe(false);
    // A non-resumable abort durably blocks the DIAGNOSTIC checkpoint.
    expect(h.store.data?.resumeState).toBe("blocked");
    expect(h.store.data?.abort).toEqual({ stage: "create-thread", reason: "create-failed" });
  });

  it("aborts non-resumably when a cleanup delete fails, truthfully and without ids", async () => {
    let calls = 0;
    const h = harness({
      argv: fullArgv,
      deleteThread: () => {
        calls += 1;
        return Promise.resolve(
          calls > 1 ? OK : { ok: false, status: 403, errorCode: "upstream_authentication_failed" },
        );
      },
    });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "cleanup-delete",
      resumable: false,
      status: 403,
      code: "upstream_authentication_failed",
    });
    expect(report.cleanup.failed).toBe(1);
    expect(report.cleanup.remaining).toBe(1);
    expect(report.completed).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/\bt1\b/);
    // A cleanup failure is non-resumable, so it durably BLOCKS the diagnostic
    // checkpoint: recovery needs deliberate operator archival/removal.
    expect(h.store.data?.resumeState).toBe("blocked");
    expect(h.store.data?.abort).toEqual({ stage: "cleanup-delete", reason: "cleanup-failed" });
    expect(h.store.deletes).toBe(0);
    // The tombstone itself stays value-free.
    expect(JSON.stringify(h.store.data)).not.toContain(CRED_SENTINEL);
  });

  it("durably blocks the checkpoint on a journal-persistence failure too", async () => {
    const ledger: string[] = [];
    const journal = recordingJournal(ledger);
    let writes = 0;
    const failing = {
      ...journal,
      recordCreated: (id: string) => {
        writes += 1;
        if (writes === 2) return Promise.reject(new Error("journal write failed"));
        return journal.recordCreated(id);
      },
    };
    const h = harness({ argv: fullArgv, journal: failing });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    expect(h.store.data?.resumeState).toBe("blocked");
    expect(h.store.data?.abort).toEqual({
      stage: "recovery-journal-record-created",
      reason: "journal-persistence-failed",
    });
  });

  it("aborts non-resumably when a recovery-journal write fails despite a successful delete", async () => {
    const ledger: string[] = [];
    const journal = recordingJournal(ledger);
    let writes = 0;
    const failing = {
      ...journal,
      recordCreated: (id: string) => {
        writes += 1;
        if (writes === 2) return Promise.reject(new Error("journal write failed"));
        return journal.recordCreated(id);
      },
    };
    const h = harness({ argv: fullArgv, journal: failing });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "recovery-journal-record-created",
      reason: "journal-persistence-failed",
      resumable: false,
    });
    // The unjournaled thread was still deleted exactly once.
    expect(report.cleanup.attempted).toBe(2);
    expect(report.cleanup.deleted).toBe(2);
    expect(report.cleanup.journalFailures).toBe(1);
    expect(report.completed).toBe(false);
  });

  it("cannot complete when journal finalization fails", async () => {
    const ledger: string[] = [];
    const journal = recordingJournal(ledger);
    const failing = {
      ...journal,
      finalize: () => Promise.reject(new Error("finalize failed")),
    };
    const h = harness({ argv: fullArgv, journal: failing });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "recovery-journal-finalize",
      reason: "recovery-journal-finalize-failed",
      resumable: false,
    });
    expect(report.completed).toBe(false);
  });

  it("cannot complete when the final checkpoint removal fails", async () => {
    const store = memStore();
    store.delete = () => {
      throw new Error("finalize failed");
    };
    const h = harness({ argv: fullArgv, store });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "checkpoint-persist",
      reason: "checkpoint-finalize-failed",
    });
    expect(report.checkpoint.persistFailed).toBe(true);
    expect(report.checkpoint.finalized).toBe(false);
    expect(report.completed).toBe(false);
  });

  it("reports a credential-configuration failure resumably with no upstream work", async () => {
    const h = harness({ argv: fullArgv });
    const deps: ToolsDiagnosticDeps = {
      ...h.deps,
      buildProvider: () => {
        throw new Error("password mode required");
      },
    };
    expect(await runToolsDiagnostic(deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({
      stage: "credential-config",
      reason: "credential-config-failed",
    });
    expect(report.attemptedRounds).toBe(0);
    expect(report.cleanup.attempted).toBe(0);
    expect(report.auth).toBeNull();
    expect(report.completed).toBe(false);
  });

  it("cleans an interrupted round on an INDEPENDENT (non-aborted) signal, resumably", async () => {
    const cleanupSignals: boolean[] = [];
    const control = interruptSeam();
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        if (created === 2) control.fire(); // interrupt mid-round, after the thread exists
        return base.processMessage(input);
      },
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter, interrupt: control });
    const deps: ToolsDiagnosticDeps = {
      ...h.deps,
      deleteThread: (_b, _p, _id, signal) => {
        cleanupSignals.push(signal.aborted);
        return Promise.resolve(OK);
      },
    };
    expect(await runToolsDiagnostic(deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.aborted).toMatchObject({ stage: "interrupted", resumable: true });
    expect(cleanupSignals.length).toBeGreaterThan(0);
    expect(cleanupSignals.every((aborted) => aborted === false)).toBe(true);
    expect(h.journal.owned.size).toBe(0);
    expect(control.removed).toBe(true);
  });

  it("emits progress only after a durable checkpoint write, and a terminal cleaned attempt exactly once", async () => {
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        created += 1;
        return base.createThread(input);
      },
      processMessage: (input) => {
        // Fail scenario 202's second round (global round 6) after scenario 201
        // committed, so a cleaned-but-uncommitted terminal attempt exists.
        if (created === 6) {
          return Promise.reject(new UpstreamError("authentication", 401, "POST"));
        }
        return base.processMessage(input);
      },
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const events = progressEvents(h.emitted);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.checkpointPersisted).toBe(true);
      expect(event.caseOrdinal).toBeGreaterThanOrEqual(FIRST_ORDINAL);
    }
    // Exactly one terminal record for the failing (202, round 2) attempt.
    const terminal = events.filter((e) => e.caseOrdinal === 202 && e.roundOrdinal === 2);
    expect(terminal).toHaveLength(1);
    // The terminal progress arrives AFTER the resumable checkpoint persisted and
    // BEFORE the final report.
    const modes = h.emitted.map((r) => r.mode);
    expect(modes[modes.length - 1]).toBe("executed");
  });

  it("emits no resumability progress when the checkpoint write itself fails", async () => {
    const store = memStore();
    let created = 0;
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        created += 1;
        if (created === 2) store.failWrite = true;
        return base.createThread(input);
      },
    };
    const h = harness({ argv: fullArgv, store, makeAdapter: () => adapter });
    expect(await runToolsDiagnostic(h.deps)).toBe(1);
    const report = executed(h.emitted);
    expect(report.checkpoint.persistFailed).toBe(true);
    expect(report.completed).toBe(false);
  });
});

describe("eval:tools:diagnose — exit semantics", () => {
  it("exits ZERO on a complete diagnostic even when every scenario failed at the transition", async () => {
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => smartAdapter({ round2: callsFor(READ) }),
    });
    const code = await runToolsDiagnostic(h.deps);
    expect(code).toBe(0);
    const report = executed(h.emitted);
    expect(report.completed).toBe(true);
    expect(report.successfulScenarios).toBe(0);
    expect(report.diagnostics.failures).toHaveLength(SCENARIO_COUNT);
  });

  it("exits non-zero for every blocking or operational condition", async () => {
    const blocked = harness({ argv: fullArgv, store: memStore(seed(3)) });
    expect(await runToolsDiagnostic(blocked.deps)).toBe(1);

    const failedCleanup = harness({
      argv: fullArgv,
      deleteThread: () => Promise.resolve({ ok: false, status: 500, errorCode: null }),
    });
    expect(await runToolsDiagnostic(failedCleanup.deps)).toBe(1);
  });
});

describe("eval:tools:diagnose — release evaluator compatibility", () => {
  it("keeps the diagnostic versions independent of the release evaluator's", () => {
    // The release constants are owned by `src/eval/report.ts` and
    // `src/eval/checkpoint.ts`; they are pinned here purely as a canary, so a
    // silent release-side bump surfaces in the diagnostic suite too.
    expect(EVAL_REPORT_VERSION).toBe(5);
    expect(CHECKPOINT_FORMAT_VERSION).toBe(4);
    // The diagnostic contract versions INDEPENDENTLY: v3 removes the v2
    // `expected-already-invoked` relation and replaces the executed-round
    // ledger with per-scenario `[executedRounds, satisfiedSteps]` evidence.
    // Neither number may be derived from the release side.
    expect(DIAGNOSTIC_REPORT_VERSION).toBe(3);
    expect(DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION).toBe(3);
    // Widened to `number` so the comparison is about the runtime values rather
    // than the literal types.
    const diagnosticReport: number = DIAGNOSTIC_REPORT_VERSION;
    const diagnosticCheckpoint: number = DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION;
    const releaseReport: number = EVAL_REPORT_VERSION;
    const releaseCheckpoint: number = CHECKPOINT_FORMAT_VERSION;
    expect(diagnosticReport).not.toBe(releaseReport);
    expect(diagnosticCheckpoint).not.toBe(releaseCheckpoint);
  });

  it("uses the same fixed origin but a distinct checkpoint filename and profile", () => {
    expect(DIAGNOSTIC_ORIGIN).toBe(EVAL_ORIGIN);
    expect(DIAGNOSTIC_CHECKPOINT_FILENAME).not.toBe(CHECKPOINT_FILENAME);
    expect(DIAGNOSTIC_PROFILE).toBe("multi-step-transition");
  });

  it("cannot name the release checkpoint module or filename from the command itself", () => {
    // The command's own module resolves ONLY the diagnostic checkpoint store, so
    // no code path here can read, overwrite, finalize, or remove the release
    // evaluator's checkpoint. Comments are stripped first: the docstring
    // legitimately explains the separation, and the property under test is that
    // no CODE position can reach it. A hermetic file read; no network,
    // credential, or upstream call.
    const source = readFileSync(
      new URL("../../src/eval/tools-diagnostic-cli.ts", import.meta.url),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["']\.\/checkpoint\.js["']/);
    expect(code).not.toContain(CHECKPOINT_FILENAME);
    expect(code).toContain("./diagnostic-checkpoint.js");
  });

  it("wires production deps to the DIAGNOSTIC checkpoint store, never the release one", () => {
    const deps = defaultToolsDiagnosticDeps();
    // The production store is a closure over the diagnostic location; construction
    // performs no I/O, so simply obtaining it must not touch the filesystem.
    const store = deps.makeCheckpointStore(DIAGNOSTIC_ORIGIN, corpusFingerprint());
    expect(typeof store.read).toBe("function");
    expect(typeof store.exists).toBe("function");
    expect(typeof store.write).toBe("function");
    expect(typeof store.delete).toBe("function");
    // Production transport wiring is shared with the release evaluator.
    expect(typeof deps.deleteThread).toBe("function");
    expect(typeof deps.buildProvider).toBe("function");
    expect(typeof deps.makeAdapter).toBe("function");
  });
});

describe("live-round — the shared lifecycle extracted from the release evaluator", () => {
  const tools = [
    {
      name: READ,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ];
  const request = buildRoundRequest(tools, { kind: "auto" }, [
    { role: "user", content: "synthetic round request" },
  ]);
  const okPoller: Poller = {
    poll: () => Promise.resolve({ kind: "answer", content: finalEnvelope("x"), messages: [] }),
  };

  function journalSpy(): RecoveryJournalSink & { events: string[] } {
    const events: string[] = [];
    return {
      events,
      init: () => Promise.resolve(),
      recordCreated: (id) => {
        events.push(`created:${id}`);
        return Promise.resolve();
      },
      recordDeleted: (id) => {
        events.push(`deleted:${id}`);
        return Promise.resolve();
      },
      finalize: () => Promise.resolve(),
      ownedThreadIds: () => [],
    };
  }

  it("preserves the extracted poll bounds and the content-free thread title", async () => {
    // These four values moved out of `tools-eval-cli.ts` during the extraction
    // and are not otherwise asserted anywhere, so a silent drift would change
    // live upstream behavior for BOTH evaluators without failing a test.
    const titles: (string | undefined)[] = [];
    const pollParams: {
      pollIntervalMs: number;
      maxPollIntervalMs: number;
      deadlineMs: number;
      answerSource: string;
    }[] = [];
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: (input) => {
        titles.push(input.title);
        return base.createThread(input);
      },
    };
    const capturingPoller: Poller = {
      poll: (params) => {
        pollParams.push({
          pollIntervalMs: params.pollIntervalMs,
          maxPollIntervalMs: params.maxPollIntervalMs,
          deadlineMs: params.deadlineMs,
          answerSource: params.answerSource,
        });
        return Promise.resolve({ kind: "answer", content: finalEnvelope("x"), messages: [] });
      },
    };
    const before = Date.now();
    await runLiveRound(
      adapter,
      capturingPoller,
      () => Promise.resolve(OK),
      journalSpy(),
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    const after = Date.now();

    expect(titles).toEqual(["New Thread"]);
    expect(pollParams).toHaveLength(1);
    expect(pollParams[0]?.pollIntervalMs).toBe(2_000);
    expect(pollParams[0]?.maxPollIntervalMs).toBe(5_000);
    expect(pollParams[0]?.answerSource).toBe("claude");
    // The 90 s request timeout is applied as an absolute deadline.
    expect(pollParams[0]?.deadlineMs).toBeGreaterThanOrEqual(before + 90_000);
    expect(pollParams[0]?.deadlineMs).toBeLessThanOrEqual(after + 90_000);
  });

  it("falls back to a fixed answer source when the configured model set is empty", async () => {
    const seen: string[] = [];
    const capturingPoller: Poller = {
      poll: (params) => {
        seen.push(params.answerSource);
        return Promise.resolve({ kind: "answer", content: finalEnvelope("x"), messages: [] });
      },
    };
    await runLiveRound(
      smartAdapter(),
      capturingPoller,
      () => Promise.resolve(OK),
      journalSpy(),
      request,
      [],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(seen).toEqual(["claude"]);
  });

  it("creates once, submits once, and deletes exactly once on success", async () => {
    const adapter = smartAdapter();
    const journal = journalSpy();
    const deletes: string[] = [];
    const result = await runLiveRound(
      adapter,
      okPoller,
      (id) => {
        deletes.push(id);
        return Promise.resolve(OK);
      },
      journal,
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(result.created).toBe(true);
    expect(result.httpDeleted).toBe(true);
    expect(result.outcome?.kind).toBe("answer");
    expect(adapter.counts.creates).toBe(1);
    expect(adapter.counts.submits).toBe(1);
    expect(deletes).toEqual(["t1"]);
    expect(journal.events).toEqual(["created:t1", "deleted:t1"]);
  });

  it("attempts no delete and reports an ambiguous create failure", async () => {
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      createThread: () => Promise.reject(new UpstreamError("authentication", 401, "POST")),
    };
    let deletes = 0;
    const result = await runLiveRound(
      adapter,
      okPoller,
      () => {
        deletes += 1;
        return Promise.resolve(OK);
      },
      journalSpy(),
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(result.created).toBe(false);
    expect(result.createFailureCode).toBe("upstream_authentication_failed");
    expect(result.createFailureStatus).toBe(401);
    expect(deletes).toBe(0);
  });

  it("short-circuits submit and poll when the create-time journal write fails, still deleting once", async () => {
    const adapter = smartAdapter();
    const journal = journalSpy();
    const failing: RecoveryJournalSink = {
      ...journal,
      recordCreated: () => Promise.reject(new Error("journal write failed")),
    };
    let deletes = 0;
    const result = await runLiveRound(
      adapter,
      okPoller,
      () => {
        deletes += 1;
        return Promise.resolve(OK);
      },
      failing,
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(result.recordCreatedFailed).toBe(true);
    expect(result.outcome).toBeNull();
    expect(adapter.counts.submits).toBe(0);
    expect(adapter.counts.polls).toBe(0);
    expect(deletes).toBe(1);
  });

  it("skips the journal drop when the delete did not return 2xx", async () => {
    const journal = journalSpy();
    const result = await runLiveRound(
      smartAdapter(),
      okPoller,
      () =>
        Promise.resolve({ ok: false, status: 403, errorCode: "upstream_authentication_failed" }),
      journal,
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(result.httpDeleted).toBe(false);
    expect(result.deleteStatus).toBe(403);
    expect(journal.events).toEqual(["created:t1"]);
  });

  it("uses the INDEPENDENT cleanup signal even when the work signal is aborted", async () => {
    const work = new AbortController();
    const cleanup = new AbortController();
    work.abort();
    const seen: boolean[] = [];
    await runLiveRound(
      smartAdapter(),
      okPoller,
      (_id, signal) => {
        seen.push(signal.aborted);
        return Promise.resolve(OK);
      },
      journalSpy(),
      request,
      ["claude"],
      work.signal,
      cleanup.signal,
    );
    expect(seen).toEqual([false]);
  });

  it("never throws, even when the deleter itself rejects", async () => {
    const result = await runLiveRound(
      smartAdapter(),
      okPoller,
      () => Promise.reject(new Error("delete exploded")),
      journalSpy(),
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(result.httpDeleted).toBe(false);
    expect(result.deleteStatus).toBeNull();
    expect(result.deleteCode).toBeNull();
  });

  it("never inspects a hostile thrown value", async () => {
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          traps += 1;
          return "leak";
        },
      },
    );
    const base = smartAdapter();
    const adapter: CollectivIQAdapter = {
      ...base,
      // Deliberately reject a hostile NON-Error value to prove it is never inspected.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      createThread: () => Promise.reject(hostile),
    };
    const result = await runLiveRound(
      adapter,
      okPoller,
      () => Promise.resolve(OK),
      journalSpy(),
      request,
      ["claude"],
      new AbortController().signal,
      new AbortController().signal,
    );
    expect(result.createFailureCode).toBeNull();
    expect(result.createFailureStatus).toBeNull();
    expect(traps).toBe(0);
  });
});
