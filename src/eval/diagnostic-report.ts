/**
 * Versioned, value-free output model for the approval-gated MULTI-STEP
 * TRANSITION DIAGNOSTIC (`npm run eval:tools:diagnose`, specification section
 * 30).
 *
 * WHY THIS EXISTS. The completed report-v4 release campaign recorded its
 * multi-step failures as `expected-tool-not-invoked`: the model produced a
 * VALID, ALLOWED tool call that simply was not the tool the round expected. The
 * release report is deliberately value-free, so it cannot distinguish whether
 * the model repeated an already-completed tool, skipped ahead to a later tool,
 * returned a mixture, chose an unrelated allowed tool, or emitted several calls
 * at once. This module adds exactly three CLOSED, value-free structural
 * dimensions that separate those cases without naming a tool.
 *
 * WHAT THIS IS NOT. This output establishes NO release gate. It carries no
 * threshold, no gate collection, and no `passed` field — only `completed`,
 * meaning the diagnostic corpus was observed end to end with clean cleanup and
 * finalization. Interpretation of the evidence, and any production remediation,
 * is a separate approval-gated decision.
 *
 * VERSIONING. {@link DIAGNOSTIC_REPORT_VERSION} is `2` and is INDEPENDENT of the
 * release evaluator's `EVAL_REPORT_VERSION` (4). The two outputs are separate
 * contracts; neither version implies anything about the other.
 *
 * SHARED VOCABULARY. The closed value-free abort/cleanup/failure-reason unions
 * are imported from `./report.ts` on purpose rather than re-declared, so the two
 * evaluators can never disagree about what a stage, reason, or cleanup total
 * means. Only the three new classification dimensions and the diagnostic output
 * shapes are owned here.
 *
 * PRIVACY. Every shape in this module is content-free: counts, closed enums, the
 * fixed public origin, and the fixed auth mode. Nothing here can carry a
 * credential, prompt, answer, tool name, tool argument, schema, model or source
 * identifier, thread/run/message/session id, title, body, URL other than the
 * fixed origin, timestamp, or thrown value. The classifier below READS tool
 * names (in-process, synthetic corpus values) but returns only a closed enum.
 */
import type { AuthObservation } from "../collectiviq/auth.js";
import type { DiagnosticChoiceKind } from "./cases.js";
import type {
  AbortInfo,
  AbortStage,
  BlockedReason,
  CleanupTotals,
  EvalFailureReason,
} from "./report.js";

/**
 * The diagnostic output-model version. Independent of `EVAL_REPORT_VERSION`;
 * bump on any breaking shape change (there is no migration path).
 *
 * v2 adds the {@link AllowedCallRelation} member `expected-already-invoked` and
 * makes the prior/future buckets HISTORY-aware rather than position-aware. The
 * round request enables parallel tool calls, so an accepted round can invoke
 * several tools at once (e.g. round 1 returning both `read` and `edit`). Under
 * v1 the classifier compared each selected name against the STATIC planned
 * sequence, so a model that correctly moved on to the next step after a parallel
 * round was reported as `future-only` — a fabricated "skip-ahead". v2 evaluates
 * against the set of names actually invoked in accepted prior rounds.
 */
export const DIAGNOSTIC_REPORT_VERSION = 2 as const;

/**
 * The fixed diagnostic profile name. It appears in every emitted record and in
 * the persisted checkpoint so a diagnostic artifact can never be mistaken for —
 * or consumed as — a release-evaluator artifact.
 */
export const DIAGNOSTIC_PROFILE = "multi-step-transition" as const;

/**
 * How the selected allowed tool-call set relates to the scenario's execution
 * HISTORY and remaining planned steps, relative to the round that failed. This
 * is the dimension the release report cannot express.
 *
 * "Prior" and "future" are judged against what the scenario ACTUALLY invoked in
 * accepted earlier rounds — not against the static planned position — because
 * the round request enables parallel tool calls, so one accepted round can
 * invoke several tools.
 *
 * - `expected-already-invoked`: this round's expected tool was ALREADY invoked in
 *   an accepted earlier round (typically as a parallel call), so the round's
 *   static expectation is stale and the model was not skipping work. This is the
 *   category that keeps a correct post-parallel continuation from being reported
 *   as a skip-ahead.
 * - `prior-only`: every selected call is a tool the scenario already invoked in
 *   an accepted earlier round (the loop repeated finished work).
 * - `future-only`: every selected call is a tool the scenario has NOT invoked yet
 *   and that a LATER planned round expects (a genuine skip-ahead).
 * - `prior-and-future`: the calls span both already-invoked and not-yet-invoked
 *   later-expected tools, with no unrelated allowed tool.
 * - `other-allowed`: the calls contain only allowed tools that are neither
 *   already invoked, the current expected tool, nor expected by a later round.
 * - `mixed-other`: at least one unrelated allowed tool appears together with an
 *   already-invoked or later-expected tool.
 * - `not-applicable`: there is no selected allowed tool-call set, the expected
 *   tool WAS present, or the failure class cannot usefully be categorized this
 *   way (an unauthorized name, ordinary text, an unavailable round, or no valid
 *   call).
 */
