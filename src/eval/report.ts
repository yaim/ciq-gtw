/**
 * Versioned, value-free output model for the approved live tool evaluator
 * (specification section 30).
 *
 * The evaluator's earlier report reduced every gate to a bare boolean and a bare
 * percentage, so a partial run (one that aborted before the corpus completed)
 * could not be told apart from a complete pass/fail: a zero denominator printed
 * as `0%`, and a partially-sampled threshold could read as satisfied. This module
 * replaces that with an explicit output UNION and a four-state {@link GateStatus}
 * so every emitted number carries its numerator, denominator, and the planned
 * denominator a complete run requires.
 *
 * Every shape here is content-free: it carries only counts, percentages, closed
 * enums, a fixed origin, and the fixed auth mode. It never carries a credential,
 * prompt, answer, schema, argument, thread id, run id, model id, title, or any
 * thrown value.
 */
import type { UpstreamErrorCode } from "../collectiviq/errors.js";
import type { AuthObservation } from "../collectiviq/auth.js";

/** The output-model version. Bump on any breaking shape change. */
export const EVAL_REPORT_VERSION = 2 as const;

/**
 * A gate's outcome. `not_evaluated` means the scored denominator is zero (never
 * printed as `0%`); `incomplete` means some — but not the full planned — sample
 * was scored, so a threshold can never read as passed; `passed`/`failed` are
 * reported only once the required planned denominator is complete (threshold
 * gates) or from a locally-measured invariant.
 */
export type GateStatus = "passed" | "failed" | "incomplete" | "not_evaluated";

/** A threshold gate result carrying its explicit numerator/denominator. */
export interface GateResult {
  readonly status: GateStatus;
  /** Percentage over the scored sample, or null when the denominator is zero. */
  readonly pct: number | null;
  readonly numerator: number;
  readonly denominator: number;
  /** Denominator a COMPLETE run must reach before a pass/fail is possible. */
  readonly plannedDenominator: number;
  /** The section-30 threshold as a percentage. */
  readonly threshold: number;
}

/**
 * The closed set of stages an abort may occur in. Each names WHERE the run
 * stopped without revealing anything about the payload involved. Defined as a
 * `const` tuple so it doubles as a runtime allowlist (checkpoint validation).
 */
export const ABORT_STAGES = [
  "recovery-journal-init",
  "checkpoint-init",
  "credential-config",
  "toolset-compile",
  "create-thread",
  "recovery-journal-record-created",
  "process-message",
  "get-messages",
  "cleanup-delete",
  "recovery-journal-record-deleted",
  "recovery-journal-finalize",
  "checkpoint-persist",
  "interrupted",
] as const;
export type AbortStage = (typeof ABORT_STAGES)[number];

/**
 * The closed set of stable mid-run abort reasons. No free-form strings ever
 * reach an emitted report or a persisted checkpoint tombstone.
 */
export const ABORT_REASONS = [
  "create-failed",
  "interrupted-during-create",
  "cleanup-failed",
  "journal-persistence-failed",
  "round-execution-failed",
  "interrupted",
  "toolset-compile-failed",
  "checkpoint-persist-failed",
  "checkpoint-finalize-failed",
  "recovery-journal-finalize-failed",
  "credential-config-failed",
] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/**
 * The closed set of stable pre-execution / precondition block reasons emitted in
 * a {@link BlockedReport} before any credential read or network I/O.
 */
