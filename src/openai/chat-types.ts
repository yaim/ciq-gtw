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

import type {
  NormalizedPriorToolCall,
  NormalizedTool,
  NormalizedToolChoice,
} from "../tools/types.js";

/**
 * The supported message roles. `tool` is accepted ONLY for `toolMode: "emulated"`
 * models (Phase 3, supported opt-in beta / non-default); a `disabled`/`native`
 * model still rejects a
 * tool-role message and the model-aware boundary enforces that.
 */
export type NormalizedRole = "system" | "developer" | "user" | "assistant" | "tool";

/**
 * The four text roles (used for exact membership checks in message
 * normalization). `tool` is intentionally NOT in this list — it is handled
 * separately and only enabled in emulated tool mode.
 */
export const NORMALIZED_ROLES: readonly Exclude<NormalizedRole, "tool">[] = [
  "system",
  "developer",
  "user",
  "assistant",
];

/**
 * One normalized message. `content` is the flattened text of a string body or an
 * array of `{ type: "text", text }` parts. For an assistant turn that proposed
 * tool calls (emulated mode only), `content` may be `null` and `toolCalls`
 * carries the prior calls; for a tool-result turn, `role` is `"tool"` and
 * `toolCallId` links it to the assistant call it answers. Text-only requests
 * never populate `toolCalls`/`toolCallId`. The declared `role` is preserved
 * distinctly (a `system`/`developer` distinction is kept even though the single
 * upstream `prompt` field weakens its trust boundary).
 */
export interface NormalizedMessage {
  readonly role: NormalizedRole;
  /** Flattened text content; `null` only on an assistant tool-call turn. */
  readonly content: string | null;
  /** Prior tool calls (assistant turns, emulated mode only). */
  readonly toolCalls?: readonly NormalizedPriorToolCall[];
  /** The linked assistant call id (tool-result turns, emulated mode only). */
  readonly toolCallId?: string;
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
  /**
   * The normalized streaming choice: `true` when the client requested exactly
   * `stream: true` (synthetic SSE), `false` when `stream` was absent or exactly
   * `false` (the non-streamed JSON path). Every other `stream` value is rejected
   * at the validation boundary and never reaches this type.
   */
  readonly stream: boolean;
  /**
   * Normalized function-tool definitions for an emulated-mode request. Absent for
   * a text-only (`disabled`) model, where any tool metadata is tolerated and
   * discarded by the Phase 2.1 bridge. An empty array means the emulated model
   * received no tools (no tool protocol is added). These plain-data definitions
   * are serialized into the protocol prompt.
   */
  readonly tools?: readonly NormalizedTool[];
  /** Normalized `tool_choice` (emulated mode only). */
  readonly toolChoice?: NormalizedToolChoice;
  /** Honored parallel-call policy (emulated mode only; default `true`). */
  readonly parallelToolCalls?: boolean;
}
