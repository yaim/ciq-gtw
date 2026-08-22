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
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollectivIQNativeTitlePlugin,
  createNativeTitleHooks,
  defaultResolveConnection,
  getOrCreateSharedHooks,
  normalizeTitle,
  PLUGIN_ID,
  resolveConnectionConfig,
  RESOLVE_TIMEOUT_MS,
  SHARED_HOOKS_KEY,
  UPDATE_TIMEOUT_MS,
  type ChatHeadersInput,
  type ChatHeadersOutput,
  type FetchLike,
  type FetchResponseLike,
  type HooksRegistry,
  type NativeTitleConnectionConfig,
  type NativeTitleDeps,
  type NativeTitleHooks,
  type PluginInput,
  type ReadGatewayKey,
  type TitleClient,
} from "../../.opencode/plugins/collectiviq-native-title.js";
// Default + namespace imports for the runtime loader-contract tests.
import pluginDefault, * as pluginModule from "../../.opencode/plugins/collectiviq-native-title.js";

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
  // Direct connection-resolver injection (takes precedence when provided).
  resolveConnection?: NativeTitleDeps["resolveConnection"];
  // Back-compat: legacy base-URL resolver (may be async / hang) used to synthesize
  // a connection when `resolveConnection` is not injected directly.
  resolveBaseURL?: () => Promise<string | undefined> | string | undefined;
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
  // Synthesize a single connection resolver from the harness opts. Preserves the
  // legacy `resolveBaseURL`/`baseURL`/`gatewayKey` injection points (including a
  // hung `resolveBaseURL` for bounded-race tests) behind the new unified seam.
  const synthConnection = async (): Promise<NativeTitleConnectionConfig | undefined> => {
    const rawBase = opts.resolveBaseURL
      ? await opts.resolveBaseURL()
      : "baseURL" in opts
        ? opts.baseURL
        : BASE_URL;
    const gatewayKey = "gatewayKey" in opts ? opts.gatewayKey : GATEWAY_KEY;
    if (typeof rawBase !== "string" || rawBase.length === 0) return undefined;
    if (typeof gatewayKey !== "string" || gatewayKey.length === 0) return undefined;
    return { baseURL: rawBase, gatewayKey };
  };
  const deps: NativeTitleDeps = {
    client,
    fetchImpl,
    sleep: opts.sleep ?? autoSleep(sleeps),
    resolveConnection: opts.resolveConnection ?? synthConnection,
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
        resolveConnection: () => ({ baseURL: BASE_URL, gatewayKey: GATEWAY_KEY }),
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

describe("native-title plugin — provider-shape compatibility (flat runtime vs nested SDK)", () => {
  // OpenCode 1.18.20's runtime passes a FLAT provider (`provider.id`); the SDK
  // type declaration describes a NESTED `provider.info.id`. Arming must tolerate
  // both, read only own DATA descriptors, never invoke a getter, ignore inherited
  // properties, and fail closed (without consuming the arming opportunity) on
  // anything else. All cases arm from cached lifecycle metadata (no session.get),
  // so an ineligible provider is proven to trigger NO lookup.
  async function seedMeta(h: Harness, sessionId = "s1"): Promise<void> {
    await emitSession(h, "session.created", { id: sessionId, title: DEFAULT_TITLE });
  }

  it("arms on the flat runtime provider shape { id: 'collectiviq' }", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider: { id: "collectiviq" } }), out);
    expect(out.headers[SESSION_HEADER]).toBe("s1");
    expect(h.get).not.toHaveBeenCalled();
  });

  it("still arms on the nested SDK provider shape { info: { id: 'collectiviq' } }", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const out = freshOutput();
    await h.hooks["chat.headers"](
      headersInput("s1", { provider: { info: { id: "collectiviq" } } }),
      out,
    );
    expect(out.headers[SESSION_HEADER]).toBe("s1");
    expect(h.get).not.toHaveBeenCalled();
  });

  it("does not arm a flat non-CollectivIQ provider, and does not consume the opportunity", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider: { id: "anthropic" } }), out);
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
    // A subsequent well-formed request still arms.
    const eligible = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), eligible);
    expect(eligible.headers[SESSION_HEADER]).toBe("s1");
  });

  it("fails closed when a flat non-CollectivIQ id conflicts with a nested CollectivIQ id (flat is authoritative)", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const out = freshOutput();
    await h.hooks["chat.headers"](
      headersInput("s1", { provider: { id: "anthropic", info: { id: "collectiviq" } } }),
      out,
    );
    // Flat `id` present → authoritative → no fallback to the nested id.
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
  });

  it("fails closed on a non-string flat id and does not fall back to the nested id", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const out = freshOutput();
    await h.hooks["chat.headers"](
      // Flat `id` present but non-string → fails closed, no nested fallback.
      headersInput("s1", { provider: { id: 123, info: { id: "collectiviq" } } }),
      out,
    );
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
  });

  it("never invokes a flat accessor `id` and does not arm", async () => {
    const h = makeHarness();
    await seedMeta(h);
    let called = 0;
    const provider: Record<string, unknown> = {};
    Object.defineProperty(provider, "id", {
      enumerable: true,
      configurable: true,
      get() {
        called++;
        return "collectiviq";
      },
    });
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider }), out);
    expect(called).toBe(0);
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
  });

  it("never invokes a nested `info` accessor and does not arm", async () => {
    const h = makeHarness();
    await seedMeta(h);
    let called = 0;
    const provider: Record<string, unknown> = {};
    Object.defineProperty(provider, "info", {
      enumerable: true,
      configurable: true,
      get() {
        called++;
        return { id: "collectiviq" };
      },
    });
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider }), out);
    expect(called).toBe(0);
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("never invokes a nested `info.id` accessor and does not arm", async () => {
    const h = makeHarness();
    await seedMeta(h);
    let called = 0;
    const info: Record<string, unknown> = {};
    Object.defineProperty(info, "id", {
      enumerable: true,
      configurable: true,
      get() {
        called++;
        return "collectiviq";
      },
    });
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider: { info } }), out);
    expect(called).toBe(0);
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("ignores an inherited (non-own) flat `id`", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const provider = Object.create({ id: "collectiviq" }) as unknown; // id on the prototype
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider }), out);
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("ignores an inherited (non-own) `info`", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const provider = Object.create({ info: { id: "collectiviq" } }) as unknown; // info on the prototype
    const out = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider }), out);
    expect(out.headers[SESSION_HEADER]).toBeUndefined();
  });

  it("does not throw on a hostile provider whose descriptor lookup throws, and preserves the arming opportunity", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    const out1 = freshOutput();
    // Must resolve (not throw) and arm nothing.
    await h.hooks["chat.headers"](headersInput("s1", { provider: hostile }), out1);
    expect(out1.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
    // The failed inspection did NOT consume the session's one arming opportunity.
    const out2 = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), out2);
    expect(out2.headers[SESSION_HEADER]).toBe("s1");
  });

  it("does not arm a missing provider, and a later eligible request still arms", async () => {
    const h = makeHarness();
    await seedMeta(h);
    const out1 = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1", { provider: undefined }), out1);
    expect(out1.headers[SESSION_HEADER]).toBeUndefined();
    expect(h.hooks.$state.has("s1")).toBe(false);
    const out2 = freshOutput();
    await h.hooks["chat.headers"](headersInput("s1"), out2);
    expect(out2.headers[SESSION_HEADER]).toBe("s1");
  });
});

