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
import type {
  CreateThreadResult,
  GetMessagesResult,
  ProcessMessageResult,
  UpstreamMessage,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
