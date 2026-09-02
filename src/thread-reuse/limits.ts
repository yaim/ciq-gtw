/**
 * Conservative, non-overridable bounds and fixed timings for the OPTIONAL
 * Redis-backed OpenCode thread reuse layer (Phase 5A; specification sections
 * 5.1.1, 21.6, 22.2).
 *
 * These are the single source of truth for every bound this boundary enforces.
 * They are initial implementation safety limits: relaxing one is a
 * configuration-contract/security change, not a runtime override. Only the
 * sliding mapping TTL is configurable (`OPENCODE_THREAD_REUSE_TTL_MS`); every
 * value here is fixed.
 */

/**
 * Lease held by a `reserved` mapping — claimed, but with NO submit yet.
 *
 * A mapping is single-writer by construction: exactly one in-flight completion
 * may address a session's upstream thread, because a second concurrent request
 * for the same mapping is rejected with `409 thread_reuse_busy` rather than
 * queued. The lease is what makes that true across replicas AND lets a
 * hard-killed owner be recovered.
 *
 * Losing a `reserved` lease is SAFE, which is why it can be short: the original
 * owner's `reserved → processing` transition is owner-token guarded, so a
 * starved owner that wakes up after a takeover reports `lost` and aborts rather
 * than submitting. No path submits without that transition succeeding first.
 */
export const REUSE_LEASE_MS = 30_000;

/**
 * Extra lease granted to a `processing` mapping beyond the request's own total
 * deadline, and the absolute ceiling on that lease.
 *
 * Losing a `processing` lease is NOT safe in the same way. The owner may be
 * legitimately mid-completion for as long as its model's `requestTimeoutMs`
 * allows, and an expiry would tombstone the mapping as `ambiguous` underneath a
 * healthy request — blocking the session for the ambiguous TTL and failing a
 * completion that was about to succeed. Renewal alone is not enough, because the
 * event-loop starvation that delays renewals is exactly the condition under
 * which this happens.
 *
 * So, mirroring the Phase 4A processing lease (`src/idempotency/limits.ts`), the
 * lease is derived from the request's own deadline: a LIVE owner's mapping
 * cannot expire mid-completion because the owner's own deadline fires first. The
 * lease then degenerates to a crash reaper, which is all it should be.
 */
export const REUSE_PROCESSING_LEASE_MARGIN_MS = 30_000;
/** Ceiling for a `processing` lease (the maximum model deadline plus the margin). */
export const MAX_REUSE_PROCESSING_LEASE_MS = 630_000;

/** Owner lease-renewal cadence. Three renewals fit inside the shortest lease. */
export const REUSE_LEASE_RENEW_INTERVAL_MS = 10_000;

/**
 * How long a mapping stays BLOCKED after a failure that may have submitted.
 *
 * Once `process_message` may have been attempted, whether the upstream thread
 * now holds an extra prompt — and an extra answer that a later turn's delta
 * poll would have to distinguish — is UNKNOWN. Reusing the thread in that state
 * risks returning the abandoned turn's answer, and creating a replacement
 * thread silently would break the session's continuity guarantee. The mapping is
 * therefore held `ambiguous` and every request for it fails closed with `503`
 * until this window elapses, after which the next request starts a fresh thread.
 */
export const REUSE_AMBIGUOUS_TTL_MS = 900_000;

/**
 * How long a `committed` record survives when its activation could not be
 * confirmed.
 *
 * `committed` is the first half of the two-step terminal transition: the commit
 * mutation landed, but `committed → active` was never positively acknowledged.
 * The stored state does not imply the client saw an answer — an acknowledged
 * commit authorizes emission, but a commit whose REPLY was lost leaves the same
 * stored state with nothing emitted. The record is NON-ACQUIRABLE in that state, so the
 * session is blocked rather than handed a mapping whose last turn the gateway
 * cannot account for. Bounding it means the block always clears: after this
 * window the key is gone and the next turn starts a clean thread. It matches the
 * ambiguous window deliberately — the observable outcome is the same "blocked,
 * bounded, then fresh" — but is named separately because the two states mean
 * different things and may need to diverge.
 */
export const REUSE_COMMITTED_TTL_MS = 900_000;

/**
 * Maximum stored Redis record size, in bytes.
 *
 * A record carries only fixed metadata plus one sealed upstream thread id, so
 * this is deliberately three orders of magnitude tighter than the idempotency
 * record bound: nothing legitimate approaches it, and anything that does is
 * classified corrupt without its bytes ever being read.
 */
export const MAX_REUSE_RECORD_BYTES = 4096;

/**
 * Maximum accepted UTF-8 length of a normalized upstream thread id, in bytes.
 *
 * The adapter normalizes an upstream integer or string id; this bounds what may
 * be sealed into a record so a hostile upstream cannot inflate stored state.
 */
export const MAX_UPSTREAM_THREAD_ID_BYTES = 512;

/** Owner-token size, in bytes (128 bits of randomness). */
export const OWNER_TOKEN_BYTES = 16;
/** AES-GCM nonce size, in bytes (96 bits, per NIST SP 800-38D). */
export const GCM_NONCE_BYTES = 12;
/** AES-GCM authentication-tag size, in bytes. */
export const GCM_TAG_BYTES = 16;

/**
 * Extra lifetime granted to a Redis key beyond the lease its record carries,
 * when the lease outlives the configured mapping TTL.
 *
 * A leased record MUST outlive its own lease. Lease expiry is what converts an
 * abandoned `processing` record into `ambiguous`; if the key simply vanished at
 * the lease deadline the next turn would see no mapping and silently start a
 * replacement thread while the previous submit might still be running upstream.
 * The grace is therefore the window in which a competitor can still observe the
 * expired lease and tombstone it, and it matches the ambiguous window so the
 * conversion always has at least one full window to happen in.
 */
export const REUSE_EXPIRED_LEASE_GRACE_MS = REUSE_AMBIGUOUS_TTL_MS;
