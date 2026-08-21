// CollectivIQ native-title bridge (OpenCode project-local plugin).
//
// Purpose: OpenCode's hidden LLM `title` agent is DISABLED in opencode.jsonc so it
// creates no separate title thread/completion. Instead, for the first ELIGIBLE
// foreground request of a fresh top-level (parentless) session — the primary
// `collectiviq-text` agent routed to the `collectiviq` provider, whose title is
// still OpenCode's generated default — this plugin arms the session by attaching a
// session-ID header, then (after the session goes idle) polls the gateway for the
// native, server-generated CollectivIQ thread title and applies it to the OpenCode
// session.
//
// Design constraints (see AGENTS.md / .agent/instructions/security.md):
//   * Best-effort and NON-BLOCKING: every hook catches all failures and never
//     throws or alerts. `chat.headers` performs NO unbounded work — it reads
//     in-memory session metadata captured from `session.created`/`session.updated`
//     lifecycle events (zero async in the normal case); only when a session has
//     not yet been observed does it fall back to a SMALL, bounded `session.get()`
//     that fails open (attaches no header) on timeout. It therefore adds at most a
//     bounded delay to the foreground request, never an indefinite one.
//   * Atomic arming: the uncached fallback first inserts a `pending` RESERVATION
//     synchronously (before awaiting `session.get()`), so two concurrent hooks for
//     the same session issue ONE lookup and attach ONE header; a failed/ineligible
//     lookup releases the reservation so a later request may retry.
//   * EVERY plugin-owned await is lifecycle- and timeout-bounded: base-URL
//     resolution (which may await `client.config.get()`), the session lookups, the
//     inter-poll sleeps, the fetches, AND the terminal `session.update` rename all
//     race the session cancellation signal plus a small explicit timeout, so a
//     deleted/evicted session settles its own tasks PROMPTLY and does no further
//     work. Cancellation is PASSED to the SDK operations that accept a `signal`
//     (`update`, and the fetch). But this plugin does not CLAIM physical
//     cancellation: an SDK/resolver promise that has no signal, or that ignores
//     one, is simply no longer awaited past the bound — it is detached and its
//     late resolution/rejection swallowed and ignored (no state change, no
//     unhandled rejection).
//   * Privacy-preserving: the gateway key, base URL credentials, session id,
//     provider title, response bodies, prompts, and answers are NEVER logged.
//     (This plugin does not log at all.)
//   * Only the exact configured gateway origin is contacted.
//
// The OpenCode plugin API is approximated with NARROW LOCAL STRUCTURAL TYPES below
// (this file imports no `opencode` package), aligned to the installed
// `@opencode-ai/plugin` + `@opencode-ai/sdk` declarations: `chat.headers` carries
// `sessionID`, `agent`, and `provider.info.id`; the `session.created`/`.updated`/
// `.deleted` events carry the full session `info` (`id`, `parentID`, `title`). The
// types are fully injectable so tests can fake them.

// ---------------------------------------------------------------------------
// Local structural approximations of the OpenCode plugin API.
// ---------------------------------------------------------------------------

/** A CollectivIQ/OpenCode session as far as this plugin reads it. */
export interface TitleSession {
  id?: string;
  parentID?: string;
  title?: string;
}

/**
 * Narrow subset of the OpenCode SDK client this plugin uses. `session.get` is
 * modeled as returning the session directly; a `{ data: session }` envelope is
 * also tolerated (see `unwrapSession`). Local approximation, fully fakeable.
 *
 * The installed SDK's request options extend `RequestInit`, so both methods
 * accept an optional `signal: AbortSignal` for cancellation. The plugin passes a
 * composed cancel signal to `update` (the terminal write); an SDK build that
 * ignores it is handled by also racing a bounded timeout and detaching the
 * underlying promise (see `applyTitle`).
 */
export interface TitleClient {
  session: {
    get(args: { path: { id: string }; signal?: AbortSignal }): Promise<unknown>;
    update(args: {
      path: { id: string };
      body: { title: string };
      signal?: AbortSignal;
    }): Promise<unknown>;
  };
}

