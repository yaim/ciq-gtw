/**
 * OpenAI message normalization (specification sections 8.2, 8.4, 9.4.4).
 *
 * Converts one raw request message into a normalized {@link NormalizedMessage},
 * or a value-free OpenAI rejection envelope. Behaviour is MODEL-POLICY-AWARE via
 * `allowTools`: a text-only (`disabled`/`native`) model rejects tool-role
 * messages and assistant `tool_calls` exactly as before; an emulated model parses
 * them into normalized prior-tool-call / tool-result fields (their deeper
 * linkage/schema validation happens in the tool request normalizer). No submitted
 * value ever appears in a returned error — `param` is only the static field name
 * `"messages"`.
 */
import type { NormalizedMessage, NormalizedRole } from "./chat-types.js";
import { NORMALIZED_ROLES } from "./chat-types.js";
import type { NormalizedPriorToolCall } from "../tools/types.js";
import { MAX_TOOL_CALLS_PER_RESPONSE } from "../tools/limits.js";
import { invalidRequest, UNSUPPORTED_CONTENT_TYPE_ERROR, type OpenAIApiError } from "./errors.js";

/** Conservative initial safety bound on text content parts per message. */
export const MAX_TEXT_PARTS_PER_MESSAGE = 256;

/**
 * Maximum tool calls in one assistant `tool_calls` history message. This is the
 * SAME bound the protocol parser enforces on a freshly generated response
 * ({@link MAX_TOOL_CALLS_PER_RESPONSE} = 8): a prior assistant turn can carry no
 * more calls than the gateway would ever emit, so there is one shared ceiling
 * rather than a separate, larger history limit.
 */
export const MAX_TOOL_CALLS_PER_MESSAGE = MAX_TOOL_CALLS_PER_RESPONSE;

/** The outcome of normalizing one message. */
export type MessageResult =
  | { readonly ok: true; readonly message: NormalizedMessage }
  | { readonly ok: false; readonly error: OpenAIApiError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Exclude<NormalizedRole, "tool"> {
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

/** Normalize a string / text-parts content body into a string, or an error. */
function normalizeTextContent(content: unknown): OpenAIApiError | string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return normalizeContentParts(content);
  return invalidRequest("A message content is invalid.", "messages");
}

/**
 * Parse an assistant `tool_calls` array (emulated mode). Each entry must be
 * `{ id, type?: "function", function: { name, arguments } }` with a non-empty
 * string `id`, a non-empty string function `name`, and a string `arguments`
 * (the JSON-string argument form). Structural only; schema validation and id
 * linkage happen later against the compiled toolset.
 */
function normalizeToolCalls(raw: unknown): OpenAIApiError | NormalizedPriorToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalidRequest("A message has invalid tool calls.", "messages");
  }
  if (raw.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    return invalidRequest("A message has too many tool calls.", "messages");
  }
  const calls: NormalizedPriorToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return invalidRequest("A message tool call is invalid.", "messages");
    const type = entry["type"];
    if (type !== undefined && type !== "function") {
      return invalidRequest("A message tool call is invalid.", "messages");
    }
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      return invalidRequest("A message tool call is invalid.", "messages");
    }
    const fn = entry["function"];
    if (!isRecord(fn)) return invalidRequest("A message tool call is invalid.", "messages");
    const name = fn["name"];
    if (typeof name !== "string" || name.length === 0) {
      return invalidRequest("A message tool call is invalid.", "messages");
    }
    const argumentsJson = fn["arguments"];
    if (typeof argumentsJson !== "string") {
      return invalidRequest("A message tool call is invalid.", "messages");
    }
    calls.push(Object.freeze({ id, name, argumentsJson }));
  }
  return calls;
}

/** Normalize a tool-result (`role: "tool"`) message (emulated mode). */
function normalizeToolResult(raw: Record<string, unknown>): MessageResult {
  const toolCallId = raw["tool_call_id"];
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return reject("A tool message is missing a tool_call_id.");
  }
  const content = normalizeTextContent(raw["content"]);
  if (typeof content !== "string") return { ok: false, error: content };
  return { ok: true, message: Object.freeze({ role: "tool", content, toolCallId }) };
}

/** Normalize an assistant message that proposed tool calls (emulated mode). */
function normalizeAssistantWithToolCalls(raw: Record<string, unknown>): MessageResult {
  const calls = normalizeToolCalls(raw["tool_calls"]);
  if (!Array.isArray(calls)) return { ok: false, error: calls };
  // Content is optional and may be null on a tool-call turn.
  const rawContent = raw["content"];
  let content: string | null;
  if (rawContent === null || rawContent === undefined) {
    content = null;
  } else {
    const normalized = normalizeTextContent(rawContent);
    if (typeof normalized !== "string") return { ok: false, error: normalized };
    content = normalized;
  }
  return {
    ok: true,
    message: Object.freeze({ role: "assistant", content, toolCalls: Object.freeze(calls) }),
  };
}

/**
 * Normalize one raw message. `allowTools` enables emulated-mode tool-role and
 * assistant `tool_calls` parsing; when false, tool metadata is rejected exactly
 * as the text-only surface always has. An optional `name` field is ignored.
 */
export function normalizeMessage(raw: unknown, allowTools: boolean): MessageResult {
  if (!isRecord(raw)) return reject("A message must be an object.");

  const role = raw["role"];

  // Tool-result role: only valid in emulated mode.
  if (role === "tool") {
    if (!allowTools) return reject("A message has an unsupported role.");
    return normalizeToolResult(raw);
  }

  if (!isRole(role)) return reject("A message has an unsupported role.");

  // Assistant `tool_calls`: rejected by PRESENCE for text-only models (even an
  // empty array / null / explicit undefined — the value is never read); parsed
  // for emulated models.
  if (Object.hasOwn(raw, "tool_calls")) {
    if (!allowTools) {
      return {
        ok: false,
        error: invalidRequest(
          "Assistant tool calls are not supported yet.",
          "messages",
          "unsupported_parameter",
        ),
      };
    }
    if (role !== "assistant") return reject("Only assistant messages may include tool calls.");
    return normalizeAssistantWithToolCalls(raw);
  }

  const content = normalizeTextContent(raw["content"]);
  if (typeof content !== "string") return { ok: false, error: content };
  return { ok: true, message: Object.freeze({ role, content }) };
}
