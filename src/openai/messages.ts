/**
 * OpenAI message normalization (specification sections 8.2, 8.4, 9.4.4).
 *
 * Converts one raw request message into a normalized, text-only
 * {@link NormalizedMessage}, or a value-free OpenAI rejection envelope. Only the
 * text-only roles are accepted; tool-role messages, assistant `tool_calls`, and
 * non-text content parts are rejected. No submitted value ever appears in a
 * returned error — `param` is only the static field name `"messages"`.
 */
import type { NormalizedMessage, NormalizedRole } from "./chat-types.js";
import { NORMALIZED_ROLES } from "./chat-types.js";
import { invalidRequest, UNSUPPORTED_CONTENT_TYPE_ERROR, type OpenAIApiError } from "./errors.js";

/** Conservative initial safety bound on text content parts per message. */
export const MAX_TEXT_PARTS_PER_MESSAGE = 256;

/** The outcome of normalizing one message. */
export type MessageResult =
  | { readonly ok: true; readonly message: NormalizedMessage }
  | { readonly ok: false; readonly error: OpenAIApiError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is NormalizedRole {
  return typeof value === "string" && (NORMALIZED_ROLES as readonly string[]).includes(value);
}

/** Reject; the message is content-free and never echoes a submitted value. */
function reject(message: string): MessageResult {
  return { ok: false, error: invalidRequest(message, "messages") };
}

/**
 * Flatten an array of content parts into a single string. Each part must be an
 * object `{ type: "text", text: <string> }`. A recognized non-text part type
 * (image/audio/file/…) yields the fixed `unsupported_content_type` envelope; any
 * other malformed part is a generic invalid-request. Parts are joined by `"\n"`.
 */
function normalizeContentParts(parts: readonly unknown[]): OpenAIApiError | string {
  if (parts.length > MAX_TEXT_PARTS_PER_MESSAGE) {
    return invalidRequest("A message has too many content parts.", "messages");
  }
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) {
      return invalidRequest("A message content part is invalid.", "messages");
    }
    const type = part["type"];
    if (type !== "text") {
      // A recognized modality (a string type other than "text") is an explicit
      // unsupported-content rejection; anything else is a generic invalid part.
      if (typeof type === "string") return UNSUPPORTED_CONTENT_TYPE_ERROR;
      return invalidRequest("A message content part is invalid.", "messages");
    }
    const text = part["text"];
    if (typeof text !== "string") {
      return invalidRequest("A message content part is invalid.", "messages");
    }
    texts.push(text);
  }
  return texts.join("\n");
}

/**
 * Normalize one raw message. Returns the normalized message or a value-free
 * OpenAI error. An optional `name` field is ignored (never used or rejected).
 */
export function normalizeMessage(raw: unknown): MessageResult {
  if (!isRecord(raw)) return reject("A message must be an object.");

  const role = raw["role"];
  if (!isRole(role)) return reject("A message has an unsupported role.");

  // Tool calls are a Phase 3 feature; the strict boundary rejects the own-property
  // PRESENCE of `tool_calls` — even an empty array, `null`, or explicit
  // `undefined` — never silently dropping it and never reading its value.
  if (Object.hasOwn(raw, "tool_calls")) {
    return {
      ok: false,
      error: invalidRequest(
        "Assistant tool calls are not supported yet.",
        "messages",
        "unsupported_parameter",
      ),
    };
  }

  const content = raw["content"];
  if (typeof content === "string") {
    return { ok: true, message: Object.freeze({ role, content }) };
  }
  if (Array.isArray(content)) {
    const flattened = normalizeContentParts(content);
    if (typeof flattened === "string") {
      return { ok: true, message: Object.freeze({ role, content: flattened }) };
    }
    return { ok: false, error: flattened };
  }
  return reject("A message content is invalid.");
}
