/**
 * The SHARED live upstream-round mechanics used by every approval-gated live
 * evaluator (specification section 30).
 *
 * This module owns ONE thing: the create → journal → submit → poll → delete
 * lifecycle for a single upstream completion, plus the value-free result shape
 * that describes how it resolved. It was extracted verbatim from
 * `tools-eval-cli.ts` so the release evaluator (`npm run eval:tools`) and the
 * multi-step transition diagnostic (`npm run eval:tools:diagnose`) execute the
 * IDENTICAL round lifecycle rather than two drifting copies.
 *
 * The guarantees below are load-bearing for both callers and must not change:
 *  - the round performs EXACTLY ONE `create_thread` and EXACTLY ONE
 *    `process_message`; nothing inside it is ever retried (only the injected
 *    poller keeps its own idempotent GET retry);
 *  - once a thread exists it receives EXACTLY ONE `DELETE`, on every path,
 *    including a create-time journal-write failure and a controlled
 *    interruption;
 *  - the DELETE runs on the INDEPENDENT `cleanupSignal`, never the (possibly
 *    already aborted) `workSignal`, so an interrupted round can still clean the
 *    thread it recorded;
 *  - a create-time `recordCreated` journal rejection short-circuits submit and
 *    poll: the unjournaled thread is deleted once and no work runs against it;
 *  - the post-delete `recordDeleted` journal drop is attempted only after a
 *    confirmed HTTP 2xx delete, and is best-effort;
 *  - HTTP-delete truth and journal-persistence truth are reported separately so
 *    the caller can account for them independently;
 *  - the function NEVER throws and never surfaces a credential, prompt, answer,
 *    thread id, URL, body, or thrown value.
 *
 * Importing this module performs no I/O and opens no socket.
 */
import type { DeleteDiagnostics } from "../collectiviq/cleanup.js";
import { isUpstreamError, type UpstreamErrorCode } from "../collectiviq/errors.js";
import type { CollectivIQAdapter, ProcessMessageResult } from "../collectiviq/types.js";
import type { RecoveryJournalSink } from "../collectiviq/recovery-journal.js";
import type { PollOutcome, Poller } from "../generation/types.js";
import { serializeConversationPrompt } from "../prompts/conversation.js";
import type { NormalizedChatRequest, NormalizedMessage } from "../openai/chat-types.js";
import type { NormalizedTool, NormalizedToolChoice } from "../tools/types.js";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 90_000;
/** The fixed content-free thread placeholder every gateway `create_thread` sends. */
const THREAD_TITLE = "New Thread";

/** A deleter bound to the run's transport config; value-free diagnostics. */
export type BoundDeleter = (threadId: string, signal: AbortSignal) => Promise<DeleteDiagnostics>;

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

/**
 * Build a normalized request from an explicit accumulated message history.
 * Shared by both evaluators so the two cannot diverge on the request shape the
 * round runner serializes. `model` is an internal label only — the prompt
 * serializer never emits it upstream.
 */
export function buildRoundRequest(
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

/** The value-free outcome of ONE created-thread round (see {@link runLiveRound}). */
export interface LiveRoundResult {
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
export async function runLiveRound(
  adapter: CollectivIQAdapter,
  poller: Poller,
  deleter: BoundDeleter,
  journal: RecoveryJournalSink,
  request: NormalizedChatRequest,
  selectedLlms: readonly string[],
  workSignal: AbortSignal,
  cleanupSignal: AbortSignal,
): Promise<LiveRoundResult> {
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
  // runs against it; it is deleted once below and the caller aborts on the
  // journal-persistence failure. `outcome` stays null (no work).
  let outcome: PollOutcome | null = null;
  let failureStage: "process-message" | "get-messages" | null = null;
  let failureCode: UpstreamErrorCode | null = null;
  let failureStatus: number | null = null;
  if (!recordCreatedFailed) {
    // The submit result is retained ONLY for its run id, which the poll needs to
    // correlate a message to this round's submission; it is never reported.
    let submitted: ProcessMessageResult | null = null;
    try {
      submitted = await adapter.processMessage({
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
    if (submitted !== null) {
      try {
        outcome = await poller.poll({
          threadId,
          answerSource: selectedLlms[0] ?? "claude",
          pollIntervalMs: POLL_INTERVAL_MS,
          maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
          deadlineMs: Date.now() + REQUEST_TIMEOUT_MS,
          signal: workSignal,
          combinedRunId: submitted.combinedRunId,
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