export type AllowedCallRelation =
  | "expected-already-invoked"
  | "prior-only"
  | "future-only"
  | "prior-and-future"
  | "other-allowed"
  | "mixed-other"
  | "not-applicable";

/**
 * Which deterministic selection path produced the generation, carried straight
 * from the trusted selector result (`ParsedGeneration.source`). It never names
 * an upstream model or answer source. `not-applicable` covers every outcome
 * with no selected tool-call set (ordinary text, no valid call, unavailable).
 */
export type DiagnosticSelectionSource =
  "desired-source" | "individual-single" | "individual-consensus" | "not-applicable";

/**
 * How many allowed calls the selection produced, bucketed. Exact counts are
 * deliberately NOT emitted — the bucket answers "did the model propose one tool
 * or several?" without quantifying the response.
 */
export type DiagnosticCallMultiplicity = "single" | "multiple" | "not-applicable";

/**
 * One value-free diagnostic for a scenario's terminal failure round. The first
 * four fields are exactly the release report's safe structural identity; the
 * last three are the new dimensions this command exists to capture.
 *
 * `caseOrdinal` is the GLOBAL corpus ordinal (201–220 for the production
 * corpus), never a diagnostic-local index, so a diagnostic can be correlated
 * with a release-campaign diagnostic by identity alone.
 */
export interface TransitionDiagnostic {
  /** 1-based GLOBAL corpus ordinal of the multi-step scenario (201–220). */
  readonly caseOrdinal: number;
  /** 1-based round ordinal within the scenario. */
  readonly roundOrdinal: number;
  /** The round's `tool_choice` kind. */
  readonly choiceKind: DiagnosticChoiceKind;
  /** The closed value-free reason the round could not be credited. */
  readonly reason: EvalFailureReason;
  readonly allowedCallRelation: AllowedCallRelation;
  readonly selectionSource: DiagnosticSelectionSource;
  readonly callMultiplicity: DiagnosticCallMultiplicity;
}

// ---------------------------------------------------------------------------
// Closed code maps for the compact on-disk checkpoint ledger
// ---------------------------------------------------------------------------
//
// Each reverse lookup is a pure closed `switch` (never a `Map`/`Set`) so the
// trust source is the FUNCTION identity: no reachable runtime mutation can
// widen an allowlist to accept an unknown code. Codes are stable — a new member
// must extend the maps, never renumber, and is a checkpoint-format-breaking
// change.

/**
 * Fixed integer codes for {@link AllowedCallRelation} (ledger use only). Codes
 * 1–6 are unchanged from v1; `expected-already-invoked` was APPENDED as 7 rather
 * than renumbering, so the ledger encoding of every pre-existing member is
 * stable.
 */
export const ALLOWED_CALL_RELATION_CODES: Readonly<Record<AllowedCallRelation, number>> =
  Object.freeze({
    "prior-only": 1,
    "future-only": 2,
    "prior-and-future": 3,
    "other-allowed": 4,
    "mixed-other": 5,
    "not-applicable": 6,
    "expected-already-invoked": 7,
  });

/** Decode a persisted relation code; `undefined` for anything unrecognized. */
export function allowedCallRelationForCode(code: unknown): AllowedCallRelation | undefined {
  if (typeof code !== "number" || !Number.isFinite(code)) return undefined;
  switch (code) {
    case 1:
      return "prior-only";
    case 2:
      return "future-only";
    case 3:
      return "prior-and-future";
    case 4:
      return "other-allowed";
    case 5:
      return "mixed-other";
    case 6:
      return "not-applicable";
    case 7:
      return "expected-already-invoked";
    default:
      return undefined;
  }
}

