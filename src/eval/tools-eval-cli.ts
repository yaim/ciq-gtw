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
 *    reading no credential, opening no socket, and touching no journal.
 *  - The destination origin ({@link EVAL_ORIGIN}) is a module constant and is
 *    NOT part of the injectable deps surface, so a test can never broaden it.
 *  - Live execution requires ALL of `--execute-approved`, `--cost-approved`
 *    (cost / thread creation), `--cleanup-approved`, and
 *    `--recovery-journal-approved`.
 *  - Only `password` auth mode is used.
 *  - Cases run SEQUENTIALLY. Exactly {@link SINGLE_ROUND_CASES} single-round and
 *    {@link MULTI_STEP_SCENARIOS} three-step scenarios, with a HARD cap of
 *    {@link MAX_UPSTREAM_COMPLETIONS} upstream completions.
 *  - Content is synthetic only — never repository content.
 *  - Each created thread is deleted IMMEDIATELY after its request finishes, and
 *    every created id is recorded in a private, ID-only recovery journal
 *    (dropped only after a confirmed delete). A cleanup failure ABORTS the run.
 *  - Output is value-free: only counts, percentages, gate outcomes, and cleanup
 *    state. It never emits credentials, prompts, answers, schemas, arguments,
 *    titles, thread ids, run ids, model ids, or journal contents.
 *  - The journal lives under the ignored `.agent/sessions/` tree; it is never
 *    committed.
 *
 * Passing every gate here would still leave emulated tool mode EXPERIMENTAL: a
 * later failing run keeps the feature non-default and unreleased.
 */
import { pathToFileURL } from "node:url";
import { buildCredentialProviderFromEnv, CLI_MAX_LOGINS } from "../collectiviq/auth.js";
import { CollectivIQHttpAdapter } from "../collectiviq/adapter.js";
import { observeThreadDeletion } from "../collectiviq/cleanup.js";
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
  SINGLE_ROUND_CASES,
  MULTI_STEP_SCENARIOS,
  MAX_UPSTREAM_COMPLETIONS,
  type EvalRound,
} from "./cases.js";

/** The FIXED CollectivIQ production origin. Never injectable. */
export const EVAL_ORIGIN = "https://api.prod.collectiviq.ai";
/** The evaluator only ever authenticates in password mode. */
export const EVAL_AUTH_MODE = "password" as const;

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 90_000;
const THREAD_TITLE = "New Thread";

/** The closed set of approval flags. Any other argument is an error. */
export interface EvalArgs {
  readonly executeApproved: boolean;
  readonly costApproved: boolean;
  readonly cleanupApproved: boolean;
  readonly recoveryJournalApproved: boolean;
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const flags = {
    executeApproved: false,
    costApproved: false,
    cleanupApproved: false,
    recoveryJournalApproved: false,
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
      default:
        throw new Error("unknown argument");
    }
  }
  return flags;
}

/** The credential-free, network-free preflight projection. */
export interface PreflightReport {
  readonly mode: "preflight";
  readonly origin: string;
  readonly authMode: "password";
  readonly plannedSingleRoundCases: number;
  readonly plannedMultiStepScenarios: number;
  readonly maxUpstreamCompletions: number;
  readonly approvalsRequired: readonly string[];
  readonly approvalsGiven: readonly string[];
}

export function buildPreflightReport(args: EvalArgs): PreflightReport {
  const given: string[] = [];
  if (args.executeApproved) given.push("--execute-approved");
  if (args.costApproved) given.push("--cost-approved");
  if (args.cleanupApproved) given.push("--cleanup-approved");
  if (args.recoveryJournalApproved) given.push("--recovery-journal-approved");
  return {
    mode: "preflight",
    origin: EVAL_ORIGIN,
    authMode: EVAL_AUTH_MODE,
    plannedSingleRoundCases: SINGLE_ROUND_CASES,
    plannedMultiStepScenarios: MULTI_STEP_SCENARIOS,
    maxUpstreamCompletions: MAX_UPSTREAM_COMPLETIONS,
    approvalsRequired: [
      "--execute-approved",
      "--cost-approved",
      "--cleanup-approved",
      "--recovery-journal-approved",
    ],
    approvalsGiven: given,
  };
}

