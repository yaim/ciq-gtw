/**
 * Private, on-disk resume checkpoint for the approved live tool evaluator
 * (specification section 30).
 *
 * The checkpoint is the ONLY durable record that lets a fully-cleaned but
 * operationally-aborted evaluator run resume from where it stopped WITHOUT
 * replaying any upstream POST or re-scoring work it already completed. It is
 * deliberately minimal and content-free: it stores a format version, the fixed
 * destination origin, the fixed password auth mode, the deterministic synthetic-
 * corpus fingerprint, the next safe case cursor, a run-segment count, cumulative
 * execution/cleanup counts, and the committed gate accumulators and invariant
 * counters — never a credential, prompt, answer, schema, argument, thread id,
 * run id, model id, title, or timestamp.
 *
 * It mirrors the recovery journal's filesystem discipline:
 * - a fixed path under the ignored `.agent/sessions/eval/` directory, kept a
 *   real, private (`0700`), non-symlink directory;
 * - reads open with `O_NOFOLLOW` and validate the OPEN descriptor via `fstat`
 *   (regular file, private `0600`, within the size cap), read through a bounded
 *   loop, and reject a symlink, a non-regular/non-private/oversized file,
 *   unexpected JSON fields, malformed JSON, a wrong origin/auth/version, a wrong
 *   corpus fingerprint, or any out-of-range count;
 * - writes are atomic: a cryptographically-named private temp file
 *   (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0600`) is written, `fsync`ed, then renamed;
 *   the temp is always removed on failure and a failed replacement never
 *   truncates the existing valid checkpoint;
 * - the caller never supplies the path.
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
  MAX_DIAGNOSTIC_FAILURES,
  type AbortReason,
  type AbortStage,
  type EvalFailureDiagnostic,
  type EvalFailureReason,
} from "./report.js";
import type { DiagnosticChoiceKind, EvalCorpusProjection } from "./cases.js";
import {
  MIN_SUCCESSFUL_SCENARIO_ROUNDS,
  popcount,
  prefixMask,
  SCENARIO_STEP_COUNT,
} from "./scenario-engine.js";

/**
 * The only supported on-disk checkpoint format version. Format 4 replaces
 * format 3's `executedScenarioRounds` integer ledger with the richer
 * per-committed-scenario {@link CheckpointScenarioEvidence} tuple, because
 * multi-step scoring is now STATE-AWARE: gate evidence is measured per planned
 * TRANSITION rather than per upstream round, so an executed-round count alone
 * can no longer prove what a committed scenario earned.
 *
 * Formats 1, 2, and 3 are REJECTED on read with NO migration path: their
 * accounting was positional (one expected tool per round ordinal) and cannot
 * be replayed under transition-based accounting. A resumed run started from an
 * older checkpoint must start from a fresh anchor.
 */
export const CHECKPOINT_FORMAT_VERSION = 4 as const;
/** Fixed checkpoint filename. */
export const CHECKPOINT_FILENAME = "tools-eval-checkpoint.json";

const MAX_CHECKPOINT_BYTES = 8_192;
const CHECKPOINT_FILE_MODE = 0o600;
const CHECKPOINT_DIR_MODE = 0o700;
/** Upper bound on any persisted count; the corpus is far below this. */
const MAX_COUNT = 10_000_000;
/** A corpus fingerprint is a lowercase SHA-256 hex digest. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** Runtime allowlists for the closed abort stage/reason unions in a tombstone. */
const ABORT_STAGE_SET: ReadonlySet<string> = new Set(ABORT_STAGES);
const ABORT_REASON_SET: ReadonlySet<string> = new Set(ABORT_REASONS);

/**
 * The low-level filesystem operations the read/write/delete paths use, behind a
 * narrow module-internal seam. Production always uses the real `node:fs`
 * functions; tests may override individual ops to inject deterministic faults (a
 * zero-progress write, a temp collision, a rename failure, descriptor growth).
 * Never re-exported from `src/eval/index`; use it only from tests, always in a
 * `try`/`finally` that calls the returned restorer.
 */
export interface CheckpointFsOps {
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

const realFsOps: CheckpointFsOps = {
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

let fsOps: CheckpointFsOps = realFsOps;

/** TEST-ONLY seam. Merge `overrides` and return a restorer for the previous set. */
export function __setCheckpointFsForTests(overrides: Partial<CheckpointFsOps>): () => void {
  const previous = fsOps;
  fsOps = { ...previous, ...overrides };
  return () => {
    fsOps = previous;
  };
}

/**
 * A single value-free entry in the compact on-disk diagnostic ledger. Each
 * triple is `[caseOrdinal, roundOrdinal, reasonCode]`:
 *  - `caseOrdinal` is a 1-based global corpus ordinal (singles first, then
 *    multi-step scenarios);
 *  - `roundOrdinal` is a 1-based round ordinal within the case;
 *  - `reasonCode` is one of the fixed integers accepted by
 *    {@link evalFailureReasonForCode} (see `report.ts`).
 *
 * The ledger carries NO phase, choice, prompt, answer, argument, tool schema,
 * tool name, model name, thread id, credential, title, URL, body, or thrown
 * value. Phase, choice, and human-readable reason are rehydrated from the
 * fingerprint-bound {@link buildEvalCases} corpus at report-build time. Storage
 * is deliberately compact so the worst valid 280-entry ledger stays well below
 * {@link MAX_CHECKPOINT_BYTES}.
 */
export type CheckpointDiagnosticFailure = readonly [
  caseOrdinal: number,
  roundOrdinal: number,
  reasonCode: number,
];

/**
 * One committed multi-step scenario's compact, content-free evidence tuple
 * (format 4). Entries appear in COMMIT ORDER and map one-to-one, in projection
 * order, onto the committed multi-step cases.
 *
 *  - `executedRounds` — upstream rounds the scenario actually issued, in
 *    `[1, correspondingCase.rounds.length]`. Under state-aware accounting a
 *    SUCCESSFUL scenario may use fewer rounds than its budget when a parallel
 *    batch completed several transitions at once.
 *  - `satisfiedSteps` — how many of the planned transitions SUCCEEDED, in
 *    `[0, plannedSteps]`. Success is prerequisite-gated, so the satisfied
 *    steps are always the leading PREFIX of the workflow and a count fully
 *    describes them.
 *  - `schemaMask` / `nameMask` / `argMask` — per-step bitmasks (bit `i` is the
 *    i-th planned transition) recording schema-validity, expected-name
 *    accuracy, and argument-validity evidence. Each step contributes exactly
 *    one unit to its gate denominator at commit, so a retried step merges its
 *    evidence instead of being counted twice.
 *
 * The tuple carries ONLY counts and bitmasks: no tool name, argument, schema,
 * prompt, answer, model name, id, credential, title, body, URL, timestamp, or
 * thrown value. Storage is deliberately compact so the worst valid ledger stays
 * well below {@link MAX_CHECKPOINT_BYTES}.
 */
export type CheckpointScenarioEvidence = readonly [
  executedRounds: number,
  satisfiedSteps: number,
  schemaMask: number,
  nameMask: number,
  argMask: number,
];

/** Cumulative cleanup counters persisted across resume segments. */
export interface CheckpointCleanup {
  readonly attempted: number;
  readonly deleted: number;
  readonly failed: number;
  readonly journalFailures: number;
}

/** Committed gate accumulators persisted across resume segments. */
export interface CheckpointGates {
  readonly expectedCall: {
    readonly total: number;
    readonly schemaValid: number;
    readonly nameAccurate: number;
    readonly argValid: number;
  };
  readonly single: { readonly total: number; readonly success: number };
  readonly multi: { readonly total: number; readonly success: number };
}

/** Locally-observed invariant counters persisted across resume segments. */
export interface CheckpointInvariants {
  readonly noSilentFallback: boolean;
  readonly injectionResistance: boolean;
}

/**
 * A durable, value-free `blocked`-tombstone marker: only a closed abort stage +
 * reason, never a message, id, or upstream body.
 */
export interface CheckpointAbort {
  readonly stage: AbortStage;
  readonly reason: AbortReason;
}

/**
 * The durable resume state:
 * - `resumable`: a normal anchor / progress / resumable-abort checkpoint; a later
 *   `--resume-approved` run may continue from `nextCaseIndex`.
 * - `blocked`: a tombstone written for a NON-resumable abort. A later
 *   `--resume-approved` run must reject it before credentials/network; recovery
 *   requires deliberate operator archival/removal.
 */
export type CheckpointResumeState = "resumable" | "blocked";

/** The minimal, content-free checkpoint shape. */
export interface CheckpointData {
  readonly formatVersion: typeof CHECKPOINT_FORMAT_VERSION;
  readonly origin: string;
  readonly authMode: "password";
  readonly corpusFingerprint: string;
  /** Durable resumable-vs-blocked state (finding 2). */
  readonly resumeState: CheckpointResumeState;
  /** The closed abort stage/reason for a `blocked` tombstone; null when resumable. */
  readonly abort: CheckpointAbort | null;
  readonly nextCaseIndex: number;
  readonly runSegments: number;
  readonly attemptedRounds: number;
  readonly completedRounds: number;
  readonly completedSingleRoundCases: number;
  readonly completedMultiStepScenarios: number;
  readonly cleanup: CheckpointCleanup;
  readonly gates: CheckpointGates;
  readonly invariants: CheckpointInvariants;
  /**
   * Per-committed-multi-step-scenario evidence, in commit order. See
   * {@link CheckpointScenarioEvidence}. `.length` MUST equal
   * `completedMultiStepScenarios`, and the sum of the tuples' executed-round
   * elements PLUS `completedSingleRoundCases` is the committed upstream-round
   * floor used by resumable-counter validation.
   */
  readonly scenarioEvidence: readonly CheckpointScenarioEvidence[];
  /**
   * The compact, content-free ledger of scored-round failure diagnostics
   * committed by the run. Bounded to {@link MAX_DIAGNOSTIC_FAILURES} entries,
   * with unique `(caseOrdinal, roundOrdinal)` pairs, and validated against the
   * fingerprint-bound corpus during {@link validateResumableCheckpoint}. A
   * complete passing run persists an empty ledger before finalization removes
   * the checkpoint.
   */
  readonly diagnosticFailures: readonly CheckpointDiagnosticFailure[];
}

/**
 * A checkpoint location: an explicit TRUSTED BASE plus the ordered MANAGED
 * components beneath it (finding 2). Every managed component is `lstat`-validated
 * from the base downward as a real, non-symlink directory, so a symlink at ANY
 * managed level is caught before the OS would traverse it. Nothing AT or ABOVE the
 * trusted base is symlink-validated, so legitimate platform symlinks above the
 * repository (or a temporary test root) — e.g. macOS `/var`→`/private/var` — are
 * intentionally out of scope. The caller never chooses the production location.
 */
export interface CheckpointLocation {
  /** Trusted base; nothing at or above it is symlink-validated. */
  readonly base: string;
  /** Managed components under {@link base}, each validated as a non-symlink directory. */
  readonly components: readonly string[];
}

/** The fixed production checkpoint location: repo root + `.agent/sessions/eval`. */
export function defaultCheckpointLocation(): CheckpointLocation {
  return {
    base: resolve(fileURLToPath(new URL("../../", import.meta.url))),
    components: [".agent", "sessions", "eval"],
  };
}

/** The resolved checkpoint-holding directory for a location. */
function resolvedDir(loc: CheckpointLocation): string {
  return resolve(loc.base, ...loc.components);
}

function checkpointPath(dir: string): string {
  return resolve(dir, CHECKPOINT_FILENAME);
}

/** Assert a value is a non-negative safe integer within {@link MAX_COUNT}. */
function assertCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new Error(`checkpoint ${label} is out of range`);
  }
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`checkpoint ${label} is invalid`);
  return value;
}

