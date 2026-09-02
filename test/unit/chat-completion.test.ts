import { describe, expect, it, vi } from "vitest";
import {
  ChatCompletionError,
  RequestCancelledError,
  THREAD_TITLE,
  createChatCompletionService,
  type ChatCompletionDeps,
} from "../../src/generation/chat-completion.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import { createPoller } from "../../src/generation/polling.js";
import { createPromptSerializer } from "../../src/prompts/serializer.js";
import type { VirtualModel } from "../../src/config/schema.js";
import type { NormalizedChatRequest } from "../../src/openai/chat-types.js";
import { INTERNAL_ERROR } from "../../src/openai/errors.js";
import type {
  CapacityAcquisition,
  CapacityController,
  Poller,
  PollOutcome,
  PollParams,
} from "../../src/generation/types.js";
import type {
  CreateThreadResult,
  GetMessagesResult,
  GetThreadTitleResult,
  ProcessMessageInput,
  ProcessMessageResult,
  UpstreamMessage,
} from "../../src/collectiviq/types.js";

const MODEL: VirtualModel = {
  id: "collectiviq-consensus",
  displayName: "Consensus",
  selectedLlms: ["gpt", "claude"],
  generateCombined: true,
  answerSource: "combined",
  toolMode: "disabled",
  promptMode: "protocol",
  requestTimeoutMs: 90_000,
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 5_000,
  maximumPromptBytes: 100_000,
};

const REQUEST: NormalizedChatRequest = {
  model: "collectiviq-consensus",
  messages: [{ role: "user", content: "hi" }],
  ignoredParameters: [],
  stream: false,
};

/** The run id the fake `process_message` reports for THIS completion. */
const RUN_ID = "run-current";
/** An earlier turn's run in the same thread. */
const PRIOR_RUN_ID = "run-earlier";

interface Trace {
  events: string[];
  processInputs: ProcessMessageInput[];
  released: number;
}

function fakeCapacity(
  trace: Trace,
  outcome: CapacityAcquisition | "grant" = "grant",
): CapacityController {
  return {
    acquire(): Promise<CapacityAcquisition> {
      trace.events.push("acquire");
      if (outcome === "grant") {
        return Promise.resolve({
          ok: true,
          permit: {
            release() {
              trace.released += 1;
              trace.events.push("release");
            },
          },
        });
      }
      return Promise.resolve(outcome);
    },
    closeAdmission() {},
    activeCount: 0,
    queuedCount: 0,
  };
}

interface AdapterOptions {
  readonly createThread?: () => Promise<CreateThreadResult>;
  readonly processMessage?: (input: ProcessMessageInput) => Promise<ProcessMessageResult>;
}

function fakeAdapter(trace: Trace, opts: AdapterOptions = {}) {
  return {
    createThread: () => {
      trace.events.push("createThread");
      return opts.createThread?.() ?? Promise.resolve({ threadId: "t1", rawStatus: 200 });
    },
    processMessage: (input: ProcessMessageInput) => {
      trace.events.push("processMessage");
      trace.processInputs.push(input);
      return (
        opts.processMessage?.(input) ??
        Promise.resolve({ accepted: true, combinedRunId: RUN_ID, rawStatus: 202 })
      );
    },
    getMessages: (): Promise<GetMessagesResult> =>
      Promise.resolve({ messages: [], rawStatus: 200 }),
    // The completion orchestration never calls the OBSERVED-ONLY title lookup;
    // this satisfies the adapter contract for the typed dependency.
    getThreadTitle: (): Promise<GetThreadTitleResult> => Promise.resolve({ kind: "pending" }),
  };
}

function fakePoller(poll: (signal: AbortSignal) => Promise<PollOutcome>): Poller {
  return { poll: (params) => poll(params.signal) };
}

function makeService(deps: Partial<ChatCompletionDeps> & { trace: Trace }) {
  const { trace, ...rest } = deps;
  const full: ChatCompletionDeps = {
    serializer: rest.serializer ?? { serialize: () => "PROMPT" },
    capacity: rest.capacity ?? fakeCapacity(trace),
    adapter: rest.adapter ?? fakeAdapter(trace),
    poller:
      rest.poller ??
      fakePoller(() => Promise.resolve({ kind: "answer", content: "answer text", messages: [] })),
    ids: rest.ids ?? { completionId: () => "chatcmpl_ciq_test" },
    clock: rest.clock ?? { nowMs: () => 1_000_000 },
    toolCallIds: rest.toolCallIds ?? { toolCallId: () => "call_ciq_test" },
  };
  return createChatCompletionService(full);
}

