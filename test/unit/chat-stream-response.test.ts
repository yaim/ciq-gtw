import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { streamChatCompletion } from "../../src/api/chat-stream-response.js";
import type { CompletionResult } from "../../src/generation/chat-completion.js";
import {
  ChatCompletionError,
  RequestCancelledError,
} from "../../src/generation/chat-completion.js";
import { GATEWAY_CAPACITY_EXCEEDED_ERROR } from "../../src/openai/errors.js";
import type { StreamMeta } from "../../src/openai/chat-stream.js";

const META: StreamMeta = {
  id: "chatcmpl_ciq_s",
  created: 1_785_000_000,
  model: "collectiviq-fast",
  index: 0,
};

/**
 * Node-faithful fake `ServerResponse`.
 *
 * - `allowWrite = true`: `write` returns `true`; the flush callback fires on a
 *   microtask (a reading client).
 * - `allowWrite = false`: `write` returns `false` (backpressure) and the flush
 *   callback is held until {@link FakeRes.flushDrain} — modelling a stuck client.
 * - `failWrites`: `write` returns `true` but the callback reports an error.
 * - `throwOnWrite`: `write` throws synchronously.
 * `destroy()`/`end()` emit `close`; `destroy()` also errors any held callbacks.
 */
class FakeRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  frames: string[] = [];
  flushed = false;
  writableEnded = false;
  destroyed = false;
  allowWrite = true;
  failWrites = false;
  throwOnWrite = false;
  throwOnEnd = false; // end() throws synchronously
  withholdEndCallback = false; // end() returns but never emits close / calls its cb
  private held: ((err?: Error | null) => void)[] = [];

  setHeader(k: string, v: string | number): void {
    this.headers[k.toLowerCase()] = String(v);
  }
  flushHeaders(): void {
    this.flushed = true;
  }
  write(frame: string, cb?: (err?: Error | null) => void): boolean {
    if (this.throwOnWrite) throw new Error("synchronous write failure");
    this.frames.push(frame);
    if (this.failWrites) {
      if (cb) queueMicrotask(() => cb(new Error("EPIPE")));
      return true;
    }
    if (this.allowWrite) {
      if (cb) queueMicrotask(() => cb(null));
      return true;
    }
    if (cb) this.held.push(cb); // backpressure: settle on drain
    return false;
  }
  /** Flush held write callbacks (as Node does around a `drain`). */
  flushDrain(): void {
    const cbs = this.held;
    this.held = [];
    for (const cb of cbs) cb(null);
    this.emit("drain");
  }
  end(cb?: () => void): void {
    if (this.throwOnEnd) throw new Error("synchronous end failure");
    if (this.writableEnded || this.destroyed) {
      cb?.();
      return;
    }
    this.writableEnded = true;
    // Model a transport whose end() returns but never flushes: no close event,
    // no callback — only the writer's bounded fallback can then finish it.
    if (this.withholdEndCallback) return;
    this.emit("close");
    cb?.();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const cbs = this.held;
    this.held = [];
    for (const cb of cbs) cb(new Error("destroyed"));
    this.emit("close");
  }
}

function fakeReply(res: FakeRes): FastifyReply {
  return { hijack: () => {}, raw: res } as unknown as FastifyReply;
}

/** All recorded `data:` records parsed to objects (skips comments/[DONE]). */
function dataObjects(res: FakeRes): unknown[] {
  return res.frames
    .filter((f) => f.startsWith("data: ") && !f.startsWith("data: [DONE]"))
    .map((f) => JSON.parse(f.slice("data: ".length, -2)) as unknown);
}
const deltasOf = (res: FakeRes): unknown[] =>
  dataObjects(res).map((o) => (o as { choices: { delta: unknown }[] }).choices[0]?.delta);
const keepAlives = (res: FakeRes): string[] =>
  res.frames.filter((f) => f.startsWith(": collectiviq-gateway keep-alive"));
