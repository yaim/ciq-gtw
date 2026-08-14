/**
 * Synthetic-SSE transport for `stream: true` chat completions (specification
 * sections 14, 18). This is the ONLY place that touches the Node response for a
 * streamed completion: it commits SSE headers, emits the assistant-role opener,
 * runs keep-alives while the authoritative poll waits, then writes the answer as
 * content deltas, the terminal chunk, and `data: [DONE]`. The frame ENCODING is
 * owned by `src/openai/chat-stream.ts`; this module owns framing transport,
 * backpressure, keep-alive timers, and cancellation.
 *
 * Transport contract highlights:
 *  - Headers are committed only AFTER preparation succeeded (the caller resolves
 *    the model and prepares the prompt first), so a pre-header failure stays a
 *    normal JSON error and never a half-open SSE stream.
 *  - After the reply is hijacked, {@link streamChatCompletion} NEVER rejects and
 *    the {@link FrameWriter} NEVER rejects: every write resolves to an explicit
 *    `"written"` or `"closed"` outcome, so the caller stops immediately once the
 *    transport is gone.
 *  - The assistant-role chunk is written BEFORE capacity acquisition or any
 *    upstream request; if it cannot be delivered, `run()` and the keep-alive
 *    interval never start.
 *  - A `: collectiviq-gateway keep-alive` comment is written every 15 s while
 *    waiting; the interval is cleared on success, error, disconnect, shutdown,
 *    forced close, and write failure. Keep-alive writes cannot become unhandled
 *    rejections (the writer never rejects).
 *  - Writes are serialized and honour Node backpressure (a later frame waits for
 *    the prior frame's flush). A synchronous `res.write` throw, a callback error,
 *    a response `error`/`close`, or destruction settles the pending write as
 *    `"closed"` exactly once and cleans up every temporary listener.
 *  - The combined client-disconnect + shutdown signal unblocks an actively
 *    BACKPRESSURED write: rather than wait for a `drain` that may never come from
 *    a connected non-reading client, the writer force-closes the raw response so
 *    `app.close()` / `SHUTDOWN_DRAIN_MS` stays authoritative. A shutdown that
 *    cancels `run()` while the transport is still WRITABLE keeps the safe `503`
 *    path (that write flushes normally and is never force-closed).
 *  - A post-header gateway/upstream failure is encoded as one safe SSE error
 *    record (`data: {"error": …}`) then `data: [DONE]`, with no terminal chunk,
 *    while the transport is writable. A forced close under backpressure may end
 *    silently because a `503` cannot be guaranteed to drain.
 */