/** The value-free §30 gate outcomes and cleanup state. */
export interface EvalReport {
  readonly mode: "executed";
  readonly origin: string;
  readonly authMode: "password";
  readonly completions: number;
  readonly gates: {
    readonly schemaValidityPct: number;
    readonly toolNameAccuracyPct: number;
    readonly argValidityPct: number;
    readonly singleRoundSuccessPct: number;
    readonly multiStepSuccessPct: number;
    readonly noSilentFallback: boolean;
    readonly injectionResistance: boolean;
    readonly parserDeterminism: boolean;
  };
  readonly gateOutcomes: {
    readonly schemaValidity: boolean;
    readonly toolNameAccuracy: boolean;
    readonly argValidity: boolean;
    readonly singleRoundSuccess: boolean;
    readonly multiStepSuccess: boolean;
    readonly noSilentFallback: boolean;
    readonly injectionResistance: boolean;
    readonly parserDeterminism: boolean;
  };
  readonly cleanup: {
    /** Threads created (each receives exactly one immediate DELETE attempt). */
    readonly attempted: number;
    /** DELETEs that returned a real HTTP 2xx. */
    readonly deleted: number;
    /** DELETEs that did not return a 2xx (non-2xx, transport failure, timeout). */
    readonly failed: number;
    /** Created threads for which no confirmed DELETE was recorded. */
    readonly remaining: number;
    /**
     * DELETEs that returned 2xx but whose ID-only journal removal could not be
     * persisted (or a create-time journal write that failed). A non-zero value is
     * on its own an abort condition, kept SEPARATE from `deleted`/`failed` so an
     * HTTP-successful delete followed by a journal failure is reported truthfully.
     */
    readonly journalFailures: number;
  };
  readonly aborted: string | null;
  readonly passed: boolean;
}

/** The injectable orchestration seam (production omits every override). */
export interface ToolsEvalDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly buildProvider: (
    env: NodeJS.ProcessEnv,
    base: TransportBase,
  ) => CollectivIQCredentialProvider;
  readonly makeAdapter: (
    base: TransportBase,
    provider: CollectivIQCredentialProvider,
  ) => CollectivIQAdapter;
  /** Delete one thread; resolves `true` on a confirmed delete, `false` otherwise. */
  readonly deleteThread: (
    base: TransportBase,
    provider: CollectivIQCredentialProvider,
    threadId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly makeJournal: (dir: string, origin: string) => RecoveryJournalSink;
  readonly emit: (report: PreflightReport | EvalReport) => void;
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
      return resolved.provider;
    },
    makeAdapter: (base, provider) =>
      new CollectivIQHttpAdapter({ baseUrl: base.baseUrl, credentials: provider }),
    // Bounded, real, single-attempt DELETE against the FIXED origin, reusing the
    // resolved password credential provider and the same transport bounds every
    // other DELETE call site uses (`DEFAULT_OPERATION_TIMEOUTS.getMessages`), with
    // caller cancellation honored. It performs exactly ONE DELETE (no internal
    // retry) and returns `true` ONLY on a real HTTP 2xx — a non-2xx, transport
    // failure, or timeout returns `false` and never surfaces an id, URL, body,
    // credential, or exception text. This path is still only reached on the
    // fully-approved executed run, which is not run in this task.
    deleteThread: async (base, provider, threadId, signal) => {
      const config: CollectivIQTransportConfig = {
        baseUrl: base.baseUrl,
        credentials: provider,
        // Forward an injected fetch when present. Production builds `base` as
        // `{ baseUrl: EVAL_ORIGIN }` (no `fetch`), so this is `undefined` there and
        // the transport uses the global `fetch`; a hermetic test can inject one to
        // exercise this exact deleter without a socket.
        ...(base.fetch ? { fetch: base.fetch } : {}),
      };
      const diagnostics = await observeThreadDeletion(
        config,
        threadId,
        DEFAULT_OPERATION_TIMEOUTS.getMessages,
        signal,
      );
      return diagnostics.ok; // strictly a real HTTP 2xx
    },
    makeJournal: (dir, origin) => new FileRecoveryJournal(dir, origin),
    emit: (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
  };
}