const hasDone = (res: FakeRes): boolean => res.frames.includes("data: [DONE]\n\n");
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** Yield past a zero-delay macrotask (e.g. the writer's bounded fallback timer). */
const nextTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
/** Temporary per-stream listeners the writer must clean up (drain/close/error). */
const tempListeners = (res: FakeRes): number =>
  res.listenerCount("drain") + res.listenerCount("close") + res.listenerCount("error");

afterEach(() => {
  vi.useRealTimers();
});

describe("streamChatCompletion — ordering and success", () => {
  it("emits the assistant-role chunk BEFORE the completion resolves and before upstream work", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let resolveRun!: (r: CompletionResult) => void;
    const run = (signal: AbortSignal): Promise<CompletionResult> => {
      seenSignal = signal;
      return new Promise((r) => (resolveRun = r));
    };

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run,
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.flushed).toBe(true);
    expect(res.frames).toHaveLength(1);
    expect(deltasOf(res)).toEqual([{ role: "assistant" }]);
    expect(seenSignal).toBe(clientAbort.signal);

    resolveRun({ upstreamThreadId: "thread-test", content: "Hello world" });
    await p;

    expect(deltasOf(res)).toEqual([{ role: "assistant" }, { content: "Hello world" }, {}]);
    for (const obj of dataObjects(res)) {
      expect(obj).toMatchObject({
        id: "chatcmpl_ciq_s",
        model: "collectiviq-fast",
        object: "chat.completion.chunk",
      });
    }
    expect(hasDone(res)).toBe(true);
    expect(res.frames.at(-1)).toBe("data: [DONE]\n\n");
    expect(res.writableEnded).toBe(true);
    expect(tempListeners(res)).toBe(0); // every listener cleaned up
  });

  it("emits role, terminal, and [DONE] but no content frames for an empty answer", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    await streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.resolve({ upstreamThreadId: "thread-test", content: "" }),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });
    expect(deltasOf(res)).toEqual([{ role: "assistant" }, {}]);
    expect(dataObjects(res)[1]).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    expect(hasDone(res)).toBe(true);
    expect(tempListeners(res)).toBe(0);
  });
});

describe("streamChatCompletion — keep-alives", () => {
  it("emits keep-alive comments while waiting and stops them before terminal output", async () => {
    vi.useFakeTimers();
    const res = new FakeRes();
    const clientAbort = new AbortController();
    let resolveRun!: (r: CompletionResult) => void;
    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => new Promise<CompletionResult>((r) => (resolveRun = r)),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 15_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(keepAlives(res)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(keepAlives(res)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(keepAlives(res)).toHaveLength(3);

    resolveRun({ upstreamThreadId: "thread-test", content: "done" });
    await p;
    const keepAliveCount = keepAlives(res).length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(keepAlives(res)).toHaveLength(keepAliveCount);
    const doneIndex = res.frames.indexOf("data: [DONE]\n\n");
    for (let i = 0; i < res.frames.length; i += 1) {
      if (res.frames[i]?.startsWith(": collectiviq")) expect(i).toBeLessThan(doneIndex);
    }
  });
});

describe("streamChatCompletion — backpressure", () => {
  it("blocks later frames until each held write flushes on drain", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    const answer = "word ".repeat(400); // splits into multiple content chunks
    res.allowWrite = false; // every write backpressures until a drain

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.resolve({ upstreamThreadId: "thread-test", content: answer }),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick();
    // Only the role chunk was attempted; the next frame waits for the flush.
    expect(res.frames).toHaveLength(1);

    res.flushDrain();
    await tick();
    expect(res.frames).toHaveLength(2);
    res.flushDrain();
    await tick();
    expect(res.frames).toHaveLength(3);

    // Drain to completion without hanging.
    res.allowWrite = true;
    for (let i = 0; i < 50; i += 1) {
      res.flushDrain();
      await tick();
      if (res.writableEnded) break;
    }
    await p;
    expect(hasDone(res)).toBe(true);
    const content = dataObjects(res)
      .map(
        (o) =>
          (o as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? "",
      )
      .join("");
    expect(content).toBe(answer);
    expect(tempListeners(res)).toBe(0);
  });
});

describe("streamChatCompletion — post-header failures", () => {
  it("encodes a post-header gateway failure as a safe SSE error record + [DONE], no terminal chunk", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    await streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.reject(new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR)),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });
    const objs = dataObjects(res);
    expect(objs[0]).toMatchObject({ choices: [{ delta: { role: "assistant" } }] });
    expect(objs[1]).toEqual(GATEWAY_CAPACITY_EXCEEDED_ERROR.body);
    expect(JSON.stringify(objs)).not.toContain('"stop"');
    expect(hasDone(res)).toBe(true);
  });

  it("writes no body when the client already disconnected (cancellation)", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    await streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => {
        clientAbort.abort();
        return Promise.reject(new RequestCancelledError());
      },
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });
    expect(dataObjects(res)).toHaveLength(1);
    expect(hasDone(res)).toBe(false);
    expect(res.writableEnded).toBe(true);
  });
});

