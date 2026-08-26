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
import { isUpstreamError, type UpstreamErrorCode } from "../collectiviq/errors.js";
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
import type { PollOutcome, Poller } from "../generation/types.js";
import { selectGeneration, type SourceCandidate } from "../tools/select.js";
import { compileToolset, type CompiledToolset } from "../tools/schema.js";
import { createToolCallIdGenerator } from "../tools/ids.js";
import { parseToolEnvelope } from "../tools/protocol.js";
import { normalizeToolRequest, type ProbedField } from "../tools/request.js";
import { serializeConversationPrompt } from "../prompts/conversation.js";
import type { NormalizedChatRequest, NormalizedMessage } from "../openai/chat-types.js";
import type { NormalizedTool, NormalizedToolChoice, ParsedToolCall } from "../tools/types.js";
import {
  buildEvalCases,
  corpusFingerprint,
  evalPlan,
  SINGLE_ROUND_CASES,
  MULTI_STEP_SCENARIOS,
  MAX_UPSTREAM_COMPLETIONS,
  type EvalRound,
} from "./cases.js";
import {
  checkpointExists,
  deleteCheckpoint,
  defaultCheckpointLocation,
  readCheckpoint,
  validateResumableCheckpoint,
  writeCheckpoint,
  type CheckpointData,
} from "./checkpoint.js";
import {
  EVAL_REPORT_VERSION,
  invariantGate,
  thresholdGate,
  type AbortInfo,
  type AbortStage,
  type BlockedReason,
  type CleanupTotals,
  type EvalOutput,
  type ExecutedReport,
  type GateStatus,
  type PreflightReport,
} from "./report.js";

/** The FIXED CollectivIQ production origin. Never injectable. */
export const EVAL_ORIGIN = "https://api.prod.collectiviq.ai";
/** The evaluator only ever authenticates in password mode. */
export const EVAL_AUTH_MODE = "password" as const;

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 90_000;
const THREAD_TITLE = "New Thread";

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

/** Fixed synthetic tool-result content fed between multi-step rounds (no repo data). */
const SYNTHETIC_TOOL_RESULT = '{"synthetic":true,"ok":true}';

/** A deleter bound to the run's transport config; value-free diagnostics. */
type BoundDeleter = (threadId: string, signal: AbortSignal) => Promise<DeleteDiagnostics>;

/**
 * Trap-safely extract a normalized upstream code + safe status from a thrown
 * value. Uses {@link isUpstreamError} (WeakSet identity) BEFORE reading any
 * property, so an unknown or hostile thrown value yields null/null with no
 * property access, `instanceof`, prototype inspection, serialization, or
 * coercion.
 */
function safeUpstream(error: unknown): {
  readonly code: UpstreamErrorCode | null;
  readonly status: number | null;
} {
  if (isUpstreamError(error)) return { code: error.code, status: error.rawStatus ?? null };
  return { code: null, status: null };
}

/** Build a normalized request from an explicit accumulated message history. */
function buildRequest(
  tools: readonly NormalizedTool[],
  choice: NormalizedToolChoice,
  messages: readonly NormalizedMessage[],
): NormalizedChatRequest {
  return Object.freeze({
    model: "eval",
    messages: Object.freeze([...messages]),
    ignoredParameters: Object.freeze([]),
    stream: false,
    tools: Object.freeze([...tools]),
    toolChoice: choice,
    parallelToolCalls: true,
  });
}

/** The value-free outcome of ONE created-thread round (see {@link runUpstreamRound}). */
interface StepResult {
  /** A thread was created, so exactly one DELETE was attempted for it. */
  readonly created: boolean;
  /** Trap-safe upstream code/status when `createThread` threw (ambiguous). */
  readonly createFailureCode: UpstreamErrorCode | null;
  readonly createFailureStatus: number | null;
  /** The DELETE returned a real HTTP 2xx. */
  readonly httpDeleted: boolean;
  /** Value-free code/status from a failed cleanup DELETE. */
  readonly deleteCode: UpstreamErrorCode | null;
  readonly deleteStatus: number | null;
  /** The create-time `recordCreated` journal write rejected. */
  readonly recordCreatedFailed: boolean;
  /** The post-delete `recordDeleted` journal write rejected. */
  readonly recordDeletedFailed: boolean;
  /** Where the round failed operationally (submit vs poll), when it did. */
  readonly failureStage: "process-message" | "get-messages" | null;
  readonly failureCode: UpstreamErrorCode | null;
  readonly failureStatus: number | null;
  /** The poll outcome, or null when create/submit/poll threw (a round failure). */
  readonly outcome: PollOutcome | null;
}