/** Reject any object carrying keys outside the allowed set. */
function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) throw new Error(`checkpoint ${label} has unexpected fields`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(obj, key)) throw new Error(`checkpoint ${label} is missing fields`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`checkpoint ${label} shape is invalid`);
  }
  return value as Record<string, unknown>;
}

/** Parse and strictly validate raw checkpoint text into {@link CheckpointData}. */
function parseCheckpoint(
  raw: string,
  expected: { origin: string; corpusFingerprint: string },
): CheckpointData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("checkpoint is malformed JSON");
  }
  const obj = asObject(parsed, "root");
  assertExactKeys(
    obj,
    [
      "formatVersion",
      "origin",
      "authMode",
      "corpusFingerprint",
      "resumeState",
      "abort",
      "nextCaseIndex",
      "runSegments",
      "attemptedRounds",
      "completedRounds",
      "completedSingleRoundCases",
      "completedMultiStepScenarios",
      "cleanup",
      "gates",
      "invariants",
      "scenarioEvidence",
      "diagnosticFailures",
    ],
    "root",
  );

  // Versions 1, 2, and 3 predate the per-scenario evidence ledger and recorded
  // positional (one-expected-tool-per-round-ordinal) accounting; there is
  // deliberately NO migration path — a resumed run started from an older
  // checkpoint must start from a fresh anchor and cannot be replayed under
  // v4 transition-based accounting.
  if (obj["formatVersion"] !== CHECKPOINT_FORMAT_VERSION) {
    throw new Error("checkpoint version is unsupported");
  }
  if (obj["origin"] !== expected.origin) throw new Error("checkpoint origin mismatch");
  if (obj["authMode"] !== "password") throw new Error("checkpoint auth mode mismatch");
  const fingerprint = obj["corpusFingerprint"];
  if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error("checkpoint corpus fingerprint is invalid");
  }
  if (fingerprint !== expected.corpusFingerprint) {
    throw new Error("checkpoint corpus fingerprint mismatch");
  }

  // Durable resume state + tombstone abort (finding 2). A `resumable` checkpoint
  // must have `abort: null`; a `blocked` tombstone must carry a closed
  // stage/reason and nothing else.
  const resumeState = obj["resumeState"];
  if (resumeState !== "resumable" && resumeState !== "blocked") {
    throw new Error("checkpoint resumeState is invalid");
  }
  let abort: CheckpointAbort | null = null;
  if (resumeState === "resumable") {
    if (obj["abort"] !== null) throw new Error("checkpoint resumable abort must be null");
  } else {
    const abortObj = asObject(obj["abort"], "abort");
    assertExactKeys(abortObj, ["stage", "reason"], "abort");
    const stage = abortObj["stage"];
    const reason = abortObj["reason"];
    if (typeof stage !== "string" || !ABORT_STAGE_SET.has(stage)) {
      throw new Error("checkpoint abort stage is invalid");
    }
    if (typeof reason !== "string" || !ABORT_REASON_SET.has(reason)) {
      throw new Error("checkpoint abort reason is invalid");
    }
    abort = { stage: stage as AbortStage, reason: reason as AbortReason };
  }

  const cleanupObj = asObject(obj["cleanup"], "cleanup");
  assertExactKeys(cleanupObj, ["attempted", "deleted", "failed", "journalFailures"], "cleanup");
  const gatesObj = asObject(obj["gates"], "gates");
  assertExactKeys(gatesObj, ["expectedCall", "single", "multi"], "gates");
  const expectedCallObj = asObject(gatesObj["expectedCall"], "gates.expectedCall");
  assertExactKeys(
    expectedCallObj,
    ["total", "schemaValid", "nameAccurate", "argValid"],
    "gates.expectedCall",
  );
  const singleObj = asObject(gatesObj["single"], "gates.single");
  assertExactKeys(singleObj, ["total", "success"], "gates.single");
  const multiObj = asObject(gatesObj["multi"], "gates.multi");
  assertExactKeys(multiObj, ["total", "success"], "gates.multi");
  const invariantsObj = asObject(obj["invariants"], "invariants");
  assertExactKeys(invariantsObj, ["noSilentFallback", "injectionResistance"], "invariants");

  const scenarioEvidence = parseScenarioEvidence(obj["scenarioEvidence"]);
  const diagnosticFailures = parseDiagnosticFailures(obj["diagnosticFailures"]);

  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    origin: expected.origin,
    authMode: "password",
    corpusFingerprint: fingerprint,
    resumeState,
    abort,
    nextCaseIndex: assertCount(obj["nextCaseIndex"], "nextCaseIndex"),
    runSegments: assertCount(obj["runSegments"], "runSegments"),
    attemptedRounds: assertCount(obj["attemptedRounds"], "attemptedRounds"),
    completedRounds: assertCount(obj["completedRounds"], "completedRounds"),
    completedSingleRoundCases: assertCount(
      obj["completedSingleRoundCases"],
      "completedSingleRoundCases",
    ),
    completedMultiStepScenarios: assertCount(
      obj["completedMultiStepScenarios"],
      "completedMultiStepScenarios",
    ),
    cleanup: {
      attempted: assertCount(cleanupObj["attempted"], "cleanup.attempted"),
      deleted: assertCount(cleanupObj["deleted"], "cleanup.deleted"),
      failed: assertCount(cleanupObj["failed"], "cleanup.failed"),
      journalFailures: assertCount(cleanupObj["journalFailures"], "cleanup.journalFailures"),
    },
    gates: {
      expectedCall: {
        total: assertCount(expectedCallObj["total"], "gates.expectedCall.total"),
        schemaValid: assertCount(expectedCallObj["schemaValid"], "gates.expectedCall.schemaValid"),
        nameAccurate: assertCount(
          expectedCallObj["nameAccurate"],
          "gates.expectedCall.nameAccurate",
        ),
        argValid: assertCount(expectedCallObj["argValid"], "gates.expectedCall.argValid"),
      },
      single: {
        total: assertCount(singleObj["total"], "gates.single.total"),
        success: assertCount(singleObj["success"], "gates.single.success"),
      },
      multi: {
        total: assertCount(multiObj["total"], "gates.multi.total"),
        success: assertCount(multiObj["success"], "gates.multi.success"),
      },
    },
    invariants: {
      noSilentFallback: assertBoolean(
        invariantsObj["noSilentFallback"],
        "invariants.noSilentFallback",
      ),
      injectionResistance: assertBoolean(
        invariantsObj["injectionResistance"],
        "invariants.injectionResistance",
      ),
    },
    scenarioEvidence,
    diagnosticFailures,
  };
}

