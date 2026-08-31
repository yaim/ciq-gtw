/**
 * Approval-gated LIVE MULTI-STEP TRANSITION DIAGNOSTIC
 * (`npm run eval:tools:diagnose`, specification section 30).
 *
 * WHY THIS COMMAND EXISTS. The completed report-v4 release campaign passed six
 * of the eight section-30 gates but failed tool-name accuracy and multi-step
 * success. Every recorded failure was the same shape: a multi-step scenario, at
 * round 2 (where the `edit` step follows a successful `read`), under
 * `tool_choice: auto`, producing a VALID, ALLOWED tool call that omitted the
 * expected tool — reason `expected-tool-not-invoked`. The release report is
 * value-free by design, so it cannot say whether the model repeated an
 * already-completed tool, skipped ahead to a later one, returned a mixture,
 * chose an unrelated allowed tool, or emitted several calls at once. This
 * command re-runs ONLY the 20 multi-step scenarios and adds exactly three
 * closed, value-free dimensions (`allowedCallRelation`, `selectionSource`,
 * `callMultiplicity`) that separate those hypotheses without naming a tool.
 *
 * WHAT IT IS NOT. It establishes NO release gate. The output carries no
 * threshold, no gate collection, and no `passed` field — only `completed`,
 * meaning the corpus was observed end to end with clean cleanup and
 * finalization. `completed: true` exits ZERO even when model transition
 * failures were observed: those failures are the evidence being collected, not
 * an operational error. A non-zero exit means the DIAGNOSTIC itself could not
 * be trusted (blocked precondition, operational abort, cleanup/journal failure,
 * or checkpoint persistence/finalization failure).
 *
 * Safety contract (identical in spirit to `eval:tools`):
 *  - The DEFAULT invocation is a credential-free, network-free PREFLIGHT: it
 *    reports the fixed origin, the fixed scenario plan, the global ordinal
 *    range, and the required approvals, reading no credential, opening no
 *    socket, and touching no journal or checkpoint.
 *  - The destination origin ({@link DIAGNOSTIC_ORIGIN}) is a module constant and
 *    is NOT part of the injectable deps surface, so a test can never broaden it.
 *  - Live execution requires ALL of `--execute-approved`, `--cost-approved`,
 *    `--cleanup-approved`, and `--recovery-journal-approved`. A resume
 *    additionally requires `--resume-approved`. Every other argument is
 *    rejected.
 *  - Only `password` auth mode is used.
 *  - Exactly the {@link MULTI_STEP_SCENARIOS} multi-step scenarios run, in
 *    order, at their GLOBAL corpus ordinals. The 200 single-round cases are
 *    NEVER executed. A HARD per-segment cap of
 *    {@link MAX_DIAGNOSTIC_UPSTREAM_ROUNDS} upstream completions applies.
 *  - Content is synthetic only — never repository content.
 *  - Each round creates at most ONE thread, which is deleted IMMEDIATELY, with
 *    every created id recorded in the private ID-only recovery journal (dropped
 *    only after a confirmed delete). A cleanup failure ABORTS the run.
 *  - The whole lifecycle runs through the SHARED `runLiveRound` helper, and the
 *    failure classifier is the release evaluator's own `classifyRoundFailure`,
 *    so the diagnostic can never drift from the behavior it is explaining.
 *  - Resume uses a SEPARATE diagnostic checkpoint
 *    (`src/eval/diagnostic-checkpoint.ts`) that hard-codes its own filename and
 *    never references the release checkpoint, so this command structurally
 *    cannot read, overwrite, finalize, or remove the release evaluator's
 *    checkpoint.
 *  - The output is a versioned, value-free UNION (preflight / progress /
 *    blocked / executed). It never emits credentials, prompts, answers,
 *    schemas, arguments, tool names, model or source identifiers, titles,
 *    thread/run/message ids, timestamps, bodies, journal/checkpoint contents, or
 *    any thrown value.
 */
import { pathToFileURL } from "node:url";
import type { AuthObservation } from "../collectiviq/auth.js";
import type {
  CollectivIQAdapter,
  CollectivIQCredentialProvider,
  TransportBase,
  UpstreamMessage,
} from "../collectiviq/types.js";
import type { DeleteDiagnostics } from "../collectiviq/cleanup.js";
import {
  defaultDiscoveryJournalDir,
  type RecoveryJournalSink,
} from "../collectiviq/recovery-journal.js";
import { createPoller } from "../generation/polling.js";
import type { PollOutcome } from "../generation/types.js";
import { selectGeneration, type SourceCandidate } from "../tools/select.js";
import { compileToolset, type CompiledToolset } from "../tools/schema.js";
import { createToolCallIdGenerator } from "../tools/ids.js";
import { normalizeToolRequest, type ProbedField } from "../tools/request.js";
import type { NormalizedMessage } from "../openai/chat-types.js";
import type { NormalizedTool, ParsedToolCall, ToolParseSource } from "../tools/types.js";
import {
  buildRoundRequest,
  runLiveRound,
  type BoundDeleter,
  type LiveRoundResult,
} from "./live-round.js";
import {
  buildEvalCases,
  corpusFingerprint,
  initializeScenarioRuntime,
  renderSyntheticToolResult,
  type EvalRound,
} from "./cases.js";
import {
  classifyRoundFailure,
  defaultToolsEvalDeps,
  type RoundDecision,
} from "./tools-eval-cli.js";
import {
  buildDiagnosticCorpusProjection,
  defaultDiagnosticCheckpointLocation,
  deleteDiagnosticCheckpoint,
  diagnosticCheckpointExists,
  readDiagnosticCheckpoint,
  rehydrateTransitionDiagnostics,
  selectDiagnosticScenarios,
  validateResumableDiagnosticCheckpoint,
  writeDiagnosticCheckpoint,
  DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
  type DiagnosticCheckpointData,
  type DiagnosticCheckpointEntry,
} from "./diagnostic-checkpoint.js";
import {
  classifyAllowedCallRelation,
  diagnosticCallMultiplicityFor,
  diagnosticSelectionSourceFor,
  transitionDiagnosticDimensionErrors,
  ALLOWED_CALL_RELATION_CODES,
  DIAGNOSTIC_CALL_MULTIPLICITY_CODES,
  DIAGNOSTIC_PROFILE,
  DIAGNOSTIC_REPORT_VERSION,
  DIAGNOSTIC_SELECTION_SOURCE_CODES,
  type DiagnosticExecutedReport,
  type DiagnosticOrdinalRange,
  type DiagnosticOutput,
  type DiagnosticPreflightReport,
  type TransitionDiagnostic,
} from "./diagnostic-report.js";
import {
  EVAL_FAILURE_REASON_CODES,
  type AbortInfo,
  type AbortStage,
  type BlockedReason,
  type CleanupTotals,
} from "./report.js";