/** Plugin input as passed by the OpenCode plugin loader (subset). */
export interface PluginInput {
  client: TitleClient;
  project?: unknown;
  directory?: unknown;
  worktree?: unknown;
  $?: unknown;
}

/**
 * `chat.headers` hook input (subset, aligned to the installed declarations):
 * the session id, the resolved `agent` name, and the provider context whose
 * `info.id` is the provider id (e.g. `collectiviq`).
 */
export interface ChatHeadersInput {
  sessionID: string;
  agent?: string;
  provider?: { info?: { id?: string } };
}

/** `chat.headers` hook output: mutable outbound header map. */
export interface ChatHeadersOutput {
  headers: Record<string, string>;
}

/** Generic OpenCode event envelope (subset). */
export interface OpenCodeEvent {
  type: string;
  properties?: unknown;
}

/** The hook object returned to the OpenCode plugin loader. */
export interface NativeTitleHooks {
  "chat.headers": (input: ChatHeadersInput, output: ChatHeadersOutput) => Promise<void>;
  event: (input: { event: OpenCodeEvent }) => Promise<void>;
  // Test-only introspection. OpenCode ignores unrecognized hook keys.
  readonly $state: Map<string, SessionEntry>;
  readonly $settle: () => Promise<void>;
}

/** Structural minimal `fetch` so this file does not depend on DOM lib types. */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Injectable seams for the core hooks factory. */
export interface NativeTitleDeps {
  client: TitleClient;
  fetchImpl: FetchLike;
  /** Abortable delay: resolves after `ms`, or early (clearing its timer) if `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  resolveBaseURL: () => Promise<string | undefined> | string | undefined;
  resolveGatewayKey: () => string | undefined;
  /** Returns a per-request timeout abort signal, or undefined for no bound. */
  makeTimeoutSignal?: (ms: number) => AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Constants (gateway contract + bounds + eligibility).
// ---------------------------------------------------------------------------

const SESSION_HEADER = "X-CollectivIQ-OpenCode-Session-ID";
const ENDPOINT_PATH = "/opencode/session-title";
const PROVIDER_ID = "collectiviq";
/** Only the intended primary foreground agent may arm native-title propagation. */
const FOREGROUND_AGENT = "collectiviq-text";

// OpenCode v1.18.18's generated default parent-session title, e.g.
// "New session - 2026-08-20T14:12:03.123Z". This mirrors OpenCode's own
// `isDefaultTitle()`: a `Date#toISOString()` timestamp with EXACTLY three
// fractional-second digits and a trailing `Z`. It is matched exactly so a manual
// title ("New session - roadmap") — or any non-generated timestamp shape (no
// millis, one or two millis digits) — is NOT treated as the generated default.
const DEFAULT_TITLE_RE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Poll schedule: immediately, then 2, 4, 8, 8, 8 seconds — SIX attempts total.
const SCHEDULE_MS: readonly number[] = [0, 2000, 4000, 8000, 8000, 8000];

// Per-request timeout bounds. Each request is bounded and kept shorter than the
// remaining polling window so a single hang cannot exceed the overall budget.
const REQUEST_TIMEOUT_CAP_MS = 5000;
const REQUEST_TIMEOUT_MIN_MS = 500;

// Bound on the fail-open `chat.headers` fallback session lookup (only used when a
// session's metadata has not yet been observed via a lifecycle event).
const SESSION_LOOKUP_TIMEOUT_MS = 1000;

// Bound on awaiting the TERMINAL rename write (`session.update`). A composed
// cancel signal is passed to the SDK and the plugin stops awaiting after this
// bound (or on deletion/eviction), so a stuck update can never leave the poll
// task pending. Exported so tests can assert the exact bound without a real wait.
export const UPDATE_TIMEOUT_MS = 1000;

// Bound on resolving the gateway base URL before polling. The production resolver
// may await `client.config.get()`, which can stall; this caps that wait so a
// poller task always settles (and settles promptly on deletion).
export const RESOLVE_TIMEOUT_MS = 1500;

// OpenCode session-title display bound (Unicode code points).
const TITLE_MAX_CODE_POINTS = 100;
const TITLE_KEEP_CODE_POINTS = 97; // + "..." == 100

// Bounded plugin state (insertion-ordered LRU eviction).
const MAX_SESSIONS = 256;
const MAX_META = 256;

// ---------------------------------------------------------------------------
// Per-session state.
// ---------------------------------------------------------------------------

/**
 * State for a tracked session. A `chat.headers` fallback lookup first inserts a
 * `pending` RESERVATION (atomically, before it awaits `session.get()`) so a
 * concurrent hook for the same session cannot also lookup/arm. A successful,
 * eligible lookup transitions the SAME reservation to `armed`; a failed, timed-out,
 * ineligible, or cancelled lookup releases it so a later request may retry. The
 * cached path inserts an `armed` entry directly (fully synchronous, no race).
 * Both states share the one bounded `sessions` map, preserving the 256 bound.
 */
export interface SessionEntry {
  /** `pending` = arming reservation in flight; `armed` = eligible and header attached. */
  status: "pending" | "armed";
  /** A poller has already been started for this session (one per session, ever). */
  polling: boolean;
  /** Exact captured default title (set on arm; undefined while pending). */
  initialTitle: string | undefined;
  /** Lifecycle cancellation: aborted on session deletion or state eviction. */
  cancel: AbortController;
}

/** Cached session metadata captured from lifecycle events (parentID + title). */
interface SessionMeta {
  parentID?: string | undefined;
  title?: string | undefined;
}

type PollResult = { kind: "ready"; title: string } | { kind: "pending" } | { kind: "stop" };

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Compose up to two abort signals; returns undefined only when both are absent. */
function composeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

function unwrapSession(res: unknown): TitleSession | undefined {
  if (!isRecord(res)) return undefined;
  const data = res["data"];
  if (isRecord(data)) return data;
  return res;
}

/** A `session.idle` event carries only `sessionID`. */
function eventSessionId(properties: unknown): string | undefined {
  if (!isRecord(properties)) return undefined;
  const direct = properties["sessionID"];
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

/** A `session.created`/`.updated`/`.deleted` event carries the full session `info`. */
function eventSessionInfo(
  properties: unknown,
): { id: string; parentID?: string | undefined; title?: string | undefined } | undefined {
  if (!isRecord(properties)) return undefined;
  const info = properties["info"];
  if (!isRecord(info)) return undefined;
  const id = info["id"];
  if (typeof id !== "string" || id.length === 0) return undefined;
  const parentID = typeof info["parentID"] === "string" ? info["parentID"] : undefined;
  const title = typeof info["title"] === "string" ? info["title"] : undefined;
  return { id, parentID, title };
}

function isReadyBody(body: unknown): body is { status: "ready"; title: string } {
  return isRecord(body) && body["status"] === "ready" && typeof body["title"] === "string";
}

/** Code-point-safe truncation to OpenCode's display limit. */
export function normalizeTitle(title: string): string {
  const points = Array.from(title);
  if (points.length <= TITLE_MAX_CODE_POINTS) return title;
  return points.slice(0, TITLE_KEEP_CODE_POINTS).join("") + "...";
}

function joinTitleUrl(baseURL: string): string {
  return baseURL.replace(/\/+$/, "") + ENDPOINT_PATH;
}

// Best-effort structural probe for the configured gateway base URL. OpenCode may
// expose the resolved config to plugins differently across versions; probe safe
// locations and fail open. Tests inject their own resolver instead.
function pickBaseURL(config: unknown): string | undefined {
  if (!isRecord(config)) return undefined;
  const provider = config["provider"];
  if (!isRecord(provider)) return undefined;
  const collectiviq = provider[PROVIDER_ID];
  if (!isRecord(collectiviq)) return undefined;
  const options = collectiviq["options"];
  if (!isRecord(options)) return undefined;
  const baseURL = options["baseURL"];
  return typeof baseURL === "string" && baseURL.length > 0 ? baseURL : undefined;
}

async function defaultResolveBaseURL(input: PluginInput): Promise<string | undefined> {
  try {
    const anyInput = input as unknown as Record<string, unknown>;
    const embedded = pickBaseURL(anyInput["config"]);
    if (embedded) return embedded;
    const client = anyInput["client"] as { config?: { get?: () => Promise<unknown> } } | undefined;
    if (client?.config?.get) {
      const res = await client.config.get();
      const data = isRecord(res) && "data" in res ? res["data"] : res;
      const fromClient = pickBaseURL(data);
      if (fromClient) return fromClient;
    }
  } catch {
    // Fail open: no base URL means the plugin silently does nothing.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Core hooks factory (fully injectable / fakeable).
// ---------------------------------------------------------------------------

export function createNativeTitleHooks(deps: NativeTitleDeps): NativeTitleHooks {
  const { client, fetchImpl, sleep, resolveBaseURL, resolveGatewayKey } = deps;
  const makeTimeoutSignal = deps.makeTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  // Armed sessions (with a poller + cancellation). Exposed to tests as `$state`.
  const sessions = new Map<string, SessionEntry>();
  // Session metadata captured from lifecycle events (parentID + title).
  const metaCache = new Map<string, SessionMeta>();
  const activePolls = new Set<Promise<void>>();

  /** Insert an armed entry, evicting (and cancelling) the oldest when at capacity. */
  function rememberSession(id: string, entry: SessionEntry): void {
    if (!sessions.has(id) && sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) {
        const evicted = sessions.get(oldest);
        // Cancel the evicted session's pending title work before dropping it.
        evicted?.cancel.abort();
        sessions.delete(oldest);
      }
    }
    sessions.set(id, entry);
  }

  /** Cache session metadata, evicting the oldest when at capacity (no cancellation needed). */
  function rememberMeta(id: string, meta: SessionMeta): void {
    if (!metaCache.has(id) && metaCache.size >= MAX_META) {
      const oldest = metaCache.keys().next().value;
      if (oldest !== undefined) metaCache.delete(oldest);
    }
    metaCache.set(id, meta);
  }

  /** Cancel and forget an armed session and its cached metadata. */
  function dropSession(id: string): void {
    const entry = sessions.get(id);
    if (entry) {
      entry.cancel.abort();
      sessions.delete(id);
    }
    metaCache.delete(id);
  }

  /**
   * Bounded, fail-open, lifecycle-aware session lookup. Races the SDK
   * `session.get()` against a small timeout AND the caller's lifecycle signal, so
   * a stalled local call can never block indefinitely and a deletion/eviction
   * stops the wait PROMPTLY (well before the timeout). On timeout, cancellation,
   * rejection, or a non-session result it resolves to `undefined` (arm nothing).
   * The underlying get is detached and swallowed so a late settle can never
   * surface as an unhandled rejection.
   */
  async function boundedSessionLookup(
    sessionId: string,
    lifecycleSignal: AbortSignal,
  ): Promise<TitleSession | undefined> {
    if (lifecycleSignal.aborted) return undefined;
    const sleepAbort = new AbortController();
    // The wait ends on our timer OR on lifecycle cancellation, whichever is first.
    const waitSignal = composeSignals(sleepAbort.signal, lifecycleSignal);
    const getP = client.session
      .get({ path: { id: sessionId } })
      .then(unwrapSession)
      .catch(() => undefined);
    const stopP = sleep(SESSION_LOOKUP_TIMEOUT_MS, waitSignal).then(() => "__stop__" as const);
    try {
      const raced = await Promise.race([getP, stopP]);
      if (lifecycleSignal.aborted) return undefined;
      return raced === "__stop__" ? undefined : raced;
    } finally {
      // Clear the timer if the get won; never leak a pending rejection.
      sleepAbort.abort();
      getP.catch(() => undefined);
    }
  }

  async function fetchTitleOnce(
    baseURL: string,
    key: string,
    sessionId: string,
    timeoutMs: number,
    lifecycleSignal: AbortSignal,
  ): Promise<PollResult> {
    const signal = composeSignals(makeTimeoutSignal(timeoutMs), lifecycleSignal);
    let res: FetchResponseLike;
    try {
      res = await fetchImpl(joinTitleUrl(baseURL), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          [SESSION_HEADER]: sessionId,
          Accept: "application/json",
        },
        ...(signal ? { signal } : {}),
      });
    } catch {
      // Network failure, per-request timeout, or lifecycle cancellation: stop.
      return { kind: "stop" };
    }
    if (res.status === 202) return { kind: "pending" };
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { kind: "stop" };
      }
      if (isReadyBody(body)) return { kind: "ready", title: body.title };
      return { kind: "stop" };
    }
    // 400, 404, or any other status: unavailable → stop.
    return { kind: "stop" };
  }

  async function applyTitle(
    sessionId: string,
    initialTitle: string,
    providerTitle: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    // Bounded, lifecycle-aware rename-side recheck (stops promptly on deletion).
    const current = await boundedSessionLookup(sessionId, signal);
    // Cancelled while the lookup was pending, or the lookup timed out.
    if (signal.aborted || !current) return;
    // Guard against a manual rename or another integration during polling.
    if (current.title !== initialTitle) return;
    const normalized = normalizeTitle(providerTitle);
    if (normalized.length === 0) return;
    // Final cancellation check immediately before the write.
    if (signal.aborted) return;

    // Bounded, lifecycle-aware TERMINAL write. A composed cancel signal (lifecycle
    // OR our own controller) is passed to the SDK, so a supporting build cancels
    // the request on deletion/eviction/timeout. Regardless of whether the SDK
    // honours it, the plugin awaits the update only until UPDATE_TIMEOUT_MS or the
    // lifecycle signal (whichever is first), then STOPS — so the poll task always
    // settles promptly. The underlying promise is detached and its rejection
    // swallowed so a late settle can never surface as an unhandled rejection.
    const requestAbort = new AbortController();
    const requestSignal = composeSignals(requestAbort.signal, signal);
    const stopAbort = new AbortController();
    const waitSignal = composeSignals(stopAbort.signal, signal);

    let updateP: Promise<unknown>;
    try {
      updateP = Promise.resolve(
        client.session.update({
          path: { id: sessionId },
          body: { title: normalized },
          ...(requestSignal ? { signal: requestSignal } : {}),
        }),
      ).catch(() => undefined);
    } catch {
      // A synchronous throw from update(): nothing was scheduled; done.
      return;
    }
    const stopP = sleep(UPDATE_TIMEOUT_MS, waitSignal).then(() => "__stop__" as const);
    try {
      await Promise.race([updateP, stopP]);
    } finally {
      // Abort the SDK request (deletion/timeout/cleanup) and clear the wait timer;
      // detach + swallow the underlying promise so a late rejection is inert.
      requestAbort.abort();
      stopAbort.abort();
      updateP.catch(() => undefined);
    }
  }

  /**
   * Bounded, lifecycle-aware base-URL resolution. The production `resolveBaseURL`
   * may await `client.config.get()`, which can stall indefinitely; this races it
   * against a small timeout AND the session's cancellation signal, so the poller
   * NEVER awaits it permanently and settles PROMPTLY on deletion/eviction. A
   * timeout, cancellation, rejection, or malformed (non-string) result yields
   * `undefined` (stop). The underlying resolver promise is detached and swallowed
   * — it is not physically cancelled (the API offers no signal); the plugin simply
   * stops awaiting it and does no further work.
   */
  async function resolveBaseURLBounded(signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return undefined;
    const sleepAbort = new AbortController();
    const waitSignal = composeSignals(sleepAbort.signal, signal);
    const resolveP = Promise.resolve()
      .then(() => resolveBaseURL())
      .then((v) => (typeof v === "string" && v.length > 0 ? v : undefined))
      .catch(() => undefined);
    const stopP = sleep(RESOLVE_TIMEOUT_MS, waitSignal).then(() => "__stop__" as const);
    try {
      const raced = await Promise.race([resolveP, stopP]);
      if (signal.aborted) return undefined;
      return raced === "__stop__" ? undefined : raced;
    } finally {
      sleepAbort.abort();
      resolveP.catch(() => undefined);
    }
  }

  async function pollAndRename(
    sessionId: string,
    initialTitle: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    // Resolve config under a lifecycle-bounded race BEFORE any polling, so a
    // stalled resolver cannot leave this task permanently unsettled.
    const baseURL = await resolveBaseURLBounded(signal);
    if (signal.aborted || !baseURL) return;
    const key = resolveGatewayKey();
    if (signal.aborted || !key) return; // Fail open: missing config → do nothing.

    for (let i = 0; i < SCHEDULE_MS.length; i++) {
      if (signal.aborted) return;
      const delay = SCHEDULE_MS[i] ?? 0;
      if (delay > 0) {
        await sleep(delay, signal);
        if (signal.aborted) return;
      }
      const remainingAfter = SCHEDULE_MS.slice(i + 1).reduce((a, b) => a + b, 0);
      const timeoutMs = clamp(
        remainingAfter > 0 ? remainingAfter : REQUEST_TIMEOUT_CAP_MS,
        REQUEST_TIMEOUT_MIN_MS,
        REQUEST_TIMEOUT_CAP_MS,
      );
      const result = await fetchTitleOnce(baseURL, key, sessionId, timeoutMs, signal);
      if (signal.aborted) return;
      if (result.kind === "ready") {
        await applyTitle(sessionId, initialTitle, result.title, signal);
        return;
      }
      if (result.kind === "pending") continue; // wait per the capped schedule
      return; // stop on unavailable/error/malformed/network/timeout
    }
    // Exhausted all attempts: leave the title unchanged.
  }

  /**
   * The exact captured default title when `meta` is eligible (parentless + the
   * exact OpenCode default-title form), else `undefined`. Pure; no state change.
   */
  function eligibleTitle(meta: TitleSession | SessionMeta): string | undefined {
    if (meta.parentID) return undefined; // parentless top-level session only
    const title = meta.title;
    if (typeof title !== "string" || !DEFAULT_TITLE_RE.test(title)) return undefined;
    return title;
  }

  const chatHeaders = async (input: ChatHeadersInput, output: ChatHeadersOutput): Promise<void> => {
    try {
      const sessionId = input.sessionID;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      // Eligibility gate FIRST, so an ineligible agent/provider never consumes the
      // session's one arming opportunity (and never triggers a session lookup).
      if (input.agent !== FOREGROUND_AGENT) return;
      if (input.provider?.info?.id !== PROVIDER_ID) return;
      // Already reserved (pending) or armed — do not lookup/arm/replace again.
      if (sessions.has(sessionId)) return;

      // Cached path: fully synchronous, so two concurrent hooks cannot race — the
      // first inserts the armed entry before the second reaches the `has` check.
      const cached = metaCache.get(sessionId);
      if (cached) {
        const title = eligibleTitle(cached);
        if (title !== undefined) {
          rememberSession(sessionId, {
            status: "armed",
            polling: false,
            initialTitle: title,
            cancel: new AbortController(),
          });
          output.headers[SESSION_HEADER] = sessionId;
        }
        return;
      }

      // Uncached path: reserve SYNCHRONOUSLY (before the first await) so a
      // concurrent eligible hook sees the reservation via `sessions.has` and
      // returns without a second `session.get()` or a second header. The
      // reservation carries the lifecycle cancel used to abort the lookup and
      // (later) the poller.
      const reservation: SessionEntry = {
        status: "pending",
        polling: false,
        initialTitle: undefined,
        cancel: new AbortController(),
      };
      rememberSession(sessionId, reservation);

      /** Drop the reservation only if it is still the current entry (identity-safe). */
      const releaseIfCurrent = (): void => {
        if (sessions.get(sessionId) === reservation) sessions.delete(sessionId);
      };

      try {
        const looked = await boundedSessionLookup(sessionId, reservation.cancel.signal);
        // Deleted/evicted during the lookup, or the entry was already replaced by a
        // newer operation → ignore this (possibly late) result entirely.
        if (reservation.cancel.signal.aborted) return;
        if (sessions.get(sessionId) !== reservation) return;
        const title = looked ? eligibleTitle(looked) : undefined;
        if (title === undefined) {
          // Timed out / failed / child / non-default → release so a later
          // eligible request may retry this session.
          releaseIfCurrent();
          return;
        }
        // Transition the SAME reservation to armed and attach the header once.
        reservation.status = "armed";
        reservation.initialTitle = title;
        output.headers[SESSION_HEADER] = sessionId;
      } catch {
        releaseIfCurrent();
      }
    } catch {
      // Best-effort: never throw out of a hook.
    }
  };

  // The event hook does only synchronous bookkeeping and detaches the poller, so
  // it awaits nothing; it still satisfies the `=> Promise<void>` hook signature.
  const handleEvent = (input: { event: OpenCodeEvent }): void => {
    try {
      const type = input.event?.type;
      if (type === "session.created" || type === "session.updated") {
        const info = eventSessionInfo(input.event.properties);
        if (info) rememberMeta(info.id, { parentID: info.parentID, title: info.title });
        return;
      }
      if (type === "session.idle") {
        const sessionId = eventSessionId(input.event.properties);
        if (!sessionId) return;
        const entry = sessions.get(sessionId);
        // Only an ARMED entry (with a captured title) starts a poller; a pending
        // reservation is skipped, and one poller runs per session at most.
        if (!entry || entry.status !== "armed" || entry.polling) return;
        if (entry.initialTitle === undefined) return;
        entry.polling = true;
        const { initialTitle, cancel } = entry;
        // Start ONE detached, caught polling task bound to the session's lifecycle
        // cancellation signal (aborted on deletion/eviction).
        const task = pollAndRename(sessionId, initialTitle, cancel.signal)
          .catch(() => {
            // swallow: best-effort
          })
          .finally(() => {
            activePolls.delete(task);
          });
        activePolls.add(task);
        void task;
        return;
      }
      if (type === "session.deleted") {
        const info = eventSessionInfo(input.event.properties);
        const sessionId = info?.id ?? eventSessionId(input.event.properties);
        if (sessionId) dropSession(sessionId);
        return;
      }
    } catch {
      // Best-effort: never throw out of a hook.
    }
  };

  const event = (input: { event: OpenCodeEvent }): Promise<void> => {
    handleEvent(input);
    return Promise.resolve();
  };

  return {
    "chat.headers": chatHeaders,
    event,
    $state: sessions,
    $settle: async () => {
      await Promise.all([...activePolls]);
    },
  };
}

// ---------------------------------------------------------------------------
// Default export: the OpenCode-loadable plugin.
// ---------------------------------------------------------------------------

export type Plugin = (input: PluginInput) => Promise<NativeTitleHooks>;

/** Real abortable delay: clears its timer and resolves early when `signal` aborts. */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
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
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const CollectivIQNativeTitlePlugin: Plugin = (input: PluginInput) => {
  return Promise.resolve(
    createNativeTitleHooks({
      client: input.client,
      fetchImpl: globalThis.fetch,
      sleep: realSleep,
      resolveBaseURL: () => defaultResolveBaseURL(input),
      resolveGatewayKey: () => process.env["COLLECTIVIQ_GATEWAY_KEY"],
    }),
  );
};

export { CollectivIQNativeTitlePlugin };
export default CollectivIQNativeTitlePlugin;
