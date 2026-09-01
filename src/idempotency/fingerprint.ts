/**
 * Descriptor-safe canonical body fingerprinting (Phase 4A; specification
 * sections 18, 21.5).
 *
 * "Same body" means the CANONICAL FULL PARSED JSON of the submitted request:
 * JSON whitespace and object-key order are insignificant, array order is
 * significant, and EVERY submitted field participates — including fields the
 * gateway tolerates and discards (e.g. `tools`/`tool_choice` metadata for a
 * text-only model). Two requests therefore share a fingerprint only when they
 * are the same request modulo insignificant JSON formatting.
 *
 * The traversal mirrors the tool engine's `safeJsonCopy` discipline: values are
 * read ONLY through `Object.getOwnPropertyDescriptor` / `Reflect.ownKeys` /
 * `Object.getPrototypeOf`, so a submitted getter, `toJSON`, iterator, Proxy
 * `get` trap, or any other executable hook is never invoked. It fails closed —
 * without inspecting the thrown value — on accessors, cycles, sparse/exotic
 * structures, symbol keys, non-finite numbers, `undefined`/function/symbol/
 * bigint values, and the depth/node/byte bounds. The route maps a failure to a
 * fixed `400 invalid_idempotency_key`.
 *
 * Canonical tokens are streamed straight into an HMAC rather than materialized
 * as a second full copy of the body, and the digest is a KEYED HMAC (never a
 * bare prompt-derived digest), so a stored fingerprint cannot be correlated to
 * prompt content without the gateway's master key (specification section 18).
 *
 * String and object-key encoding is LOSSLESS over the whole JavaScript string
 * domain — including unpaired UTF-16 surrogates — so the fingerprint is
 * injective for every distinct parsed body. See {@link stringToken}.
 *
 * The traversal is ITERATIVE (an explicit work stack), so a deeply nested body
 * can never overflow the call stack before the depth bound rejects it.
 */
import { createHmac, type Hmac } from "node:crypto";
import { MAX_FINGERPRINT_BYTES, MAX_FINGERPRINT_DEPTH, MAX_FINGERPRINT_NODES } from "./limits.js";

/** A body fingerprint, or a fail-closed rejection. */
export type FingerprintResult =
  { readonly ok: true; readonly fingerprint: string } | { readonly ok: false };

/** Internal fail-closed sentinel; never escapes {@link fingerprintRequestBody}. */
class FingerprintFail extends Error {}

/**
 * One unit of pending work. `value` items encode a JSON value; `token` items
 * emit fixed structural punctuation once their children are done.
 */
type WorkItem =
  | { readonly kind: "value"; readonly value: unknown; readonly depth: number }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "pop"; readonly ref: object };

interface Ctx {
  readonly hmac: Hmac;
  bytes: number;
  nodes: number;
  readonly onPath: Set<object>;
}

function emit(ctx: Ctx, token: string): void {
  const size = Buffer.byteLength(token, "utf8");
  ctx.bytes += size;
  if (ctx.bytes > MAX_FINGERPRINT_BYTES) throw new FingerprintFail();
  ctx.hmac.update(token, "utf8");
}

/** True when `key` is a canonical dense array index in `[0, length)`. */
function isCanonicalIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return index < length && index < 0xffffffff;
}

/**
 * The canonical token for a JSON number. `-0` normalizes to `0` so the two
 * spellings of the same JSON value cannot produce different fingerprints.
 */
function numberToken(value: number): string {
  if (!Number.isFinite(value)) throw new FingerprintFail();
  return Object.is(value, -0) ? "0" : String(value);
}

/**
 * Emit a length-prefixed string token that is LOSSLESS for every JavaScript
 * string, including one containing unpaired UTF-16 surrogates.
 *
 * A raw UTF-8 encoding would not be: `"\ud800"`, `"\ud801"`, and a literal
 * `"\ufffd"` all encode to the same three replacement bytes, so three distinct
 * request bodies would share a fingerprint and a repeat could replay a cached
 * answer instead of returning `409`. `JSON.stringify` is well-formed (ES2019):
 * it escapes an unpaired surrogate as `\udXXX` and leaves every other code point
 * literal, so the encoded form is injective over JavaScript strings, its own
 * UTF-8 encoding is lossless, and ordinary text costs no extra bytes.
 *
 * Self-delimitation comes from the QUOTING, not from the length prefix: the
 * encoded form is a quoted JSON string literal, so it ends at its first
 * unescaped `"` and no combination of key and value strings can be re-read as a
 * different structure. The byte-length prefix is redundant belt-and-braces and
 * is kept only as such — do NOT drop the quoting on the assumption that the
 * prefix carries the guarantee.
 */
function stringToken(value: string): string {
  const encoded = JSON.stringify(value);
  return `s${Buffer.byteLength(encoded, "utf8")}:${encoded}`;
}

