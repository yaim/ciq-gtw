/**
 * The idempotency coordinator (Phase 4A; specification section 18).
 *
 * This module owns the cross-replica state machine that makes one client
 * `Idempotency-Key` produce at most one upstream completion:
 *
 * ```text
 *              claim (atomic, before capacity or upstream work)
 *                 │
 *      ┌──────────┴───────────┐
 *   reserved                exists ──► different fingerprint ──► 409
 *      │                        │
 *      │ capacity acquired      ├── reserved/processing ──► bounded wait
 *      ▼                        ├── final ───────────────► replay
 *  processing (CAS)             └── ambiguous/corrupt ───► 503
 *      │
 *      │ create_thread → process_message → poll   (only after the CAS)
 *      ▼
 *   final (CAS, encrypted)  ─── committed BEFORE the JSON body / SSE content
 *      │
 *      └── failure at/after `processing` ──► ambiguous (blocked for the TTL)
 * ```
 *
 * Design rules this module enforces:
 *
 *  - The claim is created atomically BEFORE capacity is taken and before any
 *    upstream call, so two concurrent same-key requests can never both proceed.
 *  - `reserved → processing` is an atomic owner-checked transition invoked after
 *    capacity succeeds; only after it succeeds may `create_thread` run.
 *  - `processing → final` is an atomic owner-checked transition that must commit
 *    BEFORE the non-streamed response body and BEFORE any SSE content or
 *    terminal frame (the SSE headers and role opener precede it by design).
 *  - Any failure at or after `processing` leaves `ambiguous`, which blocks
 *    repeats for the TTL rather than risking a duplicate upstream completion —
 *    the gateway has no proven-idempotent `create_thread`/`process_message`.
 *  - A PROVEN pre-`processing` failure (capacity rejection, cancellation, or the
 *    transition itself failing) compare-and-deletes the owner's own `reserved`
 *    record, so a transient local failure does not block the key.
 *  - The owner renews its lease periodically; a lost renewal aborts the request.
 *    A waiter NEVER takes over a disappeared, expired, corrupt, or ownerless
 *    record within the same request — it fails `503`.
 *  - Waiting is bounded polling with backoff and is cancellation-aware. Pub/Sub
 *    is deliberately not used as a source of truth.
 *
 * The coordinator deliberately imports nothing from the API or generation
 * layers: it returns discriminated outcomes and the route owns every public
 * status and envelope.
 */
import type { Clock, RandomFn, Sleeper } from "../generation/types.js";
import { openPayload, sealPayload, type AeadBinding } from "./crypto.js";
import { fingerprintRequestBody, type FingerprintResult } from "./fingerprint.js";
import type { IdempotencyKeyring } from "./keyring.js";
import { buildStorageKey } from "./keyring.js";
import {
  LEASE_RENEW_INTERVAL_MS,
  MAX_PROCESSING_LEASE_MS,
  MAX_RECORD_BYTES,
  MAX_WAIT_POLLS,
  PROCESSING_LEASE_MARGIN_MS,
  RESERVED_LEASE_MS,
  WAIT_POLL_BACKOFF,
  WAIT_POLL_INITIAL_MS,
  WAIT_POLL_JITTER,
  WAIT_POLL_MAX_MS,
} from "./limits.js";
import {
  decodeCachedCompletion,
  encodeCachedCompletion,
  type CachedCompletion,
  type CachedResult,
} from "./payload.js";
import {
  buildFinalRecord,
  buildRecord,
  decodeRecord,
  encodeRecord,
  newOwnerToken,
  RECORD_VERSION,
  type IdempotencyRecord,
} from "./records.js";
import type { IdempotencyStore } from "./store.js";