describe("native-title plugin — process-wide duplicate-load idempotence", () => {
  /** A plain Map-backed registry seam, so tests never touch real globalThis state. */
  function makeMapRegistry(): HooksRegistry {
    const store = new Map<symbol, NativeTitleHooks>();
    return {
      get: (key) => store.get(key),
      set: (key, value) => {
        store.set(key, value);
      },
    };
  }

  it("two loader initializations share one hooks/state instance and create deps once", () => {
    const registry = makeMapRegistry();
    const key = Symbol("shared-hooks-test");
    let created = 0;
    const makeDeps = (): NativeTitleDeps => {
      created++;
      return {
        client: { session: { get: vi.fn(), update: vi.fn() } },
        fetchImpl: vi.fn(() => Promise.resolve(makeResponse(404))),
        sleep: autoSleep([]),
        resolveConnection: () => ({ baseURL: BASE_URL, gatewayKey: GATEWAY_KEY }),
        makeTimeoutSignal: () => undefined,
      };
    };
    const a = getOrCreateSharedHooks(makeDeps, registry, key);
    const b = getOrCreateSharedHooks(makeDeps, registry, key);
    expect(b).toBe(a); // same hooks instance
    expect(a.$state).toBe(b.$state); // same shared state map
    expect(created).toBe(1); // first-registration-wins; second load's deps unused
  });

  it("duplicate registration is behaviorally idempotent: one header, one poller, one lookup, one update", async () => {
    const registry = makeMapRegistry();
    const key = Symbol("dup-load-test");
    const sleeps: number[] = [];
    const get = vi.fn(() => Promise.resolve({ id: "s1", title: DEFAULT_TITLE }));
    const update = vi.fn(() => Promise.resolve(undefined));
    const fetchImpl = vi.fn(() =>
      Promise.resolve(makeResponse(200, { status: "ready", title: "Native title" })),
    );
    const makeDeps = (): NativeTitleDeps => ({
      client: { session: { get, update } },
      fetchImpl,
      sleep: autoSleep(sleeps),
      resolveConnection: () => ({ baseURL: BASE_URL, gatewayKey: GATEWAY_KEY }),
      makeTimeoutSignal: () => undefined,
    });
    // Two "loads" (project-local + global symlink) resolve to the same instance.
    const a = getOrCreateSharedHooks(makeDeps, registry, key);
    const b = getOrCreateSharedHooks(makeDeps, registry, key);
    expect(b).toBe(a);

    // Lifecycle metadata (shared) → both refs see the same cached default title.
    await a.event({
      event: { type: "session.created", properties: { info: { id: "s1", title: DEFAULT_TITLE } } },
    });

    // Invoke chat.headers on BOTH references for the same session: exactly one arms.
    const outA = freshOutput();
    const outB = freshOutput();
    await a["chat.headers"](headersInput("s1"), outA);
    await b["chat.headers"](headersInput("s1"), outB);
    const armed = [outA, outB].filter((o) => o.headers[SESSION_HEADER] === "s1");
    expect(armed.length).toBe(1);

    // Idle on BOTH references: exactly one poller runs.
    await a.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await b.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await a.$settle();
    await b.$settle();

    expect(fetchImpl).toHaveBeenCalledTimes(1); // one immediate 200-ready fetch
    expect(get).toHaveBeenCalledTimes(1); // cached arm did no lookup; one rename-side recheck
    expect(update).toHaveBeenCalledTimes(1); // at most one title update
  });
});