/** Prepare then run, returning only the trusted completion result. */
function run(
  service: ReturnType<typeof makeService>,
  signal = new AbortController().signal,
  model: VirtualModel = MODEL,
) {
  const prepared = service.prepare({ request: REQUEST, model, keyId: "k0", signal });
  return service.run(prepared, signal);
}

describe("chat-completion orchestration", () => {
  it("prepares a stream-stable identity without any upstream work", () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace });
    const prepared = service.prepare({
      request: REQUEST,
      model: MODEL,
      keyId: "k0",
      signal: new AbortController().signal,
    });
    expect(prepared.id).toBe("chatcmpl_ciq_test");
    expect(prepared.model).toBe("collectiviq-consensus");
    expect(prepared.created).toBe(1_000); // floor(1_000_000 / 1000)
    expect(prepared.prompt).toBe("PROMPT");
    // Preparation takes no capacity and makes no upstream call.
    expect(trace.events).toEqual([]);
  });

  it("creates one thread, submits once, polls, and returns the answer", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace });
    const result = await run(service);

    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.content).toBe("answer text");

    // Capacity is acquired BEFORE the thread is created; the permit is released.
    expect(trace.events).toEqual(["acquire", "createThread", "processMessage", "release"]);
    // Exactly one submit, carrying the serialized prompt and model policy.
    expect(trace.processInputs).toHaveLength(1);
    expect(trace.processInputs[0]).toMatchObject({
      threadId: "t1",
      prompt: "PROMPT",
      selectedLlms: ["gpt", "claude"],
      generateCombined: true,
    });
  });

  it("uses a generic, content-free thread title", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    let title = "";
    const adapter = fakeAdapter(trace, {
      createThread: () => Promise.resolve({ threadId: "t1", rawStatus: 200 }),
    });
    const spied = {
      ...adapter,
      createThread: (input: { title: string }) => {
        title = input.title;
        trace.events.push("createThread");
        return Promise.resolve({ threadId: "t1", rawStatus: 200 });
      },
    };
    const service = makeService({ trace, adapter: spied });
    await run(service);
    expect(title).toBe(THREAD_TITLE);
    // Literal regression guard: the on-the-wire title is EXACTLY `New Thread`
    // (CollectivIQ's server-recognized temporary placeholder). Pinning the
    // literal — not just the constant — catches an accidental constant change.
    expect(title).toBe("New Thread");
    expect(title).not.toContain("hi");
  });

  it("rejects an over-limit prompt during prepare, before acquiring capacity", () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      serializer: { serialize: () => "x".repeat(200) },
    });
    const smallModel: VirtualModel = { ...MODEL, maximumPromptBytes: 10 };
    let caught: unknown;
    try {
      service.prepare({
        request: REQUEST,
        model: smallModel,
        keyId: "k0",
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatCompletionError);
    expect((caught as ChatCompletionError).apiError).toMatchObject({
      status: 400,
      body: { error: { code: "context_length_exceeded" } },
    });
    // No capacity was taken and no upstream call was made.
    expect(trace.events).toEqual([]);
  });

  it("selects the serializer from the model's promptMode, not the model id", () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      serializer: { serialize: (_req, promptMode) => `mode:${promptMode}` },
    });
    const protocolPrepared = service.prepare({
      request: REQUEST,
      model: { ...MODEL, promptMode: "protocol" },
      keyId: "k0",
      signal: new AbortController().signal,
    });
    const directPrepared = service.prepare({
      request: REQUEST,
      model: { ...MODEL, promptMode: "direct" },
      keyId: "k0",
      signal: new AbortController().signal,
    });
    expect(protocolPrepared.prompt).toBe("mode:protocol");
    expect(directPrepared.prompt).toBe("mode:direct");
    expect(trace.events).toEqual([]);
  });

  it("enforces the byte limit against only the selected direct prompt", () => {
    // The real router serializer selects the latest user content in direct mode;
    // only THAT content counts toward maximumPromptBytes — the system message is
    // ignored. Choose a request whose latest user content is exactly 5 bytes.
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace, serializer: createPromptSerializer() });
    const directRequest: NormalizedChatRequest = {
      model: "collectiviq-consensus",
      messages: [
        { role: "system", content: "a very long system instruction ignored by direct mode" },
        { role: "user", content: "hello" }, // 5 UTF-8 bytes
      ],
      ignoredParameters: [],
      stream: false,
    };
    const atLimit: VirtualModel = { ...MODEL, promptMode: "direct", maximumPromptBytes: 5 };
    const prepared = service.prepare({
      request: directRequest,
      model: atLimit,
      keyId: "k0",
      signal: new AbortController().signal,
    });
    expect(prepared.prompt).toBe("hello");
    expect(trace.events).toEqual([]);

    const overLimit: VirtualModel = { ...atLimit, maximumPromptBytes: 4 };
    let caught: unknown;
    try {
      service.prepare({
        request: directRequest,
        model: overLimit,
        keyId: "k0",
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatCompletionError);
    expect((caught as ChatCompletionError).apiError).toMatchObject({
      status: 400,
      body: { error: { code: "context_length_exceeded" } },
    });
    expect(trace.events).toEqual([]);
  });

  it("maps a capacity rejection to 429", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      capacity: fakeCapacity(trace, { ok: false, reason: "capacity" }),
    });
    await expect(run(service)).rejects.toMatchObject({
      apiError: { status: 429, body: { error: { code: "gateway_capacity_exceeded" } } },
    });
    expect(trace.events).toEqual(["acquire"]);
  });

  it("maps a poller timeout to 504 and releases the permit", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      poller: fakePoller(() => Promise.resolve({ kind: "timeout" })),
    });
    await expect(run(service)).rejects.toMatchObject({
      apiError: { status: 504, body: { error: { code: "completion_timeout" } } },
    });
    expect(trace.released).toBe(1);
  });

  it("maps an upstream quota error to 429 and releases the permit", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      poller: fakePoller(() => Promise.reject(new UpstreamError("quota", 429, "GET"))),
    });
    await expect(run(service)).rejects.toMatchObject({
      apiError: { status: 429, body: { error: { code: "upstream_quota_exceeded" } } },
    });
    expect(trace.released).toBe(1);
  });

  it("does not retry process_message after an ambiguous failure and maps it", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const adapter = fakeAdapter(trace, {
      processMessage: () => Promise.reject(new UpstreamError("network", undefined, "POST")),
    });
    const service = makeService({ trace, adapter });
    await expect(run(service)).rejects.toMatchObject({
      apiError: { status: 502, body: { error: { code: "upstream_request_failed" } } },
    });
    // process_message was attempted exactly once (never retried).
    expect(trace.events.filter((e) => e === "processMessage")).toHaveLength(1);
    expect(trace.released).toBe(1);
  });

  it("treats a client abort as a cancellation and releases the permit", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const controller = new AbortController();
    const service = makeService({
      trace,
      poller: fakePoller(
        (signal) =>
          new Promise((_resolve, reject) => {
            if (signal.aborted) return reject(new UpstreamError("cancellation"));
            signal.addEventListener("abort", () => reject(new UpstreamError("cancellation")), {
              once: true,
            });
          }),
      ),
    });
    const promise = run(service, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);
    expect(trace.released).toBe(1);
  });

  it("maps a total-deadline abort to 504 (not a client cancellation)", async () => {
    vi.useFakeTimers();
    try {
      const trace: Trace = { events: [], processInputs: [], released: 0 };
      const shortModel: VirtualModel = { ...MODEL, requestTimeoutMs: 1_000 };
      const service = makeService({
        trace,
        poller: fakePoller(
          (signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new UpstreamError("cancellation")), {
                once: true,
              });
            }),
        ),
      });
      const promise = run(service, new AbortController().signal, shortModel);
      const assertion = expect(promise).rejects.toMatchObject({
        apiError: { status: 504, body: { error: { code: "completion_timeout" } } },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(trace.released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A Proxy whose every trap records the invocation and (for value reads) throws,
  // so any inspection of a thrown value is provable. Identity checks (`WeakSet.has`,
  // `Object.is`, `x === y`) never trigger a trap; `instanceof`, property reads, and
  // serialization do.
  function hostileError(counters: { get: number; has: number; proto: number }): unknown {
    return new Proxy(
      {},
      {
        get(_t, _p): never {
          counters.get += 1;
          throw new Error("hostile get trap");
        },
        has(): boolean {
          counters.has += 1;
          return false;
        },
        getPrototypeOf(): never {
          counters.proto += 1;
          throw new Error("hostile getPrototypeOf trap");
        },
      },
    );
  }

  it("rethrows a hostile Proxy from createThread by identity, triggering zero traps", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const counters = { get: 0, has: 0, proto: 0 };
    const hostile = hostileError(counters);
    const adapter = fakeAdapter(trace, {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the adversarial case IS a hostile non-Error Proxy value
      createThread: () => Promise.reject(hostile),
    });
    const service = makeService({ trace, adapter });
    let caught: unknown;
    await run(service).catch((err: unknown) => {
      caught = err;
    });
    // The orchestrator never mapped it (not recognized as any gateway/upstream
    // error) and re-threw the same value for the route's fixed 500 — with the
    // permit still released and NO trap ever invoked.
    expect(caught === hostile).toBe(true);
    expect(counters).toEqual({ get: 0, has: 0, proto: 0 });
    expect(trace.released).toBe(1);
  });

  it("rethrows a hostile Proxy from processMessage by identity, triggering zero traps", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const counters = { get: 0, has: 0, proto: 0 };
    const hostile = hostileError(counters);
    const adapter = fakeAdapter(trace, {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the adversarial case IS a hostile non-Error Proxy value
      processMessage: () => Promise.reject(hostile),
    });
    const service = makeService({ trace, adapter });
    let caught: unknown;
    await run(service).catch((err: unknown) => {
      caught = err;
    });
    expect(caught === hostile).toBe(true);
    expect(counters).toEqual({ get: 0, has: 0, proto: 0 });
    expect(trace.released).toBe(1);
  });

  it("rethrows a hostile Proxy from the poller read path by identity, triggering zero traps", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const counters = { get: 0, has: 0, proto: 0 };
    const hostile = hostileError(counters);
    const service = makeService({
      trace,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the adversarial case IS a hostile non-Error Proxy value
      poller: fakePoller(() => Promise.reject(hostile)),
    });
    let caught: unknown;
    await run(service).catch((err: unknown) => {
      caught = err;
    });
    expect(caught === hostile).toBe(true);
    expect(counters).toEqual({ get: 0, has: 0, proto: 0 });
    expect(trace.released).toBe(1);
  });

  it("never leaks prompt or answer content in a mapped error", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      serializer: { serialize: () => "SECRET-PROMPT" },
      poller: fakePoller(() =>
        Promise.reject(new UpstreamError("unexpected_upstream", 500, "GET")),
      ),
    });
    try {
      await run(service);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatCompletionError);
      expect(JSON.stringify((error as ChatCompletionError).apiError)).not.toContain(
        "SECRET-PROMPT",
      );
    }
  });
});

