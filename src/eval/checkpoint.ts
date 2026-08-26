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
} from "./report.js";
import type { EvalCorpusProjection } from "./cases.js";

/**
 * The only supported on-disk checkpoint format version. Format 2 adds a
 * compact, content-free `diagnosticFailures` ledger to persist scored-round
 * failure diagnostics across resume segments. Format 1 is REJECTED on read (no
 * migration): a resumed diagnostic run must start from a fresh anchor.
 */
export const CHECKPOINT_FORMAT_VERSION = 2 as const;
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
      "diagnosticFailures",
    ],
    "root",
  );

  // Version 1 predates the compact diagnostic ledger; there is deliberately NO
  // migration path — the resumed run must start from a fresh anchor.
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
    diagnosticFailures,
  };
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
  assertDiagnosticFailuresShape(data.diagnosticFailures);
  return JSON.stringify(data) + "\n";
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
 * Semantic (corpus-bound) validation of a RESUMABLE checkpoint against the
 * ACTUAL fingerprint-bound corpus projection (findings 1 + 2). Enforces that a
 * persisted resumable checkpoint's cursor, committed case counts, gate
 * denominators/numerators, upstream-round counters, and cleanup accounting are
 * consistent with the projection, so a forged or internally-inconsistent
 * checkpoint (e.g. a "complete + passing, zero-attempt" file, a scenario that
 * skipped its final-answer round, or an arbitrarily inflated counter) is
 * rejected BEFORE any credential read or network I/O and can never grant an
 * executed pass. All planned bounds and per-round layout come from the
 * supplied projection — never from checkpoint-claimed sizes.
 *
 * The per-case diagnostic checks read `projection.cases[caseIdx0]` DIRECTLY,
 * so a non-uniform corpus (a case with more/fewer rounds than its peers, or an
 * expected/final round in an unusual position) is validated round-by-round
 * rather than reduced to a "first N rounds are expected" inference.
 *
 * A resumable checkpoint MUST have `nextCaseIndex` STRICTLY less than the
 * corpus length: a genuinely complete run removes its checkpoint during
 * finalization, so a persisted resumable checkpoint can never legitimately
 * encode a complete corpus. Because `cursor < length` implies at least one
 * gate denominator is below its planned denominator, a resumed run can never
 * report `passed` without executing the remaining cases live.
 *
 * Round-counter bounds. A committed multi scenario performs
 * `projection.maxRoundsPerCase` upstream rounds (three tool steps PLUS one
 * final-answer round), so the committed upstream floor is
 * `committedSingle + committedMulti * maxRoundsPerCase` — NOT the
 * `* expectedCallsPerScenario` gate count. The operational counters
 * (`attemptedRounds`/`completedRounds`) accumulate across resume segments, but
 * a segment aborts at its FIRST non-committing case, so a segment can leave at
 * most ONE in-flight case's worth of uncommitted work: up to
 * `maxRoundsPerCase - 1` completed-but-uncommitted partial-scenario rounds (a
 * mid-scenario interruption restarts and re-counts the scenario) plus at most
 * one terminal failed attempted round. Across `runSegments` segments the
 * counters are therefore bounded ABOVE by the committed floor plus that
 * per-segment slack; an arbitrarily inflated counter is rejected. Throws
 * value-free on any inconsistency.
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
  // Committed counts + denominators + upstream-round floor come directly from
  // the ACTUAL first-`cursor` projection cases — never from the aggregate
  // shortcut `single + multi * maxRoundsPerCase`. For the uniform production
  // corpus the sums match that shortcut byte-for-byte; for a non-uniform
  // corpus they honor the actual per-case round layout.
  let committedSingle = 0;
  let committedMulti = 0;
  let committedUpstreamRounds = 0;
  let expectedCallDenom = 0;
  for (let idx = 0; idx < cursor; idx += 1) {
    const projectedCase = cases[idx];
    if (projectedCase === undefined) {
      throw new Error("checkpoint cursor references unknown case");
    }
    if (projectedCase.phase === "single") committedSingle += 1;
    else committedMulti += 1;
    committedUpstreamRounds += projectedCase.rounds.length;
    for (const r of projectedCase.rounds) if (r.hasExpectedTool) expectedCallDenom += 1;
  }
  if (committedMulti > plannedMulti) throw new Error("checkpoint committed-multi exceeds plan");
  if (committedSingle > plannedSingle) throw new Error("checkpoint committed-single exceeds plan");

  // Committed case counts are EXACTLY cursor-derived.
  if (data.completedSingleRoundCases !== committedSingle) {
    throw new Error("checkpoint completed-single mismatch");
  }
  if (data.completedMultiStepScenarios !== committedMulti) {
    throw new Error("checkpoint completed-multi mismatch");
  }

  // Gate denominators sum the ACTUAL committed cases' expected-tool rounds.
  if (data.gates.single.total !== committedSingle) {
    throw new Error("checkpoint single denominator mismatch");
  }
  if (data.gates.multi.total !== committedMulti) {
    throw new Error("checkpoint multi denominator mismatch");
  }
  if (data.gates.expectedCall.total !== expectedCallDenom) {
    throw new Error("checkpoint expected-call denominator mismatch");
  }

  // Every numerator/success count is an integer within [0, denominator].
  const inRange = (n: number, d: number): boolean => Number.isInteger(n) && n >= 0 && n <= d;
  if (!inRange(data.gates.single.success, committedSingle)) {
    throw new Error("checkpoint single success out of range");
  }
  if (!inRange(data.gates.multi.success, committedMulti)) {
    throw new Error("checkpoint multi success out of range");
  }
  if (!inRange(data.gates.expectedCall.schemaValid, expectedCallDenom)) {
    throw new Error("checkpoint schemaValid out of range");
  }
  if (!inRange(data.gates.expectedCall.nameAccurate, expectedCallDenom)) {
    throw new Error("checkpoint nameAccurate out of range");
  }
  if (!inRange(data.gates.expectedCall.argValid, expectedCallDenom)) {
    throw new Error("checkpoint argValid out of range");
  }

  // A persisted checkpoint has a valid positive run-segment count.
  if (!Number.isInteger(data.runSegments) || data.runSegments < 1) {
    throw new Error("checkpoint run-segment count is invalid");
  }

  // Upstream-round counters: `committedUpstreamRounds` was computed above by
  // summing the ACTUAL per-case round counts. The ceilings then allow one
  // in-flight case's slack per resume segment, bounded above by the projection
  // maximum (`maxRoundsPerCase`).
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

  // Resumable cleanup accounting is truthful (a failed/leaked/journal-failed state
  // is never resumable), and reconciles with the attempted-round counter.
  const c = data.cleanup;
  if (c.deleted + c.failed !== c.attempted) throw new Error("checkpoint cleanup sum mismatch");
  if (c.failed !== 0) throw new Error("checkpoint resumable cleanup has failures");
  if (c.journalFailures !== 0) throw new Error("checkpoint resumable cleanup has journal failures");
  if (c.attempted !== c.deleted) throw new Error("checkpoint resumable cleanup not fully deleted");
  if (data.attemptedRounds !== c.attempted)
    throw new Error("checkpoint attempted/cleanup mismatch");

  // Diagnostic ledger: every entry must reference a real corpus round at or
  // before the current cursor, and its reason must be structurally compatible
  // with that round's ACTUAL expected-tool disposition — looked up directly
  // from `projection.cases[caseIdx0].rounds[roundIdx0]`, never inferred from
  // aggregate position. Duplicates + shape/bound checks were enforced during
  // parsing; here we bind to the corpus.
  const cursor1Based = data.nextCaseIndex; // = number of committed cases
  for (const entry of data.diagnosticFailures) {
    const [co, ro, rc] = entry;
    if (co > cursor1Based) {
      throw new Error("checkpoint diagnosticFailures references uncommitted case");
    }
    const caseIdx0 = co - 1;
    const roundIdx0 = ro - 1;
    const projectedCase = cases[caseIdx0];
    if (projectedCase === undefined) {
      throw new Error("checkpoint diagnosticFailures references unknown round");
    }
    const projectedRound = projectedCase.rounds[roundIdx0];
    if (projectedRound === undefined) {
      throw new Error("checkpoint diagnosticFailures references unknown round");
    }
    const reason = evalFailureReasonForCode(rc);
    if (reason === undefined) {
      throw new Error("checkpoint diagnosticFailures reason code is unknown");
    }
    const scope = EVAL_FAILURE_REASON_SCOPE[reason];
    const isExpected = projectedRound.hasExpectedTool;
    if (scope === "expected" && !isExpected) {
      throw new Error("checkpoint diagnosticFailures reason incompatible with final round");
    }
    if (scope === "final" && isExpected) {
      throw new Error("checkpoint diagnosticFailures reason incompatible with expected-tool round");
    }
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