// ---------------------------------------------------------------------------
// Loader-contract regressions: the entry module must load under OpenCode 1.18.21.
//
// OpenCode resolves a plugin entry by first trying to read a V1 default plugin
// module `{ id, server }` (readV1Plugin); only if the default is NOT that object
// does it fall through to the LEGACY path, which scans the module's runtime exports
// and rejects the first non-function with `Plugin export is not a function`. The
// earlier bare-FUNCTION default fell through and OpenCode rejected the module on a
// non-function named export (e.g. UPDATE_TIMEOUT_MS), so the plugin never loaded.
// These tests inspect the ACTUAL runtime module namespace (not just types).
// ---------------------------------------------------------------------------

/** Faithful model of OpenCode's readV1Plugin-BEFORE-legacy-scan selection order. */
type LoaderSelection = { kind: "v1"; server: unknown } | { kind: "legacy"; server: unknown };

function isV1Module(value: unknown): value is { id: string; server: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { server?: unknown }).server === "function"
  );
}

function selectPluginEntry(mod: Record<string, unknown>): LoaderSelection {
  const def = mod["default"];
  // V1 FIRST: a default `{ id: string, server: fn }` is used directly — the module's
  // other (possibly non-function) exports are never scanned.
  if (isV1Module(def)) return { kind: "v1", server: def.server };
  // LEGACY fallback: every runtime export must be a function, else OpenCode throws.
  for (const value of Object.values(mod)) {
    if (typeof value !== "function") {
      throw new Error("Plugin export is not a function");
    }
  }
  return { kind: "legacy", server: def };
}

