/**
 * Chat-completion orchestration (specification sections 15, 16, 27).
 *
 * The flow is split into a synchronous {@link ChatCompletionService.prepare}
 * step and an asynchronous {@link ChatCompletionService.run} step so the API
 * layer can commit SSE response headers only AFTER preparation has succeeded:
 *
 *  - `prepare` resolves + serializes the prompt, enforces the model's byte limit,
 *    and mints the stream-stable completion identity (id + `created`). It makes
 *    no upstream call and takes no capacity. A prepare failure (e.g. an
 *    oversized prompt) throws a {@link ChatCompletionError} and therefore keeps a
 *    normal JSON error status — SSE headers are never committed for it.
 *  - `run` executes the per-completion flow: acquire capacity → obtain exactly
 *    one thread → submit exactly once → poll → select text. Capacity is acquired
 *    BEFORE thread creation and released on every exit path.
 *    `create_thread`/`process_message` are never retried.
 *
 * The default is STATELESS: every completion creates its own thread. A caller
 * that has already leased an OpenCode session's thread (Phase 5A, specification
 * section 5.1.1) may instead supply it through
 * {@link CompletionRunOptions.leasedThreadId}, in which case no thread is
 * created. Either way the poll accepts only messages carrying the run id this
 * completion's `process_message` returned, so a thread holding earlier turns is
 * no less safe than a fresh one. Nothing in this module knows how that lease is
 * stored or coordinated.
 *
 * `run` returns only TRUSTED completed text (a {@link CompletionResult}); the
 * caller owns JSON versus SSE encoding. The service depends only on normalized
 * values and narrow ports — no Fastify request/reply object and no CollectivIQ
 * wire schema.
 *
 * Failures surface as either a {@link ChatCompletionError} carrying a public
 * OpenAI envelope, or a {@link RequestCancelledError} when the CLIENT (or a
 * shutdown) aborted — never a raw upstream body, credential, or exception
 * detail. The route maps these to responses; an unexpected error propagates to
 * the fixed `500`.
 */
import type { VirtualModel } from "../config/schema.js";
import type { NormalizedChatRequest } from "../openai/chat-types.js";
import { isUpstreamError } from "../collectiviq/errors.js";
import type { CollectivIQAdapter } from "../collectiviq/types.js";
import {
  CONTEXT_LENGTH_EXCEEDED_ERROR,
  COMPLETION_TIMEOUT_ERROR,
  GATEWAY_CAPACITY_EXCEEDED_ERROR,
  INVALID_TOOL_RESPONSE_ERROR,
  openAIErrorForUpstream,
  THREAD_REUSE_UNAVAILABLE_ERROR,
  type OpenAIApiError,
} from "../openai/errors.js";
import {
  selectGeneration,
  type CompiledToolset,
  type NormalizedToolChoice,
  type ParsedToolCall,
  type SourceCandidate,
  type ToolCallIdGenerator,
} from "../tools/index.js";
import { selectWinningMessage } from "./polling.js";
import type { CapacityController, Clock, IdGenerator, Poller, PromptSerializer } from "./types.js";

/**
 * The fixed, content-free upstream thread title sent on every `create_thread`.
 * `New Thread` is CollectivIQ's observed server-recognized temporary placeholder:
 * once a completion's message is processed, the provider may ASYNCHRONOUSLY
 * replace it with its own prompt-related server-side title (which the gateway
 * never reads, returns, logs, caches, or retains). This value is always fixed and
 * never derived from prompt content, model ids, repository names, filenames,
 * users, answers, OpenCode session titles, or credentials.
 */
export const THREAD_TITLE = "New Thread";

// Branded registries of the gateway's own completion error instances. Membership
// is tested by object IDENTITY (WeakSet.has triggers no getter and no Proxy trap),
// so the route can classify a thrown value WITHOUT `instanceof` — which would
// invoke a hostile Proxy's `getPrototypeOf` trap — and without reading any
// property of an untrusted value.
const chatCompletionErrors = new WeakSet<object>();
const requestCancelledErrors = new WeakSet<object>();

/** A completion failure carrying a public OpenAI envelope for the route to send. */
export class ChatCompletionError extends Error {
  readonly apiError: OpenAIApiError;
  constructor(apiError: OpenAIApiError) {
    super("chat completion failed");
    this.name = "Error";
    this.apiError = apiError;
    chatCompletionErrors.add(this);
  }
}

