// CollectivIQ native-title bridge (OpenCode plugin; committed project-local by
// default, and optionally installed globally via a manual symlink for cross-project
// use — see README). The default export is process-wide idempotent: global +
// project-local discovery in one process share a single hooks instance (see the
// singleton section at the bottom of this file).
//
// The plugin has TWO independent responsibilities that share one gate but nothing
// else. Do not re-couple them.
//
//  1. SESSION IDENTITY (per request). Every matching completion — the primary
//     `collectiviq-text` agent routed to the `collectiviq` provider, carrying a
//     session id the gateway would accept — gets the
//     `X-CollectivIQ-OpenCode-Session-ID` header. The gateway needs that identity
//     on EVERY turn: optional Phase 5A thread reuse (specification §5.1.1) keys a
//     session's CollectivIQ thread on it, so a follow-up turn that omits it silently
//     falls back to a brand-new thread and loses the conversation. Attaching it is
//     synchronous and unconditional once the gates pass; it never depends on
//     session metadata, on title state, or on anything that can fail or time out.
//
//  2. NATIVE-TITLE PROPAGATION (one workflow per RETAINED session entry).
//     OpenCode's hidden LLM `title` agent is DISABLED in opencode.jsonc so it
//     creates no separate title thread/completion. Instead, for the first eligible
//     request of a fresh top-level (parentless) session whose title is still
//     OpenCode's generated default, this plugin arms the session, then (after the
//     session goes idle) polls the gateway for the native, server-generated
//     CollectivIQ thread title and applies it to the OpenCode session. Everything
//     below that touches `sessions`, session metadata, the parent/default-title
//     checks, polling, cancellation, or renaming belongs to THIS responsibility
//     alone. Repeated and concurrent requests do not rearm a RETAINED entry, so the
//     header repeating does not multiply title work — but the guarantee is scoped
//     to that entry's retention, not to the session's whole lifetime: `sessions` is
//     a bounded 256-entry INSERTION-ORDER map (see MAX_SESSIONS) that evicts the
//     oldest inserted retained entry, and eviction may permit a later workflow.
//     After eviction, UPDATED non-default metadata blocks rearming, but STALE
//     cached default metadata may permit one more bounded arm+poll. What prevents
//     an overwrite in that case is not the arming gate but the rename-side
//     current-title recheck immediately before `session.update` (see applyTitle).
//
// Consequences of that split: a manual, renamed, already-propagated, or child
// session still carries the reuse identity but arms nothing here, and a failed or
// timed-out title-metadata lookup leaves the already-attached header in place. An
// invalid session id, a different agent, or a different provider gets no header at
// all — the gateway would reject or ignore the value, and a wrong-provider request
// is not ours to identify.
//
// "Arms nothing" is local to this plugin, NOT to the gateway. The gateway registers
// its own short-lived title correlation for any successful completion that carried a
// valid session header and created a thread, so a session this plugin will never
// poll for can still occupy one of those bounded entries until it expires. That is a
// deliberate, accepted tradeoff of per-request identity (specification §§9.5 and
// 25): it can suppress another session's best-effort title propagation but never
// affects a completion. Do not "solve" it by making the header conditional again.
//
// Those are SEPARATE bounded stores and none governs the others: the gateway's
// correlation registry lives in the gateway process under a 60 s TTL with 32-per-key
// and 128-global caps, while this plugin owns two independent OpenCode-process maps
// with no time-based expiry at all — `sessions` (256-entry insertion-order) and
// `metaCache` (a separate 256-entry insertion-order map). Reasoning about one from
// another's limits is a mistake.
//
// Design constraints (see AGENTS.md / .agent/instructions/security.md):
//   * Best-effort and NON-BLOCKING: every hook catches all failures and never
//     throws or alerts. `chat.headers` performs NO unbounded work — the header is
//     written synchronously, and the title check that follows reads in-memory
//     session metadata captured from `session.created`/`session.updated` lifecycle
//     events (zero async in the normal case); only when a session has not yet been
//     observed does it fall back to a SMALL, bounded `session.get()` that fails
//     open (arms nothing, keeps the header) on timeout. It therefore adds at most a
//     bounded delay to the foreground request, never an indefinite one.
//   * Atomic arming: the uncached fallback first inserts a `pending` RESERVATION
//     synchronously (before awaiting `session.get()`), so two concurrent hooks for
//     the same session issue ONE lookup and arm ONCE (both still get the header); a
//     failed/ineligible lookup releases the reservation so a later request may retry.
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
// (this file imports no `opencode` package). The `session.created`/`.updated`/
// `.deleted` events carry the full session `info` (`id`, `parentID`, `title`). The
// types are fully injectable so tests can fake them.
//
// PROVIDER SHAPE — the `chat.headers` hook receives a provider whose id location
// DIFFERS between the SDK type declaration and the OpenCode runtime:
//   * SDK-DECLARED (`@opencode-ai/plugin` `ProviderContext`, `@opencode-ai/sdk`
//     `Provider`): NESTED — the provider id is at `provider.info.id`.
//   * OpenCode v1.18.20 RUNTIME: FLAT — it passes a `Provider.Info` directly, so
//     the provider id is at `provider.id` (see the upstream type/runtime mismatch,
//     opencode issue #20562 and `session/llm/request.ts`). The installed type
//     declarations lag the runtime and describe only the nested shape.
// `readProviderId` (below) tolerates BOTH: a flat own `id` is authoritative when
// present; only when it is absent does it fall back to the nested `info.id`. It
// reads own data-property descriptors only and never invokes accessors.

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
 * `chat.headers` hook input (subset): the session id, the resolved `agent` name,
 * and the provider whose id (e.g. `collectiviq`) is read structurally by
 * `readProviderId`. The provider is typed `unknown` because its shape differs
 * between the SDK declaration (nested `provider.info.id`) and the OpenCode
 * v1.18.20 runtime (flat `provider.id`); both are tolerated. It is never accessed
 * by property — only via own data-property descriptors — so no getter is invoked.
 */
