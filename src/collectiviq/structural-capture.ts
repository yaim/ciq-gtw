/**
 * Sanitized structural capture for discovery.
 *
 * Turns an arbitrary (untrusted) upstream JSON value into a shape-only
 * description that preserves USEFUL STRUCTURE while retaining NO values.
 *
 * Guarantees:
 * - Every value collapses to a constant type marker (`<string>`, `<number>`,
 *   `<boolean>`, `<null>`, `<object>`, `<array>`); no value contents and no
 *   value LENGTHS are ever emitted.
 * - Ordinary, safe field names are preserved so the shape is legible, but any
 *   reserved / credential-like / content-bearing / non-identifier name becomes
 *   a positional placeholder (`field_0`, `field_1`, ...). Placeholders are
 *   assigned by sorted original-key order so output is deterministic.
 * - Recursion depth, object width, array width, and total serialized size are
 *   bounded; truncation is a constant marker that never reveals omitted counts.
 * - Cycles, sparse-array holes, accessor properties, Proxies, and throwing
 *   descriptor inspection all fail closed to fixed markers. An array's length is
 *   itself read once through its own data descriptor; a missing, accessor,
 *   invalid, or throwing length descriptor collapses the array to a fixed
 *   failure marker. No accessor or Proxy `get` trap is ever invoked.
 *
 * This is the only representation of a live response the discovery tooling may
 * persist, and even then only under the ignored `.agent/sessions/` directory.
 * The evidence version stamped onto full discovery reports and persisted files
 * is {@link STRUCTURAL_CAPTURE_FORMAT}.
 */

/** Explicit, exported evidence-format version for captured discovery structure. */
export const STRUCTURAL_CAPTURE_FORMAT = 2 as const;

export interface CaptureLimits {
  readonly maxDepth: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
  readonly maxOutputBytes: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxDepth: 6,
  maxArrayItems: 20,
  maxObjectKeys: 40,
  maxOutputBytes: 16_384,
};

const MARKERS = {
  string: "<string>",
  number: "<number>",
  boolean: "<boolean>",
  null: "<null>",
  object: "<object>",
  array: "<array>",
  hole: "<hole>",
  truncated: "<truncated>",
  unsupported: "<unsupported>",
  circular: "<circular>",
  error: "<capture-error>",
} as const;

/** Identifier-like field names are the only names eligible for preservation. */
const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Case-insensitive substrings that mark a name as credential-like or
 * content-bearing. Any match forces a positional placeholder.
 */
const DENY_SUBSTRINGS = [
  "authorization",
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "bearer",
  "credential",
  "prompt",
  "content",
  "answer",
  "message",
  "email",
  "ssn",
] as const;

/** Names that must never survive as output keys (prototype-pollution / reserved). */
const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor", "__truncated__"]);

/** The output namespace reserved for generated positional placeholders. */
const PLACEHOLDER_NAME_RE = /^field_\d+$/;

function isSafeFieldName(name: string): boolean {
  if (!SAFE_NAME_RE.test(name)) return false;
  if (RESERVED_NAMES.has(name)) return false;
  // Never preserve a real key that collides with the generated placeholder or
  // truncation namespace; those keys become positional placeholders instead, so
  // preserved names and generated markers can never overwrite one another.
  if (PLACEHOLDER_NAME_RE.test(name)) return false;
  const lower = name.toLowerCase();
  for (const bad of DENY_SUBSTRINGS) {
    if (lower.includes(bad)) return false;
  }
  return true;
}

function describeScalar(value: unknown): string {
  if (value === null) return MARKERS.null;
  const type = typeof value;
  if (type === "string") return MARKERS.string;
  if (type === "number") return MARKERS.number;
  if (type === "boolean") return MARKERS.boolean;
  // bigint, symbol, function, undefined, etc. are never valid JSON.
  return MARKERS.unsupported;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read an array's `length` exactly once through its own property descriptor.
 * Returns the length only when it is an own DATA descriptor holding a
 * nonnegative safe integer; a missing, accessor, invalid, or throwing descriptor
 * yields `null` so the caller can fail closed. This never triggers a Proxy `get`
 * trap or an accessor — only a `getOwnPropertyDescriptor` inspection. Exported so
 * the correlation extractor shares one descriptor-safe length reader.
 */
export function readOwnArrayLength(arr: unknown[]): number | null {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(arr, "length");
  } catch {
    return null;
  }
  if (descriptor === undefined) return null;
  if ("get" in descriptor || "set" in descriptor) return null;
  const length: unknown = descriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return null;
  return length;
}

