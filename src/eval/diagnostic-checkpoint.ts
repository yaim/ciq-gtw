/**
 * Private, on-disk resume checkpoint for the approval-gated MULTI-STEP
 * TRANSITION DIAGNOSTIC (`npm run eval:tools:diagnose`, specification section
 * 30).
 *
 * SEPARATION IS THE POINT. This module is deliberately SELF-CONTAINED: it
 * hard-codes its own filename ({@link DIAGNOSTIC_CHECKPOINT_FILENAME}) and
 * resolves its own location, and it imports NOTHING from `./checkpoint.ts`. The
 * release evaluator's checkpoint filename, format version, schema, and
 * validation are therefore untouched and unreachable from here, so this command
 * structurally CANNOT read, overwrite, finalize, or remove the release
 * evaluator's checkpoint. The two files coexist safely in the same ignored
 * `.agent/sessions/eval/` directory because every read, write (including the
 * atomic temp name), existence probe, and delete is bound to this module's own
 * filename. The duplicated filesystem discipline is the accepted cost of that
 * structural guarantee.
 *
 * The stored record is minimal and content-free: a format version, the fixed
 * destination origin, the fixed password auth mode, the fixed diagnostic
 * profile, the deterministic synthetic-corpus fingerprint, the next safe
 * scenario cursor, a run-segment count, cumulative execution/cleanup counters,
 * a per-committed-scenario executed-round ledger, and a compact integer
 * diagnostic ledger. It never stores a credential, prompt, answer, schema,
 * argument, tool name, thread/run/message/session id, model or source
 * identifier, title, body, URL, or timestamp.
 *
 * Filesystem discipline (mirroring the recovery journal and the release
 * checkpoint):
 * - a fixed path under the ignored `.agent/sessions/eval/` directory, kept a
 *   real, private (`0700`), non-symlink directory;
 * - EVERY managed component is `lstat`-validated TOP-DOWN from the trusted base
 *   as a real, non-symlink directory on read/write/delete/exists, so a symlink
 *   at any managed level is caught before the OS would traverse it. Nothing at
 *   or above the trusted base is symlink-validated, so a legitimate platform
 *   symlink above the repository is not falsely rejected;
 * - reads open with `O_NOFOLLOW` and validate the OPEN descriptor via `fstat`
 *   (regular file, EXACTLY `0600`, within the size cap), read through a bounded
 *   loop, and reject a symlink, a non-regular/non-private/oversized file,
 *   unexpected JSON fields, malformed JSON, a wrong origin/auth/profile/version,
 *   a wrong corpus fingerprint, or any out-of-range count;
 * - writes are atomic: a cryptographically-named private temp file
 *   (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0600`) is written, `fsync`ed, then
 *   renamed; the temp is always removed on failure and a failed replacement
 *   never truncates the existing valid checkpoint;
 * - directory creation never uses recursive `mkdir`; missing components are
 *   created one at a time with the private mode and re-validated;
 * - the caller never supplies the production path.
 *
 * Format version 2 is the only accepted diagnostic checkpoint version; format
 * version 1 is rejected, and there is NO migration path.
 *
 * Importing this module performs no I/O.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  fsyncSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABORT_REASONS,
  ABORT_STAGES,
  EVAL_FAILURE_REASON_SCOPE,
  evalFailureReasonForCode,
  type AbortReason,
  type AbortStage,
  type EvalFailureReason,
} from "./report.js";
import {
  allowedCallRelationForCode,
  diagnosticCallMultiplicityForCode,
  diagnosticSelectionSourceForCode,
  DIAGNOSTIC_PROFILE,
  MAX_TRANSITION_DIAGNOSTICS,
  transitionDiagnosticDimensionErrors,
  type AllowedCallRelation,
  type DiagnosticCallMultiplicity,
  type DiagnosticSelectionSource,
  type TransitionDiagnostic,
} from "./diagnostic-report.js";
import type { DiagnosticChoiceKind, EvalCase } from "./cases.js";
import type { NormalizedToolChoice } from "../tools/types.js";

/**
 * The only supported on-disk diagnostic checkpoint format version. There is no
 * migration path: any other version is rejected on read.
 *
 * Format 2 accompanies diagnostic report v2, whose {@link AllowedCallRelation}
 * gains the appended member `expected-already-invoked` (ledger code 7) and
 * judges the prior/future buckets against the scenario's actual invocation
 * history rather than static round position. A **format 1 checkpoint is
 * REJECTED** on read: its persisted relation codes were derived under the
 * position-based rules, so replaying them under v2 accounting would mix two
 * incompatible classifications. A resumed run must start from a fresh anchor.
 */
export const DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION = 2 as const;

/**
 * The fixed diagnostic checkpoint filename. It is intentionally distinct from
 * the release evaluator's `tools-eval-checkpoint.json`, and this module never
 * references that constant, so no code path here can resolve to it.
 */
export const DIAGNOSTIC_CHECKPOINT_FILENAME = "tools-multi-step-diagnostic-checkpoint.json";

const MAX_CHECKPOINT_BYTES = 8_192;
const CHECKPOINT_FILE_MODE = 0o600;
const CHECKPOINT_DIR_MODE = 0o700;
/** Upper bound on any persisted count; the diagnostic corpus is far below this. */
const MAX_COUNT = 10_000_000;
/** A corpus fingerprint is a lowercase SHA-256 hex digest. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** Runtime allowlists for the closed abort stage/reason unions in a tombstone. */
const ABORT_STAGE_SET: ReadonlySet<string> = new Set(ABORT_STAGES);
const ABORT_REASON_SET: ReadonlySet<string> = new Set(ABORT_REASONS);

// ---------------------------------------------------------------------------
// The fingerprint-bound diagnostic corpus view
// ---------------------------------------------------------------------------

/**
 * One multi-step scenario selected for the diagnostic, carrying its GLOBAL
 * 1-based corpus ordinal (201–220 for the production corpus) alongside the
 * actual case. The ordinal is derived from the scenario's position in the FULL
 * corpus, never renumbered, so a diagnostic can be correlated with a release
 * campaign diagnostic by identity.
 */
export interface DiagnosticScenario {
  readonly caseOrdinal: number;
  readonly evalCase: EvalCase;
}

/** A round in the content-free structural projection of a diagnostic scenario. */
export interface DiagnosticProjectedRound {
  readonly choiceKind: DiagnosticChoiceKind;
  readonly hasExpectedTool: boolean;
}

