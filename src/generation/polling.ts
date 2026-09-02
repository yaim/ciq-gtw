/**
 * Polling coordinator and answer selection (specification sections 8.6, 10.3).
 *
 * The poller waits for a usable CollectivIQ answer by repeatedly reading the
 * thread's messages via the adapter's idempotent `getMessages`. It never creates
 * threads, never processes messages, and never uses upstream event streams.
 * Selection is a single deterministic policy so duplicate/racing upstream
 * messages always resolve to one stable answer, and malformed metadata can never
 * throw or win by accident. Every candidate must first be correlated to the run
 * this completion's `process_message` started, so the policy only ever orders
 * messages that provably belong to the caller's own submission.
 */
import { UpstreamError, isUpstreamError } from "../collectiviq/errors.js";
import type { CollectivIQAdapter, UpstreamMessage } from "../collectiviq/types.js";
import type { Clock, PollOutcome, PollParams, Poller, RandomFn, Sleeper } from "./types.js";

interface ParsedTimestamp {
  readonly valid: boolean;
  readonly value: number;
}

interface ParsedId {
  readonly sortable: boolean;
  readonly value: number;
}

/** A usable candidate paired with its parsed, comparable metadata. */
interface Candidate {
  readonly message: UpstreamMessage;
  readonly content: string;
  readonly ts: ParsedTimestamp;
  readonly id: ParsedId;
  readonly index: number;
}

const DIGITS_ONLY = /^[0-9]+$/;

/**
 * A `createdAt` is valid when it is a finite number (use it directly) or a
 * string that `Date.parse` maps to a finite value (use those milliseconds).
 */
function parseTimestamp(createdAt: string | number | null): ParsedTimestamp {
  if (typeof createdAt === "number") {
    return Number.isFinite(createdAt)
      ? { valid: true, value: createdAt }
      : { valid: false, value: 0 };
  }
  if (typeof createdAt === "string") {
    const ms = Date.parse(createdAt);
    return Number.isFinite(ms) ? { valid: true, value: ms } : { valid: false, value: 0 };
  }
  return { valid: false, value: 0 };
}

/**
 * An `id` is safely sortable when it is a finite number, or a string of ASCII
 * digits whose numeric value is a safe integer. Compared numerically.
 */
function parseId(id: string | number | null): ParsedId {
  if (typeof id === "number") {
    return Number.isFinite(id) ? { sortable: true, value: id } : { sortable: false, value: 0 };
  }
  if (typeof id === "string" && DIGITS_ONLY.test(id)) {
    const value = Number(id);
    if (Number.isSafeInteger(value)) return { sortable: true, value };
  }
  return { sortable: false, value: 0 };
}

/**
 * True when candidate `a` outranks candidate `b` under the selection policy:
 * (1) valid timestamp beats none, then higher timestamp; (2) sortable id beats
 * none, then higher id; (3) later occurrence in the array. Indices are always
 * distinct, so there is never a full tie.
 */
function outranks(a: Candidate, b: Candidate): boolean {
  if (a.ts.valid !== b.ts.valid) return a.ts.valid;
  if (a.ts.valid && b.ts.valid && a.ts.value !== b.ts.value) {
    return a.ts.value > b.ts.value;
  }
  if (a.id.sortable !== b.id.sortable) return a.id.sortable;
  if (a.id.sortable && b.id.sortable && a.id.value !== b.id.value) {
    return a.id.value > b.id.value;
  }
  return a.index > b.index;
}

/**
 * Select the single winning MESSAGE for `source` from the thread's messages, or
 * `null` when no usable candidate exists, under the deterministic ordering
 * policy. Exposed so the tool engine can read per-source content AND metadata
 * (e.g. `percentUsage`) for consensus voting.
 *
 * `combinedRunId` is the run this completion's `process_message` returned, and a
 * message is a candidate ONLY when its own normalized `combinedRunId` is exactly
 * equal to it. This is the authoritative correlation rule and applies to every
 * completion, not just a reused thread: upstream message ORDERING and PAGINATION
 * are unverified (specification section 35, items 7 and 8), so position, recency,
 * and snapshot completeness prove nothing about which run produced an entry —
 * only the run id does. A message whose run id is `null` (the entry named no run)
 * or different can therefore never win, and a thread that produces no correlated
 * message simply yields no answer and the caller times out.
 *
 * The filter is applied while COLLECTING candidates rather than to an already
 * chosen winner. Ranking first would let a foreign-run message that outranks this
 * run's answer take the top slot, be rejected, and starve a perfectly good answer
 * sitting in the same snapshot.
 */
export function selectWinningMessage(
  messages: readonly UpstreamMessage[],
  source: string,
  combinedRunId: string,
): UpstreamMessage | null {
  let best: Candidate | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.source !== source) continue;
    if (message.combinedRunId !== combinedRunId) continue;
    const content = message.content;
    if (typeof content !== "string" || content.trim().length === 0) continue;
    const candidate: Candidate = {
      message,
      content,
      ts: parseTimestamp(message.createdAt),
      id: parseId(message.id),
      index,
    };
    if (best === null || outranks(candidate, best)) best = candidate;
  }
  return best === null ? null : best.message;
}

