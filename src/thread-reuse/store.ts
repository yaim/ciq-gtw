/**
 * The thread-reuse store PORT (Phase 5A).
 *
 * The coordinator depends only on this narrow interface, so the Redis client is
 * a replaceable implementation detail and hermetic tests can inject a
 * deterministic in-memory fake. Records cross this boundary as opaque
 * already-serialized strings in one direction only: unlike the idempotency
 * store, the CALLER never supplies a whole record, because every write must
 * stamp a lease deadline read from Redis's own clock. The store therefore
 * assembles each record server-side from the fixed fields plus, where relevant,
 * the caller's sealed thread id.
 *
 * Every operation is total and non-throwing: transport, protocol, and timeout
 * failures surface as `unavailable`, never as a rejection, so the coordinator
 * can always fail closed to `503` without inspecting a thrown value.
 */
import type { SealedThread } from "./crypto.js";
import type { ReuseRecordState } from "./records.js";

/**
 * The timings every write needs. Supplied on each call, never cached.
 *
 * BOTH leases are shipped on every operation so the STORE chooses between them
 * from the authoritative stored state. The caller never selects one, because its
 * own view of the state can lag Redis across the `reserved → processing`
 * transition, and picking the short reserved lease for a live `processing`
 * record is precisely the expiry the derived lease exists to prevent.
 */
export interface ReuseTimings {
  /** Lease for a `reserved` record, in ms (added to Redis's own clock in Lua). */
  readonly leaseMs: number;
  /**
   * Lease for a `processing` record, in ms. Derived from the request's own total
   * deadline plus a margin, so a live owner cannot expire mid-completion.
   */
  readonly processingLeaseMs: number;
  /**
   * Sliding mapping lifetime, in ms. It is the Redis `PX` of an `active` record
   * and the FLOOR for a leased one — a leased record additionally takes at least
   * its own lease plus a conversion grace, because a record must outlive its
   * lease for an expired `processing` state to become `ambiguous` instead of
   * vanishing.
   */
  readonly mappingTtlMs: number;
  /** Lifetime of an `ambiguous` tombstone, in ms. */
  readonly ambiguousTtlMs: number;
  /**
   * Lifetime of a `committed` record whose activation was never acknowledged,
   * in ms. It is non-acquirable, so this bounds how long the session is blocked
   * before it may start a clean thread.
   */
  readonly committedTtlMs: number;
}

/** The outcome of an atomic lease acquisition. */
export type ReuseAcquireResult =
  /**
   * The caller now owns a `reserved` record. `raw` is the record the script
   * wrote, so the caller can strictly re-validate it and read any carried-over
   * sealed thread id.
   */
  | { readonly kind: "acquired"; readonly raw: string }
  /** Another request holds an UNEXPIRED lease on this mapping. Map to `409`. */
  | { readonly kind: "busy" }
  /** The mapping is `ambiguous` and stays blocked for its TTL. Map to `503`. */
  | { readonly kind: "blocked" }
  /** The stored value is unusable (oversized, malformed, impossible). Fail closed. */
  | { readonly kind: "corrupt" }
  /** Redis is disconnected, timed out, or returned an unusable reply. */
  | { readonly kind: "unavailable" };

/** The outcome of an atomic owner-guarded compare-and-transition. */
export type ReuseCasResult =
  | {
      readonly kind: "ok";
      /**
       * The state the store observed, populated only by `renew`. It reports
       * which state was actually renewed and is a fixed literal, never content.
       */
      readonly observedState?: ReuseRecordState;
    }
  /** The key no longer exists (the mapping expired or was released). */
  | { readonly kind: "missing" }
  /** A different owner token holds the record; the lease was lost. */
  | { readonly kind: "lost" }
  /** The record exists and is owned, but is not in the expected state. */
  | { readonly kind: "state" }
  /** The stored value is unusable. Fail closed. */
  | { readonly kind: "corrupt" }
  | { readonly kind: "unavailable" };