/** A scenario in the content-free structural projection. */
export interface DiagnosticProjectedScenario {
  readonly caseOrdinal: number;
  readonly rounds: readonly DiagnosticProjectedRound[];
}

/**
 * The immutable, content-free structural projection of the diagnostic corpus,
 * plus the aggregate bounds derived from those SAME scenarios. It is the SOLE
 * trust source for checkpoint validation and diagnostic rehydration: nothing
 * about scenario count, round layout, ordinals, or bounds is ever taken from
 * checkpoint-claimed data.
 */
export interface DiagnosticCorpusProjection {
  readonly scenarios: readonly DiagnosticProjectedScenario[];
  /** Maximum rounds in any projected scenario (the operational round ceiling). */
  readonly maxRoundsPerScenario: number;
  /** UPPER BOUND on upstream rounds for a complete run (Σ rounds). */
  readonly plannedUpstreamRounds: number;
}

/**
 * Select the multi-step scenarios from a FULL corpus, preserving each one's
 * GLOBAL 1-based ordinal. The caller must pass the SAME `EvalCase[]` instance it
 * fingerprints and executes, so fingerprint, projection, and execution all
 * derive from one exact corpus value.
 *
 * A multi-step scenario is a case with more than one round (the same phase rule
 * the release evaluator uses) and must carry synthetic `scenarioState`; a
 * multi-round case without it cannot drive the agent loop and fails closed here,
 * before any credential read or network I/O.
 */
export function selectDiagnosticScenarios(cases: readonly EvalCase[]): DiagnosticScenario[] {
  const scenarios: DiagnosticScenario[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const evalCase = cases[i];
    if (evalCase === undefined) continue;
    if (evalCase.rounds.length <= 1) continue;
    if (evalCase.scenarioState === undefined) {
      throw new Error("diagnostic corpus rejects a multi-round case without synthetic state");
    }
    scenarios.push(Object.freeze({ caseOrdinal: i + 1, evalCase }));
  }
  return scenarios;
}

/** The closed set of `tool_choice.kind` values a diagnostic can represent. */
const DIAGNOSTIC_CHOICE_KINDS: ReadonlySet<NormalizedToolChoice["kind"]> = new Set<
  NormalizedToolChoice["kind"]
>(["auto", "required", "function"]);

function isDiagnosticChoiceKind(kind: NormalizedToolChoice["kind"]): kind is DiagnosticChoiceKind {
  return DIAGNOSTIC_CHOICE_KINDS.has(kind);
}

/**
 * Build the immutable, content-free projection from the selected scenarios.
 * Every ordinal, round count, `choiceKind`, and `hasExpectedTool` value is
 * copied from the SOURCE scenarios — never inferred — so a non-uniform corpus is
 * honored round-by-round.
 *
 * Fails CLOSED at build on any round whose `choice.kind` is outside the closed
 * diagnostic union `"auto" | "required" | "function"` (notably `"none"`, which
 * the synthetic corpus never uses and the diagnostic shape cannot represent), so
 * no downstream constructor ever needs a silent relabel and such a corpus
 * refuses to enter the pipeline before any credential read or network I/O.
 */
export function buildDiagnosticCorpusProjection(
  scenarios: readonly DiagnosticScenario[],
): DiagnosticCorpusProjection {
  const projected: DiagnosticProjectedScenario[] = [];
  let maxRoundsPerScenario = 0;
  let plannedUpstreamRounds = 0;
  for (const scenario of scenarios) {
    const rounds: DiagnosticProjectedRound[] = [];
    for (const round of scenario.evalCase.rounds) {
      if (!isDiagnosticChoiceKind(round.choice.kind)) {
        throw new Error(
          "diagnostic corpus projection rejects unsupported tool choice kind (only auto/required/function are diagnostic-representable)",
        );
      }
      rounds.push(
        Object.freeze({
          choiceKind: round.choice.kind,
          hasExpectedTool: round.expectedTool !== undefined,
        }),
      );
    }
    if (rounds.length === 0) throw new Error("diagnostic corpus projection rejects an empty case");
    if (rounds.length > maxRoundsPerScenario) maxRoundsPerScenario = rounds.length;
    plannedUpstreamRounds += rounds.length;
    projected.push(
      Object.freeze({ caseOrdinal: scenario.caseOrdinal, rounds: Object.freeze(rounds) }),
    );
  }
  return Object.freeze({
    scenarios: Object.freeze(projected),
    maxRoundsPerScenario,
    plannedUpstreamRounds,
  });
}

// ---------------------------------------------------------------------------
// The on-disk shape
// ---------------------------------------------------------------------------

/**
 * A single value-free entry in the compact on-disk diagnostic ledger, persisted
 * as a fixed six-integer tuple:
 * `[caseOrdinal, roundOrdinal, reasonCode, relationCode, sourceCode, multiplicityCode]`.
 *
 * `caseOrdinal` is the GLOBAL corpus ordinal (201–220); `roundOrdinal` is 1-based
 * within the scenario; the four codes are the fixed integers accepted by
 * `evalFailureReasonForCode`, `allowedCallRelationForCode`,
 * `diagnosticSelectionSourceForCode`, and `diagnosticCallMultiplicityForCode`.
 * `choiceKind` is NOT persisted — it is derived from the fingerprint-bound
 * projection at report-build time.
 */
export type DiagnosticCheckpointEntry = readonly [
  caseOrdinal: number,
  roundOrdinal: number,
  reasonCode: number,
  relationCode: number,
  sourceCode: number,
  multiplicityCode: number,
];

/** Cumulative cleanup counters persisted across resume segments. */
export interface DiagnosticCheckpointCleanup {
  readonly attempted: number;
  readonly deleted: number;
  readonly failed: number;
  readonly journalFailures: number;
}

/** A durable `blocked`-tombstone marker: only a closed abort stage + reason. */
export interface DiagnosticCheckpointAbort {
  readonly stage: AbortStage;
  readonly reason: AbortReason;
}

/**
 * The durable resume state:
 * - `resumable`: a normal anchor / progress / resumable-abort checkpoint; a later
 *   `--resume-approved` run may continue from `nextScenarioIndex`.
 * - `blocked`: a tombstone written for a NON-resumable abort. A later
 *   `--resume-approved` run must reject it before credentials/network; recovery
 *   requires deliberate operator archival/removal.
 */
export type DiagnosticCheckpointResumeState = "resumable" | "blocked";

