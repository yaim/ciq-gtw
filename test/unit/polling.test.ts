import { describe, expect, it, vi } from "vitest";
import { createPoller, selectAnswer } from "../../src/generation/polling.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import type {
  CollectivIQAdapter,
  GetMessagesResult,
  UpstreamMessage,
} from "../../src/collectiviq/types.js";
import type { Clock, PollParams, Sleeper } from "../../src/generation/types.js";

function msg(
  source: string,
  content: string | null,
  extra: Partial<UpstreamMessage> = {},
): UpstreamMessage {
  return {
    source,
    content,
    percentUsage: null,
    createdAt: null,
    id: null,
    ...extra,
  };
}

const notImplemented = (): never => {
  throw new Error("must not be called");
};

/** Adapter whose `getMessages` returns/throws per call from `steps`. */
function makeAdapter(steps: readonly (UpstreamMessage[] | Error)[]): {
  adapter: CollectivIQAdapter;
  getMessages: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const getMessages = vi.fn(
    (_threadId: string, _signal?: AbortSignal): Promise<GetMessagesResult> => {
      const step = index < steps.length ? steps[index] : steps[steps.length - 1];
      index += 1;
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve({ messages: step ?? [], rawStatus: 200 });
    },
  );
  const adapter: CollectivIQAdapter = {
    createThread: notImplemented,
    processMessage: notImplemented,
    getMessages,
  };
  return { adapter, getMessages };
}

/** Fake clock + sleep that advances the clock by the requested amount. */
function timeSeam(start = 0): {
  clock: Clock;
  sleep: Sleeper;
  sleeps: number[];
  nowRef: { now: number };
} {
  const nowRef = { now: start };
  const sleeps: number[] = [];
  const clock: Clock = { nowMs: () => nowRef.now };
  const sleep: Sleeper = {
    sleep(ms: number): Promise<void> {
      sleeps.push(ms);
      nowRef.now += ms;
      return Promise.resolve();
    },
  };
  return { clock, sleep, sleeps, nowRef };
}

