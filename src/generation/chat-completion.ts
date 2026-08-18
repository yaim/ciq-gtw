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
 *  - `run` executes the stateless per-completion flow: acquire capacity → create
 *    exactly one thread → submit exactly once → poll → select text. Capacity is
 *    acquired BEFORE thread creation and released on every exit path.
 *    `create_thread`/`process_message` are never retried.
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
  openAIErrorForUpstream,
  type OpenAIApiError,
} from "../openai/errors.js";
import type { CapacityController, Clock, IdGenerator, Poller, PromptSerializer } from "./types.js";

/**
 * A generic, content-free upstream thread title. Never derived from prompt
 * content, model ids, repository names, filenames, users, or credentials.
 */
export const THREAD_TITLE = "CollectivIQ Gateway request";

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
}

/** Per-request context (already authenticated, validated, and model-resolved). */
export interface ChatCompletionRequestContext {
  readonly request: NormalizedChatRequest;
  readonly model: VirtualModel;
  /** Opaque gateway-key identity for per-key capacity accounting. */
  readonly keyId: string;
  /** Combined client-disconnect + shutdown abort signal (the deadline is added here). */
  readonly signal: AbortSignal;
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
}

/** The trusted result of a completed generation: parsed assistant answer text. */
export interface CompletionResult {
  /** The parsed assistant answer (may be an empty string). */
  readonly content: string;
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
   * Execute the prepared completion: acquire capacity, create exactly one
   * thread, submit once, poll under the model's total deadline, and return the
   * trusted answer text. Throws a {@link ChatCompletionError} (public envelope)
   * or {@link RequestCancelledError} (client/shutdown abort); an unexpected
   * error propagates unmapped.
   */
  run(prepared: PreparedCompletion, signal: AbortSignal): Promise<CompletionResult>;
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
      return {
        id: deps.ids.completionId(),
        created: Math.floor(deps.clock.nowMs() / 1000),
        model: request.model,
        prompt,
        policy: model,
        keyId: ctx.keyId,
      };
    },

    async run(prepared: PreparedCompletion, signal: AbortSignal): Promise<CompletionResult> {
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
          // Create exactly one thread, submit exactly once, then poll.
          const thread = await deps.adapter.createThread({
            title: THREAD_TITLE,
            signal: combined,
          });
          await deps.adapter.processMessage({
            threadId: thread.threadId,
            prompt: prepared.prompt,
            selectedLlms: model.selectedLlms,
            generateCombined: model.generateCombined,
            signal: combined,
          });
          const outcome = await deps.poller.poll({
            threadId: thread.threadId,
            answerSource: model.answerSource,
            pollIntervalMs: model.pollIntervalMs,
            maxPollIntervalMs: model.maxPollIntervalMs,
            deadlineMs,
            signal: combined,
          });
          if (outcome.kind === "timeout") {
            throw new ChatCompletionError(COMPLETION_TIMEOUT_ERROR);
          }
          return { content: outcome.content };
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