/**
 * The completion was aborted by the client disconnecting or by shutdown (NOT by
 * the total deadline). The route normally sends nothing (the socket is gone);
 * when the client is still connected (shutdown) it maps to `503`.
 */
export class RequestCancelledError extends Error {
  constructor() {
    super("request cancelled");
    this.name = "Error";
    requestCancelledErrors.add(this);
  }
}

/**
 * True only for a gateway-created {@link ChatCompletionError}. Trap-safe: it
 * reads no property of `value` and never invokes an `instanceof`/prototype trap,
 * so a hostile thrown value is classified purely by identity.
 */
export function isChatCompletionError(value: unknown): value is ChatCompletionError {
  return typeof value === "object" && value !== null && chatCompletionErrors.has(value);
}

/** True only for a gateway-created {@link RequestCancelledError}. Trap-safe. */
export function isRequestCancelledError(value: unknown): value is RequestCancelledError {
  return typeof value === "object" && value !== null && requestCancelledErrors.has(value);
}

/** Injected dependencies (all narrow ports; every seam is test-injectable). */
export interface ChatCompletionDeps {
  readonly serializer: PromptSerializer;
  readonly capacity: CapacityController;
  readonly adapter: CollectivIQAdapter;
  readonly poller: Poller;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Gateway-owned tool-call id generator (emulated mode only). */
  readonly toolCallIds: ToolCallIdGenerator;
}

/** Per-request context (already authenticated, validated, and model-resolved). */
export interface ChatCompletionRequestContext {
  readonly request: NormalizedChatRequest;
  readonly model: VirtualModel;
  /** Opaque gateway-key identity for per-key capacity accounting. */
  readonly keyId: string;
  /** Combined client-disconnect + shutdown abort signal (the deadline is added here). */
  readonly signal: AbortSignal;
  /**
   * The per-request compiled toolset (emulated mode with tools only). Carried
   * through {@link PreparedCompletion.toolContext} so `run` can parse/vote over
   * upstream tool-call candidates using the same compiled validators.
   */
  readonly toolset?: CompiledToolset;
}

/** The active tool policy threaded into `run` for emulated-mode selection. */
export interface PreparedToolContext {
  readonly toolset: CompiledToolset;
  readonly choice: NormalizedToolChoice;
  readonly parallelToolCalls: boolean;
}

/**
 * The immutable, already-prepared completion identity and prompt. Produced by a
 * synchronous {@link ChatCompletionService.prepare} so the API layer can commit
 * SSE headers (using `id`, `created`, and `model`) BEFORE any upstream work,
 * then hand the value straight back to {@link ChatCompletionService.run}. It
 * carries no raw request, header, or Fastify object.
 */
export interface PreparedCompletion {
  /** Stable `chatcmpl_ciq_*` id for the whole response (every SSE frame reuses it). */
  readonly id: string;
  /** Stable Unix-seconds creation time for the whole response. */
  readonly created: number;
  /** The requested virtual-model id, echoed verbatim in the response. */
  readonly model: string;
  /** The serialized control prompt (already within the model's byte limit). */
  readonly prompt: string;
  /** The resolved internal model policy driving capacity/upstream/poll bounds. */
  readonly policy: VirtualModel;
  /** Opaque gateway-key identity for per-key capacity accounting. */
  readonly keyId: string;
  /**
   * The active emulated-tool policy, present only when tools are active (emulated
   * model, non-empty tools, `tool_choice` ≠ `none`). Absent means the completion
   * produces ordinary text. `run` uses it to parse/vote over upstream tool-call
   * candidates.
   */
  readonly toolContext?: PreparedToolContext;
  /** Configured source order, used for deterministic tool-consensus tie-breaks. */
  readonly selectedLlms: readonly string[];
}

/**
 * Trusted internal metadata about the upstream thread a completion used. It is
 * consumed ONLY inside the process — by native-title correlation and by the
 * thread-reuse coordinator — and is NEVER exposed in the OpenAI JSON/SSE.
 */
