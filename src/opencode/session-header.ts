/**
 * Shared validation for the OpenCode session-correlation header.
 *
 * The header carries an OPAQUE OpenCode session identifier used ONLY to
 * process-locally correlate a completion's upstream thread with the caller's
 * session so the native-title bridge can later return that thread's
 * server-generated title (see `title-bridge.ts`). The value is never logged,
 * hashed into logs, reflected in an error, or exposed in a completion response.
 *
 * Both the chat-completions route (which registers a successful correlation) and
 * the `GET /v1/opencode/session-title` route (which looks one up) share this
 * validator so the accepted shape is defined exactly once.
 */

/** The correlation header name (lowercase; Fastify normalizes header keys to lowercase). */
export const SESSION_ID_HEADER = "x-collectiviq-opencode-session-id";

/** Maximum accepted session-id length, in bytes (ASCII, so bytes === chars). */
export const SESSION_ID_MAX_BYTES = 128;

/** Opaque ASCII identifier: letters, digits, underscore, hyphen; 1–128 chars. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Normalize a raw header value to a valid opaque session id, or `null` when it is
 * absent or malformed (missing, an array of values, wrong length, or containing a
 * disallowed character). Callers treat `null` as "no valid correlation": the chat
 * route simply skips registration; the title route returns its fixed `400`.
 * The raw value is never logged or reflected regardless of the outcome.
 */
export function normalizeSessionId(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (!SESSION_ID_PATTERN.test(raw)) return null;
  return raw;
}
