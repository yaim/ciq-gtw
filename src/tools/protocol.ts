/**
 * Strict tool-or-final protocol parser (specification sections 11.2, 12.2).
 *
 * Parses ONE candidate upstream message into a final-text or tool-calls
 * envelope, or rejects it. The algorithm is exactly section 12.2: Unicode trim →
 * remove at most one complete outer JSON code fence → parse with a real JSON
 * parser → validate the versioned envelope and its exact key set → allowlist tool
 * names → validate arguments against the compiled schema → enforce strict object
 * bounds, `tool_choice`, call-count, parallel, and argument-byte limits. There is
 * NO regex extraction from prose, NO partial-fence acceptance, NO silent JSON
 * repair, and NO trust in upstream ids. Anything that is not exactly one valid
 * JSON object of the expected shape maps to `{ kind: "invalid" }`.
 */
import { safeJsonCopy } from "./copy.js";
import {
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_CALLS_PER_RESPONSE,
  MAX_TOOL_JSON_DEPTH,
} from "./limits.js";
import type { CompiledToolset } from "./schema.js";
import type { NormalizedToolChoice } from "./types.js";

/** The versioned protocol identifier the envelope must carry. */
export const GATEWAY_PROTOCOL_VERSION = "1.0";

/** A parsed call before gateway id assignment (name + canonical arguments). */
export interface EnvelopeToolCall {
  readonly name: string;
  readonly argumentsJson: string;
}

/** The result of parsing one candidate message. */
export type ParsedEnvelope =
  | { readonly kind: "final"; readonly content: string }
  | { readonly kind: "tool_calls"; readonly calls: readonly EnvelopeToolCall[] }
  | { readonly kind: "invalid" };

export interface ParseOptions {
  readonly toolset: CompiledToolset;
  readonly choice: NormalizedToolChoice;
  readonly parallelToolCalls: boolean;
}

const INVALID: ParsedEnvelope = { kind: "invalid" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an object's own enumerable string keys are a subset of `allowed`. */
function keysWithin(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

/**
 * Remove exactly one complete outer Markdown code fence, if present. A fence
 * must open with ``` optionally followed by a language token on its own line and
 * close with a trailing ```. A partial or non-enclosing fence is left untouched
 * (so it fails JSON parsing rather than being silently repaired).
 */
function stripOneFence(text: string): string {
  if (!text.startsWith("```")) return text;
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return text; // partial fence: no body
  const openToken = text.slice(3, firstNewline);
  if (!/^[a-zA-Z0-9_-]*[ \t]*$/.test(openToken)) return text; // not a clean opening fence
  const body = text.slice(firstNewline + 1);
  const closeIndex = body.lastIndexOf("```");
  if (closeIndex === -1) return text; // no closing fence
  // Everything after the closing fence must be whitespace only (no trailing prose).
  if (body.slice(closeIndex + 3).trim() !== "") return text;
  return body.slice(0, closeIndex);
}

/** Parse and validate one candidate's arguments object into canonical JSON. */
function normalizeArguments(
  toolset: CompiledToolset,
  name: string,
  rawArgs: unknown,
): string | null {
  // `rawArgs` came from JSON.parse (plain data). Bound its size and depth and
  // copy into a canonical plain tree in one pass; fail closed on any anomaly.
  const copy = safeJsonCopy(rawArgs, {
    maxBytes: MAX_TOOL_ARGUMENT_BYTES,
    maxDepth: MAX_TOOL_JSON_DEPTH,
  });
  if (!copy.ok) return null;
  const value = copy.value;
  // Arguments must be a JSON object (OpenAI function arguments are objects).
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Exact-schema validation (no coercion). An unknown name never validates.
  if (!toolset.validateArguments(name, value)) return null;
  const argumentsJson = JSON.stringify(value);
  if (Buffer.byteLength(argumentsJson, "utf8") > MAX_TOOL_ARGUMENT_BYTES) return null;
  return argumentsJson;
}

/** Parse one candidate message into a tool-or-final envelope, or reject it. */
export function parseToolEnvelope(rawText: string, options: ParseOptions): ParsedEnvelope {
  const trimmed = rawText.trim();
  const unfenced = stripOneFence(trimmed).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return INVALID;
  }
  if (!isPlainObject(parsed)) return INVALID;
  if (parsed["gateway_protocol"] !== GATEWAY_PROTOCOL_VERSION) return INVALID;

  const type = parsed["type"];
  if (type === "final") {
    if (!keysWithin(parsed, ["gateway_protocol", "type", "content"])) return INVALID;
    const content = parsed["content"];
    if (typeof content !== "string") return INVALID;
    return { kind: "final", content };
  }

  if (type === "tool_calls") {
    if (!keysWithin(parsed, ["gateway_protocol", "type", "calls"])) return INVALID;
    const rawCalls = parsed["calls"];
    if (!Array.isArray(rawCalls)) return INVALID;
    if (rawCalls.length < 1 || rawCalls.length > MAX_TOOL_CALLS_PER_RESPONSE) return INVALID;
    // Parallel-call policy: a single call is always allowed; multiple calls are
    // rejected unless parallel calls are enabled. There is NO silent
    // "select the first call" fallback.
    if (!options.parallelToolCalls && rawCalls.length > 1) return INVALID;

    const calls: EnvelopeToolCall[] = [];
    for (const rawCall of rawCalls) {
      if (!isPlainObject(rawCall)) return INVALID;
      if (!keysWithin(rawCall, ["name", "arguments"])) return INVALID;
      // A call MUST carry its own `arguments` property. An omitted `arguments`
      // is NOT silently repaired to `{}`: a tool whose schema requires no fields
      // must still emit an explicit `"arguments": {}`, so a missing key is a
      // malformed envelope, not an implicit empty-argument call.
      if (!Object.prototype.hasOwnProperty.call(rawCall, "arguments")) return INVALID;
      const name = rawCall["name"];
      if (typeof name !== "string" || !options.toolset.has(name)) return INVALID; // allowlist
      // A named tool_choice requires every call to target the named function.
      if (options.choice.kind === "function" && name !== options.choice.name) return INVALID;
      const argumentsJson = normalizeArguments(options.toolset, name, rawCall["arguments"]);
      if (argumentsJson === null) return INVALID;
      calls.push({ name, argumentsJson });
    }
    return { kind: "tool_calls", calls };
  }

  return INVALID;
}
