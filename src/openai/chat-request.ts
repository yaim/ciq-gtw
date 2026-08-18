/**
 * OpenAI Chat Completions request validation and normalization
 * (specification sections 8.2, 8.7, 9.4). Produces an immutable
 * {@link NormalizedChatRequest} plus the resolved internal model policy, or a
 * value-free OpenAI rejection envelope.
 *
 * The raw request object never leaves this boundary. `stream` is normalized to
 * a boolean (Phase 2: `true` selects synthetic SSE, absent/`false` the
 * non-streamed path; any other value is rejected). Deferred features
 * (`response_format`, `logprobs`, audio) are rejected by own-property presence
 * with stable `400` envelopes rather than silently ignored.
 *
 * Tool metadata is handled by a MODEL-POLICY-AWARE compatibility bridge (Phase
 * 2.1). OpenCode automatically attaches `tools`/`tool_choice` to every request
 * even when every tool permission is denied; a text-only (`toolMode:
 * "disabled"`) model must therefore TOLERATE that metadata. A tool definition is
 * never semantically interpreted, retained, serialized into the upstream prompt,
 * forwarded, logged, reflected, persisted, or executed — it is traversed only
 * through data-property descriptors for bounded JSON-shape and byte accounting
 * (count ≤ `MAX_TOOLS`, aggregate JSON ≤ `MAX_TOOL_SCHEMA_BYTES`), and submitted
 * accessors and executable hooks are never invoked. Only the parameter NAMES are
 * recorded for the diagnostic header. Actual tool calling stays disabled: any
 * tool metadata sent to a model whose mode is `emulated`/`native` (both
 * unimplemented) fails closed, and a `tool_choice` that REQUIRES or NAMES a tool
 * is always rejected. See the per-field contract on
 * {@link validateToolCompatibility}.
 *
 * Documented optional sampling/storage parameters are accepted but their VALUES
 * are never read, logged, or retained — only their names are recorded.
 */
import type { VirtualModel } from "../config/schema.js";
import type { NormalizedChatRequest, NormalizedMessage } from "./chat-types.js";
import { normalizeMessage, MAX_TEXT_PARTS_PER_MESSAGE } from "./messages.js";
import {
  invalidRequest,
  INVALID_REQUEST_ERROR,
  MODEL_NOT_FOUND_ERROR,
  type OpenAIApiError,
} from "./errors.js";

export { MAX_TEXT_PARTS_PER_MESSAGE };

/** Conservative initial safety bound on the number of messages per request. */
export const MAX_MESSAGES = 512;

/**
 * Conservative upper bound on the number of `tools` entries tolerated from a
 * text-only client (specification section 21.6, `MAX_TOOL_COUNT`). Entries are
 * never semantically interpreted; the count is bounded so a hostile client
 * cannot force unbounded work merely by sending a giant tool collection.
 */
export const MAX_TOOLS = 128;

/**
 * Aggregate byte budget for the ENTIRE `tools` JSON array (specification section
 * 21.6, `MAX_TOOL_SCHEMA_BYTES = 2 MiB`). Array/object framing, property names,
 * tool names, descriptions, schema keys, schema values, and every nested JSON
 * value all count toward the exact UTF-8 JSON representation. This bounds a
 * hostile client that stays within {@link MAX_TOOLS} but sends enormous
 * individual schemas.
 */
export const MAX_TOOL_SCHEMA_BYTES = 2_097_152;

/**
 * Conservative maximum JSON nesting depth for the `tools` collection. Deeper
 * structures fail closed. The iterative accounting below cannot overflow the
 * call stack, so this is a resource/anomaly bound (a real tool schema nests only
 * a handful of levels), not a stack-safety crutch.
 */
const MAX_TOOL_JSON_DEPTH = 512;

