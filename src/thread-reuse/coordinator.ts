/**
 * The thread-reuse coordinator (Phase 5A; specification section 5.1.1).
 *
 * This module owns the cross-replica state machine that lets sequential
 * eligible messages from one OpenCode session address ONE CollectivIQ thread:
 *
 * ```text
 *                    acquire (atomic, after the rate limit, before capacity)
 *                                   │
 *        ┌──────────────────────────┼───────────────────────────┐
 *   absent → reserved      active → reserved (carrying     live lease → 409 busy
 *   (no thread yet)                 the sealed thread)     ambiguous  → 503
 *        │                          │
 *        │ capacity acquired        │ capacity acquired
 *        ▼                          │
 *   create_thread → bind (CAS)      │
 *        └──────────┬───────────────┘
 *                   ▼
 *            processing (CAS)   ← immediately before process_message
 *                   │
 *                   │ submit once → run-correlated poll
 *                   ▼
 *             committed (CAS)   ─── acknowledged BEFORE the JSON body / SSE
 *                   │                content; NOT acquirable by anyone
 *                   ▼
 *              active (CAS, TTL reset)  ─── reusable by the next turn
 *                   │
 *                   └── failure at/after `processing` ──► blocked: ambiguous
 *                       (15 min), or a bounded `committed` when the commit was
 *                       acknowledged but activation stayed unconfirmed
 * ```
 *
 * Design rules this module enforces:
 *
 *  - The lease is taken atomically BEFORE capacity and before any upstream
 *    call, so two concurrent requests for one session can never both submit to
 *    the same thread. The loser is told to retry (`409`), never queued.
 *  - A mapping only ever advances through owner-guarded atomic transitions. The
 *    coordinator never reads a record and then writes based on what it saw.
 *  - The terminal step is the ACKNOWLEDGEMENT-SAFE pair
 *    `processing → committed → active`, and the COMMIT must be acknowledged
 *    BEFORE the non-streamed response body and before any SSE content or
 *    terminal frame, so an answer is never emitted for a turn whose mapping the
 *    gateway could not record. (The SSE headers and role opener precede it by
 *    design, exactly as for idempotency.) `committed` is never acquirable, so a
 *    reply lost after Redis applied the write can only block the session — it
 *    can never expose a mapping whose last turn went undelivered.
 *  - A PROVEN pre-submit failure restores the mapping to what it was, so a
 *    capacity rejection costs the session nothing.
 *  - Anything at or after the point `process_message` may have run leaves the
 *    mapping BLOCKED, because the thread may now hold an extra prompt and answer
 *    a later turn could be confused by. That is usually `ambiguous`, but an
 *    acknowledged commit whose activation stays unconfirmed may truthfully
 *    remain in the bounded, equally non-acquirable `committed` state, and an
 *    activation that finds the mapping genuinely absent atomically persists an
 *    `ambiguous` tombstone. Every one of those blocks the session for a bounded
 *    window rather than silently continuing or silently replacing the thread.
 *  - The owner renews its lease periodically; a lost renewal aborts the request
 *    so upstream work stops promptly.
 *
 * The coordinator deliberately imports nothing from the API or generation
 * layers: it returns discriminated outcomes and the route owns every public
 * status and envelope.
 */
import type { VirtualModel } from "../config/schema.js";
import { openThreadId, sealThreadId, type ThreadAeadBinding } from "./crypto.js";
import {
  buildMappingIdentityDigest,
  buildReuseStorageKey,
  deriveModelPolicyFingerprint,
  type MappingIdentity,
  type ThreadReuseKeyring,
} from "./keyring.js";
import {
  MAX_REUSE_PROCESSING_LEASE_MS,
  REUSE_AMBIGUOUS_TTL_MS,
  REUSE_COMMITTED_TTL_MS,
  REUSE_LEASE_MS,
  REUSE_LEASE_RENEW_INTERVAL_MS,
  REUSE_PROCESSING_LEASE_MARGIN_MS,
} from "./limits.js";
import { decodeReuseRecord, newReuseOwnerToken, REUSE_RECORD_VERSION } from "./records.js";
import type { ReuseTimings, ThreadReuseStore } from "./store.js";

