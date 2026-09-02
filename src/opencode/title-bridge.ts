/**
 * Process-local native-title correlation service (the gateway half of the
 * one-thread native-title bridge).
 *
 * After a completion succeeds, the chat route registers the correlation
 * `{ gatewayKeyId, openCodeSessionId → upstreamThreadId }` here. The
 * `GET /v1/opencode/session-title` route later looks it up and performs a bounded,
 * best-effort `get_threads` read to obtain that thread's server-generated title.
 *
 * Privacy and bounds (all fail closed and stay content-free):
 *  - Stores ONLY the two opaque ids plus the upstream thread id — never a title,
 *    prompt, or answer. A fetched title is returned to the caller and never cached.
 *  - Keyed by `gatewayKeyId + sessionId`; first registration wins (a later
 *    completion for the same session never replaces the mapping). With optional
 *    thread reuse enabled (specification §5.1.1) the route registers ONLY for the
 *    turn that CREATED the upstream thread, since the provider generates its
 *    native title once and a continuing turn has nothing new to propagate.
 *  - TTL 60 s with lazy expiry (a bounded sweep on registration; no per-entry
 *    timer). Global cap 128 entries, per-key cap 32; when full, registration is
 *    silently skipped and the completion still succeeds.
 *  - At most one in-flight upstream lookup per correlation (single-flight), a
 *    minimum 2 s between actual upstream lookups, and at most 6 actual lookups per
 *    correlation. Unknown, expired, or exhausted correlations are unavailable.
 *  - Correlation is process-local: a restart safely loses pending propagation.
 *
 * The upstream `get_threads` read is OBSERVED-ONLY and account/principal
 * dependent; a lookup failure is treated as pending while attempts remain, then
 * unavailable, and never surfaces a raw upstream value.
 */
import type { CollectivIQAdapter } from "../collectiviq/types.js";
import type { Clock } from "../generation/types.js";

/** Correlation TTL, in ms. */
const TTL_MS = 60_000;
/** Global maximum number of live correlations. */
const MAX_GLOBAL = 128;
/** Per-gateway-key maximum number of live correlations. */
const MAX_PER_KEY = 32;
/** Minimum wall-clock gap between two ACTUAL upstream lookups for one correlation. */
const MIN_LOOKUP_INTERVAL_MS = 2_000;
/** Maximum number of ACTUAL upstream lookups per correlation. */
const MAX_LOOKUPS = 6;

/** The public result of a title lookup (never carries a raw upstream value). */
export type TitleLookupOutcome =
  | { readonly kind: "ready"; readonly title: string }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" };

const PENDING: TitleLookupOutcome = { kind: "pending" };
const UNAVAILABLE: TitleLookupOutcome = { kind: "unavailable" };

/** Inputs identifying one correlation (both ids are opaque). */
export interface CorrelationKey {
  /** Opaque gateway-key identity (per-key isolation). */
  readonly keyId: string;
  /** Opaque, already-validated OpenCode session id. */
  readonly sessionId: string;
}

/** A successful-completion registration. */
export interface TitleRegistration extends CorrelationKey {
  /** The normalized upstream thread id created for this completion. */
  readonly upstreamThreadId: string;
}

/** The process-local correlation/lookup service. */
export interface TitleBridge {
  /**
   * Register a successful completion's correlation. Synchronous, bounded, and
   * non-throwing; it can never alter the completion result. First registration
   * for a `{keyId, sessionId}` wins; a full registry silently skips.
   */
  register(registration: TitleRegistration): void;
  /**
   * Look up the correlation's native title. Never throws; returns `ready`
   * (validated title), `pending` (not renamed yet / floor / recoverable failure
   * with attempts remaining), or `unavailable` (unknown, expired, or exhausted).
   */
  lookup(key: CorrelationKey, signal: AbortSignal): Promise<TitleLookupOutcome>;
}