function captureArray(
  arr: unknown[],
  depth: number,
  limits: CaptureLimits,
  seen: WeakSet<object>,
): unknown {
  const length = readOwnArrayLength(arr);
  // A hostile or exotic length (accessor/missing/non-integer/throwing) fails closed.
  if (length === null) return MARKERS.error;
  const out: unknown[] = [];
  const limit = Math.min(length, limits.maxArrayItems);
  for (let i = 0; i < limit; i += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(arr, String(i));
    } catch {
      out.push(MARKERS.error);
      continue;
    }
    if (descriptor === undefined) {
      // Sparse-array hole: the index has no own property.
      out.push(MARKERS.hole);
      continue;
    }
    if ("get" in descriptor || "set" in descriptor) {
      // Never invoke accessors.
      out.push(MARKERS.unsupported);
      continue;
    }
    out.push(captureInner(descriptor.value, depth + 1, limits, seen));
  }
  if (length > limits.maxArrayItems) out.push(MARKERS.truncated);
  return out;
}

function captureObject(
  obj: object,
  depth: number,
  limits: CaptureLimits,
  seen: WeakSet<object>,
): unknown {
  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    return MARKERS.error;
  }
  // Deterministic ordering: sort original keys, then assign positional
  // placeholders by that sorted order so unsafe names never leak position info.
  keys.sort();
  const out: Record<string, unknown> = {};
  const limit = Math.min(keys.length, limits.maxObjectKeys);
  for (let i = 0; i < limit; i += 1) {
    const originalKey = keys[i] as string;
    const outKey = isSafeFieldName(originalKey) ? originalKey : `field_${i}`;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(obj, originalKey);
    } catch {
      out[outKey] = MARKERS.error;
      continue;
    }
    if (descriptor === undefined) {
      out[outKey] = MARKERS.unsupported;
      continue;
    }
    if ("get" in descriptor || "set" in descriptor) {
      out[outKey] = MARKERS.unsupported;
      continue;
    }
    out[outKey] = captureInner(descriptor.value, depth + 1, limits, seen);
  }
  if (keys.length > limits.maxObjectKeys) out["__truncated__"] = MARKERS.truncated;
  return out;
}

function captureInner(
  value: unknown,
  depth: number,
  limits: CaptureLimits,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") return describeScalar(value);

  const obj = value;
  const isArray = Array.isArray(obj);
  if (depth >= limits.maxDepth) return isArray ? MARKERS.array : MARKERS.object;
  if (seen.has(obj)) return MARKERS.circular;

  seen.add(obj);
  try {
    if (isArray) return captureArray(obj as unknown[], depth, limits, seen);
    // Non-plain objects (Map, Set, Date, class instances, Proxies with exotic
    // prototypes) are not safe to enumerate as data; fail closed.
    if (!isPlainObject(obj)) return MARKERS.unsupported;
    return captureObject(obj, depth, limits, seen);
  } catch {
    // A hostile Proxy or throwing trap collapses to a constant marker.
    return MARKERS.error;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Produce a sanitized structural summary of `value`. On any internal failure or
 * when the serialized result would exceed `maxOutputBytes`, returns a fixed
 * marker rather than risking a larger or partially-original capture.
 */
export function captureStructure(
  value: unknown,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): unknown {
  try {
    const summary = captureInner(value, 0, limits, new WeakSet());
    const bytes = Buffer.byteLength(JSON.stringify(summary) ?? "", "utf8");
    if (bytes > limits.maxOutputBytes) return MARKERS.truncated;
    return summary;
  } catch {
    return MARKERS.error;
  }
}
