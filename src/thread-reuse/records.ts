/**
 * The versioned Redis thread-reuse record (Phase 5A; specification sections
 * 5.1.1, 22.2).
 *
 * A record is a small bounded JSON document stored as the string value at the
 * mapping's storage key. It carries ONLY opaque coordination metadata:
 *
 *  - `v` record format version;
 *  - `s` state (`reserved` | `processing` | `committed` | `active` |
 *        `ambiguous`);
 *  - `o` random owner token;
 *  - `l` absolute lease deadline in epoch ms, or `0` when the record is
 *        unleased (`committed` / `active` / `ambiguous`). Unlike the idempotency
 *        record's informational expiry hint this field is AUTHORITATIVE: it is
 *        written and compared inside Lua against Redis's own `TIME`, because
 *        Redis `PX` holds the record's LIFETIME, not the lease — a leased record
 *        is deliberately given enough lifetime to outlive its own lease;
 *  - `p` the sealed upstream thread id, present only when a thread is bound.
 *
 * It NEVER carries a session id, a gateway key, an upstream credential, a
 * prompt, an answer, a thread title, a model id, an origin, a Redis URL, or a
 * plaintext thread id.
 *
 * Decoding is strict and fail-closed: an unsupported version, an unexpected
 * key, a wrong type, a malformed encoding, an oversized document, or a
 * state/field combination the state machine can never produce is `corrupt`,
 * which the coordinator maps to a fixed `503`. Decoding never inspects a thrown
 * value and never reflects one.
 *
 * The `v`, `s`, `o`, `l`, and `p` field names are part of the store contract:
 * the Lua scripts read and rebuild exactly these fields.
 */
import { randomBytes } from "node:crypto";
import type { SealedThread } from "./crypto.js";
import { MAX_REUSE_RECORD_BYTES, OWNER_TOKEN_BYTES } from "./limits.js";

/** The only supported record format version. */
export const REUSE_RECORD_VERSION = 1;

/**
 * The five mapping states.
 *
 * - `reserved` — a request holds the lease but has not submitted. A thread may
 *   already be bound (carried over from `active`, or just created).
 * - `processing` — `process_message` is about to run, is running, or may have
 *   run. A thread is always bound.
 * - `committed` — the commit mutation LANDED: the mapping's next state is
 *   decided, but `committed → active` has not been confirmed. Note the stored
 *   state says nothing about the client: the answer is authorized for emission
 *   only once the COORDINATOR positively acknowledged the commit, so a commit
 *   whose reply was lost leaves this state behind with no answer emitted at all.
 *   It is deliberately NOT acquirable either way: a later turn must never
 *   continue from a mapping whose terminal transition the gateway could not
 *   confirm. Bounded by {@link REUSE_COMMITTED_TTL_MS}, after which the session
 *   starts fresh.
 * - `active` — idle and reusable: a bound thread, no owner lease. This is the
 *   only state a later turn may continue from.
 * - `ambiguous` — a failure occurred once `process_message` may have been
 *   attempted, so the thread's contents are UNKNOWN. Repeats stay blocked
 *   (`503`) until the ambiguous TTL elapses, rather than risking a stale answer
 *   or a silent replacement thread. Never carries a thread id.
 *
 * `committed` exists because a single-step `processing → active` transition is
 * unsafe when Redis APPLIES the mutation but its reply is lost: the request
 * would report `503` while the mapping silently became reusable, and a later
 * turn would continue a thread whose last answer was never delivered. Splitting
 * the terminal step means the intermediate state is non-acquirable, so an
 * unacknowledged commit can only ever block — never leak a reusable mapping.
 */
export const REUSE_RECORD_STATES = [
  "reserved",
  "processing",
  "committed",
  "active",
  "ambiguous",
] as const;
export type ReuseRecordState = (typeof REUSE_RECORD_STATES)[number];

/** A decoded, validated thread-reuse record. */
export interface ThreadReuseRecord {
  readonly v: typeof REUSE_RECORD_VERSION;
  readonly s: ReuseRecordState;
  readonly o: string;
  readonly l: number;
  readonly p?: SealedThread;
}