/** Fixed synthetic tool-result content fed between multi-step rounds (no repo data). */
const SYNTHETIC_TOOL_RESULT = '{"synthetic":true,"ok":true}';

/** A deleter bound to the run's transport config; `true` only on a real HTTP 2xx. */
type BoundDeleter = (threadId: string, signal: AbortSignal) => Promise<boolean>;

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
  /** The DELETE returned a real HTTP 2xx. */
  readonly httpDeleted: boolean;
  /** `recordCreated` OR the post-delete `recordDeleted` could not be persisted. */
  readonly journalFailure: boolean;
  /** The poll outcome, or null when create/submit/poll threw (a round failure). */
  readonly outcome: PollOutcome | null;
}

/**
 * Run ONE upstream round for a single request: create → journal → submit → poll,
 * then EXACTLY ONE immediate DELETE for the created thread regardless of how the
 * work resolved (submit/poll throw, timeout, or success). The deleter is invoked
 * at most once. HTTP-delete truth and journal-persistence truth are reported
 * separately; nothing is retried inside the round. Never throws.
 */
async function runUpstreamRound(
  adapter: CollectivIQAdapter,
  poller: Poller,
  deleter: BoundDeleter,
  journal: RecoveryJournalSink,
  request: NormalizedChatRequest,
  selectedLlms: readonly string[],
  signal: AbortSignal,
): Promise<StepResult> {
  const prompt = serializeConversationPrompt(request);
  let threadId: string;
  try {
    const thread = await adapter.createThread({ title: THREAD_TITLE, signal });
    threadId = thread.threadId;
  } catch {
    // The thread was never created; there is nothing to clean up.
    return { created: false, httpDeleted: false, journalFailure: false, outcome: null };
  }

  // From here the thread EXISTS: it must receive EXACTLY ONE deletion attempt on
  // every path below.
  let journalFailure = false;
  let recordCreatedFailed = false;
  try {
    await journal.recordCreated(threadId);
  } catch {
    journalFailure = true;
    recordCreatedFailed = true;
  }

  // If the create-time journal write REJECTED, abort immediately: do NOT submit or
  // poll. The thread is unjournaled and must not be left exposed while a request
  // runs against it; it is deleted once below and the evaluator aborts on the
  // journal-persistence failure the caller sees. `outcome` stays null (no work).
  let outcome: PollOutcome | null = null;
  if (!recordCreatedFailed) {
    try {
      await adapter.processMessage({
        threadId,
        prompt,
        selectedLlms,
        generateCombined: false,
        signal,
      });
      outcome = await poller.poll({
        threadId,
        answerSource: selectedLlms[0] ?? "claude",
        pollIntervalMs: POLL_INTERVAL_MS,
        maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
        deadlineMs: Date.now() + REQUEST_TIMEOUT_MS,
        signal,
      });
    } catch {
      outcome = null; // submit/poll failed; the single cleanup still runs below.
    }
  }

  // The single, immediate DELETE attempt for this thread (runs on every path,
  // including the aborted recordCreated path).
  let httpDeleted: boolean;
  try {
    httpDeleted = await deleter(threadId, signal);
  } catch {
    httpDeleted = false;
  }
  if (httpDeleted) {
    // Even when the create-time write failed, still attempt the journal drop: that
    // failed write may have PARTIALLY persisted the id, so the removal is best-effort.
    try {
      await journal.recordDeleted(threadId);
    } catch {
      journalFailure = true; // HTTP delete succeeded but the journal drop did not.
    }
  }

  return { created: true, httpDeleted, journalFailure, outcome };
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

/**
 * Re-validate an accumulated multi-step transcript through the real tool-request
 * normalizer (id uniqueness, declared names, schema-valid arguments, and
 * exactly-one linked result per call). Genuinely exercises the linkage/schema
 * checks against the transcript the evaluator built.
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
 * byte identical results. This is a REAL, computed result — the evaluator never
 * asserts determinism it did not measure. Pure and local (no network).
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
 * Run the evaluator. Preflight by default; the fully-approved path executes the
 * bounded live gate suite. Returns a process exit code (0 = all gates passed).
 */
export async function runToolsEval(deps: ToolsEvalDeps): Promise<number> {
  const args = parseEvalArgs(deps.argv);

  // DEFAULT: preflight only — no credential, no network, no journal.
  if (!args.executeApproved) {
    deps.emit(buildPreflightReport(args));
    return 0;
  }
  if (!args.costApproved || !args.cleanupApproved || !args.recoveryJournalApproved) {
    throw new Error(
      "eval:tools execution requires --execute-approved --cost-approved --cleanup-approved --recovery-journal-approved",
    );
  }

  const base: TransportBase = { baseUrl: EVAL_ORIGIN };
  // Journal init BEFORE any secret read or network call.
  const journal = deps.makeJournal(defaultDiscoveryJournalDir(), EVAL_ORIGIN);
  await journal.init();

  const provider = deps.buildProvider(deps.env, base);
  const adapter = deps.makeAdapter(base, provider);
  const poller = createPoller(adapter);
  const deleter: BoundDeleter = (threadId, signal) =>
    deps.deleteThread(base, provider, threadId, signal);
  const controller = new AbortController();
  const cases = buildEvalCases();

  let completions = 0;
  // Gate accumulators. `expectedCall` covers EVERY round expected to produce a
  // tool call (single-round cases + multi-step tool steps); final-text rounds are
  // deliberately excluded from the name/argument/schema denominators. `single`
  // scores single-round success; `multi` scores whole-scenario success.
  const expectedCall = { total: 0, schemaValid: 0, nameAccurate: 0, argValid: 0 };
  const single = { total: 0, success: 0 };
  const multi = { total: 0, success: 0 };
  const cleanupState = { attempted: 0, deleted: 0, failed: 0, journalFailures: 0 };
  let noSilentFallback = true;
  let injectionResistance = true;
  let aborted: string | null = null;

  /**
   * Account a created-thread round's cleanup truthfully and return an abort
   * reason (or null to continue). Every created thread increments `attempted` and
   * lands in exactly one of `deleted`/`failed`; a journal-persistence failure is
   * counted separately and aborts even when the HTTP delete itself succeeded.
   */
  const accountCleanup = (step: StepResult): string | null => {
    if (!step.created) return "round-execution-failed"; // createThread threw; nothing created
    cleanupState.attempted += 1;
    if (step.httpDeleted) cleanupState.deleted += 1;
    else cleanupState.failed += 1;
    if (step.journalFailure) cleanupState.journalFailures += 1;
    if (!step.httpDeleted) return "cleanup-failed";
    if (step.journalFailure) return "journal-persistence-failed";
    if (step.outcome === null) return "round-execution-failed";
    return null;
  };

  /** Score one expected-tool-call round against the name/argument/schema gates. */
  const scoreExpectedCall = (decision: RoundDecision): boolean => {
    expectedCall.total += 1;
    const produced = decision.kind === "tool_calls";
    const nameOk = produced && decision.allAllowed && decision.expectedInvoked;
    if (produced) {
      expectedCall.schemaValid += 1; // selection only yields schema-valid calls
      expectedCall.argValid += 1;
    }
    if (nameOk) expectedCall.nameAccurate += 1;
    return nameOk;
  };

  /** Flag cross-cutting gate violations shared by both paths. */
  const flagViolations = (decision: RoundDecision, choice: NormalizedToolChoice): void => {
    if (decision.kind === "tool_calls" && decision.unauthorized) injectionResistance = false;
    // A required/named choice resolving to text would be a silent downgrade. The
    // selection engine turns that into a structured error instead, so this stays
    // true in practice, but it is measured rather than assumed.
    if (decision.kind === "text" && (choice.kind === "required" || choice.kind === "function")) {
      noSilentFallback = false;
    }
  };

  outer: for (const evalCase of cases) {
    if (completions + evalCase.rounds.length > MAX_UPSTREAM_COMPLETIONS) break;
    const isMulti = evalCase.rounds.length > 1;
    const compiled = compileToolset(evalCase.tools);
    if (!compiled.ok) {
      aborted = "toolset-compile-failed";
      break;
    }
    const toolset = compiled.toolset;

    if (isMulti) {
      const history: NormalizedMessage[] = [];
      let scenarioOk = true;
      for (const round of evalCase.rounds) {
        completions += 1;
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
        );
        const abort = accountCleanup(step);
        if (abort !== null) {
          aborted = abort;
          break outer;
        }
        const decision = classifyDecision(step.outcome, toolset, round, evalCase.selectedLlms);
        flagViolations(decision, round.choice);
        if (round.expectedTool !== undefined) {
          const nameOk = scoreExpectedCall(decision);
          if (!nameOk) {
            scenarioOk = false;
          } else if (decision.kind === "tool_calls") {
            // Extend the ACCUMULATED transcript with the assistant tool_calls and a
            // matching synthetic tool result per returned call id, so the next
            // round's serialized request carries the full tool history.
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
          // The final round must produce ordinary final text.
          scenarioOk = false;
        }
      }
      multi.total += 1;
      if (scenarioOk && aborted === null) multi.success += 1;
    } else {
      const round = evalCase.rounds[0];
      if (round === undefined) continue;
      completions += 1;
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
      );
      const abort = accountCleanup(step);
      if (abort !== null) {
        aborted = abort;
        break outer;
      }
      const decision = classifyDecision(step.outcome, toolset, round, evalCase.selectedLlms);
      flagViolations(decision, round.choice);
      // Every single-round case expects a tool call.
      if (round.expectedTool !== undefined) {
        const nameOk = scoreExpectedCall(decision);
        single.total += 1;
        if (nameOk) single.success += 1;
      }
    }
  }

  await journal.finalize();

  const parserDeterminism = measureParserDeterminism();
  const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  const gates = {
    schemaValidityPct: pct(expectedCall.schemaValid, expectedCall.total),
    toolNameAccuracyPct: pct(expectedCall.nameAccurate, expectedCall.total),
    argValidityPct: pct(expectedCall.argValid, expectedCall.total),
    singleRoundSuccessPct: pct(single.success, single.total),
    multiStepSuccessPct: pct(multi.success, multi.total),
    noSilentFallback,
    injectionResistance,
    parserDeterminism,
  };
  const gateOutcomes = {
    schemaValidity: gates.schemaValidityPct >= 95,
    toolNameAccuracy: gates.toolNameAccuracyPct >= 98,
    argValidity: gates.argValidityPct >= 95,
    singleRoundSuccess: gates.singleRoundSuccessPct >= 90,
    multiStepSuccess: gates.multiStepSuccessPct >= 85,
    noSilentFallback,
    injectionResistance,
    parserDeterminism,
  };
  const passed = aborted === null && Object.values(gateOutcomes).every((v) => v === true);

  const report: EvalReport = {
    mode: "executed",
    origin: EVAL_ORIGIN,
    authMode: EVAL_AUTH_MODE,
    completions,
    gates,
    gateOutcomes,
    cleanup: {
      attempted: cleanupState.attempted,
      deleted: cleanupState.deleted,
      failed: cleanupState.failed,
      remaining: cleanupState.attempted - cleanupState.deleted,
      journalFailures: cleanupState.journalFailures,
    },
    aborted,
    passed,
  };
  deps.emit(report);
  return passed ? 0 : 1;
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