export const BLOCKED_REASONS = [
  "checkpoint-read-failed",
  "checkpoint-resume-not-approved",
  "checkpoint-incompatible",
  "checkpoint-inconsistent",
  "checkpoint-blocked",
  "checkpoint-write-failed",
  "recovery-journal-unrecovered",
  "recovery-journal-finalize-failed",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * Structured, value-free abort diagnostics. Beyond the stable reason and stage
 * it carries only a normalized upstream error code and a safe integer HTTP
 * status when they were trap-safely available, plus whether the run may be
 * resumed. It NEVER carries an error message, URL, payload, identifier, prompt,
 * response, model, schema, title, or arbitrary thrown value.
 */
export interface AbortInfo {
  /** Stable, closed-union reason (no dynamic content). */
  readonly reason: AbortReason;
  readonly stage: AbortStage;
  /** Normalized upstream code when the failure was a recognized UpstreamError. */
  readonly code: UpstreamErrorCode | null;
  /** Safe integer HTTP status when one was available. */
  readonly status: number | null;
  /**
   * Whether a later `--resume-approved` run may safely retry from the persisted
   * checkpoint. A submit/poll failure is resumable only after the created thread
   * was confirmed deleted AND the checkpoint durably persisted; an ambiguous
   * create, a cleanup failure, a journal-persistence failure, a journal-
   * finalization failure, and a checkpoint persistence failure are all
   * non-resumable (and durably block the checkpoint via a `blocked` tombstone).
   */
  readonly resumable: boolean;
}

/** Value-free cleanup totals (HTTP-delete truth plus journal-persistence truth). */
export interface CleanupTotals {
  readonly attempted: number;
  readonly deleted: number;
  readonly failed: number;
  readonly remaining: number;
  readonly journalFailures: number;
}

/** The run's checkpoint/resume state, exposed value-free in the report. */
export interface CheckpointStateReport {
  /** This run continued from a persisted checkpoint. */
  readonly resumed: boolean;
  /** `--resume-approved` was supplied. */
  readonly resumeApproved: boolean;
  /** Case cursor this run segment started from (0-based). */
  readonly startCaseIndex: number;
  /** Case cursor the checkpoint now points at (0-based). */
  readonly nextCaseIndex: number;
  /** Run-segment count including this segment. */
  readonly runSegments: number;
  /** The checkpoint was removed after a complete, fully-passing run. */
  readonly finalized: boolean;
  /** A checkpoint persist/finalize failed (a non-resumable, non-zero condition). */
  readonly persistFailed: boolean;
}

/** The credential-free, network-free preflight projection (default invocation). */
export interface PreflightReport {
  readonly version: typeof EVAL_REPORT_VERSION;
  readonly mode: "preflight";
  readonly origin: string;
  readonly authMode: "password";
  readonly plannedSingleRoundCases: number;
  readonly plannedMultiStepScenarios: number;
  readonly plannedUpstreamRounds: number;
  readonly approvalsRequired: readonly string[];
  readonly approvalsGiven: readonly string[];
  /** A resume flag was supplied on this preflight (informational only). */
  readonly resumeApproved: boolean;
}

/**
 * A pre-execution precondition failure emitted BEFORE any credential read or
 * network I/O (e.g. a checkpoint exists without `--resume-approved`, an
 * incompatible checkpoint, or an unrecovered recovery journal). It is distinct
 * from a mid-run {@link AbortInfo}; nothing upstream was attempted.
 */
export interface BlockedReport {
  readonly version: typeof EVAL_REPORT_VERSION;
  readonly mode: "blocked";
  readonly origin: string;
  readonly authMode: "password";
  /** Stable, closed-union reason (no dynamic content). */
  readonly reason: BlockedReason;
  readonly stage: AbortStage;
}

/** A progress event emitted after a cleaned attempt and a successful checkpoint write. */
export interface ProgressEvent {
  readonly version: typeof EVAL_REPORT_VERSION;
  readonly mode: "progress";
  readonly origin: string;
  readonly authMode: "password";
  readonly runSegment: number;
  readonly phase: "single" | "multi";
  /** 1-based case ordinal within the whole corpus. */
  readonly caseOrdinal: number;
  /** 1-based round ordinal within the case. */
  readonly roundOrdinal: number;
  readonly plannedUpstreamRounds: number;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  readonly completedSingleRoundCases: number;
  readonly completedMultiStepScenarios: number;
  readonly cleanup: CleanupTotals;
  /** The checkpoint was durably persisted at/after this event. */
  readonly checkpointPersisted: boolean;
}

/** The final executed report with explicit numerators, denominators, and planned totals. */
export interface ExecutedReport {
  readonly version: typeof EVAL_REPORT_VERSION;
  readonly mode: "executed";
  readonly origin: string;
  readonly authMode: "password";
  readonly plannedUpstreamRounds: number;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  readonly completedSingleRoundCases: number;
  readonly completedMultiStepScenarios: number;
  readonly plannedSingleRoundCases: number;
  readonly plannedMultiStepScenarios: number;
  readonly gates: {
    readonly schemaValidity: GateResult;
    readonly toolNameAccuracy: GateResult;
    readonly argValidity: GateResult;
    readonly singleRoundSuccess: GateResult;
    readonly multiStepSuccess: GateResult;
    readonly noSilentFallback: GateStatus;
    readonly injectionResistance: GateStatus;
    readonly parserDeterminism: GateStatus;
  };
  readonly cleanup: CleanupTotals;
  /** Value-free password-provider auth observation, when available. */
  readonly auth: AuthObservation | null;
  readonly checkpoint: CheckpointStateReport;
  readonly aborted: AbortInfo | null;
  readonly passed: boolean;
}

/** The full evaluator output union. */
export type EvalOutput = PreflightReport | BlockedReport | ProgressEvent | ExecutedReport;

/** Round a ratio to one decimal place (matching the historical `pct` precision). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Compute a threshold gate from its scored numerator/denominator, the planned
 * denominator a complete run requires, and the section-30 threshold percentage.
 * A zero denominator is `not_evaluated`; a partial (below-planned) denominator is
 * `incomplete`; only a complete denominator yields `passed`/`failed`.
 */
export function thresholdGate(
  numerator: number,
  denominator: number,
  plannedDenominator: number,
  threshold: number,
): GateResult {
  let status: GateStatus;
  if (denominator === 0) {
    status = "not_evaluated";
  } else if (denominator < plannedDenominator) {
    status = "incomplete";
  } else {
    status = (numerator / denominator) * 100 >= threshold ? "passed" : "failed";
  }
  return {
    status,
    pct: denominator === 0 ? null : round1((numerator / denominator) * 100),
    numerator,
    denominator,
    plannedDenominator,
    threshold,
  };
}

/**
 * Compute a locally-observed boolean invariant gate. A violation is `failed`
 * immediately; otherwise the gate is `passed` only once the live corpus is
 * complete, and `incomplete` while it is still partial.
 */
export function invariantGate(satisfied: boolean, corpusComplete: boolean): GateStatus {
  if (!satisfied) return "failed";
  return corpusComplete ? "passed" : "incomplete";
}