export interface ChatHeadersInput {
  sessionID: string;
  agent?: string;
  provider?: unknown;
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

/**
 * A fully resolved connection to the gateway's session-title extension: the base
 * URL and the exact gateway key. Produced by a single bounded resolution; never
 * partial (both `baseURL` and `gatewayKey` are valid). The key is used only for the
 * in-flight poll fetch and is never stored in singleton/session/metadata state,
 * errors, or logs.
 */
export interface NativeTitleConnectionConfig {
  baseURL: string;
  gatewayKey: string;
}

/** Injectable seams for the core hooks factory. */
export interface NativeTitleDeps {
  client: TitleClient;
  fetchImpl: FetchLike;
  /** Abortable delay: resolves after `ms`, or early (clearing its timer) if `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * ONE bounded connection resolution: returns a complete `{ baseURL, gatewayKey }`
   * or `undefined` when either the base URL or a usable key is unavailable. Replaces
   * the former separate `resolveBaseURL`/`resolveGatewayKey` seams so the whole
   * lookup (including `client.config.get()`) sits behind a single timeout/
   * cancellation boundary.
   */
  resolveConnection: () =>
    Promise<NativeTitleConnectionConfig | undefined> | NativeTitleConnectionConfig | undefined;
  /** Returns a per-request timeout abort signal, or undefined for no bound. */
  makeTimeoutSignal?: (ms: number) => AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Constants (gateway contract + bounds + eligibility).
// ---------------------------------------------------------------------------

const SESSION_HEADER = "X-CollectivIQ-OpenCode-Session-ID";
const ENDPOINT_PATH = "/opencode/session-title";
const PROVIDER_ID = "collectiviq";
/** Only the intended primary foreground agent gets the header / arms propagation. */
const FOREGROUND_AGENT = "collectiviq-text";

// The gateway's accepted session-id shape, mirrored from
// `src/opencode/session-header.ts`: an opaque token of 1–128 bytes drawn from
// `[A-Za-z0-9_-]`. Every allowed character is single-byte UTF-8, so the 128
// CHARACTER bound is exactly the 128 BYTE bound the gateway enforces. Validating
// here keeps the plugin from ever sending a value the server would reject: with
// Phase 5A thread reuse enabled, a present-but-invalid header on an otherwise
// eligible request is a hard `400 invalid_opencode_session_id`, not a value the
// gateway quietly ignores.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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

// Bound on resolving the gateway connection (base URL + key) before polling. The
// production resolver may await `client.config.get()`, which can stall; this caps
// that wait so a poller task always settles (and settles promptly on deletion).
export const RESOLVE_TIMEOUT_MS = 1500;

// Maximum UTF-8 byte length of an accepted gateway key. Mirrors the server-side
// `GATEWAY_KEY_LIMITS.maxKeyBytes` (src/config/schema.ts) so the plugin never
// forwards a key the gateway would reject; gateway auth is EXACT-match, so a valid
// key is used verbatim (never trimmed/normalized).
const MAX_GATEWAY_KEY_BYTES = 8192;

// Rejects an unresolved OpenCode config placeholder (e.g. `{env:VAR}`/`{file:/p}`)
// that reached the plugin without substitution — such a value is not a usable key
// or base URL.
const UNRESOLVED_PLACEHOLDER_RE = /\{(?:env|file):[^}]*\}/;

// OpenCode session-title display bound (Unicode code points).
const TITLE_MAX_CODE_POINTS = 100;
const TITLE_KEEP_CODE_POINTS = 97; // + "..." == 100

// Bounded plugin state. Both maps are INSERTION-ORDER, not LRU: eviction removes the
// oldest INSERTED key (`keys().next().value`), and access does not refresh insertion
// order — `chat.headers` returns early on `sessions.has(...)` so it never re-inserts,
// and `Map.set` on an existing key keeps that key's original position, so
// `rememberMeta` does not reorder either. A frequently used old session can therefore
// be evicted after 256 newer insertions; do not describe these as "the 256 most
// recent sessions".
//
// These bounds are what make every "one title workflow" statement about this plugin a
// claim about a RETAINED entry rather than about a session's whole lifetime: once
// `sessions` is full, `rememberSession` evicts (and cancels) the oldest inserted
// entry, and a later matching request for that session may arm and poll AGAIN.
// Whether it does depends on the metadata it then reads — updated non-default
// metadata blocks rearming, stale cached default metadata may permit one more bounded
// workflow — and an overwrite is prevented at the END by the rename-side current-title
// recheck, not by the arming gate. This is pre-existing, bounded, and intentional; the
// two maps are independent of each other and of the GATEWAY's correlation registry and
// its separate 60 s TTL.
const MAX_SESSIONS = 256;
const MAX_META = 256;

// ---------------------------------------------------------------------------
// Per-session state.
// ---------------------------------------------------------------------------

/**
 * State for a tracked session. This map tracks NATIVE-TITLE propagation only; it
 * never gates the session header, which every matching request receives. An entry
 * is retained until the session is deleted or insertion-order eviction reclaims it
 * (the oldest inserted entry goes first, regardless of how recently it was used),
 * and every "already armed / already polling" guarantee below is scoped to that
 * retention.
 *
 * A `chat.headers` fallback lookup first inserts a `pending` RESERVATION
 * (atomically, before it awaits `session.get()`) so a concurrent hook for the same
 * session cannot also lookup/arm. A successful, eligible lookup transitions the
 * SAME reservation to `armed`; a failed, timed-out, ineligible, or cancelled lookup
 * releases it so a later request may retry. The cached path inserts an `armed`
 * entry directly (fully synchronous, no race). Both states share the one bounded
 * `sessions` map, preserving the 256 bound.
 */
export interface SessionEntry {
  /** `pending` = arming reservation in flight; `armed` = eligible for title propagation. */
  status: "pending" | "armed";
  /** A poller has already been started for THIS entry (one per retained entry). */
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

/**
 * The own DATA-property value at `key` when it is a string, else undefined.
 * Inspects ONLY the own property descriptor: an inherited property, an accessor
 * (getter/setter), a non-string value, or a descriptor/proxy trap failure all
 * yield undefined. No user code (getter/`toJSON`/iterator) is ever invoked.
 */
function ownDataString(obj: object, key: string): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return undefined; // hostile proxy trap → fail closed
  }
  if (!descriptor) return undefined; // absent or inherited-only
  if ("get" in descriptor || "set" in descriptor) return undefined; // accessor → never invoke
  return typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/**
 * Descriptor-safe provider-id reader tolerating BOTH provider shapes (see the
 * PROVIDER SHAPE note at the top of the file):
 *   1. A flat own `id` property is AUTHORITATIVE when present — its string data
 *      value is returned; an accessor or non-string flat `id` fails closed and
 *      does NOT fall back to the nested shape.
 *   2. Only when a flat `id` property is ABSENT is the own data-property `info`
 *      inspected, then its own data-property `id` (string only).
 * Inherited properties are ignored, accessors/hooks are never invoked, and any
 * descriptor/proxy failure returns undefined. This function never throws.
 */
function readProviderId(provider: unknown): string | undefined {
  try {
    if (typeof provider !== "object" || provider === null) return undefined;

    // 1. Flat shape: an own `id` property, when present, is authoritative.
    let flat: PropertyDescriptor | undefined;
    try {
      flat = Object.getOwnPropertyDescriptor(provider, "id");
    } catch {
      return undefined;
    }
    if (flat) {
      if ("get" in flat || "set" in flat) return undefined; // accessor → fail closed, no fallback
      return typeof flat.value === "string" ? flat.value : undefined;
    }

    // 2. Nested shape: only reached when there is no own flat `id`.
    let infoDesc: PropertyDescriptor | undefined;
    try {
      infoDesc = Object.getOwnPropertyDescriptor(provider, "info");
    } catch {
      return undefined;
    }
    if (!infoDesc || "get" in infoDesc || "set" in infoDesc) return undefined;
    const info: unknown = infoDesc.value;
    if (typeof info !== "object" || info === null) return undefined;
    return ownDataString(info, "id");
  } catch {
    return undefined; // belt-and-braces: never throw out of the reader
  }
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

/**
 * The own DATA-property object value at `key`, else undefined. Descriptor-safe:
 * inspects only the own property descriptor, ignores inherited/accessor properties,
 * and fails closed on a throwing proxy trap. No getter/hook is ever invoked.
 */
function ownDataObject(obj: unknown, key: string): object | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return undefined; // hostile proxy trap → fail closed
  }
  if (!descriptor) return undefined; // absent or inherited-only
  if ("get" in descriptor || "set" in descriptor) return undefined; // accessor → never invoke
  const value: unknown = descriptor.value;
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * Descriptor-safe read of `config.provider.collectiviq.options.{baseURL,apiKey}`.
 * Uses own data-property descriptors at every level (never bracket access, `in`, or
 * a getter), so accessors, inherited members, and throwing proxies are treated as
 * absent. Returns raw strings (or undefined); validation happens in the caller.
 */
function pickProviderOptions(config: unknown): {
  baseURL: string | undefined;
  apiKey: string | undefined;
} {
  const provider = ownDataObject(config, "provider");
  const collectiviq = ownDataObject(provider, PROVIDER_ID);
  const options = ownDataObject(collectiviq, "options");
  if (!options) return { baseURL: undefined, apiKey: undefined };
  return { baseURL: ownDataString(options, "baseURL"), apiKey: ownDataString(options, "apiKey") };
}

/** UTF-8 byte length (not code points / not chars). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * A usable gateway key: a non-empty string with no unresolved config placeholder
 * and at most `MAX_GATEWAY_KEY_BYTES` UTF-8 bytes. Returned EXACTLY (never trimmed
 * or normalized) because gateway authentication is exact-match. Otherwise undefined.
 */
function usableKey(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (UNRESOLVED_PLACEHOLDER_RE.test(value)) return undefined;
  if (utf8ByteLength(value) > MAX_GATEWAY_KEY_BYTES) return undefined;
  return value;
}

/** A usable base URL: a non-empty string with no unresolved config placeholder. */
function usableBaseURL(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (UNRESOLVED_PLACEHOLDER_RE.test(value)) return undefined;
  return value;
}

/**
 * Lazy, injectable reader for the fallback gateway credential. Returns the raw
 * candidate (or `undefined`); validation is applied by the caller. It is invoked
 * ONLY when a usable base URL exists but provider config has no usable key, so the
 * environment is never inspected on the provider-config or no-base-URL paths.
 */
export type ReadGatewayKey = () => string | undefined;

/** Sources consulted by {@link resolveConnectionConfig}. */
export interface ConnectionSources {
  /** OpenCode's merged SDK config (`client.config.get()` result), preferred. */
  merged?: unknown;
  /** Embedded plugin-input config (`input.config`), compatibility fallback. */
  embedded?: unknown;
  /**
   * Lazy fallback reader for `COLLECTIVIQ_GATEWAY_KEY`. Invoked at most once, and
   * only when a usable base URL exists but no usable provider-config key does, so
   * the environment is never evaluated on the provider-config or no-base-URL paths.
   * A throwing reader is caught and treated as an absent fallback.
   */
  readEnvKey?: ReadGatewayKey | undefined;
}

/**
 * Pure connection resolution with deterministic precedence and no direct I/O:
 *   base URL  = merged provider config → embedded provider config
 *   key       = merged provider `apiKey` → embedded provider `apiKey` → env fallback
 * Provider-config keys always win over the environment fallback. The lazy
 * `readEnvKey` reader is consulted ONLY when a usable base URL exists but no usable
 * provider-config key does — never when a provider key already resolves and never
 * when the base URL is missing (no complete connection is possible either way) — and
 * at most once. A throwing reader fails open. Returns a complete connection only
 * when BOTH a valid base URL and a usable key are available (never partial);
 * otherwise undefined. Never throws.
 */
export function resolveConnectionConfig(
  sources: ConnectionSources,
): NativeTitleConnectionConfig | undefined {
  const merged = pickProviderOptions(sources.merged);
  const embedded = pickProviderOptions(sources.embedded);
  const baseURL = usableBaseURL(merged.baseURL) ?? usableBaseURL(embedded.baseURL);
  const providerKey = usableKey(merged.apiKey) ?? usableKey(embedded.apiKey);
  if (providerKey) {
    // Provider config is complete on its own: never consult the environment.
    if (!baseURL) return undefined;
    return { baseURL, gatewayKey: providerKey };
  }
  // No usable base URL means no complete connection is possible: skip the fallback.
  if (!baseURL) return undefined;
  let rawEnvKey: string | undefined;
  try {
    rawEnvKey = sources.readEnvKey?.(); // AT MOST ONCE, fallback path only
  } catch {
    rawEnvKey = undefined; // fail open: a throwing reader is an absent fallback
  }
  const envKey = usableKey(rawEnvKey);
  if (!envKey) return undefined;
  return { baseURL, gatewayKey: envKey };
}

/**
 * Production connection resolver. Reads the embedded `input.config` and calls
 * `client.config.get()` AT MOST ONCE for OpenCode's merged config, then applies the
 * pure precedence in {@link resolveConnectionConfig}. Fails open (undefined) and
 * never throws. The base URL and the gateway key both come from the resolved
 * CollectivIQ provider — `provider.collectiviq.options.{baseURL,apiKey}` — so no
 * separate terminal `COLLECTIVIQ_GATEWAY_KEY` export is required when OpenCode has
 * already resolved a working provider credential; the env var is only a fallback.
 *
 * The fallback reader is REQUIRED and injected (no default that reads
 * `process.env`), so unit tests supply a synthetic reader and can never touch the
 * real credential environment. The reader is invoked lazily by
 * {@link resolveConnectionConfig} — at most once, and only on the fallback path.
 */
export async function defaultResolveConnection(
  input: PluginInput,
  readEnvKey: ReadGatewayKey,
): Promise<NativeTitleConnectionConfig | undefined> {
  const anyInput = input as unknown as Record<string, unknown>;
  const embedded = ownDataObject(anyInput, "config");
  let merged: unknown;
  try {
    const client = anyInput["client"] as { config?: { get?: () => Promise<unknown> } } | undefined;
    if (client?.config?.get) {
      const res = await client.config.get(); // AT MOST ONCE per resolution
      merged = ownDataObject(res, "data") ?? res; // unwrap a `{ data }` envelope, else raw
    }
  } catch {
    merged = undefined; // fail open: no merged config
  }
  return resolveConnectionConfig({ merged, embedded, readEnvKey });
}

// ---------------------------------------------------------------------------
// Core hooks factory (fully injectable / fakeable).
// ---------------------------------------------------------------------------

export function createNativeTitleHooks(deps: NativeTitleDeps): NativeTitleHooks {
  const { client, fetchImpl, sleep, resolveConnection } = deps;
  const makeTimeoutSignal = deps.makeTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  // Armed sessions (with a poller + cancellation). Exposed to tests as `$state`.
  const sessions = new Map<string, SessionEntry>();
  // Session metadata captured from lifecycle events (parentID + title).
  const metaCache = new Map<string, SessionMeta>();
  const activePolls = new Set<Promise<void>>();

  /**
   * Insert an armed entry, evicting (and cancelling) the OLDEST INSERTED entry when
   * at capacity. Insertion-order, not LRU: an existing key is never re-inserted, so
   * using a session does not protect it from eviction.
   */
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

  /**
   * Cache session metadata, evicting the OLDEST INSERTED key when at capacity (no
   * cancellation needed). Also insertion-order: updating an existing key replaces its
   * value but keeps its original position, so refreshed metadata is not "recent".
   */
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

  /**
   * Apply the provider title, but only if the session is STILL on the exact title
   * captured at arm time.
   *
   * This rename-side current-title recheck — not the arming gate — is the real
   * overwrite protection. Arming reads possibly stale cached metadata, so a session
   * whose title already changed can still reach this point after an eviction and
   * re-arm; reading the LIVE title here and comparing it to `initialTitle` is what
   * refuses to clobber a manual or already-propagated title.
   */
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
    // Guard against a manual rename, another integration, or an earlier propagation
    // this workflow could not see when it armed from cached metadata.
    const titleStillDefault = current.title === initialTitle;
    const normalized = normalizeTitle(providerTitle);
    if (!titleStillDefault) return;
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
   * Bounded, lifecycle-aware CONNECTION resolution (base URL + gateway key). The
   * production `resolveConnection` may await `client.config.get()`, which can stall
   * indefinitely; this races the WHOLE lookup against a single small timeout AND the
   * session's cancellation signal, so the poller NEVER awaits it permanently and
   * settles PROMPTLY on deletion/eviction. A timeout, cancellation, rejection, or a
   * partial/malformed result yields `undefined` (stop). The underlying resolver
   * promise is detached and swallowed — it is not physically cancelled (the API
   * offers no signal); the plugin simply stops awaiting it and does no further work.
   */
  async function resolveConnectionBounded(
    signal: AbortSignal,
  ): Promise<NativeTitleConnectionConfig | undefined> {
    if (signal.aborted) return undefined;
    const sleepAbort = new AbortController();
    const waitSignal = composeSignals(sleepAbort.signal, signal);
    const resolveP = Promise.resolve()
      .then(() => resolveConnection())
      .then((c) =>
        c &&
        typeof c.baseURL === "string" &&
        c.baseURL.length > 0 &&
        typeof c.gatewayKey === "string" &&
        c.gatewayKey.length > 0
          ? c
          : undefined,
      )
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
    // Resolve the connection under a single lifecycle-bounded race BEFORE any
    // polling, so a stalled resolver cannot leave this task permanently unsettled.
    const connection = await resolveConnectionBounded(signal);
    if (signal.aborted) return;
    if (!connection) return; // Fail open: no complete connection → do nothing.
    // The resolved key stays LOCAL to this poll operation — never stored in
    // singleton/session/metadata state, errors, or logs.
    const { baseURL, gatewayKey: key } = connection;

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
      // Shared gates. They decide BOTH responsibilities: a request that fails any
      // of them gets no header and never consumes the session's pending arming
      // opportunity (and never triggers a session lookup).
      if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return;
      if (input.agent !== FOREGROUND_AGENT) return;
      // Provider gate — tolerant of the flat runtime shape (`provider.id`) and the
      // nested SDK shape (`provider.info.id`); descriptor-safe, never invokes a
      // getter, and fails closed on anything else.
      if (readProviderId(input.provider) !== PROVIDER_ID) return;

      // RESPONSIBILITY 1 — session identity, on EVERY matching request. Written
      // first and unconditionally: the gateway needs it on every turn to keep an
      // eligible session on one CollectivIQ thread (specification §5.1.1), so it
      // must not depend on title state or on the bounded lookup below, either of
      // which may legitimately decline or time out.
      output.headers[SESSION_HEADER] = sessionId;

      // RESPONSIBILITY 2 — native-title arming, one workflow per retained entry.
      // Everything from here down only decides whether THIS session's title
      // workflow starts; it never withdraws the header written above.
      //
      // Already reserved (pending) or armed — do not lookup/arm/replace again while
      // that entry is retained. After insertion-order eviction (or deletion) this
      // check no longer matches, and a later request may arm again: updated
      // non-default metadata blocks it below, while stale cached default metadata
      // permits one more bounded workflow whose rename is then refused by the
      // rename-side current-title recheck.
      if (sessions.has(sessionId)) return;

      // Cached path: fully synchronous, so two concurrent hooks cannot race — the
      // first inserts the armed entry before the second reaches the `has` check.
      // An ineligible session (child, manual/already-propagated title) simply arms
      // nothing; it keeps its header and stays cheap to re-check on every turn.
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
        }
        return;
      }