/** The FIXED CollectivIQ production origin. Never injectable. */
export const DIAGNOSTIC_ORIGIN = "https://api.prod.collectiviq.ai";
/** The diagnostic only ever authenticates in password mode. */
export const DIAGNOSTIC_AUTH_MODE = "password" as const;

/**
 * HARD per-segment cap on upstream completions: 20 scenarios × 4 rounds. This is
 * an UPPER BOUND, not an expected count — truthful early termination means a
 * scenario that fails at round 2 issues no further rounds.
 */
export const MAX_DIAGNOSTIC_UPSTREAM_ROUNDS = 80;

/** The closed set of approval flags. Any other argument is an error. */
export interface DiagnosticArgs {
  readonly executeApproved: boolean;
  readonly costApproved: boolean;
  readonly cleanupApproved: boolean;
  readonly recoveryJournalApproved: boolean;
  readonly resumeApproved: boolean;
}

export function parseDiagnosticArgs(argv: readonly string[]): DiagnosticArgs {
  const flags = {
    executeApproved: false,
    costApproved: false,
    cleanupApproved: false,
    recoveryJournalApproved: false,
    resumeApproved: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case "--execute-approved":
        flags.executeApproved = true;
        break;
      case "--cost-approved":
        flags.costApproved = true;
        break;
      case "--cleanup-approved":
        flags.cleanupApproved = true;
        break;
      case "--recovery-journal-approved":
        flags.recoveryJournalApproved = true;
        break;
      case "--resume-approved":
        flags.resumeApproved = true;
        break;
      default:
        throw new Error("unknown argument");
    }
  }
  return flags;
}

/**
 * The global corpus ordinal range the diagnostic covers, derived from the corpus
 * itself (never hardcoded). For the production corpus this is 201–220.
 */
function ordinalRange(ordinals: readonly number[]): DiagnosticOrdinalRange {
  const first = ordinals[0] ?? 0;
  const last = ordinals[ordinals.length - 1] ?? 0;
  return { first, last };
}

/**
 * Build the credential-free, network-free preflight projection. It derives the
 * scenario count, global ordinal range, and upstream-round upper bound from the
 * deterministic synthetic corpus — a pure, in-memory computation that reads no
 * credential, initializes no journal, inspects no checkpoint, and opens no
 * socket.
 */
export function buildDiagnosticPreflightReport(args: DiagnosticArgs): DiagnosticPreflightReport {
  const scenarios = selectDiagnosticScenarios(buildEvalCases());
  const projection = buildDiagnosticCorpusProjection(scenarios);
  const given: string[] = [];
  if (args.executeApproved) given.push("--execute-approved");
  if (args.costApproved) given.push("--cost-approved");
  if (args.cleanupApproved) given.push("--cleanup-approved");
  if (args.recoveryJournalApproved) given.push("--recovery-journal-approved");
  if (args.resumeApproved) given.push("--resume-approved");
  return {
    version: DIAGNOSTIC_REPORT_VERSION,
    mode: "preflight",
    profile: DIAGNOSTIC_PROFILE,
    origin: DIAGNOSTIC_ORIGIN,
    authMode: DIAGNOSTIC_AUTH_MODE,
    plannedScenarios: scenarios.length,
    globalOrdinalRange: ordinalRange(scenarios.map((s) => s.caseOrdinal)),
    plannedUpstreamRounds: projection.plannedUpstreamRounds,
    approvalsRequired: [
      "--execute-approved",
      "--cost-approved",
      "--cleanup-approved",
      "--recovery-journal-approved",
    ],
    approvalsGiven: given,
    resumeApproved: args.resumeApproved,
  };
}

/** A provider plus its value-free auth observation accessor. */
export interface DiagnosticBuiltProvider {
  readonly provider: CollectivIQCredentialProvider;
  readonly authObservation: () => AuthObservation | null;
}

/** The private, content-free DIAGNOSTIC checkpoint store (injected for tests). */
export interface DiagnosticCheckpointStore {
  read(): DiagnosticCheckpointData | null;
  exists(): boolean;
  write(data: DiagnosticCheckpointData): void;
  delete(): void;
}

/** The injectable orchestration seam (production omits every override). */
export interface ToolsDiagnosticDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly buildProvider: (env: NodeJS.ProcessEnv, base: TransportBase) => DiagnosticBuiltProvider;
  readonly makeAdapter: (
    base: TransportBase,
    provider: CollectivIQCredentialProvider,
  ) => CollectivIQAdapter;
  readonly deleteThread: (
    base: TransportBase,
    provider: CollectivIQCredentialProvider,
    threadId: string,
    signal: AbortSignal,
  ) => Promise<DeleteDiagnostics>;
  readonly makeJournal: (dir: string, origin: string) => RecoveryJournalSink;
  readonly makeCheckpointStore: (
    origin: string,
    corpusFingerprint: string,
  ) => DiagnosticCheckpointStore;
  readonly installInterruptHandler: (onInterrupt: () => void) => () => void;
  readonly emit: (output: DiagnosticOutput) => void;
}

