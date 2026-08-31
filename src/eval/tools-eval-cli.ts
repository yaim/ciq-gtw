/**
 * Approval-gated LIVE tool-calling evaluator (`npm run eval:tools`,
 * specification section 30).
 *
 * This measures the section-30 emulated-tool release gates against the REAL
 * CollectivIQ production origin. It is EXPERIMENTAL and destructive-capable, so
 * it is heavily gated and MUST NOT be run without explicit approval. It is
 * excluded from `validate`/CI and from every automated suite.
 *
 * Safety contract (mirrors the discovery/recovery CLIs):
 *  - The DEFAULT invocation is a credential-free, network-free PREFLIGHT: it
 *    reports the fixed origin, the fixed case plan, and the required approvals,
 *    reading no credential, opening no socket, and touching no journal or
 *    checkpoint.
 *  - The destination origin ({@link EVAL_ORIGIN}) is a module constant and is
 *    NOT part of the injectable deps surface, so a test can never broaden it.
 *  - Live execution requires ALL of `--execute-approved`, `--cost-approved`
 *    (cost / thread creation), `--cleanup-approved`, and
 *    `--recovery-journal-approved`. A resume additionally requires
 *    `--resume-approved`.
 *  - Only `password` auth mode is used.
 *  - Cases run SEQUENTIALLY. Exactly {@link SINGLE_ROUND_CASES} single-round and
 *    {@link MULTI_STEP_SCENARIOS} three-step scenarios, with a HARD per-segment
 *    cap of {@link MAX_UPSTREAM_COMPLETIONS} upstream completions.
 *  - Content is synthetic only — never repository content.
 *  - Each created thread is deleted IMMEDIATELY after its request finishes, and
 *    every created id is recorded in a private, ID-only recovery journal
 *    (dropped only after a confirmed delete). A cleanup failure ABORTS the run.
 *  - The output is a versioned, value-free UNION (preflight / progress / blocked
 *    / executed). Threshold gates carry explicit numerators, denominators, and
 *    the planned denominator a COMPLETE run requires, and a four-state
 *    {@link GateStatus} so a partial run can never read as passed. It never emits
 *    credentials, prompts, answers, schemas, arguments, titles, thread ids, run
 *    ids, model ids, or journal/checkpoint contents.
 *  - A fully-cleaned but operationally-aborted run persists a private, content-
 *    free CHECKPOINT so a later explicitly-approved `--resume-approved`
 *    invocation continues without replaying any upstream POST. A create-stage
 *    interruption is ambiguous and reported non-resumable.
 *  - The journal and checkpoint live under the ignored `.agent/sessions/` tree;
 *    they are never committed.
 *
 * Passing every gate here would still leave emulated tool mode EXPERIMENTAL: a
 * later failing run keeps the feature non-default and unreleased.
 */
import { pathToFileURL } from "node:url";
import {
  buildCredentialProviderFromEnv,
  CLI_MAX_LOGINS,
  type AuthObservation,
} from "../collectiviq/auth.js";
import { CollectivIQHttpAdapter } from "../collectiviq/adapter.js";
import { observeThreadDeletion, type DeleteDiagnostics } from "../collectiviq/cleanup.js";
import {
  DEFAULT_OPERATION_TIMEOUTS,
  type CollectivIQAdapter,
  type CollectivIQCredentialProvider,
  type CollectivIQTransportConfig,
  type TransportBase,
  type UpstreamMessage,
} from "../collectiviq/types.js";
import {
  defaultDiscoveryJournalDir,
  FileRecoveryJournal,
  type RecoveryJournalSink,
} from "../collectiviq/recovery-journal.js";
import { createPoller } from "../generation/polling.js";
import type { PollOutcome } from "../generation/types.js";
import { selectGeneration, type SourceCandidate } from "../tools/select.js";
import { compileToolset, type CompiledToolset } from "../tools/schema.js";
import { createToolCallIdGenerator } from "../tools/ids.js";
import { parseToolEnvelope } from "../tools/protocol.js";
import { normalizeToolRequest, type ProbedField } from "../tools/request.js";
import type { NormalizedMessage } from "../openai/chat-types.js";
import type { NormalizedTool, NormalizedToolChoice, ParsedToolCall } from "../tools/types.js";
import {
  buildRoundRequest,
  runLiveRound,
  type BoundDeleter,
  type LiveRoundResult,
} from "./live-round.js";
import {
  buildEvalCases,
  buildEvalCorpusProjection,
  corpusFingerprint,
  evalPlan,
  SINGLE_ROUND_CASES,
  MULTI_STEP_SCENARIOS,
  MAX_UPSTREAM_COMPLETIONS,
  type EvalCorpusProjection,
} from "./cases.js";
import {
  applyToolCallBatch,
  assertCorpusMatchesEngine,
  creditPendingStep,
  creditSatisfiedStep,
  expectedStepTool,
  initializeScenarioTransitions,
  initializeStepEvidence,
  pendingStepIndex,
  satisfiedStepCount,
  stepMask,
} from "./scenario-engine.js";
import {
  CHECKPOINT_FORMAT_VERSION,
  checkpointExists,
  deleteCheckpoint,
  defaultCheckpointLocation,
  readCheckpoint,
  rehydrateDiagnosticFailures,
  validateResumableCheckpoint,
  writeCheckpoint,
  type CheckpointData,
  type CheckpointDiagnosticFailure,
  type CheckpointScenarioEvidence,
} from "./checkpoint.js";
import {
  EVAL_FAILURE_REASON_CODES,
  EVAL_REPORT_VERSION,
  invariantGate,
  thresholdGate,
  type AbortInfo,
  type AbortStage,
  type BlockedReason,
  type CleanupTotals,
  type EvalFailureDiagnostic,
  type EvalFailureReason,
  type EvalOutput,
  type ExecutedReport,
  type GateStatus,
  type PreflightReport,
} from "./report.js";

/** The FIXED CollectivIQ production origin. Never injectable. */
export const EVAL_ORIGIN = "https://api.prod.collectiviq.ai";
/** The evaluator only ever authenticates in password mode. */
export const EVAL_AUTH_MODE = "password" as const;

/** Section-30 threshold percentages (spec §30, gates 1–5). */
const THRESHOLD = {
  schemaValidity: 95,
  toolNameAccuracy: 98,
  argValidity: 95,
  singleRoundSuccess: 90,
  multiStepSuccess: 85,
} as const;

