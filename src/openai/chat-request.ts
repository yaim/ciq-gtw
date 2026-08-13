/**
 * OpenAI Chat Completions request validation and normalization
 * (specification sections 8.2, 9.4). Produces an immutable
 * {@link NormalizedChatRequest} or a value-free OpenAI rejection envelope.
 *
 * The raw request object never leaves this boundary. Deferred features
 * (streaming, tools, response_format, logprobs, audio) are rejected with stable
 * `400` envelopes rather than silently ignored. Documented optional
 * sampling/storage parameters are accepted but their VALUES are never read,
 * logged, or retained — only their names are recorded for a diagnostic header.
 */
import type { NormalizedChatRequest, NormalizedMessage } from "./chat-types.js";
import { normalizeMessage, MAX_TEXT_PARTS_PER_MESSAGE } from "./messages.js";
import { invalidRequest, INVALID_REQUEST_ERROR, type OpenAIApiError } from "./errors.js";

export { MAX_TEXT_PARTS_PER_MESSAGE };

/** Conservative initial safety bound on the number of messages per request. */
export const MAX_MESSAGES = 512;

/**
 * The bounded set of accepted-but-ignored optional parameters (already sorted).
 * Only the presence of these NAMES is ever surfaced; their values are not read.
 */
export const IGNORED_PARAMETER_NAMES: readonly string[] = [
  "max_completion_tokens",
  "max_tokens",
  "parallel_tool_calls",
  "seed",
  "stop",
  "store",
  "temperature",
  "top_p",
  "user",
];

/** The outcome of validating a full chat-completion request. */
export type ChatRequestResult =
  | { readonly ok: true; readonly request: NormalizedChatRequest }
  | { readonly ok: false; readonly error: OpenAIApiError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether an OWN property is present. Existence only — the value is never read,
 * so an explicit `undefined` still counts as supplied, an inherited/prototype
 * property never counts, and (for accepted-but-ignored names) a value getter is
 * never invoked merely to record the name. `Object.hasOwn` does not trigger a
 * getter.
 */
function present(body: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(body, key);
}

function fail(error: OpenAIApiError): ChatRequestResult {
  return { ok: false, error };
}

/**
 * Validate and normalize a raw request body. Returns the first failure (callers
 * and tests use single-violation inputs), or the normalized request.
 */
export function validateChatRequest(body: unknown): ChatRequestResult {
  if (!isRecord(body)) return fail(INVALID_REQUEST_ERROR);

  // 1. Streaming is a Phase 2 feature. `stream` may be ABSENT or exactly `false`;
  //    an explicit `undefined`, `null`, `true`, and every other value are all
  //    rejected — own-property presence with a non-`false` value fails closed.
  if (present(body, "stream") && body["stream"] !== false) {
    return fail(
      invalidRequest(
        "Streaming responses are not supported yet.",
        "stream",
        "unsupported_parameter",
      ),
    );
  }

  // 2. Deferred feature surfaces are rejected by own-property PRESENCE alone —
  //    even an empty array, `null`, explicit `undefined`, `"auto"`, `"none"`, or
  //    an otherwise-harmless value — so the narrow Phase 1B contract never
  //    partially accepts a tool/structured-output signal, and their values are
  //    never read. `parallel_tool_calls` is the sole exception: with no other
  //    tool surface accepted it is a harmless ignored compatibility name (below).
  for (const field of ["tools", "tool_choice", "response_format", "audio", "logprobs"] as const) {
    if (present(body, field)) {
      return fail(invalidRequest(`${field} is not supported yet.`, field, "unsupported_parameter"));
    }
  }

  // 3. Required `model` (exact-case; resolution happens in the catalog).
  const model = body["model"];
  if (typeof model !== "string" || model.length === 0) {
    return fail(invalidRequest("The model field is required.", "model"));
  }

  // 4. `n` must be ABSENT or exactly `1`; a present `undefined` (or any other
  //    value) is invalid.
  if (present(body, "n") && body["n"] !== 1) {
    return fail(invalidRequest("Only n=1 is supported.", "n"));
  }

  // 5. Required non-empty, bounded `messages`.
  const rawMessages = body["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return fail(invalidRequest("The messages field must be a non-empty array.", "messages"));
  }
  if (rawMessages.length > MAX_MESSAGES) {
    return fail(invalidRequest("Too many messages.", "messages"));
  }

  const messages: NormalizedMessage[] = [];
  for (const raw of rawMessages) {
    const result = normalizeMessage(raw);
    if (!result.ok) return fail(result.error);
    messages.push(result.message);
  }

  // 6. Record ignored parameter names by own-property presence only — the value
  //    is never read (no getter is invoked merely to record a name).
  const ignoredParameters = IGNORED_PARAMETER_NAMES.filter((name) => present(body, name));

  // The normalized request is deeply immutable: each message object is frozen
  // (by `normalizeMessage`), and the message array, the ignored-name collection,
  // and the outer request object are frozen here.
  return {
    ok: true,
    request: Object.freeze({
      model,
      messages: Object.freeze(messages),
      ignoredParameters: Object.freeze(ignoredParameters),
    }),
  };
}