      // Uncached path: reserve SYNCHRONOUSLY (before the first await) so a
      // concurrent eligible hook sees the reservation via `sessions.has` and
      // returns without a second `session.get()` or a second arm. The reservation
      // carries the lifecycle cancel used to abort the lookup and (later) the
      // poller.
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
          // eligible request may retry this session. The header stays attached:
          // the request is still this session's turn regardless of its title.
          releaseIfCurrent();
          return;
        }
        // Transition the SAME reservation to armed. The header was already written.
        reservation.status = "armed";
        reservation.initialTitle = title;
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
        // reservation is skipped, and at most one poller runs per RETAINED entry
        // (an evicted/re-armed session gets a fresh entry and may poll again).
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

// ---------------------------------------------------------------------------
// Process-wide singleton (idempotent duplicate-load).
// ---------------------------------------------------------------------------
//
// The committed plugin is discovered project-locally (`.opencode/plugins/`), but
// operators may ALSO install it globally for cross-project use via a symlink under
// `~/.config/opencode/plugins/` (see README). When the gateway repository is the
// active project, OpenCode discovers BOTH paths and initializes the plugin twice
// in the SAME process. To keep that harmless, the default plugin shares ONE hooks
// instance across duplicate initialization — and therefore ONE state map, so both
// loads observe the same retained entries and cannot each arm, poll, or rename the
// same session concurrently (the per-entry scoping described at MAX_SESSIONS still
// applies; sharing removes duplication, it does not add a lifetime guarantee),
// keyed on a stable `Symbol.for(...)` slot on `globalThis`. First initialization
// wins and creates the hooks (lazily, so the second load's `input`/deps are never
// used); later initialization returns the same instance. Process exit remains the
// lifetime boundary. `createNativeTitleHooks` stays the isolated per-call factory
// used by unit tests; only THIS default wrapper shares an instance.