/**
 * Strictly parse the compact `scenarioEvidence` ledger (format 4) into frozen
 * five-element tuples. Bounds are checked at the SHAPE level only: each tuple
 * has exactly five safe-integer elements, `executedRounds` is in
 * `[1, MAX_COUNT]`, `satisfiedSteps` is in `[0, SCENARIO_STEP_COUNT]`, and each
 * mask is a non-negative integer below `2 ** SCENARIO_STEP_COUNT`, so no
 * oversized value can reach the semantic validator.
 *
 * Corpus-bound consistency — `.length === completedMultiStepScenarios`, each
 * `executedRounds` within its CORRESPONDING committed case's actual
 * `rounds.length` (never the projection-wide `maxRoundsPerCase`, which is only
 * used later as the operational counter ceiling and per-run-segment slack),
 * masks confined to that case's planned step count, the satisfied prefix
 * present in every mask, aggregate numerators equal to the mask popcounts, and
 * the diagnostic ↔ satisfied-state agreement — lives in
 * {@link validateResumableCheckpoint}, which owns the corpus projection.
 */
function parseScenarioEvidence(value: unknown): CheckpointScenarioEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error("checkpoint scenarioEvidence shape is invalid");
  }
  if (value.length > MAX_COUNT) {
    throw new Error("checkpoint scenarioEvidence exceeds bound");
  }
  const out: CheckpointScenarioEvidence[] = [];
  for (const entry of value as unknown[]) out.push(parseScenarioEvidenceEntry(entry));
  return out;
}

/** Strictly parse ONE `scenarioEvidence` tuple; throws value-free on any anomaly. */
function parseScenarioEvidenceEntry(entry: unknown): CheckpointScenarioEvidence {
  if (!Array.isArray(entry) || entry.length !== 5) {
    throw new Error("checkpoint scenarioEvidence entry shape is invalid");
  }
  const [executedRounds, satisfiedSteps, schemaMask, nameMask, argMask] = entry as unknown[];
  if (
    typeof executedRounds !== "number" ||
    !Number.isSafeInteger(executedRounds) ||
    executedRounds < 1 ||
    executedRounds > MAX_COUNT
  ) {
    throw new Error("checkpoint scenarioEvidence executed-round count is out of range");
  }
  if (
    typeof satisfiedSteps !== "number" ||
    !Number.isSafeInteger(satisfiedSteps) ||
    satisfiedSteps < 0 ||
    satisfiedSteps > SCENARIO_STEP_COUNT
  ) {
    throw new Error("checkpoint scenarioEvidence satisfied-step count is out of range");
  }
  for (const mask of [schemaMask, nameMask, argMask]) {
    if (
      typeof mask !== "number" ||
      !Number.isSafeInteger(mask) ||
      mask < 0 ||
      mask >= 1 << SCENARIO_STEP_COUNT
    ) {
      throw new Error("checkpoint scenarioEvidence mask is out of range");
    }
  }
  return Object.freeze([
    executedRounds,
    satisfiedSteps,
    schemaMask as number,
    nameMask as number,
    argMask as number,
  ]) as unknown as CheckpointScenarioEvidence;
}

/**
 * Strictly parse the compact `diagnosticFailures` field into a frozen array of
 * `[caseOrdinal, roundOrdinal, reasonCode]` triples. Bounds are checked here at
 * the SHAPE level only (safe positive ordinal integers within
 * {@link MAX_COUNT}, a known reason code, no over-count, and no duplicate
 * (case, round) pairs). Corpus-bound consistency — that the ordinals reference
 * a real round at or before `nextCaseIndex` and that the reason matches the
 * round's expected-tool disposition — lives in
 * {@link validateResumableCheckpoint}, which is the only place that also owns
 * the corpus-derived plan.
 */
function parseDiagnosticFailures(value: unknown): CheckpointDiagnosticFailure[] {
  if (!Array.isArray(value)) throw new Error("checkpoint diagnosticFailures shape is invalid");
  if (value.length > MAX_DIAGNOSTIC_FAILURES) {
    throw new Error("checkpoint diagnosticFailures exceeds bound");
  }
  const seen = new Set<string>();
  const out: CheckpointDiagnosticFailure[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry: unknown = value[i];
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new Error("checkpoint diagnosticFailures entry shape is invalid");
    }
    const co: unknown = entry[0];
    const ro: unknown = entry[1];
    const rc: unknown = entry[2];
    if (
      typeof co !== "number" ||
      !Number.isSafeInteger(co) ||
      co < 1 ||
      co > MAX_COUNT ||
      typeof ro !== "number" ||
      !Number.isSafeInteger(ro) ||
      ro < 1 ||
      ro > MAX_COUNT ||
      typeof rc !== "number" ||
      !Number.isSafeInteger(rc)
    ) {
      throw new Error("checkpoint diagnosticFailures entry is out of range");
    }
    if (evalFailureReasonForCode(rc) === undefined) {
      throw new Error("checkpoint diagnosticFailures reason code is unknown");
    }
    const key = `${co}:${ro}`;
    if (seen.has(key)) throw new Error("checkpoint diagnosticFailures has duplicate ordinal pair");
    seen.add(key);
    out.push(Object.freeze([co, ro, rc]));
  }
  return out;
}

/** Read the exact bytes of an opened descriptor under a hard cap. */
function readBoundedFromFd(fd: number): string {
  const buffer = Buffer.allocUnsafe(MAX_CHECKPOINT_BYTES + 1);
  let total = 0;
  for (;;) {
    const room = buffer.length - total;
    if (room === 0) throw new Error("checkpoint is too large");
    const bytesRead = fsOps.readSync(fd, buffer, total, room, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint is too large");
  }
  return buffer.toString("utf8", 0, total);
}

/** `lstat` one path; return `null` on ENOENT, else the stats (throws value-free). */
function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("checkpoint path is not accessible", { cause: error });
  }
}

/** Assert an existing managed component is a real, non-symlink directory. */
function assertManagedDir(stat: Stats): void {
  if (stat.isSymbolicLink()) throw new Error("checkpoint managed component must not be a symlink");
  if (!stat.isDirectory()) throw new Error("checkpoint managed component is not a directory");
}

/**
 * Validate every managed component of a location TOP-DOWN from the trusted base
 * for a NON-creating read/delete/exists (finding 2). Because each level is
 * `lstat`-checked before descending into it, a symlink at ANY managed component —
 * even one whose descendants already exist through it — is caught before the OS
 * would follow it. Returns `false` when a managed component is absent (no
 * checkpoint), and additionally requires the final directory to be owner-only
 * (`0700`). Never creates or `chmod`s anything.
 */
function assertAccessibleDir(loc: CheckpointLocation): boolean {
  let cursor = resolve(loc.base);
  for (let i = 0; i < loc.components.length; i += 1) {
    cursor = resolve(cursor, loc.components[i] ?? "");
    const stat = lstatOrNull(cursor);
    if (stat === null) return false; // a component is missing → no checkpoint
    assertManagedDir(stat);
    if (i === loc.components.length - 1 && (stat.mode & 0o777) !== CHECKPOINT_DIR_MODE) {
      throw new Error("checkpoint directory must be private (0700)");
    }
  }
  return true;
}

