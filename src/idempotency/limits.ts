/**
 * Conservative, non-overridable bounds for the optional Redis-backed
 * idempotency layer (Phase 4A; specification sections 18, 21.6, 22.2).
 *
 * These are the single source of truth for every bound the idempotency boundary
 * enforces. They are initial implementation safety limits: relaxing one is a
 * configuration-contract/security change, not a runtime override.
 */
import { MAX_REQUEST_BODY_BYTES_MAX } from "../config/schema.js";

/** Maximum accepted `Idempotency-Key` header size, in bytes. */
export const MAX_IDEMPOTENCY_KEY_BYTES = 255;
/** Minimum accepted `Idempotency-Key` header size, in bytes. */
export const MIN_IDEMPOTENCY_KEY_BYTES = 1;

/**
 * Maximum nesting depth traversed while fingerprinting a request body.
 *
 * Unlike the node and byte bounds below this one is NOT sized to admit every
 * accepted body: a 512-deep structure is pathological, and rejecting it is the
 * point. A body that exceeds it is refused with `invalid_idempotency_key`
 * (specification §18.1), which is stricter than the same body would be treated
 * WITHOUT an `Idempotency-Key`.
 */
export const MAX_FINGERPRINT_DEPTH = 512;

/**
 * Maximum number of JSON nodes visited while fingerprinting a request body.
 *
 * Sized so the BYTE bound below binds first for any body within the DEFAULT
 * request-body limit (8 MiB): the densest possible node is a one-character
 * array element, so ~4.2M nodes is the most an 8 MiB body can carry, and this
 * ceiling clears that with margin. It remains a real work bound for a
 * deployment that raises `MAX_REQUEST_BODY_BYTES` toward its 64 MiB maximum.
 */
export const MAX_FINGERPRINT_NODES = 8_000_000;

/**
 * Maximum canonical token bytes hashed for one body fingerprint.
 *
 * Strictly DOMINATES the largest configurable request body
 * (`MAX_REQUEST_BODY_BYTES_MAX`), because the canonical token stream is always
 * somewhat larger than the minified body it encodes — every token carries fixed
 * framing. Sizing the two equally would refuse a body at the very top of the
 * configurable range that the gateway otherwise accepts. The measured worst-case
 * expansion is well under 2x (framing on many tiny strings dominates; escape-heavy
 * content does not expand, since a lone surrogate costs six bytes in the body and
 * six bytes encoded).
 */
export const MAX_FINGERPRINT_BYTES = 2 * MAX_REQUEST_BODY_BYTES_MAX;

/** Maximum stored Redis record size, in bytes (record JSON, ciphertext included). */
export const MAX_RECORD_BYTES = 8_388_608; // 8 MiB

/**
 * Maximum decrypted cached-payload size, in bytes.
 *
 * Derived from {@link MAX_RECORD_BYTES} rather than set independently: the
 * payload is sealed and then base64url encoded (~4/3 expansion) inside a JSON
 * record that also carries the fixed metadata fields. A payload ceiling equal to
 * the record ceiling could therefore never bind — the record cap would always
 * trip first, turning an oversized answer into an opaque `503` plus a blocked
 * key instead of the documented payload bound.
 */
const RECORD_FRAMING_BYTES = 1024;
export const MAX_PAYLOAD_BYTES = Math.floor(((MAX_RECORD_BYTES - RECORD_FRAMING_BYTES) * 3) / 4);

/**
 * Lease held by a `reserved` record — claimed, but with NO upstream work done
 * yet. It is deliberately short: an orphaned claim (a replica that died between
 * the claim and the state transition, or a claim whose result was unknown to its
 * own client) must free the key quickly. Losing a `reserved` lease is SAFE: the
 * original owner's `reserved → processing` transition is owner-token guarded, so
 * it reports `lost` and aborts rather than proceeding to an upstream call.
 */
export const RESERVED_LEASE_MS = 30_000;

/**
 * Extra lease granted to a `processing` record beyond the request's own total
 * deadline, and the absolute ceiling on that lease.
 *
 * Losing a `processing` lease is NOT safe: an upstream completion may be in
 * flight, so another replica claiming the key would duplicate billed work. A
 * lease derived from the model's `requestTimeoutMs` means a LIVE owner's record
 * cannot expire while it is legitimately working — even under event-loop
 * starvation that delays lease renewal — because the owner's own deadline fires
 * first. The lease then degenerates to a crash reaper, which is all it should
 * be: a hard-killed owner blocks its key for at most this long instead of
 * risking a duplicate completion.
 */
export const PROCESSING_LEASE_MARGIN_MS = 30_000;
/** Ceiling for a `processing` lease (the maximum model deadline plus the margin). */
export const MAX_PROCESSING_LEASE_MS = 630_000;

/** Owner lease-renewal cadence. Three renewals fit inside the shortest lease. */
export const LEASE_RENEW_INTERVAL_MS = 10_000;

/** Initial waiter poll delay, in ms. */
export const WAIT_POLL_INITIAL_MS = 100;
/** Waiter poll backoff multiplier. */
export const WAIT_POLL_BACKOFF = 1.25;
/** Maximum waiter poll delay, in ms (before jitter). */
export const WAIT_POLL_MAX_MS = 1_000;
/** Maximum additional jitter applied to a waiter poll delay, as a fraction. */
export const WAIT_POLL_JITTER = 0.25;
/**
 * Absolute ceiling on waiter poll iterations, independent of the deadline.
 *
 * The deadline normally ends a wait (the longest configurable model timeout is
 * 600 s, which is at most ~6000 polls at the 100 ms floor). This bound is a
 * fail-closed backstop against a stalled or non-monotonic clock, so the loop can
 * never spin unboundedly.
 */
export const MAX_WAIT_POLLS = 10_000;

// The Redis CONNECTION bounds (command/connect/reconnect/close deadlines) are
// shared by every Redis-backed feature and live in `src/redis/limits.ts`.

/** Owner-token size, in bytes (128 bits of randomness). */
export const OWNER_TOKEN_BYTES = 16;
/** AES-GCM nonce size, in bytes (96 bits, per NIST SP 800-38D). */
export const GCM_NONCE_BYTES = 12;
/** AES-GCM authentication-tag size, in bytes. */
export const GCM_TAG_BYTES = 16;