describe("native-title plugin — OpenCode loader contract (V1 default module)", () => {
  // The default server writes into the process-global singleton slot; clear it so
  // no case leaks the Symbol.for(...) instance into another.
  const clearGlobalSingleton = (): void => {
    delete (globalThis as unknown as Record<symbol, unknown>)[SHARED_HOOKS_KEY];
  };
  afterEach(clearGlobalSingleton);

  function fakePluginInput(): {
    client: { session: { get: () => Promise<unknown>; update: () => Promise<unknown> } };
  } {
    return {
      client: {
        session: {
          get: () => Promise.resolve({}),
          update: () => Promise.resolve({}),
        },
      },
    };
  }

  it("default export is a V1 object with the stable id and the plugin server function", () => {
    expect(typeof pluginDefault).toBe("object");
    expect(pluginDefault).not.toBeNull();
    expect(pluginDefault.id).toBe("collectiviq-native-title");
    expect(pluginDefault.id).toBe(PLUGIN_ID);
    // `default.server` is EXACTLY the plugin server function (identity), and callable.
    expect(pluginDefault.server).toBe(CollectivIQNativeTitlePlugin);
    expect(typeof pluginDefault.server).toBe("function");
  });

  it("selection recognizes the real module as V1 and never enters the legacy scan", () => {
    // The real module DOES contain non-function named exports that would trip the
    // legacy scan; prove one exists...
    expect(typeof (pluginModule as Record<string, unknown>)["UPDATE_TIMEOUT_MS"]).toBe("number");
    // ...yet selection returns V1 (no throw), so the legacy scan is bypassed.
    const selected = selectPluginEntry({ ...pluginModule });
    expect(selected.kind).toBe("v1");
    expect(selected.server).toBe(CollectivIQNativeTitlePlugin);
  });

  it("models the legacy failure: a bare-function default + non-function export is rejected", () => {
    // This is exactly the OLD shape's failure mode under the legacy scan.
    expect(() => selectPluginEntry({ default: () => undefined, UPDATE_TIMEOUT_MS: 1000 })).toThrow(
      "Plugin export is not a function",
    );
    // A V1 default bypasses the scan even with non-function named exports present.
    const selected = selectPluginEntry({
      default: { id: "x", server: () => undefined },
      UPDATE_TIMEOUT_MS: 1000,
    });
    expect(selected.kind).toBe("v1");
  });

  it("the selected server returns the expected hook surface with no network access", async () => {
    const selected = selectPluginEntry({ ...pluginModule });
    expect(selected.kind).toBe("v1");
    const server = selected.server as typeof CollectivIQNativeTitlePlugin;
    const hooks = await server(fakePluginInput());
    expect(typeof hooks["chat.headers"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(hooks.$state).toBeInstanceOf(Map);
    expect(typeof hooks.$settle).toBe("function");
  });

  it("two selected-server initializations share one hooks/state instance (first-init-wins)", async () => {
    clearGlobalSingleton(); // start from a clean global slot
    const selected = selectPluginEntry({ ...pluginModule });
    const server = selected.server as typeof CollectivIQNativeTitlePlugin;
    const hooksA = await server(fakePluginInput());
    const hooksB = await server(fakePluginInput());
    expect(hooksB).toBe(hooksA); // shared instance
    expect(hooksB.$state).toBe(hooksA.$state); // shared state map
    // afterEach clears the global slot so this does not leak into other cases.
  });
});

// ---------------------------------------------------------------------------
// Connection resolution: gateway key from resolved CollectivIQ provider config
// (`provider.collectiviq.options.apiKey`), with COLLECTIVIQ_GATEWAY_KEY fallback.
// ---------------------------------------------------------------------------

/** Build a config with `provider.collectiviq.options.{baseURL,apiKey}` as given. */
function providerCfg(opts: { baseURL?: unknown; apiKey?: unknown }): unknown {
  const options: Record<string, unknown> = {};
  if ("baseURL" in opts) options["baseURL"] = opts.baseURL;
  if ("apiKey" in opts) options["apiKey"] = opts.apiKey;
  return { provider: { collectiviq: { options } } };
}

/**
 * A synthetic, lazy fallback reader that RECORDS how many times it is invoked and
 * returns a fixed synthetic value. Injected in place of the real credential
 * environment lookup so no test can touch the real credential environment.
 */
function recordingReader(value: string | undefined): { read: ReadGatewayKey; calls: () => number } {
  let calls = 0;
  return {
    read: () => {
      calls++;
      return value;
    },
    calls: () => calls,
  };
}

/** A synthetic lazy reader that throws when invoked (hostile fallback source). */
function throwingReader(): ReadGatewayKey {
  return () => {
    throw new Error("boom");
  };
}

describe("native-title plugin — connection resolution (pure precedence + validation)", () => {
  it("1. resolves a provider-config apiKey and never reads the environment", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: providerCfg({ baseURL: BASE_URL, apiKey: "cfg-key" }),
      readEnvKey: env.read,
    });
    expect(conn).toEqual({
      baseURL: BASE_URL,
      gatewayKey: "cfg-key",
    });
    expect(env.calls()).toBe(0); // provider-config path: zero environment reads
  });

  it("2. prefers the provider-config key and does not read the environment", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: providerCfg({ baseURL: BASE_URL, apiKey: "cfg-key" }),
      readEnvKey: env.read,
    });
    expect(conn?.gatewayKey).toBe("cfg-key");
    expect(env.calls()).toBe(0);
  });

  it("2b. resolves an embedded provider key and never reads the environment", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: undefined,
      embedded: providerCfg({ baseURL: BASE_URL, apiKey: "embedded-key" }),
      readEnvKey: env.read,
    });
    expect(conn).toEqual({
      baseURL: BASE_URL,
      gatewayKey: "embedded-key",
    });
    expect(env.calls()).toBe(0);
  });

  it("3. falls back to the environment reader exactly once when no provider key", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: providerCfg({ baseURL: BASE_URL }),
      readEnvKey: env.read,
    });
    expect(conn).toEqual({
      baseURL: BASE_URL,
      gatewayKey: "env-key",
    });
    expect(env.calls()).toBe(1); // fallback path: exactly one read
  });

  it("4. prefers merged SDK config over embedded and env (base URL and key)", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: providerCfg({ baseURL: "http://merged", apiKey: "merged-key" }),
      embedded: providerCfg({ baseURL: "http://embedded", apiKey: "embedded-key" }),
      readEnvKey: env.read,
    });
    expect(conn?.baseURL).toBe("http://merged");
    expect(conn?.gatewayKey).toBe("merged-key");
    expect(env.calls()).toBe(0);
  });

  it("5. uses embedded config as a compatibility fallback when merged is absent", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: undefined,
      embedded: providerCfg({ baseURL: "http://embedded", apiKey: "embedded-key" }),
      readEnvKey: env.read,
    });
    expect(conn).toEqual({
      baseURL: "http://embedded",
      gatewayKey: "embedded-key",
    });
    expect(env.calls()).toBe(0);
  });

  it("7. an empty config key falls back to the env reader exactly once", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: providerCfg({ baseURL: BASE_URL, apiKey: "" }),
      readEnvKey: env.read,
    });
    expect(conn?.gatewayKey).toBe("env-key");
    expect(env.calls()).toBe(1);
  });

  it("8. a non-string config key falls back to the env reader exactly once", () => {
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: providerCfg({ baseURL: BASE_URL, apiKey: 123 }),
      readEnvKey: env.read,
    });
    expect(conn?.gatewayKey).toBe("env-key");
    expect(env.calls()).toBe(1);
  });

  it("9. accepts a key exactly at 8192 UTF-8 bytes and rejects one over", () => {
    const exact = "a".repeat(8192);
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL, apiKey: exact }),
      })?.gatewayKey,
    ).toBe(exact);
    const over = "a".repeat(8193);
    const env = recordingReader(undefined);
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL, apiKey: over }),
        readEnvKey: env.read,
      }),
    ).toBeUndefined();
    expect(env.calls()).toBe(1); // overlong config key → fallback attempted once
  });

  it("10. rejects literal unresolved {env:...} and {file:...} placeholders", () => {
    const env = recordingReader(undefined);
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL, apiKey: "{env:COLLECTIVIQ_GATEWAY_KEY}" }),
        readEnvKey: env.read,
      }),
    ).toBeUndefined();
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL, apiKey: "{file:/etc/collectiviq/key}" }),
        readEnvKey: env.read,
      }),
    ).toBeUndefined();
    expect(env.calls()).toBe(2); // one fallback attempt per unusable provider key
  });

  it("11. counts key size by UTF-8 bytes, not characters (multibyte boundary)", () => {
    const at = "a".repeat(8189) + "€"; // 8189 + 3 (€) = 8192 bytes
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL, apiKey: at }),
      })?.gatewayKey,
    ).toBe(at);
    const over = "a".repeat(8190) + "€"; // 8190 + 3 = 8193 bytes
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL, apiKey: over }),
      }),
    ).toBeUndefined();
  });

  it("12. never invokes an accessor apiKey (falls back to env exactly once)", () => {
    let called = 0;
    const options: Record<string, unknown> = { baseURL: BASE_URL };
    Object.defineProperty(options, "apiKey", {
      enumerable: true,
      configurable: true,
      get() {
        called++;
        return "SECRET";
      },
    });
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: { provider: { collectiviq: { options } } },
      readEnvKey: env.read,
    });
    expect(called).toBe(0); // accessor never invoked
    expect(conn?.gatewayKey).toBe("env-key");
    expect(env.calls()).toBe(1);
  });

  it("13. ignores an inherited (non-own) apiKey and falls back to env once", () => {
    const options = Object.create({ apiKey: "SECRET" }) as Record<string, unknown>;
    options["baseURL"] = BASE_URL;
    const env = recordingReader("env-key");
    const conn = resolveConnectionConfig({
      merged: { provider: { collectiviq: { options } } },
      readEnvKey: env.read,
    });
    expect(conn?.gatewayKey).toBe("env-key"); // inherited apiKey ignored
    expect(env.calls()).toBe(1);
  });

  it("14. fails closed (no throw) on a hostile proxy whose descriptor lookup throws", () => {
    const merged = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    let conn: NativeTitleConnectionConfig | undefined;
    expect(() => {
      conn = resolveConnectionConfig({ merged });
    }).not.toThrow();
    expect(conn).toBeUndefined();
  });

  it("6b. missing base URL never invokes the environment reader", () => {
    const env = recordingReader("env-key");
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ apiKey: "cfg-key" }), // no base URL, provider key present
        readEnvKey: env.read,
      }),
    ).toBeUndefined();
    expect(env.calls()).toBe(0); // no complete connection possible → no fallback read
  });

  it("6c. invalid (placeholder) base URL never invokes the environment reader", () => {
    const env = recordingReader("env-key");
    expect(
      resolveConnectionConfig({
        merged: providerCfg({ baseURL: "{env:BASE}" }), // unusable base URL, no key
        readEnvKey: env.read,
      }),
    ).toBeUndefined();
    expect(env.calls()).toBe(0);
  });

  it("7b. a throwing environment reader fails open (no throw, no connection)", () => {
    let conn: NativeTitleConnectionConfig | undefined;
    expect(() => {
      conn = resolveConnectionConfig({
        merged: providerCfg({ baseURL: BASE_URL }), // no provider key → fallback path
        readEnvKey: throwingReader(),
      });
    }).not.toThrow();
    expect(conn).toBeUndefined();
  });

  it("8b. an unusable synthetic env value fails open on the fallback path", () => {
    for (const bad of ["", "{env:X}", "a".repeat(8193)]) {
      const env = recordingReader(bad);
      expect(
        resolveConnectionConfig({
          merged: providerCfg({ baseURL: BASE_URL }),
          readEnvKey: env.read,
        }),
      ).toBeUndefined();
      expect(env.calls()).toBe(1); // read once, then rejected
    }
  });

  it("17. returns no partial connection when base URL or key is missing", () => {
    const env = recordingReader(undefined);
    expect(
      resolveConnectionConfig({ merged: providerCfg({ apiKey: "cfg-key" }), readEnvKey: env.read }),
    ).toBeUndefined(); // no base URL
    expect(
      resolveConnectionConfig({ merged: providerCfg({ baseURL: BASE_URL }), readEnvKey: env.read }),
    ).toBeUndefined(); // no key (fallback read, still nothing)
  });
});

