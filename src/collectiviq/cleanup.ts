/**
 * Shared, value-free cleanup diagnostics for the discovery baseline and the
 * recovery command.
 *
 * A cleanup DELETE is reduced to a bounded, content-free summary — a phase, an
 * `ok` flag, an optional HTTP status, and a normalized safe {@link
 * UpstreamErrorCode}. It NEVER carries an identifier, path, URL, header, body,
 * credential, or exception message, so a `403` can be distinguished from a
 * timeout or a network failure without exposing anything sensitive.
 */
import { deleteThreadPath } from "./endpoints.js";
import { UpstreamError, upstreamErrorForStatus, type UpstreamErrorCode } from "./errors.js";
import { observeUpstreamJson } from "./http.js";
import type { CollectivIQTransportConfig, OperationTimeouts } from "./types.js";

/** Which stage of the workflow issued a counted cleanup DELETE. */
export type DiscoveryCleanupPhase = "not-found-initial" | "final-cleanup" | "recovery-cleanup";

/** One value-free cleanup attempt summary. Contains no id, path, or body. */
export interface DiscoveryCleanupAttempt {
  readonly phase: DiscoveryCleanupPhase;
  readonly ok: boolean;
  /** HTTP status when a response was received; otherwise null. */
  readonly status: number | null;
  /** Normalized safe error code for a non-2xx/failed attempt; otherwise null. */
  readonly errorCode: UpstreamErrorCode | null;
  /**
   * Whether the journal removal for this thread was durably persisted, kept
   * separate from the HTTP DELETE truth:
   * - `true`: the DELETE succeeded and the journal removal persisted;
   * - `false`: the DELETE succeeded but the journal removal failed (the thread
   *   is dropped from the in-memory ledger anyway; the stale journal converges
   *   through recovery's exact-404 handling);
   * - `null`: the DELETE failed, so no journal removal was attempted.
   */
  readonly journalPersisted: boolean | null;
}

/**
 * Sanitized cleanup outcome: cumulative bounded counts plus a bounded list of
 * value-free attempt summaries. Never ids or bodies. `attempted`/`succeeded`/
 * `failed` count every session-owned DELETE that is cleanup work (including the
 * not-found probe's first deletion, but never its second already-deleted
 * observation) and describe HTTP DELETE outcomes ONLY. `remaining` is the number
 * of owned threads still undeleted. `journalPersistenceFailed` is the count of
 * attempts whose DELETE succeeded but whose journal removal failed
 * (`journalPersisted: false`); it is a non-zero-exit condition on its own.
 */
export interface DiscoveryCleanupReport {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly remaining: number;
  readonly journalPersistenceFailed: number;
  readonly attempts: readonly DiscoveryCleanupAttempt[];
}

/** Value-free diagnostics for a single thread deletion. */
export interface DeleteDiagnostics {
  readonly ok: boolean;
  readonly status: number | null;
  readonly errorCode: UpstreamErrorCode | null;
}

/**
 * How a recovery deletion resolved a journal-owned id. `deleted` is a real HTTP
 * 2xx deletion; `already_absent` is an EXACT HTTP 404 (the thread is confirmed
 * gone upstream). Both resolve ownership for recovery; neither relabels the HTTP
 * truth (a 404 is still a non-2xx response in {@link DeleteDiagnostics}).
 */
export type DeleteResolution = "deleted" | "already_absent";

/**
 * The outcome of a recovery deletion attempt: the HTTP-truthful diagnostics plus
 * a recovery-facing resolution. Only a 2xx (`deleted`) or an exact 404
 * (`already_absent`) is `resolved`; every other status, transport, or timeout
 * failure stays unresolved and must be retried by a later recovery run.
 */
export interface DeleteResolutionOutcome {
  readonly diagnostics: DeleteDiagnostics;
  readonly resolved: boolean;
  readonly resolution: DeleteResolution | null;
}

/**
 * One value-free recovery attempt. Preserves the HTTP truth (`ok`/`status`/
 * `errorCode`) alongside the recovery classification. `resolved` is true only
 * when the deletion resolved ownership AND the journal removal was durably
 * persisted; if persistence failed, `resolved` is false and `persisted` is false
 * so a later run retries. Contains no id, path, or body.
 */
export interface RecoveryAttempt {
  /** True only for an HTTP 2xx deletion (a 404 stays false). */
  readonly ok: boolean;
  readonly status: number | null;
  readonly errorCode: UpstreamErrorCode | null;
  /** Ownership resolved AND durably removed from the journal. */
  readonly resolved: boolean;
  /** How ownership resolved, when it did and was persisted; otherwise null. */
  readonly resolution: DeleteResolution | null;
  /** Whether the journal removal for this id was durably written. */
  readonly persisted: boolean;
}

/**
 * Sanitized recovery outcome: bounded counts plus value-free per-attempt
 * summaries. `resolved` counts ids durably removed from the journal;
 * `unresolved` counts ids still pending (a non-2xx/non-404 delete, or a delete
 * whose journal removal could not be persisted). `remaining` is the number of
 * ids still recorded in the journal. Never ids or bodies.
 */
export interface RecoveryCleanupReport {
  readonly attempted: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly remaining: number;
  readonly attempts: readonly RecoveryAttempt[];
}

/**
 * Perform ONE bounded DELETE against a session-owned thread id and reduce the
 * outcome to value-free diagnostics. A non-2xx JSON observation keeps its
 * numeric status and normalized safe code; a thrown {@link UpstreamError} keeps
 * only its allowed status/code; any other failure stays `status: null,
 * errorCode: null`. Never returns a body, header, identifier, path, or message.
 */
export async function observeThreadDeletion(
  config: CollectivIQTransportConfig,
  threadId: string,
  timeouts: OperationTimeouts,
  signal?: AbortSignal,
): Promise<DeleteDiagnostics> {
  try {
    const raw = await observeUpstreamJson(config, {
      method: "DELETE",
      path: deleteThreadPath(threadId),
      timeouts,
      ...(signal ? { signal } : {}),
    });
    return {
      ok: raw.ok,
      status: raw.status,
      errorCode: raw.ok ? null : upstreamErrorForStatus(raw.status, "DELETE").code,
    };
  } catch (error) {
    // A size-cap, strict-UTF-8, timeout, cancellation, or network failure throws
    // a normalized UpstreamError; anything else fails closed with no detail.
    if (error instanceof UpstreamError) {
      return { ok: false, status: error.rawStatus ?? null, errorCode: error.code };
    }
    return { ok: false, status: null, errorCode: null };
  }
}

/**
 * Resolve a recovery deletion of a journal-owned id. A 2xx means the thread was
 * deleted; an EXACT HTTP 404 means it is already absent — both resolve ownership
 * so recovery can converge across the crash window where a prior DELETE
 * succeeded but the journal update did not. Every other status (e.g. 403, 410),
 * transport failure, or timeout stays unresolved for a later retry. The HTTP
 * truth (`ok`/`status`/`errorCode`) is preserved verbatim; a 404 is never
 * relabeled as a successful HTTP response.
 */
export async function resolveThreadDeletion(
  config: CollectivIQTransportConfig,
  threadId: string,
  timeouts: OperationTimeouts,
  signal?: AbortSignal,
): Promise<DeleteResolutionOutcome> {
  const diagnostics = await observeThreadDeletion(config, threadId, timeouts, signal);
  if (diagnostics.ok) return { diagnostics, resolved: true, resolution: "deleted" };
  if (diagnostics.status === 404)
    return { diagnostics, resolved: true, resolution: "already_absent" };
  return { diagnostics, resolved: false, resolution: null };
}
