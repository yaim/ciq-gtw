/**
 * The shared-capacity store PORT (Phase 4D; specification section 19.2).
 *
 * The coordinator depends only on this narrow interface, so the Redis client is
 * a replaceable implementation detail and hermetic tests can inject a
 * deterministic in-memory fake.
 *
 * Two shapes are deliberate:
 *
 *  - a claim is a BATCH, because one process-local FIFO queue may hold several
 *    waiters and this boundary allows at most one Redis claim in flight. A batch
 *    also lets the server apply the per-key limit across candidates, which a
 *    sequence of single claims could not do atomically.
 *  - a claim reply names the exact OWNER TOKENS granted rather than a count.
 *    Per-key bypass means the granted set is not a prefix of the candidate list,
 *    so a count would be ambiguous about WHICH waiters may proceed.
 *
 * Every operation is total and non-throwing: transport, protocol, and timeout
 * failures surface as `unavailable`, never as a rejection, so the coordinator
 * can always fail closed to `503` without inspecting a thrown value.
 */

/** One candidate in an ORDERED claim batch (local FIFO order is significant). */
export interface CapacityCandidate {
  /** This waiter's freshly minted 128-bit owner token (unpadded base64url). */
  readonly owner: string;
  /** The waiter's opaque cross-replica capacity scope (unpadded base64url). */
  readonly scope: string;
  /**
   * Lease duration for THIS candidate, in ms, derived from its own model's total
   * deadline. Shipped per candidate because one batch may mix models with
   * different deadlines. The deadline itself is stamped server-side from Redis
   * `TIME`, never from a caller's clock.
   */
  readonly leaseMs: number;
}

/** The cluster-wide active-permit limits enforced by one claim. */
export interface CapacityClaimLimits {
  /** `MAX_CONCURRENT_REQUESTS`, interpreted cluster-wide when enabled. */
  readonly maxActive: number;
  /** `MAX_CONCURRENT_REQUESTS_PER_KEY`, interpreted cluster-wide when enabled. */
  readonly maxActivePerScope: number;
}

/** The outcome of one atomic batched claim. */
export type CapacityClaimResult =
  | {
      readonly kind: "claimed";
      /**
       * The owner tokens actually granted, in grant order. It is a SUBSET of the
       * submitted candidates and MAY be empty, which means the cluster is
       * currently at its limit — the one outcome worth retrying.
       */
      readonly granted: readonly string[];
    }
  /** The registry is the wrong type, over-cardinality, or holds a malformed member. */
  | { readonly kind: "corrupt" }
  /** Redis is disconnected, timed out, or returned an unusable reply. */
  | { readonly kind: "unavailable" };

/** The outcome of one atomic release. */
export type CapacityReleaseResult =
  /**
   * The member is no longer present. IDEMPOTENT: a member that was already
   * removed (by a repeat release or by lease-expiry pruning) also reports `ok`,
   * because the post-condition the caller needs is "this permit is not held".
   */
  { readonly kind: "ok" } | { readonly kind: "corrupt" } | { readonly kind: "unavailable" };

/**
 * Atomic, cross-replica active-permit operations over ONE namespace-level lease
 * registry.
 *
 * Every operation is a single atomic server-side script; there is no
 * read-then-write sequence anywhere in the correctness path, and no lease
 * deadline is ever chosen from a caller's clock.
 */
export interface SharedCapacityStore {
  /**
   * Atomically prune expired leases, count global and per-scope occupancy, and
   * grant an ordered subset of `candidates`.
   *
   * Candidates are considered in the supplied order. A candidate whose scope is
   * already at `maxActivePerScope` is SKIPPED rather than blocking the batch, so
   * a later candidate with a different scope can still be granted — the
   * cross-replica analogue of the local controller's per-key bypass. Granting
   * stops as soon as global occupancy reaches `maxActive`.
   *
   * The complete existing registry AND every argument are validated BEFORE any
   * mutation. A wrong type, an over-cardinality registry, a malformed member or
   * score, or a duplicated owner token returns `corrupt` and leaves the registry
   * byte-for-byte untouched.
   *
   * The batch is bounded by BOTH the fixed ceiling and `limits.maxActive`: a
   * batch larger than the cluster-wide global limit could never be granted in
   * full, so it is refused rather than partially applied. A batch containing a
   * duplicated owner token is refused for the same reason a stored duplicate is
   * corrupt — it would add two members for one permit.
   */
  claimBatch(
    key: string,
    candidates: readonly CapacityCandidate[],
    limits: CapacityClaimLimits,
    signal?: AbortSignal,
  ): Promise<CapacityClaimResult>;

  /**
   * Atomically remove one exact `version | owner | scope` member.
   *
   * Also prunes expired leases, deletes the key when the registry becomes empty,
   * and otherwise re-expires it at the latest remaining lease. It is issued
   * WITHOUT the request's abort signal, because a released permit must be given
   * back even when the request that held it was cancelled.
   */
  release(
    key: string,
    owner: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<CapacityReleaseResult>;

  /**
   * Fixed, bounded availability view. Must be synchronous, non-throwing, and
   * perform no I/O.
   */
  isReady(): boolean;
}
