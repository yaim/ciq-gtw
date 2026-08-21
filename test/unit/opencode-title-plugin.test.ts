/**
 * Unit tests for the OpenCode native-title plugin.
 *
 * Fully hermetic: fake client, fetch, and an abortable in-memory sleep (a real
 * 0 ms macrotask so microtask-resolving fakes deterministically win any bound
 * race). No real network, no real 2/4/8 s waits.
 *
 * These cover the four behaviors the review required: `chat.headers` never
 * performs an unbounded await (it reads lifecycle-event metadata, or falls back
 * to a small bounded fail-open `session.get`); deletion/eviction cancels all
 * pending title work; only the intended first eligible foreground request
 * (agent `collectiviq-text`, provider `collectiviq`, parentless, exact default
 * title) arms; and the bridge remains best-effort.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createNativeTitleHooks,
  normalizeTitle,
  RESOLVE_TIMEOUT_MS,
  UPDATE_TIMEOUT_MS,
  type ChatHeadersInput,
  type ChatHeadersOutput,
  type FetchLike,
  type FetchResponseLike,
  type NativeTitleDeps,
  type TitleClient,
} from "../../.opencode/plugins/collectiviq-native-title.js";

const SESSION_HEADER = "X-CollectivIQ-OpenCode-Session-ID";
const BASE_URL = "http://127.0.0.1:8787/v1";
const GATEWAY_KEY = "gw-fake-key-for-tests";
const DEFAULT_TITLE = "New session - 2026-08-20T12:00:00.000Z";
const AGENT = "collectiviq-text";

function makeResponse(status: number, body?: unknown, throwOnJson = false): FetchResponseLike {
  return {
    status,
    headers: { get: () => null },
    json: () => (throwOnJson ? Promise.reject(new Error("malformed")) : Promise.resolve(body)),
  };
}

/** An abortable sleep backed by a 0 ms macrotask; records requested delays. */
function autoSleep(sleeps: number[]): NativeTitleDeps["sleep"] {
  return (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      sleeps.push(ms);
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 0);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** A sleep that never elapses on its own — it resolves ONLY when its signal aborts. */
const abortOnlySleep: NativeTitleDeps["sleep"] = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });

interface HarnessOpts {
  get?: (args: { path: { id: string } }) => Promise<unknown>;
  fetchImpl?: FetchLike;
  sleep?: NativeTitleDeps["sleep"];
  resolveBaseURL?: NativeTitleDeps["resolveBaseURL"];
  baseURL?: string | undefined;
  gatewayKey?: string | undefined;
}

interface Harness {
  hooks: ReturnType<typeof createNativeTitleHooks>;
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  fetchImpl: ReturnType<typeof vi.fn>;
  sleeps: number[];
}

/** Default fake `session.get`: a parentless session at the default title, per id. */
function defaultGet(args: { path: { id: string } }): Promise<unknown> {
  return Promise.resolve({ id: args.path.id, title: DEFAULT_TITLE });
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const sleeps: number[] = [];
  const get = vi.fn(opts.get ?? defaultGet);
  const update = vi.fn(() => Promise.resolve(undefined));
  const client: TitleClient = { session: { get, update } };
  const fetchImpl = vi.fn(opts.fetchImpl ?? (() => Promise.resolve(makeResponse(404))));
  const deps: NativeTitleDeps = {
    client,
    fetchImpl,
    sleep: opts.sleep ?? autoSleep(sleeps),
    resolveBaseURL: opts.resolveBaseURL ?? (() => ("baseURL" in opts ? opts.baseURL : BASE_URL)),
    resolveGatewayKey: () => ("gatewayKey" in opts ? opts.gatewayKey : GATEWAY_KEY),
    // No real per-request abort timers in tests (fetch gets the lifecycle signal).
    makeTimeoutSignal: () => undefined,
  };
  return { hooks: createNativeTitleHooks(deps), get, update, fetchImpl, sleeps };
}

function freshOutput(): ChatHeadersOutput {
  return { headers: {} };
}

/** A well-formed eligible `chat.headers` input. */
function headersInput(sessionId: string, over: Partial<ChatHeadersInput> = {}): ChatHeadersInput {
  return {
    sessionID: sessionId,
    agent: AGENT,
    provider: { info: { id: "collectiviq" } },
    ...over,
  };
}