/**
 * Production deps. The transport-facing wiring (password provider, real adapter,
 * bounded single-attempt DELETE, file recovery journal, controlled first-signal
 * interruption) is taken VERBATIM from the release evaluator's production deps so
 * the two commands cannot drift apart operationally.
 *
 * Every field is assigned EXPLICITLY rather than spread, so the type checker
 * forces `makeCheckpointStore` to be named here: the diagnostic can never
 * silently inherit the release evaluator's checkpoint store, which is the single
 * most important isolation property of this command.
 */
export function defaultToolsDiagnosticDeps(): ToolsDiagnosticDeps {
  const shared = defaultToolsEvalDeps();
  return {
    argv: process.argv.slice(2),
    env: process.env,
    buildProvider: shared.buildProvider,
    makeAdapter: shared.makeAdapter,
    deleteThread: shared.deleteThread,
    makeJournal: shared.makeJournal,
    installInterruptHandler: shared.installInterruptHandler,
    makeCheckpointStore: (origin, fingerprint) => {
      const loc = defaultDiagnosticCheckpointLocation();
      return {
        read: () => readDiagnosticCheckpoint(loc, { origin, corpusFingerprint: fingerprint }),
        exists: () => diagnosticCheckpointExists(loc),
        write: (data) => writeDiagnosticCheckpoint(loc, data),
        delete: () => deleteDiagnosticCheckpoint(loc),
      };
    },
    emit: (output) => process.stdout.write(`${JSON.stringify(output)}\n`),
  };
}

/**
 * A round's classified generation, extending the release evaluator's
 * {@link RoundDecision} with the two extra value-free dimensions the diagnostic
 * needs: the trusted selector's selection path and the selected call names
 * (in-process only — names never reach the output).
 */
type DiagnosticDecision = RoundDecision & {
  readonly selectionSource: ToolParseSource | null;
};

/**
 * Classify a poll outcome by running the REAL selection engine, capturing the
 * trusted selection path alongside the release evaluator's decision shape.
 * Never throws.
 */
function classifyDiagnosticDecision(
  outcome: PollOutcome | null,
  toolset: CompiledToolset,
  round: EvalRound,
  selectedLlms: readonly string[],
): DiagnosticDecision {
  if (outcome === null || outcome.kind === "timeout") {
    return { kind: "unavailable", selectionSource: null };
  }
  const individuals: SourceCandidate[] = outcome.messages
    .filter((m): m is UpstreamMessage & { content: string } => typeof m.content === "string")
    .map((m) => ({ source: m.source, content: m.content, percentUsage: m.percentUsage ?? null }));
  let selection;
  try {
    selection = selectGeneration({
      desired: { content: outcome.content },
      individuals,
      toolset,
      choice: round.choice,
      parallelToolCalls: true,
      selectedLlms,
      idGen: createToolCallIdGenerator(),
    });
  } catch {
    return { kind: "unavailable", selectionSource: null };
  }
  if (!selection.ok) return { kind: "no_valid_call", selectionSource: null };
  if (selection.generation.kind === "text") return { kind: "text", selectionSource: null };
  const calls = selection.generation.calls;
  // Defensive: a zero-call `tool_calls` generation is impossible today because
  // `parseToolEnvelope` rejects an envelope with fewer than one call. Were that
  // bound ever relaxed, the flags below would go vacuously wrong —
  // `calls.every(...)` is true for an empty array while `calls.some(...)` is
  // false — labelling it `expected-tool-not-invoked`, a reason that MANDATES a
  // real allowed-call relation. That combination violates the reason ⇄ dimension
  // contract and would abort an approval-gated live run after upstream threads
  // had already been spent. Treat it as "no valid call" instead, which degrades
  // the diagnostic truthfully rather than crashing mid-campaign.
  if (calls.length === 0) return { kind: "no_valid_call", selectionSource: null };
  const allAllowed = calls.every((call) => toolset.has(call.name));
  const expectedInvoked =
    round.expectedTool === undefined
      ? true
      : calls.some((call) => call.name === round.expectedTool);
  return {
    kind: "tool_calls",
    calls,
    expectedInvoked,
    allAllowed,
    unauthorized: !allAllowed,
    selectionSource: selection.generation.source,
  };
}

/** Whether an expected-tool-call round produced the correct allowed call (pure). */
function expectedCallNameOk(decision: DiagnosticDecision): boolean {
  return decision.kind === "tool_calls" && decision.allAllowed && decision.expectedInvoked;
}

/**
 * Re-validate an accumulated transcript through the real tool-request normalizer
 * (id uniqueness, declared names, schema-valid arguments, exactly-one linked
 * result per call) — the same check the release evaluator performs.
 */
function transcriptValid(
  messages: readonly NormalizedMessage[],
  tools: readonly NormalizedTool[],
): boolean {
  const toolsValue = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
  const present = (value: unknown): ProbedField => ({ present: true, value });
  const absent: ProbedField = { present: false, value: undefined };
  const result = normalizeToolRequest({
    tools: present(toolsValue),
    toolChoice: absent,
    parallelToolCalls: absent,
    messages,
  });
  return result.ok;
}

/**
 * Build one value-free {@link TransitionDiagnostic}. The scenario's expected-tool
 * sequence and the selected call names are read here (in-process, synthetic
 * corpus values) but only closed enums are returned. Fails closed if the derived
 * dimensions would violate the reason ⇄ dimension contract, so an inconsistent
 * diagnostic can never be emitted or persisted.
 */