/**
 * Select the single answer for `answerSource` produced by run `combinedRunId`, or
 * `null` when no usable candidate exists. Returns the original (untrimmed)
 * content of the winning candidate.
 */
export function selectAnswer(
  messages: readonly UpstreamMessage[],
  answerSource: string,
  combinedRunId: string,
): string | null {
  const winner = selectWinningMessage(messages, answerSource, combinedRunId);
  return winner === null ? null : winner.content;
}

const defaultClock: Clock = { nowMs: () => Date.now() };

/**
 * Abort-aware sleep: clears its timer and rejects with a normalized
 * cancellation on abort, so an aborted backoff surfaces as an
 * {@link UpstreamError} the orchestrator already understands.
 */
const defaultSleep: Sleeper = {
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new UpstreamError("cancellation"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        reject(new UpstreamError("cancellation"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export interface PollerSeams {
  readonly clock?: Clock;
  readonly sleep?: Sleeper;
  readonly random?: RandomFn;
}

export function createPoller(adapter: CollectivIQAdapter, seams: PollerSeams = {}): Poller {
  const clock = seams.clock ?? defaultClock;
  const sleeper = seams.sleep ?? defaultSleep;
  const random = seams.random ?? Math.random;

  async function poll(params: PollParams): Promise<PollOutcome> {
    const fixed = params.pollIntervalMs === params.maxPollIntervalMs;
    let interval = params.pollIntervalMs;

    for (;;) {
      // The total request deadline and client/shutdown cancellation are
      // AUTHORITATIVE and are checked BEFORE every upstream poll: a `getMessages`
      // is never issued once the deadline has expired or the request was
      // cancelled. Cancellation is kept distinct from a timeout.
      if (params.signal.aborted) throw new UpstreamError("cancellation");
      if (clock.nowMs() >= params.deadlineMs) return { kind: "timeout" };

      let messages: readonly UpstreamMessage[] | null = null;
      let pollError: unknown;
      let failed = false;
      try {
        const res = await adapter.getMessages(params.threadId, params.signal);
        messages = res.messages;
      } catch (err) {
        failed = true;
        pollError = err;
      }

      // Cancellation is AUTHORITATIVE and is rechecked the instant the poll
      // settles — BEFORE interpreting a returned answer or a thrown upstream
      // error, and BEFORE the deadline. If the signal aborted while this
      // `getMessages` was in flight, the completion is cancelled: a fulfilled
      // poll can never win with a late answer, and a rejected poll can never be
      // reinterpreted as a timeout or transport error. The orchestrator maps the
      // combined signal to the correct source (deadline → 504, client → no body,
      // shutdown → 503).
      if (params.signal.aborted) throw new UpstreamError("cancellation");

      if (failed) {
        // A failure observed AT OR AFTER the deadline (but with no cancellation)
        // is the gateway timeout — regardless of whether it was retryable — and
        // must not leak out as an upstream transport error.
        if (clock.nowMs() >= params.deadlineMs) return { kind: "timeout" };
        // Otherwise only an idempotent-GET retryable error may be retried (with
        // time still remaining); every other failure is terminal. A transient
        // miss falls through to the backoff sleep. The retryable field is read
        // only AFTER trap-safe identity is established.
        if (!(isUpstreamError(pollError) && pollError.retryable)) throw pollError;
      } else if (messages !== null) {
        // Recheck the deadline AFTER the poll resolves and BEFORE accepting its
        // result: a response that arrived at or after the deadline is a timeout,
        // never a successful completion.
        if (clock.nowMs() >= params.deadlineMs) return { kind: "timeout" };
        // Only a message this run produced may be selected, so an earlier turn's
        // answer in a reused thread — or any unrelated entry — can never win.
        const answer = selectAnswer(messages, params.answerSource, params.combinedRunId);
        // Return the full validated snapshot alongside the selected desired-source
        // answer so the tool engine can parse/vote over per-source candidates.
        if (answer !== null) return { kind: "answer", content: answer, messages };
      }

      // Next sleep: the base/jittered interval never exceeds the configured
      // maximum poll interval, and the actual sleep never passes the deadline.
      const jittered = fixed ? params.pollIntervalMs : interval * (1 + (random() * 2 - 1) * 0.1);
      const capped = Math.min(jittered, params.maxPollIntervalMs);
      const remaining = params.deadlineMs - clock.nowMs();
      const sleepMs = Math.max(0, Math.min(capped, remaining));
      if (sleepMs <= 0) return { kind: "timeout" };

      await sleeper.sleep(sleepMs, params.signal);

      if (!fixed) interval = Math.min(params.maxPollIntervalMs, interval * 1.25);
    }
  }

  return { poll };
}