/** Stable global slot for the shared hooks instance. */
export const SHARED_HOOKS_KEY: symbol = Symbol.for("collectiviq.native-title.hooks.v1");

/**
 * Narrow, injectable registry seam. The default is backed by `globalThis`; tests
 * inject a plain `Map`-backed registry so they never pollute real global state.
 */
export interface HooksRegistry {
  get(key: symbol): NativeTitleHooks | undefined;
  set(key: symbol, value: NativeTitleHooks): void;
}

/** The `globalThis`-backed registry used by the default plugin. */
export function globalHooksRegistry(): HooksRegistry {
  const store = globalThis as unknown as Record<symbol, NativeTitleHooks | undefined>;
  return {
    get: (key) => store[key],
    set: (key, value) => {
      store[key] = value;
    },
  };
}

/**
 * Return the process-shared hooks, creating them once via `createNativeTitleHooks`
 * on first initialization and returning the same instance thereafter. `makeDeps`
 * is invoked ONLY on first creation (first-registration-wins). The `registry` and
 * `key` seams are injectable for hermetic tests.
 */
export function getOrCreateSharedHooks(
  makeDeps: () => NativeTitleDeps,
  registry: HooksRegistry = globalHooksRegistry(),
  key: symbol = SHARED_HOOKS_KEY,
): NativeTitleHooks {
  const existing = registry.get(key);
  if (existing) return existing;
  const created = createNativeTitleHooks(makeDeps());
  registry.set(key, created);
  return created;
}