function buildTransitionDiagnostic(
  caseOrdinal: number,
  roundOrdinal: number,
  choiceKind: TransitionDiagnostic["choiceKind"],
  reason: TransitionDiagnostic["reason"],
  decision: DiagnosticDecision,
  expectedToolByRound: readonly (string | undefined)[],
  priorInvokedNames: ReadonlySet<string>,
): TransitionDiagnostic {
  const calls: readonly ParsedToolCall[] | null =
    decision.kind === "tool_calls" ? decision.calls : null;
  const diagnostic: TransitionDiagnostic = {
    caseOrdinal,
    roundOrdinal,
    choiceKind,
    reason,
    allowedCallRelation: classifyAllowedCallRelation({
      reason,
      selectedCallNames: calls === null ? null : calls.map((call) => call.name),
      allAllowed: decision.kind === "tool_calls" ? decision.allAllowed : false,
      expectedToolByRound,
      roundIndex: roundOrdinal - 1,
      priorInvokedNames,
    }),
    selectionSource: diagnosticSelectionSourceFor(decision.selectionSource),
    callMultiplicity: diagnosticCallMultiplicityFor(calls === null ? null : calls.length),
  };
  if (transitionDiagnosticDimensionErrors(diagnostic).length > 0) {
    throw new Error("diagnostic dimensions are inconsistent with the classified reason");
  }
  return diagnostic;
}

/**
 * A bounded, value-free descriptor of a cleaned-but-uncommitted terminal round
 * whose resumable abort left the loop before it could emit its own progress
 * event. It carries ONLY the attempted round's global case + round ordinals and
 * never claims the scenario cursor advanced. Emitted exactly once, AFTER the
 * resumable checkpoint durably persists.
 */
interface PendingProgress {
  readonly caseOrdinal: number;
  readonly roundOrdinal: number;
}

/** Emit a value-free blocked (pre-execution precondition) report; returns code 1. */
function emitBlocked(deps: ToolsDiagnosticDeps, reason: BlockedReason, stage: AbortStage): number {
  deps.emit({
    version: DIAGNOSTIC_REPORT_VERSION,
    mode: "blocked",
    profile: DIAGNOSTIC_PROFILE,
    origin: DIAGNOSTIC_ORIGIN,
    authMode: DIAGNOSTIC_AUTH_MODE,
    reason,
    stage,
  });
  return 1;
}

/**
 * Run the diagnostic. Preflight by default; the fully-approved path executes the
 * bounded multi-step-only live loop. Returns a process exit code: 0 when the
 * diagnostic COMPLETED (even with observed model failures), 1 for any blocking
 * or operational condition that makes the evidence untrustworthy.
 */