// --- Remediation regressions (would fail the pre-remediation writer) ---------

describe("streamChatCompletion — bounded write failures never reject", () => {
  it("(1) a synchronous role write() throw: fulfils, cancels, run never starts, no [DONE]", async () => {
    const res = new FakeRes();
    res.throwOnWrite = true;
    const clientAbort = new AbortController();
    let runCalls = 0;

    // Must FULFIL, never reject, after hijack.
    await expect(
      streamChatCompletion({
        reply: fakeReply(res),
        meta: META,
        run: () => {
          runCalls += 1;
          return Promise.resolve({ upstreamThreadId: "thread-test", content: "unreachable" });
        },
        runSignal: clientAbort.signal,
        clientAbort,
        keepAliveMs: 100_000,
      }),
    ).resolves.toBeUndefined();

    expect(runCalls).toBe(0); // role delivery failed → run never begins
    expect(clientAbort.signal.aborted).toBe(true); // client cancellation
    expect(res.destroyed || res.writableEnded).toBe(true); // response ended/destroyed
    expect(hasDone(res)).toBe(false);
    expect(tempListeners(res)).toBe(0);
  });

  it("(2) an async callback error on the role write: no run, no unhandled rejection, cancels + cleans up", async () => {
    const res = new FakeRes();
    res.failWrites = true; // write() returns true, callback reports an error
    const clientAbort = new AbortController();
    let runCalls = 0;

    await streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => {
        runCalls += 1;
        return Promise.resolve({ upstreamThreadId: "thread-test", content: "unreachable" });
      },
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    expect(runCalls).toBe(0);
    expect(clientAbort.signal.aborted).toBe(true);
    expect(hasDone(res)).toBe(false);
    expect(res.writableEnded || res.destroyed).toBe(true);
    expect(tempListeners(res)).toBe(0);
  });

  it("(3) a backpressured role write + shutdown abort before drain: settles, run never starts, force-closed, no leaks", async () => {
    const res = new FakeRes();
    res.allowWrite = false; // role write backpressures and is held
    const clientAbort = new AbortController();
    const shutdown = new AbortController();
    const runSignal = AbortSignal.any([clientAbort.signal, shutdown.signal]);
    let runCalls = 0;

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => {
        runCalls += 1;
        return Promise.resolve({ upstreamThreadId: "thread-test", content: "unreachable" });
      },
      runSignal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick();
    expect(res.frames).toHaveLength(1); // role frame buffered, awaiting flush
    expect(runCalls).toBe(0);

    shutdown.abort(); // shutdown fires while the role write is stuck
    await p; // settles promptly, no hang, no rejection

    expect(runCalls).toBe(0);
    expect(res.destroyed).toBe(true); // force-closed to keep the drain bound
    expect(hasDone(res)).toBe(false);
    // A force-close is silent: the client controller is NOT newly aborted.
    expect(clientAbort.signal.aborted).toBe(false);
    expect(tempListeners(res)).toBe(0); // no listener left attached
  });

  it("(4) a backpressured write during run + shutdown: pending write unblocks, run cancels, timer cleared", async () => {
    vi.useFakeTimers();
    const res = new FakeRes();
    const clientAbort = new AbortController();
    const shutdown = new AbortController();
    const runSignal = AbortSignal.any([clientAbort.signal, shutdown.signal]);
    let runCancelled = false;
    const run = (signal: AbortSignal): Promise<CompletionResult> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            runCancelled = true;
            reject(new RequestCancelledError());
          },
          { once: true },
        );
      });

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run,
      runSignal,
      clientAbort,
      keepAliveMs: 15_000,
    });

    await vi.advanceTimersByTimeAsync(0); // role flushes (allowWrite defaults true)
    res.allowWrite = false; // subsequent keep-alive backpressures and is held
    await vi.advanceTimersByTimeAsync(15_000);
    expect(res.frames.some((f) => f.startsWith(": collectiviq"))).toBe(true);

    shutdown.abort(); // pending keep-alive write is stuck; shutdown must unblock it
    await vi.runAllTimersAsync();
    await p;

    expect(runCancelled).toBe(true); // active work observed cancellation
    expect(res.destroyed).toBe(true); // stuck transport force-closed
    expect(hasDone(res)).toBe(false); // silent (a 503 cannot be guaranteed to drain)
    expect(tempListeners(res)).toBe(0);
  });

  it("(5) response error + close race: settles exactly once, cancels, cleans every listener", async () => {
    const res = new FakeRes();
    res.allowWrite = false; // role write is held so the races hit a pending write
    const clientAbort = new AbortController();
    let ended = 0;
    const origEnd = res.end.bind(res);
    res.end = () => {
      ended += 1;
      origEnd();
    };

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.resolve({ upstreamThreadId: "thread-test", content: "unreachable" }),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick();
    expect(res.frames).toHaveLength(1); // role write pending

    // Fire both a response error and a close in the same turn.
    res.emit("error", new Error("socket blew up"));
    res.emit("close");
    await p;

    expect(clientAbort.signal.aborted).toBe(true); // cancelled once
    expect(ended).toBeLessThanOrEqual(1); // no double end
    expect(hasDone(res)).toBe(false);
    expect(tempListeners(res)).toBe(0); // drain/close/error listeners all removed
  });
});