/**
 * The bounded set of accepted-but-ignored optional parameters (already sorted).
 * Only the presence of these NAMES is ever surfaced; their values are not read.
 * `tools`/`tool_choice` are NOT in this list — they are handled by the
 * model-aware bridge, which contributes their names to the recorded collection
 * only when they are present AND accepted for a `disabled` model.
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

/** Resolve the internal model policy for an exact-case id (the catalog lookup). */
export type ModelResolver = (id: string) => VirtualModel | undefined;

/** The outcome of validating a full chat-completion request. */
export type ChatRequestResult =
  | { readonly ok: true; readonly request: NormalizedChatRequest; readonly model: VirtualModel }
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
 * A descriptor-safe probe of ONE own property. It reads the property descriptor
 * (never the property via `[[Get]]`), so an accessor's getter is never invoked
 * and a hostile `getOwnPropertyDescriptor` trap that throws fails closed. Only
 * OWN properties count (an inherited property probes as `absent`).
 */
type PropertyProbe =
  | { readonly kind: "absent" }
  | { readonly kind: "accessor" }
  | { readonly kind: "error" }
  | { readonly kind: "value"; readonly value: unknown };

function probeOwn(body: Record<string, unknown>, key: string): PropertyProbe {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(body, key);
  } catch {
    // A hostile proxy trap threw: fail closed WITHOUT inspecting the thrown value.
    return { kind: "error" };
  }
  if (descriptor === undefined) return { kind: "absent" };
  // An accessor property is rejected without ever invoking its getter/setter.
  if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
    return { kind: "accessor" };
  }
  return { kind: "value", value: descriptor.value };
}

/** Stable content-free tool rejection (`param` is only the static field name). */
function toolUnsupported(param: "tools" | "tool_choice"): OpenAIApiError {
  return invalidRequest(
    `${param} is not supported for this request.`,
    param,
    "unsupported_parameter",
  );
}

/**
 * Whether `key` is a canonical array index string (`"0"`, `"1"`, … — no leading
 * zeros, no sign, no fraction) that falls within `[0, length)`. Used to prove a
 * `tools` array is dense (no holes, no extra own string keys).
 */
function isCanonicalIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return index < length && index < 0xffffffff;
}

/**
 * Bounded, side-effect-free JSON byte accounting over the whole `tools`
 * collection. It proves the collection is a JSON-compatible tree within
 * {@link MAX_TOOL_SCHEMA_BYTES} WITHOUT ever triggering an ordinary property
 * `[[Get]]`, a getter/setter, `toJSON`, an iterator, or any user function:
 * every value is read through `Object.getOwnPropertyDescriptor` /
 * `Reflect.ownKeys` / `Object.getPrototypeOf` only (a Proxy may see those
 * descriptor/own-key/prototype traps, but never a `get` trap). Traversal is
 * ITERATIVE (an explicit work stack, so deep input cannot overflow the call
 * stack) and depth-bounded ({@link MAX_TOOL_JSON_DEPTH}); a path-scoped `onPath`
 * set detects cycles while still allowing shared (DAG) sub-objects.
 *
 * The accepted subset is exactly what `JSON.stringify` would emit for a plain
 * JSON tree — `null`, booleans, finite numbers, strings, dense arrays, and plain
 * objects with enumerable own string data properties — so the accumulated size
 * equals `Buffer.byteLength(JSON.stringify(tools), "utf8")` byte-for-byte. It
 * fails closed (returns `false`, never throws) for accessors anywhere, sparse or
 * anomalous arrays, cycles, functions/symbols/bigint/`undefined`/non-finite
 * numbers, symbol keys, non-plain exotic objects, descriptor/own-key/proxy
 * failures, excessive depth, or an encoded size over the budget. `JSON.stringify`
 * is used only on an already-obtained PRIMITIVE string/number value (never on a
 * submitted object or array) to compute exact escaping/UTF-8 bytes.
 */