describe("native-title plugin — connection resolution (production resolver I/O)", () => {
  it("6. calls client.config.get() at most once and never reads env on the provider path", async () => {
    let calls = 0;
    const input: unknown = {
      client: {
        session: { get: () => Promise.resolve({}), update: () => Promise.resolve({}) },
        config: {
          get: () => {
            calls++;
            return Promise.resolve({ data: providerCfg({ baseURL: BASE_URL, apiKey: "cfg-key" }) });
          },
        },
      },
    };
    // Inject a throwing reader: if the provider path ever reads env, this throws.
    const conn = await defaultResolveConnection(input as PluginInput, throwingReader());
    expect(calls).toBe(1);
    expect(conn).toEqual({
      baseURL: BASE_URL,
      gatewayKey: "cfg-key",
    });
  });

  it("6d. with no usable provider key, invokes the injected env reader exactly once", async () => {
    const input: unknown = {
      client: {
        session: { get: () => Promise.resolve({}), update: () => Promise.resolve({}) },
        config: {
          get: () => Promise.resolve({ data: providerCfg({ baseURL: BASE_URL }) }), // no key
        },
      },
    };
    const env = recordingReader("env-key");
    const conn = await defaultResolveConnection(input as PluginInput, env.read);
    expect(env.calls()).toBe(1);
    expect(conn).toEqual({
      baseURL: BASE_URL,
      gatewayKey: "env-key",
    });
  });
});