describe("streamChatCompletion — writable shutdown still emits 503", () => {
  it("(6) shutdown cancels run while the transport is writable: role, safe 503, [DONE], no stop terminal", async () => {
    const res = new FakeRes(); // allowWrite stays true → transport writable
    const clientAbort = new AbortController();
    const shutdown = new AbortController();
    const runSignal = AbortSignal.any([clientAbort.signal, shutdown.signal]);
    const run = (signal: AbortSignal): Promise<CompletionResult> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new RequestCancelledError()), { once: true });
      });

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run,
      runSignal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick(); // role opener flushes
    shutdown.abort(); // cancels run() while the client is still reading
    await p;

    const objs = dataObjects(res);
    expect(objs[0]).toMatchObject({ choices: [{ delta: { role: "assistant" } }] });
    expect(objs[1]).toMatchObject({ error: { code: "service_unavailable" } });
    expect(JSON.stringify(objs)).not.toContain('"stop"'); // no normal terminal chunk
    expect(hasDone(res)).toBe(true);
    expect(clientAbort.signal.aborted).toBe(false); // shutdown, not a client disconnect
    expect(tempListeners(res)).toBe(0);
  });
});

describe("streamChatCompletion — hardened forced termination", () => {
  // Drive a writable shutdown (role + safe 503 + [DONE] written) whose terminal
  // res.end() misbehaves. The stream must still finish destroyed exactly once,
  // never reject, never hang, and leave no listener or timer behind.
  const shutdownRun =
    () =>
    (signal: AbortSignal): Promise<CompletionResult> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new RequestCancelledError()), { once: true });
      });

  it("(7) end() throws on the forced path: fulfils, destroys immediately, 503 + [DONE] emitted first, no leaks", async () => {
    const res = new FakeRes();
    res.throwOnEnd = true; // res.end() throws synchronously during termination
    const clientAbort = new AbortController();
    const shutdown = new AbortController();
    const runSignal = AbortSignal.any([clientAbort.signal, shutdown.signal]);

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: shutdownRun(),
      runSignal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick(); // role opener flushes
    shutdown.abort(); // cancels run() → writable 503 path → finishResponse throws

    await expect(p).resolves.toBeUndefined(); // fulfils, never rejects

    // The safe 503 + [DONE] were written before end() threw.
    expect(dataObjects(res)[1]).toMatchObject({ error: { code: "service_unavailable" } });
    expect(hasDone(res)).toBe(true);
    // end() threw → the response is destroyed immediately (never left hanging).
    expect(res.destroyed).toBe(true);
    expect(tempListeners(res)).toBe(0);
  });

  it("(8) end() returns but its callback never fires: the bounded fallback destroys, settles without hanging, no leaks", async () => {
    const res = new FakeRes();
    res.withholdEndCallback = true; // end() returns; no close, no callback
    const clientAbort = new AbortController();
    const shutdown = new AbortController();
    const runSignal = AbortSignal.any([clientAbort.signal, shutdown.signal]);

    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: shutdownRun(),
      runSignal,
      clientAbort,
      keepAliveMs: 100_000,
    });

    await tick(); // role opener flushes
    shutdown.abort(); // cancels run() → writable 503 path → finishResponse

    await p; // settles even though end()'s callback never fires (no hang)

    // The safe 503 + [DONE] were written and the response was ended.
    expect(dataObjects(res)[1]).toMatchObject({ error: { code: "service_unavailable" } });
    expect(hasDone(res)).toBe(true);
    expect(res.writableEnded).toBe(true);

    // The bounded next-turn fallback fires and destroys the socket.
    await nextTurn();
    expect(res.destroyed).toBe(true);
    expect(tempListeners(res)).toBe(0);
  });
});