/**
 * Run ONE upstream round for a single request: create → journal → submit → poll,
 * then EXACTLY ONE immediate DELETE for the created thread regardless of how the
 * work resolved (submit/poll throw, timeout, or success). The deleter is invoked
 * at most once, on the INDEPENDENT `cleanupSignal` (never the already-aborted
 * `workSignal`), so a controlled interruption can still clean a recorded thread.
 * HTTP-delete truth and journal-persistence truth are reported separately;
 * nothing is retried inside the round. Never throws.
 */
async function runUpstreamRound(
  adapter: CollectivIQAdapter,
  poller: Poller,
  deleter: BoundDeleter,
  journal: RecoveryJournalSink,
  request: NormalizedChatRequest,
  selectedLlms: readonly string[],
  workSignal: AbortSignal,
  cleanupSignal: AbortSignal,
): Promise<StepResult> {
  const prompt = serializeConversationPrompt(request);
  let threadId: string;
  try {
    const thread = await adapter.createThread({ title: THREAD_TITLE, signal: workSignal });
    threadId = thread.threadId;
  } catch (error) {
    // The thread creation was ambiguous (it may or may not have taken effect and
    // no id is available); there is nothing safe to clean up.
    const u = safeUpstream(error);
    return {
      created: false,
      createFailureCode: u.code,
      createFailureStatus: u.status,
      httpDeleted: false,
      deleteCode: null,
      deleteStatus: null,
      recordCreatedFailed: false,
      recordDeletedFailed: false,
      failureStage: null,
      failureCode: null,
      failureStatus: null,
      outcome: null,
    };
  }

  // From here the thread EXISTS: it must receive EXACTLY ONE deletion attempt on
  // every path below.
  let recordCreatedFailed = false;
  try {
    await journal.recordCreated(threadId);
  } catch {
    recordCreatedFailed = true;
  }

  // If the create-time journal write REJECTED, abort immediately: do NOT submit or
  // poll. The thread is unjournaled and must not be left exposed while a request
  // runs against it; it is deleted once below and the evaluator aborts on the
  // journal-persistence failure. `outcome` stays null (no work).
  let outcome: PollOutcome | null = null;
  let failureStage: "process-message" | "get-messages" | null = null;
  let failureCode: UpstreamErrorCode | null = null;
  let failureStatus: number | null = null;
  if (!recordCreatedFailed) {
    try {
      await adapter.processMessage({
        threadId,
        prompt,
        selectedLlms,
        generateCombined: false,
        signal: workSignal,
      });
    } catch (error) {
      const u = safeUpstream(error);
      failureStage = "process-message";
      failureCode = u.code;
      failureStatus = u.status;
    }
    if (failureStage === null) {
      try {
        outcome = await poller.poll({
          threadId,
          answerSource: selectedLlms[0] ?? "claude",
          pollIntervalMs: POLL_INTERVAL_MS,
          maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
          deadlineMs: Date.now() + REQUEST_TIMEOUT_MS,
          signal: workSignal,
        });
      } catch (error) {
        const u = safeUpstream(error);
        failureStage = "get-messages";
        failureCode = u.code;
        failureStatus = u.status;
        outcome = null;
      }
    }
  }

  // The single, immediate DELETE attempt for this thread on the INDEPENDENT
  // cleanup signal (runs on every path, including the aborted recordCreated path
  // and a controlled interruption).
  let diagnostics: DeleteDiagnostics;
  try {
    diagnostics = await deleter(threadId, cleanupSignal);
  } catch {
    diagnostics = { ok: false, status: null, errorCode: null };
  }
  let recordDeletedFailed = false;
  if (diagnostics.ok) {
    // Even when the create-time write failed, still attempt the journal drop: that
    // failed write may have PARTIALLY persisted the id, so the removal is best-effort.
    try {
      await journal.recordDeleted(threadId);
    } catch {
      recordDeletedFailed = true;
    }
  }

  return {
    created: true,
    createFailureCode: null,
    createFailureStatus: null,
    httpDeleted: diagnostics.ok,
    deleteCode: diagnostics.ok ? null : diagnostics.errorCode,
    deleteStatus: diagnostics.status,
    recordCreatedFailed,
    recordDeletedFailed,
    failureStage,
    failureCode,
    failureStatus,
    outcome,
  };
}

/** A round's classified generation (value-free; records no name, argument, or text). */
type RoundDecision =
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