function toolCollectionWithinBudget(root: unknown): boolean {
  type Task = { readonly value: unknown } | { readonly exit: object };
  let total = 0;
  const onPath = new Set<object>();
  const stack: Task[] = [{ value: root }];

  try {
    while (stack.length > 0) {
      const task = stack.pop() as Task;
      if ("exit" in task) {
        onPath.delete(task.exit);
        continue;
      }
      const value = task.value;

      if (value === null) {
        total += 4; // "null"
      } else if (typeof value === "boolean") {
        total += value ? 4 : 5; // "true" / "false"
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) return false;
        total += String(value).length; // JSON number form is ASCII
      } else if (typeof value === "string") {
        total += Buffer.byteLength(JSON.stringify(value), "utf8"); // quotes + escapes
      } else if (typeof value === "object") {
        const obj = value;
        if (onPath.has(obj)) return false; // cycle
        if (onPath.size >= MAX_TOOL_JSON_DEPTH) return false; // too deep

        if (Array.isArray(obj)) {
          const lengthDesc = Object.getOwnPropertyDescriptor(obj, "length");
          if (lengthDesc === undefined || !("value" in lengthDesc)) return false;
          const length: unknown = lengthDesc.value;
          if (
            typeof length !== "number" ||
            !Number.isInteger(length) ||
            length < 0 ||
            length > 0xffffffff
          ) {
            return false;
          }
          // Own keys must be exactly the dense indices [0, length) plus "length".
          let indexCount = 0;
          for (const key of Reflect.ownKeys(obj)) {
            if (typeof key === "symbol") return false;
            if (key === "length") continue;
            if (!isCanonicalIndex(key, length)) return false;
            indexCount += 1;
          }
          if (indexCount !== length) return false; // sparse / holes / extras
          total += 2 + (length > 0 ? length - 1 : 0); // "[" "]" + commas
          if (total > MAX_TOOL_SCHEMA_BYTES) return false;
          onPath.add(obj);
          stack.push({ exit: obj });
          for (let i = 0; i < length; i += 1) {
            const elementDesc = Object.getOwnPropertyDescriptor(obj, String(i));
            if (elementDesc === undefined || !("value" in elementDesc)) return false; // hole / accessor
            stack.push({ value: elementDesc.value });
          }
        } else {
          const proto: unknown = Object.getPrototypeOf(obj);
          if (proto !== null && proto !== Object.prototype) return false; // exotic / non-plain
          const values: unknown[] = [];
          let members = 0;
          let framing = 0;
          for (const key of Reflect.ownKeys(obj)) {
            if (typeof key === "symbol") return false; // unexpected symbol key
            const desc = Object.getOwnPropertyDescriptor(obj, key);
            if (desc === undefined) return false;
            if (typeof desc.get === "function" || typeof desc.set === "function") return false; // accessor
            if (!desc.enumerable) continue; // JSON.stringify omits non-enumerable props
            members += 1;
            framing += Buffer.byteLength(JSON.stringify(key), "utf8") + 1; // key + ":"
            values.push(desc.value);
          }
          total += 2 + (members > 0 ? members - 1 : 0) + framing; // "{" "}" + commas + keys/colons
          if (total > MAX_TOOL_SCHEMA_BYTES) return false;
          onPath.add(obj);
          stack.push({ exit: obj });
          for (const child of values) stack.push({ value: child });
        }
      } else {
        // function, symbol, bigint, or undefined → not JSON-representable.
        return false;
      }

      if (total > MAX_TOOL_SCHEMA_BYTES) return false;
    }
  } catch {
    // A descriptor/own-key/prototype/proxy failure fails closed WITHOUT
    // inspecting or serializing the thrown value.
    return false;
  }
  return total <= MAX_TOOL_SCHEMA_BYTES;
}

/**
 * Whether a `tools` value is a bounded, JSON-safe tool collection: a real array
 * of at most {@link MAX_TOOLS} entries (count read from the array's own `length`
 * DATA descriptor, never through `[[Get]]`) whose entire JSON encoding is within
 * {@link MAX_TOOL_SCHEMA_BYTES}. Fails closed on any anomaly.
 */
