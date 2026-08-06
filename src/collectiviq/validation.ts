/**
 * PROVISIONAL upstream response validators.
 *
 * The source OpenAPI document declares empty (`{}`) success schemas for every
 * core operation, so none of these shapes are upstream-guaranteed. Each
 * validator enforces the minimal contract the gateway needs and ignores
 * unknown fields. They must stay visibly labeled provisional until live
 * discovery produces sanitized fixtures that confirm them.
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

  // Provisional metadata for the future selection policy; upstream key names
  // are unverified. Absent values normalize to null.
  const rawCreatedAt = raw["created_at"];
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