/** The minimal, content-free diagnostic checkpoint shape. */
export interface DiagnosticCheckpointData {
  readonly formatVersion: typeof DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION;
  readonly origin: string;
  readonly authMode: "password";
  /** The fixed diagnostic profile; a wrong profile is rejected on read. */
  readonly profile: typeof DIAGNOSTIC_PROFILE;
  readonly corpusFingerprint: string;
  readonly resumeState: DiagnosticCheckpointResumeState;
  readonly abort: DiagnosticCheckpointAbort | null;
  /** 0-based cursor into the DIAGNOSTIC scenario slice (not a global index). */
  readonly nextScenarioIndex: number;
  readonly runSegments: number;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  readonly completedScenarios: number;
  readonly successfulScenarios: number;
  readonly cleanup: DiagnosticCheckpointCleanup;
  /**
   * Per-committed-scenario upstream-round counts, in commit order. Each entry is
   * mapped IN ORDER to its corresponding committed projected scenario and must
   * be an integer in `[1, thatScenario.rounds.length]` — the per-SCENARIO round
   * count, not the projection-wide maximum. `.length` MUST equal
   * `completedScenarios`, and the sum is the committed upstream-round floor.
   */
  readonly executedScenarioRounds: readonly number[];
  /** The compact, content-free terminal-diagnostic ledger (≤ one per scenario). */
  readonly diagnostics: readonly DiagnosticCheckpointEntry[];
}

/**
 * A checkpoint location: an explicit TRUSTED BASE plus the ordered MANAGED
 * components beneath it. Every managed component is `lstat`-validated from the
 * base downward as a real, non-symlink directory. The caller never chooses the
 * production location.
 */
export interface DiagnosticCheckpointLocation {
  readonly base: string;
  readonly components: readonly string[];
}

/** The fixed production location: repo root + `.agent/sessions/eval`. */
export function defaultDiagnosticCheckpointLocation(): DiagnosticCheckpointLocation {
  return {
    base: resolve(fileURLToPath(new URL("../../", import.meta.url))),
    components: [".agent", "sessions", "eval"],
  };
}

/**
 * The low-level filesystem operations the read/write/delete paths use, behind a
 * narrow module-internal seam. Production always uses the real `node:fs`
 * functions; tests may override individual ops to inject deterministic faults.
 * Use it only from tests, always in a `try`/`finally` that calls the restorer.
 */
export interface DiagnosticCheckpointFsOps {
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  readSync: typeof readSync;
  writeSync: typeof writeSync;
  fchmodSync: typeof fchmodSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const realFsOps: DiagnosticCheckpointFsOps = {
  openSync,
  fstatSync,
  readSync,
  writeSync,
  fchmodSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
};

let fsOps: DiagnosticCheckpointFsOps = realFsOps;

/** TEST-ONLY seam. Merge `overrides` and return a restorer for the previous set. */
export function __setDiagnosticCheckpointFsForTests(
  overrides: Partial<DiagnosticCheckpointFsOps>,
): () => void {
  const previous = fsOps;
  fsOps = { ...previous, ...overrides };
  return () => {
    fsOps = previous;
  };
}

// ---------------------------------------------------------------------------
// Path + directory discipline
// ---------------------------------------------------------------------------

function resolvedDir(loc: DiagnosticCheckpointLocation): string {
  return resolve(loc.base, ...loc.components);
}

function checkpointPath(dir: string): string {
  return resolve(dir, DIAGNOSTIC_CHECKPOINT_FILENAME);
}

/** `lstat` one path; return `null` on ENOENT, else the stats (throws value-free). */
function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("diagnostic checkpoint path is not accessible", { cause: error });
  }
}

/** Assert an existing managed component is a real, non-symlink directory. */
function assertManagedDir(stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Error("diagnostic checkpoint managed component must not be a symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error("diagnostic checkpoint managed component is not a directory");
  }
}

/**
 * Validate every managed component TOP-DOWN from the trusted base for a
 * NON-creating read/delete/exists. Returns `false` when a managed component is
 * absent (no checkpoint), and additionally requires the final directory to be
 * owner-only (`0700`). Never creates or `chmod`s anything.
 */
function assertAccessibleDir(loc: DiagnosticCheckpointLocation): boolean {
  let cursor = resolve(loc.base);
  for (let i = 0; i < loc.components.length; i += 1) {
    cursor = resolve(cursor, loc.components[i] ?? "");
    const stat = lstatOrNull(cursor);
    if (stat === null) return false;
    assertManagedDir(stat);
    if (i === loc.components.length - 1 && (stat.mode & 0o777) !== CHECKPOINT_DIR_MODE) {
      throw new Error("diagnostic checkpoint directory must be private (0700)");
    }
  }
  return true;
}

/**
 * Create-or-tighten every managed component TOP-DOWN from the trusted base to a
 * real, private, non-symlink directory. Missing components are created ONE AT A
 * TIME with the private mode (never `{ recursive: true }`, which would silently
 * follow a redirected ancestor) and re-validated.
 */
function ensureSafeDir(loc: DiagnosticCheckpointLocation): void {
  let cursor = resolve(loc.base);
  for (let i = 0; i < loc.components.length; i += 1) {
    cursor = resolve(cursor, loc.components[i] ?? "");
    const stat = lstatOrNull(cursor);
    if (stat === null) {
      mkdirSync(cursor, { mode: CHECKPOINT_DIR_MODE });
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("diagnostic checkpoint directory could not be created safely");
      }
    } else {
      assertManagedDir(stat);
    }
  }
  chmodSync(resolvedDir(loc), CHECKPOINT_DIR_MODE);
}

function fsyncDir(dir: string): void {
  let dfd: number;
  try {
    dfd = openSync(dir, fsConstants.O_RDONLY);
  } catch {
    return;
  }
  try {
    fsyncSync(dfd);
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename still lands.
  } finally {
    closeSync(dfd);
  }
}

/** Read the exact bytes of an opened descriptor under a hard cap. */
function readBoundedFromFd(fd: number): string {
  const buffer = Buffer.allocUnsafe(MAX_CHECKPOINT_BYTES + 1);
  let total = 0;
  for (;;) {
    const room = buffer.length - total;
    if (room === 0) throw new Error("diagnostic checkpoint is too large");
    const bytesRead = fsOps.readSync(fd, buffer, total, room, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_CHECKPOINT_BYTES) throw new Error("diagnostic checkpoint is too large");
  }
  return buffer.toString("utf8", 0, total);
}