const CollectivIQNativeTitlePlugin: Plugin = (input: PluginInput) => {
  return Promise.resolve(
    getOrCreateSharedHooks(() => ({
      client: input.client,
      fetchImpl: globalThis.fetch,
      sleep: realSleep,
      // One bounded resolution: base URL + gateway key from the resolved
      // CollectivIQ provider config, with COLLECTIVIQ_GATEWAY_KEY as a LAZY
      // fallback. This closure is the ONLY place in the plugin that reads the
      // credential environment variable, and it stays unevaluated until the
      // fallback path actually needs it.
      resolveConnection: () =>
        defaultResolveConnection(input, () => process.env["COLLECTIVIQ_GATEWAY_KEY"]),
    })),
  );
};

// ---------------------------------------------------------------------------
// V1 default plugin module — LOAD-BEARING export shape (do not revert).
// ---------------------------------------------------------------------------
//
// OpenCode's loader (1.18.21) resolves a plugin entry by FIRST trying to read a V1
// default plugin module shaped as `{ id: string, server: <plugin fn> }`
// (`readV1Plugin`). Only when the default is NOT that object does it fall through
// to the LEGACY path, which scans the module's runtime exports and rejects the
// first non-function with `error="Plugin export is not a function"`.
//
// This module intentionally exposes named runtime helpers/constants that unit
// tests rely on (`UPDATE_TIMEOUT_MS`, `RESOLVE_TIMEOUT_MS`, `SHARED_HOOKS_KEY`,
// `normalizeTitle`, `createNativeTitleHooks`, `globalHooksRegistry`,
// `getOrCreateSharedHooks`, …). Several of those are NOT functions, so a bare
// FUNCTION default (the earlier shape) fell through to the legacy scan and OpenCode
// rejected the module with `Plugin export is not a function` — the plugin never
// loaded at all (confirmed 2026-08-21 for both the global-symlink and project-local
// paths), so none of the arming/header/poll/rename logic ever ran.
//
// Therefore the default export MUST remain the V1 `{ id, server }` object below so
// OpenCode invokes ONLY `default.server` and never enters the legacy export scan.
// Do NOT revert this to a bare function, and do NOT migrate to the V2 `setup` API.

/** Stable plugin id advertised in the V1 default module. */
export const PLUGIN_ID = "collectiviq-native-title";

/**
 * Narrow local structural type for OpenCode's V1 default plugin module. Declared
 * locally so this file adds no `@opencode-ai/*` runtime dependency.
 */
export interface V1PluginModule {
  id: string;
  server: Plugin;
}

/** The V1 default module OpenCode's `readV1Plugin` recognizes (bypasses legacy scan). */
const nativeTitleV1Module: V1PluginModule = {
  id: PLUGIN_ID,
  server: CollectivIQNativeTitlePlugin,
};

export { CollectivIQNativeTitlePlugin };
export default nativeTitleV1Module;