/** Inputs identifying one eligible reuse request. */
export interface ReuseAcquireInput {
  /** The stable, opaque per-gateway-key reuse scope. */
  readonly gatewayKeyScope: string;
  /** The validated, opaque OpenCode session id. */
  readonly sessionId: string;
  /** The resolved internal model policy (fingerprinted, never stored). */
  readonly model: VirtualModel;
}

/**
 * The owner's handle on a leased mapping. Every method is total and never
 * throws; the route maps an `unavailable` outcome to the public `503` envelope.
 */
export interface ThreadReuseSession {
  /**
   * Aborts when this request loses its lease (a failed renewal). Compose it
   * into the run signal so upstream work stops promptly.
   */
  readonly signal: AbortSignal;
  /** True once the lease was lost, so a cancellation maps to `503`, not a disconnect. */
  readonly leaseLost: boolean;
  /**
   * The upstream thread this session must continue, or `null` when the mapping
   * is new and a thread has to be created and bound.
   */
  readonly existingThreadId: string | null;
  /**
   * Atomically attach a freshly created thread while still `reserved`. MUST
   * succeed before `process_message`; on `unavailable` the caller performs NO
   * submit, and the blank upstream thread is deliberately not deleted.
   */
  bindThread(threadId: string): Promise<"ok" | "unavailable">;
  /**
   * Atomically move `reserved → processing` immediately before
   * `process_message`. On `unavailable` the caller performs no submit and the
   * mapping is restored on the normal exit path.
   */
  markProcessing(): Promise<"ok" | "unavailable">;
  /**
   * Complete the mapping for this turn, through the acknowledgement-safe
   * two-step terminal transition (`processing → committed → active`).
   *
   * MUST be called, and return `"ok"`, before the non-streamed response body and
   * before any SSE content or terminal frame. `"unavailable"` means the answer
   * was never authorized and must not be emitted; the mapping is tombstoned so a
   * later turn is blocked rather than continuing a thread this gateway cannot
   * account for.
   *
   * `"ok"` is returned as soon as the COMMIT is acknowledged. Activation may
   * still be unconfirmed at that point, which is deliberately not a client-
   * visible failure: the record is non-acquirable until it is activated, so the
   * worst case is a blocked session, never a mapping handed out with an
   * unaccounted-for turn.
   */
  finalize(): Promise<"ok" | "unavailable">;
  /**
   * Stop the lease timer and settle the mapping according to how far this turn
   * actually got:
   *
   *  - finalized (already `active`) — no further transition;
   *  - `committed` — retry activation best effort, since only that step is
   *    unconfirmed and the mapping legitimately holds this turn's thread;
   *  - `processing` — settle as `ambiguous`, because a submit may have run;
   *  - `reserved` — restore the previous mapping, or delete a reservation that
   *    never bound a thread.
   *
   * Best effort: never throws, and idempotent — safe to call more than once.
   */
  finish(): Promise<void>;
}

/** The decision made by an atomic lease acquisition. */
export type ReuseAcquireOutcome =
  | { readonly kind: "leased"; readonly session: ThreadReuseSession }
  /** Another request holds a live lease for this session. Map to `409`. */
  | { readonly kind: "busy" }
  /** Redis, the record, or the sealed thread is unusable. Map to `503`. */
  | { readonly kind: "unavailable" };

/** The cross-replica thread-reuse use case consumed by the chat route. */
export interface ThreadReuseCoordinator {
  /** Bounded, synchronous availability view (no I/O). */
  isAvailable(): boolean;
  /** Take the session's lease, or report why the request cannot proceed. */
  acquire(input: ReuseAcquireInput): Promise<ReuseAcquireOutcome>;
}

/** Injected dependencies (all narrow ports; every seam is test-injectable). */
export interface ThreadReuseCoordinatorDeps {
  readonly store: ThreadReuseStore;
  readonly keyring: ThreadReuseKeyring;
  /** The validated `REDIS_KEY_PREFIX` namespace. */
  readonly namespace: string;
  /** The validated CollectivIQ origin (`COLLECTIVIQ_BASE_URL`). */
  readonly origin: string;
  /**
   * The value-free fingerprint of the ACTIVE upstream principal, derived once
   * at composition so the raw credential material is read exactly once.
   */
  readonly principalFingerprint: string;
  /** The validated `OPENCODE_THREAD_REUSE_TTL_MS` sliding idle lifetime. */
  readonly mappingTtlMs: number;
  /**
   * Interval seam for the lease renewal timer. Injected only so tests can drive
   * renewal deterministically; production uses `setInterval`.
   */
  readonly scheduleRenewal?: (fn: () => void, ms: number) => { cancel: () => void };
}

