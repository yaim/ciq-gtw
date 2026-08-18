import { describe, expect, it, vi } from "vitest";
import {
  ChatCompletionError,
  RequestCancelledError,
  THREAD_TITLE,
  createChatCompletionService,
  type ChatCompletionDeps,
} from "../../src/generation/chat-completion.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import { createPromptSerializer } from "../../src/prompts/serializer.js";
import type { VirtualModel } from "../../src/config/schema.js";
import type { NormalizedChatRequest } from "../../src/openai/chat-types.js";
import type {
  CapacityAcquisition,
  CapacityController,
  Poller,
  PollOutcome,
} from "../../src/generation/types.js";
import type {
  CreateThreadResult,
  GetMessagesResult,
  ProcessMessageInput,
  ProcessMessageResult,
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
      return opts.processMessage?.(input) ?? Promise.resolve({ accepted: true, rawStatus: 202 });
    },
    getMessages: (): Promise<GetMessagesResult> =>
      Promise.resolve({ messages: [], rawStatus: 200 }),
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
      rest.poller ?? fakePoller(() => Promise.resolve({ kind: "answer", content: "answer text" })),
    ids: rest.ids ?? { completionId: () => "chatcmpl_ciq_test" },
    clock: rest.clock ?? { nowMs: () => 1_000_000 },
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

    expect(result.content).toBe("answer text");

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
