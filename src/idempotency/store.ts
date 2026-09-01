/**
 * The idempotency store PORT (Phase 4A).
 *
 * The coordinator depends only on this narrow interface, so the Redis client is
 * a replaceable implementation detail and integration tests can inject a
 * deterministic in-memory fake. Records cross this boundary as opaque
 * already-serialized strings: the store never interprets a record beyond the two
 * fields its atomic compare-and-transition scripts must read (`s` state and `o`
 * owner token), which are documented in `records.ts`.
 *
 * Every operation is total and non-throwing: transport, protocol, and timeout
 * failures surface as `unavailable`, never as a rejection, so the coordinator
 * can always fail closed to `503` without inspecting a thrown value.
 */
import type { RecordState } from "./records.js";

/** The outcome of an atomic claim attempt. */
export type ClaimResult =
  /** The key did not exist and this caller now owns a fresh `reserved` record. */
  | { readonly kind: "claimed" }
  /** A record already exists; `raw` is its unvalidated stored value. */
  | { readonly kind: "exists"; readonly raw: string }
  /** The stored value is unusable (oversized). Fail closed. */
  | { readonly kind: "corrupt" }
  /** Redis is disconnected, timed out, or returned an unusable reply. */
  | { readonly kind: "unavailable" };

/** The outcome of reading a record. */
export type ReadResult =
  | { readonly kind: "found"; readonly raw: string }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unavailable" };

/**
 * The lease durations an active record may carry, in ms.
 *
 * Both are supplied to every renewal so the STORE chooses between them from the
 * authoritative stored state. The caller never selects one, because its own view
 * of the state can lag Redis across the `reserved -> processing` transition.
 */
export interface ActiveLeases {
  readonly reserved: number;
  readonly processing: number;
}

/** The outcome of an atomic compare-and-transition (or compare-and-delete). */
export type CasResult =
  /** The owner and expected state matched; the write was applied. */
  | {
      readonly kind: "ok";
      /**
       * The state the store observed, populated only by `renew`. It reports
       * which lease was actually applied and is a fixed literal, never content.
       */
      readonly observedState?: RecordState;
    }
  /** The key no longer exists (expired or deleted). */
  | { readonly kind: "missing" }
  /** A different owner token holds the record; ownership was lost. */
  | { readonly kind: "lost" }
  /** The record exists and is owned, but is not in the expected state. */
  | { readonly kind: "state" }
  /** The stored value is unusable. Fail closed. */
  | { readonly kind: "corrupt" }
  | { readonly kind: "unavailable" };

/**
 * Atomic, cross-replica idempotency state operations.
 *
 * Every mutating operation is a single atomic server-side script; there is no
 * read-then-write sequence anywhere in the correctness path.
 */
export interface IdempotencyStore {
  /**
   * Atomically create `record` at `key` with a `leaseMs` expiry when the key is
   * absent, or report the existing value. Never overwrites an existing record.
   */
  claim(key: string, record: string, leaseMs: number): Promise<ClaimResult>;

  /**
   * Read the current stored value (used only by a waiter's bounded poll).
   *
   * The size bound must be enforced BEFORE the value is materialized, so an
   * oversized entry is reported as `corrupt` without its bytes ever crossing
   * this boundary.
   */
  read(key: string): Promise<ReadResult>;

  /**
   * Atomically replace the record at `key` with `next` and set `ttlMs`, but only
   * when the stored record's owner token equals `owner` AND its state equals
   * `from`.
   */
  transition(
    key: string,
    owner: string,
    from: RecordState,
    next: string,
    ttlMs: number,
  ): Promise<CasResult>;

  /**
   * Atomically extend the lease of an ACTIVE (`reserved` / `processing`) record
   * owned by `owner`, applying the lease that matches the record's stored state.
   * Never revives a `final` or `ambiguous` record.
   *
   * Both leases are passed because only the store can see the authoritative
   * state: a caller that selected one could shorten a `processing` lease using a
   * stale `reserved` view (see the renewal script's contract).
   */
  renew(key: string, owner: string, leases: ActiveLeases): Promise<CasResult>;

  /**
   * Atomically delete the record at `key` when it is owned by `owner` AND still
   * in the expected `from` state. Used only for a PROVEN pre-`processing`
   * failure, so a record whose state has advanced is never destroyed.
   */
  release(key: string, owner: string, from: RecordState): Promise<CasResult>;

  /**
   * Fixed, bounded availability view. Must be synchronous, non-throwing, and
   * perform no I/O — it backs readiness.
   */
  isReady(): boolean;
}