/** The identity minted by `prepare()` for a request that becomes the owner. */
export interface CompletionIdentity {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

/** Inputs for one idempotent request. */
export interface BeginInput {
  /** The client's exact `Idempotency-Key` value (hashed, never stored). */
  readonly clientKey: string;
  /** The stable, opaque per-gateway-key Redis scope. */
  readonly gatewayKeyScope: string;
  /** The keyed canonical body fingerprint. */
  readonly bodyFingerprint: string;
  /** The identity this request would publish if it becomes the owner. */
  readonly identity: CompletionIdentity;
  /** Combined client-disconnect + shutdown signal. */
  readonly signal: AbortSignal;
  /**
   * The model's total request timeout, in ms. A waiter is bounded by it and
   * reaches the SAME `504` an ordinary completion would. The absolute deadline
   * is computed from the coordinator's own clock so tests stay deterministic.
   */
  readonly timeoutMs: number;
}

/** The result of resolving an existing record (waiting or replaying). */
export type ResolveOutcome =
  | { readonly kind: "cached"; readonly cached: CachedCompletion }
  /** The key is held for a DIFFERENT body. */
  | { readonly kind: "conflict" }
  /** Redis, the record, or its payload is unusable. Fail closed to `503`. */
  | { readonly kind: "unavailable" }
  /** The wait reached the request deadline. */
  | { readonly kind: "timeout" }
  /** The client disconnected or the gateway is shutting down. */
  | { readonly kind: "cancelled" };

/**
 * The owner's handle on its claim. Every method is total and never throws; the
 * route maps an `unavailable` outcome to the public `503` envelope.
 */
export interface IdempotencyOwnerSession {
  /**
   * Aborts when this request loses its claim (a failed lease renewal). Compose
   * it into the run signal so upstream work stops promptly.
   */
  readonly signal: AbortSignal;
  /** True once the claim was lost, so a cancellation maps to `503`, not a disconnect. */
  readonly ownershipLost: boolean;
  /**
   * Atomically move `reserved → processing` after capacity is acquired. MUST
   * succeed before `create_thread`; on `unavailable` the caller releases capacity
   * and performs no upstream call.
   */
  markProcessing(): Promise<"ok" | "unavailable">;
  /**
   * Atomically move `processing → final`, persisting the encrypted answer.
   *
   * Per specification §18.1 it MUST succeed before the non-streamed response
   * body, and before any SSE content or terminal frame. The SSE status line and
   * the assistant-role opener are committed earlier by design, so a failure here
   * on the streamed path is a content-free SSE error record rather than an HTTP
   * status.
   */
  commit(result: CachedResult): Promise<"ok" | "unavailable">;
  /**
   * Stop the lease timer and settle the record: nothing when committed,
   * `ambiguous` when `processing` began, a compare-and-delete when still
   * `reserved`. Best effort; never throws. Safe to call more than once.
   */
  finish(): Promise<void>;
}

/** The decision made by an atomic claim. */
export type BeginOutcome =
  | { readonly kind: "owner"; readonly session: IdempotencyOwnerSession }
  | { readonly kind: "existing"; readonly resolve: () => Promise<ResolveOutcome> }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" };

/** The cross-replica idempotency use case consumed by the chat route. */
export interface IdempotencyCoordinator {
  /** Bounded, synchronous availability view (no I/O). */
  isAvailable(): boolean;
  /**
   * Keyed canonical fingerprint of the ORIGINAL parsed request body. Exposed
   * here so the body-fingerprint subkey never leaves this boundary.
   */
  fingerprintBody(body: unknown): FingerprintResult;
  /** Claim the key, or decide how an existing record is served. */
  begin(input: BeginInput): Promise<BeginOutcome>;
}

/** Injected dependencies (all narrow ports; every seam is test-injectable). */
export interface IdempotencyCoordinatorDeps {
  readonly store: IdempotencyStore;
  readonly keyring: IdempotencyKeyring;
  /** The validated `REDIS_KEY_PREFIX` namespace. */
  readonly namespace: string;
  /** The validated `IDEMPOTENCY_TTL_MS` applied to `final` and `ambiguous`. */
  readonly ttlMs: number;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly random?: RandomFn;
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

export function createIdempotencyCoordinator(
  deps: IdempotencyCoordinatorDeps,
): IdempotencyCoordinator {
  const random = deps.random ?? Math.random;
  const schedule = deps.scheduleRenewal ?? defaultScheduleRenewal;

  /** Bind a ciphertext to its record version, storage key, and body fingerprint. */
  const bindingFor = (storageKey: string, fingerprint: string): AeadBinding => ({
    recordVersion: RECORD_VERSION,
    storageKey,
    bodyFingerprint: fingerprint,
  });

  /**
   * Decrypt and decode a committed record. Any failure — a wrong key, a tampered
   * ciphertext, a rebound record, or a malformed payload — is `unavailable`.
   */
  function replay(storageKey: string, record: IdempotencyRecord): ResolveOutcome {
    if (record.p === undefined) return { kind: "unavailable" };
    const plaintext = openPayload(deps.keyring.aeadKey, record.p, bindingFor(storageKey, record.f));
    if (plaintext === null) return { kind: "unavailable" };
    const cached = decodeCachedCompletion(plaintext);
    if (cached === null) return { kind: "unavailable" };
    return { kind: "cached", cached };
  }

  /**
   * Classify an existing record for a caller that does NOT own it. `null` means
   * "still in progress — keep waiting".
   */
  function classify(storageKey: string, fingerprint: string, raw: string): ResolveOutcome | null {
    const decoded = decodeRecord(raw);
    // A corrupt or tampered record is never repaired, replayed, or taken over.
    if (!decoded.ok) return { kind: "unavailable" };
    const record = decoded.record;
    // The body check comes first: the same key held for a different body is a
    // conflict regardless of how far the other request has progressed.
    if (record.f !== fingerprint) return { kind: "conflict" };
    if (record.s === "final") return replay(storageKey, record);
    if (record.s === "ambiguous") return { kind: "unavailable" };
    return null; // reserved / processing
  }

  /** Bounded, jittered backoff delay that never overshoots the deadline. */
  function nextDelay(current: number, remainingMs: number): number {
    const jittered = current * (1 + random() * WAIT_POLL_JITTER);
    return Math.max(1, Math.min(Math.round(jittered), WAIT_POLL_MAX_MS, remainingMs));
  }

  /**
   * Poll until the owning request commits, fails, or the deadline passes. The
   * waiter holds NO capacity permit (it performs no upstream work) and never
   * takes over the record.
   */
  async function waitForExisting(
    storageKey: string,
    input: BeginInput,
    deadlineMs: number,
  ): Promise<ResolveOutcome> {
    let delay = WAIT_POLL_INITIAL_MS;
    // The deadline normally ends the loop; the iteration cap is a fail-closed
    // backstop so a stalled or non-monotonic clock can never spin forever.
    for (let polls = 0; polls < MAX_WAIT_POLLS; polls += 1) {
      if (input.signal.aborted) return { kind: "cancelled" };
      const remaining = deadlineMs - deps.clock.nowMs();
      if (remaining <= 0) return { kind: "timeout" };

      try {
        await deps.sleeper.sleep(nextDelay(delay, remaining), input.signal);
      } catch {
        // The sleep rejects only on abort; the reason is never inspected.
        return { kind: "cancelled" };
      }
      if (input.signal.aborted) return { kind: "cancelled" };

      const read = await deps.store.read(storageKey);
      if (read.kind === "unavailable" || read.kind === "corrupt") return { kind: "unavailable" };
      // The record vanished (the owner released it, or its lease expired). This
      // request never takes over: it fails closed so the client can retry with a
      // fresh claim rather than racing the previous owner.
      if (read.kind === "missing") return { kind: "unavailable" };

      const outcome = classify(storageKey, input.bodyFingerprint, read.raw);
      if (outcome !== null) return outcome;

      delay = Math.min(delay * WAIT_POLL_BACKOFF, WAIT_POLL_MAX_MS);
    }
    return { kind: "unavailable" };
  }

  function createOwnerSession(
    storageKey: string,
    fingerprint: string,
    identity: CompletionIdentity,
    owner: string,
    processingLeaseMs: number,
  ): IdempotencyOwnerSession {
    const abort = new AbortController();
    let ownershipLost = false;
    let state: "reserved" | "processing" | "committed" = "reserved";
    let settled = false;
    let renewing = false;
    let renewal: { cancel: () => void } | null = null;

    /**
     * Both active leases, handed to every renewal so the STORE selects one from
     * the authoritative record. The coordinator deliberately does NOT choose:
     * its `state` can lag Redis across the `reserved -> processing` transition
     * (Redis may apply the transition while `markProcessing` is still awaiting
     * its reply), and a renewal issued in that window would otherwise carry the
     * short reserved lease and shorten a live `processing` record's TTL.
     */
    const activeLeases = { reserved: RESERVED_LEASE_MS, processing: processingLeaseMs } as const;

    const stopRenewal = (): void => {
      renewal?.cancel();
      renewal = null;
    };

    const loseOwnership = (): void => {
      ownershipLost = true;
      stopRenewal();
      if (!abort.signal.aborted) abort.abort();
    };

    const renew = (): void => {
      // Never overlap renewals; a slow Redis must not queue attempts.
      if (renewing || settled || state === "committed") return;
      renewing = true;
      void deps.store
        .renew(storageKey, owner, activeLeases)
        .then((result) => {
          // ANY non-`ok` outcome means the claim can no longer be guaranteed:
          // abort rather than continue work another replica might duplicate.
          if (result.kind !== "ok" && !settled && state !== "committed") loseOwnership();
        })
        .catch(() => {
          if (!settled && state !== "committed") loseOwnership();
        })
        .finally(() => {
          renewing = false;
        });
    };
    renewal = schedule(renew, LEASE_RENEW_INTERVAL_MS);

    /** Best-effort terminal write. Never throws; runs at most once. */
    async function settle(): Promise<void> {
      if (settled) return;
      settled = true;
      stopRenewal();
      try {
        if (state === "processing") {
          // The upstream side effect MAY have happened: block repeats for the
          // full TTL instead of allowing a possible duplicate completion.
          const record = buildRecord({
            state: "ambiguous",
            fingerprint,
            owner,
            expiresAtMs: deps.clock.nowMs() + deps.ttlMs,
          });
          await deps.store.transition(
            storageKey,
            owner,
            "processing",
            encodeRecord(record),
            deps.ttlMs,
          );
        } else if (state === "reserved") {
          // PROVEN not to have started upstream work: free the key immediately.
          // The expected-state guard means a record owned by someone else, or
          // one that advanced past this request, is never deleted.
          const released = await deps.store.release(storageKey, owner, "reserved");
          // A `state` mismatch here means this request's OWN
          // `reserved -> processing` write actually landed even though its
          // result came back unknown (a timeout or a dropped connection after
          // the server applied it). The hook therefore threw, so `create_thread`
          // was never reached — the record is provably abandoned and safe to
          // delete. Without this the key would stay `processing` for its full
          // lease with nobody renewing it.
          if (released.kind === "state") {
            await deps.store.release(storageKey, owner, "processing");
          }
        }
      } catch {
        // Best effort only: an unreachable Redis leaves the record to expire
        // under its bounded lease.
      }
    }

    return {
      signal: abort.signal,
      get ownershipLost(): boolean {
        return ownershipLost;
      },

      async markProcessing(): Promise<"ok" | "unavailable"> {
        if (settled || ownershipLost || state !== "reserved") return "unavailable";
        const record = buildRecord({
          state: "processing",
          fingerprint,
          owner,
          expiresAtMs: deps.clock.nowMs() + processingLeaseMs,
        });
        const result = await deps.store.transition(
          storageKey,
          owner,
          "reserved",
          encodeRecord(record),
          processingLeaseMs,
        );
        if (result.kind !== "ok") {
          // The record is still `reserved` from this request's point of view, so
          // `finish()` compare-and-deletes it. No upstream call has been made.
          return "unavailable";
        }
        // Defence in depth: if the session settled while this transition was in
        // flight, its record has already been released or tombstoned, so
        // reporting success would let the caller proceed upstream against a
        // claim it no longer holds.
        if (settled || ownershipLost) return "unavailable";
        state = "processing";
        return "ok";
      },

      async commit(result: CachedResult): Promise<"ok" | "unavailable"> {
        if (state === "committed") return "ok";
        if (settled || ownershipLost || state !== "processing") return "unavailable";

        let encoded: string;
        try {
          const payload = sealPayload(
            deps.keyring.aeadKey,
            encodeCachedCompletion({ ...identity, result }),
            bindingFor(storageKey, fingerprint),
          );
          encoded = encodeRecord(
            buildFinalRecord({
              fingerprint,
              owner,
              expiresAtMs: deps.clock.nowMs() + deps.ttlMs,
              payload,
            }),
          );
        } catch {
          await settle();
          return "unavailable";
        }
        if (Buffer.byteLength(encoded, "utf8") > MAX_RECORD_BYTES) {
          await settle();
          return "unavailable";
        }

        const written = await deps.store.transition(
          storageKey,
          owner,
          "processing",
          encoded,
          deps.ttlMs,
        );
        if (written.kind === "ok") {
          state = "committed";
          settled = true;
          stopRenewal();
          return "ok";
        }
        // The answer is NOT durably recorded: never emit it. Mark the record
        // ambiguous so a repeat is blocked rather than duplicating the work.
        await settle();
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

    fingerprintBody(body: unknown): FingerprintResult {
      return fingerprintRequestBody(body, deps.keyring.bodyKey);
    },

    async begin(input: BeginInput): Promise<BeginOutcome> {
      const storageKey = buildStorageKey(
        deps.keyring,
        deps.namespace,
        input.gatewayKeyScope,
        input.clientKey,
      );
      const owner = newOwnerToken();
      const reserved = encodeRecord(
        buildRecord({
          state: "reserved",
          fingerprint: input.bodyFingerprint,
          owner,
          expiresAtMs: deps.clock.nowMs() + RESERVED_LEASE_MS,
        }),
      );
      // A `processing` record must outlive the request's own deadline so a live
      // owner's key can never expire mid-completion (see `limits.ts`).
      const processingLeaseMs = Math.min(
        input.timeoutMs + PROCESSING_LEASE_MARGIN_MS,
        MAX_PROCESSING_LEASE_MS,
      );

      const claim = await deps.store.claim(storageKey, reserved, RESERVED_LEASE_MS);
      if (claim.kind === "claimed") {
        return {
          kind: "owner",
          session: createOwnerSession(
            storageKey,
            input.bodyFingerprint,
            input.identity,
            owner,
            processingLeaseMs,
          ),
        };
      }
      if (claim.kind !== "exists") return { kind: "unavailable" };

      const immediate = classify(storageKey, input.bodyFingerprint, claim.raw);
      if (immediate !== null) {
        if (immediate.kind === "conflict") return { kind: "conflict" };
        if (immediate.kind === "unavailable") return { kind: "unavailable" };
        return {
          kind: "existing",
          resolve: (): Promise<ResolveOutcome> => Promise.resolve(immediate),
        };
      }
      // Another request holds the claim for the SAME body: wait for its result
      // under this request's own deadline.
      const deadlineMs = deps.clock.nowMs() + input.timeoutMs;
      return { kind: "existing", resolve: () => waitForExisting(storageKey, input, deadlineMs) };
    },
  };
}