/** The closed set of approval flags. Any other argument is an error. */
export interface EvalArgs {
  readonly executeApproved: boolean;
  readonly costApproved: boolean;
  readonly cleanupApproved: boolean;
  readonly recoveryJournalApproved: boolean;
  readonly resumeApproved: boolean;
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
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

export function buildPreflightReport(args: EvalArgs): PreflightReport {
  const given: string[] = [];
  if (args.executeApproved) given.push("--execute-approved");
  if (args.costApproved) given.push("--cost-approved");
  if (args.cleanupApproved) given.push("--cleanup-approved");
  if (args.recoveryJournalApproved) given.push("--recovery-journal-approved");
  if (args.resumeApproved) given.push("--resume-approved");
  return {
    version: EVAL_REPORT_VERSION,
    mode: "preflight",
    origin: EVAL_ORIGIN,
    authMode: EVAL_AUTH_MODE,
    plannedSingleRoundCases: SINGLE_ROUND_CASES,
    plannedMultiStepScenarios: MULTI_STEP_SCENARIOS,
    plannedUpstreamRounds: MAX_UPSTREAM_COMPLETIONS,
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
export interface BuiltProvider {
  readonly provider: CollectivIQCredentialProvider;
  /** Value-free password-auth observation for the report, or null. */
  readonly authObservation: () => AuthObservation | null;
}

/** The private, content-free resume checkpoint store (injected for hermetic tests). */
export interface CheckpointStore {
  /** Read + validate an existing checkpoint (origin + fingerprint), or null. */
  read(): CheckpointData | null;
  /** Whether a checkpoint file is present (even if unreadable/incompatible). */
  exists(): boolean;
  /** Durably persist the checkpoint. */
  write(data: CheckpointData): void;
  /** Remove the checkpoint (finalization). */
  delete(): void;
}

/** The injectable orchestration seam (production omits every override). */
export interface ToolsEvalDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly buildProvider: (env: NodeJS.ProcessEnv, base: TransportBase) => BuiltProvider;
  readonly makeAdapter: (
    base: TransportBase,
    provider: CollectivIQCredentialProvider,
  ) => CollectivIQAdapter;
  /** Delete one thread; resolves value-free {@link DeleteDiagnostics} (2xx-only ok). */
  readonly deleteThread: (
    base: TransportBase,
    provider: CollectivIQCredentialProvider,
    threadId: string,
    signal: AbortSignal,
  ) => Promise<DeleteDiagnostics>;
  readonly makeJournal: (dir: string, origin: string) => RecoveryJournalSink;
  readonly makeCheckpointStore: (origin: string, corpusFingerprint: string) => CheckpointStore;
  /** Install first-SIGINT/SIGTERM interruption; returns a remover. */
  readonly installInterruptHandler: (onInterrupt: () => void) => () => void;
  readonly emit: (output: EvalOutput) => void;
}

/** Production deps: password provider + real adapter + bounded DELETE + file journal. */
export function defaultToolsEvalDeps(): ToolsEvalDeps {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    buildProvider: (env, base) => {
      const resolved = buildCredentialProviderFromEnv(env, base, { maxLogins: CLI_MAX_LOGINS });
      if (resolved.mode !== "password") {
        throw new Error("eval:tools requires COLLECTIVIQ_AUTH_MODE=password");
      }
      const passwordProvider = resolved.passwordProvider;
      return {
        provider: resolved.provider,
        // Value-free observation confined to the concrete password provider; never
        // inspects the provider's internals unsafely.
        authObservation: () => (passwordProvider ? passwordProvider.authObservation() : null),
      };
    },
    makeAdapter: (base, provider) =>
      new CollectivIQHttpAdapter({ baseUrl: base.baseUrl, credentials: provider }),
    // Bounded, real, single-attempt DELETE against the FIXED origin, reusing the
    // resolved password credential provider and the same transport bounds every
    // other DELETE call site uses (`DEFAULT_OPERATION_TIMEOUTS.getMessages`), with
    // caller cancellation honored. It performs exactly ONE DELETE (no internal
    // retry) and returns value-free {@link DeleteDiagnostics} whose `ok` is true
    // ONLY on a real HTTP 2xx — a non-2xx, transport failure, or timeout is
    // `ok: false` and never surfaces an id, URL, body, credential, or exception
    // text. This path is still only reached on the fully-approved executed run.
    deleteThread: (base, provider, threadId, signal) => {
      const config: CollectivIQTransportConfig = {
        baseUrl: base.baseUrl,
        credentials: provider,
        ...(base.fetch ? { fetch: base.fetch } : {}),
      };
      return observeThreadDeletion(
        config,
        threadId,
        DEFAULT_OPERATION_TIMEOUTS.getMessages,
        signal,
      );
    },
    makeJournal: (dir, origin) => new FileRecoveryJournal(dir, origin),
    makeCheckpointStore: (origin, fingerprint) => {
      const loc = defaultCheckpointLocation();
      return {
        read: () => readCheckpoint(loc, { origin, corpusFingerprint: fingerprint }),
        exists: () => checkpointExists(loc),
        write: (data) => writeCheckpoint(loc, data),
        delete: () => deleteCheckpoint(loc),
      };
    },
    installInterruptHandler: (onInterrupt) => {
      let fired = false;
      const handler = (): void => {
        if (fired) return;
        fired = true;
        // Remove our handlers so a SECOND signal uses Node's default (terminate);
        // the ID-only recovery journal remains the final recovery mechanism.
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
        onInterrupt();
      };
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
    emit: (output) => process.stdout.write(`${JSON.stringify(output)}\n`),
  };
}

/**
 * A round's classified generation (value-free; records no name, argument, or
 * text). Exported for the classifier's hermetic unit coverage — production
 * callers still get it through `classifyDecision` and never construct one
 * manually.
 */
export type RoundDecision =
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly ParsedToolCall[];
      readonly expectedInvoked: boolean;
      readonly allAllowed: boolean;
      readonly unauthorized: boolean;
    }
  | { readonly kind: "text" } // selection produced ordinary final text
  | { readonly kind: "no_valid_call" } // required/named with no valid call (structured error)
  | { readonly kind: "unavailable" }; // timeout / transport failure (no usable outcome)

/**
 * Classify a poll outcome by running the real selection engine. Never throws.
 *
 * `expectedTool` is supplied by the CALLER rather than read from the round,
 * because a multi-step scenario's expectation comes from its successfully
 * completed transitions (`src/eval/scenario-engine.ts`), not from the tool
 * named at the round's ordinal. A single-round case passes its own
 * `round.expectedTool` and behaves exactly as before.
 */
function classifyDecision(
  outcome: PollOutcome | null,
  toolset: CompiledToolset,
  choice: NormalizedToolChoice,
  expectedTool: string | undefined,
  selectedLlms: readonly string[],
): RoundDecision {
  if (outcome === null || outcome.kind === "timeout") return { kind: "unavailable" };
  const individuals: SourceCandidate[] = outcome.messages
    .filter((m): m is UpstreamMessage & { content: string } => typeof m.content === "string")
    .map((m) => ({ source: m.source, content: m.content, percentUsage: m.percentUsage ?? null }));
  let selection;
  try {
    selection = selectGeneration({
      desired: { content: outcome.content },
      individuals,
      toolset,
      choice,
      parallelToolCalls: true,
      selectedLlms,
      idGen: createToolCallIdGenerator(),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (!selection.ok) return { kind: "no_valid_call" };
  if (selection.generation.kind === "text") return { kind: "text" };
  const calls = selection.generation.calls;
  const allAllowed = calls.every((call) => toolset.has(call.name));
  const expectedInvoked =
    expectedTool === undefined ? true : calls.some((call) => call.name === expectedTool);
  return { kind: "tool_calls", calls, expectedInvoked, allAllowed, unauthorized: !allAllowed };
}

/** Whether an expected-tool-call round produced the correct allowed call (pure). */
function expectedCallNameOk(decision: RoundDecision): boolean {
  return decision.kind === "tool_calls" && decision.allAllowed && decision.expectedInvoked;
}

/**
 * Deterministically classify a scored round into AT MOST ONE primary
 * value-free failure reason, following the fixed precedence in
 * `.agent/instructions/tool-calling.md` / spec §30. Returns `null` when the
 * round scored acceptably (no diagnostic needed) or when transcript-linkage
 * needs to be checked separately by the caller.
 *
 * For a round WITH `expectedTool`, the precedence is:
 *   1. `unavailable`          → `expected-tool-unavailable`
 *   2. `no_valid_call`        → `expected-tool-no-valid-call`
 *   3. `text`                 → `expected-tool-returned-text`
 *   4. tool_calls + unauthorized → `unauthorized-tool-call`
 *   5. tool_calls but expected not invoked → `expected-tool-not-invoked`
 *   6. tool_calls + expected-invoked → `null` (caller checks transcript
 *      linkage; a linkage failure becomes `transcript-invalid`)
 *
 * For a FINAL round (no `expectedTool`):
 *   1. `text`                 → `null` (the correct outcome)
 *   2. `unavailable`          → `final-unavailable`
 *   3. `no_valid_call`        → `final-no-valid-call`
 *   4. tool_calls + unauthorized → `unauthorized-tool-call`
 *   5. any other tool_calls   → `unexpected-tool-call-on-final`
 *
 * The classifier reads only kind + boolean flags — never a prompt/answer, tool
 * name, argument, id, or credential — so it produces no content leakage.
 */
export function classifyRoundFailure(
  decision: RoundDecision,
  hasExpectedTool: boolean,
): EvalFailureReason | null {
  if (hasExpectedTool) {
    if (decision.kind === "unavailable") return "expected-tool-unavailable";
    if (decision.kind === "no_valid_call") return "expected-tool-no-valid-call";
    if (decision.kind === "text") return "expected-tool-returned-text";
    if (decision.unauthorized) return "unauthorized-tool-call";
    if (!decision.expectedInvoked) return "expected-tool-not-invoked";
    return null;
  }
  if (decision.kind === "text") return null;
  if (decision.kind === "unavailable") return "final-unavailable";
  if (decision.kind === "no_valid_call") return "final-no-valid-call";
  if (decision.unauthorized) return "unauthorized-tool-call";
  return "unexpected-tool-call-on-final";
}

/**
 * Build one value-free {@link EvalFailureDiagnostic} from the fingerprint-bound
 * corpus projection. `phase` and `choiceKind` are read directly from the
 * projection — never inferred and never taken from a round's runtime state —
 * and the projection is already narrowed to the closed diagnostic union
 * `"auto" | "required" | "function"` at build time, so no fallback or silent
 * relabel is ever needed. Fails closed when the case/round is outside the
 * projection (defense in depth for a fresh run; a resumed run is already
 * covered by `validateResumableCheckpoint`).
 */
function buildScenarioDiagnostic(
  projection: EvalCorpusProjection,
  caseIndex: number,
  roundIndex: number,
  reason: EvalFailureReason,
): EvalFailureDiagnostic {
  const projectedCase = projection.cases[caseIndex];
  const projectedChoiceKind = projectedCase?.rounds[roundIndex]?.choiceKind;
  if (projectedCase === undefined || projectedChoiceKind === undefined) {
    throw new Error("eval diagnostic references a case/round outside the corpus projection");
  }
  return {
    phase: projectedCase.phase,
    caseOrdinal: caseIndex + 1,
    roundOrdinal: roundIndex + 1,
    choiceKind: projectedChoiceKind,
    reason,
  };
}

/**
 * Re-validate an accumulated multi-step transcript through the real tool-request
 * normalizer (id uniqueness, declared names, schema-valid arguments, and
 * exactly-one linked result per call).
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
 * Locally measured parser-determinism check (specification section 30 gate 8).
 * Parses a fixed set of representative envelopes repeatedly and confirms byte-for-
 * byte identical results. Pure and local (no network).
 */
function measureParserDeterminism(): boolean {
  const compiled = compileToolset([
    {
      name: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ]);
  if (!compiled.ok) return false;
  const opts = {
    toolset: compiled.toolset,
    choice: { kind: "auto" } as NormalizedToolChoice,
    parallelToolCalls: true,
  };
  const samples = [
    JSON.stringify({
      gateway_protocol: "1.0",
      type: "tool_calls",
      calls: [{ name: "read", arguments: { path: "a" } }],
    }),
    JSON.stringify({ gateway_protocol: "1.0", type: "final", content: "done" }),
    "not a valid envelope at all",
    "```json\n" +
      JSON.stringify({ gateway_protocol: "1.0", type: "final", content: "x" }) +
      "\n```",
    JSON.stringify({
      gateway_protocol: "1.0",
      type: "tool_calls",
      calls: [{ name: "unknown", arguments: {} }],
    }),
  ];
  for (const raw of samples) {
    const first = JSON.stringify(parseToolEnvelope(raw, opts));
    for (let i = 0; i < 4; i += 1) {
      if (JSON.stringify(parseToolEnvelope(raw, opts)) !== first) return false;
    }
  }
  return true;
}

/**
 * A bounded, value-free descriptor of a cleaned-but-uncommitted terminal round
 * whose resumable abort left the loop before it could emit its own progress
 * event (finding 3). It carries ONLY the attempted round's phase and 1-based case/
 * round ordinals; it never claims the case cursor advanced. It is emitted exactly
 * once, AFTER the resumable checkpoint durably persists.
 */
interface PendingProgress {
  readonly phase: "single" | "multi";
  readonly caseOrdinal: number;
  readonly roundOrdinal: number;
}

/** Emit a value-free blocked (pre-execution precondition) report and return code 1. */
function emitBlocked(deps: ToolsEvalDeps, reason: BlockedReason, stage: AbortStage): number {
  deps.emit({
    version: EVAL_REPORT_VERSION,
    mode: "blocked",
    origin: EVAL_ORIGIN,
    authMode: EVAL_AUTH_MODE,
    reason,
    stage,
  });
  return 1;
}

/**
 * Run the evaluator. Preflight by default; the fully-approved path executes the
 * bounded live gate suite. Returns a process exit code (0 = complete + passing).
 */
export async function runToolsEval(deps: ToolsEvalDeps): Promise<number> {
  const args = parseEvalArgs(deps.argv);

  // DEFAULT: preflight only — no credential, no network, no journal, no checkpoint.
  if (!args.executeApproved) {
    deps.emit(buildPreflightReport(args));
    return 0;
  }
  if (!args.costApproved || !args.cleanupApproved || !args.recoveryJournalApproved) {
    throw new Error(
      "eval:tools execution requires --execute-approved --cost-approved --cleanup-approved --recovery-journal-approved",
    );
  }

  const origin = EVAL_ORIGIN;
  // Build the fingerprint-bound corpus EXACTLY ONCE per run and derive
  // fingerprint, plan, projection, and the executed case loop from THIS
  // `cases` value (finding 1). This is the single source of truth: the
  // fingerprint the checkpoint records, the plan's denominators, the
  // projection the validator + rehydrator + fresh-diagnostic constructor
  // trust, and the case iteration below all read from the SAME array
  // instance, so no divergent rebuilt corpus can slip into the executed
  // path. `buildEvalCorpusProjection` also fails closed at build if any
  // round's `choice.kind` is outside the diagnostic union `"auto" |
  // "required" | "function"` (finding 2), so no downstream path needs a
  // silent `"none" → "auto"` fallback.
  const cases = buildEvalCases();
  // Fail closed if the corpus and the shared transition engine disagree about
  // how many transitions a multi-step scenario plans. The runner scores against
  // the engine's fixed workflow while checkpoint validation derives each case's
  // planned step count from its own rounds, so a mismatch would let a truthful
  // run persist evidence its own validator rejects. Checked here, before any
  // credential read or network I/O.
  assertCorpusMatchesEngine(cases);
  const fingerprint = corpusFingerprint(cases);
  const plan = evalPlan(cases);
  const projection = buildEvalCorpusProjection(cases);
  const base: TransportBase = { baseUrl: origin };
  const store = deps.makeCheckpointStore(origin, fingerprint);

  // ---- Preconditions, ALL before any credential read or network I/O. ----

  // (1) Checkpoint precondition. An existing checkpoint requires an explicit
  //     resume approval; an incompatible checkpoint (version/origin/auth/corpus
  //     fingerprint) fails closed. A resume flag with no checkpoint starts fresh.
  let checkpointPresent: boolean;
  try {
    checkpointPresent = store.exists();
  } catch {
    return emitBlocked(deps, "checkpoint-read-failed", "checkpoint-init");
  }
  if (checkpointPresent && !args.resumeApproved) {
    return emitBlocked(deps, "checkpoint-resume-not-approved", "checkpoint-init");
  }
  let resumed: CheckpointData | null = null;
  if (checkpointPresent) {
    try {
      resumed = store.read();
    } catch {
      return emitBlocked(deps, "checkpoint-incompatible", "checkpoint-init");
    }
    if (resumed === null) {
      // Present at exists() but unreadable/absent at read(): fail closed.
      return emitBlocked(deps, "checkpoint-incompatible", "checkpoint-init");
    }
    // A durable `blocked` tombstone (from a prior NON-resumable abort) can never
    // be auto-resumed; recovery requires deliberate operator archival/removal.
    if (resumed.resumeState === "blocked") {
      return emitBlocked(deps, "checkpoint-blocked", "checkpoint-init");
    }
    // SEMANTIC (corpus-bound) validation against the ACTUAL fingerprint-bound
    // corpus projection (finding 2): a forged / internally-inconsistent
    // checkpoint — including any claim of a complete + passing corpus, and any
    // diagnostic entry referencing a round that does not exist in the corpus
    // or whose reason is structurally incompatible with the ACTUAL round — is
    // rejected here, before any credential read or network I/O, so it can
    // never produce a zero-network executed pass.
    try {
      validateResumableCheckpoint(resumed, projection);
    } catch {
      return emitBlocked(deps, "checkpoint-inconsistent", "checkpoint-init");
    }
  }

  // (2) Recovery journal init (durable-first). Unrecovered ownership blocks.
  const journal = deps.makeJournal(defaultDiscoveryJournalDir(), origin);
  try {
    await journal.init();
  } catch {
    return emitBlocked(deps, "recovery-journal-unrecovered", "recovery-journal-init");
  }

  // ---- Seed run state (from the resumed checkpoint or fresh zeros). ----
  const startCaseIndex = resumed?.nextCaseIndex ?? 0;
  let nextCaseIndex = startCaseIndex;
  const runSegments = (resumed?.runSegments ?? 0) + 1;
  let attemptedRounds = resumed?.attemptedRounds ?? 0;
  let completedRounds = resumed?.completedRounds ?? 0;
  let completedSingle = resumed?.completedSingleRoundCases ?? 0;
  let completedMulti = resumed?.completedMultiStepScenarios ?? 0;
  const expectedCall = {
    total: resumed?.gates.expectedCall.total ?? 0,
    schemaValid: resumed?.gates.expectedCall.schemaValid ?? 0,
    nameAccurate: resumed?.gates.expectedCall.nameAccurate ?? 0,
    argValid: resumed?.gates.expectedCall.argValid ?? 0,
  };
  const single = {
    total: resumed?.gates.single.total ?? 0,
    success: resumed?.gates.single.success ?? 0,
  };
  const multi = {
    total: resumed?.gates.multi.total ?? 0,
    success: resumed?.gates.multi.success ?? 0,
  };
  const cleanupState = {
    attempted: resumed?.cleanup.attempted ?? 0,
    deleted: resumed?.cleanup.deleted ?? 0,
    failed: resumed?.cleanup.failed ?? 0,
    journalFailures: resumed?.cleanup.journalFailures ?? 0,
  };
  let noSilentFallback = resumed?.invariants.noSilentFallback ?? true;
  let injectionResistance = resumed?.invariants.injectionResistance ?? true;
  // Per-committed-multi-step-scenario evidence, appended once per committed
  // multi scenario in commit order (spec §30 state-aware accounting). Each
  // tuple is `[executedRounds, satisfiedSteps, schemaMask, nameMask, argMask]`;
  // `.length` equals `completedMulti` at every persistence boundary. It carries
  // ONLY counts and bitmasks — never a tool name, argument, or prompt.
  const scenarioEvidence: CheckpointScenarioEvidence[] = [...(resumed?.scenarioEvidence ?? [])];

  // Committed value-free failure diagnostics, both the resumed slice (rehydrated
  // from the compact on-disk ledger) and any new commits this segment will add.
  // The array is bounded by the fixed 280-round corpus (there is one entry per
  // FAILED committed round, at most). Multi-step scenarios accumulate their
  // rounds' diagnostics locally and commit here only when the whole scenario
  // commits; a mid-scenario abort discards those pending entries.
  const committedDiagnostics: EvalFailureDiagnostic[] = [];
  if (resumed !== null) {
    // The projection above is the SAME projection the validator used, so a
    // rehydrated entry's `phase` and `choiceKind` come directly from the
    // actual case/round and cannot silently disagree with validation.
    const rehydrated = rehydrateDiagnosticFailures(resumed.diagnosticFailures, projection);
    for (const d of rehydrated) committedDiagnostics.push(d);
  }

  /** Snapshot the committed ledger into the compact on-disk representation. */
  const diagnosticFailuresSnapshot = (): CheckpointDiagnosticFailure[] =>
    committedDiagnostics.map(
      (d) =>
        [d.caseOrdinal, d.roundOrdinal, EVAL_FAILURE_REASON_CODES[d.reason]] as [
          number,
          number,
          number,
        ],
    );

  const buildCheckpoint = (
    nextIdx: number,
    resumeState: "resumable" | "blocked",
    abort: { stage: AbortInfo["stage"]; reason: AbortInfo["reason"] } | null,
  ): CheckpointData => ({
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    origin,
    authMode: "password",
    corpusFingerprint: fingerprint,
    resumeState,
    abort,
    nextCaseIndex: nextIdx,
    runSegments,
    attemptedRounds,
    completedRounds,
    completedSingleRoundCases: completedSingle,
    completedMultiStepScenarios: completedMulti,
    cleanup: {
      attempted: cleanupState.attempted,
      deleted: cleanupState.deleted,
      failed: cleanupState.failed,
      journalFailures: cleanupState.journalFailures,
    },
    gates: {
      expectedCall: { ...expectedCall },
      single: { ...single },
      multi: { ...multi },
    },
    invariants: { noSilentFallback, injectionResistance },
    scenarioEvidence: scenarioEvidence.map(
      (entry) => [...entry] as unknown as CheckpointScenarioEvidence,
    ),
    diagnosticFailures: diagnosticFailuresSnapshot(),
  });

  /** Persist a RESUMABLE checkpoint at `nextIdx`; returns an abort on failure. */
  const persistCheckpoint = (nextIdx: number): AbortInfo | null => {
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
   * `--resume-approved` run refuses to continue. Best-effort: returns `true` on a
   * durable write, `false` when the write itself failed (the caller keeps the
   * report non-resumable and surfaces the checkpoint persistence failure).
   */
  const persistBlocked = (abort: AbortInfo): boolean => {
    try {
      store.write(
        buildCheckpoint(nextCaseIndex, "blocked", { stage: abort.stage, reason: abort.reason }),
      );
      return true;
    } catch {
      return false;
    }
  };

  // Finalize the initialized recovery journal EXACTLY ONCE across every executed
  // and blocked path (finding 3). Idempotent: the first call attempts the finalize
  // and caches its success; later calls return the cached result without a second
  // finalize. Value-free.
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

  const emitProgress = (
    phase: "single" | "multi",
    caseOrdinal: number,
    roundOrdinal: number,
  ): void => {
    deps.emit({
      version: EVAL_REPORT_VERSION,
      mode: "progress",
      origin,
      authMode: "password",
      runSegment: runSegments,
      phase,
      caseOrdinal,
      roundOrdinal,
      plannedUpstreamRounds: plan.plannedUpstreamRounds,
      attemptedRounds,
      completedRounds,
      completedSingleRoundCases: completedSingle,
      completedMultiStepScenarios: completedMulti,
      cleanup: cleanupTotals(),
      checkpointPersisted: true,
    });
  };

  /**
   * The single, explicit finalization state machine shared by EVERY executed
   * path (credential-config failure and post-loop). Order:
   *   3. Finalize the initialized recovery journal EXACTLY ONCE (a finalize
   *      failure is non-resumable and prevents a pass).
   *   4. Dispose the checkpoint: remove it on complete success; persist a
   *      resumable checkpoint for a resumable abort; else write a durable
   *      `blocked` tombstone. A persistence failure is surfaced truthfully.
   *   5. Emit exactly one terminal `pendingProgress` event — ONLY after a durable
   *      resumable checkpoint write — for a cleaned-but-uncommitted terminal round.
   *   6. Emit the final value-free executed report and return its exit code.
   * `scoredComplete` reflects the LOOP outcome (all planned cases scored) and is
   * not reduced by a post-loop journal/checkpoint failure.
   */
  const finalizeAndReport = async (
    loopAbort: AbortInfo | null,
    scoredComplete: boolean,
    auth: AuthObservation | null,
    pendingProgress: PendingProgress | null = null,
  ): Promise<number> => {
    let aborted = loopAbort;

    // Step 3: finalize the recovery journal exactly once (init already succeeded).
    const journalOk = await finalizeJournalOnce();
    if (!journalOk && (aborted === null || aborted.resumable)) {
      // Remaining-id persistence/removal is uncertain → non-resumable.
      aborted = {
        reason: "recovery-journal-finalize-failed",
        stage: "recovery-journal-finalize",
        code: null,
        status: null,
        resumable: false,
      };
    }

    // Step 4: checkpoint disposition. A checkpoint-persist abort that arrived from
    // the loop (a per-round write already failed) is a persistence failure.
    let finalized = false;
    let persistFailed = aborted?.stage === "checkpoint-persist";
    let resumableCheckpointPersisted = false;

    if (aborted === null && scoredComplete) {
      // Complete, un-aborted run → remove the checkpoint.
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
      // Durably persist the resumable checkpoint at the current cursor.
      const persistAbort = persistCheckpoint(nextCaseIndex);
      if (persistAbort !== null) {
        persistFailed = true;
        aborted = persistAbort; // now non-resumable (checkpoint-persist)
      } else {
        resumableCheckpointPersisted = true;
      }
    }

    if (aborted !== null && !aborted.resumable) {
      // Durably block resume with a value-free tombstone. If it cannot be written,
      // keep the report non-resumable and surface the persistence failure.
      if (!persistBlocked(aborted)) persistFailed = true;
    }

    // Step 5: emit the terminal cleaned-attempt progress event, but ONLY after the
    // resumable checkpoint durably persisted (never after a journal-finalize or
    // checkpoint persistence failure, which have already made `aborted`
    // non-resumable above).
    if (pendingProgress !== null && resumableCheckpointPersisted) {
      emitProgress(
        pendingProgress.phase,
        pendingProgress.caseOrdinal,
        pendingProgress.roundOrdinal,
      );
    }

    // Step 6: emit the final report.
    const report = emitExecuted(deps, {
      plan,
      origin,
      attemptedRounds,
      completedRounds,
      completedSingle,
      completedMulti,
      expectedCall,
      single,
      multi,
      cleanupState,
      noSilentFallback,
      injectionResistance,
      parserDeterminism: measureParserDeterminism(),
      auth,
      resumed: resumed !== null,
      resumeApproved: args.resumeApproved,
      startCaseIndex,
      nextCaseIndex,
      runSegments,
      finalized,
      persistFailed,
      scoredComplete,
      aborted,
      diagnosticFailures: [...committedDiagnostics],
    });
    return report.passed ? 0 : 1;
  };

  // (3) Write the initial checkpoint anchor BEFORE reading credentials. This
  //     verifies writability up front and guarantees a resume anchor exists even
  //     if the very first case aborts.
  {
    const anchorAbort = persistCheckpoint(startCaseIndex);
    if (anchorAbort !== null) {
      // The journal was already initialized; finalize it EXACTLY ONCE through the
      // shared helper so no executed/blocked path leaves it un-finalized. A journal-
      // finalize failure is its OWN closed, value-free blocked reason, DISTINCT from
      // the checkpoint-anchor write failure. Nothing upstream ran; no credential was
      // read and no network call was made.
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
    // Route through the shared finalization so the recovery journal is finalized
    // exactly once on this executed path too.
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
   * Account a created-thread round's cleanup truthfully and return an abort
   * (or null to continue). Every created thread increments `attempted` and lands
   * in exactly one of `deleted`/`failed`; a journal-persistence failure is counted
   * separately and aborts even when the HTTP delete succeeded.
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

  /** Commit one expected-tool-call round into the scored accumulators. */
  const commitExpectedCall = (decision: RoundDecision): void => {
    expectedCall.total += 1;
    if (decision.kind === "tool_calls") {
      expectedCall.schemaValid += 1; // selection only yields schema-valid calls
      expectedCall.argValid += 1;
    }
    if (expectedCallNameOk(decision)) expectedCall.nameAccurate += 1;
  };

  /**
   * Advance the case cursor after a case commits, then durably persist the
   * resumable checkpoint and emit its progress record — but ONLY while the
   * cursor still points INSIDE the corpus.
   *
   * The FINAL case's commit is deliberately kept in memory. Writing
   * `nextCaseIndex === cases.length` would produce a resumable checkpoint that
   * {@link validateResumableCheckpoint} refuses by design (a genuinely
   * complete run REMOVES its checkpoint rather than resuming one), so a stop
   * between that write and the removal would leave the evaluator rejecting its
   * OWN checkpoint on the next approved resume. Instead the last durable
   * checkpoint keeps pointing at the final, still-uncommitted case, which an
   * approved resume replays exactly once; and because nothing was persisted
   * for that case, no progress record claims a durable write that never
   * happened. Successful finalization still reports the in-memory complete
   * cursor and removes the checkpoint.
   *
   * BOTH the single-round and multi-step branches route through here so the
   * invariant cannot drift between them, whichever kind of case a corpus ends
   * with. Returns an abort when the durable write failed, else null.
   */
  const commitCaseCursor = (
    caseIndex: number,
    phase: "single" | "multi",
    roundOrdinal: number,
  ): AbortInfo | null => {
    nextCaseIndex = caseIndex + 1;
    if (nextCaseIndex >= cases.length) return null;
    const persistAbort = persistCheckpoint(nextCaseIndex);
    if (persistAbort !== null) return persistAbort;
    emitProgress(phase, caseIndex + 1, roundOrdinal);
    return null;
  };

  /** Flag cross-cutting invariant violations shared by both paths. */
  const flagViolations = (decision: RoundDecision, choice: NormalizedToolChoice): void => {
    if (decision.kind === "tool_calls" && decision.unauthorized) injectionResistance = false;
    if (decision.kind === "text" && (choice.kind === "required" || choice.kind === "function")) {
      noSilentFallback = false;
    }
  };

  let aborted: AbortInfo | null = null;
  let segmentCompletions = 0;
  // A cleaned-but-uncommitted terminal round's progress, emitted by
  // `finalizeAndReport` only after its resumable checkpoint durably persists.
  let pendingProgress: PendingProgress | null = null;

  try {
    outer: for (let i = startCaseIndex; i < cases.length; i += 1) {
      const evalCase = cases[i];
      if (evalCase === undefined) continue;
      // Interruption at a case boundary: nothing is in flight, so this is safe to
      // resume from the current cursor.
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
      if (segmentCompletions + evalCase.rounds.length > MAX_UPSTREAM_COMPLETIONS) break;

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
      const isMulti = evalCase.rounds.length > 1;

      if (isMulti) {
        // A multi-step scenario represents a genuine OpenCode-style agent loop
        // over synthetic in-memory state (spec §30). ONE initial user message
        // (rounds[0].prompt) states the whole goal; later rounds accumulate
        // ONLY through assistant `tool_calls` messages and exactly linked
        // `role: "tool"` synthetic result messages — the evaluator never
        // injects a fresh user instruction between tool results.
        //
        // The scenario's expectation is STATE-AWARE: it comes from the next
        // unsatisfied transition in the shared engine, never from the tool
        // named at this round's ordinal. The request enables parallel tool
        // calls, so one accepted batch can complete several transitions, and
        // a positional schedule would score the correct next round against a
        // stale expectation. Tool results are rendered deterministically from
        // the scenario's declared state (no filesystem, shell, MCP, external
        // service, repository content, or real user data). The scenario STOPS
        // at its first terminal failure: no further upstream rounds are issued
        // and no cascade diagnostics are fabricated.
        const scenarioState = evalCase.scenarioState;
        if (scenarioState === undefined) {
          throw new Error("multi-step case is missing synthetic scenarioState");
        }
        const initialRound = evalCase.rounds[0];
        if (initialRound === undefined) continue;
        const transitions = initializeScenarioTransitions(scenarioState);
        const evidence = initializeStepEvidence();
        const history: NormalizedMessage[] = [{ role: "user", content: initialRound.prompt }];
        // Pending value-free diagnostics for this scenario. Bounded to AT MOST
        // ONE entry: a scenario emits exactly one terminal reason, either its
        // first terminal round failure or `scenario-round-budget-exhausted`.
        // Committed into `committedDiagnostics` ONLY when the whole scenario
        // commits; a mid-scenario abort (interruption, cleanup failure,
        // journal failure, checkpoint-persist failure) discards them.
        const pendingScenarioDiagnostics: EvalFailureDiagnostic[] = [];
        let scenarioAbort: AbortInfo | null = null;
        let executedRounds = 0;
        let terminated = false;
        let finalAccepted = false;
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
          // Derive this round's expectation from SUCCESSFUL state, not from
          // `round.expectedTool` at the same ordinal.
          const pendingStep = pendingStepIndex(transitions);
          const expectedTool = expectedStepTool(transitions) ?? undefined;
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
            // confirmed deleted with no journal failure (a cleaned attempt); record
            // its terminal progress so finalization can emit it after the resumable
            // checkpoint persists.
            if (stepAbort.resumable) {
              pendingProgress = { phase: "multi", caseOrdinal: i + 1, roundOrdinal: r + 1 };
            }
            scenarioAbort = stepAbort;
            break;
          }
          const decision = classifyDecision(
            step.outcome,
            toolset,
            round.choice,
            expectedTool,
            evalCase.selectedLlms,
          );
          flagViolations(decision, round.choice);
          let reason = classifyRoundFailure(decision, expectedTool !== undefined);
          if (pendingStep !== null) {
            // The pending transition's schema/argument evidence follows the
            // existing per-round behavior (the selection engine only yields
            // schema- and argument-valid calls); expected-name evidence is
            // marked only when that step's tool is actually present in an
            // allowed set.
            creditPendingStep(evidence, pendingStep, {
              schemaAndArgValid: decision.kind === "tool_calls",
              expectedNamePresent: expectedCallNameOk(decision),
            });
            if (decision.kind === "tool_calls" && reason === null) {
              // Append the assistant tool_calls message AND the deterministic
              // synthetic tool-result messages for each call, folding the batch
              // through the shared engine IN THE MODEL'S RETURNED ORDER so a
              // parallel batch can advance several consecutive transitions.
              // Results are content-safe and derived only from the scenario's
              // declared synthetic state.
              const contentBefore = transitions.content;
              const batch = applyToolCallBatch(decision.calls, scenarioState, transitions);
              history.push({
                role: "assistant",
                content: null,
                toolCalls: decision.calls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  argumentsJson: call.argumentsJson,
                })),
              });
              decision.calls.forEach((call, callIndex) => {
                history.push({
                  role: "tool",
                  content: batch.applied[callIndex]?.content ?? JSON.stringify({ ok: false }),
                  toolCallId: call.id,
                });
              });
              if (transcriptValid(history, evalCase.tools)) {
                // Every transition this batch completed — including extras
                // beyond the pending one — receives FULL evidence exactly once.
                for (const advancedStep of batch.advancedSteps) {
                  creditSatisfiedStep(evidence, advancedStep);
                }
              } else {
                // Precedence step 6: the expected tool was selected and allowed,
                // but the transcript linkage the gateway would build for the
                // next round fails re-validation, so the loop cannot continue.
                // Roll the synthetic transitions back: a round the gateway
                // rejects in full must never count as workflow progress, which
                // also keeps this expected-scope diagnostic consistent with a
                // still-pending transition. The pending step keeps the
                // schema/argument/name evidence credited above, exactly as the
                // per-round accounting always did for this reason.
                transitions.content = contentBefore;
                for (const advancedStep of batch.advancedSteps) {
                  transitions.satisfied[advancedStep] = false;
                }
                reason = "transcript-invalid";
              }
            }
          } else if (decision.kind === "text") {
            // Every transition succeeded and the model returned the final
            // answer: the scenario is complete.
            finalAccepted = true;
          }
          if (reason !== null) {
            pendingScenarioDiagnostics.push(buildScenarioDiagnostic(projection, i, r, reason));
            // Truthful early termination (spec §30): this scenario cannot
            // represent a real read → edit → test → final loop from here, so
            // stop issuing upstream rounds. Unsatisfied planned steps are
            // accounted for below as gate MISSES (denominator only), NOT as
            // attempted upstream rounds — no cascade diagnostics are
            // fabricated for rounds that never ran.
            terminated = true;
            break;
          }
          if (finalAccepted) break;
          // Persist per-round so cleanup counters are durable — cleanup counters
          // advance, but the case cursor and the scenario's gate measurements do
          // NOT until the scenario completes. Only for non-final rounds: a
          // persist AFTER the scenario's last planned round would record a
          // completed-round counter one full scenario above the still-unadvanced
          // cursor's committed floor, i.e. a checkpoint its own resumable
          // ceiling rejects. The scenario-commit persist below covers that round.
          // The scenario-end event is likewise the single completion record for
          // this case, so there is no duplicate progress at the final ordinal.
          if (r < evalCase.rounds.length - 1) {
            const persistAbort = persistCheckpoint(nextCaseIndex);
            if (persistAbort !== null) {
              scenarioAbort = persistAbort;
              break;
            }
            emitProgress("multi", i + 1, r + 1);
          }
        }
        if (scenarioAbort !== null) {
          aborted = scenarioAbort;
          break outer;
        }
        // The scenario exhausted its round budget without a terminal failure
        // and without an accepted final answer. That is a scenario-level
        // failure, so emit EXACTLY ONE value-free reason at the last executed
        // round; no later round is fabricated.
        if (!terminated && !finalAccepted && executedRounds > 0) {
          pendingScenarioDiagnostics.push(
            buildScenarioDiagnostic(
              projection,
              i,
              executedRounds - 1,
              "scenario-round-budget-exhausted",
            ),
          );
        }
        // Whole scenario committed (either completed successfully OR stopped at
        // a terminal failure / budget exhaustion). Commit the deferred per-step
        // gate measurements AND the single primary diagnostic (when one was
        // recorded) now. A mid-scenario abort above dropped both; a committed
        // scenario commits both together, atomically.
        //
        // Each of the scenario's planned transitions contributes EXACTLY ONE
        // unit to the expected-step denominator, whether or not its round ran,
        // so the section-30 planned denominator is unchanged while retries are
        // merged rather than double-counted. The count comes from THIS case's
        // actual layout, matching how `deriveCommittedEvidence` recomputes it.
        let plannedSteps = 0;
        for (const projectedRound of projection.cases[i]?.rounds ?? []) {
          if (projectedRound.hasExpectedTool) plannedSteps += 1;
        }
        for (let s = 0; s < plannedSteps; s += 1) {
          expectedCall.total += 1;
          if (evidence.schemaValid[s] === true) expectedCall.schemaValid += 1;
          if (evidence.argValid[s] === true) expectedCall.argValid += 1;
          if (evidence.nameAccurate[s] === true) expectedCall.nameAccurate += 1;
        }
        for (const d of pendingScenarioDiagnostics) committedDiagnostics.push(d);
        const satisfied = satisfiedStepCount(transitions);
        multi.total += 1;
        // A scenario succeeds only when every planned transition succeeded AND
        // the final answer was accepted — which parallelism can achieve in
        // fewer rounds than the budget.
        if (satisfied >= plannedSteps && finalAccepted) multi.success += 1;
        completedMulti += 1;
        scenarioEvidence.push([
          executedRounds,
          satisfied,
          stepMask(evidence.schemaValid),
          stepMask(evidence.nameAccurate),
          stepMask(evidence.argValid),
        ]);
        const persistAbort = commitCaseCursor(i, "multi", executedRounds);
        if (persistAbort !== null) {
          aborted = persistAbort;
          break;
        }
      } else {
        const round = evalCase.rounds[0];
        if (round === undefined) continue;
        attemptedRounds += 1;
        segmentCompletions += 1;
        const request = buildRoundRequest(evalCase.tools, round.choice, [
          { role: "user", content: round.prompt },
        ]);
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
          // A resumable abort here is a cleaned attempt (thread created + confirmed
          // deleted, no journal failure); record its terminal progress for emission
          // after the resumable checkpoint persists.
          if (stepAbort.resumable) {
            pendingProgress = { phase: "single", caseOrdinal: i + 1, roundOrdinal: 1 };
          }
          aborted = stepAbort;
          break;
        }
        // A single-round case has no transition state: its expectation is the
        // corpus round's own `expectedTool`, exactly as before.
        const decision = classifyDecision(
          step.outcome,
          toolset,
          round.choice,
          round.expectedTool,
          evalCase.selectedLlms,
        );
        flagViolations(decision, round.choice);
        const singleReason = classifyRoundFailure(decision, round.expectedTool !== undefined);
        if (round.expectedTool !== undefined) {
          const nameOk = expectedCallNameOk(decision);
          commitExpectedCall(decision);
          single.total += 1;
          if (nameOk) single.success += 1;
        }
        if (singleReason !== null) {
          committedDiagnostics.push(buildScenarioDiagnostic(projection, i, 0, singleReason));
        }
        completedSingle += 1;
        const persistAbort = commitCaseCursor(i, "single", 1);
        if (persistAbort !== null) {
          aborted = persistAbort;
          break;
        }
      }
    }
  } finally {
    removeInterrupt();
  }

  // ---- Finalization (shared state machine). `scoredComplete` reflects the loop
  //      outcome; the journal is finalized and the checkpoint disposed there. ----
  const scoredComplete = aborted === null && nextCaseIndex >= cases.length;
  return await finalizeAndReport(aborted, scoredComplete, authObservation(), pendingProgress);
}

/** The parameters for assembling the final executed report. */
interface ExecutedParams {
  readonly plan: ReturnType<typeof evalPlan>;
  readonly origin: string;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  readonly completedSingle: number;
  readonly completedMulti: number;
  readonly expectedCall: {
    total: number;
    schemaValid: number;
    nameAccurate: number;
    argValid: number;
  };
  readonly single: { total: number; success: number };
  readonly multi: { total: number; success: number };
  readonly cleanupState: {
    attempted: number;
    deleted: number;
    failed: number;
    journalFailures: number;
  };
  readonly noSilentFallback: boolean;
  readonly injectionResistance: boolean;
  readonly parserDeterminism: boolean;
  readonly auth: AuthObservation | null;
  readonly resumed: boolean;
  readonly resumeApproved: boolean;
  readonly startCaseIndex: number;
  readonly nextCaseIndex: number;
  readonly runSegments: number;
  readonly finalized: boolean;
  readonly persistFailed: boolean;
  readonly scoredComplete: boolean;
  readonly aborted: AbortInfo | null;
  readonly diagnosticFailures: readonly EvalFailureDiagnostic[];
}

/** Assemble and emit the final executed report; returns it for the exit code. */
function emitExecuted(deps: ToolsEvalDeps, p: ExecutedParams): ExecutedReport {
  const gates = {
    schemaValidity: thresholdGate(
      p.expectedCall.schemaValid,
      p.expectedCall.total,
      p.plan.expectedCall,
      THRESHOLD.schemaValidity,
    ),
    toolNameAccuracy: thresholdGate(
      p.expectedCall.nameAccurate,
      p.expectedCall.total,
      p.plan.expectedCall,
      THRESHOLD.toolNameAccuracy,
    ),
    argValidity: thresholdGate(
      p.expectedCall.argValid,
      p.expectedCall.total,
      p.plan.expectedCall,
      THRESHOLD.argValidity,
    ),
    singleRoundSuccess: thresholdGate(
      p.single.success,
      p.single.total,
      p.plan.single,
      THRESHOLD.singleRoundSuccess,
    ),
    multiStepSuccess: thresholdGate(
      p.multi.success,
      p.multi.total,
      p.plan.multi,
      THRESHOLD.multiStepSuccess,
    ),
    noSilentFallback: invariantGate(p.noSilentFallback, p.scoredComplete),
    injectionResistance: invariantGate(p.injectionResistance, p.scoredComplete),
    parserDeterminism: (p.parserDeterminism ? "passed" : "failed") as GateStatus,
  };

  const remaining = p.cleanupState.attempted - p.cleanupState.deleted;
  const cleanupClean =
    p.cleanupState.failed === 0 && remaining === 0 && p.cleanupState.journalFailures === 0;
  const thresholdsPassed = [
    gates.schemaValidity,
    gates.toolNameAccuracy,
    gates.argValidity,
    gates.singleRoundSuccess,
    gates.multiStepSuccess,
  ].every((g) => g.status === "passed");
  const invariantsPassed =
    gates.noSilentFallback === "passed" &&
    gates.injectionResistance === "passed" &&
    gates.parserDeterminism === "passed";
  const passed =
    p.aborted === null &&
    p.scoredComplete &&
    thresholdsPassed &&
    invariantsPassed &&
    cleanupClean &&
    p.finalized &&
    !p.persistFailed;

  const report: ExecutedReport = {
    version: EVAL_REPORT_VERSION,
    mode: "executed",
    origin: p.origin,
    authMode: "password",
    plannedUpstreamRounds: p.plan.plannedUpstreamRounds,
    attemptedRounds: p.attemptedRounds,
    completedRounds: p.completedRounds,
    completedSingleRoundCases: p.completedSingle,
    completedMultiStepScenarios: p.completedMulti,
    plannedSingleRoundCases: SINGLE_ROUND_CASES,
    plannedMultiStepScenarios: MULTI_STEP_SCENARIOS,
    gates,
    cleanup: {
      attempted: p.cleanupState.attempted,
      deleted: p.cleanupState.deleted,
      failed: p.cleanupState.failed,
      remaining,
      journalFailures: p.cleanupState.journalFailures,
    },
    auth: p.auth,
    checkpoint: {
      resumed: p.resumed,
      resumeApproved: p.resumeApproved,
      startCaseIndex: p.startCaseIndex,
      nextCaseIndex: p.nextCaseIndex,
      runSegments: p.runSegments,
      finalized: p.finalized,
      persistFailed: p.persistFailed,
    },
    aborted: p.aborted,
    diagnostics: { failures: p.diagnosticFailures },
    passed,
  };
  deps.emit(report);
  return report;
}

/* c8 ignore start — the production entry point is never exercised hermetically. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runToolsEval(defaultToolsEvalDeps())
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // Value-free: never surface the thrown value.
      process.stderr.write("eval:tools failed (internal error)\n");
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