function defaultScheduleRenewal(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setInterval(fn, ms);
  // `unref` so a pending renewal can never keep the process alive on shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return { cancel: () => clearInterval(timer) };
}

export function createThreadReuseCoordinator(
  deps: ThreadReuseCoordinatorDeps,
): ThreadReuseCoordinator {
  const schedule = deps.scheduleRenewal ?? defaultScheduleRenewal;

  /**
   * Derive this request's timings. The `processing` lease is derived from the
   * MODEL'S OWN total deadline (plus a margin, capped) so a live owner's mapping
   * can never expire mid-completion — even under the event-loop starvation that
   * delays lease renewal — because the owner's own deadline fires first. The
   * short `reserved` lease is safe to lose, because the owner-guarded
   * `reserved → processing` transition stops a starved owner from submitting
   * after a takeover.
   */
  function timingsFor(model: VirtualModel): ReuseTimings {
    return {
      leaseMs: REUSE_LEASE_MS,
      processingLeaseMs: Math.min(
        model.requestTimeoutMs + REUSE_PROCESSING_LEASE_MARGIN_MS,
        MAX_REUSE_PROCESSING_LEASE_MS,
      ),
      mappingTtlMs: deps.mappingTtlMs,
      ambiguousTtlMs: REUSE_AMBIGUOUS_TTL_MS,
      committedTtlMs: REUSE_COMMITTED_TTL_MS,
    };
  }

  function createSession(
    storageKey: string,
    binding: ThreadAeadBinding,
    owner: string,
    existingThreadId: string | null,
    timings: ReuseTimings,
  ): ThreadReuseSession {
    const abort = new AbortController();
    let leaseLost = false;
    /**
     * This request's view of the mapping. `committed` means the answer is
     * authorized for emission but `committed → active` is unconfirmed, so
     * settlement retries activation instead of tombstoning.
     */
    let state: "reserved" | "processing" | "committed" | "finalized" = "reserved";
    let bound = existingThreadId !== null;
    let settled = false;
    let renewing = false;
    let renewal: { cancel: () => void } | null = null;

    const stopRenewal = (): void => {
      renewal?.cancel();
      renewal = null;
    };

    const loseLease = (): void => {
      leaseLost = true;
      stopRenewal();
      if (!abort.signal.aborted) abort.abort();
    };

    /**
     * True once the answer is authorized for emission, i.e. from the moment the
     * COMMIT is acknowledged — not merely once activation confirms.
     *
     * Renewal must stop here. A `committed` record is deliberately not
     * renewable, so a renewal fired during an unconfirmed activation would come
     * back `state` and call {@link loseLease}, aborting the request's signal
     * AFTER its answer was authorized — cancelling the very response writes the
     * commit had just cleared, most visibly mid-SSE.
     */
    const answerAuthorized = (): boolean => state === "committed" || state === "finalized";

    const renew = (): void => {
      // Never overlap renewals; a slow Redis must not queue attempts.
      if (renewing || settled || answerAuthorized()) return;
      renewing = true;
      void deps.store
        .renew(storageKey, owner, timings)
        .then((result) => {
          // ANY non-`ok` outcome means the lease can no longer be guaranteed:
          // abort rather than keep submitting to a thread another request may
          // now own.
          if (result.kind !== "ok" && !settled && !answerAuthorized()) loseLease();
        })
        .catch(() => {
          if (!settled && !answerAuthorized()) loseLease();
        })
        .finally(() => {
          renewing = false;
        });
    };
    renewal = schedule(renew, REUSE_LEASE_RENEW_INTERVAL_MS);

    /** Best-effort terminal write. Never throws; runs at most once. */
    async function settle(): Promise<void> {
      if (settled) return;
      settled = true;
      stopRenewal();
      try {
        if (state === "committed") {
          // The commit was acknowledged, so the answer is AUTHORIZED. Whether it
          // has actually been EMITTED depends on the transport: a stream may
          // already have written content, while a non-streamed response can
          // still be pending, because the route may call `finish()` before
          // Fastify serializes the returned body. Either way only
          // `committed → active` is unconfirmed.
          //
          // Retry it best effort rather than tombstoning: the mapping
          // legitimately holds this turn's thread. If it still cannot be
          // confirmed the record stays `committed`, which is non-acquirable and
          // bounded by its own TTL, so the session blocks and then starts clean
          // rather than letting a later turn continue an unaccounted-for one.
          await deps.store.activate(storageKey, owner, timings);
        } else if (state === "processing") {
          // `process_message` MAY have run, so the thread's contents are
          // unknown: block the session for the ambiguous TTL rather than risk a
          // later turn selecting this turn's answer. `abandon` also accepts a
          // `committed` record, so an unacknowledged commit that actually landed
          // is tombstoned here too.
          await deps.store.abandon(storageKey, owner, timings);
        } else if (state === "reserved") {
          // PROVEN not to have submitted: restore the mapping exactly as it was
          // (or delete a reservation that never bound a thread). The
          // expected-state guard means a record owned by someone else, or one
          // that advanced past this request, is never rewritten.
          const released = await deps.store.release(storageKey, owner, timings);
          // A `state` mismatch means this request's OWN `reserved → processing`
          // write actually landed even though its reply never arrived (a
          // timeout or a dropped connection after the server applied it). The
          // caller therefore treated it as a failure and never submitted — but
          // the gateway cannot prove that from Redis alone, so the mapping is
          // tombstoned rather than restored.
          if (released.kind === "state") {
            await deps.store.abandon(storageKey, owner, timings);
          }
        }
      } catch {
        // Best effort only: an unreachable Redis leaves the record to expire
        // under its bounded mapping TTL, and its stale lease lets the next
        // request recover it.
      }
    }

    return {
      signal: abort.signal,
      existingThreadId,
      get leaseLost(): boolean {
        return leaseLost;
      },

      async bindThread(threadId: string): Promise<"ok" | "unavailable"> {
        if (settled || leaseLost || state !== "reserved" || bound) return "unavailable";
        const sealed = sealThreadId(deps.keyring.aeadKey, threadId, binding);
        if (sealed === null) return "unavailable";
        const result = await deps.store.bind(storageKey, owner, sealed, timings);
        if (result.kind !== "ok") return "unavailable";
        // Defence in depth: if the session settled while this write was in
        // flight, the mapping has already been restored or deleted, so
        // reporting success would let the caller submit against a lease it no
        // longer holds.
        if (settled || leaseLost) return "unavailable";
        bound = true;
        return "ok";
      },

      async markProcessing(): Promise<"ok" | "unavailable"> {
        if (settled || leaseLost || state !== "reserved" || !bound) return "unavailable";
        const result = await deps.store.markProcessing(storageKey, owner, timings);
        if (result.kind !== "ok") return "unavailable";
        if (settled || leaseLost) return "unavailable";
        state = "processing";
        return "ok";
      },

      async finalize(): Promise<"ok" | "unavailable"> {
        if (state === "finalized" || state === "committed") return "ok";
        if (settled || leaseLost || state !== "processing") return "unavailable";

        // --- Step 1: COMMIT, which must be positively acknowledged -----------
        // `commit` is idempotent for this owner, so a retry after a lost reply
        // acknowledges a mutation that already landed instead of concluding
        // "failed" while the record has moved on. Only `unavailable` is worth
        // retrying: every other outcome is a definitive answer from Redis.
        let committed = await deps.store.commit(storageKey, owner, timings);
        if (committed.kind === "unavailable") {
          committed = await deps.store.commit(storageKey, owner, timings);
        }
        if (committed.kind !== "ok") {
          // The mapping is NOT durably recorded: never emit the answer. Settling
          // tombstones the record — `abandon` accepts `processing` AND
          // `committed`, so it retires the mapping whichever of the two the
          // unacknowledged write actually reached. `committed` is not
          // acquirable, so no other owner can have taken it meanwhile.
          await settle();
          return "unavailable";
        }

        // The answer is now AUTHORIZED for emission. From here on, an inability
        // to reach Redis must not turn a successful completion into a `503` —
        // and renewal must stop, because a `committed` record is not renewable
        // and a failed renewal would abort the signal the response is still
        // being written on.
        state = "committed";
        stopRenewal();

        // --- Step 2: ACTIVATE, which may be left unconfirmed -----------------
        const activated = await deps.store.activate(storageKey, owner, timings);
        if (activated.kind === "ok") {
          state = "finalized";
          settled = true;
          stopRenewal();
          return "ok";
        }
        if (activated.kind === "unavailable") {
          // Undecided, not wrong. The record is either `committed` or already
          // `active`; both are safe. Report success and let settlement retry.
          return "ok";
        }
        // A DEFINITIVE bad answer (`missing`, `lost`, `state`, `corrupt`) means
        // the mapping is not what this request believes it is, so the request
        // fails closed and touches the record NO further.
        //
        // Settling here would be actively wrong: `settle()` retries activation
        // for local state `committed`, so a transient definitive fault would be
        // followed by a successful retry — the client would receive `503` while
        // the mapping quietly became reusable, which is precisely the hazard the
        // two-step transition exists to prevent. There is also nothing safe left
        // to do: `lost` means another owner holds the record, `state` means it
        // advanced beyond `committed`, and `corrupt` must never be rewritten.
        // `missing` needs no follow-up write either — the activation script
        // already converted the absence into a bounded `ambiguous` tombstone
        // atomically, so the session is blocked rather than handed a clean slate
        // it would fill with a replacement thread.
        settled = true;
        stopRenewal();
        return "unavailable";
      },

      async finish(): Promise<void> {
        stopRenewal();
        await settle();
      },
    };
  }

  return {
    isAvailable(): boolean {
      try {
        return deps.store.isReady();
      } catch {
        return false;
      }
    },

    async acquire(input: ReuseAcquireInput): Promise<ReuseAcquireOutcome> {
      const identity: MappingIdentity = {
        gatewayKeyScope: input.gatewayKeyScope,
        sessionId: input.sessionId,
        policyFingerprint: deriveModelPolicyFingerprint(deps.keyring, input.model),
        origin: deps.origin,
        principalFingerprint: deps.principalFingerprint,
      };
      const storageKey = buildReuseStorageKey(deps.keyring, deps.namespace, identity);
      const binding: ThreadAeadBinding = {
        recordVersion: REUSE_RECORD_VERSION,
        storageKey,
        mappingIdentityDigest: buildMappingIdentityDigest(deps.keyring, deps.namespace, identity),
      };
      const owner = newReuseOwnerToken();
      const timings = timingsFor(input.model);

      const acquired = await deps.store.acquire(storageKey, owner, timings);
      if (acquired.kind === "busy") return { kind: "busy" };
      if (acquired.kind !== "acquired") return { kind: "unavailable" };

      /**
       * Retire a mapping whose stored thread cannot be used. Restoring it would
       * reset the sliding TTL on every retry and pin the session on a permanent
       * `503`; deleting it would silently start a replacement thread. The
       * tombstone fails closed for a bounded window and then lets the next turn
       * begin cleanly.
       */
      const discard = async (): Promise<ReuseAcquireOutcome> => {
        await deps.store.discardUnusable(storageKey, owner, timings).catch(() => undefined);
        return { kind: "unavailable" };
      };

      // Round-trip the record the script wrote. The lease is already held, so a
      // record this gateway cannot re-validate — or a sealed thread it cannot
      // authenticate — must be retired rather than left blocking the session
      // forever.
      const decoded = decodeReuseRecord(acquired.raw);
      if (!decoded.ok || decoded.record.o !== owner || decoded.record.s !== "reserved") {
        return discard();
      }

      let existingThreadId: string | null = null;
      const sealed = decoded.record.p;
      if (sealed !== undefined) {
        existingThreadId = openThreadId(deps.keyring.aeadKey, sealed, binding);
        // A relocated, rebound, or tampered ciphertext.
        if (existingThreadId === null) return discard();
      }

      return {
        kind: "leased",
        session: createSession(storageKey, binding, owner, existingThreadId, timings),
      };
    },
  };
}
