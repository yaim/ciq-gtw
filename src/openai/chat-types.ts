/**
 * Normalized internal chat-request types (specification sections 8.2, 8.4).
 *
 * These are the immutable, already-validated values the generation layer and
 * prompt serializer consume. The raw OpenAI request object is validated and
 * normalized into these shapes at the `src/openai/` boundary and NEVER flows
 * past it. No raw framework request, header, or submitted optional value is
 * carried here.
 *
 * This file is intentionally dependency-free (types only) so both the request
 * validator (`chat-request.ts`) and the generation orchestrator can depend on
 * it without importing each other.
 */

/**
 * The text-only roles supported in the initial release. `tool` is intentionally
 * absent: tool-role messages are rejected until Phase 3.
 */
export type NormalizedRole = "system" | "developer" | "user" | "assistant";

/** The ordered list of accepted roles (used for exact membership checks). */
export const NORMALIZED_ROLES: readonly NormalizedRole[] = [
  "system",
  "developer",
  "user",
  "assistant",
];

/**
 * One normalized message. `content` is the flattened text of a string body or
 * an array of `{ type: "text", text }` parts; the declared `role` is preserved
 * distinctly (a `system`/`developer` distinction is kept even though the single
 * upstream `prompt` field weakens its trust boundary).
 */
export interface NormalizedMessage {
  readonly role: NormalizedRole;
  /** Flattened text content. May be an empty string; never null or undefined. */
  readonly content: string;
}

/**
 * A fully normalized, immutable chat-completion request. The generation layer
 * receives only this — never the raw request. `model` is the verbatim,
 * exact-case requested id (resolution happens in the model catalog). The
 * `ignoredParameters` list carries only the NAMES of accepted-but-ignored
 * optional parameters (never their values), sorted and de-duplicated, for a
 * diagnostic response header.
 */
export interface NormalizedChatRequest {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly ignoredParameters: readonly string[];
}
