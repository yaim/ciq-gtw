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

/**
 * The output-model version. Bump on any breaking shape change.
 *
 * v4 (this release) captures two related semantic corrections without changing
 * any emitted field name:
 *
 *   1. Multi-step scenarios model a genuine OpenCode-style agent loop over
 *      synthetic in-memory state: ONE initial user message states the whole
 *      goal, later rounds accumulate only through assistant `tool_calls`
 *      messages and exactly linked `role: "tool"` synthetic result messages,
 *      and a scenario terminates at its first terminal failure without
 *      issuing further upstream requests.
 *   2. `plannedUpstreamRounds` is the complete-corpus UPPER BOUND (200 + 20×4
 *      = 280) — not the exact number of attempts. When a scenario terminates
 *      early it stops issuing upstream rounds, so `attemptedRounds` for a
 *      complete failed corpus can be strictly less than
 *      `plannedUpstreamRounds`. Section-30 gate denominators are unaffected:
 *      every committed multi-step scenario contributes the corpus's
 *      `expectedCallsPerScenario` (3 for this corpus) to the expected-call
 *      denominator, and 1 to the multi-step-success denominator, regardless
 *      of how many rounds it actually issued.
 *
 * v3 checkpoints and v3 reports are incompatible: an older checkpoint is
 * rejected outright with no migration path (see `src/eval/checkpoint.ts`).
 */
export const EVAL_REPORT_VERSION = 4 as const;

/**
 * The closed set of value-free failure reasons a scored round can produce.
 *
 * Each reason names WHY the scoring engine could not credit a round without
 * revealing the prompt, answer, arguments, tool schema, tool name, model name,
 * thread id, credential, title, URL, body, or any thrown value. The union is
 * closed and stable: a new reason is a breaking change (bump {@link
 * EVAL_REPORT_VERSION}). The mapping is:
 *
 * - `expected-tool-*` — a round with an `expectedTool` failed for the stated
 *   reason (the model returned ordinary text, produced no valid call,
 *   was unavailable, or invoked something else with an allowed name).
 * - `unauthorized-tool-call` — a tool call named something outside the
 *   request's allowlist (an injection-resistance violation). It applies to
 *   both an expected-tool round and a final round.
 * - `transcript-invalid` — the expected tool was correctly named and allowed,
 *   but the normalized tool-call/tool-result linkage the gateway would build
 *   for the next round failed re-validation (see `transcriptValid`).
 * - `final-*` / `unexpected-tool-call-on-final` — a round with NO `expectedTool`
 *   (the final answer round of a three-step scenario) failed for the stated
 *   reason.
 */
export type EvalFailureReason =
  | "expected-tool-returned-text"
  | "expected-tool-no-valid-call"
  | "expected-tool-unavailable"
  | "expected-tool-not-invoked"
  | "unauthorized-tool-call"
  | "transcript-invalid"
  | "unexpected-tool-call-on-final"
  | "final-no-valid-call"
  | "final-unavailable";

/**
 * The fixed internal numeric mapping used ONLY by the compact on-disk
 * checkpoint ledger. The mapping is not part of the emitted report shape;
 * callers rehydrate diagnostics into the string union at report-build time.
 * The codes are stable — a new reason must extend the codes here, not renumber
 * existing entries, and any change is a checkpoint-format-breaking change.
 */
export const EVAL_FAILURE_REASON_CODES: Readonly<Record<EvalFailureReason, number>> = Object.freeze(
  {
    "expected-tool-returned-text": 1,
    "expected-tool-no-valid-call": 2,
    "expected-tool-unavailable": 3,
    "expected-tool-not-invoked": 4,
    "unauthorized-tool-call": 5,
    "transcript-invalid": 6,
    "unexpected-tool-call-on-final": 7,
    "final-no-valid-call": 8,
    "final-unavailable": 9,
  },
);

/**
 * Reverse lookup for the closed reason ↔ code mapping. Deliberately implemented
 * as a pure closed `switch` so the trust source is the FUNCTION identity, not a
 * mutable container: no consumer can `.set(42, ...)` its way into the allowlist
 * (a `ReadonlyMap` type only hides mutation at compile time — the underlying
 * `Map` remains mutable, and `Object.freeze(new Map())` does not disable
 * `Map.prototype.set`). Returns the mapped reason for one of the fixed codes
 * 1–9 and `undefined` for anything else, including a non-number or NaN. Adding
 * a new reason requires a new case here AND a new `EVAL_FAILURE_REASON_CODES`
 * entry AND a checkpoint-format-version bump.
 */
