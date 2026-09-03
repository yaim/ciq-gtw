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

// --- Capacity / backpressure (specification sections 19, 19.2) ---------------

/** A single acquired capacity permit. `release()` must be idempotent. */
export interface Permit {
  release(): void;
}

/**
 * Everything an admission decision may depend on, in one structured input.
 *
 * The process-local controller (specification section 19) reads only `keyId` and
 * `signal`; the optional cross-replica controller (section 19.2) additionally
 * needs the opaque shared scope and the request's own deadline, which bounds the
 * lease its permit carries. Passing one value keeps both implementations behind
 * the identical port.
 */
export interface CapacityRequest {
  /**
   * The PROCESS-LOCAL opaque gateway-key identity (`k<index>`). Ordering
   * dependent and meaningless outside this process, so it is used only for local
   * per-key accounting and is never written to shared state.
   */
  readonly keyId: string;
  /**
   * The CROSS-REPLICA opaque capacity scope for the matched gateway key, or
   * `null` when shared capacity is disabled (or, defensively, when it is enabled
   * but no scope was derived — which the shared controller must treat as an
   * unavailable dependency rather than a silent downgrade to local accounting).
   * The local controller ignores it.
   */
  readonly capacityScopeId: string | null;
  /**
   * The resolved model's total request deadline, in ms. The shared controller
   * derives its permit lease from this plus a fixed margin, so a live request's
   * permit cannot expire mid-completion. The local controller ignores it.
   */
  readonly requestTimeoutMs: number;
  /** Combined client-disconnect + total-deadline + shutdown abort signal. */
  readonly signal: AbortSignal;
}

/**
 * The outcome of a capacity acquisition.
 *
 * `capacity` covers a full queue, a queue-wait timeout, and closed admission
 * (all map to the public `429 gateway_capacity_exceeded`). `cancelled` means the
 * caller's signal aborted while waiting (the orchestrator decides whether that
 * abort was the total deadline or a client/shutdown abort). `unavailable` is
 * reachable ONLY from the optional cross-replica controller and means the
 * decision could not be made at all — an unusable Redis, corrupt or ambiguous
 * shared state, or an enabled-but-unwired instance — which maps to the public
 * `503 capacity_unavailable`. It is deliberately distinct from `capacity`: one
 * says "the cluster is busy", the other says "the gateway cannot tell".
 */
export type CapacityAcquisition =
  | { readonly ok: true; readonly permit: Permit }
  | { readonly ok: false; readonly reason: "capacity" | "cancelled" | "unavailable" };

/**
 * Admission controller enforcing a global active limit, a per-key active limit,
 * and a bounded FIFO queue with a bounded wait.
 *
 * The default implementation (`capacity.ts`) is PROCESS-LOCAL: its limits and
 * its queue apply to one replica. The optional Phase 4D implementation
 * (`src/shared-capacity/`) makes the two ACTIVE limits cluster-wide while
 * keeping the queue, the queue length, and the queue wait per replica; it is the
 * only implementation that can answer `unavailable`.
 */
export interface CapacityController {
  /**
   * Acquire a permit, waiting in the bounded local queue if necessary. Resolves
   * with a permit, a `capacity` rejection (full/timed-out/closed), a `cancelled`
   * rejection when the request's signal aborts first, or an `unavailable`
   * rejection when a shared decision could not be made. Never throws.
   */
  acquire(request: CapacityRequest): Promise<CapacityAcquisition>;
  /** Stop admitting new work and reject everything currently queued. */
  closeAdmission(): void;
  /**
   * Permits currently HELD BY THIS REPLICA (for metrics/tests). Under shared
   * capacity it counts confirmed shared permits this process holds, never
   * cluster-wide occupancy — which no replica can observe locally.
   */
  readonly activeCount: number;
  /** THIS REPLICA's currently waiting requests (for metrics/tests). */
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
  /**
   * The `combined_run_id` this completion's `process_message` returned.
   *
   * REQUIRED for every poll, not only for a reused thread, so there is exactly
   * one correctness rule: a message may be selected only when it names this same
   * run. Upstream message ORDERING and PAGINATION are unverified (specification
   * section 35, items 7 and 8), so nothing about a message's position or recency
   * can establish that it belongs to this submission — only the run id can. A
   * reused thread that still holds every earlier turn is the sharpest case, but
   * an uncorrelated answer would be just as wrong on a fresh thread.
   *
   * When no correlated message arrives before the deadline the run times out
   * rather than returning older or unrelated thread content.
   */
  readonly combinedRunId: string;
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
      /** How many `get_messages` attempts this polling run issued. */
      readonly pollCount: number;
    }
  | {
      readonly kind: "timeout";
      /** How many `get_messages` attempts this polling run issued. */
      readonly pollCount: number;
    };

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