function pushArray(stack: WorkItem[], ctx: Ctx, obj: object, depth: number): void {
  const lengthDesc = Object.getOwnPropertyDescriptor(obj, "length");
  if (lengthDesc === undefined || !("value" in lengthDesc)) throw new FingerprintFail();
  const length: unknown = lengthDesc.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    throw new FingerprintFail();
  }
  // Own keys must be exactly the dense indices [0, length) plus "length"; a
  // sparse array or an extra own property fails closed.
  let indexCount = 0;
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === "symbol") throw new FingerprintFail();
    if (key === "length") continue;
    if (!isCanonicalIndex(key, length)) throw new FingerprintFail();
    indexCount += 1;
  }
  if (indexCount !== length) throw new FingerprintFail();

  emit(ctx, "[");
  ctx.onPath.add(obj);
  // Children are pushed in reverse so the stack pops them in array order; array
  // order is significant and is preserved exactly.
  stack.push({ kind: "pop", ref: obj });
  stack.push({ kind: "token", token: "]" });
  for (let i = length - 1; i >= 0; i -= 1) {
    const desc = Object.getOwnPropertyDescriptor(obj, String(i));
    if (desc === undefined || !("value" in desc)) throw new FingerprintFail();
    stack.push({ kind: "value", value: desc.value, depth: depth + 1 });
  }
}

function pushObject(stack: WorkItem[], ctx: Ctx, obj: object, depth: number): void {
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) throw new FingerprintFail();

  // Collect own ENUMERABLE data properties. Every JSON object key participates,
  // including `__proto__`, `constructor`, and `prototype`: they are read as
  // ordinary own descriptors and never assigned anywhere, so no prototype is
  // ever consulted or mutated.
  const keys: string[] = [];
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === "symbol") throw new FingerprintFail();
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new FingerprintFail();
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      throw new FingerprintFail();
    }
    if (!desc.enumerable) continue;
    keys.push(key);
    values.set(key, desc.value);
  }
  // Object-key order is insignificant: sort recursively by UTF-16 code unit,
  // which is a total, locale-independent order every replica reproduces.
  keys.sort();

  emit(ctx, "{");
  ctx.onPath.add(obj);
  stack.push({ kind: "pop", ref: obj });
  stack.push({ kind: "token", token: "}" });
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const key = keys[i] as string;
    stack.push({ kind: "value", value: values.get(key), depth: depth + 1 });
    stack.push({ kind: "token", token: `k${stringToken(key)}` });
  }
}

function run(root: unknown, ctx: Ctx): void {
  const stack: WorkItem[] = [{ kind: "value", value: root, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop() as WorkItem;
    if (item.kind === "token") {
      emit(ctx, item.token);
      continue;
    }
    if (item.kind === "pop") {
      ctx.onPath.delete(item.ref);
      continue;
    }

    ctx.nodes += 1;
    if (ctx.nodes > MAX_FINGERPRINT_NODES) throw new FingerprintFail();

    const { value, depth } = item;
    if (value === null) {
      emit(ctx, "n");
      continue;
    }
    const type = typeof value;
    if (type === "boolean") {
      emit(ctx, value === true ? "t" : "f");
      continue;
    }
    if (type === "number") {
      emit(ctx, `#${numberToken(value as number)}`);
      continue;
    }
    if (type === "string") {
      emit(ctx, stringToken(value as string));
      continue;
    }
    if (type !== "object") {
      // undefined, function, symbol, bigint — not JSON-representable.
      throw new FingerprintFail();
    }

    const obj = value as object;
    if (ctx.onPath.has(obj)) throw new FingerprintFail(); // cycle
    if (depth >= MAX_FINGERPRINT_DEPTH) throw new FingerprintFail();

    if (Array.isArray(obj)) pushArray(stack, ctx, obj, depth);
    else pushObject(stack, ctx, obj, depth);
  }
}

/**
 * Compute the keyed canonical fingerprint of a parsed request body.
 *
 * @param body the ORIGINAL parsed body (not the normalized request), so every
 *   submitted field — including tolerated-and-discarded tool metadata — is
 *   covered.
 * @param hmacKey the HKDF-derived body-fingerprint subkey.
 * @returns the base64url digest, or `{ ok: false }` when the body cannot be
 *   canonicalized safely. The thrown value is never inspected or reflected.
 */
export function fingerprintRequestBody(body: unknown, hmacKey: Buffer): FingerprintResult {
  const ctx: Ctx = {
    hmac: createHmac("sha256", hmacKey),
    bytes: 0,
    nodes: 0,
    onPath: new Set(),
  };
  try {
    run(body, ctx);
  } catch {
    return { ok: false };
  }
  return { ok: true, fingerprint: ctx.hmac.digest("base64url") };
}
