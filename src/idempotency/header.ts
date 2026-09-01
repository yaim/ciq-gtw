/**
 * `Idempotency-Key` request-header normalization (Phase 4A; specification
 * section 18).
 *
 * The header is the ONE optional public input the idempotency layer accepts. It
 * is opaque to the gateway: the value is never logged, reflected in a response,
 * or stored. Only a keyed HMAC of it ever reaches Redis.
 *
 * A value is accepted only when it is a single header occurrence holding 1–255
 * bytes of visible ASCII (`0x21`–`0x7E`). Space and every control character are
 * excluded, which also rejects the `", "`-joined form Node produces for a
 * duplicated header; `rawHeaders` is additionally counted when available so a
 * duplicate is rejected on its own terms.
 */
import { MAX_IDEMPOTENCY_KEY_BYTES, MIN_IDEMPOTENCY_KEY_BYTES } from "./limits.js";

/** The canonical lowercase header name Node/Fastify expose. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * The outcome of reading the header.
 *
 * - `absent`: no header was supplied; the request keeps its current behaviour.
 * - `key`: a single well-formed value, preserved byte-for-byte.
 * - `invalid`: present but unusable (array/duplicate/empty/oversized/illegal
 *   character). The route maps this to a fixed `400 invalid_idempotency_key`;
 *   the submitted value is never included.
 */
export type IdempotencyHeaderResult =
  | { readonly kind: "absent" }
  | { readonly kind: "key"; readonly value: string }
  | { readonly kind: "invalid" };

const ABSENT: IdempotencyHeaderResult = { kind: "absent" };
const INVALID: IdempotencyHeaderResult = { kind: "invalid" };

/** True when every character is visible ASCII (`0x21`–`0x7E`, so no space/control). */
function isVisibleAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Count occurrences of the header in Node's flat `rawHeaders` array (name,
 * value, name, value, …). Returns `null` when the array is unavailable or not
 * the expected shape, so callers fall back to the character rules alone.
 */
function countRawOccurrences(rawHeaders: unknown): number | null {
  if (!Array.isArray(rawHeaders)) return null;
  const entries: readonly unknown[] = rawHeaders;
  let count = 0;
  for (let i = 0; i < entries.length; i += 2) {
    const name = entries[i];
    if (typeof name === "string" && name.toLowerCase() === IDEMPOTENCY_KEY_HEADER) count += 1;
  }
  return count;
}

/**
 * Normalize the supplied header value.
 *
 * @param raw the value from `request.headers["idempotency-key"]`.
 * @param rawHeaders optional `request.raw.rawHeaders`, used only to reject a
 *   duplicated header explicitly. Absent/malformed input is ignored safely.
 */
export function readIdempotencyKeyHeader(
  raw: string | readonly string[] | undefined,
  rawHeaders?: readonly string[],
): IdempotencyHeaderResult {
  if (raw === undefined) return ABSENT;
  // A duplicated header is never a usable key. Node normally joins duplicates
  // into one comma-space string (rejected by the character rule below), but some
  // stacks surface an array instead.
  if (Array.isArray(raw)) return INVALID;
  if (typeof raw !== "string") return INVALID;

  const occurrences = countRawOccurrences(rawHeaders);
  if (occurrences !== null && occurrences > 1) return INVALID;

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes < MIN_IDEMPOTENCY_KEY_BYTES || bytes > MAX_IDEMPOTENCY_KEY_BYTES) return INVALID;
  if (!isVisibleAscii(raw)) return INVALID;
  // Preserved EXACTLY: no trimming, casing change, or other normalization.
  return { kind: "key", value: raw };
}