describe("streamChatCompletion — onCompleted (native-title registration hook)", () => {
  it("invokes onCompleted exactly once, with the result, after a delivered [DONE]", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    const completed: CompletionResult[] = [];
    await streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.resolve({ upstreamThreadId: "T-42", content: "hello" }),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
      onCompleted: (r) => void completed.push(r),
    });
    expect(hasDone(res)).toBe(true);
    expect(completed).toEqual([{ upstreamThreadId: "T-42", content: "hello" }]);
  });

  it("does NOT invoke onCompleted when the transport closes before [DONE]", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    const answer = "word ".repeat(400); // multiple content chunks
    res.allowWrite = false; // backpressure every write
    let called = 0;
    const p = streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.resolve({ upstreamThreadId: "T-42", content: answer }),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
      onCompleted: () => void (called += 1),
    });
    await tick();
    // Destroy the transport mid-stream (before terminal/[DONE] can be written).
    res.destroy();
    await p;
    expect(hasDone(res)).toBe(false);
    expect(called).toBe(0);
  });

  it("does NOT invoke onCompleted on a post-header failure (error record path)", async () => {
    const res = new FakeRes();
    const clientAbort = new AbortController();
    let called = 0;
    await streamChatCompletion({
      reply: fakeReply(res),
      meta: META,
      run: () => Promise.reject(new ChatCompletionError(GATEWAY_CAPACITY_EXCEEDED_ERROR)),
      runSignal: clientAbort.signal,
      clientAbort,
      keepAliveMs: 100_000,
      onCompleted: () => void (called += 1),
    });
    expect(called).toBe(0);
  });
});