/** Fixed integer codes for {@link DiagnosticSelectionSource} (ledger use only). */
export const DIAGNOSTIC_SELECTION_SOURCE_CODES: Readonly<
  Record<DiagnosticSelectionSource, number>
> = Object.freeze({
  "desired-source": 1,
  "individual-single": 2,
  "individual-consensus": 3,
  "not-applicable": 4,
});

/** Decode a persisted selection-source code; `undefined` when unrecognized. */
export function diagnosticSelectionSourceForCode(
  code: unknown,
): DiagnosticSelectionSource | undefined {
  if (typeof code !== "number" || !Number.isFinite(code)) return undefined;
  switch (code) {
    case 1:
      return "desired-source";
    case 2:
      return "individual-single";
    case 3:
      return "individual-consensus";
    case 4:
      return "not-applicable";
    default:
      return undefined;
  }
}

/** Fixed integer codes for {@link DiagnosticCallMultiplicity} (ledger use only). */
export const DIAGNOSTIC_CALL_MULTIPLICITY_CODES: Readonly<
  Record<DiagnosticCallMultiplicity, number>
> = Object.freeze({
  single: 1,
  multiple: 2,
  "not-applicable": 3,
});

/** Decode a persisted multiplicity code; `undefined` when unrecognized. */
export function diagnosticCallMultiplicityForCode(
  code: unknown,
): DiagnosticCallMultiplicity | undefined {
  if (typeof code !== "number" || !Number.isFinite(code)) return undefined;
  switch (code) {
    case 1:
      return "single";
    case 2:
      return "multiple";
    case 3:
      return "not-applicable";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reason ⇄ dimension compatibility (the diagnostic contract, enforced on disk)
// ---------------------------------------------------------------------------

/**
 * Whether a failure reason implies the selection produced a tool-call set at
 * all. Only these four reasons do; the rest describe ordinary text, no valid
 * call, or an unavailable round, and therefore force `not-applicable` on the
 * selection-source and multiplicity dimensions.
 */
export function reasonHasSelectedCallSet(reason: EvalFailureReason): boolean {
  switch (reason) {
    case "expected-tool-not-invoked":
    case "unauthorized-tool-call":
    case "transcript-invalid":
    case "unexpected-tool-call-on-final":
      return true;
    case "expected-tool-returned-text":
    case "expected-tool-no-valid-call":
    case "expected-tool-unavailable":
    case "final-no-valid-call":
    case "final-unavailable":
      return false;
    default: {
      const exhaustive: never = reason;
      void exhaustive;
      return false;
    }
  }
}

/**
 * Whether a failure reason must carry a REAL (non-`not-applicable`) allowed-call
 * relation. Exactly two reasons qualify:
 *
 * - `expected-tool-not-invoked` — the reason this command exists: allowed calls
 *   were selected and the expected tool was absent, so the relation is always
 *   derivable and is mandated to be meaningful.
 * - `unexpected-tool-call-on-final` — a final round produced allowed calls when
 *   text was expected; every expected tool is prior, so the relation is
 *   likewise always derivable.
 *
 * The other seven reasons force `not-applicable`: `transcript-invalid` and
 * `unauthorized-tool-call` have a call set but no usefully categorizable
 * relation (the expected tool WAS present, or a name fell outside the
 * allowlist), and the remaining five have no call set at all.
 */
export function reasonRequiresAllowedCallRelation(reason: EvalFailureReason): boolean {
  return reason === "expected-tool-not-invoked" || reason === "unexpected-tool-call-on-final";
}

/**
 * Hard cap on persisted/emitted diagnostics: at most one terminal diagnostic per
 * scenario in the 20-scenario diagnostic corpus.
 */
export const MAX_TRANSITION_DIAGNOSTICS = 20 as const;

/**
 * Validate one diagnostic's three dimensions against its reason. Returns an
 * empty array when consistent, else a list of stable value-free rule names.
 * Used by both the fresh-construction path (defense in depth) and the
 * checkpoint validator, so an inconsistent diagnostic can never be emitted or
 * persisted.
 */
export function transitionDiagnosticDimensionErrors(d: {
  readonly reason: EvalFailureReason;
  readonly allowedCallRelation: AllowedCallRelation;
  readonly selectionSource: DiagnosticSelectionSource;
  readonly callMultiplicity: DiagnosticCallMultiplicity;
}): string[] {
  const errors: string[] = [];
  const hasCalls = reasonHasSelectedCallSet(d.reason);
  const needsRelation = reasonRequiresAllowedCallRelation(d.reason);
  if (needsRelation && d.allowedCallRelation === "not-applicable") {
    errors.push("relation-must-be-applicable");
  }
  if (!needsRelation && d.allowedCallRelation !== "not-applicable") {
    errors.push("relation-must-be-not-applicable");
  }
  if (hasCalls && d.selectionSource === "not-applicable") {
    errors.push("selection-source-must-be-applicable");
  }
  if (!hasCalls && d.selectionSource !== "not-applicable") {
    errors.push("selection-source-must-be-not-applicable");
  }
  if (hasCalls && d.callMultiplicity === "not-applicable") {
    errors.push("multiplicity-must-be-applicable");
  }
  if (!hasCalls && d.callMultiplicity !== "not-applicable") {
    errors.push("multiplicity-must-be-not-applicable");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The pure relation classifier
// ---------------------------------------------------------------------------

/** Inputs for {@link classifyAllowedCallRelation}. */
export interface AllowedCallRelationInput {
  /** The already-classified value-free failure reason for this round. */
  readonly reason: EvalFailureReason;
  /**
   * The selected call names, or `null` when the selection produced no allowed
   * call set. Names are in-process synthetic corpus values and are NEVER
   * emitted or persisted — only the returned enum leaves this function.
   *
   * A non-null but EMPTY array is treated as "no call set" and yields
   * `not-applicable`. Callers must not pair an empty call set with a
   * relation-mandating reason: the decision producer maps a zero-call
   * generation to `no_valid_call` before classification (see
   * `classifyDiagnosticDecision` in `tools-diagnostic-cli.ts`), because
   * `calls.every(...)` is vacuously true for an empty array while
   * `calls.some(...)` is false — which would otherwise label a zero-call
   * generation `expected-tool-not-invoked` and then fail the reason ⇄
   * dimension contract mid-run.
   */
  readonly selectedCallNames: readonly string[] | null;
  /** True when every selected call named a tool inside the request allowlist. */
  readonly allAllowed: boolean;
  /**
   * The scenario's expected tool per round, in round order. `undefined` marks a
   * round that expects final text (the scenario's last round).
   */
  readonly expectedToolByRound: readonly (string | undefined)[];
  /**
   * 0-based index of the FAILING round within `expectedToolByRound`. It MUST
   * index the same scenario the sequence came from; see the range check in
   * {@link classifyAllowedCallRelation}.
   */
  readonly roundIndex: number;
  /**
   * The names the scenario ACTUALLY invoked in accepted earlier rounds — the
   * execution history the prior/future buckets are judged against. It must NOT
   * yet include the failing round's own calls.
   *
   * This exists because the round request enables parallel tool calls: an
   * accepted round can invoke several tools at once, so static round position
   * does not describe what has run. Names are in-process synthetic corpus values
   * and never leave this function.
   *
   * Every earlier round of a still-running scenario was necessarily ACCEPTED
   * (a scenario terminates at its first terminal failure), and acceptance
   * requires the round's expected tool to be among its selected calls, so each
   * earlier round's expected tool is always present in this set — the
   * history-aware `prior` bucket is therefore a superset of the old
   * position-based one and never loses a correct classification.
   */
  readonly priorInvokedNames: ReadonlySet<string>;
}

/**
 * Derive the {@link AllowedCallRelation} for one failing round, purely and
 * deterministically, from the scenario's execution HISTORY plus its remaining
 * planned steps.
 *
 * Precedence:
 *
 *  1. Reason applicability: a reason that cannot carry a relation is
 *     `not-applicable` (see {@link reasonRequiresAllowedCallRelation}), as is a
 *     missing/empty call set or a set containing a name outside the allowlist.
 *  2. `expected-already-invoked`: this round's expected tool was ALREADY invoked
 *     in an accepted earlier round. The round's static expectation is stale, so
 *     the model was not skipping work — this outranks per-name bucketing, which
 *     would otherwise report a correct continuation as `future-only`.
 *  3. Per-name bucketing, in fixed order so a name occupying several roles
 *     always resolves the same way:
 *       - the CURRENT expected tool being present ⇒ `not-applicable` (the
 *         round's failure is not a transition confusion);
 *       - a name in the invoked history ⇒ `prior`;
 *       - a name NOT yet invoked but expected by a LATER planned round ⇒
 *         `future`;
 *       - anything else allowed ⇒ `other`.
 *  4. Combine: `other` with `prior`/`future` ⇒ `mixed-other`; `other` alone ⇒
 *     `other-allowed`; both ⇒ `prior-and-future`; else `prior-only` /
 *     `future-only`.
 *
 * FAILS CLOSED on an out-of-range `roundIndex`. The index is otherwise used only
 * to read the current expected tool and to bound the later-round scan, so an
 * index past the end would silently treat every planned round as already past
 * and a negative index would treat every round as still ahead — a
 * plausible-looking but wrong answer in a command whose entire purpose is
 * diagnostic accuracy. Because `roundIndex` and `expectedToolByRound` arrive as
 * separate arguments, an off-by-one or a scenario/round mispairing at the call
 * site must be loud rather than silent.
 */
export function classifyAllowedCallRelation(input: AllowedCallRelationInput): AllowedCallRelation {
  const {
    reason,
    selectedCallNames,
    allAllowed,
    expectedToolByRound,
    roundIndex,
    priorInvokedNames,
  } = input;
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= expectedToolByRound.length) {
    throw new Error("diagnostic relation classifier received a round index outside the scenario");
  }
  if (!reasonRequiresAllowedCallRelation(reason)) return "not-applicable";
  if (selectedCallNames === null || selectedCallNames.length === 0) return "not-applicable";
  if (!allAllowed) return "not-applicable";

  const current = expectedToolByRound[roundIndex];

  // Step 2: the round's expectation is stale because its tool already ran.
  if (current !== undefined && priorInvokedNames.has(current)) {
    return "expected-already-invoked";
  }

  // Tools a LATER planned round expects. A name already invoked is history, not
  // a skip-ahead, so the invoked set takes precedence over this set below.
  const laterExpected = new Set<string>();
  for (let r = roundIndex + 1; r < expectedToolByRound.length; r += 1) {
    const name = expectedToolByRound[r];
    if (name !== undefined) laterExpected.add(name);
  }

  let sawPrior = false;
  let sawFuture = false;
  let sawOther = false;
  for (const name of selectedCallNames) {
    if (current !== undefined && name === current) return "not-applicable";
    if (priorInvokedNames.has(name)) sawPrior = true;
    else if (laterExpected.has(name)) sawFuture = true;
    else sawOther = true;
  }

  if (sawOther) return sawPrior || sawFuture ? "mixed-other" : "other-allowed";
  if (sawPrior && sawFuture) return "prior-and-future";
  if (sawPrior) return "prior-only";
  if (sawFuture) return "future-only";
  // Unreachable for a non-empty allowed call set (every name lands in exactly
  // one bucket), but stay explicit and fail safe rather than guessing.
  return "not-applicable";
}

/** Map a trusted selector generation to the value-free selection-source enum. */
export function diagnosticSelectionSourceFor(
  source: "desired-source" | "individual-single" | "individual-consensus" | null,
): DiagnosticSelectionSource {
  return source ?? "not-applicable";
}

/**
 * Bucket a selected call count into the value-free multiplicity enum. Anything
 * that is not a positive integer — `null`, zero, a negative, a fraction, `NaN`,
 * or an infinity — is `not-applicable`, mirroring the fail-closed posture of the
 * ledger decoders above rather than silently bucketing a nonsense count as
 * `multiple`.
 */
export function diagnosticCallMultiplicityFor(
  callCount: number | null,
): DiagnosticCallMultiplicity {
  if (callCount === null || !Number.isInteger(callCount) || callCount <= 0) {
    return "not-applicable";
  }
  return callCount === 1 ? "single" : "multiple";
}

// ---------------------------------------------------------------------------
// The output union
// ---------------------------------------------------------------------------

/** Fields present on every diagnostic record, in every mode. */
interface DiagnosticRecordBase {
  readonly version: typeof DIAGNOSTIC_REPORT_VERSION;
  readonly profile: typeof DIAGNOSTIC_PROFILE;
  /** The FIXED public CollectivIQ origin (the only URL any record may carry). */
  readonly origin: string;
  readonly authMode: "password";
}

/** The 1-based inclusive global corpus ordinal range the diagnostic covers. */
export interface DiagnosticOrdinalRange {
  readonly first: number;
  readonly last: number;
}

/** The credential-free, network-free preflight projection (default invocation). */
export interface DiagnosticPreflightReport extends DiagnosticRecordBase {
  readonly mode: "preflight";
  /** Multi-step scenarios the diagnostic would run (20). */
  readonly plannedScenarios: number;
  /** The global corpus ordinals those scenarios occupy (201–220). */
  readonly globalOrdinalRange: DiagnosticOrdinalRange;
  /**
   * UPPER BOUND on upstream completions (80 = 20 × 4). Truthful early
   * termination means an actual run can attempt strictly fewer.
   */
  readonly plannedUpstreamRounds: number;
  readonly approvalsRequired: readonly string[];
  readonly approvalsGiven: readonly string[];
  /** A resume flag was supplied on this preflight (informational only). */
  readonly resumeApproved: boolean;
}

/**
 * A pre-execution precondition failure emitted BEFORE any credential read or
 * network I/O. Distinct from a mid-run {@link AbortInfo}: nothing upstream was
 * attempted.
 */
export interface DiagnosticBlockedReport extends DiagnosticRecordBase {
  readonly mode: "blocked";
  readonly reason: BlockedReason;
  readonly stage: AbortStage;
}

/** Progress emitted only AFTER a durable diagnostic-checkpoint write. */
export interface DiagnosticProgressEvent extends DiagnosticRecordBase {
  readonly mode: "progress";
  readonly runSegment: number;
  /** 1-based GLOBAL corpus ordinal (201–220). */
  readonly caseOrdinal: number;
  /** 1-based round ordinal within the scenario (executed rounds only). */
  readonly roundOrdinal: number;
  readonly plannedScenarios: number;
  readonly plannedUpstreamRounds: number;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  readonly completedScenarios: number;
  readonly cleanup: CleanupTotals;
  /** Always true: this event is emitted only after a durable write. */
  readonly checkpointPersisted: true;
}

/** The diagnostic run's checkpoint state, exposed value-free. */
export interface DiagnosticCheckpointStateReport {
  /** This run continued from a persisted DIAGNOSTIC checkpoint. */
  readonly resumed: boolean;
  /** `--resume-approved` was supplied. */
  readonly resumeApproved: boolean;
  /** Scenario cursor this run segment started from (0-based, diagnostic-local). */
  readonly startScenarioIndex: number;
  /** Scenario cursor the checkpoint now points at (0-based, diagnostic-local). */
  readonly nextScenarioIndex: number;
  readonly runSegments: number;
  /** The diagnostic checkpoint was removed after a complete, clean run. */
  readonly finalized: boolean;
  /** A diagnostic checkpoint persist/finalize failed (non-zero condition). */
  readonly persistFailed: boolean;
}

/**
 * The final executed diagnostic report. It carries NO gate collection and NO
 * `passed` field by design — this command gathers evidence and does not
 * establish a release gate.
 */
export interface DiagnosticExecutedReport extends DiagnosticRecordBase {
  readonly mode: "executed";
  readonly plannedScenarios: number;
  readonly globalOrdinalRange: DiagnosticOrdinalRange;
  /** UPPER BOUND (80); early termination reduces actual attempts. */
  readonly plannedUpstreamRounds: number;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  /** Scenarios observed to a commit point (completed OR terminated early). */
  readonly completedScenarios: number;
  /** Scenarios that produced every expected call AND ran to completion. */
  readonly successfulScenarios: number;
  readonly diagnostics: {
    readonly failures: readonly TransitionDiagnostic[];
  };
  readonly cleanup: CleanupTotals;
  /** Value-free password-provider auth observation, when available. */
  readonly auth: AuthObservation | null;
  readonly checkpoint: DiagnosticCheckpointStateReport;
  readonly aborted: AbortInfo | null;
  /**
   * True ONLY when every planned scenario was observed, no operational abort
   * remains, every created thread was confirmed deleted, no recovery-journal
   * failure remains, journal finalization succeeded, and the diagnostic
   * checkpoint was removed successfully. Observed MODEL failures do not make a
   * run incomplete — they are the evidence the command exists to collect.
   */
  readonly completed: boolean;
}

/** The full diagnostic output union. */
export type DiagnosticOutput =
  | DiagnosticPreflightReport
  | DiagnosticBlockedReport
  | DiagnosticProgressEvent
  | DiagnosticExecutedReport;