// ---------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------

function assertCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new Error(`diagnostic checkpoint ${label} is out of range`);
  }
  return value;
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new Error(`diagnostic checkpoint ${label} has unexpected fields`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(obj, key)) {
      throw new Error(`diagnostic checkpoint ${label} is missing fields`);
    }
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`diagnostic checkpoint ${label} shape is invalid`);
  }
  return value as Record<string, unknown>;
}

/**
 * Strictly parse the compact `executedScenarioRounds` array into positive
 * integers. Corpus-bound consistency (length, per-scenario bounds, the committed
 * floor) lives in {@link validateResumableDiagnosticCheckpoint}, which owns the
 * projection.
 */
function parseExecutedScenarioRounds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("diagnostic checkpoint executedScenarioRounds shape is invalid");
  }
  if (value.length > MAX_COUNT) {
    throw new Error("diagnostic checkpoint executedScenarioRounds exceeds bound");
  }
  const out: number[] = [];
  for (const entry of value as unknown[]) {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 1 ||
      entry > MAX_COUNT
    ) {
      throw new Error("diagnostic checkpoint executedScenarioRounds entry is out of range");
    }
    out.push(entry);
  }
  return out;
}

/**
 * Strictly parse the compact `diagnostics` ledger into six-integer tuples.
 * Bounds are checked here at the SHAPE level only: safe positive ordinals, each
 * of the four codes decodable, the reason ⇄ dimension contract satisfied, no
 * over-count, and no duplicate `(caseOrdinal, roundOrdinal)` pair. Corpus-bound
 * consistency lives in {@link validateResumableDiagnosticCheckpoint}.
 */
function parseDiagnostics(value: unknown): DiagnosticCheckpointEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("diagnostic checkpoint diagnostics shape is invalid");
  }
  if (value.length > MAX_TRANSITION_DIAGNOSTICS) {
    throw new Error("diagnostic checkpoint diagnostics exceeds bound");
  }
  const seen = new Set<string>();
  const out: DiagnosticCheckpointEntry[] = [];
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 6) {
      throw new Error("diagnostic checkpoint diagnostics entry shape is invalid");
    }
    const ints = entry as unknown[];
    for (let k = 0; k < 6; k += 1) {
      const n: unknown = ints[k];
      if (typeof n !== "number" || !Number.isSafeInteger(n)) {
        throw new Error("diagnostic checkpoint diagnostics entry is out of range");
      }
    }
    const [co, ro, reasonCode, relationCode, sourceCode, multiplicityCode] = ints as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (co < 1 || co > MAX_COUNT || ro < 1 || ro > MAX_COUNT) {
      throw new Error("diagnostic checkpoint diagnostics ordinal is out of range");
    }
    const reason = evalFailureReasonForCode(reasonCode);
    if (reason === undefined) {
      throw new Error("diagnostic checkpoint diagnostics reason code is unknown");
    }
    const relation = allowedCallRelationForCode(relationCode);
    if (relation === undefined) {
      throw new Error("diagnostic checkpoint diagnostics relation code is unknown");
    }
    const selectionSource = diagnosticSelectionSourceForCode(sourceCode);
    if (selectionSource === undefined) {
      throw new Error("diagnostic checkpoint diagnostics selection-source code is unknown");
    }
    const callMultiplicity = diagnosticCallMultiplicityForCode(multiplicityCode);
    if (callMultiplicity === undefined) {
      throw new Error("diagnostic checkpoint diagnostics multiplicity code is unknown");
    }
    const dimensionErrors = transitionDiagnosticDimensionErrors({
      reason,
      allowedCallRelation: relation,
      selectionSource,
      callMultiplicity,
    });
    if (dimensionErrors.length > 0) {
      throw new Error("diagnostic checkpoint diagnostics dimensions are inconsistent");
    }
    const key = `${co}:${ro}`;
    if (seen.has(key)) {
      throw new Error("diagnostic checkpoint diagnostics has duplicate ordinal pair");
    }
    seen.add(key);
    out.push(Object.freeze([co, ro, reasonCode, relationCode, sourceCode, multiplicityCode]));
  }
  return out;
}

/** Parse and strictly validate raw text into {@link DiagnosticCheckpointData}. */
function parseCheckpoint(
  raw: string,
  expected: { origin: string; corpusFingerprint: string },
): DiagnosticCheckpointData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("diagnostic checkpoint is malformed JSON");
  }
  const obj = asObject(parsed, "root");
  assertExactKeys(
    obj,
    [
      "formatVersion",
      "origin",
      "authMode",
      "profile",
      "corpusFingerprint",
      "resumeState",
      "abort",
      "nextScenarioIndex",
      "runSegments",
      "attemptedRounds",
      "completedRounds",
      "completedScenarios",
      "successfulScenarios",
      "cleanup",
      "executedScenarioRounds",
      "diagnostics",
    ],
    "root",
  );

  if (obj["formatVersion"] !== DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION) {
    throw new Error("diagnostic checkpoint version is unsupported");
  }
  if (obj["origin"] !== expected.origin) {
    throw new Error("diagnostic checkpoint origin mismatch");
  }
  if (obj["authMode"] !== "password") {
    throw new Error("diagnostic checkpoint auth mode mismatch");
  }
  // A release-evaluator artifact, or any other profile, can never be consumed
  // here even if it somehow appeared under this filename.
  if (obj["profile"] !== DIAGNOSTIC_PROFILE) {
    throw new Error("diagnostic checkpoint profile mismatch");
  }
  const fingerprint = obj["corpusFingerprint"];
  if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error("diagnostic checkpoint corpus fingerprint is invalid");
  }
  if (fingerprint !== expected.corpusFingerprint) {
    throw new Error("diagnostic checkpoint corpus fingerprint mismatch");
  }

  const resumeState = obj["resumeState"];
  if (resumeState !== "resumable" && resumeState !== "blocked") {
    throw new Error("diagnostic checkpoint resumeState is invalid");
  }
  let abort: DiagnosticCheckpointAbort | null = null;
  if (resumeState === "resumable") {
    if (obj["abort"] !== null) {
      throw new Error("diagnostic checkpoint resumable abort must be null");
    }
  } else {
    const abortObj = asObject(obj["abort"], "abort");
    assertExactKeys(abortObj, ["stage", "reason"], "abort");
    const stage = abortObj["stage"];
    const reason = abortObj["reason"];
    if (typeof stage !== "string" || !ABORT_STAGE_SET.has(stage)) {
      throw new Error("diagnostic checkpoint abort stage is invalid");
    }
    if (typeof reason !== "string" || !ABORT_REASON_SET.has(reason)) {
      throw new Error("diagnostic checkpoint abort reason is invalid");
    }
    abort = { stage: stage as AbortStage, reason: reason as AbortReason };
  }

  const cleanupObj = asObject(obj["cleanup"], "cleanup");
  assertExactKeys(cleanupObj, ["attempted", "deleted", "failed", "journalFailures"], "cleanup");

  return {
    formatVersion: DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
    origin: expected.origin,
    authMode: "password",
    profile: DIAGNOSTIC_PROFILE,
    corpusFingerprint: fingerprint,
    resumeState,
    abort,
    nextScenarioIndex: assertCount(obj["nextScenarioIndex"], "nextScenarioIndex"),
    runSegments: assertCount(obj["runSegments"], "runSegments"),
    attemptedRounds: assertCount(obj["attemptedRounds"], "attemptedRounds"),
    completedRounds: assertCount(obj["completedRounds"], "completedRounds"),
    completedScenarios: assertCount(obj["completedScenarios"], "completedScenarios"),
    successfulScenarios: assertCount(obj["successfulScenarios"], "successfulScenarios"),
    cleanup: {
      attempted: assertCount(cleanupObj["attempted"], "cleanup.attempted"),
      deleted: assertCount(cleanupObj["deleted"], "cleanup.deleted"),
      failed: assertCount(cleanupObj["failed"], "cleanup.failed"),
      journalFailures: assertCount(cleanupObj["journalFailures"], "cleanup.journalFailures"),
    },
    executedScenarioRounds: parseExecutedScenarioRounds(obj["executedScenarioRounds"]),
    diagnostics: parseDiagnostics(obj["diagnostics"]),
  };
}