/** The result of strictly decoding a stored record. */
export type DecodeReuseRecordResult =
  { readonly ok: true; readonly record: ThreadReuseRecord } | { readonly ok: false };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RECORD_KEYS = new Set(["v", "s", "o", "l", "p"]);
const SEALED_KEYS = new Set(["i", "c", "t"]);

/** Mint a fresh, unguessable owner token for one lease attempt. */
export function newReuseOwnerToken(): string {
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

function isReuseRecordState(value: unknown): value is ReuseRecordState {
  return typeof value === "string" && (REUSE_RECORD_STATES as readonly string[]).includes(value);
}

function decodeSealed(value: unknown): SealedThread | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== SEALED_KEYS.size) return null;
  for (const key of keys) if (!SEALED_KEYS.has(key)) return null;
  const candidate = value as Record<string, unknown>;
  // The whole record is already bounded by MAX_REUSE_RECORD_BYTES, so these
  // per-field caps only have to exclude absurd shapes within that budget.
  if (!isBase64Url(candidate["i"], 64)) return null;
  if (!isBase64Url(candidate["c"], MAX_REUSE_RECORD_BYTES)) return null;
  if (!isBase64Url(candidate["t"], 64)) return null;
  return { i: candidate["i"], c: candidate["c"], t: candidate["t"] };
}

/** Serialize a record. Only used by tests and fakes; production writes are Lua. */
export function encodeReuseRecord(record: ThreadReuseRecord): string {
  return JSON.stringify(record);
}

/**
 * Strictly decode a stored record value.
 *
 * Rejects (as `{ ok: false }`) an oversized document, malformed JSON, a
 * non-object root, an unknown or missing key, an unsupported version or state,
 * a non-base64url owner, a non-integer or negative lease deadline, a malformed
 * sealed payload, and every state/field combination the state machine cannot
 * produce: a leased `active`/`ambiguous` record, an unleased
 * `reserved`/`processing` record, an `active` or `processing` record with no
 * bound thread, and an `ambiguous` record that still carries one.
 */
export function decodeReuseRecord(raw: string): DecodeReuseRecordResult {
  if (typeof raw !== "string") return { ok: false };
  if (Buffer.byteLength(raw, "utf8") > MAX_REUSE_RECORD_BYTES) return { ok: false };

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

  if (candidate["v"] !== REUSE_RECORD_VERSION) return { ok: false };
  const state: unknown = candidate["s"];
  if (!isReuseRecordState(state)) return { ok: false };
  const owner: unknown = candidate["o"];
  if (!isBase64Url(owner, 128)) return { ok: false };
  const lease: unknown = candidate["l"];
  if (typeof lease !== "number" || !Number.isSafeInteger(lease) || lease < 0) {
    return { ok: false };
  }

  // Only the two states an owner actively holds carry a lease deadline; every
  // terminal state has none, so a stray lease is an impossible record.
  const leased = state === "reserved" || state === "processing";
  if (leased && lease === 0) return { ok: false };
  if (!leased && lease !== 0) return { ok: false };

  const hasPayload = Object.hasOwn(candidate, "p");
  // `ambiguous` deliberately drops the thread: it is never reused, so keeping
  // it would leave encrypted upstream state at rest for no purpose.
  if (state === "ambiguous" && hasPayload) return { ok: false };
  // A mapping cannot be `active` (reusable), `committed` (terminal, pending
  // acknowledgement), or `processing` (submitting) without the thread it refers to.
  if (state !== "reserved" && state !== "ambiguous" && !hasPayload) return { ok: false };

  if (!hasPayload) {
    return { ok: true, record: { v: REUSE_RECORD_VERSION, s: state, o: owner, l: lease } };
  }
  const sealed = decodeSealed(candidate["p"]);
  if (sealed === null) return { ok: false };
  return {
    ok: true,
    record: { v: REUSE_RECORD_VERSION, s: state, o: owner, l: lease, p: sealed },
  };
}
