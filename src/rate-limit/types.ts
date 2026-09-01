/**
 * The rate-limiter PORT (Phase 4B; specification section 19.1).
 *
 * The route depends only on this narrow interface, so the Redis-backed GCRA
 * implementation is replaceable and integration tests can inject a
 * deterministic fake. Nothing here knows about Redis, HTTP status codes, or
 * error envelopes: the API boundary owns every public status and header.
 */

/**
 * The outcome of one quota consumption attempt.
 *
 * The union is CLOSED and the operation is TOTAL: a limiter never throws, so the
 * caller can always fail closed without inspecting a thrown value.
 */
export type RateLimitDecision =
  /** Quota was consumed; the request may proceed. */
  | { readonly kind: "allowed" }
  /**
   * The scope is over its limit. Nothing was consumed and the stored state was
   * NOT mutated. `retryAfterSeconds` is a bounded positive integer.
   */
  | { readonly kind: "limited"; readonly retryAfterSeconds: number }
  /**
   * The decision could not be made (Redis disconnected, command timed out,
   * stored state corrupt, or an unusable reply). The caller must fail closed —
   * never allow.
   */
  | { readonly kind: "unavailable" }
  /** The caller's signal aborted (client disconnect, shutdown, or deadline). */
  | { readonly kind: "cancelled" };

/** Cross-replica, per-gateway-key admission control. */
export interface RateLimiter {
  /**
   * Attempt to consume exactly one quota unit for `gatewayKeyScope`.
   *
   * Exactly one atomic Redis decision per call. A rejected call consumes
   * nothing; an allowed call is never refunded, so the caller must invoke this
   * only for attempts that should genuinely count.
   */
  consume(gatewayKeyScope: string, signal?: AbortSignal): Promise<RateLimitDecision>;
  /**
   * Fixed, bounded availability view. Must be synchronous, non-throwing, and
   * perform no I/O.
   */
  isReady(): boolean;
}
