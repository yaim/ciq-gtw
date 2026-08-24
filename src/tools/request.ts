/**
 * Emulated-mode request normalization (specification sections 8.4, 9.4.3, 12,
 * 21.5). Given the descriptor-safe-probed raw `tools` / `tool_choice` /
 * `parallel_tool_calls` values and the normalized message history, this produces
 * the trusted tool policy and a compiled toolset, or a value-free failure keyed
 * by the offending public parameter.
 *
 * All heavy structural traversal goes through {@link safeJsonCopy}; every check
 * that could otherwise trust a raw object operates on the resulting plain data.
 * The caller (`src/openai/chat-request.ts`) maps a failure `param` to a stable
 * OpenAI envelope and performs the top-level descriptor probe (rejecting an
 * accessor-backed property before its value is ever read).
 */
import { deepFreezeJson, safeJsonCopy } from "./copy.js";
import { MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_JSON_DEPTH, MAX_TOOL_SCHEMA_BYTES } from "./limits.js";
import {
  AUTO_CHOICE,
  NONE_CHOICE,
  normalizeToolChoice,
  normalizeToolDefinitions,
} from "./normalize.js";
import { compileToolset, type CompiledToolset } from "./schema.js";
import type { NormalizedTool, NormalizedToolChoice, ToolHistoryMessage } from "./types.js";

/** The public parameter a failure is attributed to. */
export type ToolParam = "tools" | "tool_choice" | "messages" | "parallel_tool_calls";

/** A descriptor-probed optional field: present with a value, or absent. */
export interface ProbedField {
  readonly present: boolean;
  readonly value: unknown;
}

export interface NormalizeToolRequestInput {
  readonly tools: ProbedField;
  readonly toolChoice: ProbedField;
  readonly parallelToolCalls: ProbedField;
  readonly messages: readonly ToolHistoryMessage[];
}

/** The trusted emulated-mode tool policy for one request. */
export interface NormalizedToolRequest {
  readonly tools: readonly NormalizedTool[];
  readonly choice: NormalizedToolChoice;
  readonly parallelToolCalls: boolean;
  /** Compiled once per request; reused for history and every upstream call. */
  readonly toolset: CompiledToolset;
}

export type NormalizeToolRequestResult =
  | { readonly ok: true; readonly value: NormalizedToolRequest }
  | { readonly ok: false; readonly param: ToolParam };

function fail(param: ToolParam): NormalizeToolRequestResult {
  return { ok: false, param };
}

/**
 * Whether an argument JSON string is bounded, depth-safe, an object, and valid
 * against the named tool's compiled schema. Used for prior-history arguments.
 */
function argumentsValid(toolset: CompiledToolset, name: string, argumentsJson: string): boolean {
  if (Buffer.byteLength(argumentsJson, "utf8") > MAX_TOOL_ARGUMENT_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return false;
  }
  const copy = safeJsonCopy(parsed, {
    maxBytes: MAX_TOOL_ARGUMENT_BYTES,
    maxDepth: MAX_TOOL_JSON_DEPTH,
  });
  if (!copy.ok) return false;
  const value = copy.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return toolset.validateArguments(name, value);
}

/**
 * Validate prior assistant tool calls and their linked tool results
 * (specification section 8.4): every gateway-issued call id is unique, references
 * a declared tool, has parseable schema-valid arguments, and is resolved by
 * exactly one correctly linked tool-result message that appears after it. Orphan,
 * duplicate, unresolved, or mismatched relationships fail closed.
 */
function validateHistory(
  messages: readonly ToolHistoryMessage[],
  toolset: CompiledToolset,
): boolean {
  const calls = new Map<string, { resolved: boolean }>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        if (typeof call.id !== "string" || call.id.length === 0) return false;
        if (calls.has(call.id)) return false; // duplicate call id
        if (!toolset.has(call.name)) return false; // undeclared tool
        if (!argumentsValid(toolset, call.name, call.argumentsJson)) return false;
        calls.set(call.id, { resolved: false });
      }
    } else if (message.role === "tool") {
      const id = message.toolCallId;
      if (typeof id !== "string" || id.length === 0) return false;
      const entry = calls.get(id);
      if (entry === undefined) return false; // orphan result (no matching call)
      if (entry.resolved) return false; // duplicate result for one call
      entry.resolved = true;
    }
  }
  for (const entry of calls.values()) {
    if (!entry.resolved) return false; // unresolved call (no linked result)
  }
  return true;
}