describe("chat-completion with a leased OpenCode thread (specification §5.1.1)", () => {
  /** An adapter whose `getMessages` answers from a queue of thread snapshots. */
  function reuseAdapter(
    trace: Trace,
    snapshots: readonly UpstreamMessage[][],
  ): ReturnType<typeof fakeAdapter> {
    let index = 0;
    return {
      ...fakeAdapter(trace),
      getMessages: (): Promise<GetMessagesResult> => {
        trace.events.push("getMessages");
        const messages = snapshots[Math.min(index, snapshots.length - 1)] ?? [];
        index += 1;
        return Promise.resolve({ messages, rawStatus: 200 });
      },
    };
  }

  function message(id: number, content: string, combinedRunId = RUN_ID): UpstreamMessage {
    return { source: "combined", content, percentUsage: null, createdAt: id, id, combinedRunId };
  }

  it("creates a thread when none is leased, and reports it as newly created", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    const result = await service.run(prepared, signal, {});
    expect(result.upstreamThreadCreated).toBe(true);
    expect(result.upstreamThreadId).toBe("t1");
    expect(trace.events).toEqual(["acquire", "createThread", "processMessage", "release"]);
  });

  /** The pre-submit hook every mapping-managing caller must supply. */
  const noopSubmitHook = (): Promise<void> => Promise.resolve();

  it("submits into the leased thread without creating one", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace, adapter: reuseAdapter(trace, [[]]) });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    const result = await service.run(prepared, signal, {
      leasedThreadId: "leased-42",
      onBeforeSubmit: noopSubmitHook,
    });

    expect(result.upstreamThreadCreated).toBe(false);
    expect(result.upstreamThreadId).toBe("leased-42");
    expect(trace.events).not.toContain("createThread");
    // No pre-submit read of the thread: run correlation replaces the snapshot.
    expect(trace.events).toEqual(["acquire", "processMessage", "release"]);
    expect(trace.processInputs[0]).toMatchObject({ threadId: "leased-42", prompt: "PROMPT" });
  });

  it("performs NO pre-submit get_messages on a reused thread", async () => {
    // MUTATION GUARD. The old defence snapshotted the thread before submitting
    // and excluded those identities. That read is gone: it cost an extra upstream
    // round trip, silently capped a conversation at the snapshot bound, and was
    // unsound whenever the history was truncated. Correlation needs nothing but
    // the submit response, so a reused turn must issue exactly one upstream call
    // before the poll.
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({
      trace,
      adapter: reuseAdapter(trace, [[message(1, "previous turn", PRIOR_RUN_ID)]]),
      poller: {
        poll: () => Promise.resolve({ kind: "answer", content: "new", messages: [] }),
      },
    });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    await service.run(prepared, signal, {
      leasedThreadId: "leased-42",
      onBeforeSubmit: noopSubmitHook,
    });
    expect(trace.events).not.toContain("getMessages");
  });

  it("passes the submit response's run id to the poller", async () => {
    // The correlation key is whatever THIS submission returned — never a
    // gateway-invented or reused value — so the poller can only accept messages
    // belonging to this completion.
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    let seen: PollParams | undefined;
    const adapter = {
      ...reuseAdapter(trace, [[]]),
      processMessage: (input: ProcessMessageInput) => {
        trace.events.push("processMessage");
        trace.processInputs.push(input);
        return Promise.resolve({
          accepted: true,
          combinedRunId: "run-from-this-submit",
          rawStatus: 202,
        });
      },
    };
    const service = makeService({
      trace,
      adapter,
      poller: {
        poll: (p) => {
          seen = p;
          return Promise.resolve({ kind: "answer", content: "new", messages: [] });
        },
      },
    });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    await service.run(prepared, signal, {
      leasedThreadId: "leased-42",
      onBeforeSubmit: noopSubmitHook,
    });
    expect(seen?.combinedRunId).toBe("run-from-this-submit");
  });

  it("refuses to submit when a mapping-managing caller omits the pre-submit hook", async () => {
    // MUTATION GUARD. Submitting into a leased thread while the mapping still
    // reads `reserved` would leave a lease another owner can take over, and a
    // second owner could then submit into the SAME thread. The generation layer
    // enforces the invariant where the submit happens, not only at the route.
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace, adapter: reuseAdapter(trace, [[]]) });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });

    await expect(
      service.run(prepared, signal, { leasedThreadId: "leased-42" }),
    ).rejects.toBeInstanceOf(ChatCompletionError);
    await expect(
      service.run(prepared, signal, { onThreadCreated: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(ChatCompletionError);
    expect(trace.processInputs).toHaveLength(0);
    // Nothing upstream was attempted at all: the guard runs before the thread.
    expect(trace.events).not.toContain("createThread");
  });

  it("never returns a prior turn's answer through the REAL poller", async () => {
    // End-to-end over the actual selection chain rather than a fake poller:
    // process_message run id -> PollParams.combinedRunId -> selectAnswer.
    // Deleting any link makes the stale answer win, because the prior turn is
    // both first in the snapshot and available several polls earlier.
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const prior = message(1, "the PREVIOUS answer", PRIOR_RUN_ID);
    const fresh = message(2, "the new answer");
    let poll = 0;
    const adapter = {
      ...fakeAdapter(trace),
      getMessages: (): Promise<GetMessagesResult> => {
        trace.events.push("getMessages");
        poll += 1;
        // Two polls that still show only the prior turn, then the poll where this
        // run's answer has landed.
        const messages = poll >= 3 ? [prior, fresh] : [prior];
        return Promise.resolve({ messages, rawStatus: 200 });
      },
    };
    const service = makeService({
      trace,
      adapter,
      poller: createPoller(adapter, {
        clock: { nowMs: () => 1_000_000 },
        sleep: { sleep: () => Promise.resolve() },
        random: () => 0.5,
      }),
    });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    const result = await service.run(prepared, signal, {
      leasedThreadId: "leased-42",
      onBeforeSubmit: noopSubmitHook,
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.content).toBe("the new answer");
  });

  it("correlates the stateless path to its own run too", async () => {
    // The stateless default gets the SAME rule, so there is one correctness
    // story rather than a reuse-only special case.
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    let seen: PollParams | undefined;
    const service = makeService({
      trace,
      poller: {
        poll: (p) => {
          seen = p;
          return Promise.resolve({ kind: "answer", content: "x", messages: [] });
        },
      },
    });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    await service.run(prepared, signal);
    expect(seen?.combinedRunId).toBe(RUN_ID);
  });

  it("runs the lifecycle hooks in the order the mapping depends on", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    const bound: string[] = [];
    await service.run(prepared, signal, {
      onThreadCreated: (threadId: string) => {
        bound.push(threadId);
        trace.events.push("onThreadCreated");
        return Promise.resolve();
      },
      onBeforeSubmit: () => {
        trace.events.push("onBeforeSubmit");
        return Promise.resolve();
      },
    });
    expect(bound).toEqual(["t1"]);
    expect(trace.events).toEqual([
      "acquire",
      "createThread",
      "onThreadCreated",
      "onBeforeSubmit",
      "processMessage",
      "release",
    ]);
  });

  it("performs no submit when the bind hook fails, and releases capacity", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    await expect(
      service.run(prepared, signal, {
        onThreadCreated: () => Promise.reject(new ChatCompletionError(INTERNAL_ERROR)),
        onBeforeSubmit: noopSubmitHook,
      }),
    ).rejects.toBeInstanceOf(ChatCompletionError);
    // The thread was created; the submit never happened.
    expect(trace.events).toEqual(["acquire", "createThread", "release"]);
    expect(trace.processInputs).toHaveLength(0);
    expect(trace.released).toBe(1);
  });

  it("performs no submit when the pre-submit hook fails, and releases capacity", async () => {
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const service = makeService({ trace, adapter: reuseAdapter(trace, [[]]) });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    await expect(
      service.run(prepared, signal, {
        leasedThreadId: "leased-42",
        onBeforeSubmit: () => Promise.reject(new ChatCompletionError(INTERNAL_ERROR)),
      }),
    ).rejects.toBeInstanceOf(ChatCompletionError);
    expect(trace.processInputs).toHaveLength(0);
    expect(trace.released).toBe(1);
  });

  it("makes no upstream read of a leased thread before the pre-submit hook", async () => {
    // The pre-submit hook is the caller's last provably-not-submitted moment. A
    // reused turn must reach it having touched the thread not at all, so a
    // rejection there can never be confused with an ambiguous post-submit
    // failure. (This replaces the old guarantee that a FAILING baseline snapshot
    // still aborted before the hook — there is no snapshot left to fail.)
    const trace: Trace = { events: [], processInputs: [], released: 0 };
    const adapter = {
      ...fakeAdapter(trace),
      getMessages: (): Promise<GetMessagesResult> => {
        trace.events.push("getMessages");
        return Promise.reject(new UpstreamError("network"));
      },
    };
    const service = makeService({ trace, adapter });
    const signal = new AbortController().signal;
    const prepared = service.prepare({ request: REQUEST, model: MODEL, keyId: "k0", signal });
    const eventsAtHook: string[] = [];
    await expect(
      service.run(prepared, signal, {
        leasedThreadId: "leased-42",
        onBeforeSubmit: () => {
          eventsAtHook.push(...trace.events);
          return Promise.reject(new ChatCompletionError(INTERNAL_ERROR));
        },
      }),
    ).rejects.toBeInstanceOf(ChatCompletionError);
    expect(eventsAtHook).toEqual(["acquire"]);
    expect(trace.processInputs).toHaveLength(0);
    expect(trace.released).toBe(1);
  });
});
