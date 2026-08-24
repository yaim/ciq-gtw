/**
 * Shared generation-layer ports (specification sections 8.6, 15–19, 27).
 *
 * These narrow interfaces let the orchestrator (`chat-completion.ts`) depend on
 * capacity, polling, prompt serialization, ID, and clock behaviour without
 * importing their concrete implementations or any Fastify/CollectivIQ wire
 * type. Deterministic tests inject fakes for every seam here.
 */
import type { NormalizedChatRequest } from "../openai/chat-types.js";
import type { PromptMode } from "../config/schema.js";
import type { UpstreamMessage } from "../collectiviq/types.js";

// --- Time / randomness / IDs seams -------------------------------------------

/** Monotonic-enough millisecond clock (defaults to `Date.now`). */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  nowMs(): number;
}

/** Abort-aware sleep seam (defaults to a real `setTimeout`-backed sleep). */
export interface Sleeper {
  /**
   * Resolve after `ms`, or reject with the abort reason if `signal` aborts
   * first. Must clear its timer on every exit path (no dangling timers).
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Deterministic randomness seam for poll jitter (defaults to `Math.random`). */
export type RandomFn = () => number;

/** Public identifier generator for completion IDs. */
export interface IdGenerator {
  /** A unique `chatcmpl_ciq_*` completion id. */
  completionId(): string;
}

// --- Capacity / backpressure (specification section 19) ----------------------

/** A single acquired capacity permit. `release()` must be idempotent. */
export interface Permit {
  release(): void;
}

/**
 * The outcome of a capacity acquisition. `capacity` covers both a full queue
 * and a queue-wait timeout and closed admission (all map to the public `429`).
 * `cancelled` means the caller's signal aborted while waiting (the orchestrator
 * decides whether that abort was the total deadline or a client/shutdown abort).
 */
export type CapacityAcquisition =
  | { readonly ok: true; readonly permit: Permit }
  | { readonly ok: false; readonly reason: "capacity" | "cancelled" };

/**
 * Process-local admission controller enforcing a global active limit, a per-key
 * active limit, and a bounded FIFO queue with a bounded wait. Capacity is NOT
 * shared across replicas.
 */
export interface CapacityController {
  /**
   * Acquire a permit for `keyId`, waiting in the bounded queue if necessary.
   * Resolves with a permit, a `capacity` rejection (full/timed-out/closed), or
   * a `cancelled` rejection when `signal` aborts first. Never throws.
   */
  acquire(keyId: string, signal: AbortSignal): Promise<CapacityAcquisition>;
  /** Stop admitting new work and reject everything currently queued. */
  closeAdmission(): void;
  /** Current number of held permits (for readiness/metrics/tests). */
  readonly activeCount: number;
  /** Current number of queued waiters (for readiness/metrics/tests). */
  readonly queuedCount: number;
}

// --- Polling coordinator (specification section 8.6) -------------------------

/** Parameters for one polling run against a single upstream thread. */
export interface PollParams {
  readonly threadId: string;
  /** The model's desired answer `source` (exact match). */
  readonly answerSource: string;
  /** Base poll interval, in ms. */
  readonly pollIntervalMs: number;
  /** Maximum poll interval, in ms (equal to base disables backoff). */
  readonly maxPollIntervalMs: number;
  /** Absolute total deadline, in `Clock.nowMs()` units. */
  readonly deadlineMs: number;
  /** Combined client-disconnect + total-deadline + shutdown abort signal. */
  readonly signal: AbortSignal;
}

/**
 * The result of a polling run. A terminal upstream failure or cancellation is
 * thrown as an {@link import("../collectiviq/errors.js").UpstreamError} rather
 * than returned, so the orchestrator maps it once via the shared error mapper.
 *
 * On success `content` is the selected desired-source answer text and `messages`
 * is the full validated message snapshot at the moment the desired source became
 * available. The snapshot lets the tool engine parse and vote over per-source
 * candidates; the text path uses only `content`.
 */
export type PollOutcome =
  | {
      readonly kind: "answer";
      readonly content: string;
      readonly messages: readonly UpstreamMessage[];
    }
  | { readonly kind: "timeout" };

/** Waits for a usable CollectivIQ message via the adapter's `getMessages`. */
export interface Poller {
  poll(params: PollParams): Promise<PollOutcome>;
}

// --- Prompt serialization port (specification sections 8.4, 11) --------------

/**
 * Deterministic, model-policy-aware prompt serializer. Produces the final prompt
 * from a normalized request and the resolved model's NORMALIZED `promptMode`
 * (`protocol` → framing + versioned JSON envelope; `direct` → latest-user
 * content only). Pure: the same request and mode always yield byte-identical
 * output. It never enforces the byte limit itself — the orchestrator measures
 * the result against the model's `maximumPromptBytes`. The narrow `promptMode`
 * argument (not the full model policy) is all the serializer needs; behaviour is
 * driven from that validated mode, never from a model-id string.
 */
export interface PromptSerializer {
  serialize(request: NormalizedChatRequest, promptMode: PromptMode): string;
}