// ---------------------------------------------------------------------------
// Read / exists / write / delete
// ---------------------------------------------------------------------------

/**
 * Read and strictly validate the diagnostic checkpoint against the expected
 * origin and corpus fingerprint. Returns null when it does not exist. Throws
 * value-free on a symlink, non-regular/non-private/oversized file, or any
 * invalid/mismatched content. The file is opened with `O_NOFOLLOW` and validated
 * via `fstat` on the OPEN descriptor.
 */
export function readDiagnosticCheckpoint(
  loc: DiagnosticCheckpointLocation,
  expected: { origin: string; corpusFingerprint: string },
): DiagnosticCheckpointData | null {
  if (!assertAccessibleDir(loc)) return null;
  const path = checkpointPath(resolvedDir(loc));
  let fd: number;
  try {
    fd = fsOps.openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error("diagnostic checkpoint must not be a symlink", { cause: error });
    }
    throw new Error("diagnostic checkpoint is not accessible", { cause: error });
  }
  try {
    const stat = fsOps.fstatSync(fd);
    if (!stat.isFile()) throw new Error("diagnostic checkpoint must be a regular file");
    // EXACT 0600: reject group/world bits AND owner modes other than rw.
    if ((stat.mode & 0o777) !== CHECKPOINT_FILE_MODE) {
      throw new Error("diagnostic checkpoint must be private (0600)");
    }
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error("diagnostic checkpoint is too large");
    return parseCheckpoint(readBoundedFromFd(fd), expected);
  } finally {
    fsOps.closeSync(fd);
  }
}

/** Whether a diagnostic checkpoint file is present, value-free. */
export function diagnosticCheckpointExists(loc: DiagnosticCheckpointLocation): boolean {
  if (!assertAccessibleDir(loc)) return false;
  const target = checkpointPath(resolvedDir(loc));
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Wrap rather than rethrow, so this helper matches the read path and can
    // never surface a raw filesystem message (which carries the path).
    throw new Error("diagnostic checkpoint is not accessible", { cause: error });
  }
  if (stat.isSymbolicLink()) throw new Error("diagnostic checkpoint must not be a symlink");
  return stat.isFile();
}

/**
 * Shape-check the executed-round ledger before serialization. Takes `unknown` so
 * a hostile caller's non-array value is validated positionally rather than
 * trusted by its declared type.
 */
function assertExecutedScenarioRoundsShape(entries: unknown): void {
  if (!Array.isArray(entries)) {
    throw new Error("diagnostic checkpoint executedScenarioRounds shape is invalid");
  }
  const values = entries as readonly unknown[];
  if (values.length > MAX_COUNT) {
    throw new Error("diagnostic checkpoint executedScenarioRounds exceeds bound");
  }
  for (const entry of values) {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 1 ||
      entry > MAX_COUNT
    ) {
      throw new Error("diagnostic checkpoint executedScenarioRounds entry is invalid");
    }
  }
}

/**
 * Shape-check the diagnostic ledger before serialization. Mirrors
 * {@link parseDiagnostics} so a hostile caller cannot slip a malformed or
 * dimension-inconsistent ledger onto disk via {@link writeDiagnosticCheckpoint}.
 */
function assertDiagnosticsShape(entries: unknown): void {
  if (!Array.isArray(entries)) {
    throw new Error("diagnostic checkpoint diagnostics shape is invalid");
  }
  const rows = entries as readonly unknown[];
  if (rows.length > MAX_TRANSITION_DIAGNOSTICS) {
    throw new Error("diagnostic checkpoint diagnostics exceeds bound");
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row)) {
      throw new Error("diagnostic checkpoint diagnostics entry shape is invalid");
    }
    const values = row as readonly unknown[];
    if (values.length !== 6) {
      throw new Error("diagnostic checkpoint diagnostics entry shape is invalid");
    }
    const ints: number[] = [];
    for (let k = 0; k < 6; k += 1) {
      const n: unknown = values[k];
      if (typeof n !== "number" || !Number.isSafeInteger(n)) {
        throw new Error("diagnostic checkpoint diagnostics entry is invalid");
      }
      ints.push(n);
    }
    const [co, ro, reasonCode, relationCode, sourceCode, multiplicityCode] = ints as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (co < 1 || co > MAX_COUNT || ro < 1 || ro > MAX_COUNT) {
      throw new Error("diagnostic checkpoint diagnostics ordinal is invalid");
    }
    const reason = evalFailureReasonForCode(reasonCode);
    const relation = allowedCallRelationForCode(relationCode);
    const selectionSource = diagnosticSelectionSourceForCode(sourceCode);
    const callMultiplicity = diagnosticCallMultiplicityForCode(multiplicityCode);
    if (
      reason === undefined ||
      relation === undefined ||
      selectionSource === undefined ||
      callMultiplicity === undefined
    ) {
      throw new Error("diagnostic checkpoint diagnostics code is unknown");
    }
    if (
      transitionDiagnosticDimensionErrors({
        reason,
        allowedCallRelation: relation,
        selectionSource,
        callMultiplicity,
      }).length > 0
    ) {
      throw new Error("diagnostic checkpoint diagnostics dimensions are inconsistent");
    }
    const key = `${co}:${ro}`;
    if (seen.has(key)) {
      throw new Error("diagnostic checkpoint diagnostics has duplicate ordinal pair");
    }
    seen.add(key);
  }
}