function isBoundedToolCollection(value: unknown): boolean {
  try {
    if (!Array.isArray(value)) return false;
    const lengthDesc = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDesc === undefined || !("value" in lengthDesc)) return false;
    const length: unknown = lengthDesc.value;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > MAX_TOOLS
    ) {
      return false;
    }
    return toolCollectionWithinBudget(value);
  } catch {
    return false;
  }
}

/** The outcome of the model-aware tool-compatibility bridge. */
type ToolBridgeResult =
  | { readonly ok: true; readonly ignored: readonly string[] }
  | { readonly ok: false; readonly error: OpenAIApiError };

/**
 * Model-policy-aware `tools`/`tool_choice` compatibility bridge (Phase 2.1).
 *
 * Validated AFTER exact model resolution and in deterministic order — `tools`
 * first, then `tool_choice` — so two invalid fields always yield the same
 * envelope. A tool definition is never semantically interpreted, retained,
 * serialized into the upstream prompt, forwarded, logged, reflected, persisted,
 * or executed; it is traversed only through data-property descriptors for
 * bounded JSON-shape and byte accounting, and submitted accessors and executable
 * hooks are never invoked. On acceptance the bridge records ONLY the parameter
 * name for the diagnostic header.
 *
 * For a `toolMode: "disabled"` (text-only) model:
 *  - `tools` is accepted only as an own JSON array of at most {@link MAX_TOOLS}
 *    entries whose entire JSON encoding is within {@link MAX_TOOL_SCHEMA_BYTES}
 *    (see {@link toolCollectionWithinBudget}); a non-array, an over-count or
 *    over-budget collection, an accessor anywhere, a sparse/anomalous/exotic/
 *    cyclic/too-deep structure, an unsupported value, or a descriptor/proxy
 *    failure is rejected.
 *  - `tool_choice` is accepted only when absent or exactly `"auto"`/`"none"`;
 *    `"required"`, a named-function object, any other object, `null`, an
 *    explicit `undefined`, an accessor, or a malformed value is rejected — a
 *    request that REQUIRES or NAMES a tool is never silently ignored.
 *
 * For an `emulated`/`native` model (neither implemented), any presence of
 * `tools`/`tool_choice` fails closed with the same unsupported-parameter
 * envelope so those modes are never partially activated.
 */
function validateToolCompatibility(
  body: Record<string, unknown>,
  toolMode: VirtualModel["toolMode"],
): ToolBridgeResult {
  const ignored: string[] = [];
  const disabled = toolMode === "disabled";

  // 1. `tools` (validated first).
  const tools = probeOwn(body, "tools");
  if (tools.kind !== "absent") {
    if (!disabled || tools.kind !== "value") {
      // Non-disabled mode, an accessor-backed property, or a descriptor/proxy
      // failure at the top level: fail closed.
      return { ok: false, error: toolUnsupported("tools") };
    }
    // Bounded, descriptor-only structural + byte accounting: the collection must
    // be a JSON array of at most MAX_TOOLS entries whose entire JSON encoding is
    // within MAX_TOOL_SCHEMA_BYTES. The array length is read from its own DATA
    // descriptor (never `.length` via `[[Get]]`), and definitions are traversed
    // only through descriptors — never interpreted, retained, or executed.
    if (!isBoundedToolCollection(tools.value)) {
      return { ok: false, error: toolUnsupported("tools") };
    }
    ignored.push("tools");
  }

  // 2. `tool_choice` (validated second).
  const choice = probeOwn(body, "tool_choice");
  if (choice.kind !== "absent") {
    if (!disabled || choice.kind !== "value") {
      return { ok: false, error: toolUnsupported("tool_choice") };
    }
    // Only the two tool-free string choices are accepted; every value that
    // requires or names a tool (or is otherwise malformed) is rejected.
    if (choice.value !== "auto" && choice.value !== "none") {
      return { ok: false, error: toolUnsupported("tool_choice") };
    }
    ignored.push("tool_choice");
  }

  return { ok: true, ignored };
}