/**
 * Normalize the emulated-mode tool policy. When no `tools` are supplied the
 * request has no active tool protocol (empty tool set, `none` choice) UNLESS a
 * `required`/named choice is present, which is rejected. Prior tool history is
 * validated against the compiled toolset. Returns the trusted policy or a
 * value-free failure.
 */
export function normalizeToolRequest(input: NormalizeToolRequestInput): NormalizeToolRequestResult {
  // 1. Tool definitions. The descriptor-safe copy produces a fresh trusted tree;
  //    it is deep-frozen so every nested schema value RETAINED on the normalized
  //    request (and serialized verbatim into the protocol prompt) is immutable.
  //    The original untrusted object is never traversed through ordinary reads.
  let tools: readonly NormalizedTool[] = [];
  if (input.tools.present) {
    const copy = safeJsonCopy(input.tools.value, {
      maxBytes: MAX_TOOL_SCHEMA_BYTES,
      maxDepth: MAX_TOOL_JSON_DEPTH,
    });
    if (!copy.ok) return fail("tools");
    const normalized = normalizeToolDefinitions(deepFreezeJson(copy.value));
    if (!normalized.ok) return fail("tools");
    // Freeze each definition wrapper and the array; the `parameters` sub-trees are
    // already frozen above, so the whole retained tool policy is deeply immutable.
    tools = Object.freeze(normalized.tools.map((tool) => Object.freeze(tool)));
  }

  // 2. Compile the schemas once (draft-07 default; draft 2020-12 when a tool's
  //    root `$schema` declares it). A malformed/unknown-dialect schema fails.
  const compiled = compileToolset(tools);
  if (!compiled.ok) return fail("tools");
  const toolset = compiled.toolset;

  // 3. tool_choice. Omitted with tools present means `auto`; omitted with no
  //    tools means `none` (no tool protocol). `required`/named requires ≥1
  //    declared tool and, for named, that the function is declared.
  let choice: NormalizedToolChoice;
  if (input.toolChoice.present) {
    const copy = safeJsonCopy(input.toolChoice.value, {
      maxBytes: MAX_TOOL_SCHEMA_BYTES,
      maxDepth: MAX_TOOL_JSON_DEPTH,
    });
    if (!copy.ok) return fail("tool_choice");
    const normalized = normalizeToolChoice(copy.value);
    if (!normalized.ok) return fail("tool_choice");
    choice = normalized.choice;
  } else {
    // Frozen singletons — the retained `tool_choice` default is immutable.
    choice = tools.length > 0 ? AUTO_CHOICE : NONE_CHOICE;
  }
  if ((choice.kind === "required" || choice.kind === "function") && tools.length === 0) {
    return fail("tool_choice");
  }
  if (choice.kind === "function" && !toolset.has(choice.name)) {
    return fail("tool_choice");
  }

  // 4. parallel_tool_calls (honored in emulated mode). Absent → default `true`.
  //    When present it MUST be an own boolean data property: `false` disables
  //    multiple calls, `true` keeps the default. Any non-boolean value (null,
  //    string, number, object, …) is a stable rejection keyed to the parameter;
  //    an accessor-backed / proxy-throwing property is rejected at the top-level
  //    descriptor probe (`chat-request.ts`) before its value ever reaches here.
  let parallelToolCalls = true;
  if (input.parallelToolCalls.present) {
    if (typeof input.parallelToolCalls.value !== "boolean") return fail("parallel_tool_calls");
    parallelToolCalls = input.parallelToolCalls.value;
  }

  // 5. Prior tool history linkage/uniqueness/schema validation.
  if (!validateHistory(input.messages, toolset)) return fail("messages");

  return { ok: true, value: { tools, choice, parallelToolCalls, toolset } };
}