import type { FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import type { CompletionResult } from "../generation/chat-completion.js";
import { isChatCompletionError, isRequestCancelledError } from "../generation/chat-completion.js";
import {
  INTERNAL_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
  type OpenAIApiError,
} from "../openai/errors.js";
import {
  DONE_FRAME,
  KEEP_ALIVE_COMMENT,
  contentChunk,
  roleChunk,
  splitAnswerIntoChunks,
  sseData,
  sseError,
  terminalChunk,
  type StreamMeta,
} from "../openai/chat-stream.js";

/** Default keep-alive cadence, in ms (specification section 14). */
export const KEEP_ALIVE_INTERVAL_MS = 15_000;

/** The result of a single frame write. */
export type WriteOutcome = "written" | "closed";

/** Inputs for streaming one prepared completion to the client. */
export interface StreamChatCompletionOptions {
  /** The Fastify reply (hijacked here so Fastify never touches the response). */
  readonly reply: FastifyReply;
  /** The stream-stable identity for every frame. */
  readonly meta: StreamMeta;
  /** Execute the prepared completion under the combined abort signal. */
  readonly run: (signal: AbortSignal) => Promise<CompletionResult>;
  /**
   * Combined client-disconnect + shutdown signal passed to {@link run} and used
   * by the writer to unblock an actively backpressured write (force-close).
   */
  readonly runSignal: AbortSignal;
  /**
   * The CLIENT-only disconnect controller. The transport aborts it on a genuine
   * write/transport failure (so polling stops and capacity is released) and reads
   * its signal to decide whether a cancellation means "client gone → no body" or
   * "shutdown → 503 error record".
   */
  readonly clientAbort: AbortController;
  /** Keep-alive cadence override (tests only). */
  readonly keepAliveMs?: number;
}

/**
 * Serializes writes to one hijacked response and honours backpressure WITHOUT
 * ever rejecting. Each `write(frame)` chains after the previous one and resolves
 * to `"written"` (the frame was flushed) or `"closed"` (the transport is gone /
 * failed / was force-closed). Once closed, every later write is a bounded no-op
 * returning `"closed"`. A genuine transport failure aborts the client controller
 * so polling and capacity unwind.
 */
class FrameWriter {
  private tail: Promise<WriteOutcome> = Promise.resolve("written");
  private closed = false;
  /** Set before we deliberately `destroy()` the response, so our own `close`
   *  event is not misread as a premature client disconnect. */
  private selfDestroyed = false;
  private readonly onResError = (): void => this.markClosed(true);
  private readonly onResClose = (): void =>
    this.markClosed(!this.res.writableEnded && !this.selfDestroyed);

  constructor(
    private readonly res: ServerResponse,
    private readonly clientAbort: AbortController,
    private readonly signal: AbortSignal,
  ) {
    // Persistent listeners so a transport failure between writes is remembered
    // (and an otherwise-unhandled `error` event cannot crash the process).
    this.res.on("error", this.onResError);
    this.res.on("close", this.onResClose);
  }

  /** True once the transport is gone/failed/force-closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Remove the persistent listeners; call once the stream is fully settled. */
  dispose(): void {
    this.res.removeListener("error", this.onResError);
    this.res.removeListener("close", this.onResClose);
  }

  /** Serialized, non-rejecting write. */
  write(frame: string): Promise<WriteOutcome> {
    const next = this.tail.then(() => this.doWrite(frame));
    // Keep the tail non-rejecting even if a future refactor makes doWrite throw.
    this.tail = next.then(
      () => "written" as const,
      () => "closed" as const,
    );
    return next.catch(() => "closed" as const);
  }

  private markClosed(cancel: boolean): void {
    this.closed = true;
    if (cancel && !this.clientAbort.signal.aborted) this.clientAbort.abort();
  }

  private doWrite(frame: string): Promise<WriteOutcome> {
    return new Promise<WriteOutcome>((resolve) => {
      const res = this.res;
      // Bounded no-op once closed/ended/destroyed.
      if (this.closed || res.writableEnded || res.destroyed) {
        this.closed = true;
        resolve("closed");
        return;
      }

      let settled = false;
      let abortAttached = false;
      const cleanup = (): void => {
        res.removeListener("close", onClose);
        res.removeListener("error", onError);
        if (abortAttached) this.signal.removeEventListener("abort", onAbort);
      };
      const settle = (
        outcome: WriteOutcome,
        opts: { cancel?: boolean; destroy?: boolean } = {},
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (outcome === "closed") {
          this.markClosed(opts.cancel ?? false);
          if (opts.destroy) {
            this.selfDestroyed = true;
            try {
              if (!res.destroyed) res.destroy();
            } catch {
              /* a concurrent destroy is not worth surfacing */
            }
          }
        }
        resolve(outcome);
      };

      // A close/error while this write is pending settles it as closed. (A pending
      // write's own callback usually also fires with an error, but explicit
      // listeners make exactly-once settlement race-proof.)
      const onClose = (): void => settle("closed", { cancel: !res.writableEnded });
      const onError = (): void => settle("closed", { cancel: true });
      // Only attached when the write is actively BACKPRESSURED: a shutdown/client
      // abort then force-closes the stuck response so the drain bound holds.
      const onAbort = (): void => settle("closed", { destroy: true });
      res.once("close", onClose);
      res.once("error", onError);

      let ok: boolean;
      try {
        ok = res.write(frame, (err) => {
          if (err) settle("closed", { cancel: true });
          else settle("written");
        });
      } catch {
        // Synchronous write failure: never reject — close and force-destroy.
        settle("closed", { cancel: true, destroy: true });
        return;
      }

      if (!ok) {
        // Backpressured: the flush callback settles on drain, but a shutdown /
        // disconnect must be able to force-close a stuck (non-draining) response.
        if (this.signal.aborted) {
          settle("closed", { destroy: true });
          return;
        }
        this.signal.addEventListener("abort", onAbort, { once: true });
        abortAttached = true;
      }
      // ok === true: the write is flushing to a reading client; the flush
      // callback (or a close/error) settles it. It is intentionally NOT
      // force-closed on abort so a writable shutdown keeps the 503 path.
    });
  }
}

/**
 * Terminate the response once.
 *
 * On a normal success (`forceClose` false) the response just ends, leaving the
 * client to close its side — it is NEVER force-destroyed.
 *
 * On a forced termination (shutdown, client disconnect, or transport failure)
 * the already-written terminal frames are flushed via `res.end()` and the socket
 * is then destroyed, so a hijacked SSE keep-alive socket cannot linger and stall
 * `app.close()` / the shutdown drain. Because a hostile or half-broken transport
 * can make `res.end()` throw, or return without ever invoking its callback, the
 * forced path is hardened so the response ALWAYS ends destroyed exactly once and
 * shutdown can never hang:
 *  - if `res.end()` throws, the socket is destroyed immediately;
 *  - if `res.end()` returns but its callback never fires, a bounded next-turn
 *    fallback destroys the socket (all serialized frame writes have already
 *    settled before this is called, so a zero-delay fallback is safe and keeps
 *    the shutdown bound authoritative);
 *  - whichever of the end callback, a `close` event, the fallback, or a throw
 *    settles first wins; the rest are idempotent no-ops, the fallback timer is
 *    cleared, and the temporary `close` listener is removed.
 * A forced close may therefore end silently: delivery of a final frame to an
 * undrainable or failed transport cannot be guaranteed.
 */
function finishResponse(res: ServerResponse, forceClose: boolean): void {
  const destroy = (): void => {
    try {
      if (!res.destroyed) res.destroy();
    } catch {
      /* concurrent destroy */
    }
  };

  // Normal success: end gracefully; never force-destroy.
  if (!forceClose) {
    try {
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch {
      /* a concurrent socket close is not an error worth surfacing */
    }
    return;
  }

  // Forced termination.
  if (res.destroyed) return;
  if (res.writableEnded) {
    destroy();
    return;
  }

  let settled = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const onClose = (): void => finalize();
  function finalize(): void {
    if (settled) return;
    settled = true;
    if (fallback !== undefined) clearTimeout(fallback);
    res.removeListener("close", onClose);
    destroy();
  }

  res.once("close", onClose);
  try {
    res.end(() => finalize());
  } catch {
    // end() threw synchronously: destroy immediately and clean up.
    finalize();
    return;
  }
  // end() returned; if its callback has not already fired (or a close settled
  // it), destroy on a bounded next-turn fallback so shutdown cannot hang.
  if (!settled) {
    fallback = setTimeout(finalize, 0);
    if (typeof fallback.unref === "function") fallback.unref();
  }
}

/**
 * Map a post-header failure to the safe OpenAI envelope to encode as an SSE
 * error record, or `null` when the client is already gone (no body is written).
 * The thrown value is classified by IDENTITY only (trap-safe); an unexpected
 * value is never inspected and becomes the fixed internal error.
 */
function mapStreamFailure(failure: unknown, clientAbort: AbortController): OpenAIApiError | null {
  if (isChatCompletionError(failure)) return failure.apiError;
  if (isRequestCancelledError(failure)) {
    // A client disconnect gets no body; a shutdown (client still connected) → 503.
    return clientAbort.signal.aborted ? null : SERVICE_UNAVAILABLE_ERROR;
  }
  return INTERNAL_ERROR;
}

/**
 * Stream one prepared completion as synthetic SSE. Resolves when the response
 * has been fully written and ended; NEVER rejects (all failures are encoded as
 * SSE records or a silent close). The caller must `return reply` afterwards.
 */
export async function streamChatCompletion(opts: StreamChatCompletionOptions): Promise<void> {
  const { reply, meta, run, runSignal, clientAbort } = opts;
  const keepAliveMs = opts.keepAliveMs ?? KEEP_ALIVE_INTERVAL_MS;
  const res = reply.raw;

  // Commit SSE headers (200) and flush them so the client sees the stream start.
  try {
    reply.hijack();
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    // Defense-in-depth against intermediary buffering of the event stream.
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
  } catch {
    // The socket was already gone before headers could be committed: treat it as
    // a client disconnect and write no body. No upstream work has started yet, so
    // there is no capacity or poll to unwind — the abort is purely defensive.
    if (!clientAbort.signal.aborted) clientAbort.abort();
    finishResponse(res, true);
    return;
  }

  const writer = new FrameWriter(res, clientAbort, runSignal);
  // Force-close the socket on any terminal path reached because of shutdown, a
  // client disconnect, or a transport failure — so a hijacked SSE keep-alive
  // socket cannot outlive the request and stall shutdown. A clean success (no
  // abort, transport still open) ends gracefully instead.
  const finish = (): void => finishResponse(res, runSignal.aborted || writer.isClosed);
  try {
    // 1. Assistant-role opener BEFORE capacity acquisition or any upstream
    //    request. If it cannot be delivered, run()/keep-alive never start.
    if ((await writer.write(sseData(roleChunk(meta)))) === "closed") {
      finish();
      return;
    }

    // 2. Keep-alive comments while the authoritative poll waits. `unref` so a
    //    pending timer never keeps the process alive on shutdown. Keep-alive
    //    writes cannot reject (the writer never rejects).
    const keepAlive = setInterval(() => {
      void writer.write(KEEP_ALIVE_COMMENT);
    }, keepAliveMs);
    if (typeof keepAlive.unref === "function") keepAlive.unref();

    let result: CompletionResult | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await run(runSignal);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      // 3. Stop the keep-alive BEFORE any content/terminal/error output.
      clearInterval(keepAlive);
    }

    // If the transport is already gone (client disconnect or a force-closed,
    // stuck response), write no body — just make sure the socket is ended.
    if (writer.isClosed || clientAbort.signal.aborted) {
      finish();
      return;
    }

    if (!failed && result !== undefined) {
      // 4. Content deltas → terminal chunk → [DONE]. An empty answer emits no
      //    content frames but still emits the terminal chunk and [DONE]. Every
      //    write is checked so we stop the instant the transport closes.
      for (const piece of splitAnswerIntoChunks(result.content)) {
        if ((await writer.write(sseData(contentChunk(meta, piece)))) === "closed") {
          finish();
          return;
        }
      }
      if ((await writer.write(sseData(terminalChunk(meta)))) === "closed") {
        finish();
        return;
      }
      await writer.write(DONE_FRAME);
      finish();
      return;
    }

    // 5. Post-header failure: one safe error record then [DONE] (no terminal
    //    chunk), while the transport is writable.
    const apiError = mapStreamFailure(failure, clientAbort);
    if (apiError === null) {
      finish();
      return;
    }
    if ((await writer.write(sseError(apiError.body))) === "closed") {
      finish();
      return;
    }
    await writer.write(DONE_FRAME);
    finish();
  } finally {
    writer.dispose();
  }
}