/** Classify a poll outcome by running the real selection engine. Never throws. */
function classifyDecision(
  outcome: PollOutcome | null,
  toolset: CompiledToolset,
  round: EvalRound,
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
      choice: round.choice,
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
    round.expectedTool === undefined
      ? true
      : calls.some((call) => call.name === round.expectedTool);
  return { kind: "tool_calls", calls, expectedInvoked, allAllowed, unauthorized: !allAllowed };
}

/** Whether an expected-tool-call round produced the correct allowed call (pure). */
function expectedCallNameOk(decision: RoundDecision): boolean {
  return decision.kind === "tool_calls" && decision.allAllowed && decision.expectedInvoked;
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
  const fingerprint = corpusFingerprint();
  const plan = evalPlan();
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
    // SEMANTIC (corpus-bound) validation against the ACTUAL plan (finding 1): a
    // forged / internally-inconsistent checkpoint — including any claim of a
    // complete + passing corpus — is rejected here, before any credential read
    // or network I/O, so it can never produce a zero-network executed pass.
    try {
      validateResumableCheckpoint(resumed, {
        plannedSingle: plan.single,
        plannedMulti: plan.multi,
        expectedCallsPerScenario: plan.expectedCallsPerScenario,
        maxRoundsPerCase: plan.maxRoundsPerCase,
      });
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

  const buildCheckpoint = (
    nextIdx: number,
    resumeState: "resumable" | "blocked",
    abort: { stage: AbortInfo["stage"]; reason: AbortInfo["reason"] } | null,
  ): CheckpointData => ({
    formatVersion: 1,
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
  const cases = buildEvalCases();

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
  const accountCleanup = (step: StepResult): AbortInfo | null => {
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
        const history: NormalizedMessage[] = [];
        const pending: RoundDecision[] = [];
        let scenarioOk = true;
        let scenarioAbort: AbortInfo | null = null;
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
          history.push({ role: "user", content: round.prompt });
          const request = buildRequest(evalCase.tools, round.choice, history);
          const step = await runUpstreamRound(
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
          const decision = classifyDecision(step.outcome, toolset, round, evalCase.selectedLlms);
          flagViolations(decision, round.choice);
          if (round.expectedTool !== undefined) {
            // Defer the SCORED gate accumulation until the whole scenario finishes.
            pending.push(decision);
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
                history.push({ role: "tool", content: SYNTHETIC_TOOL_RESULT, toolCallId: call.id });
              }
              if (!transcriptValid(history, evalCase.tools)) scenarioOk = false;
            }
          } else if (decision.kind !== "text") {
            scenarioOk = false;
          }
          // Persist per-round: cleanup counters advance, but the case cursor and
          // the scenario's gate measurements do NOT until the scenario completes.
          const persistAbort = persistCheckpoint(nextCaseIndex);
          if (persistAbort !== null) {
            scenarioAbort = persistAbort;
            break;
          }
          // Emit intra-scenario progress only for non-final rounds; the scenario-
          // end event below is the single completion record for this case (no
          // duplicate progress at the final round ordinal).
          if (r < evalCase.rounds.length - 1) emitProgress("multi", i + 1, r + 1);
        }
        if (scenarioAbort !== null) {
          aborted = scenarioAbort;
          break outer;
        }
        // Whole scenario completed: commit the deferred gate measurements now.
        for (const decision of pending) commitExpectedCall(decision);
        multi.total += 1;
        if (scenarioOk) multi.success += 1;
        completedMulti += 1;
        nextCaseIndex = i + 1;
        const persistAbort = persistCheckpoint(nextCaseIndex);
        if (persistAbort !== null) {
          aborted = persistAbort;
          break;
        }
        emitProgress("multi", i + 1, evalCase.rounds.length);
      } else {
        const round = evalCase.rounds[0];
        if (round === undefined) continue;
        attemptedRounds += 1;
        segmentCompletions += 1;
        const request = buildRequest(evalCase.tools, round.choice, [
          { role: "user", content: round.prompt },
        ]);
        const step = await runUpstreamRound(
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
        const decision = classifyDecision(step.outcome, toolset, round, evalCase.selectedLlms);
        flagViolations(decision, round.choice);
        if (round.expectedTool !== undefined) {
          const nameOk = expectedCallNameOk(decision);
          commitExpectedCall(decision);
          single.total += 1;
          if (nameOk) single.success += 1;
        }
        completedSingle += 1;
        nextCaseIndex = i + 1;
        const persistAbort = persistCheckpoint(nextCaseIndex);
        if (persistAbort !== null) {
          aborted = persistAbort;
          break;
        }
        emitProgress("single", i + 1, 1);
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
