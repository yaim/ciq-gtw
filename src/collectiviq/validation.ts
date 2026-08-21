/**
 * Upstream response validators (mixed-evidence contract).
 *
 * The source OpenAPI document declares empty (`{}`) success schemas for every
 * core operation, so no shape here is upstream-*guaranteed*; each validator is
 * the gateway's own minimal contract and ignores unknown fields. The evidence
 * behind each rule now varies, so the shapes are no longer uniformly
 * provisional:
 *   - Safe field names and statuses that repeated identically across the two
 *     2026-08-11 authorized password baselines are verified-repeatable and are
 *     encoded as synthetic fixtures (e.g. the `create_time` metadata key and the
 *     `process_message` `202` shape).
 *   - Mappings whose observed field NAME stayed masked by structural capture
 *     (notably message `content`), and any field meaning/semantics, remain
 *     provisional.
 * The minimal success *rules* below (e.g. "an object without an own `detail`")
 * are gateway-owned working rules, not provider guarantees.
 *
 * Validators never surface upstream content: on failure they throw a
 * normalized {@link UpstreamError} with no body, message, or field values.
 */
import { UpstreamError } from "./errors.js";
import {
  MAX_NATIVE_TITLE_BYTES,
  type CreateThreadResult,
  type GetMessagesResult,
  type GetThreadTitleResult,
  type ProcessMessageResult,
  type UpstreamMessage,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fixed placeholder the gateway sends on `create_thread`; a still-`New Thread` title means the provider has not renamed the thread yet. */
const PLACEHOLDER_TITLE = "New Thread";

/**
 * Read an own DATA property's value without invoking any accessor. Returns
 * `undefined` when the key is absent OR is an accessor (getter) property, so a
 * hostile getter is never called during title normalization.
 */
function ownDataValue(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * True when the string contains any C0 (0x00–0x1F) or C1 (0x7F–0x9F) control
 * code point, or a Unicode line separator (`U+2028`) or paragraph separator
 * (`U+2029`). All of these break the single-line title contract.
 */
function hasControlOrLineSeparator(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * `create_thread`: require a top-level object with a `thread_id` that is either
 * a positive integer or a non-empty string; normalize it to a string.
 */
export function normalizeCreateThread(json: unknown, rawStatus: number): CreateThreadResult {
  if (!isRecord(json)) throw new UpstreamError("upstream_protocol", rawStatus);
  const threadId = json["thread_id"];
  if (typeof threadId === "number") {
    if (!Number.isInteger(threadId) || threadId <= 0) {
      throw new UpstreamError("upstream_protocol", rawStatus);
    }
    return { threadId: String(threadId), rawStatus };
  }
  if (typeof threadId === "string" && threadId.trim() !== "") {
    return { threadId, rawStatus };
  }
  throw new UpstreamError("upstream_protocol", rawStatus);
}

/**
 * `process_message`: require a top-level object. The presence of an OWN `detail`
 * property means the upstream signalled an error even on HTTP 2xx, so it is NOT
 * success — regardless of the property's value (`null`, `undefined`, empty
 * string, object, or array all count as failure). The raw value is never read
 * or exposed. Unknown fields are otherwise ignored.
 */
export function normalizeProcessMessage(json: unknown, rawStatus: number): ProcessMessageResult {
  if (!isRecord(json)) throw new UpstreamError("upstream_protocol", rawStatus);
  if (Object.hasOwn(json, "detail")) {
    // Upstream-reported failure; never expose `detail` content. `process_message`
    // is not auto-retried, so this is a terminal unexpected upstream failure.
    throw new UpstreamError("unexpected_upstream", rawStatus);
  }
  return { accepted: true, rawStatus };
}

/** Normalize one message entry; returns null when the entry is not an object. */
function normalizeMessage(raw: unknown): UpstreamMessage | null {
  if (!isRecord(raw)) return null;
  const source = raw["source"];
  if (typeof source !== "string" || source === "") return null;

  const rawContent = raw["content"];
  let content: string | null;
  if (rawContent === undefined || rawContent === null) content = null;
  else if (typeof rawContent === "string") content = rawContent;
  else return null;

  const rawPercent = raw["percent_usage"];
  let percentUsage: number | null;
  if (rawPercent === undefined || rawPercent === null) percentUsage = null;
  else if (typeof rawPercent === "number" && Number.isFinite(rawPercent)) percentUsage = rawPercent;
  else return null;

  // Creation-time metadata for the future selection policy. The 2026-08-11
  // authorized password baselines (two verified-repeatable runs) observed the
  // field name `create_time`, not the earlier provisional `created_at`; the
  // provisional `created_at` is retained as a fallback so the mapping stays
  // forward/backward compatible and no synthetic fixture regresses. A separate
  // `updated_at` was also observed but is intentionally not mapped here (its
  // selection semantics are unverified). Absent values normalize to null.
  const rawCreatedAt = Object.hasOwn(raw, "create_time") ? raw["create_time"] : raw["created_at"];
  let createdAt: string | number | null;
  if (rawCreatedAt === undefined || rawCreatedAt === null) createdAt = null;
  else if (typeof rawCreatedAt === "string") createdAt = rawCreatedAt;
  else if (typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt))
    createdAt = rawCreatedAt;
  else return null;

  const rawId = raw["id"];
  let id: string | number | null;
  if (rawId === undefined || rawId === null) id = null;
  else if (typeof rawId === "string") id = rawId;
  else if (typeof rawId === "number" && Number.isFinite(rawId)) id = rawId;
  else return null;

  return { source, content, percentUsage, createdAt, id };
}

/**
 * `get_messages`: require a top-level object with a `messages` array. Every
 * element must be a well-formed message; a malformed element makes the whole
 * response an upstream protocol error (deterministic, no partial guessing).
 */
export function normalizeGetMessages(json: unknown, rawStatus: number): GetMessagesResult {
  if (!isRecord(json)) throw new UpstreamError("upstream_protocol", rawStatus);
  const rawMessages = json["messages"];
  if (!Array.isArray(rawMessages)) throw new UpstreamError("upstream_protocol", rawStatus);

  const messages: UpstreamMessage[] = [];
  for (const entry of rawMessages) {
    const normalized = normalizeMessage(entry);
    if (normalized === null) throw new UpstreamError("upstream_protocol", rawStatus);
    messages.push(normalized);
  }
  return { messages, rawStatus };
}

/**
 * `get_threads` (OBSERVED-ONLY native-title lookup): extract ONLY the target
 * thread's server-generated title. This never enumerates, retains, serializes, or
 * logs unrelated thread entries — it inspects exactly the one own data-property
 * keyed by `targetThreadId`.
 *
 * Contract (all reads are own DATA descriptors; accessors are never invoked):
 *   - require a top-level object with no own upstream-error `detail` property;
 *   - require an own `threads` value that is a non-null, non-array object;
 *   - the target entry is looked up by exact own key; ABSENT ⇒ `pending`;
 *   - the target entry must be a non-null, non-array object with an own `title`
 *     value (otherwise a normalized validation error — never a leaked value);
 *   - a `title` still equal (trimmed) to the fixed `New Thread` placeholder ⇒
 *     `pending` (the provider has not renamed the thread yet);
 *   - a READY title must be a string that trims to non-empty, single-line, free of
 *     C0/C1 control characters and Unicode line/paragraph separators
 *     (`U+2028`/`U+2029`), and ≤ {@link MAX_NATIVE_TITLE_BYTES} UTF-8 bytes;
 *     any violation is a normalized validation error;
 *   - unknown fields are ignored.
 *
 * On any malformed structure it throws {@link UpstreamError}('upstream_protocol')
 * with no body, message, title, or identifier — the raw upstream value never
 * escapes. The returned ready title is the trimmed provider value; display-length
 * truncation is a separate downstream concern.
 */
export function normalizeGetThreadTitle(
  json: unknown,
  rawStatus: number,
  targetThreadId: string,
): GetThreadTitleResult {
  if (!isRecord(json)) throw new UpstreamError("upstream_protocol", rawStatus);
  // An own `detail` marks an upstream-reported error even on HTTP 2xx.
  if (Object.hasOwn(json, "detail")) throw new UpstreamError("unexpected_upstream", rawStatus);

  const threads = ownDataValue(json, "threads");
  if (!isRecord(threads)) throw new UpstreamError("upstream_protocol", rawStatus);

  // Inspect ONLY the exact own property matching the normalized target id.
  if (!Object.hasOwn(threads, targetThreadId)) return { kind: "pending" };
  const entry = ownDataValue(threads, targetThreadId);
  if (!isRecord(entry)) throw new UpstreamError("upstream_protocol", rawStatus);

  if (!Object.hasOwn(entry, "title")) throw new UpstreamError("upstream_protocol", rawStatus);
  const rawTitle = ownDataValue(entry, "title");
  if (typeof rawTitle !== "string") throw new UpstreamError("upstream_protocol", rawStatus);

  const title = rawTitle.trim();
  // Still the fixed placeholder (in any surrounding whitespace) ⇒ not yet renamed.
  if (title === PLACEHOLDER_TITLE) return { kind: "pending" };
  if (title === "") throw new UpstreamError("upstream_protocol", rawStatus);
  if (hasControlOrLineSeparator(title)) throw new UpstreamError("upstream_protocol", rawStatus);
  if (Buffer.byteLength(title, "utf8") > MAX_NATIVE_TITLE_BYTES) {
    throw new UpstreamError("upstream_protocol", rawStatus);
  }
  return { kind: "ready", title };
}