interface UpstreamThreadInfo {
  /** The normalized upstream thread id (see `src/opencode/title-bridge.ts`). */
  readonly upstreamThreadId: string;
  /**
   * Whether THIS completion created that thread (Phase 5A). `false` means the
   * completion continued a thread an earlier turn of the same OpenCode session
   * created, in which case native-title propagation must not be registered
   * again — the provider generates its title once, for the first turn.
   */
  readonly upstreamThreadCreated: boolean;
}

/**
 * The trusted result of a completed generation: either parsed assistant text or
 * validated tool calls (specification section 8.7). Both variants carry the
 * internal upstream-thread metadata described by {@link UpstreamThreadInfo}.
 */
export type CompletionResult =
  | ({ readonly kind: "text"; readonly content: string } & UpstreamThreadInfo)
  | ({
      readonly kind: "tool_calls";
      readonly toolCalls: readonly ParsedToolCall[];
    } & UpstreamThreadInfo);

/**
 * Optional per-run inputs observed by {@link ChatCompletionService.run}.
 *
 * The lifecycle hooks exist so a cross-cutting concern — Redis-backed
 * idempotency (specification section 18) and OpenCode thread reuse (section
 * 5.1.1) — can interpose at an exact point in the flow WITHOUT the generation
 * layer learning anything about that concern. Omitting the whole object keeps
 * the stateless one-thread-per-completion default byte-for-byte unchanged.
 */
export interface CompletionRunOptions {
  /**
   * Invoked once, AFTER the capacity permit is acquired and BEFORE
   * `create_thread`. A rejection aborts the completion: the permit is released
   * on the normal exit path and NO upstream call is made. Throw a
   * {@link ChatCompletionError} to choose the public envelope; anything else
   * propagates to the route's fixed `500`.
   */
  readonly onCapacityAcquired?: (signal: AbortSignal) => Promise<void>;
  /**
   * Invoked once, immediately AFTER a successful `create_thread` and BEFORE any
   * other upstream call, with the normalized thread id. A rejection aborts the
   * completion before `process_message`, so the newly created thread is left
   * blank and is deliberately not deleted (its id has no proven-safe deletion
   * semantics — specification section 35, item 9). Never invoked when
   * {@link CompletionRunOptions.leasedThreadId} supplied a thread.
   */
  readonly onThreadCreated?: (threadId: string, signal: AbortSignal) => Promise<void>;
  /**
   * Invoked once, immediately BEFORE `process_message` — after the thread
   * exists. A rejection aborts the completion with no submit having been
   * attempted, which is what lets the caller distinguish a provably-not-submitted
   * failure from an ambiguous one.
   */
  readonly onBeforeSubmit?: (signal: AbortSignal) => Promise<void>;
  /**
   * An already-leased upstream thread to CONTINUE instead of creating one
   * (Phase 5A). When present, `create_thread` is not called and the result
   * reports `upstreamThreadCreated: false`. A reused thread needs no special
   * read of its earlier turns: selection is correlated to the run this
   * completion's `process_message` returns, so a previous turn's answer is
   * ineligible by construction.
   */
  readonly leasedThreadId?: string;
}

/** The narrow completion use case consumed by the route (prepare then run). */
export interface ChatCompletionService {
  /**
   * Resolve + serialize + bound the prompt and mint the stream-stable identity.
   * Synchronous, side-effect-free (no capacity, no upstream I/O). Throws a
   * {@link ChatCompletionError} on a preparation failure (e.g. an oversized
   * prompt) — which the caller maps to a normal JSON error, never SSE.
   */
  prepare(ctx: ChatCompletionRequestContext): PreparedCompletion;
  /**
   * Execute the prepared completion: acquire capacity, run any
   * {@link CompletionRunOptions.onCapacityAcquired} hook, obtain exactly one
   * thread (created, or continued from
   * {@link CompletionRunOptions.leasedThreadId}), submit once, poll under the
   * model's total deadline, and return the trusted answer text. Throws a
   * {@link ChatCompletionError} (public envelope) or
   * {@link RequestCancelledError} (client/shutdown abort); an unexpected error
   * propagates unmapped.
   */
  run(
    prepared: PreparedCompletion,
    signal: AbortSignal,
    options?: CompletionRunOptions,
  ): Promise<CompletionResult>;
}