/** Serialize a payload with all fields revalidated defensively (compact JSON). */
function serialize(data: DiagnosticCheckpointData): string {
  if (data.formatVersion !== DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION) {
    throw new Error("diagnostic checkpoint version is unsupported");
  }
  if (typeof data.origin !== "string" || data.origin.length === 0) {
    throw new Error("diagnostic checkpoint origin is invalid");
  }
  if (data.authMode !== "password") throw new Error("diagnostic checkpoint auth mode is invalid");
  if (data.profile !== DIAGNOSTIC_PROFILE)
    throw new Error("diagnostic checkpoint profile is invalid");
  if (typeof data.corpusFingerprint !== "string" || !FINGERPRINT_RE.test(data.corpusFingerprint)) {
    throw new Error("diagnostic checkpoint corpus fingerprint is invalid");
  }
  if (data.resumeState !== "resumable" && data.resumeState !== "blocked") {
    throw new Error("diagnostic checkpoint resumeState is invalid");
  }
  if (data.resumeState === "resumable") {
    if (data.abort !== null) throw new Error("diagnostic checkpoint resumable abort must be null");
  } else {
    if (data.abort === null) throw new Error("diagnostic checkpoint blocked abort is required");
    if (!ABORT_STAGE_SET.has(data.abort.stage)) {
      throw new Error("diagnostic checkpoint abort stage is invalid");
    }
    if (!ABORT_REASON_SET.has(data.abort.reason)) {
      throw new Error("diagnostic checkpoint abort reason is invalid");
    }
  }
  assertCount(data.nextScenarioIndex, "nextScenarioIndex");
  assertCount(data.runSegments, "runSegments");
  assertCount(data.attemptedRounds, "attemptedRounds");
  assertCount(data.completedRounds, "completedRounds");
  assertCount(data.completedScenarios, "completedScenarios");
  assertCount(data.successfulScenarios, "successfulScenarios");
  for (const [k, v] of Object.entries(data.cleanup)) assertCount(v, `cleanup.${k}`);
  assertExecutedScenarioRoundsShape(data.executedScenarioRounds);
  assertDiagnosticsShape(data.diagnostics);
  return JSON.stringify(data) + "\n";
}

/**
 * Atomically write the diagnostic checkpoint with mode `0600`. Validates and
 * byte-bounds the payload, ensures a private directory, refuses to overwrite
 * through a symlink or non-regular target, writes a cryptographically-named
 * private temp file, fsyncs and renames it into place, then fsyncs the
 * directory. The temp is always removed on failure and a failed replacement
 * never truncates the existing valid checkpoint.
 */
