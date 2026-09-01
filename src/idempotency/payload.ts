/**
 * The versioned cached-completion payload (Phase 4A).
 *
 * This is the ONLY content the gateway persists, and it is always encrypted
 * before it reaches Redis (`crypto.ts`). It carries exactly what a replay must
 * reproduce:
 *
 *  - the ORIGINAL completion id and Unix creation time, so a replay is
 *    byte-identical in identity to the first response;
 *  - the requested virtual-model id, echoed verbatim;
 *  - the trusted result discriminator, and either the assistant text or the
 *    validated tool calls.
 *
 * It deliberately does NOT carry the upstream thread id: native-title
 * correlation is process-local to the original owner (specification section
 * 9.5), and Redis retention is never expanded merely to recover it.
 *
 * Decoding is strict and fail-closed; a malformed payload is treated exactly
 * like a corrupt record.
 */
import type { ParsedToolCall } from "../tools/index.js";
import { MAX_PAYLOAD_BYTES } from "./limits.js";

/** The only supported payload format version. */
export const PAYLOAD_VERSION = 1;

/**
 * A completion result in the form the OpenAI encoders need. Structurally a
 * `CompletionResult` minus its internal `upstreamThreadId`, so a live result
 * satisfies it directly.
 */
export type CachedResult =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "tool_calls"; readonly toolCalls: readonly ParsedToolCall[] };

/** A decoded cached completion: original identity plus the trusted result. */
export interface CachedCompletion {
  /** The ORIGINAL `chatcmpl_ciq_*` id (never a duplicate request's fresh id). */
  readonly id: string;
  /** The ORIGINAL Unix-seconds creation time. */
  readonly created: number;
  /** The requested virtual-model id. */
  readonly model: string;
  /** The trusted text or tool-call result. */
  readonly result: CachedResult;
}

const PAYLOAD_KEYS = new Set(["v", "id", "c", "m", "k", "t", "l"]);
const CALL_KEYS = new Set(["i", "n", "a"]);

/** Serialize a cached completion into the plaintext that gets sealed. */
export function encodeCachedCompletion(cached: CachedCompletion): string {
  const base = { v: PAYLOAD_VERSION, id: cached.id, c: cached.created, m: cached.model };
  if (cached.result.kind === "tool_calls") {
    return JSON.stringify({
      ...base,
      k: "tool_calls",
      l: cached.result.toolCalls.map((call) => ({
        i: call.id,
        n: call.name,
        a: call.argumentsJson,
      })),
    });
  }
  return JSON.stringify({ ...base, k: "text", t: cached.result.content });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeToolCalls(value: unknown): ParsedToolCall[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries: readonly unknown[] = value;
  const calls: ParsedToolCall[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== CALL_KEYS.size) return null;
    for (const key of keys) if (!CALL_KEYS.has(key)) return null;
    const call = entry as Record<string, unknown>;
    if (!isNonEmptyString(call["i"])) return null;
    if (!isNonEmptyString(call["n"])) return null;
    if (typeof call["a"] !== "string") return null;
    calls.push({ id: call["i"], name: call["n"], argumentsJson: call["a"] });
  }
  return calls;
}

/**
 * Strictly decode a decrypted payload. Returns `null` — never throws — for an
 * oversized document, malformed JSON, an unsupported version, an unknown or
 * missing key, a wrong type, or a discriminator that disagrees with the fields
 * present.
 */
export function decodeCachedCompletion(plaintext: string): CachedCompletion | null {
  if (typeof plaintext !== "string") return null;
  if (Buffer.byteLength(plaintext, "utf8") > MAX_PAYLOAD_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  for (const key of Object.keys(parsed)) if (!PAYLOAD_KEYS.has(key)) return null;
  const candidate = parsed as Record<string, unknown>;

  if (candidate["v"] !== PAYLOAD_VERSION) return null;
  if (!isNonEmptyString(candidate["id"])) return null;
  const created: unknown = candidate["c"];
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) return null;
  if (!isNonEmptyString(candidate["m"])) return null;

  const kind: unknown = candidate["k"];
  const identity = { id: candidate["id"], created, model: candidate["m"] } as const;

  if (kind === "text") {
    if (Object.hasOwn(candidate, "l")) return null;
    const content: unknown = candidate["t"];
    // An empty answer is a legitimate completion, so only the TYPE is required.
    if (typeof content !== "string") return null;
    return { ...identity, result: { kind: "text", content } };
  }
  if (kind === "tool_calls") {
    if (Object.hasOwn(candidate, "t")) return null;
    const calls = decodeToolCalls(candidate["l"]);
    if (calls === null) return null;
    return { ...identity, result: { kind: "tool_calls", toolCalls: calls } };
  }
  return null;
}
