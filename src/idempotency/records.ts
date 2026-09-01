/**
 * The versioned Redis idempotency record (Phase 4A; specification sections 18,
 * 22.2).
 *
 * A record is a bounded JSON document stored as the string value at the
 * request's storage key. It carries ONLY opaque coordination metadata:
 *
 *  - `v` record format version;
 *  - `s` state (`reserved` | `processing` | `final` | `ambiguous`);
 *  - `f` keyed body fingerprint;
 *  - `o` random owner token;
 *  - `e` absolute expiry hint, in epoch ms (informational only — Redis `PX` is
 *        authoritative, so a skewed clock can never extend a record's life);
 *  - `p` the encrypted final payload, present only for `final`.
 *
 * It NEVER carries a prompt, a request body, an authorization value, a raw
 * gateway key, a raw idempotency key, a thread title, a Redis URL, or an
 * upstream thread id.
 *
 * Decoding is strict and fail-closed: an unsupported version, an unexpected key,
 * a wrong type, a malformed encoding, or an oversized document is `corrupt`,
 * which the coordinator maps to a fixed `503`. Decoding never inspects a thrown
 * value and never reflects one.
 *
 * The `s` and `o` field names are part of the store contract: the Lua
 * compare-and-transition scripts read exactly those two fields.
 */
import { randomBytes } from "node:crypto";
import type { SealedPayload } from "./crypto.js";
import { MAX_RECORD_BYTES, OWNER_TOKEN_BYTES } from "./limits.js";

/** The only supported record format version. */
export const RECORD_VERSION = 1;

/**
 * The four record states.
 *
 * - `reserved` — claimed, no capacity taken and no upstream call made yet.
 * - `processing` — capacity held; an upstream completion may be in flight.
 * - `final` — the answer is committed and encrypted; repeats replay it.
 * - `ambiguous` — a failure occurred at or after `processing`, so whether the
 *   upstream side effect happened is UNKNOWN. Repeats stay blocked (`503`) for
 *   the configured TTL rather than risking a duplicate completion.
 */
export const RECORD_STATES = ["reserved", "processing", "final", "ambiguous"] as const;
export type RecordState = (typeof RECORD_STATES)[number];

/** A decoded, validated idempotency record. */
export interface IdempotencyRecord {
  readonly v: typeof RECORD_VERSION;
  readonly s: RecordState;
  readonly f: string;
  readonly o: string;
  readonly e: number;
  readonly p?: SealedPayload;
}

/** The result of strictly decoding a stored record. */
export type DecodeRecordResult =
  { readonly ok: true; readonly record: IdempotencyRecord } | { readonly ok: false };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RECORD_KEYS = new Set(["v", "s", "f", "o", "e", "p"]);
const PAYLOAD_KEYS = new Set(["i", "c", "t"]);

/** Mint a fresh, unguessable owner token for one claim attempt. */
export function newOwnerToken(): string {
  return randomBytes(OWNER_TOKEN_BYTES).toString("base64url");
}

function isBase64Url(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    BASE64URL.test(value)
  );
}

function isRecordState(value: unknown): value is RecordState {
  return typeof value === "string" && (RECORD_STATES as readonly string[]).includes(value);
}

function decodeSealed(value: unknown): SealedPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== PAYLOAD_KEYS.size) return null;
  for (const key of keys) if (!PAYLOAD_KEYS.has(key)) return null;
  const candidate = value as Record<string, unknown>;
  // The ciphertext bound mirrors the record bound; an oversized field is caught
  // by the record byte cap before this point, so a generous cap is safe here.
  if (!isBase64Url(candidate["i"], 64)) return null;
  if (!isBase64Url(candidate["c"], MAX_RECORD_BYTES)) return null;
  if (!isBase64Url(candidate["t"], 64)) return null;
  return { i: candidate["i"], c: candidate["c"], t: candidate["t"] };
}

/** Serialize a record. The caller must reject an over-budget result. */
export function encodeRecord(record: IdempotencyRecord): string {
  return JSON.stringify(record);
}

/**
 * Strictly decode a stored record value.
 *
 * Rejects (as `{ ok: false }`) an oversized document, malformed JSON, a
 * non-object root, an unknown or missing key, an unsupported version or state,
 * a non-base64url fingerprint/owner, a non-integer expiry, a `p` on a
 * non-`final` record, and a `final` record with no `p`.
 */
export function decodeRecord(raw: string): DecodeRecordResult {
  if (typeof raw !== "string") return { ok: false };
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) return { ok: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };

  const keys = Object.keys(parsed);
  for (const key of keys) if (!RECORD_KEYS.has(key)) return { ok: false };
  const candidate = parsed as Record<string, unknown>;

  if (candidate["v"] !== RECORD_VERSION) return { ok: false };
  const state: unknown = candidate["s"];
  if (!isRecordState(state)) return { ok: false };
  const fingerprint: unknown = candidate["f"];
  if (!isBase64Url(fingerprint, 128)) return { ok: false };
  const owner: unknown = candidate["o"];
  if (!isBase64Url(owner, 128)) return { ok: false };
  const expiry: unknown = candidate["e"];
  if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry < 0) {
    return { ok: false };
  }

  const hasPayload = Object.hasOwn(candidate, "p");
  if (state === "final") {
    if (!hasPayload) return { ok: false };
    const sealed = decodeSealed(candidate["p"]);
    if (sealed === null) return { ok: false };
    return {
      ok: true,
      record: { v: RECORD_VERSION, s: state, f: fingerprint, o: owner, e: expiry, p: sealed },
    };
  }
  if (hasPayload) return { ok: false };
  return { ok: true, record: { v: RECORD_VERSION, s: state, f: fingerprint, o: owner, e: expiry } };
}

/** Build an active (`reserved` / `processing`) or `ambiguous` record. */
export function buildRecord(input: {
  readonly state: Exclude<RecordState, "final">;
  readonly fingerprint: string;
  readonly owner: string;
  readonly expiresAtMs: number;
}): IdempotencyRecord {
  return {
    v: RECORD_VERSION,
    s: input.state,
    f: input.fingerprint,
    o: input.owner,
    e: input.expiresAtMs,
  };
}

/** Build a committed `final` record carrying the encrypted answer. */
export function buildFinalRecord(input: {
  readonly fingerprint: string;
  readonly owner: string;
  readonly expiresAtMs: number;
  readonly payload: SealedPayload;
}): IdempotencyRecord {
  return {
    v: RECORD_VERSION,
    s: "final",
    f: input.fingerprint,
    o: input.owner,
    e: input.expiresAtMs,
    p: input.payload,
  };
}