/** Feed a lifecycle event that populates in-memory session metadata. */
async function emitSession(
  h: Harness,
  type: "session.created" | "session.updated",
  info: { id: string; parentID?: string; title?: string },
): Promise<void> {
  await h.hooks.event({ event: { type, properties: { info } } });
}

/** Arm via cached lifecycle metadata (the normal, no-async path). */
async function armCached(
  h: Harness,
  sessionId = "s1",
  info?: { parentID?: string; title?: string },
): Promise<ChatHeadersOutput> {
  await emitSession(h, "session.created", {
    id: sessionId,
    title: info?.title ?? DEFAULT_TITLE,
    ...(info?.parentID !== undefined ? { parentID: info.parentID } : {}),
  });
  const output = freshOutput();
  await h.hooks["chat.headers"](headersInput(sessionId), output);
  return output;
}

async function idle(h: Harness, sessionId = "s1"): Promise<void> {
  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } });
}

// ---------------------------------------------------------------------------

describe("native-title plugin — arming eligibility (chat.headers)", () => {
  it("arms an eligible parentless default session once, from cached metadata, with NO session.get", async () => {
    const h = makeHarness();
    const out1 = await armCached(h);
    expect(out1.headers[SESSION_HEADER]).toBe("s1");
    // Cached lifecycle metadata means chat.headers performs no async session lookup.
    expect(h.get).not.toHaveBeenCalled();

    // A later eligible request for the same session never re-arms / replaces it.
    const out2 = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), out2);
    expect(out2.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("does not arm a wrong AGENT on the collectiviq provider, and does not consume the opportunity", async () => {
    const h = makeHarness();
    await emitSession(h, "session.created", { id: "s1", title: DEFAULT_TITLE });

    // Another agent using the collectiviq provider: ignored, no arm, no consume.
    const wrongAgent = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { agent: "build" }), wrongAgent);
    expect(wrongAgent.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);

    // A subsequent eligible request can still arm.
    const eligible = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), eligible);
    expect(eligible.headers[SESSION_HEADER]).toBe("s1");
  });

  it("does not arm a non-collectiviq provider, and a later eligible request still arms", async () => {
    const h = makeHarness();
    await emitSession(h, "session.created", { id: "s1", title: DEFAULT_TITLE });

    const wrongProvider = freshOutput();
    await h.hooks["chat.headers"](
      headersInput("s1", { provider: { info: { id: "anthropic" } } }),
      wrongProvider,
    );
    expect(wrongProvider.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.get).not.toHaveBeenCalled(); // ineligible provider never triggers a lookup

    const eligible = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), eligible);
    expect(eligible.headers[SESSION_HEADER]).toBe("s1");
  });

  it("ignores a child (parentID) session", async () => {
    const h = makeHarness();
    const out = await armCached(h, "s1", { parentID: "parent" });
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("does not treat a manual `New session - roadmap` title as the generated default", async () => {
    const h = makeHarness();
    const out = await armCached(h, "s1", { title: "New session - roadmap" });
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("arms on the exact ISO default title form", async () => {
    const h = makeHarness();
    const out = await armCached(h, "s1", { title: "New session - 2026-01-02T03:04:05.678Z" });
    expect(out.headers[SESSION_HEADER]).toBe("s1");
  });

  it("does nothing without a session id", async () => {
    const h = makeHarness();
    const output = freshOutput();
    await h.hooks["chat.headers"]({ sessionID: "", agent: AGENT }, output);
    expect(output.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe("native-title plugin — bounded, non-blocking arming fallback (finding 1)", () => {
  it("cannot hang the hook when an uncached session.get never settles (bounded fail-open)", async () => {
    // No lifecycle event was seen → chat.headers falls back to a bounded get.
    const neverSettles = (): Promise<unknown> => new Promise<unknown>(() => {});
    const h = makeHarness({ get: neverSettles });
    const output = freshOutput();
    // Resolves (does not hang) and attaches no header; the bound is recorded.
    await h.hooks["chat.headers"](headersInput("s1"), output);
    expect(output.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toContain(1000); // the SESSION_LOOKUP_TIMEOUT_MS bound
  });

  it("arms via the bounded fallback when the uncached session.get returns an eligible session", async () => {
    const h = makeHarness(); // defaultGet → parentless default session per id
    const output = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), output);
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(output.headers[SESSION_HEADER]).toBe("s1");
  });
});

describe("native-title plugin — polling (event / session.idle)", () => {
  it("starts exactly one poller per session on session.idle", async () => {
    let calls = 0;
    const h = makeHarness({
      fetchImpl: () => {
        calls++;
        return Promise.resolve(makeResponse(404));
      },
    });
    await armCached(h);
    await idle(h);
    await idle(h);
    await h.hooks.$settle();
    expect(calls).toBe(1); // one poller; 404 → stop after a single fetch
  });

  it("does not poll an unarmed session", async () => {
    const h = makeHarness();
    await idle(h, "unknown");
    await h.hooks.$settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("polls immediately then at 2,4,8,8,8s, bounded to six attempts on 202", async () => {
    const h = makeHarness({
      fetchImpl: () => Promise.resolve(makeResponse(202, { status: "pending" })),
    });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(h.fetchImpl).toHaveBeenCalledTimes(6);
    // A leading bounded base-URL resolution, then the capped inter-attempt waits.
    expect(h.sleeps).toEqual([RESOLVE_TIMEOUT_MS, 2000, 4000, 8000, 8000, 8000]);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("sends the bearer key and session header to the exact gateway endpoint", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(makeResponse(200, { status: "ready", title: "Fix the parser bug" })),
    );
    const h = makeHarness({ fetchImpl: fetchImpl as unknown as FetchLike });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method?: string; headers?: Record<string, string> },
    ];
    expect(url).toBe("http://127.0.0.1:8787/v1/opencode/session-title");
    expect(init.method).toBe("GET");
    expect(init.headers?.["Authorization"]).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(init.headers?.[SESSION_HEADER]).toBe("s1");
  });
});

describe("native-title plugin — rename application", () => {
  it("updates the session title exactly once on a 200 ready response", async () => {
    const h = makeHarness({
      fetchImpl: () =>
        Promise.resolve(makeResponse(200, { status: "ready", title: "Fix the parser bug" })),
    });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(h.update).toHaveBeenCalledTimes(1);
    // The terminal write now also carries a composed cancel signal.
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "s1" }, body: { title: "Fix the parser bug" } }),
    );
    const updateArg = h.update.mock.calls[0]?.[0] as { signal?: unknown };
    expect(updateArg.signal).toBeInstanceOf(AbortSignal);
  });

  it("truncates a >100 code-point title to 97 code points + '...' (Unicode-safe)", async () => {
    const longTitle = "\u{1F600}".repeat(150);
    const h = makeHarness({
      fetchImpl: () => Promise.resolve(makeResponse(200, { status: "ready", title: longTitle })),
    });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(h.update).toHaveBeenCalledTimes(1);
    const body = (h.update.mock.calls[0]?.[0] as { body: { title: string } }).body;
    expect(Array.from(body.title).length).toBe(100);
    expect(body.title.endsWith("...")).toBe(true);
    expect(
      Array.from(body.title)
        .slice(0, 97)
        .every((c) => c === "\u{1F600}"),
    ).toBe(true);
  });

  it("does NOT update when the title changed during polling (manual rename)", async () => {
    // Rename-side get returns a title different from the captured default.
    const get = vi.fn(() => Promise.resolve({ id: "s1", title: "User renamed this" }));
    const h = makeHarness({
      get,
      fetchImpl: () =>
        Promise.resolve(makeResponse(200, { status: "ready", title: "Native title" })),
    });
    await armCached(h); // cached arm (no get) captures the default title
    await idle(h);
    await h.hooks.$settle();
    expect(get).toHaveBeenCalledTimes(1); // only the rename-side recheck
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("native-title plugin — non-ready outcomes leave the title unchanged", () => {
  const cases: Array<[string, FetchLike]> = [
    ["400 unavailable", () => Promise.resolve(makeResponse(400, { status: "unavailable" }))],
    ["404 unavailable", () => Promise.resolve(makeResponse(404, { status: "unavailable" }))],
    ["malformed JSON on 200", () => Promise.resolve(makeResponse(200, undefined, true))],
    ["200 wrong shape", () => Promise.resolve(makeResponse(200, { status: "ready" }))],
    ["network failure", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["timeout (abort)", () => Promise.reject(new Error("The operation was aborted"))],
  ];
  for (const [name, fetchImpl] of cases) {
    it(`leaves the title unchanged: ${name}`, async () => {
      const h = makeHarness({ fetchImpl });
      await armCached(h);
      await idle(h);
      await h.hooks.$settle();
      expect(h.update).not.toHaveBeenCalled();
    });
  }

  it("does nothing when base URL or gateway key is missing (fail open)", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(makeResponse(200, { status: "ready", title: "x" })),
    );
    const noBase = makeHarness({
      fetchImpl: fetchImpl as unknown as FetchLike,
      baseURL: undefined,
    });
    await armCached(noBase);
    await idle(noBase);
    await noBase.hooks.$settle();
    expect(fetchImpl).not.toHaveBeenCalled();

    const noKey = makeHarness({
      fetchImpl: fetchImpl as unknown as FetchLike,
      gatewayKey: undefined,
    });
    await armCached(noKey);
    await idle(noKey);
    await noKey.hooks.$settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("native-title plugin — lifecycle cancellation (finding 2)", () => {
  it("session.deleted after a first 202 prevents every subsequent gateway fetch", async () => {
    let calls = 0;
    const h = makeHarness({
      fetchImpl: (): Promise<FetchResponseLike> => {
        calls++;
        if (calls === 1) {
          // Deletion arrives during the first attempt (synchronous event handler).
          void h.hooks.event({
            event: { type: "session.deleted", properties: { info: { id: "s1" } } },
          });
        }
        return Promise.resolve(makeResponse(202, { status: "pending" }));
      },
    });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    // Only the first attempt ran; cancellation stopped the schedule.
    expect(calls).toBe(1);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.hooks.$state.has("s1")).toBe(false);
  });

  it("session.deleted while the rename-side session.get is pending prevents session.update", async () => {
    const get = vi.fn((): Promise<unknown> => {
      // Deletion arrives while the rename recheck is in flight.
      void h.hooks.event({
        event: { type: "session.deleted", properties: { info: { id: "s1" } } },
      });
      return Promise.resolve({ id: "s1", title: DEFAULT_TITLE });
    });
    const h = makeHarness({
      get,
      fetchImpl: () =>
        Promise.resolve(makeResponse(200, { status: "ready", title: "Native title" })),
    });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(get).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("eviction of an actively polling entry stops further work and $settle still completes", async () => {
    // A gated sleep only resolves on abort, so the victim poller PARKS at each
    // wait; `pending` tracks currently-parked waits. (The bounded base-URL
    // resolution's own sleep parks momentarily then resolves when the sync
    // resolver wins its race, so it is not counted here.)
    let pending = 0;
    const gatedSleep: NativeTitleDeps["sleep"] = (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        pending++;
        const done = (): void => {
          pending--;
          resolve();
        };
        signal?.addEventListener("abort", done, { once: true });
      });
    let calls = 0;
    const h = makeHarness({
      sleep: gatedSleep,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(makeResponse(202, { status: "pending" }));
      },
    });
    // Arm the victim first (oldest), then start its poller.
    await armCached(h, "victim");
    await idle(h, "victim");
    // Let the detached poller resolve config, run its immediate attempt, and park
    // at the gated inter-attempt wait.
    await new Promise((r) => setTimeout(r, 0));
    // The poller made attempt 1 (202) and is now parked at exactly one gated wait.
    expect(calls).toBe(1);
    expect(pending).toBe(1);

    // Fill to capacity so the victim (oldest) is evicted; each arm is cached (no sleep).
    for (let i = 0; i < 256; i++) await armCached(h, `s${i}`);
    expect(h.hooks.$state.has("victim")).toBe(false); // evicted
    expect(h.hooks.$state.size).toBe(256);

    // Eviction aborted the victim's signal → its parked sleep resolved → poller stops.
    await h.hooks.$settle();
    expect(calls).toBe(1); // no further fetch after eviction
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("native-title plugin — bounded resolver boundary (finding 1b)", () => {
  it("settles $settle after deletion even when resolveBaseURL never resolves", async () => {
    // Never-resolving resolver + abort-only sleep: ONLY deletion can end the wait,
    // proving the pre-poll resolution is lifecycle-bounded (not merely time-bounded).
    const h = makeHarness({
      resolveBaseURL: () => new Promise<string>(() => {}),
      sleep: abortOnlySleep,
    });
    await armCached(h);
    await idle(h);
    // Let the detached poller reach the (parked) resolver race.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.fetchImpl).not.toHaveBeenCalled();
    // Delete → aborts the session signal → resolver wait ends promptly → poller stops.
    await h.hooks.event({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } },
    });
    await h.hooks.$settle(); // must complete (not hang)
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("times out a never-resolving resolver without deletion and still settles", async () => {
    const h = makeHarness({ resolveBaseURL: () => new Promise<string>(() => {}) });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    // Exactly the resolver bound elapsed; polling never started.
    expect(h.sleeps).toEqual([RESOLVE_TIMEOUT_MS]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("native-title plugin — atomic uncached arming (finding 2b)", () => {
  it("deletion during the uncached lookup: resolves promptly, no header/state, late get is inert", async () => {
    let resolveGet!: (v: unknown) => void;
    let rejectGet!: (e: unknown) => void;
    const get = vi.fn(
      () =>
        new Promise<unknown>((resolve, reject) => {
          resolveGet = resolve;
          rejectGet = reject;
        }),
    );
    const h = makeHarness({ get, sleep: abortOnlySleep });
    const output = freshOutput();
    const p = h.hooks["chat.headers"](headersInput("s1"), output);
    // The reservation was inserted synchronously, before the lookup await.
    expect(h.hooks.$state.has("s1")).toBe(true);
    expect(h.hooks.$state.get("s1")?.status).toBe("pending");
    // Delete while the lookup is pending → hook stops awaiting promptly.
    await h.hooks.event({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } },
    });
    await p;
    expect(output.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
    // A late SDK settle (resolve AND reject) must have no effect and not throw.
    resolveGet({ id: "s1", title: DEFAULT_TITLE });
    rejectGet(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    expect(output.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("two concurrent uncached hooks issue one lookup and attach one header", async () => {
    let resolveGet!: (v: unknown) => void;
    const get = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const h = makeHarness({ get });
    const outA = freshOutput();
    const outB = freshOutput();
    const pA = h.hooks["chat.headers"](headersInput("s1"), outA);
    const pB = h.hooks["chat.headers"](headersInput("s1"), outB);
    // Release the single lookup with an eligible session.
    resolveGet({ id: "s1", title: DEFAULT_TITLE });
    await Promise.all([pA, pB]);
    expect(get).toHaveBeenCalledTimes(1);
    const armedHeaders = [outA, outB].filter((o) => o.headers[SESSION_HEADER] === "s1");
    expect(armedHeaders.length).toBe(1);
    expect(h.hooks.$state.size).toBe(1);
    expect(h.hooks.$state.get("s1")?.status).toBe("armed");
    // A later eligible hook cannot replace the first correlation.
    const outC = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), outC);
    expect(outC.headers[SESSION_HEADER]).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("a failed reservation is released so a later eligible request can arm once", async () => {
    let call = 0;
    const get = vi.fn(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ id: "s1", title: DEFAULT_TITLE });
    });
    const h = makeHarness({ get });
    const out1 = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), out1);
    expect(out1.headers[SESSION_HEADER]).toBeUndefined(); // failed lookup → no header
    expect(h.hooks.$state.has("s1")).toBe(false); // reservation released
    const out2 = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), out2);
    expect(out2.headers[SESSION_HEADER]).toBe("s1"); // retry armed
    expect(h.hooks.$state.get("s1")?.status).toBe("armed");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("native-title plugin — exact default-title shape (finding 3)", () => {
  it("arms on exactly three millisecond digits", async () => {
    const h = makeHarness();
    const out = await armCached(h, "sA", { title: "New session - 2026-01-02T03:04:05.678Z" });
    expect(out.headers[SESSION_HEADER]).toBe("sA");
  });

  const rejected = [
    "New session - 2026-01-02T03:04:05Z", // no milliseconds
    "New session - 2026-01-02T03:04:05.1Z", // one digit
    "New session - 2026-01-02T03:04:05.12Z", // two digits
    "New session - roadmap", // manual title
  ];
  for (const title of rejected) {
    it(`does not arm: ${JSON.stringify(title)}`, async () => {
      const h = makeHarness();
      const out = await armCached(h, "s1", { title });
      expect(out.headers[SESSION_HEADER]).toBeUndefined();
    });
  }
});

describe("native-title plugin — bounded terminal update (finding P2)", () => {
  /** A ready-flow harness whose `session.update` never settles; captures its signal. */
  function hungUpdateHarness(opts: { sleep?: NativeTitleDeps["sleep"] } = {}): {
    h: Harness;
    updateSignal: () => AbortSignal | undefined;
    rejectUpdate: () => void;
  } {
    let captured: AbortSignal | undefined;
    let reject!: (e: unknown) => void;
    const update = vi.fn((args: { signal?: AbortSignal }) => {
      captured = args.signal;
      return new Promise<unknown>((_resolve, rej) => {
        reject = rej;
      });
    });
    const get = vi.fn(() => Promise.resolve({ id: "s1", title: DEFAULT_TITLE }));
    const client: TitleClient = { session: { get, update } };
    const sleeps: number[] = [];
    const h: Harness = (() => {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(makeResponse(200, { status: "ready", title: "Native title" })),
      );
      const hooks = createNativeTitleHooks({
        client,
        fetchImpl,
        sleep: opts.sleep ?? autoSleep(sleeps),
        resolveBaseURL: () => BASE_URL,
        resolveGatewayKey: () => GATEWAY_KEY,
        makeTimeoutSignal: () => undefined,
      });
      return { hooks, get, update, fetchImpl, sleeps };
    })();
    return { h, updateSignal: () => captured, rejectUpdate: () => reject(new Error("late")) };
  }

  it("session.deleted during a hung terminal update settles the poll task and aborts the request", async () => {
    // abort-only sleep: the update bound can ONLY end via cancellation, proving
    // DELETION (not the timeout) settles the hung write.
    const { h, updateSignal } = hungUpdateHarness({ sleep: abortOnlySleep });
    await armCached(h);
    await idle(h);
    // Let the poller reach the (never-settling) terminal update await.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(updateSignal()?.aborted).toBe(false);
    // Delete → aborts the update's composed signal → the plugin stops awaiting.
    await h.hooks.event({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } },
    });
    await h.hooks.$settle(); // must complete (not hang)
    expect(updateSignal()?.aborted).toBe(true);
    expect(h.hooks.$state.has("s1")).toBe(false);
    expect(h.update).toHaveBeenCalledTimes(1); // no retry
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung terminal update by timeout (no deletion), aborting the request and settling", async () => {
    const { h, updateSignal } = hungUpdateHarness(); // autoSleep → the timeout elapses
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(h.update).toHaveBeenCalledTimes(1);
    // The update bound was exercised through the injected sleep seam and aborted it.
    expect(h.sleeps).toContain(UPDATE_TIMEOUT_MS);
    expect(updateSignal()?.aborted).toBe(true);
  });

  it("a late terminal-update rejection is inert (no unhandled rejection, no state change/retry)", async () => {
    const { h, rejectUpdate } = hungUpdateHarness(); // times out, releasing the task
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    const updatesBefore = h.update.mock.calls.length;
    // The detached SDK promise rejects AFTER the poll task already settled.
    rejectUpdate();
    await new Promise((r) => setTimeout(r, 0));
    // No unhandled rejection (vitest would fail), no retry, no extra work.
    expect(h.update.mock.calls.length).toBe(updatesBefore);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("native-title plugin — privacy", () => {
  it("never logs anything (no console output across a full ready flow)", async () => {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    };
    try {
      const h = makeHarness({
        fetchImpl: () =>
          Promise.resolve(makeResponse(200, { status: "ready", title: "Secret prompt title" })),
      });
      await armCached(h);
      await idle(h);
      await h.hooks.$settle();
      expect(h.update).toHaveBeenCalledTimes(1);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  });
});

describe("normalizeTitle", () => {
  it("passes short titles through unchanged", () => {
    expect(normalizeTitle("A short title")).toBe("A short title");
  });
  it("truncates code-point-safely at 100 (97 + '...')", () => {
    const out = normalizeTitle("a".repeat(200));
    expect(out.length).toBe(100);
    expect(out.endsWith("...")).toBe(true);
  });
});