describe("native-title plugin — credential env lookup is confined to the wrapper", () => {
  const CRED_ENV = "COLLECTIVIQ_GATEWAY_KEY";
  const pluginSrc = readFileSync(
    new URL("../../.opencode/plugins/collectiviq-native-title.ts", import.meta.url),
    "utf8",
  );
  const testSrc = readFileSync(new URL("./opencode-title-plugin.test.ts", import.meta.url), "utf8");

  it("11a. reads the credential env var in exactly one place in the plugin (the wrapper)", () => {
    // Count `process.env` reads of the credential var (any quote/access style),
    // excluding placeholder string literals like "{env:COLLECTIVIQ_GATEWAY_KEY}".
    const reads = pluginSrc.match(
      new RegExp(
        `process\\.env\\s*(?:\\.${CRED_ENV}\\b|\\[\\s*["'\`]${CRED_ENV}["'\`]\\s*\\])`,
        "g",
      ),
    );
    expect(reads).not.toBeNull();
    expect(reads).toHaveLength(1);
  });

  it("11b. no test source path reads the real credential env var", () => {
    const testReads = testSrc.match(
      new RegExp(
        `process\\.env\\s*(?:\\.${CRED_ENV}\\b|\\[\\s*["'\`]${CRED_ENV}["'\`]\\s*\\])`,
        "g",
      ),
    );
    expect(testReads).toBeNull();
  });
});

describe("native-title plugin — connection resolution (bounded/fail-open through the poller)", () => {
  it("15. bounds a hung connection resolution and issues no fetch", async () => {
    const h = makeHarness({ resolveConnection: () => new Promise<never>(() => {}) });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(h.sleeps).toEqual([RESOLVE_TIMEOUT_MS]); // exactly one bounded pre-poll sleep
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("16. session deletion during a hung resolution prevents any later fetch", async () => {
    const h = makeHarness({
      resolveConnection: () => new Promise<never>(() => {}),
      sleep: abortOnlySleep,
    });
    await armCached(h);
    await idle(h);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await h.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    await h.hooks.$settle(); // must complete (not hang)
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("17b. an unavailable connection (undefined) fails open and issues no fetch", async () => {
    const h = makeHarness({ resolveConnection: () => undefined });
    await armCached(h);
    await idle(h);
    await h.hooks.$settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
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
