/**
 * Semantic normalization of tool definitions and `tool_choice` (specification
 * sections 9.4.2, 9.4.3, 21.5). Input is ALWAYS trusted plain-JSON data produced
 * by {@link import("./copy.js").safeJsonCopy} — never a raw client object — so
 * every property read here is safe (no getter/proxy exposure). Failures are
 * value-free booleans; the caller maps them to a stable OpenAI envelope.
 */
import { MAX_TOOLS } from "./limits.js";
import type { JsonValue, NormalizedTool, NormalizedToolChoice } from "./types.js";

function isPlainObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The frozen empty JSON Schema used when a tool omits `function.parameters`
 * (accepts any arguments). Freezing the shared default keeps every retained
 * `NormalizedTool.parameters` deeply immutable even when it was synthesized here
 * rather than copied from the (already deep-frozen) request tree.
 */
const EMPTY_PARAMETERS: JsonValue = Object.freeze({});

/** Frozen tool-free choice singletons, reused for the omitted-choice defaults. */
export const AUTO_CHOICE: NormalizedToolChoice = Object.freeze({ kind: "auto" });
export const NONE_CHOICE: NormalizedToolChoice = Object.freeze({ kind: "none" });
const REQUIRED_CHOICE: NormalizedToolChoice = Object.freeze({ kind: "required" });

export type NormalizeToolsResult =
  { readonly ok: true; readonly tools: readonly NormalizedTool[] } | { readonly ok: false };

/**
 * Interpret a copied `tools` array into normalized function-tool definitions.
 * Each entry must be exactly `{ type: "function", function: { name, description?,
 * parameters? } }` with a non-empty string `name`, a string `description` when
 * present, and an object/boolean JSON-Schema `parameters` when present (an absent
 * schema becomes `{}`, accepting any arguments). Names must be unique. A hole,
 * anomaly, or unsupported shape fails closed.
 */
export function normalizeToolDefinitions(copied: JsonValue): NormalizeToolsResult {
  if (!Array.isArray(copied)) return { ok: false };
  if (copied.length > MAX_TOOLS) return { ok: false };

  const tools: NormalizedTool[] = [];
  const seen = new Set<string>();
  for (const entry of copied) {
    if (!isPlainObject(entry)) return { ok: false };
    if (entry["type"] !== "function") return { ok: false };
    const fn = entry["function"];
    if (!isPlainObject(fn)) return { ok: false };

    const name = fn["name"];
    if (typeof name !== "string" || name.length === 0) return { ok: false };
    if (seen.has(name)) return { ok: false }; // unique function names required
    seen.add(name);

    let description: string | undefined;
    if ("description" in fn) {
      const raw = fn["description"];
      if (typeof raw !== "string") return { ok: false };
      description = raw;
    }

    let parameters: JsonValue = EMPTY_PARAMETERS;
    if ("parameters" in fn) {
      const raw = fn["parameters"];
      // A JSON Schema is an object or a boolean; anything else is unsupported.
      if (!(isPlainObject(raw) || typeof raw === "boolean")) return { ok: false };
      // `raw` is a sub-tree of the already deep-frozen copied request tree.
      parameters = raw;
    }

    tools.push(
      description === undefined ? { name, parameters } : { name, description, parameters },
    );
  }
  return { ok: true, tools };
}

export type NormalizeChoiceResult =
  { readonly ok: true; readonly choice: NormalizedToolChoice } | { readonly ok: false };

/**
 * Interpret a copied `tool_choice` value. Accepts exactly the string forms
 * `"auto"`/`"none"`/`"required"` and the named-function object
 * `{ type: "function", function: { name } }`. Every other value fails closed.
 * (Whether a `required`/named choice is legal given the declared tools is checked
 * by the caller, which knows the tool set.)
 */
export function normalizeToolChoice(copied: JsonValue): NormalizeChoiceResult {
  if (copied === "auto") return { ok: true, choice: AUTO_CHOICE };
  if (copied === "none") return { ok: true, choice: NONE_CHOICE };
  if (copied === "required") return { ok: true, choice: REQUIRED_CHOICE };
  if (isPlainObject(copied) && copied["type"] === "function") {
    const fn = copied["function"];
    if (isPlainObject(fn)) {
      const name = fn["name"];
      if (typeof name === "string" && name.length > 0) {
        // Freeze the named-choice variant so the retained `tool_choice` is immutable.
        return { ok: true, choice: Object.freeze({ kind: "function" as const, name }) };
      }
    }
  }
  return { ok: false };
}
