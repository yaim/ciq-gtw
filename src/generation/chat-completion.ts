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
 * Capacity is taken through the {@link CapacityController} port, so this module
 * is identical whether admission is process-local (specification §19) or backed
 * by the optional cross-replica lease registry (§19.2). The one visible
 * difference is that the shared controller can report `unavailable`, which maps
 * to `503 capacity_unavailable` rather than the busy-cluster `429`.
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
  CAPACITY_UNAVAILABLE_ERROR,
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
import { toParserSource, type PollOutcomeLabel } from "../observability/labels.js";
import { DISABLED_TELEMETRY, type Telemetry } from "../observability/telemetry.js";
import type { GatewaySpan, SpanAttributes, SpanName } from "../observability/tracing.js";
import { elapsedSeconds } from "../shared/elapsed.js";
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

/**
 * Close one upstream span as FAILED (specification §23.3: `ERROR` status, no
 * status message, a closed category).
 *
 * The exact public envelope for an upstream failure is decided later, by the
 * orchestrator's outer catch, from the normalized `UpstreamError` category — so
 * no more precise category is trusted at this point and the closed fallback is
 * used rather than a guess. The root `gateway.request` span still records the
 * exact category, taken from the envelope the gateway actually returns.
 */
function failUpstreamSpan(span: GatewaySpan | null, cancelled: boolean): void {
  if (span === null) return;
  span.setAttributes({ upstreamOutcome: cancelled ? "cancelled" : "error" });
  span.setError("other");
  span.end();
}

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
  /**
   * Observability ports (specification section 23). Omitted means fully
   * disabled, which is the default for tests and for any caller that has not
   * opted in. Telemetry is best-effort and never changes control flow, admission
   * order, or the response.
   */
  readonly telemetry?: Telemetry;
}

/** Per-request context (already authenticated, validated, and model-resolved). */
export interface ChatCompletionRequestContext {
  readonly request: NormalizedChatRequest;
  readonly model: VirtualModel;
  /** Opaque PROCESS-LOCAL gateway-key identity for per-key capacity accounting. */
  readonly keyId: string;
  /**
   * Opaque CROSS-REPLICA capacity scope for the matched gateway key (Phase 4D),
   * or `null` when shared capacity is disabled. Passed straight through to the
   * capacity port, which is the only collaborator that interprets it; this
   * service never learns whether capacity is local or shared.
   */
  readonly capacityScopeId?: string | null;
  /** Combined client-disconnect + shutdown abort signal (the deadline is added here). */
  readonly signal: AbortSignal;
  /**
   * The per-request compiled toolset (emulated mode with tools only). Carried
   * through {@link PreparedCompletion.toolContext} so `run` can parse/vote over
   * upstream tool-call candidates using the same compiled validators.
   */
  readonly toolset?: CompiledToolset;
  /**
   * The caller's `gateway.request` span, used as the explicit parent for every
   * span this service creates. Absent means the spans are roots (or no-ops when
   * tracing is disabled); it never affects the completion itself.
   */
  readonly requestSpan?: GatewaySpan;
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
  /** Opaque PROCESS-LOCAL gateway-key identity for per-key capacity accounting. */
  readonly keyId: string;
  /** Opaque CROSS-REPLICA capacity scope, or `null` when shared capacity is off. */
  readonly capacityScopeId: string | null;
  /**
   * The active emulated-tool policy, present only when tools are active (emulated
   * model, non-empty tools, `tool_choice` ≠ `none`). Absent means the completion
   * produces ordinary text. `run` uses it to parse/vote over upstream tool-call
   * candidates.
   */
  readonly toolContext?: PreparedToolContext;
  /** Configured source order, used for deterministic tool-consensus tie-breaks. */
  readonly selectedLlms: readonly string[];
  /** The caller's `gateway.request` span, carried through as the span parent. */
  readonly requestSpan?: GatewaySpan;
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
  const telemetry = deps.telemetry ?? DISABLED_TELEMETRY;
  const { metrics, tracing } = telemetry;
  // Resolved ONCE, at construction. Every telemetry statement below is guarded
  // by one of these booleans, so a disabled gateway builds no span options, no
  // observation samples, and no closures, reads no telemetry clock, and calls
  // into neither port. A boolean test is the whole cost.
  const metricsOn = metrics.enabled;
  const tracingOn = tracing.enabled;