export async function runToolsDiagnostic(deps: ToolsDiagnosticDeps): Promise<number> {
  const args = parseDiagnosticArgs(deps.argv);

  // DEFAULT: preflight only — no credential, no network, no journal, no checkpoint.
  if (!args.executeApproved) {
    deps.emit(buildDiagnosticPreflightReport(args));
    return 0;
  }
  if (!args.costApproved || !args.cleanupApproved || !args.recoveryJournalApproved) {
    throw new Error(
      "eval:tools:diagnose execution requires --execute-approved --cost-approved --cleanup-approved --recovery-journal-approved",
    );
  }

  const origin = DIAGNOSTIC_ORIGIN;
  // Build the FULL corpus EXACTLY ONCE, fingerprint THAT value, select the
  // multi-step slice from THAT value, and project/execute from the same
  // scenarios. Fingerprint, projection, and execution therefore all derive from
  // one exact corpus instance, so no divergent rebuilt corpus can slip into the
  // executed path. Projection build also fails closed on a `choiceKind` outside
  // the diagnostic union, before any credential read or network I/O.
  const cases = buildEvalCases();
  const fingerprint = corpusFingerprint(cases);
  const scenarios = selectDiagnosticScenarios(cases);
  const projection = buildDiagnosticCorpusProjection(scenarios);
  const plannedUpstreamRounds = projection.plannedUpstreamRounds;
  const globalOrdinalRange = ordinalRange(scenarios.map((s) => s.caseOrdinal));
  const base: TransportBase = { baseUrl: origin };
  const store = deps.makeCheckpointStore(origin, fingerprint);

  // ---- Preconditions, ALL before any credential read or network I/O. ----

  let checkpointPresent: boolean;
  try {
    checkpointPresent = store.exists();
  } catch {
    return emitBlocked(deps, "checkpoint-read-failed", "checkpoint-init");
  }
  if (checkpointPresent && !args.resumeApproved) {
    return emitBlocked(deps, "checkpoint-resume-not-approved", "checkpoint-init");
  }
  let resumed: DiagnosticCheckpointData | null = null;
  if (checkpointPresent) {
    try {
      resumed = store.read();
    } catch {
      return emitBlocked(deps, "checkpoint-incompatible", "checkpoint-init");
    }
    if (resumed === null) {
      return emitBlocked(deps, "checkpoint-incompatible", "checkpoint-init");
    }
    // A durable `blocked` tombstone (from a prior NON-resumable abort) can never
    // be auto-resumed; recovery requires deliberate operator archival/removal.
    if (resumed.resumeState === "blocked") {
      return emitBlocked(deps, "checkpoint-blocked", "checkpoint-init");
    }
    // SEMANTIC (corpus-bound) validation against the ACTUAL fingerprint-bound
    // projection. A forged / internally inconsistent checkpoint is rejected
    // here, before any credential read or network I/O.
    try {
      validateResumableDiagnosticCheckpoint(resumed, projection);
    } catch {
      return emitBlocked(deps, "checkpoint-inconsistent", "checkpoint-init");
    }
  }

  // Recovery journal init (durable-first). Unrecovered ownership blocks.
  const journal = deps.makeJournal(defaultDiscoveryJournalDir(), origin);
  try {
    await journal.init();
  } catch {
    return emitBlocked(deps, "recovery-journal-unrecovered", "recovery-journal-init");
  }

  // ---- Seed run state (from the resumed checkpoint or fresh zeros). ----
  const startScenarioIndex = resumed?.nextScenarioIndex ?? 0;
  let nextScenarioIndex = startScenarioIndex;
  const runSegments = (resumed?.runSegments ?? 0) + 1;
  let attemptedRounds = resumed?.attemptedRounds ?? 0;
  let completedRounds = resumed?.completedRounds ?? 0;
  let completedScenarios = resumed?.completedScenarios ?? 0;
  let successfulScenarios = resumed?.successfulScenarios ?? 0;
  const cleanupState = {
    attempted: resumed?.cleanup.attempted ?? 0,
    deleted: resumed?.cleanup.deleted ?? 0,
    failed: resumed?.cleanup.failed ?? 0,
    journalFailures: resumed?.cleanup.journalFailures ?? 0,
  };
  const executedScenarioRounds: number[] = [...(resumed?.executedScenarioRounds ?? [])];

  // Committed value-free diagnostics: the resumed slice (rehydrated from the
  // compact ledger against the SAME projection the validator used) plus any new
  // commits this segment adds. A scenario's pending diagnostic commits only when
  // the whole scenario commits, so a mid-scenario abort discards it and the
  // scenario restarts cleanly on resume — no duplicates.
  const committedDiagnostics: TransitionDiagnostic[] = [];
  if (resumed !== null) {
    for (const d of rehydrateTransitionDiagnostics(resumed.diagnostics, projection)) {
      committedDiagnostics.push(d);
    }
  }

  const diagnosticsSnapshot = (): DiagnosticCheckpointEntry[] =>
    committedDiagnostics.map(
      (d) =>
        [
          d.caseOrdinal,
          d.roundOrdinal,
          EVAL_FAILURE_REASON_CODES[d.reason],
          ALLOWED_CALL_RELATION_CODES[d.allowedCallRelation],
          DIAGNOSTIC_SELECTION_SOURCE_CODES[d.selectionSource],
          DIAGNOSTIC_CALL_MULTIPLICITY_CODES[d.callMultiplicity],
        ] as DiagnosticCheckpointEntry,
    );

  const buildCheckpoint = (
    nextIdx: number,
    resumeState: "resumable" | "blocked",
    abort: { stage: AbortInfo["stage"]; reason: AbortInfo["reason"] } | null,
  ): DiagnosticCheckpointData => ({
    formatVersion: DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
    origin,
    authMode: "password",
    profile: DIAGNOSTIC_PROFILE,
    corpusFingerprint: fingerprint,
    resumeState,
    abort,
    nextScenarioIndex: nextIdx,
    runSegments,
    attemptedRounds,
    completedRounds,
    completedScenarios,
    successfulScenarios,
    cleanup: {
      attempted: cleanupState.attempted,
      deleted: cleanupState.deleted,
      failed: cleanupState.failed,
      journalFailures: cleanupState.journalFailures,
    },
    executedScenarioRounds: [...executedScenarioRounds],
    diagnostics: diagnosticsSnapshot(),
  });

  /**
   * Persist a RESUMABLE checkpoint at `nextIdx`; returns an abort on failure.
   *
   * A resumable checkpoint may NEVER encode a complete corpus: its own validator
   * rejects that cursor by design (a genuinely complete run removes its
   * checkpoint instead of resuming it), so writing one would leave a file the
   * next `--resume-approved` run refuses as inconsistent. The call sites keep the
   * final scenario's commit in memory for exactly this reason; the guard here
   * makes the invariant enforced rather than merely observed, and fails closed on
   * an impossible state instead of persisting a self-rejecting file.
   */
  const persistCheckpoint = (nextIdx: number): AbortInfo | null => {
    if (nextIdx >= scenarios.length) {
      throw new Error("diagnostic refused to persist a resumable complete-corpus cursor");
    }
    try {
      store.write(buildCheckpoint(nextIdx, "resumable", null));
      return null;
    } catch {
      return {
        reason: "checkpoint-persist-failed",
        stage: "checkpoint-persist",
        code: null,
        status: null,
        resumable: false,
      };
    }
  };

  /**
   * Persist a durable `blocked` tombstone for a NON-resumable abort so a later
   * `--resume-approved` run refuses to continue. Best-effort: `false` means the
   * write itself failed and the caller surfaces the persistence failure.
   */
  const persistBlocked = (abort: AbortInfo): boolean => {
    try {
      store.write(
        buildCheckpoint(nextScenarioIndex, "blocked", {
          stage: abort.stage,
          reason: abort.reason,
        }),
      );
      return true;
    } catch {
      return false;
    }
  };

  // Finalize the initialized recovery journal EXACTLY ONCE across every executed
  // and blocked path. Idempotent and value-free.
  let journalFinalizeAttempted = false;
  let journalFinalizeOk = true;
  const finalizeJournalOnce = async (): Promise<boolean> => {
    if (journalFinalizeAttempted) return journalFinalizeOk;
    journalFinalizeAttempted = true;
    try {
      await journal.finalize();
      journalFinalizeOk = true;
    } catch {
      journalFinalizeOk = false;
    }
    return journalFinalizeOk;
  };

  const cleanupTotals = (): CleanupTotals => ({
    attempted: cleanupState.attempted,
    deleted: cleanupState.deleted,
    failed: cleanupState.failed,
    remaining: cleanupState.attempted - cleanupState.deleted,
    journalFailures: cleanupState.journalFailures,
  });

  const emitProgress = (caseOrdinal: number, roundOrdinal: number): void => {
    deps.emit({
      version: DIAGNOSTIC_REPORT_VERSION,
      mode: "progress",
      profile: DIAGNOSTIC_PROFILE,
      origin,
      authMode: "password",
      runSegment: runSegments,
      caseOrdinal,
      roundOrdinal,
      plannedScenarios: scenarios.length,
      plannedUpstreamRounds,
      attemptedRounds,
      completedRounds,
      completedScenarios,
      cleanup: cleanupTotals(),
      checkpointPersisted: true,
    });
  };

  /**
   * The single, explicit finalization state machine shared by EVERY executed
   * path. Order: finalize the recovery journal exactly once → dispose the
   * diagnostic checkpoint (remove on complete success, persist a resumable
   * checkpoint for a resumable abort, else write a durable `blocked` tombstone)
   * → emit exactly one terminal pending-progress event, and ONLY after a durable
   * resumable checkpoint write → emit the final report.
   */
  const finalizeAndReport = async (
    loopAbort: AbortInfo | null,
    observedComplete: boolean,
    auth: AuthObservation | null,
    pendingProgress: PendingProgress | null = null,
  ): Promise<number> => {
    let aborted = loopAbort;

    const journalOk = await finalizeJournalOnce();
    if (!journalOk && (aborted === null || aborted.resumable)) {
      aborted = {
        reason: "recovery-journal-finalize-failed",
        stage: "recovery-journal-finalize",
        code: null,
        status: null,
        resumable: false,
      };
    }

    let finalized = false;
    let persistFailed = aborted?.stage === "checkpoint-persist";
    let resumableCheckpointPersisted = false;

    if (aborted === null && observedComplete) {
      // Complete, un-aborted run → remove ONLY the diagnostic checkpoint.
      try {
        store.delete();
        finalized = true;
      } catch {
        persistFailed = true;
        aborted = {
          reason: "checkpoint-finalize-failed",
          stage: "checkpoint-persist",
          code: null,
          status: null,
          resumable: false,
        };
      }
    }

    if (aborted !== null && aborted.resumable) {
      const persistAbort = persistCheckpoint(nextScenarioIndex);
      if (persistAbort !== null) {
        persistFailed = true;
        aborted = persistAbort; // now non-resumable (checkpoint-persist)
      } else {
        resumableCheckpointPersisted = true;
      }
    }

    if (aborted !== null && !aborted.resumable) {
      if (!persistBlocked(aborted)) persistFailed = true;
    }

    if (pendingProgress !== null && resumableCheckpointPersisted) {
      emitProgress(pendingProgress.caseOrdinal, pendingProgress.roundOrdinal);
    }

    const remaining = cleanupState.attempted - cleanupState.deleted;
    const cleanupClean =
      cleanupState.failed === 0 && remaining === 0 && cleanupState.journalFailures === 0;
    // `completed` describes the DIAGNOSTIC's own trustworthiness, never the
    // model's behavior: observed transition failures are the evidence, not an
    // error. It requires every planned scenario observed, no remaining abort,
    // clean cleanup, a successfully finalized journal, and a removed checkpoint.
    const completed =
      aborted === null &&
      observedComplete &&
      cleanupClean &&
      journalFinalizeOk &&
      finalized &&
      !persistFailed;

    const report: DiagnosticExecutedReport = {
      version: DIAGNOSTIC_REPORT_VERSION,
      mode: "executed",
      profile: DIAGNOSTIC_PROFILE,
      origin,
      authMode: "password",
      plannedScenarios: scenarios.length,
      globalOrdinalRange,
      plannedUpstreamRounds,
      attemptedRounds,
      completedRounds,
      completedScenarios,
      successfulScenarios,
      diagnostics: { failures: [...committedDiagnostics] },
      cleanup: cleanupTotals(),
      auth,
      checkpoint: {
        resumed: resumed !== null,
        resumeApproved: args.resumeApproved,
        startScenarioIndex,
        nextScenarioIndex,
        runSegments,
        finalized,
        persistFailed,
      },
      aborted,
      completed,
    };
    deps.emit(report);
    return completed ? 0 : 1;
  };

  // Write the initial checkpoint anchor BEFORE reading credentials: this verifies
  // writability up front and guarantees a resume anchor exists even if the very
  // first scenario aborts.
  {
    const anchorAbort = persistCheckpoint(startScenarioIndex);
    if (anchorAbort !== null) {
      // The journal was already initialized; finalize it EXACTLY ONCE through the
      // shared helper. A journal-finalize failure is its OWN closed blocked
      // reason, distinct from the anchor write failure. Nothing upstream ran.
      const journalOk = await finalizeJournalOnce();
      if (!journalOk) {
        return emitBlocked(deps, "recovery-journal-finalize-failed", "recovery-journal-finalize");
      }
      return emitBlocked(deps, "checkpoint-write-failed", "checkpoint-init");
    }
  }

  // ---- Credentials (after all preconditions). ----
  let provider: CollectivIQCredentialProvider;
  let authObservation: () => AuthObservation | null;
  try {
    const built = deps.buildProvider(deps.env, base);
    provider = built.provider;
    authObservation = built.authObservation;
  } catch {
    // Nothing upstream happened; the anchor checkpoint is intact and resumable.
    const aborted: AbortInfo = {
      reason: "credential-config-failed",
      stage: "credential-config",
      code: null,
      status: null,
      resumable: true,
    };
    return await finalizeAndReport(aborted, false, null);
  }

  const adapter = deps.makeAdapter(base, provider);
  const poller = createPoller(adapter);
  const deleter: BoundDeleter = (threadId, signal) =>
    deps.deleteThread(base, provider, threadId, signal);

  // Work signal (aborted on interruption) and an INDEPENDENT cleanup signal that
  // stays live so an interrupted round can still delete its recorded thread.
  const controller = new AbortController();
  const cleanupController = new AbortController();
  let interrupted = false;
  const removeInterrupt = deps.installInterruptHandler(() => {
    interrupted = true;
    controller.abort();
  });

  /**
   * Account a created-thread round's cleanup truthfully and return an abort (or
   * null to continue). Every created thread increments `attempted` and lands in
   * exactly one of `deleted`/`failed`; a journal-persistence failure is counted
   * separately and aborts even when the HTTP delete succeeded. This mirrors the
   * release evaluator's accounting exactly.
   */
  const accountCleanup = (step: LiveRoundResult): AbortInfo | null => {
    if (!step.created) {
      // createThread threw. The thread may or may not exist and no id is
      // available, so this is NOT resumable (an interruption here is ambiguous).
      return {
        reason: interrupted ? "interrupted-during-create" : "create-failed",
        stage: "create-thread",
        code: step.createFailureCode,
        status: step.createFailureStatus,
        resumable: false,
      };
    }
    cleanupState.attempted += 1;
    if (step.httpDeleted) cleanupState.deleted += 1;
    else cleanupState.failed += 1;
    if (step.recordCreatedFailed || step.recordDeletedFailed) cleanupState.journalFailures += 1;
    if (!step.httpDeleted) {
      return {
        reason: "cleanup-failed",
        stage: "cleanup-delete",
        code: step.deleteCode,
        status: step.deleteStatus,
        resumable: false,
      };
    }
    if (step.recordCreatedFailed) {
      return {
        reason: "journal-persistence-failed",
        stage: "recovery-journal-record-created",
        code: null,
        status: null,
        resumable: false,
      };
    }
    if (step.recordDeletedFailed) {
      return {
        reason: "journal-persistence-failed",
        stage: "recovery-journal-record-deleted",
        code: null,
        status: null,
        resumable: false,
      };
    }
    if (interrupted) {
      // Thread created + confirmed deleted + journal consistent → safe to resume.
      return {
        reason: "interrupted",
        stage: "interrupted",
        code: null,
        status: null,
        resumable: true,
      };
    }
    if (step.outcome === null) {
      // Submit/poll threw operationally; the thread was cleaned. Resumable after
      // the checkpoint durably persists at the current (non-advanced) cursor.
      return {
        reason: "round-execution-failed",
        stage: step.failureStage ?? "process-message",
        code: step.failureCode,
        status: step.failureStatus,
        resumable: true,
      };
    }
    completedRounds += 1;
    return null;
  };

  let aborted: AbortInfo | null = null;
  let segmentCompletions = 0;
  let pendingProgress: PendingProgress | null = null;

  try {
    for (let i = startScenarioIndex; i < scenarios.length; i += 1) {
      const scenario = scenarios[i];
      if (scenario === undefined) continue;
      const evalCase = scenario.evalCase;
      const caseOrdinal = scenario.caseOrdinal;
      // Interruption at a scenario boundary: nothing is in flight, so this is
      // safe to resume from the current cursor.
      if (interrupted) {
        aborted = {
          reason: "interrupted",
          stage: "interrupted",
          code: null,
          status: null,
          resumable: true,
        };
        break;
      }
      // Hard per-segment cap on upstream completions.
      if (segmentCompletions + evalCase.rounds.length > MAX_DIAGNOSTIC_UPSTREAM_ROUNDS) break;

      const compiled = compileToolset(evalCase.tools);
      if (!compiled.ok) {
        aborted = {
          reason: "toolset-compile-failed",
          stage: "toolset-compile",
          code: null,
          status: null,
          resumable: false,
        };
        break;
      }
      const toolset = compiled.toolset;

      const scenarioState = evalCase.scenarioState;
      if (scenarioState === undefined) {
        // `selectDiagnosticScenarios` already rejected this, but stay explicit.
        throw new Error("multi-step scenario is missing synthetic scenarioState");
      }
      const initialRound = evalCase.rounds[0];
      if (initialRound === undefined) continue;
      const expectedToolByRound = evalCase.rounds.map((round) => round.expectedTool);
      const runtimeState = initializeScenarioRuntime(scenarioState);
      // ONE initial user message states the whole goal; later rounds accumulate
      // ONLY through the accepted assistant `tool_calls` message and exactly
      // linked `role: "tool"` synthetic result messages. No fresh user
      // instruction is ever injected between tool results.
      const history: NormalizedMessage[] = [{ role: "user", content: initialRound.prompt }];
      // AT MOST ONE pending diagnostic: a scenario terminates at its first
      // terminal failure. Committed only when the whole scenario commits.
      const pendingScenarioDiagnostics: TransitionDiagnostic[] = [];
      // The tool names this scenario has ACTUALLY invoked in accepted rounds —
      // the execution history the diagnostic's prior/future buckets are judged
      // against. The round request enables parallel tool calls, so an accepted
      // round can invoke several tools and static round position does not
      // describe what has run. It is scenario-local (discarded when the scenario
      // ends), affects ONLY diagnostic classification, and its names never leave
      // the process. A round's own calls are added only AFTER that round is
      // accepted and its transcript re-validates.
      const priorInvokedNames = new Set<string>();
      let scenarioOk = true;
      let scenarioAbort: AbortInfo | null = null;
      let executedRounds = 0;
      let terminated = false;

      for (let r = 0; r < evalCase.rounds.length; r += 1) {
        const round = evalCase.rounds[r];
        if (round === undefined) break;
        if (interrupted) {
          scenarioAbort = {
            reason: "interrupted",
            stage: "interrupted",
            code: null,
            status: null,
            resumable: true,
          };
          break;
        }
        attemptedRounds += 1;
        segmentCompletions += 1;
        executedRounds += 1;
        const request = buildRoundRequest(evalCase.tools, round.choice, history);
        const step = await runLiveRound(
          adapter,
          poller,
          deleter,
          journal,
          request,
          evalCase.selectedLlms,
          controller.signal,
          cleanupController.signal,
        );
        const stepAbort = accountCleanup(step);
        if (stepAbort !== null) {
          // A resumable abort here means this round's thread was created AND
          // confirmed deleted with no journal failure (a cleaned attempt);
          // record its terminal progress for emission after the resumable
          // checkpoint persists.
          if (stepAbort.resumable) {
            pendingProgress = { caseOrdinal, roundOrdinal: r + 1 };
          }
          scenarioAbort = stepAbort;
          break;
        }
        const decision = classifyDiagnosticDecision(
          step.outcome,
          toolset,
          round,
          evalCase.selectedLlms,
        );
        // The RELEASE evaluator's own classifier, reused verbatim, so the
        // diagnostic's terminal-failure precedence can never drift from the
        // behavior it is explaining.
        let reason = classifyRoundFailure(decision, round.expectedTool !== undefined);
        // This round's selected names, held back until the round is fully
        // accepted. They join `priorInvokedNames` only after the terminal-failure
        // check below, so the failing round is always classified against the
        // history that existed BEFORE it ran.
        let acceptedCallNames: readonly string[] | null = null;
        if (round.expectedTool !== undefined) {
          const nameOk = expectedCallNameOk(decision);
          if (!nameOk) {
            scenarioOk = false;
          } else if (decision.kind === "tool_calls") {
            history.push({
              role: "assistant",
              content: null,
              toolCalls: decision.calls.map((call) => ({
                id: call.id,
                name: call.name,
                argumentsJson: call.argumentsJson,
              })),
            });
            for (const call of decision.calls) {
              history.push({
                role: "tool",
                content: renderSyntheticToolResult(call, scenarioState, runtimeState),
                toolCallId: call.id,
              });
            }
            if (!transcriptValid(history, evalCase.tools)) {
              scenarioOk = false;
              if (reason === null) reason = "transcript-invalid";
            } else {
              acceptedCallNames = decision.calls.map((call) => call.name);
            }
          }
        } else if (decision.kind !== "text") {
          scenarioOk = false;
        }
        if (reason !== null) {
          const projectedChoiceKind = projection.scenarios[i]?.rounds[r]?.choiceKind;
          if (projectedChoiceKind === undefined) {
            throw new Error("diagnostic references a scenario/round outside the corpus projection");
          }
          pendingScenarioDiagnostics.push(
            buildTransitionDiagnostic(
              caseOrdinal,
              r + 1,
              projectedChoiceKind,
              reason,
              decision,
              expectedToolByRound,
              priorInvokedNames,
            ),
          );
          // Truthful early termination: this scenario cannot represent a real
          // read → edit → test → final loop from here, so stop issuing upstream
          // rounds and fabricate no cascade diagnostics for rounds that never
          // ran.
          terminated = true;
          break;
        }
        // The round was ACCEPTED: its calls become part of the scenario's
        // invocation history for every later round's classification.
        if (acceptedCallNames !== null) {
          for (const name of acceptedCallNames) priorInvokedNames.add(name);
        }
        // Persist per-round so cleanup counters are durable, but ONLY for
        // non-final rounds: the scenario cursor and its commit measurements do
        // not advance until the scenario completes, so a persist AFTER the final
        // round would record a completed-round counter one full scenario above
        // the still-unadvanced cursor's committed floor — i.e. a checkpoint that
        // its own resumable ceiling would reject. The scenario-commit persist
        // immediately below covers that round instead. Progress is emitted only
        // after the durable write, and the scenario-end event below is the single
        // completion record for this scenario.
        if (r < evalCase.rounds.length - 1) {
          const persistAbort = persistCheckpoint(nextScenarioIndex);
          if (persistAbort !== null) {
            scenarioAbort = persistAbort;
            break;
          }
          emitProgress(caseOrdinal, r + 1);
        }
      }

      if (scenarioAbort !== null) {
        aborted = scenarioAbort;
        break;
      }
      // Whole scenario committed (completed OR terminated early at a terminal
      // failure). Commit its diagnostic and counters together, atomically.
      for (const d of pendingScenarioDiagnostics) committedDiagnostics.push(d);
      completedScenarios += 1;
      if (scenarioOk && !terminated) successfulScenarios += 1;
      executedScenarioRounds.push(executedRounds);
      nextScenarioIndex = i + 1;
      // The FINAL scenario's commit stays in memory. Persisting it would write
      // `nextScenarioIndex === scenarios.length`, a cursor the resumable
      // validator rejects by design — so a stop between that write and the
      // successful checkpoint removal would leave the diagnostic rejecting its
      // OWN checkpoint on the next approved resume. Instead the last durable
      // checkpoint keeps pointing at this final scenario, which an approved
      // resume safely replays, and finalization below removes the checkpoint on
      // success. No progress record is emitted for the final scenario either,
      // because none was persisted.
      if (nextScenarioIndex < scenarios.length) {
        const persistAbort = persistCheckpoint(nextScenarioIndex);
        if (persistAbort !== null) {
          aborted = persistAbort;
          break;
        }
        emitProgress(caseOrdinal, executedRounds);
      }
    }
  } finally {
    removeInterrupt();
  }

  const observedComplete = aborted === null && nextScenarioIndex >= scenarios.length;
  return await finalizeAndReport(aborted, observedComplete, authObservation(), pendingProgress);
}

/* c8 ignore start — the production entry point is never exercised hermetically. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runToolsDiagnostic(defaultToolsDiagnosticDeps())
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // Value-free: never surface the thrown value.
      process.stderr.write("eval:tools:diagnose failed (internal error)\n");
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