/**
 * Validate and normalize a raw request body against the resolved model policy.
 * Returns the first failure (callers and tests use single-violation inputs), or
 * the normalized request together with the resolved internal model policy.
 *
 * Ordering is deterministic: model-independent structural validation (stream →
 * deferred features → model → n → messages) runs first, then the model is
 * resolved (`404` on an unknown/case-mismatched id), then the model-aware checks
 * run — the direct-mode "at least one user message" guard, then the tool bridge.
 * This keeps a structural `400` ahead of a `404`, and a `404` ahead of a
 * model-aware `400` (the model policy is unknown until the model resolves).
 */
export function validateChatRequest(body: unknown, resolveModel: ModelResolver): ChatRequestResult {
  if (!isRecord(body)) return fail(INVALID_REQUEST_ERROR);

  // 1. Streaming (Phase 2). `stream` may be ABSENT or exactly `false` (the
  //    non-streamed JSON path) or exactly `true` (synthetic SSE). Every other
  //    value — an explicit `undefined`, `null`, `"true"`, `0`, `1`, etc. — is
  //    rejected; own-property presence with a non-boolean value fails closed.
  let stream = false;
  if (present(body, "stream")) {
    const value = body["stream"];
    if (value !== false && value !== true) {
      return fail(
        invalidRequest("The stream field must be a boolean.", "stream", "invalid_request"),
      );
    }
    stream = value;
  }

  // 2. Model-independent deferred feature surfaces are rejected by own-property
  //    PRESENCE alone — even an empty value, `null`, or explicit `undefined` —
  //    so the narrow contract never partially accepts a structured-output/audio
  //    signal, and their values are never read. (`tools`/`tool_choice` are
  //    handled by the model-aware bridge in step 7; `parallel_tool_calls` stays
  //    an ignored compatibility name below.)
  for (const field of ["response_format", "audio", "logprobs"] as const) {
    if (present(body, field)) {
      return fail(invalidRequest(`${field} is not supported yet.`, field, "unsupported_parameter"));
    }
  }

  // 3. Required `model` (exact-case; resolution happens below).
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

  // 6. Resolve the internal model policy (exact-case). An unknown id or case
  //    mismatch is a `404`; the submitted id is never reflected back.
  const policy = resolveModel(model);
  if (policy === undefined) return fail(MODEL_NOT_FOUND_ERROR);

  // 7. Direct-mode prompt policy (model-aware). A `promptMode: "direct"` model
  //    submits ONLY the latest normalized user-role message, so a request with
  //    no user-role message cannot produce a prompt. Reject it here — at the
  //    model-aware boundary — with a fixed, content-free `400` so the failure
  //    happens BEFORE prepare(), capacity acquisition, thread creation,
  //    submission, or any SSE header commitment. Prompt behaviour is driven from
  //    the validated `promptMode`, never a model-id comparison.
  if (policy.promptMode === "direct" && !messages.some((message) => message.role === "user")) {
    return fail(invalidRequest("A user message is required.", "messages", "invalid_request"));
  }

  // 8. Model-aware `tools`/`tool_choice` bridge (Phase 2.1). Its accepted names
  //    join the ignored-parameter collection; a rejection is a stable `400`.
  const toolBridge = validateToolCompatibility(body, policy.toolMode);
  if (!toolBridge.ok) return fail(toolBridge.error);

  // 9. Record ignored parameter names by own-property presence only — the value
  //    is never read (no getter is invoked merely to record a name) — then merge
  //    the accepted tool names and sort deterministically.
  const ignoredParameters = [
    ...IGNORED_PARAMETER_NAMES.filter((name) => present(body, name)),
    ...toolBridge.ignored,
  ].sort();

  // The normalized request is deeply immutable: each message object is frozen
  // (by `normalizeMessage`), and the message array, the ignored-name collection,
  // and the outer request object are frozen here.
  return {
    ok: true,
    model: policy,
    request: Object.freeze({
      model,
      messages: Object.freeze(messages),
      ignoredParameters: Object.freeze(ignoredParameters),
      stream,
    }),
  };
}
