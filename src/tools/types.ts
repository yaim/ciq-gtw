/**
 * Trusted, dependency-free domain types for the emulated tool-calling engine
 * (specification sections 8.7, 11.2, 12). Every value here is either produced by
 * the descriptor-safe copy (plain JSON data) or by the strict protocol parser —
 * a raw client or upstream object never appears in these shapes.
 */

/** A plain JSON value produced by the descriptor-safe copy (no exotic objects). */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A normalized function-tool definition. `parameters` is a JSON Schema copied
 * into trusted plain data; it is compiled once per request for argument
 * validation and serialized verbatim into the protocol prompt.
 */
export interface NormalizedTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: JsonValue;
}

/**
 * The normalized `tool_choice` (specification section 9.4.3). `required` and a
 * named function forbid a text fallback; `none` disables the tool protocol for
 * the request; `auto` allows either a tool envelope or ordinary final text.
 */
export type NormalizedToolChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "none" }
  | { readonly kind: "required" }
  | { readonly kind: "function"; readonly name: string };

/**
 * A prior assistant tool call carried in the request history. Its `id` is a
 * gateway-issued identifier from an earlier round; `argumentsJson` is the exact
 * validated JSON-string form re-serialized deterministically for the prompt.
 */
export interface NormalizedPriorToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/**
 * One tool call parsed from an upstream tool-or-final envelope. `id` is always a
 * gateway-owned `call_ciq_<ULID>` (upstream ids are never trusted). `argumentsJson`
 * is the validated argument object re-serialized to a canonical JSON string.
 */
export interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/**
 * The parser's output for one completion (specification section 8.7): either
 * ordinary final text or one or more validated tool calls. `source` records the
 * candidate-selection path for bounded, value-free diagnostics only.
 */
export type ParsedGeneration =
  | { readonly kind: "text"; readonly content: string }
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly ParsedToolCall[];
      readonly source: ToolParseSource;
    };

/** Value-free selection-path label (never records tool names or arguments). */
export type ToolParseSource = "desired-source" | "individual-consensus" | "individual-single";

/**
 * The minimal message projection the tool-history validator needs. The
 * `src/openai` `NormalizedMessage` is structurally assignable to this (same
 * `role`/`toolCalls`/`toolCallId` fields), so the request boundary passes its
 * normalized messages directly without an adapter.
 */
export interface ToolHistoryMessage {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  /** Present only on assistant turns that proposed tool calls. */
  readonly toolCalls?: readonly NormalizedPriorToolCall[];
  /** Present only on tool-result turns. */
  readonly toolCallId?: string;
}