function params(overrides: Partial<PollParams> = {}): PollParams {
  return {
    threadId: "t1",
    answerSource: "gpt",
    pollIntervalMs: 500,
    maxPollIntervalMs: 500,
    deadlineMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("selectAnswer", () => {
  it("returns null when no message matches the exact source", () => {
    expect(selectAnswer([msg("other", "hi")], "gpt")).toBeNull();
    expect(selectAnswer([], "gpt")).toBeNull();
  });

  it("ignores wrong-source and empty-content messages", () => {
    const messages = [msg("other", "wrong"), msg("gpt", "   "), msg("gpt", null), msg("gpt", "ok")];
    expect(selectAnswer(messages, "gpt")).toBe("ok");
  });

  it("returns the original untrimmed content", () => {
    expect(selectAnswer([msg("gpt", "  padded  ")], "gpt")).toBe("  padded  ");
  });

  it("selects the latest valid timestamp", () => {
    const messages = [
      msg("gpt", "old", { createdAt: 100 }),
      msg("gpt", "new", { createdAt: 300 }),
      msg("gpt", "mid", { createdAt: "1970-01-01T00:00:00.200Z" }),
    ];
    expect(selectAnswer(messages, "gpt")).toBe("new");
  });

  it("prefers a candidate with a valid timestamp over one without", () => {
    const messages = [msg("gpt", "no-ts", { id: 999 }), msg("gpt", "has-ts", { createdAt: 5 })];
    expect(selectAnswer(messages, "gpt")).toBe("has-ts");
  });

  it("breaks timestamp ties by highest sortable id", () => {
    const messages = [
      msg("gpt", "a", { createdAt: 100, id: "10" }),
      msg("gpt", "b", { createdAt: 100, id: "42" }),
      msg("gpt", "c", { createdAt: 100, id: 7 }),
    ];
    expect(selectAnswer(messages, "gpt")).toBe("b");
  });

  it("breaks full ties by last occurrence", () => {
    const messages = [msg("gpt", "first"), msg("gpt", "second"), msg("gpt", "third")];
    expect(selectAnswer(messages, "gpt")).toBe("third");
  });

  it("does not throw or let invalid metadata win by accident", () => {
    const messages = [
      msg("gpt", "valid", { createdAt: 50, id: "5" }),
      msg("gpt", "bad-ts", { createdAt: "not-a-date" }),
      msg("gpt", "bad-id", { id: "12abc" }),
      msg("gpt", "huge-id", { id: "999999999999999999999999" }),
    ];
    // Only the candidate with a valid timestamp should win.
    expect(selectAnswer(messages, "gpt")).toBe("valid");
  });
});

describe("createPoller", () => {
  it("polls until the desired answer appears", async () => {
    const { adapter, getMessages } = makeAdapter([[], [msg("gpt", "answer")]]);
    const { clock, sleep, sleeps } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });

    const outcome = await poller.poll(params());
    expect(outcome).toEqual({ kind: "answer", content: "answer" });
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]);
  });

  it("ignores wrong-source messages while waiting", async () => {
    const { adapter } = makeAdapter([[msg("other", "noise")], [msg("gpt", "done")]]);
    const { clock, sleep } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const outcome = await poller.poll(params());
    expect(outcome).toEqual({ kind: "answer", content: "done" });
  });

  it("retries a retryable UpstreamError then succeeds", async () => {
    const retryable = new UpstreamError("network", undefined, "GET");
    expect(retryable.retryable).toBe(true);
    const { adapter, getMessages } = makeAdapter([retryable, [msg("gpt", "recovered")]]);
    const { clock, sleep } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });

    const outcome = await poller.poll(params());
    expect(outcome).toEqual({ kind: "answer", content: "recovered" });
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-retryable UpstreamError immediately", async () => {
    const fatal = new UpstreamError("validation", 422, "GET");
    expect(fatal.retryable).toBe(false);
    const { adapter, getMessages } = makeAdapter([fatal, [msg("gpt", "never")]]);
    const { clock, sleep } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });

    await expect(poller.poll(params())).rejects.toBe(fatal);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it("issues zero polls when the deadline has already expired", async () => {
    const { adapter, getMessages } = makeAdapter([[msg("gpt", "late")]]);
    const { clock, sleep } = timeSeam(1_000);
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const outcome = await poller.poll(params({ deadlineMs: 500 }));
    expect(outcome).toEqual({ kind: "timeout" });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("converts a retryable error observed at/after the deadline into a timeout", async () => {
    // The clock advances past the deadline DURING the poll; the retryable error
    // observed on return must become a timeout, not leak as a transport error.
    const retryable = new UpstreamError("network", undefined, "GET");
    let t = 0;
    const clock: Clock = { nowMs: () => t };
    const sleep: Sleeper = { sleep: () => Promise.resolve() };
    const getMessages = vi.fn((): Promise<GetMessagesResult> => {
      t = 200; // now >= deadline
      return Promise.reject(retryable);
    });
    const adapter: CollectivIQAdapter = {
      createThread: notImplemented,
      processMessage: notImplemented,
      getMessages,
    };
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const outcome = await poller.poll(params({ deadlineMs: 100 }));
    expect(outcome).toEqual({ kind: "timeout" });
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it("does not accept an answer that arrived at/after the deadline", async () => {
    // getMessages returns a usable answer but advances the clock past the
    // deadline; the late answer must not become a successful completion.
    let t = 0;
    const clock: Clock = { nowMs: () => t };
    const sleep: Sleeper = { sleep: () => Promise.resolve() };
    const getMessages = vi.fn((): Promise<GetMessagesResult> => {
      t = 200; // now >= deadline
      return Promise.resolve({ messages: [msg("gpt", "too late")], rawStatus: 200 });
    });
    const adapter: CollectivIQAdapter = {
      createThread: notImplemented,
      processMessage: notImplemented,
      getMessages,
    };
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const outcome = await poller.poll(params({ deadlineMs: 100 }));
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("throws cancellation (distinct from timeout) when the signal is already aborted", async () => {
    const { adapter, getMessages } = makeAdapter([[msg("gpt", "unused")]]);
    const { clock, sleep } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    await poller.poll(params({ signal: controller.signal })).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).category).toBe("cancellation");
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("prefers cancellation over a late answer when the signal aborts mid-poll", async () => {
    // The signal aborts WHILE `getMessages` is in flight, then the poll fulfils
    // with a usable answer. Cancellation observed after the poll settles must win
    // — the late answer can never become a successful completion.
    const controller = new AbortController();
    const { clock, sleep, sleeps } = timeSeam();
    const getMessages = vi.fn((): Promise<GetMessagesResult> => {
      controller.abort();
      return Promise.resolve({ messages: [msg("gpt", "answer")], rawStatus: 200 });
    });
    const adapter: CollectivIQAdapter = {
      createThread: notImplemented,
      processMessage: notImplemented,
      getMessages,
    };
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    let caught: unknown;
    await poller.poll(params({ signal: controller.signal })).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).category).toBe("cancellation");
    // Exactly one poll, and NO extra poll or sleep after cancellation.
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("prefers cancellation over timeout when a poll rejects as the deadline passes", async () => {
    // The signal aborts AND the clock reaches the deadline during the same poll,
    // which then rejects. Cancellation must take precedence over the timeout so
    // the orchestrator can apply the correct source-specific mapping (client vs
    // shutdown vs deadline) — the poll must not be misclassified as a plain
    // timeout, and the rejection must not leak as a transport error.
    const controller = new AbortController();
    let t = 0;
    const clock: Clock = { nowMs: () => t };
    const sleep: Sleeper = { sleep: () => Promise.resolve() };
    const rejected = new UpstreamError("cancellation");
    const getMessages = vi.fn((): Promise<GetMessagesResult> => {
      controller.abort();
      t = 200; // now >= deadlineMs as well
      return Promise.reject(rejected);
    });
    const adapter: CollectivIQAdapter = {
      createThread: notImplemented,
      processMessage: notImplemented,
      getMessages,
    };
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    let caught: unknown;
    await poller
      .poll(params({ deadlineMs: 100, signal: controller.signal }))
      .catch((err: unknown) => {
        caught = err;
      });
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).category).toBe("cancellation");
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it("caps the actual sleep (including jitter) at the maximum poll interval", async () => {
    // With backoff the interval grows to the max; positive jitter must never push
    // a real sleep above maxPollIntervalMs.
    const { adapter } = makeAdapter([[], [], [], [], [msg("gpt", "done")]]);
    const { clock, sleep, sleeps } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.999 });
    await poller.poll(params({ pollIntervalMs: 100, maxPollIntervalMs: 105, deadlineMs: 100_000 }));
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(105);
    // The interval reaches the cap and stays there despite +jitter.
    expect(sleeps.some((s) => s === 105)).toBe(true);
  });

  it("returns timeout when the deadline is reached", async () => {
    const { adapter } = makeAdapter([[]]);
    const { clock, sleep, sleeps } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const outcome = await poller.poll(
      params({ pollIntervalMs: 500, maxPollIntervalMs: 500, deadlineMs: 1_000 }),
    );
    expect(outcome).toEqual({ kind: "timeout" });
    // Two 500ms sleeps land exactly on the deadline; the third read sees now >= deadline.
    expect(sleeps).toEqual([500, 500]);
  });

  it("propagates an abort raised during sleep", async () => {
    const { adapter } = makeAdapter([[]]);
    const abortReason = new Error("aborted");
    const sleep: Sleeper = { sleep: () => Promise.reject(abortReason) };
    const clock: Clock = { nowMs: () => 0 };
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    await expect(poller.poll(params())).rejects.toBe(abortReason);
  });

  it("uses a fixed interval with no jitter when min equals max", async () => {
    const { adapter } = makeAdapter([[], [msg("gpt", "x")]]);
    const { clock, sleep, sleeps } = timeSeam();
    const random = vi.fn(() => 0.5);
    const poller = createPoller(adapter, { clock, sleep, random });
    await poller.poll(params({ pollIntervalMs: 500, maxPollIntervalMs: 500 }));
    expect(random).not.toHaveBeenCalled();
    expect(sleeps).toEqual([500]);
  });

  it("grows the interval with backoff between polls", async () => {
    const { adapter } = makeAdapter([[], [], [], [msg("gpt", "done")]]);
    const { clock, sleep, sleeps } = timeSeam();
    // random 0.5 => zero jitter, so intervals are exactly base * 1.25^n.
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    await poller.poll(
      params({ pollIntervalMs: 100, maxPollIntervalMs: 1_000, deadlineMs: 10_000 }),
    );
    expect(sleeps).toEqual([100, 125, 156.25]);
  });

  it("never sleeps past the deadline", async () => {
    const { adapter } = makeAdapter([[]]);
    const { clock, sleep, sleeps } = timeSeam();
    const poller = createPoller(adapter, { clock, sleep, random: () => 0.5 });
    const outcome = await poller.poll(
      params({ pollIntervalMs: 100, maxPollIntervalMs: 1_000, deadlineMs: 150 }),
    );
    expect(outcome).toEqual({ kind: "timeout" });
    // First sleep 100 (now=100), second clamped to remaining 50 (now=150), then timeout.
    expect(sleeps).toEqual([100, 50]);
  });
});