  /**
   * Start a child span, or `null` when tracing is disabled.
   *
   * Built ONCE here rather than per `run()`, and `null` (not a no-op function)
   * when tracing is off — so a disabled completion allocates no closure. Call it
   * with optional invocation (`startChild?.(…)`), which short-circuits WITHOUT
   * evaluating its arguments, so the attribute objects below are never
   * constructed either.
   */
  const startChild = tracingOn
    ? (parent: GatewaySpan | undefined, name: SpanName, attributes?: SpanAttributes): GatewaySpan =>
        tracing.startSpan(name, {
          ...(parent !== undefined ? { parent } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
        })
    : null;

  /**
   * Single owner of `timeouts_total`: exactly one increment per completion that
   * terminates as the public completion timeout, whichever path produced it (the
   * poll deadline, an abort attributed to the deadline, or an upstream timeout
   * mapped to the same envelope). Identity comparison against the frozen
   * envelope is what makes "exactly once" checkable.
   *
   * Built ONCE here and `null` when metrics are disabled, so a disabled
   * completion allocates no closure — the same rule `startChild` follows.
   */
  const noteTerminalError = metricsOn
    ? (apiError: OpenAIApiError, modelId: string): void => {
        if (apiError === COMPLETION_TIMEOUT_ERROR) metrics.observeTimeout(modelId);
      }
    : null;

  return {
    prepare(ctx: ChatCompletionRequestContext): PreparedCompletion {
      const { request, model } = ctx;
      // Serialize the prompt using the resolved model's NORMALIZED `promptMode`
      // (protocol vs direct — never a model-id comparison) and enforce the
      // model's UTF-8 byte limit against the FINAL selected prompt, BEFORE any
      // capacity is taken, any upstream call is made, or any SSE header is
      // committed. Mint the stream-stable identity here so both the JSON and SSE
      // encoders reuse one id/timestamp across the whole response.
      const serializeSpan =
        startChild?.(ctx.requestSpan, "gateway.serialize", {
          model: model.id,
          promptMode: model.promptMode,
          toolMode: model.toolMode,
        }) ?? null;
      let prompt: string;
      try {
        prompt = deps.serializer.serialize(request, model.promptMode);
      } catch (error) {
        // No trusted category exists for an unexpected serializer failure, but
        // the gateway's own response for it is the fixed internal error.
        serializeSpan?.setError("internal_error");
        serializeSpan?.end();
        throw error;
      }
      if (Buffer.byteLength(prompt, "utf8") > model.maximumPromptBytes) {
        serializeSpan?.setError("context_length_exceeded");
        serializeSpan?.end();
        throw new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR);
      }
      serializeSpan?.end();
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
        capacityScopeId: ctx.capacityScopeId ?? null,
        selectedLlms: model.selectedLlms,
        ...(toolContext !== undefined ? { toolContext } : {}),
        ...(ctx.requestSpan !== undefined ? { requestSpan: ctx.requestSpan } : {}),
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

      // Every span this run creates hangs off the caller's `gateway.request`
      // span, so a completion is one trace rather than a scatter of roots.
      const parentSpan = prepared.requestSpan;

      try {
        // Acquire capacity before creating an upstream thread. The controller may
        // be the process-local one (specification §19) or the optional
        // cross-replica one (§19.2); this service cannot tell, and deliberately
        // passes both identities plus the request's own deadline so whichever is
        // wired has what it needs.
        const acquisition = await deps.capacity.acquire({
          keyId: prepared.keyId,
          capacityScopeId: prepared.capacityScopeId,
          requestTimeoutMs: model.requestTimeoutMs,
          signal: combined,
        });
        if (!acquisition.ok) {
          if (acquisition.reason === "capacity") {
            throw new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR);
          }
          // Only the shared controller can answer this: the decision could not be
          // made, so admitting the request would silently exceed the configured
          // cluster-wide limit. Distinct from the `429` above, which means the
          // cluster is genuinely busy.
          if (acquisition.reason === "unavailable") {
            throw new ChatCompletionError(CAPACITY_UNAVAILABLE_ERROR);
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
            const createSpan =
              startChild?.(parentSpan, "collectiviq.create_thread", {
                model: model.id,
                upstreamOperation: "create_thread",
              }) ?? null;
            let thread: Awaited<ReturnType<typeof deps.adapter.createThread>>;
            try {
              thread = await deps.adapter.createThread({
                title: THREAD_TITLE,
                signal: combined,
              });
            } catch (error) {
              // The public envelope is decided later, by the outer catch, from
              // the normalized upstream category — so the precise category is
              // not yet trusted here and the closed fallback is used. The root
              // `gateway.request` span still carries the exact one.
              failUpstreamSpan(createSpan, combined.aborted);
              throw error;
            }
            createSpan?.setAttributes({ upstreamOutcome: "success" });
            createSpan?.end();
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
          const submitSpan =
            startChild?.(parentSpan, "collectiviq.process_message", {
              model: model.id,
              upstreamOperation: "process_message",
            }) ?? null;
          let submitted: Awaited<ReturnType<typeof deps.adapter.processMessage>>;
          try {
            submitted = await deps.adapter.processMessage({
              threadId,
              prompt: prepared.prompt,
              selectedLlms: model.selectedLlms,
              generateCombined: model.generateCombined,
              signal: combined,
            });
          } catch (error) {
            failUpstreamSpan(submitSpan, combined.aborted);
            throw error;
          }
          submitSpan?.setAttributes({ upstreamOutcome: "success" });
          submitSpan?.end();

          // The whole polling PHASE is one span and one duration sample; the
          // individual `get_messages` attempts are counted by the adapter
          // decorator, which is the only layer that sees each one.
          const pollSpan =
            startChild?.(parentSpan, "collectiviq.poll", {
              model: model.id,
              upstreamOperation: "get_messages",
            }) ?? null;
          const pollStartNs = metricsOn ? process.hrtime.bigint() : 0n;
          let pollOutcome: PollOutcomeLabel = "error";
          let pollAttempts = 0;
          let outcome: Awaited<ReturnType<typeof deps.poller.poll>>;
          try {
            outcome = await deps.poller.poll({
              threadId,
              answerSource: model.answerSource,
              pollIntervalMs: model.pollIntervalMs,
              maxPollIntervalMs: model.maxPollIntervalMs,
              deadlineMs,
              signal: combined,
              combinedRunId: submitted.combinedRunId,
            });
            pollAttempts = outcome.pollCount;
            pollOutcome = outcome.kind === "timeout" ? "timeout" : "answer";
          } catch (error) {
            // A throw carries no attempt count, so the phase reports zero polls
            // while the decorator's per-attempt counter stays complete. The
            // deadline is distinguished from a client/shutdown abort here for
            // the same reason the public status is: they are different failures.
            pollOutcome = timedOut ? "timeout" : combined.aborted ? "cancelled" : "error";
            throw error;
          } finally {
            if (metricsOn) {
              metrics.observePollPhase({
                model: model.id,
                outcome: pollOutcome,
                durationSeconds: elapsedSeconds(pollStartNs),
                pollCount: pollAttempts,
              });
            }
            if (pollSpan !== null) {
              pollSpan.setAttributes({ pollOutcome, pollCount: pollAttempts });
              // Anything but a delivered answer is a failed phase. A deadline is
              // the one outcome whose public envelope is already known here.
              if (pollOutcome !== "answer") {
                pollSpan.setError(pollOutcome === "timeout" ? "completion_timeout" : "other");
              }
              pollSpan.end();
            }
          }
          if (outcome.kind === "timeout") {
            throw new ChatCompletionError(COMPLETION_TIMEOUT_ERROR);
          }
          // The thread id is carried out ONLY for process-local native-title
          // correlation and thread reuse; it never enters the public JSON/SSE.
          const threadInfo = {
            upstreamThreadId: threadId,
            upstreamThreadCreated: !reused,
          } as const;
          // Whether this completion CONTINUED an OpenCode session's thread
          // (specification §5.1.1) is recorded on the request span, which is
          // where a reader looks for a completion's shape. It is a boolean about
          // the gateway's own decision — never the thread or session identity.
          if (tracingOn) parentSpan?.setAttributes({ threadReused: reused });

          // Response parsing (specification section 8.7). The span covers both
          // transports and both modes; only emulated mode reports a parser
          // source, because text mode does no parsing.
          const parseSpan =
            startChild?.(parentSpan, "gateway.parse", {
              model: model.id,
              toolMode: model.toolMode,
            }) ?? null;
          try {
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
              const message = selectWinningMessage(
                outcome.messages,
                source,
                submitted.combinedRunId,
              );
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
              // silent text fallback). This is the single owner of
              // `tool_parse_failures_total`.
              if (metricsOn) metrics.observeToolParseFailure(model.id);
              parseSpan?.setError("invalid_tool_response");
              throw new ChatCompletionError(INVALID_TOOL_RESPONSE_ERROR);
            }
            if (selection.generation.kind === "tool_calls") {
              const parserSource = toParserSource(selection.generation.source);
              if (parserSource !== null) {
                if (metricsOn) {
                  metrics.observeToolResponse({
                    model: model.id,
                    toolMode: model.toolMode,
                    parserSource,
                  });
                }
                parseSpan?.setAttributes({
                  parserSource,
                  toolCallCount: selection.generation.calls.length,
                });
              }
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
          } catch (error) {
            // Selection is total in practice, so this is defence in depth — but
            // §23.3 requires EVERY failure exit to mark its span failed, and a
            // `finally` alone would end it with an UNSET status. A
            // `ChatCompletionError` already recorded its own precise category.
            if (!isChatCompletionError(error)) parseSpan?.setError("internal_error");
            throw error;
          } finally {
            parseSpan?.end();
          }
        } finally {
          acquisition.permit.release();
        }
      } catch (error) {
        if (isChatCompletionError(error)) {
          noteTerminalError?.(error.apiError, model.id);
          throw error;
        }
        if (isRequestCancelledError(error)) throw error;
        // Any failure once the combined signal has aborted is a cancellation:
        // either the total deadline (→ 504) or a client/shutdown abort. This
        // also covers an abort surfaced as a rejected sleep (a DOM abort
        // reason rather than an UpstreamError).
        if (combined.aborted) {
          const cancelled = cancellationError();
          if (isChatCompletionError(cancelled)) noteTerminalError?.(cancelled.apiError, model.id);
          throw cancelled;
        }
        // Trap-safe identity check: an arbitrary thrown value (e.g. a hostile
        // Proxy) is never touched by `instanceof`/prototype lookup. Fields are
        // read only AFTER identity is established.
        if (isUpstreamError(error)) {
          if (error.category === "cancellation") {
            const cancelled = cancellationError();
            if (isChatCompletionError(cancelled)) noteTerminalError?.(cancelled.apiError, model.id);
            throw cancelled;
          }
          const mapped = openAIErrorForUpstream(error);
          noteTerminalError?.(mapped, model.id);
          throw new ChatCompletionError(mapped);
        }
        // An unexpected error propagates unmapped; the route returns the fixed 500.
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