export function writeDiagnosticCheckpoint(
  loc: DiagnosticCheckpointLocation,
  data: DiagnosticCheckpointData,
): void {
  const payload = serialize(data);
  if (Buffer.byteLength(payload, "utf8") > MAX_CHECKPOINT_BYTES) {
    throw new Error("diagnostic checkpoint is too large");
  }

  ensureSafeDir(loc);
  const dir = resolvedDir(loc);
  const target = checkpointPath(dir);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("diagnostic checkpoint must not be a symlink");
    if (!stat.isFile()) throw new Error("diagnostic checkpoint must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const tmp = resolve(
    dir,
    `${DIAGNOSTIC_CHECKPOINT_FILENAME}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const fd = fsOps.openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    CHECKPOINT_FILE_MODE,
  );
  try {
    let written = 0;
    const bytes = Buffer.from(payload, "utf8");
    while (written < bytes.length) {
      const remaining = bytes.length - written;
      const n = fsOps.writeSync(fd, bytes, written, remaining, null);
      if (!Number.isInteger(n) || n <= 0 || n > remaining) {
        throw new Error("diagnostic checkpoint write reported invalid progress");
      }
      written += n;
    }
    fsOps.fchmodSync(fd, CHECKPOINT_FILE_MODE);
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
  } catch (error) {
    try {
      fsOps.closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      fsOps.unlinkSync(tmp);
    } catch {
      // Nothing to remove.
    }
    throw error;
  }

  try {
    fsOps.renameSync(tmp, target);
  } catch (error) {
    try {
      fsOps.unlinkSync(tmp);
    } catch {
      // Nothing to remove.
    }
    throw error;
  }
  fsyncDir(dir);
}

/**
 * Remove the DIAGNOSTIC checkpoint if present; refuses to unlink a symlink or
 * non-regular file. It can only ever target
 * {@link DIAGNOSTIC_CHECKPOINT_FILENAME}, so it can never remove the release
 * evaluator's checkpoint.
 */
export function deleteDiagnosticCheckpoint(loc: DiagnosticCheckpointLocation): void {
  if (!assertAccessibleDir(loc)) return;
  const target = checkpointPath(resolvedDir(loc));
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("diagnostic checkpoint is not accessible", { cause: error });
  }
  if (stat.isSymbolicLink()) throw new Error("diagnostic checkpoint must not be a symlink");
  if (!stat.isFile()) throw new Error("diagnostic checkpoint must be a regular file");
  fsOps.unlinkSync(target);
}

// ---------------------------------------------------------------------------
// Semantic (corpus-bound) validation
// ---------------------------------------------------------------------------

/**
 * The EXACT committed metrics a truthful resumable diagnostic checkpoint would
 * have persisted, derived from the projection plus the two ledgers. Every field
 * is a non-negative integer; nothing here is content-carrying.
 */
interface DerivedDiagnosticEvidence {
  readonly committedScenarios: number;
  readonly executedScenarioSum: number;
  readonly successfulScenarios: number;
}

/**
 * Semantic (corpus-bound) validation of a RESUMABLE diagnostic checkpoint
 * against the ACTUAL fingerprint-bound projection. Every planned bound and
 * per-round layout comes from the supplied projection — never from
 * checkpoint-claimed sizes — and validation runs BEFORE any credential read or
 * network I/O, so a corrupt, incompatible, out-of-range, semantically
 * impossible, or wrong-profile checkpoint can never begin a live run.
 *
 * Enforced:
 *
 *  1. `resumeState === "resumable"` with `abort === null` (a blocked tombstone is
 *     rejected by the caller before this, and again here).
 *  2. Defense in depth: every projected round's `choiceKind` is inside the
 *     closed diagnostic union.
 *  3. `nextScenarioIndex` STRICTLY within `0..scenarios.length` — a resumable
 *     checkpoint can never encode a complete corpus, because a genuinely
 *     complete run removes its checkpoint.
 *  4. `executedScenarioRounds.length === nextScenarioIndex === completedScenarios`
 *     and every entry within `[1, correspondingScenario.rounds.length]` — the
 *     per-SCENARIO round count, not the projection-wide maximum.
 *  5. Diagnostics: at most ONE per committed scenario (a scenario terminates at
 *     its first terminal failure); the case ordinal must be the GLOBAL ordinal of
 *     a committed projected scenario; the round must exist in THAT scenario; the
 *     round ordinal must equal that scenario's executed-round count (a scenario
 *     terminates AT its diagnostic round); the reason scope must match the
 *     round's ACTUAL `hasExpectedTool` disposition; the three dimensions must
 *     satisfy the reason ⇄ dimension contract; and an early-terminated scenario
 *     (`executed < rounds.length`) MUST carry a terminal diagnostic.
 *  6. `successfulScenarios` EXACTLY equals the derived count (ran to completion
 *     AND no terminal diagnostic), so a forged success claim is rejected.
 *  7. Upstream-round counters bounded by the committed floor
 *     (`Σ executedScenarioRounds`) plus per-run-segment slack, with
 *     `completedRounds ≤ attemptedRounds`.
 *  8. Resumable cleanup accounting truthful (deleted + failed == attempted,
 *     failed == 0, journalFailures == 0, attempted == deleted == attemptedRounds)
 *     and `runSegments >= 1`.
 *
 * Throws value-free on any inconsistency.
 */
export function validateResumableDiagnosticCheckpoint(
  data: DiagnosticCheckpointData,
  projection: DiagnosticCorpusProjection,
): void {
  if (data.resumeState !== "resumable" || data.abort !== null) {
    throw new Error("diagnostic checkpoint is not a resumable checkpoint");
  }
  if (data.profile !== DIAGNOSTIC_PROFILE) {
    throw new Error("diagnostic checkpoint profile mismatch");
  }
  const { scenarios, maxRoundsPerScenario } = projection;
  for (const scenario of scenarios) {
    for (const round of scenario.rounds) {
      if (
        round.choiceKind !== "auto" &&
        round.choiceKind !== "required" &&
        round.choiceKind !== "function"
      ) {
        throw new Error(
          "diagnostic checkpoint validation rejects a projection containing an unsupported tool choice kind",
        );
      }
    }
  }

  const cursor = data.nextScenarioIndex;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= scenarios.length) {
    throw new Error("diagnostic checkpoint cursor is out of resumable range");
  }

  const evidence = deriveDiagnosticEvidence(data, projection, cursor);

  if (data.completedScenarios !== evidence.committedScenarios) {
    throw new Error("diagnostic checkpoint completed-scenario mismatch");
  }
  if (data.successfulScenarios !== evidence.successfulScenarios) {
    throw new Error("diagnostic checkpoint successful-scenario mismatch");
  }
  if (!Number.isInteger(data.runSegments) || data.runSegments < 1) {
    throw new Error("diagnostic checkpoint run-segment count is invalid");
  }

  // Counters accumulate across resume segments, but a segment aborts at its
  // FIRST non-committing scenario, so it can leave at most ONE in-flight
  // scenario's uncommitted work: up to `maxRoundsPerScenario - 1` completed but
  // uncommitted rounds plus at most one terminal failed attempted round.
  const committed = evidence.executedScenarioSum;
  const completedCeiling = committed + data.runSegments * (maxRoundsPerScenario - 1);
  const attemptedCeiling = committed + data.runSegments * maxRoundsPerScenario;
  if (data.completedRounds > data.attemptedRounds) {
    throw new Error("diagnostic checkpoint completed exceeds attempted");
  }
  if (data.completedRounds < committed) {
    throw new Error("diagnostic checkpoint completed below committed upstream rounds");
  }
  if (data.completedRounds > completedCeiling) {
    throw new Error("diagnostic checkpoint completed above resumable ceiling");
  }
  if (data.attemptedRounds > attemptedCeiling) {
    throw new Error("diagnostic checkpoint attempted above resumable ceiling");
  }

  const c = data.cleanup;
  if (c.deleted + c.failed !== c.attempted) {
    throw new Error("diagnostic checkpoint cleanup sum mismatch");
  }
  if (c.failed !== 0) throw new Error("diagnostic checkpoint resumable cleanup has failures");
  if (c.journalFailures !== 0) {
    throw new Error("diagnostic checkpoint resumable cleanup has journal failures");
  }
  if (c.attempted !== c.deleted) {
    throw new Error("diagnostic checkpoint resumable cleanup not fully deleted");
  }
  if (data.attemptedRounds !== c.attempted) {
    throw new Error("diagnostic checkpoint attempted/cleanup mismatch");
  }
}

/**
 * Walk the first `cursor` committed scenarios of the projection and derive the
 * EXACT committed accounting a truthful run would have persisted. All structural
 * and relational rejections happen here.
 */
function deriveDiagnosticEvidence(
  data: DiagnosticCheckpointData,
  projection: DiagnosticCorpusProjection,
  cursor: number,
): DerivedDiagnosticEvidence {
  const { scenarios } = projection;
  if (data.executedScenarioRounds.length !== cursor) {
    throw new Error("diagnostic checkpoint executedScenarioRounds length mismatch");
  }

  // Index diagnostics by GLOBAL case ordinal, rejecting an uncommitted ordinal,
  // an unknown round, a scope-incompatible reason, and two diagnostics for the
  // same scenario (the runner terminates a scenario at its first failure).
  const committedOrdinals = new Map<number, number>(); // global ordinal → committed index
  for (let k = 0; k < cursor; k += 1) {
    const scenario = scenarios[k];
    if (scenario === undefined) {
      throw new Error("diagnostic checkpoint cursor references unknown scenario");
    }
    committedOrdinals.set(scenario.caseOrdinal, k);
  }

  const perScenario = new Map<number, { roundOrdinal: number; reason: EvalFailureReason }>();
  for (const [co, ro, reasonCode] of data.diagnostics) {
    const committedIndex = committedOrdinals.get(co);
    if (committedIndex === undefined) {
      throw new Error("diagnostic checkpoint diagnostics references uncommitted scenario");
    }
    const scenario = scenarios[committedIndex];
    if (scenario === undefined) {
      throw new Error("diagnostic checkpoint diagnostics references unknown scenario");
    }
    const round = scenario.rounds[ro - 1];
    if (round === undefined) {
      throw new Error("diagnostic checkpoint diagnostics references unknown round");
    }
    const reason = evalFailureReasonForCode(reasonCode);
    if (reason === undefined) {
      throw new Error("diagnostic checkpoint diagnostics reason code is unknown");
    }
    const scope = EVAL_FAILURE_REASON_SCOPE[reason];
    if (scope === "expected" && !round.hasExpectedTool) {
      throw new Error("diagnostic checkpoint diagnostics reason incompatible with final round");
    }
    if (scope === "final" && round.hasExpectedTool) {
      throw new Error(
        "diagnostic checkpoint diagnostics reason incompatible with expected-tool round",
      );
    }
    if (perScenario.has(co)) {
      throw new Error("diagnostic checkpoint diagnostics has multiple entries for one scenario");
    }
    perScenario.set(co, { roundOrdinal: ro, reason });
  }

  let executedScenarioSum = 0;
  let successfulScenarios = 0;
  for (let k = 0; k < cursor; k += 1) {
    const scenario = scenarios[k];
    if (scenario === undefined) {
      throw new Error("diagnostic checkpoint cursor references unknown scenario");
    }
    const executed = data.executedScenarioRounds[k];
    if (executed === undefined) {
      throw new Error("diagnostic checkpoint executedScenarioRounds length mismatch");
    }
    // Per-SCENARIO bound: `[1, thisScenario.rounds.length]`. A committed scenario
    // always issued at least its first round.
    if (!Number.isSafeInteger(executed) || executed < 1 || executed > scenario.rounds.length) {
      throw new Error(
        "diagnostic checkpoint executedScenarioRounds entry out of range for its scenario",
      );
    }
    executedScenarioSum += executed;

    const diag = perScenario.get(scenario.caseOrdinal) ?? null;
    if (diag !== null) {
      if (diag.roundOrdinal !== executed) {
        throw new Error(
          "diagnostic checkpoint diagnostics is not at its scenario's terminal round",
        );
      }
    } else if (executed < scenario.rounds.length) {
      throw new Error(
        "diagnostic checkpoint claims a scenario stopped early without a terminal diagnostic",
      );
    } else {
      successfulScenarios += 1;
    }
  }

  return {
    committedScenarios: cursor,
    executedScenarioSum,
    successfulScenarios,
  };
}

/**
 * Rehydrate a persisted compact diagnostic ledger into the report's expanded
 * {@link TransitionDiagnostic} shape using the fingerprint-bound projection.
 * `choiceKind` is looked up directly from the projected scenario/round — never
 * from checkpoint-claimed data and never inferred from aggregate position — and
 * the reason/relation/source/multiplicity are remapped through the immutable
 * closed decoders.
 *
 * Fails CLOSED on any impossible entry: an unknown code, a case ordinal that is
 * not a projected scenario, a round beyond that scenario, a `choiceKind` outside
 * the diagnostic union, or a dimension combination that violates the reason ⇄
 * dimension contract. The caller MUST have run
 * {@link validateResumableDiagnosticCheckpoint} against the SAME projection
 * first.
 */
export function rehydrateTransitionDiagnostics(
  entries: readonly DiagnosticCheckpointEntry[],
  projection: DiagnosticCorpusProjection,
): TransitionDiagnostic[] {
  const byOrdinal = new Map<number, DiagnosticProjectedScenario>();
  for (const scenario of projection.scenarios) byOrdinal.set(scenario.caseOrdinal, scenario);

  const out: TransitionDiagnostic[] = [];
  for (const [co, ro, reasonCode, relationCode, sourceCode, multiplicityCode] of entries) {
    const reason = evalFailureReasonForCode(reasonCode);
    if (reason === undefined) {
      throw new Error("diagnostic checkpoint diagnostics reason code is unknown");
    }
    const allowedCallRelation: AllowedCallRelation | undefined =
      allowedCallRelationForCode(relationCode);
    if (allowedCallRelation === undefined) {
      throw new Error("diagnostic checkpoint diagnostics relation code is unknown");
    }
    const selectionSource: DiagnosticSelectionSource | undefined =
      diagnosticSelectionSourceForCode(sourceCode);
    if (selectionSource === undefined) {
      throw new Error("diagnostic checkpoint diagnostics selection-source code is unknown");
    }
    const callMultiplicity: DiagnosticCallMultiplicity | undefined =
      diagnosticCallMultiplicityForCode(multiplicityCode);
    if (callMultiplicity === undefined) {
      throw new Error("diagnostic checkpoint diagnostics multiplicity code is unknown");
    }
    if (
      transitionDiagnosticDimensionErrors({
        reason,
        allowedCallRelation,
        selectionSource,
        callMultiplicity,
      }).length > 0
    ) {
      throw new Error("diagnostic checkpoint diagnostics dimensions are inconsistent");
    }
    const scenario = byOrdinal.get(co);
    if (scenario === undefined) {
      throw new Error("diagnostic checkpoint diagnostics references unknown scenario");
    }
    const round = scenario.rounds[ro - 1];
    if (round === undefined) {
      throw new Error("diagnostic checkpoint diagnostics references unknown round");
    }
    if (
      round.choiceKind !== "auto" &&
      round.choiceKind !== "required" &&
      round.choiceKind !== "function"
    ) {
      throw new Error("diagnostic checkpoint diagnostics references unsupported tool choice");
    }
    out.push({
      caseOrdinal: co,
      roundOrdinal: ro,
      choiceKind: round.choiceKind,
      reason,
      allowedCallRelation,
      selectionSource,
      callMultiplicity,
    });
  }
  return out;
}