/** The outcome of a proven pre-submit release. */
export type ReuseReleaseResult =
  | {
      readonly kind: "ok";
      /**
       * `true` when a bound thread was restored to `active` (the mapping
       * survives for the next turn); `false` when a never-bound reservation was
       * deleted.
       */
      readonly restored: boolean;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "lost" }
  | { readonly kind: "state" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unavailable" };

/**
 * Atomic, cross-replica thread-reuse state operations.
 *
 * Every operation is a single atomic server-side script; there is no
 * read-then-write sequence anywhere in the correctness path, and no lease
 * deadline is ever chosen from a caller's clock.
 */
export interface ThreadReuseStore {
  /**
   * Atomically take the mapping's lease.
   *
   * Absent → create `reserved` with no thread. `active` → `reserved` carrying
   * the existing sealed thread. `reserved`/`processing` whose stored lease
   * deadline has NOT passed → `busy`. `reserved` whose lease HAS passed → taken
   * over, keeping any bound thread. `processing` whose lease HAS passed →
   * rewritten to `ambiguous` and reported `blocked`, never revived. `ambiguous`
   * → `blocked`. Anything unreadable → `corrupt`.
   */
  acquire(key: string, owner: string, timings: ReuseTimings): Promise<ReuseAcquireResult>;

  /**
   * Atomically attach a freshly created thread to the caller's own `reserved`
   * record, leaving it `reserved` and refreshing the lease. Only valid when no
   * thread is bound yet.
   */
  bind(
    key: string,
    owner: string,
    sealed: SealedThread,
    timings: ReuseTimings,
  ): Promise<ReuseCasResult>;

  /**
   * Atomically move the caller's own record `reserved → processing`, refreshing
   * the lease. Fails when no thread is bound: submitting requires one.
   */
  markProcessing(key: string, owner: string, timings: ReuseTimings): Promise<ReuseCasResult>;

  /**
   * Atomically extend the caller's own lease on a `reserved` or `processing`
   * record, and refresh the mapping's Redis lifetime.
   *
   * The state is read from the AUTHORITATIVE stored record, never accepted from
   * the caller, so a renewal that races a transition can neither revive an
   * `active`/`ambiguous` record, be misapplied, nor shorten a live `processing`
   * lease back down to the reserved one. The reply reports which state it saw.
   */
  renew(key: string, owner: string, timings: ReuseTimings): Promise<ReuseCasResult>;

  /**
   * Atomically move the caller's own record `processing → committed`, the FIRST
   * half of the acknowledgement-safe terminal transition.
   *
   * IDEMPOTENT for the same owner: a record already `committed` by this owner
   * reports `ok`. That is the whole point — if the mutation applied but its
   * reply was lost, a bounded retry can still acknowledge it, instead of the
   * caller concluding "failed" while the record silently moved on.
   *
   * `committed` is non-acquirable, so until it is acknowledged the mapping can
   * only block another turn, never be handed to one.
   */
  commit(key: string, owner: string, timings: ReuseTimings): Promise<ReuseCasResult>;

  /**
   * Atomically move the caller's own record `committed → active`, the SECOND
   * half: the mapping becomes reusable and the sliding TTL is reset.
   *
   * Also IDEMPOTENT for the same owner (an already-`active` record reports
   * `ok`), so a lost reply here is recoverable too. It must NEVER be called
   * before {@link ThreadReuseStore.commit} has been positively acknowledged.
   *
   * A genuinely ABSENT key is repaired, not merely reported: the implementation
   * atomically leaves an `ambiguous` tombstone for this owner and STILL returns
   * `missing`. Without that write the key would stay absent and the session's
   * next turn would silently create a replacement thread. `lost`, `state`, and
   * `corrupt` are reported with the record left untouched.
   */
  activate(key: string, owner: string, timings: ReuseTimings): Promise<ReuseCasResult>;

  /**
   * Atomically settle a PROVEN pre-submit failure on the caller's own
   * `reserved` record: restore it to `active` when a thread is bound, or delete
   * it when none ever was.
   */
  release(key: string, owner: string, timings: ReuseTimings): Promise<ReuseReleaseResult>;

  /**
   * Atomically tombstone the caller's own `processing` OR `committed` record as
   * `ambiguous`, dropping the sealed thread and applying the ambiguous TTL. Used
   * whenever `process_message` may already have been attempted.
   *
   * It accepts `committed` as well as `processing` because a commit whose reply
   * was lost leaves the record in a state the caller does not know it reached;
   * settlement must be able to tombstone either. Since `committed` is never
   * acquirable, no other owner can have taken it in the meantime.
   */
  abandon(key: string, owner: string, timings: ReuseTimings): Promise<ReuseCasResult>;

  /**
   * Atomically retire the caller's own `reserved` record whose sealed thread is
   * UNUSABLE, as `ambiguous` with the ambiguous TTL.
   *
   * Distinct from {@link ThreadReuseStore.release}, which restores the mapping
   * and resets the sliding TTL: doing that for a ciphertext this gateway cannot
   * authenticate would extend the broken mapping's life on every retry and pin
   * the session on a permanent `503`. Distinct from deleting, which would
   * silently start a replacement thread on the next request.
   */
  discardUnusable(key: string, owner: string, timings: ReuseTimings): Promise<ReuseCasResult>;

  /**
   * Fixed, bounded availability view. Must be synchronous, non-throwing, and
   * perform no I/O.
   */
  isReady(): boolean;
}