interface Correlation {
  readonly keyId: string;
  readonly upstreamThreadId: string;
  readonly createdAtMs: number;
  /** Number of ACTUAL upstream lookups performed so far. */
  attempts: number;
  /** `nowMs` of the last actual upstream lookup (−∞ until the first). */
  lastLookupMs: number;
  /** The single in-flight lookup promise, or null when idle. */
  inFlight: Promise<TitleLookupOutcome> | null;
}

/** Dependencies for {@link createTitleBridge}. */
export interface TitleBridgeDeps {
  /** Only the OBSERVED-ONLY title lookup is used. */
  readonly adapter: Pick<CollectivIQAdapter, "getThreadTitle">;
  readonly clock: Clock;
}

/** Compose `keyId` and `sessionId` into a collision-free map key (neither value contains `\n`). */
function compositeKey(keyId: string, sessionId: string): string {
  return `${keyId}\n${sessionId}`;
}

/** Build the process-local title bridge. */
export function createTitleBridge(deps: TitleBridgeDeps): TitleBridge {
  const entries = new Map<string, Correlation>();

  const isExpired = (entry: Correlation, now: number): boolean => now - entry.createdAtMs > TTL_MS;

  /** Bounded sweep (≤128 entries) removing expired correlations. */
  const pruneExpired = (now: number): void => {
    for (const [key, entry] of entries) {
      if (isExpired(entry, now)) entries.delete(key);
    }
  };

  const countForKey = (keyId: string): number => {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.keyId === keyId) count += 1;
    }
    return count;
  };

  return {
    register(registration: TitleRegistration): void {
      try {
        const now = deps.clock.nowMs();
        pruneExpired(now);
        const key = compositeKey(registration.keyId, registration.sessionId);
        // First registration wins: never replace a live correlation.
        if (entries.has(key)) return;
        // Enforce capacity; when full, silently skip (the completion still succeeds).
        if (entries.size >= MAX_GLOBAL) return;
        if (countForKey(registration.keyId) >= MAX_PER_KEY) return;
        entries.set(key, {
          keyId: registration.keyId,
          upstreamThreadId: registration.upstreamThreadId,
          createdAtMs: now,
          attempts: 0,
          lastLookupMs: Number.NEGATIVE_INFINITY,
          inFlight: null,
        });
      } catch {
        // Registration must never throw or affect the completion.
      }
    },

    async lookup(key: CorrelationKey, signal: AbortSignal): Promise<TitleLookupOutcome> {
      try {
        const now = deps.clock.nowMs();
        const mapKey = compositeKey(key.keyId, key.sessionId);
        const entry = entries.get(mapKey);
        if (entry === undefined || isExpired(entry, now)) {
          if (entry !== undefined) entries.delete(mapKey);
          return UNAVAILABLE;
        }
        // Single-flight: concurrent callers share the one in-flight lookup.
        if (entry.inFlight !== null) return await entry.inFlight;
        // Exhausted the actual-lookup budget.
        if (entry.attempts >= MAX_LOOKUPS) return UNAVAILABLE;
        // Two-second floor between actual upstream lookups: report pending without a call.
        if (now - entry.lastLookupMs < MIN_LOOKUP_INTERVAL_MS) return PENDING;

        entry.attempts += 1;
        entry.lastLookupMs = now;
        const attemptNo = entry.attempts;
        const promise = (async (): Promise<TitleLookupOutcome> => {
          try {
            const result = await deps.adapter.getThreadTitle(entry.upstreamThreadId, signal);
            if (result.kind === "ready") return { kind: "ready", title: result.title };
            return PENDING;
          } catch {
            // Content-free: pending while attempts remain, otherwise unavailable.
            return attemptNo >= MAX_LOOKUPS ? UNAVAILABLE : PENDING;
          }
        })();
        entry.inFlight = promise;
        try {
          return await promise;
        } finally {
          entry.inFlight = null;
        }
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