export function evalFailureReasonForCode(code: unknown): EvalFailureReason | undefined {
  if (typeof code !== "number" || !Number.isFinite(code)) return undefined;
  switch (code) {
    case 1:
      return "expected-tool-returned-text";
    case 2:
      return "expected-tool-no-valid-call";
    case 3:
      return "expected-tool-unavailable";
    case 4:
      return "expected-tool-not-invoked";
    case 5:
      return "unauthorized-tool-call";
    case 6:
      return "transcript-invalid";
    case 7:
      return "unexpected-tool-call-on-final";
    case 8:
      return "final-no-valid-call";
    case 9:
      return "final-unavailable";
    default:
      return undefined;
  }
}

/**
 * Which category of round a reason applies to. `expected-tool` reasons and
 * `transcript-invalid` are structurally compatible ONLY with rounds carrying an
 * `expectedTool`; `final-*` and `unexpected-tool-call-on-final` are compatible
 * ONLY with a final round (no `expectedTool`); `unauthorized-tool-call` is
 * compatible with either. Checkpoint validation uses this to reject a
 * `[caseOrdinal, roundOrdinal, reasonCode]` triple whose reason cannot match
 * the referenced round in the corpus.
 */
export type EvalFailureReasonScope = "expected" | "final" | "any";

/** Which round categories each closed reason may be attributed to. */
export const EVAL_FAILURE_REASON_SCOPE: Readonly<
  Record<EvalFailureReason, EvalFailureReasonScope>
> = Object.freeze({
  "expected-tool-returned-text": "expected",
  "expected-tool-no-valid-call": "expected",
  "expected-tool-unavailable": "expected",
  "expected-tool-not-invoked": "expected",
  "unauthorized-tool-call": "any",
  "transcript-invalid": "expected",
  "unexpected-tool-call-on-final": "final",
  "final-no-valid-call": "final",
  "final-unavailable": "final",
});

/**
 * A single value-free failure record for one scored round. It carries only the
 * corpus-position identifiers a diagnostic run needs to locate the case + round
 * against the fingerprint-bound corpus — never a prompt, answer, argument,
 * schema, tool name, model name, thread id, credential, title, URL, body, or
 * thrown value. The 1-based ordinals match the JSON progress event shape.
 */
export interface EvalFailureDiagnostic {
  /** `single` for a single-round case, `multi` for a three-step scenario. */
  readonly phase: "single" | "multi";
  /** 1-based ordinal within the whole corpus (single first, then multi). */
  readonly caseOrdinal: number;
  /** 1-based round ordinal within the case (single = 1; multi = 1..N). */
  readonly roundOrdinal: number;
  /** The `tool_choice` kind for this round (auto / required / named function). */
  readonly choiceKind: "auto" | "required" | "function";
  /** The closed value-free reason the scoring engine could not credit this round. */
  readonly reason: EvalFailureReason;
}

/** Hard cap on persisted diagnostic entries; matches the fixed 280-round corpus. */
export const MAX_DIAGNOSTIC_FAILURES = 280 as const;

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
  /**
   * Complete-corpus upper bound on upstream completions (200 + 20 × 4 = 280).
   * See the {@link EVAL_REPORT_VERSION} docstring: when a multi-step scenario
   * terminates early, actual attempts fall below this bound, but section-30
   * gate denominators are unaffected.
   */
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
  /** 1-based round ordinal within the case (executed rounds only). */
  readonly roundOrdinal: number;
  /**
   * Complete-corpus upper bound on upstream completions (see {@link
   * EVAL_REPORT_VERSION}). Not equal to actual attempts when scenarios
   * terminate early.
   */
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
  /**
   * Complete-corpus upper bound on upstream completions (see {@link
   * EVAL_REPORT_VERSION}). Not equal to `attemptedRounds` when a complete
   * failed corpus terminates scenarios early.
   */
  readonly plannedUpstreamRounds: number;
  /** Actual upstream completions issued in this run. */
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
  /**
   * Value-free failure diagnostics for a diagnostic-guided rerun. `failures`
   * lists at most one PRIMARY diagnostic per FAILED round (see the classifier
   * in `tools-eval-cli.ts`), bounded by the fixed 280-round corpus and stripped
   * of every prompt/answer/id/credential/tool-name/model-name value. A complete
   * passing run emits an empty `failures` array. Only present on `executed`.
   */
  readonly diagnostics: {
    readonly failures: readonly EvalFailureDiagnostic[];
  };
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