/** Build the completion service from its ports. */
export function createChatCompletionService(deps: ChatCompletionDeps): ChatCompletionService {
  return {
    prepare(ctx: ChatCompletionRequestContext): PreparedCompletion {
      const { request, model } = ctx;
      // Serialize the prompt using the resolved model's NORMALIZED `promptMode`
      // (protocol vs direct — never a model-id comparison) and enforce the
      // model's UTF-8 byte limit against the FINAL selected prompt, BEFORE any
      // capacity is taken, any upstream call is made, or any SSE header is
      // committed. Mint the stream-stable identity here so both the JSON and SSE
      // encoders reuse one id/timestamp across the whole response.
      const prompt = deps.serializer.serialize(request, model.promptMode);
      if (Buffer.byteLength(prompt, "utf8") > model.maximumPromptBytes) {
        throw new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR);
      }
      // Tools are active only for an emulated model with a compiled toolset, a
      // non-empty tool set, and a `tool_choice` other than `none`. Otherwise the
      // completion produces ordinary text and no tool selection runs.
      const toolsActive =
        ctx.toolset !== undefined &&
        (request.tools?.length ?? 0) > 0 &&
        request.toolChoice !== undefined &&
        request.toolChoice.kind !== "none";
      const toolContext: PreparedToolContext | undefined =
        toolsActive && ctx.toolset !== undefined && request.toolChoice !== undefined
          ? {
              toolset: ctx.toolset,
              choice: request.toolChoice,
              parallelToolCalls: request.parallelToolCalls ?? true,
            }
          : undefined;
      return {
        id: deps.ids.completionId(),
        created: Math.floor(deps.clock.nowMs() / 1000),
        model: request.model,
        prompt,
        policy: model,
        keyId: ctx.keyId,
        selectedLlms: model.selectedLlms,
        ...(toolContext !== undefined ? { toolContext } : {}),
      };
    },

    async run(
      prepared: PreparedCompletion,
      signal: AbortSignal,
      options: CompletionRunOptions = {},
    ): Promise<CompletionResult> {
      const model = prepared.policy;

      // Compose the total deadline with the client/shutdown signal. The combined
      // signal bounds queue wait AND upstream execution; `timedOut` distinguishes
      // a deadline abort (→ 504) from a client/shutdown abort.
      const deadlineController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        deadlineController.abort();
      }, model.requestTimeoutMs);
      const combined = AbortSignal.any([signal, deadlineController.signal]);
      const deadlineMs = deps.clock.nowMs() + model.requestTimeoutMs;

      /** Map an abort to the right terminal error (deadline vs client/shutdown). */
      const cancellationError = (): Error =>
        timedOut ? new ChatCompletionError(COMPLETION_TIMEOUT_ERROR) : new RequestCancelledError();

      try {
        // Acquire capacity before creating an upstream thread.
        const acquisition = await deps.capacity.acquire(prepared.keyId, combined);
        if (!acquisition.ok) {
          if (acquisition.reason === "capacity") {
            throw new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR);
          }
          throw cancellationError();
        }

        try {
          // Capacity is held. Any lifecycle hook runs HERE — before the first
          // upstream call — so a hook failure releases the permit on the normal
          // exit path below and no thread is ever created.
          if (options.onCapacityAcquired !== undefined) {
            await options.onCapacityAcquired(combined);
          }

          // Obtain exactly one thread: continue the leased one (Phase 5A) or
          // create a new one. Either way `create_thread` runs at most once and
          // is never retried.
          const leasedThreadId = options.leasedThreadId;
          const reused = leasedThreadId !== undefined;
          // Structural guard for the invariant below: a caller that manages a
          // mapping (it leased a thread, or wants to bind a created one) must
          // also own the pre-submit transition. Refuse to submit otherwise
          // rather than leave the mapping in a state another owner can take.
          if (
            (reused || options.onThreadCreated !== undefined) &&
            options.onBeforeSubmit === undefined
          ) {
            throw new ChatCompletionError(THREAD_REUSE_UNAVAILABLE_ERROR);
          }
          let threadId: string;
          if (leasedThreadId !== undefined) {
            threadId = leasedThreadId;
          } else {
            const thread = await deps.adapter.createThread({
              title: THREAD_TITLE,
              signal: combined,
            });
            threadId = thread.threadId;
            // The caller binds the new thread to its mapping BEFORE any submit,
            // so a failure here leaves a blank thread rather than an untracked
            // conversation.
            if (options.onThreadCreated !== undefined) {
              await options.onThreadCreated(threadId, combined);
            }
          }

          // A leased thread MUST pass through the caller's pre-submit
          // transition. Without it the mapping would still read `reserved`
          // while this request submits, and an expired reserved lease is
          // takeable — so a second owner could submit into the same thread.
          if (options.onBeforeSubmit !== undefined) {
            await options.onBeforeSubmit(combined);
          }

          // The submit answers with the run it started. That id is the ONLY
          // thing that later proves a polled message belongs to this completion,
          // so it is carried straight into the poll and into tool-consensus
          // selection; it is never logged, retained, or exposed.
          const submitted = await deps.adapter.processMessage({
            threadId,
            prompt: prepared.prompt,
            selectedLlms: model.selectedLlms,
            generateCombined: model.generateCombined,
            signal: combined,
          });
          const outcome = await deps.poller.poll({
            threadId,
            answerSource: model.answerSource,
            pollIntervalMs: model.pollIntervalMs,
            maxPollIntervalMs: model.maxPollIntervalMs,
            deadlineMs,
            signal: combined,
            combinedRunId: submitted.combinedRunId,
          });
          if (outcome.kind === "timeout") {
            throw new ChatCompletionError(COMPLETION_TIMEOUT_ERROR);
          }
          // The thread id is carried out ONLY for process-local native-title
          // correlation and thread reuse; it never enters the public JSON/SSE.
          const threadInfo = {
            upstreamThreadId: threadId,
            upstreamThreadCreated: !reused,
          } as const;

          // Text mode (no active tools): return the desired-source answer.
          const toolContext = prepared.toolContext;
          if (toolContext === undefined) {
            return { kind: "text", content: outcome.content, ...threadInfo };
          }

          // Emulated tool mode: parse/vote over the validated message snapshot.
          const individuals: SourceCandidate[] = [];
          for (const source of prepared.selectedLlms) {
            // Consensus reads the same snapshot the poller ranked, so it applies
            // the same run correlation: a stale individual from an earlier turn
            // must never get a vote.
            const message = selectWinningMessage(outcome.messages, source, submitted.combinedRunId);
            if (message !== null && typeof message.content === "string") {
              individuals.push({
                source,
                content: message.content,
                percentUsage: message.percentUsage ?? null,
              });
            }
          }
          const selection = selectGeneration({
            desired: { content: outcome.content },
            individuals,
            toolset: toolContext.toolset,
            choice: toolContext.choice,
            parallelToolCalls: toolContext.parallelToolCalls,
            selectedLlms: prepared.selectedLlms,
            idGen: deps.toolCallIds,
          });
          if (!selection.ok) {
            // `required`/named choice with no valid tool call → 502 (never a
            // silent text fallback).
            throw new ChatCompletionError(INVALID_TOOL_RESPONSE_ERROR);
          }
          if (selection.generation.kind === "tool_calls") {
            return {
              kind: "tool_calls",
              toolCalls: selection.generation.calls,
              ...threadInfo,
            };
          }
          return {
            kind: "text",
            content: selection.generation.content,
            ...threadInfo,
          };
        } finally {
          acquisition.permit.release();
        }
      } catch (error) {
        if (isChatCompletionError(error) || isRequestCancelledError(error)) {
          throw error;
        }
        // Any failure once the combined signal has aborted is a cancellation:
        // either the total deadline (→ 504) or a client/shutdown abort. This
        // also covers an abort surfaced as a rejected sleep (a DOM abort
        // reason rather than an UpstreamError).
        if (combined.aborted) throw cancellationError();
        // Trap-safe identity check: an arbitrary thrown value (e.g. a hostile
        // Proxy) is never touched by `instanceof`/prototype lookup. Fields are
        // read only AFTER identity is established.
        if (isUpstreamError(error)) {
          if (error.category === "cancellation") throw cancellationError();
          throw new ChatCompletionError(openAIErrorForUpstream(error));
        }
        // An unexpected error propagates unmapped; the route returns the fixed 500.
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