/**
 * Create-or-tighten every managed component TOP-DOWN from the trusted base to a
 * real, private, non-symlink directory (finding 2). Each existing component is
 * `lstat`-validated as a non-symlink directory before descending; each missing
 * component is created ONE AT A TIME with the private mode (never
 * `{ recursive: true }`, which would silently follow a redirected ancestor) and
 * re-validated. The final directory is tightened to `0700`.
 */
function ensureSafeDir(loc: CheckpointLocation): void {
  let cursor = resolve(loc.base);
  for (let i = 0; i < loc.components.length; i += 1) {
    cursor = resolve(cursor, loc.components[i] ?? "");
    const stat = lstatOrNull(cursor);
    if (stat === null) {
      mkdirSync(cursor, { mode: CHECKPOINT_DIR_MODE });
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("checkpoint directory could not be created safely");
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

/**
 * Read and strictly validate the checkpoint against the expected origin and
 * corpus fingerprint. Returns null when it does not exist. Throws value-free on a
 * symlink, non-regular/non-private/oversized file, or any invalid/mismatched
 * content. The file is opened with `O_NOFOLLOW` and validated via `fstat` on the
 * OPEN descriptor.
 */
export function readCheckpoint(
  loc: CheckpointLocation,
  expected: { origin: string; corpusFingerprint: string },
): CheckpointData | null {
  if (!assertAccessibleDir(loc)) return null;
  const path = checkpointPath(resolvedDir(loc));
  let fd: number;
  try {
    fd = fsOps.openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("checkpoint must not be a symlink", { cause: error });
    throw new Error("checkpoint is not accessible", { cause: error });
  }
  try {
    const stat = fsOps.fstatSync(fd);
    if (!stat.isFile()) throw new Error("checkpoint must be a regular file");
    // EXACT 0600: reject group/world bits AND owner modes other than rw
    // (e.g. 0400, 0200, 0000, 0700). The documented contract is precisely 0600.
    if ((stat.mode & 0o777) !== CHECKPOINT_FILE_MODE) {
      throw new Error("checkpoint must be private (0600)");
    }
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint is too large");
    return parseCheckpoint(readBoundedFromFd(fd), expected);
  } finally {
    fsOps.closeSync(fd);
  }
}

/** Whether a checkpoint file is present (directory + regular file), value-free. */
export function checkpointExists(loc: CheckpointLocation): boolean {
  if (!assertAccessibleDir(loc)) return false;
  const target = checkpointPath(resolvedDir(loc));
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("checkpoint must not be a symlink");
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Serialize a checkpoint payload with all counts revalidated defensively. The
 * output is COMPACT JSON (no indentation) so the worst valid 280-entry
 * diagnostic ledger stays comfortably below {@link MAX_CHECKPOINT_BYTES}; this
 * is a private on-disk artifact and never intended for human hand-editing.
 */
function serialize(data: CheckpointData): string {
  if (data.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new Error("checkpoint version is unsupported");
  }
  if (typeof data.origin !== "string" || data.origin.length === 0) {
    throw new Error("checkpoint origin is invalid");
  }
  if (data.authMode !== "password") throw new Error("checkpoint auth mode is invalid");
  if (typeof data.corpusFingerprint !== "string" || !FINGERPRINT_RE.test(data.corpusFingerprint)) {
    throw new Error("checkpoint corpus fingerprint is invalid");
  }
  if (data.resumeState !== "resumable" && data.resumeState !== "blocked") {
    throw new Error("checkpoint resumeState is invalid");
  }
  if (data.resumeState === "resumable") {
    if (data.abort !== null) throw new Error("checkpoint resumable abort must be null");
  } else {
    if (data.abort === null) throw new Error("checkpoint blocked abort is required");
    if (!ABORT_STAGE_SET.has(data.abort.stage))
      throw new Error("checkpoint abort stage is invalid");
    if (!ABORT_REASON_SET.has(data.abort.reason)) {
      throw new Error("checkpoint abort reason is invalid");
    }
  }
  assertCount(data.nextCaseIndex, "nextCaseIndex");
  assertCount(data.runSegments, "runSegments");
  assertCount(data.attemptedRounds, "attemptedRounds");
  assertCount(data.completedRounds, "completedRounds");
  assertCount(data.completedSingleRoundCases, "completedSingleRoundCases");
  assertCount(data.completedMultiStepScenarios, "completedMultiStepScenarios");
  for (const [k, v] of Object.entries(data.cleanup)) assertCount(v, `cleanup.${k}`);
  assertCount(data.gates.expectedCall.total, "gates.expectedCall.total");
  assertCount(data.gates.expectedCall.schemaValid, "gates.expectedCall.schemaValid");
  assertCount(data.gates.expectedCall.nameAccurate, "gates.expectedCall.nameAccurate");
  assertCount(data.gates.expectedCall.argValid, "gates.expectedCall.argValid");
  assertCount(data.gates.single.total, "gates.single.total");
  assertCount(data.gates.single.success, "gates.single.success");
  assertCount(data.gates.multi.total, "gates.multi.total");
  assertCount(data.gates.multi.success, "gates.multi.success");
  assertBoolean(data.invariants.noSilentFallback, "invariants.noSilentFallback");
  assertBoolean(data.invariants.injectionResistance, "invariants.injectionResistance");
  assertScenarioEvidenceShape(data.scenarioEvidence);
  assertDiagnosticFailuresShape(data.diagnosticFailures);
  return JSON.stringify(data) + "\n";
}

/**
 * Shape-check the `scenarioEvidence` ledger before serialization. This mirrors
 * the post-parse checks in {@link parseScenarioEvidence} so a hostile caller
 * cannot slip a malformed ledger onto disk via {@link writeCheckpoint}.
 */
function assertScenarioEvidenceShape(
  entries: readonly CheckpointScenarioEvidence[] | undefined,
): void {
  if (!Array.isArray(entries)) {
    throw new Error("checkpoint scenarioEvidence shape is invalid");
  }
  if (entries.length > MAX_COUNT) {
    throw new Error("checkpoint scenarioEvidence exceeds bound");
  }
  for (const entry of entries) parseScenarioEvidenceEntry(entry);
}

/**
 * Shape-check a diagnostic ledger before serialization. This mirrors the
 * post-parse checks in {@link parseDiagnosticFailures} so a hostile caller
 * cannot slip a malformed ledger onto disk via {@link writeCheckpoint}.
 */
function assertDiagnosticFailuresShape(
  entries: readonly CheckpointDiagnosticFailure[] | undefined,
): void {
  if (!Array.isArray(entries)) throw new Error("checkpoint diagnosticFailures shape is invalid");
  if (entries.length > MAX_DIAGNOSTIC_FAILURES) {
    throw new Error("checkpoint diagnosticFailures exceeds bound");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new Error("checkpoint diagnosticFailures entry shape is invalid");
    }
    const co: unknown = entry[0];
    const ro: unknown = entry[1];
    const rc: unknown = entry[2];
    if (
      typeof co !== "number" ||
      !Number.isSafeInteger(co) ||
      co < 1 ||
      co > MAX_COUNT ||
      typeof ro !== "number" ||
      !Number.isSafeInteger(ro) ||
      ro < 1 ||
      ro > MAX_COUNT ||
      typeof rc !== "number" ||
      !Number.isSafeInteger(rc) ||
      evalFailureReasonForCode(rc) === undefined
    ) {
      throw new Error("checkpoint diagnosticFailures entry is invalid");
    }
    const key = `${co}:${ro}`;
    if (seen.has(key)) throw new Error("checkpoint diagnosticFailures has duplicate ordinal pair");
    seen.add(key);
  }
}

/**
 * Atomically write the checkpoint with mode `0600`. Validates and byte-bounds the
 * payload, ensures a private directory, refuses to overwrite through a symlink or
 * non-regular target, writes a cryptographically-named private temp file, fsyncs
 * and renames it into place, then fsyncs the directory. The temp file is always
 * removed on failure, and a failed replacement never truncates the existing valid
 * checkpoint.
 */
export function writeCheckpoint(loc: CheckpointLocation, data: CheckpointData): void {
  const payload = serialize(data);
  if (Buffer.byteLength(payload, "utf8") > MAX_CHECKPOINT_BYTES) {
    throw new Error("checkpoint is too large");
  }

  ensureSafeDir(loc);
  const dir = resolvedDir(loc);
  const target = checkpointPath(dir);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("checkpoint must not be a symlink");
    if (!stat.isFile()) throw new Error("checkpoint must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const tmp = resolve(dir, `${CHECKPOINT_FILENAME}.${randomBytes(12).toString("hex")}.tmp`);
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
        throw new Error("checkpoint write reported invalid progress");
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
 * Internal derived-evidence structure: the EXACT committed metrics a truthful
 * resumable checkpoint would have persisted, derived directly from the
 * projection, the per-scenario executed-round ledger, and the per-round
 * diagnostic ledger. `validateResumableCheckpoint` compares these derived
 * numbers against every checkpoint-claimed accumulator, so a numerator that
 * exceeds the diagnostic-provable evidence — the classic checkpoint forgery
 * — is rejected as content-free invalid state (finding 1). The two invariant
 * booleans are derived identically so a forged persisted `invariants` boolean
 * (a `true` claim under diagnostic evidence of a violation, or a `false`
 * claim without such evidence) is likewise rejected before any credential
 * read or network I/O.
 *
 * Every field is a non-negative integer or boolean. Nothing here is
 * content-carrying.
 */
interface DerivedCheckpointEvidence {
  readonly committedSingle: number;
  readonly committedMulti: number;
  readonly executedScenarioSum: number;
  readonly committedUpstreamRounds: number;
  readonly expectedCallTotal: number;
  readonly expectedSchemaValid: number;
  readonly expectedArgValid: number;
  readonly expectedNameAccurate: number;
  readonly singleTotal: number;
  readonly singleSuccess: number;
  readonly multiTotal: number;
  readonly multiSuccess: number;
  /**
   * True unless an executed round produced ordinary text under a `required`
   * or named-`function` tool choice. An expected-tool round with reason
   * `expected-tool-returned-text` represents that outcome; a final round
   * WITHOUT a diagnostic represents the accepted final-text outcome (a
   * scenario that ran to its final round successfully). A text outcome
   * under `choiceKind: "auto"` does not violate, and unexecuted rounds
   * contribute nothing.
   */
  readonly noSilentFallback: boolean;
  /**
   * True unless an executed round produced an unauthorized tool call. Under
   * the closed diagnostic model the terminal `unauthorized-tool-call`
   * diagnostic is the only evidence of that violation. Unexecuted rounds
   * contribute nothing.
   */
  readonly injectionResistance: boolean;
}

/**
 * Combine one executed expected-tool round's contribution to the derived
 * gate metrics. The per-round contribution table is the ONLY place the closed
 * {@link EvalFailureReason} union is mapped to gate deltas; it mirrors the
 * runner's `classifyDecision`/`classifyRoundFailure`/`commitExpectedCall`
 * behavior exactly (spec §30).
 *
 * A `null` diagnostic reason means the round produced the correct allowed
 * tool call and was fully credited (nameOk). Otherwise the diagnostic reason
 * tells us EXACTLY what the runner would have credited to this round:
 *
 *   - `expected-tool-returned-text`      → decision.kind = "text"          → 0/0/0
 *   - `expected-tool-no-valid-call`      → decision.kind = "no_valid_call" → 0/0/0
 *   - `expected-tool-unavailable`        → decision.kind = "unavailable"   → 0/0/0
 *   - `expected-tool-not-invoked`        → tool_calls + !expected           → 1/1/0
 *   - `unauthorized-tool-call`           → tool_calls + unauthorized        → 1/1/0
 *   - `transcript-invalid`               → tool_calls + expected + linkage  → 1/1/1
 *
 * A `final-*`/`unexpected-tool-call-on-final` reason on an expected-tool round
 * is structurally impossible — the per-diagnostic scope check above rejects
 * it — so the default arm throws for defense-in-depth.
 */
function accumulateExpectedRound(
  target: {
    total: number;
    schemaValid: number;
    argValid: number;
    nameAccurate: number;
  },
  diagReason: EvalFailureReason | null,
): void {
  target.total += 1;
  if (diagReason === null) {
    target.schemaValid += 1;
    target.argValid += 1;
    target.nameAccurate += 1;
    return;
  }
  switch (diagReason) {
    case "expected-tool-returned-text":
    case "expected-tool-no-valid-call":
    case "expected-tool-unavailable":
      return;
    case "expected-tool-not-invoked":
    case "unauthorized-tool-call":
      target.schemaValid += 1;
      target.argValid += 1;
      return;
    case "transcript-invalid":
      target.schemaValid += 1;
      target.argValid += 1;
      target.nameAccurate += 1;
      return;
    case "unexpected-tool-call-on-final":
    case "final-no-valid-call":
    case "final-unavailable":
      throw new Error("checkpoint diagnosticFailures reason incompatible with expected-tool round");
    case "scenario-round-budget-exhausted":
      // A whole-scenario reason; multi-step evidence is accumulated from the
      // per-step masks, and a single-round case is rejected before it reaches
      // this table.
      throw new Error(
        "checkpoint diagnosticFailures scenario reason has no per-round contribution",
      );
    default: {
      const _exhaustive: never = diagReason;
      void _exhaustive;
      throw new Error("checkpoint diagnosticFailures reason is unknown");
    }
  }
}

/**
 * Walk the first `cursor` cases of the fingerprint-bound corpus projection
 * and derive the EXACT committed gate accumulators a truthful run would have
 * persisted (finding 1). Every returned value is DERIVED from the projection
 * plus the two ledgers — never from the checkpoint's claimed metrics — so
 * {@link validateResumableCheckpoint} can require exact equality with those
 * claims and reject forged gate numerators.
 *
 * Structural / relational rejects (throws value-free):
 *
 *  1. A `scenarioEvidence[k]` executed-round count outside
 *     `[1, correspondingCase.rounds.length]` — the per-CASE round count, NOT
 *     the global `maxRoundsPerCase`.
 *  2. `scenarioEvidence.length !== committedMultiStepScenarios` derived from
 *     `cursor`.
 *  3. A `satisfiedSteps` count outside `[0, thatCase's plannedSteps]`, a mask
 *     carrying a bit outside that case's planned steps, or a mask omitting a
 *     bit of the satisfied PREFIX (a successful transition necessarily proves
 *     schema, name, and argument evidence for its step).
 *  4. A diagnostic referencing an uncommitted case or an unknown round of a
 *     committed case.
 *  5. Two or more diagnostics for the same committed case — the runner
 *     terminates each case at its FIRST failure, so a case has AT MOST ONE
 *     diagnostic.
 *  6. A diagnostic referencing an unexecuted round for a committed multi-step
 *     scenario, or one whose round ordinal disagrees with the scenario's
 *     executed-round count (a scenario stops AT its diagnostic round).
 *  7. A terminal diagnostic whose SCOPE disagrees with the scenario's
 *     satisfied state — an `expected`-scope reason once every transition
 *     succeeded, or a `final`-scope reason while one is still pending. For a
 *     single-round case the scope is checked against the round's own
 *     `hasExpectedTool` disposition instead, and a whole-scenario reason is
 *     rejected outright.
 *  8. A diagnostic-FREE committed multi-step scenario that did not satisfy
 *     every transition, that carries incomplete step evidence, or that could
 *     not have reached a final-answer round. A successful scenario MAY use
 *     fewer rounds than its budget when a parallel batch completed several
 *     transitions at once, so the bound is a floor, not the full budget.
 *  9. A single-round case whose diagnostic references a round other than 1.
 */
function deriveCommittedEvidence(
  data: CheckpointData,
  projection: EvalCorpusProjection,
): DerivedCheckpointEvidence {
  const { cases } = projection;
  const cursor = data.nextCaseIndex;

  // 1. Index diagnostics by caseOrdinal for O(1) per-case lookup. Reject
  //    (a) an uncommitted case ordinal, (b) an unknown round, (c) a reason
  //    whose scope disagrees with the referenced round, and (d) two
  //    diagnostics for the SAME committed case (finding 1: the runner
  //    terminates a case at its first failure).
  const perCaseDiagnostic = new Map<number, { roundOrdinal: number; reason: EvalFailureReason }>();
  for (const [co, ro, rc] of data.diagnosticFailures) {
    if (co > cursor) {
      throw new Error("checkpoint diagnosticFailures references uncommitted case");
    }
    const projectedCase = cases[co - 1];
    if (projectedCase === undefined) {
      throw new Error("checkpoint diagnosticFailures references unknown case");
    }
    const projectedRound = projectedCase.rounds[ro - 1];
    if (projectedRound === undefined) {
      throw new Error("checkpoint diagnosticFailures references unknown round");
    }
    const reason = evalFailureReasonForCode(rc);
    if (reason === undefined) {
      throw new Error("checkpoint diagnosticFailures reason code is unknown");
    }
    // Scope is judged POSITIONALLY only for a single-round case, whose sole
    // round has no transition state and whose `hasExpectedTool` disposition is
    // therefore exactly what that round expected.
    //
    // A MULTI-STEP case gets NO positional scope check here. Under state-aware
    // accounting a round's corpus slot no longer describes what that round
    // expected: a parallel batch can satisfy several transitions early (so an
    // expected-tool slot can legitimately carry a `final-*` reason), and a
    // semantically failed retry can leave a transition pending past its
    // planned slot (so the final slot can legitimately carry an
    // `expected-tool-*` reason). Applying the old rule here rejected truthful
    // checkpoints BEFORE the correct check could run. Multi-step scope is
    // validated below against the scenario's persisted SATISFIED STATE.
    if (projectedCase.phase === "single") {
      const scope = EVAL_FAILURE_REASON_SCOPE[reason];
      if (scope === "expected" && !projectedRound.hasExpectedTool) {
        throw new Error("checkpoint diagnosticFailures reason incompatible with final round");
      }
      if (scope === "final" && projectedRound.hasExpectedTool) {
        throw new Error(
          "checkpoint diagnosticFailures reason incompatible with expected-tool round",
        );
      }
    }
    if (perCaseDiagnostic.has(co)) {
      throw new Error("checkpoint diagnosticFailures has multiple diagnostics for one case");
    }
    perCaseDiagnostic.set(co, { roundOrdinal: ro, reason });
  }

  // 2. Walk committed cases in projection order, mapping each executed-round
  //    ledger entry to its CORRESPONDING multi-step case's round-count bound
  //    (finding 2), and accumulate the derived gate metrics AND the two
  //    invariant gates. `noSilentFallback` and `injectionResistance` are
  //    derived from EXECUTED evidence only — the executed-round ledger
  //    scopes what a diagnostic (or a diagnostic-free final round) is
  //    allowed to witness (unexecuted rounds contribute nothing).
  let committedSingle = 0;
  let committedMulti = 0;
  let executedScenarioSum = 0;
  let singleTotal = 0;
  let singleSuccess = 0;
  let multiTotal = 0;
  let multiSuccess = 0;
  const expectedCall = { total: 0, schemaValid: 0, argValid: 0, nameAccurate: 0 };
  let noSilentFallback = true;
  let injectionResistance = true;

  /**
   * Update the two derived invariant booleans for ONE executed round using
   * only the projection's `choiceKind`/`hasExpectedTool` and the diagnostic
   * reason (or null when the round was not diagnosed). This mirrors the
   * runner's `flagViolations` exactly:
   *
   *   - `unauthorized-tool-call` on ANY executed round ⇒ injectionResistance = false.
   *   - `expected-tool-returned-text` on an executed expected-tool round
   *      under `required`/`function` ⇒ noSilentFallback = false.
   *   - A diagnostic-free EXECUTED final round (no `hasExpectedTool`) under
   *      `required`/`function` ⇒ noSilentFallback = false. A committed
   *      scenario's `executed` value proves the final round actually ran.
   *   - A text outcome under `auto` never violates.
   *   - Any other diagnosed outcome (tool_calls-that-missed, no_valid_call,
   *      unavailable, transcript-invalid, final-*, unexpected-tool-call-
   *      on-final) is not "silent text" and does not violate either
   *      invariant.
   */
  const updateInvariants = (
    projectedRound: {
      readonly choiceKind: DiagnosticChoiceKind;
      readonly hasExpectedTool: boolean;
    },
    diagReason: EvalFailureReason | null,
  ): void => {
    const constrained =
      projectedRound.choiceKind === "required" || projectedRound.choiceKind === "function";
    if (diagReason === "unauthorized-tool-call") injectionResistance = false;
    if (projectedRound.hasExpectedTool) {
      if (constrained && diagReason === "expected-tool-returned-text") {
        noSilentFallback = false;
      }
    } else if (constrained && diagReason === null) {
      noSilentFallback = false;
    }
  };

  let ledgerIdx = 0;
  for (let i = 0; i < cursor; i += 1) {
    const projectedCase = cases[i];
    if (projectedCase === undefined) {
      throw new Error("checkpoint cursor references unknown case");
    }
    const co = i + 1;
    const diag = perCaseDiagnostic.get(co) ?? null;
    if (projectedCase.phase === "single") {
      committedSingle += 1;
      const round0 = projectedCase.rounds[0];
      if (round0 === undefined) {
        throw new Error("checkpoint cursor references unknown round");
      }
      if (diag !== null && diag.roundOrdinal !== 1) {
        throw new Error(
          "checkpoint diagnosticFailures references a non-existent round in a single-round case",
        );
      }
      if (diag !== null && diag.reason === "scenario-round-budget-exhausted") {
        // A whole-scenario reason cannot describe a one-round case.
        throw new Error(
          "checkpoint diagnosticFailures scenario reason is invalid for a single-round case",
        );
      }
      // A single-round case's sole round is always executed on commit;
      // update the invariants using the projection + this round's
      // diagnostic reason (or null when the round scored acceptably).
      updateInvariants(round0, diag?.reason ?? null);
      if (round0.hasExpectedTool) {
        singleTotal += 1;
        accumulateExpectedRound(expectedCall, diag?.reason ?? null);
        if (diag === null) singleSuccess += 1;
      }
      // A final-round single (not used by the current corpus) contributes
      // nothing to `expectedCall.*` or `single.*`. A `final-*`/`unauthorized`
      // diagnostic on it is scope-compatible and simply carries no metric.
    } else {
      committedMulti += 1;
      multiTotal += 1;
      const entry = data.scenarioEvidence[ledgerIdx];
      if (entry === undefined) {
        throw new Error("checkpoint scenarioEvidence length mismatch");
      }
      ledgerIdx += 1;
      const [executed, satisfied, schemaMask, nameMask, argMask] = entry;

      // Per-CASE bound: `[1, correspondingCase.rounds.length]`, NOT the
      // corpus-wide `maxRoundsPerCase`. A committed scenario always issued at
      // least one upstream round.
      if (
        !Number.isSafeInteger(executed) ||
        executed < 1 ||
        executed > projectedCase.rounds.length
      ) {
        throw new Error("checkpoint scenarioEvidence executed rounds out of range for its case");
      }
      executedScenarioSum += executed;

      // The scenario's PLANNED transitions come from the corpus, never from
      // the checkpoint. Every planned transition contributes exactly one unit
      // to the expected-step denominator, whether or not its round ran.
      let plannedSteps = 0;
      for (const round of projectedCase.rounds) {
        if (round.hasExpectedTool) plannedSteps += 1;
      }
      const fullMask = plannedSteps <= 0 ? 0 : (1 << plannedSteps) - 1;

      if (!Number.isSafeInteger(satisfied) || satisfied < 0 || satisfied > plannedSteps) {
        throw new Error("checkpoint scenarioEvidence satisfied steps out of range for its case");
      }
      // A mask may only carry bits for transitions this case actually plans.
      for (const mask of [schemaMask, nameMask, argMask]) {
        if ((mask & ~fullMask) !== 0) {
          throw new Error("checkpoint scenarioEvidence mask exceeds the case's planned steps");
        }
      }
      // Transition success is prerequisite-gated, so the satisfied steps are
      // the leading PREFIX of the workflow, and a successful transition
      // necessarily proves schema, name, and argument evidence for its step.
      // Uses the engine's own helper so the two can never drift.
      const satisfiedPrefix = prefixMask(satisfied);
      for (const mask of [schemaMask, nameMask, argMask]) {
        if ((mask & satisfiedPrefix) !== satisfiedPrefix) {
          throw new Error("checkpoint scenarioEvidence mask omits a satisfied transition");
        }
      }

      // Once every transition succeeds the scenario expects FINAL TEXT; while
      // one is pending it expects a tool. That is the state-aware disposition
      // a terminal diagnostic's scope must agree with — the round's positional
      // `hasExpectedTool` no longer describes what the round expected.
      const expectsFinal = satisfied >= plannedSteps;
      if (diag !== null) {
        if (diag.roundOrdinal > executed) {
          throw new Error(
            "checkpoint diagnosticFailures references an unexecuted round for a committed scenario",
          );
        }
        if (diag.roundOrdinal !== executed) {
          throw new Error(
            "checkpoint diagnosticFailures for a multi-step scenario is not at its terminal round",
          );
        }
        const scope = EVAL_FAILURE_REASON_SCOPE[diag.reason];
        if (scope === "expected" && expectsFinal) {
          throw new Error(
            "checkpoint diagnosticFailures expected-tool reason disagrees with satisfied state",
          );
        }
        if (scope === "final" && !expectsFinal) {
          throw new Error(
            "checkpoint diagnosticFailures final reason disagrees with satisfied state",
          );
        }
      } else {
        // No diagnostic ⇒ the scenario SUCCEEDED: every transition completed
        // and the final answer was accepted. That requires full evidence and
        // at least one tool-call round plus one final-answer round — but NOT
        // the whole budget, because a parallel batch can complete several
        // transitions at once.
        if (satisfied !== plannedSteps) {
          throw new Error(
            "checkpoint claims a multi-step scenario succeeded without every transition",
          );
        }
        if (schemaMask !== fullMask || nameMask !== fullMask || argMask !== fullMask) {
          throw new Error(
            "checkpoint claims a multi-step scenario succeeded with incomplete step evidence",
          );
        }
        const minSuccessRounds = plannedSteps > 0 ? MIN_SUCCESSFUL_SCENARIO_ROUNDS : 1;
        if (executed < minSuccessRounds) {
          throw new Error(
            "checkpoint claims a multi-step scenario succeeded without a final-answer round",
          );
        }
      }

      // Per-STEP expected-call accumulation (state-aware). Each planned
      // transition contributes one denominator unit and its recorded evidence
      // bit; retries were merged into the mask by the runner, so no step is
      // double-counted and an unsatisfied step is a truthful miss.
      expectedCall.total += plannedSteps;
      expectedCall.schemaValid += popcount(schemaMask);
      expectedCall.nameAccurate += popcount(nameMask);
      expectedCall.argValid += popcount(argMask);

      // Invariants. Every round BEFORE the terminal one was accepted with a
      // valid allowed tool-call set (a scenario stops at its first terminal
      // failure and at its accepted final answer), so ordinary text and an
      // unauthorized call can only occur at the terminal round.
      const terminalRound = projectedCase.rounds[executed - 1];
      if (terminalRound === undefined) {
        throw new Error("checkpoint cursor references unknown round");
      }
      if (diag?.reason === "unauthorized-tool-call") injectionResistance = false;
      const constrained =
        terminalRound.choiceKind === "required" || terminalRound.choiceKind === "function";
      if (constrained && (diag === null || diag.reason === "expected-tool-returned-text")) {
        // Either an accepted final-text round or a text answer while a
        // transition was still pending, both under a constrained choice.
        noSilentFallback = false;
      }

      // Multi-step success: every transition satisfied AND the final answer
      // accepted — exactly the diagnostic-free case validated above.
      if (diag === null) multiSuccess += 1;
    }
  }

  // The ledger length must exactly match the committed multi count. This
  // catches a length mismatch even when the runtime entries would pass the
  // per-entry bounds.
  if (ledgerIdx !== data.scenarioEvidence.length) {
    throw new Error("checkpoint scenarioEvidence length mismatch");
  }

  return {
    committedSingle,
    committedMulti,
    executedScenarioSum,
    committedUpstreamRounds: committedSingle + executedScenarioSum,
    expectedCallTotal: expectedCall.total,
    expectedSchemaValid: expectedCall.schemaValid,
    expectedArgValid: expectedCall.argValid,
    expectedNameAccurate: expectedCall.nameAccurate,
    singleTotal,
    singleSuccess,
    multiTotal,
    multiSuccess,
    noSilentFallback,
    injectionResistance,
  };
}

/**
 * Semantic (corpus-bound) validation of a RESUMABLE checkpoint against the
 * ACTUAL fingerprint-bound corpus projection (findings 1 + 2). Enforces that
 * a persisted resumable checkpoint's cursor, committed case counts, gate
 * denominators/numerators, upstream-round counters, and cleanup accounting
 * are consistent with the projection AND the per-scenario evidence ledger AND
 * the per-round diagnostic ledger, so a forged or internally
 * inconsistent checkpoint (e.g. a "complete + passing, zero-attempt" file, a
 * scenario that skipped its final-answer round without a terminal diagnostic,
 * a numerator that exceeds the diagnostic-provable evidence, or an
 * arbitrarily inflated counter) is rejected BEFORE any credential read or
 * network I/O and can never grant an executed pass. All planned bounds AND
 * per-round layout come from the supplied projection — never from
 * checkpoint-claimed sizes.
 *
 * Per-case ledger mapping. Every `scenarioEvidence[k]` tuple is mapped in
 * projection order to its CORRESPONDING committed multi-step case; the
 * executed-round bound is `[1, correspondingCase.rounds.length]` — the per-CASE
 * round count, NOT the corpus-wide `maxRoundsPerCase` — and the satisfied count
 * and masks are bounded by that case's own planned step count. A non-uniform
 * corpus (a case with more/fewer rounds than its peers, or an expected/final
 * round in an unusual position) is honored case-by-case.
 *
 * Numerator ↔ evidence correlation. Every gate numerator must EXACTLY equal the
 * derivable value — a loose upper bound is not enough. A single-round case's
 * contribution is derived from its diagnostic reason through the same table the
 * runner's `commitExpectedCall` uses ({@link accumulateExpectedRound}); a
 * multi-step scenario's contribution is the POPCOUNT of its persisted per-step
 * masks. A checkpoint claiming credit for a transition its masks do not record
 * is therefore rejected as impossible.
 *
 * Multi-step success semantics (state-aware). A committed multi-step scenario is
 * credited to `multi.success` iff it has NO terminal diagnostic, which the
 * derivation additionally requires to mean every planned transition succeeded,
 * every mask is full, and the scenario had room for a final-answer round.
 * A successful scenario MAY use fewer rounds than its budget — a parallel batch
 * such as `[read, edit]` completes two transitions at once — so a short
 * diagnostic-free scenario is valid, while a short scenario WITHOUT full
 * evidence is not.
 *
 * A resumable checkpoint MUST have `nextCaseIndex` STRICTLY less than the
 * corpus length: a genuinely complete run removes its checkpoint during
 * finalization, so a persisted resumable checkpoint can never legitimately
 * encode a complete corpus. Because `cursor < length` implies at least one
 * gate denominator is below its planned denominator, a resumed run can never
 * report `passed` without executing the remaining cases live.
 *
 * Round-counter bounds. The committed upstream floor is `committedSingle +
 * Σ scenarioEvidence[k].executedRounds` (NOT `committedMulti *
 * maxRoundsPerCase`). The
 * operational counters (`attemptedRounds`/`completedRounds`) accumulate
 * across resume segments, but a segment aborts at its FIRST non-committing
 * case, so a segment can leave at most ONE in-flight case's worth of
 * uncommitted work: up to `maxRoundsPerCase - 1` completed-but-uncommitted
 * partial-scenario rounds (a mid-scenario interruption restarts and
 * re-counts the scenario) plus at most one terminal failed attempted round.
 * Across `runSegments` segments the counters are therefore bounded ABOVE by
 * the committed floor plus that per-segment slack; an arbitrarily inflated
 * counter is rejected. Throws value-free on any inconsistency.
 */
export function validateResumableCheckpoint(
  data: CheckpointData,
  projection: EvalCorpusProjection,
): void {
  if (data.resumeState !== "resumable" || data.abort !== null) {
    throw new Error("checkpoint is not a resumable checkpoint");
  }
  const { plannedSingle, plannedMulti, maxRoundsPerCase, cases } = projection;
  // Defense-in-depth against a corrupt or hand-crafted projection (finding 2):
  // production always constructs the projection through
  // `buildEvalCorpusProjection`, which fails closed on any `choiceKind`
  // outside the diagnostic union `"auto" | "required" | "function"`. A
  // supplied projection that bypasses the builder (in a test or a hostile
  // caller) is re-checked here BEFORE any credential read or network I/O so
  // a rehydrated diagnostic can never be relabeled to a supported value —
  // `"none"` in particular must fail closed at this boundary.
  for (const projectedCase of cases) {
    for (const projectedRound of projectedCase.rounds) {
      if (
        projectedRound.choiceKind !== "auto" &&
        projectedRound.choiceKind !== "required" &&
        projectedRound.choiceKind !== "function"
      ) {
        throw new Error(
          "checkpoint validation rejects a projection containing an unsupported tool choice kind",
        );
      }
    }
  }
  const length = plannedSingle + plannedMulti;
  const cursor = data.nextCaseIndex;
  // A resumable checkpoint is strictly within the corpus (never complete).
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= length) {
    throw new Error("checkpoint cursor is out of resumable range");
  }

  // Derive every committed accumulator from the fingerprint-bound projection
  // AND the two ledgers. All structural / relational rejections happen inside
  // `deriveCommittedEvidence` (finding 1: per-case ledger mapping,
  // diagnostic-per-case cap, terminal-round tie, no diagnostic for an
  // unexecuted round, early-terminated ⇒ terminal diagnostic; finding 2:
  // per-CASE `[1, rounds.length]` ledger bound).
  const evidence = deriveCommittedEvidence(data, projection);

  if (evidence.committedMulti > plannedMulti) {
    throw new Error("checkpoint committed-multi exceeds plan");
  }
  if (evidence.committedSingle > plannedSingle) {
    throw new Error("checkpoint committed-single exceeds plan");
  }

  // Committed case counts are EXACTLY cursor-derived.
  if (data.completedSingleRoundCases !== evidence.committedSingle) {
    throw new Error("checkpoint completed-single mismatch");
  }
  if (data.completedMultiStepScenarios !== evidence.committedMulti) {
    throw new Error("checkpoint completed-multi mismatch");
  }

  // Gate denominators sum the ACTUAL committed cases' expected-tool rounds.
  // A committed scenario that terminated early still contributes every
  // planned expected-tool round to the denominator (an unexecuted expected
  // step counts as a gate MISS, not an attempted upstream round).
  if (data.gates.single.total !== evidence.singleTotal) {
    throw new Error("checkpoint single denominator mismatch");
  }
  if (data.gates.multi.total !== evidence.multiTotal) {
    throw new Error("checkpoint multi denominator mismatch");
  }
  if (data.gates.expectedCall.total !== evidence.expectedCallTotal) {
    throw new Error("checkpoint expected-call denominator mismatch");
  }

  // Every numerator/success count is required to EXACTLY equal the value
  // derivable from the diagnostic ledger + executed-round ledger
  // (finding 1). A forged "all-success" numerator on a partially-executed
  // scenario (e.g. 19 one-round multi ledgers claiming all-pass) cannot
  // pass because the derived nameAccurate/schemaValid/argValid contribution
  // for an unexecuted expected-tool round is zero.
  if (data.gates.single.success !== evidence.singleSuccess) {
    throw new Error("checkpoint single success mismatch");
  }
  if (data.gates.multi.success !== evidence.multiSuccess) {
    throw new Error("checkpoint multi success mismatch");
  }
  if (data.gates.expectedCall.schemaValid !== evidence.expectedSchemaValid) {
    throw new Error("checkpoint schemaValid mismatch");
  }
  if (data.gates.expectedCall.nameAccurate !== evidence.expectedNameAccurate) {
    throw new Error("checkpoint nameAccurate mismatch");
  }
  if (data.gates.expectedCall.argValid !== evidence.expectedArgValid) {
    throw new Error("checkpoint argValid mismatch");
  }

  // Invariant gates are release-gate evidence too and must be derived from
  // the same executed-round + diagnostic evidence, not trusted as opaque
  // persisted booleans (finding 1). A forged `noSilentFallback: true`
  // against a required/function `expected-tool-returned-text` diagnostic
  // (or against an executed constrained final round with no diagnostic) is
  // rejected; a forged `injectionResistance: true` against an executed
  // `unauthorized-tool-call` diagnostic is rejected.
  if (data.invariants.noSilentFallback !== evidence.noSilentFallback) {
    throw new Error("checkpoint noSilentFallback mismatch");
  }
  if (data.invariants.injectionResistance !== evidence.injectionResistance) {
    throw new Error("checkpoint injectionResistance mismatch");
  }

  // A persisted checkpoint has a valid positive run-segment count.
  if (!Number.isInteger(data.runSegments) || data.runSegments < 1) {
    throw new Error("checkpoint run-segment count is invalid");
  }

  // Upstream-round counters: `evidence.committedUpstreamRounds` was computed
  // by summing the ACTUAL per-case round counts. The ceilings then allow one
  // in-flight case's slack per resume segment, bounded above by the
  // projection maximum (`maxRoundsPerCase`).
  const committedUpstreamRounds = evidence.committedUpstreamRounds;
  const completedCeiling = committedUpstreamRounds + data.runSegments * (maxRoundsPerCase - 1);
  const attemptedCeiling = committedUpstreamRounds + data.runSegments * maxRoundsPerCase;
  if (data.completedRounds > data.attemptedRounds) {
    throw new Error("checkpoint completed exceeds attempted");
  }
  if (data.completedRounds < committedUpstreamRounds) {
    throw new Error("checkpoint completed below committed upstream rounds");
  }
  if (data.completedRounds > completedCeiling) {
    throw new Error("checkpoint completed above resumable ceiling");
  }
  if (data.attemptedRounds > attemptedCeiling) {
    throw new Error("checkpoint attempted above resumable ceiling");
  }

  // Resumable cleanup accounting is truthful (a failed/leaked/journal-failed
  // state is never resumable), and reconciles with the attempted-round
  // counter.
  const c = data.cleanup;
  if (c.deleted + c.failed !== c.attempted) throw new Error("checkpoint cleanup sum mismatch");
  if (c.failed !== 0) throw new Error("checkpoint resumable cleanup has failures");
  if (c.journalFailures !== 0) throw new Error("checkpoint resumable cleanup has journal failures");
  if (c.attempted !== c.deleted) throw new Error("checkpoint resumable cleanup not fully deleted");
  if (data.attemptedRounds !== c.attempted) {
    throw new Error("checkpoint attempted/cleanup mismatch");
  }
}

/**
 * Rehydrate a persisted compact `diagnosticFailures` ledger into the report's
 * expanded {@link EvalFailureDiagnostic} shape using the fingerprint-bound
 * corpus projection (finding 2). Both `phase` and `choiceKind` are looked up
 * directly from `projection.cases[caseIdx0]` — never from checkpoint-claimed
 * data and never inferred from aggregate position. The reason is remapped
 * through the immutable {@link evalFailureReasonForCode}.
 *
 * Fails CLOSED on any impossible entry: an unknown reason code, a case ordinal
 * beyond the projection, a round ordinal beyond that case, or a `choiceKind`
 * outside the diagnostic union (specifically `"none"`, which the synthetic
 * corpus never contains and which {@link buildEvalCorpusProjection} rejects at
 * build time in production; the check here is defense-in-depth for a
 * hand-crafted projection). Each impossible entry throws value-free. The
 * caller MUST have called {@link validateResumableCheckpoint} against the SAME
 * projection first; this function assumes the ledger has already passed
 * structural, bound, and semantic corpus-bound validation.
 */
export function rehydrateDiagnosticFailures(
  entries: readonly CheckpointDiagnosticFailure[],
  projection: EvalCorpusProjection,
): EvalFailureDiagnostic[] {
  const out: EvalFailureDiagnostic[] = [];
  for (const [co, ro, rc] of entries) {
    const reason = evalFailureReasonForCode(rc);
    if (reason === undefined) {
      throw new Error("checkpoint diagnosticFailures reason code is unknown");
    }
    const caseIdx0 = co - 1;
    const roundIdx0 = ro - 1;
    const projectedCase = projection.cases[caseIdx0];
    if (projectedCase === undefined) {
      throw new Error("checkpoint diagnosticFailures references unknown case");
    }
    const projectedRound = projectedCase.rounds[roundIdx0];
    if (projectedRound === undefined) {
      throw new Error("checkpoint diagnosticFailures references unknown round");
    }
    if (
      projectedRound.choiceKind !== "auto" &&
      projectedRound.choiceKind !== "required" &&
      projectedRound.choiceKind !== "function"
    ) {
      throw new Error("checkpoint diagnosticFailures references unsupported tool choice");
    }
    out.push({
      phase: projectedCase.phase,
      caseOrdinal: co,
      roundOrdinal: ro,
      choiceKind: projectedRound.choiceKind,
      reason,
    });
  }
  return out;
}

/** Remove the checkpoint if present; refuses to unlink a symlink/non-regular file. */
export function deleteCheckpoint(loc: CheckpointLocation): void {
  if (!assertAccessibleDir(loc)) return;
  const target = checkpointPath(resolvedDir(loc));
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("checkpoint is not accessible", { cause: error });
  }
  if (stat.isSymbolicLink()) throw new Error("checkpoint must not be a symlink");
  if (!stat.isFile()) throw new Error("checkpoint must be a regular file");
  fsOps.unlinkSync(target);
}
