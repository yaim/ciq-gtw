/**
 * Descriptor-safe bounded deep copy (specification sections 21.5, 21.6).
 *
 * `safeJsonCopy` converts a submitted, untrusted value into a fresh plain-JSON
 * tree WITHOUT ever triggering an ordinary property `[[Get]]`, a getter/setter,
 * `toJSON`, an iterator, or any user function: every value is read only through
 * `Object.getOwnPropertyDescriptor` / `Reflect.ownKeys` / `Object.getPrototypeOf`
 * (a hostile Proxy may observe those descriptor/own-key/prototype traps, but
 * never a `get` trap). It fails closed (returns `{ ok: false }`, never throws to
 * the caller) for accessors anywhere, sparse or anomalous arrays, cycles,
 * functions / symbols / bigint / `undefined` / non-finite numbers, symbol keys,
 * non-plain exotic objects, descriptor/own-key/proxy failures, excessive depth,
 * or an encoded size over the byte budget.
 *
 * The accumulated byte total equals `Buffer.byteLength(JSON.stringify(result),
 * "utf8")` exactly, so it doubles as the aggregate encoded size. Recursion depth
 * is bounded by `maxDepth` (checked before descending), so a hostile deep input
 * fails closed long before it can overflow the call stack.
 */
import type { JsonValue } from "./types.js";

export interface CopyLimits {
  /** Maximum encoded UTF-8 byte size of the whole tree. */
  readonly maxBytes: number;
  /** Maximum nesting depth (the root is depth 0). */
  readonly maxDepth: number;
}

export type CopyResult =
  { readonly ok: true; readonly value: JsonValue; readonly bytes: number } | { readonly ok: false };

/** Internal fail-closed sentinel; never escapes {@link safeJsonCopy}. */
class CopyFail extends Error {}

interface Ctx {
  total: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly onPath: Set<object>;
}

/** True when `key` is a canonical dense array index in `[0, length)`. */
function isCanonicalIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return index < length && index < 0xffffffff;
}

function guard(ctx: Ctx): void {
  if (ctx.total > ctx.maxBytes) throw new CopyFail();
}

function copy(value: unknown, ctx: Ctx, depth: number): JsonValue {
  if (value === null) {
    ctx.total += 4; // "null"
    guard(ctx);
    return null;
  }
  if (typeof value === "boolean") {
    ctx.total += value ? 4 : 5; // "true" / "false"
    guard(ctx);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CopyFail();
    ctx.total += String(value).length; // JSON number form is ASCII
    guard(ctx);
    return value;
  }
  if (typeof value === "string") {
    ctx.total += Buffer.byteLength(JSON.stringify(value), "utf8"); // quotes + escapes
    guard(ctx);
    return value;
  }
  if (typeof value !== "object") {
    // function, symbol, bigint, or undefined → not JSON-representable.
    throw new CopyFail();
  }

  const obj = value;
  if (ctx.onPath.has(obj)) throw new CopyFail(); // cycle
  if (depth >= ctx.maxDepth) throw new CopyFail(); // too deep

  if (Array.isArray(obj)) {
    const lengthDesc = Object.getOwnPropertyDescriptor(obj, "length");
    if (lengthDesc === undefined || !("value" in lengthDesc)) throw new CopyFail();
    const length: unknown = lengthDesc.value;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xffffffff
    ) {
      throw new CopyFail();
    }
    // Own keys must be exactly the dense indices [0, length) plus "length".
    let indexCount = 0;
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key === "symbol") throw new CopyFail();
      if (key === "length") continue;
      if (!isCanonicalIndex(key, length)) throw new CopyFail();
      indexCount += 1;
    }
    if (indexCount !== length) throw new CopyFail(); // sparse / holes / extras
    ctx.total += 2 + (length > 0 ? length - 1 : 0); // "[" "]" + commas
    guard(ctx);
    ctx.onPath.add(obj);
    const out: JsonValue[] = [];
    for (let i = 0; i < length; i += 1) {
      const elementDesc = Object.getOwnPropertyDescriptor(obj, String(i));
      if (elementDesc === undefined || !("value" in elementDesc)) throw new CopyFail(); // hole / accessor
      out.push(copy(elementDesc.value, ctx, depth + 1));
    }
    ctx.onPath.delete(obj);
    return out;
  }

  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) throw new CopyFail(); // exotic / non-plain

  // Two passes so the accumulated bytes match JSON.stringify exactly: framing is
  // added first (keys + colons + commas + braces), then the values are copied.
  const keys: string[] = [];
  const rawValues: unknown[] = [];
  let framing = 0;
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === "symbol") throw new CopyFail(); // unexpected symbol key
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new CopyFail();
    if (typeof desc.get === "function" || typeof desc.set === "function") throw new CopyFail(); // accessor
    if (!desc.enumerable) continue; // JSON.stringify omits non-enumerable props
    framing += Buffer.byteLength(JSON.stringify(key), "utf8") + 1; // key + ":"
    keys.push(key);
    rawValues.push(desc.value);
  }
  ctx.total += 2 + (keys.length > 0 ? keys.length - 1 : 0) + framing; // "{" "}" + commas + keys/colons
  guard(ctx);
  ctx.onPath.add(obj);
  const record: Record<string, JsonValue> = {};
  for (let i = 0; i < keys.length; i += 1) {
    // Define the property directly rather than assigning through `record[key]`.
    // A plain assignment `record["__proto__"] = …` invokes the inherited
    // `Object.prototype.__proto__` setter (mutating the prototype and dropping the
    // key), and `constructor`/`prototype` behave as ordinary keys but are worth
    // the same guarantee: `defineProperty` always creates an OWN enumerable data
    // property, so every JSON key — including `__proto__` — round-trips exactly
    // and the byte accounting stays truthful.
    Object.defineProperty(record, keys[i] as string, {
      value: copy(rawValues[i], ctx, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ctx.onPath.delete(obj);
  return record;
}

/**
 * Recursively freeze a TRUSTED plain-JSON tree in place, returning the same
 * reference deeply immutable. It is only ever called on a value produced by
 * {@link safeJsonCopy} (plain objects/arrays/primitives, already depth-bounded),
 * so it traverses through ordinary property reads safely — there are no getters,
 * proxies, or exotic objects to observe — and cannot recurse unbounded. Used to
 * make the tool schemas retained on the normalized request deeply immutable.
 */
export function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const element of value) deepFreezeJson(element);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreezeJson((value as Record<string, JsonValue>)[key] as JsonValue);
  }
  return Object.freeze(value);
}

/** Copy `root` into a fresh plain-JSON tree, or fail closed. See file header. */
export function safeJsonCopy(root: unknown, limits: CopyLimits): CopyResult {
  const ctx: Ctx = {
    total: 0,
    maxBytes: limits.maxBytes,
    maxDepth: limits.maxDepth,
    onPath: new Set(),
  };
  try {
    const value = copy(root, ctx, 0);
    if (ctx.total > ctx.maxBytes) return { ok: false };
    return { ok: true, value, bytes: ctx.total };
  } catch {
    // A descriptor/own-key/prototype/proxy failure or any fail-closed condition
    // returns cleanly WITHOUT inspecting or serializing the thrown value.
    return { ok: false };
  }
}
