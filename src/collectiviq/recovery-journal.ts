/**
 * Private, on-disk recovery journal for an APPROVED authenticated baseline run.
 *
 * The journal is the ONLY durable record of the (at most two) session-owned
 * thread ids a baseline currently holds, so a crashed or partially-failed run
 * remains recoverable by the opt-in recovery command. It is deliberately
 * minimal and content-free beyond those ids:
 *
 * - It stores ONLY a format version, the fixed destination origin, and up to two
 *   normalized thread ids. Never a credential, model id, run id, prompt, title,
 *   answer, body, status, timestamp, or account/user datum.
 * - It lives at a fixed path under the ignored `.agent/sessions/discovery/`
 *   directory, which is kept a real, private (`0700`) directory.
 * - Reads and deletes first validate the directory itself (a real, non-symlink,
 *   private `0700` directory; absent means "no journal") without creating or
 *   `chmod`ing it, so a redirected or loosened directory is refused. Only the
 *   final directory component is checked — no path-race/ancestor guarantee.
 * - Reads open with `O_NOFOLLOW`, validate the OPEN descriptor via `fstat`
 *   (regular file, private `0600`, within the size cap), read through a bounded
 *   loop (never an unbounded whole-file read), and reject a symlink, a
 *   non-regular/non-private/oversized file, unexpected JSON fields, malformed
 *   JSON, a wrong origin, an unsupported version, a non-array id list, more than
 *   two ids, an empty id, an oversized id, or duplicate ids.
 * - Writes are atomic: a cryptographically-named private temp file
 *   (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0600`) in the same directory is written,
 *   `fsync`ed, then renamed; the temp is always removed on failure and a failed
 *   replacement never truncates the existing valid journal. Writes never follow
 *   or overwrite through a symlink.
 * - Durable-first: every sink transition persists to disk BEFORE mutating the
 *   in-memory ledger, so a failed persist never leaves a phantom recorded id.
 * - Journal contents are never emitted to stdout/stderr, the sanitized report,
 *   logs, thrown messages, tests, or documentation.
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
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The only supported on-disk journal format version. */
export const RECOVERY_JOURNAL_FORMAT = 1 as const;
/** Fixed journal filename, separate from the sanitized baseline report. */
export const RECOVERY_JOURNAL_FILENAME = "recovery-journal.json";
/** A baseline owns at most two threads, so the journal holds at most two ids. */
export const MAX_RECOVERY_THREAD_IDS = 2;

const MAX_THREAD_ID_LENGTH = 256;
const MAX_JOURNAL_BYTES = 4_096;
const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIR_MODE = 0o700;
/** Bits that must be clear for a file/dir to count as private (owner-only). */
const NON_OWNER_PERMISSION_BITS = 0o077;
/** The only property names a valid on-disk journal may contain. */
const ALLOWED_JOURNAL_KEYS: ReadonlySet<string> = new Set([
  "formatVersion",
  "destinationOrigin",
  "threadIds",
]);

/**
 * The low-level filesystem operations the journal read/write/delete paths use,
 * behind a narrow module-internal seam. Production always uses the real `node:fs`
 * functions; tests may override individual ops to inject deterministic faults
 * (a zero-progress write, a temp collision, a rename failure, descriptor growth).
 * This seam is deliberately NOT re-exported from `src/collectiviq/index.ts`, and
 * normal callers keep the same public function signatures.
 */
export interface JournalFsOps {
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

const realFsOps: JournalFsOps = {
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

let fsOps: JournalFsOps = realFsOps;

/**
 * TEST-ONLY seam. Merge `overrides` over the current filesystem ops and return a
 * function that restores the previous set. Never used in production and never
 * re-exported through `index.ts`; use it only from tests, always in a
 * `try`/`finally` that calls the returned restorer.
 */
export function __setRecoveryJournalFsForTests(overrides: Partial<JournalFsOps>): () => void {
  const previous = fsOps;
  fsOps = { ...previous, ...overrides };
  return () => {
    fsOps = previous;
  };
}

/** The minimal, content-free journal shape. */
export interface RecoveryJournalData {
  readonly formatVersion: typeof RECOVERY_JOURNAL_FORMAT;
  readonly destinationOrigin: string;
  readonly threadIds: readonly string[];
}

/**
 * The write-facing journal surface the baseline runner depends on. Its presence
 * (a concrete sink) is what lets an authenticated baseline run; a run given no
 * sink is rejected before any request. Kept abstract so tests can use an
 * in-memory implementation with synthetic ids only.
 */
export interface RecoveryJournalSink {
  /** Verify writability and reconcile any prior state BEFORE the first request. */
  init(): Promise<void>;
  /** Record a newly created, normalized thread id (persisted immediately). */
  recordCreated(threadId: string): Promise<void>;
  /** Drop a thread id after a CONFIRMED successful deletion (persisted). */
  recordDeleted(threadId: string): Promise<void>;
  /** Remove the journal when empty; otherwise leave remaining ids persisted. */
  finalize(): Promise<void>;
  /** Currently owned ids (for the caller/tests); never emitted to output. */
  ownedThreadIds(): readonly string[];
}

/** The fixed journal directory (repo `.agent/sessions/discovery`). */
export function defaultDiscoveryJournalDir(): string {
  return resolve(fileURLToPath(new URL("../../.agent/sessions/discovery", import.meta.url)));
}

function journalPath(dir: string): string {
  return resolve(dir, RECOVERY_JOURNAL_FILENAME);
}

function isValidThreadId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_THREAD_ID_LENGTH &&
    !id.includes("\n") &&
    !id.includes("\r") &&
    !id.includes("\0")
  );
}

/** Enforce the id-list invariants (count, per-id validity, uniqueness). */
function validateThreadIds(ids: readonly string[]): void {
  if (ids.length > MAX_RECOVERY_THREAD_IDS) throw new Error("recovery journal holds too many ids");
  for (const id of ids) {
    if (!isValidThreadId(id)) throw new Error("recovery journal id is invalid");
  }
  if (new Set(ids).size !== ids.length) throw new Error("recovery journal ids must be unique");
}

/** Parse and validate raw journal text into a bounded {@link RecoveryJournalData}. */
function parseJournal(raw: string): RecoveryJournalData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("recovery journal is malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("recovery journal shape is invalid");
  }
  const obj = parsed as Record<string, unknown>;
  // Reject any unexpected property: a valid journal carries exactly the three
  // known fields and nothing else.
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_JOURNAL_KEYS.has(key)) throw new Error("recovery journal has unexpected fields");
  }
  if (obj["formatVersion"] !== RECOVERY_JOURNAL_FORMAT) {
    throw new Error("recovery journal version is unsupported");
  }
  const origin = obj["destinationOrigin"];
  if (typeof origin !== "string" || origin.length === 0) {
    throw new Error("recovery journal origin is invalid");
  }
  const rawIds = obj["threadIds"];
  if (!Array.isArray(rawIds)) throw new Error("recovery journal threadIds is not an array");
  const ids: string[] = [];
  for (const value of rawIds) {
    if (typeof value !== "string") throw new Error("recovery journal id is not a string");
    ids.push(value);
  }
  validateThreadIds(ids);
  return { formatVersion: RECOVERY_JOURNAL_FORMAT, destinationOrigin: origin, threadIds: ids };
}

/**
 * Read the exact bytes of an opened descriptor under a hard cap. Reads through
 * the descriptor with a bounded loop (never an unbounded whole-file read),
 * capped at `MAX_JOURNAL_BYTES + 1` so one byte past the cap forces a rejection.
 */
function readBoundedFromFd(fd: number): string {
  const buffer = Buffer.allocUnsafe(MAX_JOURNAL_BYTES + 1);
  let total = 0;
  for (;;) {
    const room = buffer.length - total;
    if (room === 0) throw new Error("recovery journal is too large");
    const bytesRead = fsOps.readSync(fd, buffer, total, room, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_JOURNAL_BYTES) throw new Error("recovery journal is too large");
  }
  return buffer.toString("utf8", 0, total);
}

/**
 * Validate the journal directory for a NON-creating read or delete. Returns
 * `false` when the directory is absent (the caller treats that as a missing
 * journal). When it exists it must be a real directory, not a symbolic link, and
 * owner-only (`0700`); any other case throws a value-free error. This never
 * creates or `chmod`s the directory — enforcing/creating the private directory is
 * the write path's responsibility. Only the final directory component is checked;
 * no protection is claimed for path races or ancestor components.
 */
function assertAccessibleDir(dir: string): boolean {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("recovery journal directory is not accessible", { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new Error("recovery journal directory must not be a symlink");
  }
  if (!stat.isDirectory()) throw new Error("recovery journal directory is not a directory");
  if ((stat.mode & 0o777) !== JOURNAL_DIR_MODE) {
    throw new Error("recovery journal directory must be private (0700)");
  }
  return true;
}

/**
 * Read and validate the journal. Returns null when it does not exist. Throws a
 * value-free error on a symlink, a non-regular file, a non-private file, an
 * oversized file, or any malformed/invalid content.
 *
 * The file is opened with `O_NOFOLLOW` and validated via `fstat` on the OPEN
 * descriptor (defeating a symlink swapped in after any prior stat), then read
 * through that descriptor with a bounded loop.
 */
export function readRecoveryJournal(dir: string): RecoveryJournalData | null {
  // Validate the directory itself (real, non-symlink, private 0700) BEFORE any
  // file access; an absent directory means there is no journal.
  if (!assertAccessibleDir(dir)) return null;

  const path = journalPath(dir);
  let fd: number;
  try {
    fd = fsOps.openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // ELOOP means the path is a symlink (O_NOFOLLOW refused it); surface it as a
    // symlink rejection rather than a generic access error.
    if (code === "ELOOP") {
      throw new Error("recovery journal must not be a symlink", { cause: error });
    }
    throw new Error("recovery journal is not accessible", { cause: error });
  }
  try {
    const stat = fsOps.fstatSync(fd);
    if (!stat.isFile()) throw new Error("recovery journal must be a regular file");
    if ((stat.mode & NON_OWNER_PERMISSION_BITS) !== 0) {
      throw new Error("recovery journal must be private (0600)");
    }
    if (stat.size > MAX_JOURNAL_BYTES) throw new Error("recovery journal is too large");
    return parseJournal(readBoundedFromFd(fd));
  } finally {
    fsOps.closeSync(fd);
  }
}

/**
 * The single write-capable helper that makes the shared discovery/report
 * directory a real, private (`0700`), non-symlink directory. It creates the
 * directory with `0700` when absent and TIGHTENS an existing real directory
 * (e.g. a `0755` directory left by the sanitized report writer) to `0700`
 * before journal initialization. It refuses a symlinked or non-directory path.
 *
 * Both the sanitized report writer (`discovery-cli`) and the recovery journal
 * use this same helper so the directory can never be left world/group readable.
 * It is deliberately separate from the NON-creating {@link assertAccessibleDir}
 * used on read-only paths.
 */
export function ensureSafeDiscoveryDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error("recovery journal directory must not be a symlink");
  if (!stat.isDirectory()) throw new Error("recovery journal directory is not a directory");
  chmodSync(dir, JOURNAL_DIR_MODE);
}

/** Best-effort fsync of a directory so a rename is durable where supported. */
function fsyncDir(dir: string): void {
  let dfd: number;
  try {
    dfd = openSync(dir, fsConstants.O_RDONLY);
  } catch {
    return; // Some platforms disallow opening a directory for fsync.
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
 * Atomically write the journal with mode `0600`. Validates and byte-bounds the
 * payload, ensures a private directory, refuses to overwrite through a symlink or
 * non-regular target, writes a cryptographically-named private temp file
 * (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0600`) in the same directory, fsyncs and
 * renames it into place, then fsyncs the directory. The temp file is always
 * removed on failure, and a failed replacement never truncates or destroys the
 * existing valid journal (the target is untouched until the final rename).
 */
export function writeRecoveryJournal(dir: string, data: RecoveryJournalData): void {
  if (data.formatVersion !== RECOVERY_JOURNAL_FORMAT) {
    throw new Error("recovery journal version is unsupported");
  }
  if (typeof data.destinationOrigin !== "string" || data.destinationOrigin.length === 0) {
    throw new Error("recovery journal origin is invalid");
  }
  validateThreadIds(data.threadIds);

  const payload =
    JSON.stringify(
      {
        formatVersion: RECOVERY_JOURNAL_FORMAT,
        destinationOrigin: data.destinationOrigin,
        threadIds: [...data.threadIds],
      },
      null,
      2,
    ) + "\n";
  if (Buffer.byteLength(payload, "utf8") > MAX_JOURNAL_BYTES) {
    throw new Error("recovery journal is too large");
  }

  ensureSafeDiscoveryDir(dir);
  const target = journalPath(dir);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("recovery journal must not be a symlink");
    if (!stat.isFile()) throw new Error("recovery journal must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // A unique, unpredictable temp name in the same directory avoids collisions
  // and a predictable-path pre-creation attack; O_EXCL refuses any pre-existing
  // entry (including a planted symlink) at that name.
  const tmp = resolve(dir, `${RECOVERY_JOURNAL_FILENAME}.${randomBytes(12).toString("hex")}.tmp`);
  const fd = fsOps.openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    JOURNAL_FILE_MODE,
  );
  try {
    // Write the full payload, forcing sane progress: a non-positive or
    // non-integer `writeSync` result would otherwise loop forever, and a result
    // larger than the remaining requested length would advance the offset past a
    // never-written tail and rename an incomplete file over the prior journal, so
    // fail closed on both. Positive partial writes within the request advance
    // normally. Then force the mode regardless of umask, flush to disk, and
    // (below) atomically replace the target.
    let written = 0;
    const bytes = Buffer.from(payload, "utf8");
    while (written < bytes.length) {
      const remaining = bytes.length - written;
      const n = fsOps.writeSync(fd, bytes, written, remaining, null);
      if (!Number.isInteger(n) || n <= 0 || n > remaining) {
        throw new Error("recovery journal write reported invalid progress");
      }
      written += n;
    }
    fsOps.fchmodSync(fd, JOURNAL_FILE_MODE);
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
  } catch (error) {
    // Best-effort: close the descriptor and remove the temp so no stale file with
    // ids is left behind; the existing target is untouched.
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

/** Remove the journal if it exists; refuses to unlink a symlink/non-regular file. */
export function deleteRecoveryJournal(dir: string): void {
  // Validate the directory itself before any file access; an absent directory
  // means there is nothing to remove.
  if (!assertAccessibleDir(dir)) return;

  const target = journalPath(dir);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("recovery journal is not accessible", { cause: error });
  }
  if (stat.isSymbolicLink()) throw new Error("recovery journal must not be a symlink");
  if (!stat.isFile()) throw new Error("recovery journal must be a regular file");
  fsOps.unlinkSync(target);
}

/**
 * File-backed {@link RecoveryJournalSink} for the baseline runner. `init` refuses
 * to start when a prior journal still holds unrecovered ids (the operator must
 * run the recovery command first), enforces the fixed origin, and verifies
 * writability before any network request.
 */
/**
 * Run synchronous journal work and surface any failure as a rejected promise
 * (never a synchronous throw), so a caller may uniformly `await` the sink.
 */
function settle(work: () => void): Promise<void> {
  try {
    work();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("recovery journal error", { cause: error }),
    );
  }
}

export class FileRecoveryJournal implements RecoveryJournalSink {
  readonly #dir: string;
  readonly #origin: string;
  #ids: string[] = [];

  constructor(dir: string, origin: string) {
    this.#dir = dir;
    this.#origin = origin;
  }

  init(): Promise<void> {
    return settle(() => {
      // Create-or-tighten the shared directory to a real, private 0700 directory
      // BEFORE the read. This lets an approved run recover cleanly when the
      // directory already exists at 0755 (e.g. left by the sanitized report
      // writer) — the read path itself requires 0700 and would otherwise refuse
      // it. A symlink/non-directory is still rejected here.
      ensureSafeDiscoveryDir(this.#dir);
      const existing = readRecoveryJournal(this.#dir);
      if (existing !== null) {
        if (existing.destinationOrigin !== this.#origin) {
          throw new Error("recovery journal origin mismatch");
        }
        if (existing.threadIds.length > 0) {
          throw new Error("recovery journal has unrecovered threads; run recovery cleanup first");
        }
      }
      // Durable-first: verify writability by WRITING the empty journal BEFORE
      // adopting the new in-memory state (creates the file with mode 0600). Unlike
      // the empty case in {@link #persist}, this must write (not delete) so a
      // non-writable directory fails the run up front.
      writeRecoveryJournal(this.#dir, {
        formatVersion: RECOVERY_JOURNAL_FORMAT,
        destinationOrigin: this.#origin,
        threadIds: [],
      });
      this.#ids = [];
    });
  }

  recordCreated(threadId: string): Promise<void> {
    return settle(() => {
      const next = this.#ids.includes(threadId) ? this.#ids : [...this.#ids, threadId];
      // Durable-first: the write must succeed before the in-memory ledger changes,
      // so a failed persist never leaves an id "recorded" without being on disk.
      this.#persist(next);
      this.#ids = next;
    });
  }

  recordDeleted(threadId: string): Promise<void> {
    return settle(() => {
      const next = this.#ids.filter((id) => id !== threadId);
      // Durable-first: persist the removal (or delete the file when empty) before
      // dropping the id from the in-memory ledger.
      this.#persist(next);
      this.#ids = next;
    });
  }

  finalize(): Promise<void> {
    return settle(() => {
      this.#persist(this.#ids);
    });
  }

  ownedThreadIds(): readonly string[] {
    return [...this.#ids];
  }

  /** Durably persist the given id set: remove the file when empty, else write it. */
  #persist(ids: readonly string[]): void {
    if (ids.length === 0) {
      deleteRecoveryJournal(this.#dir);
      return;
    }
    writeRecoveryJournal(this.#dir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: this.#origin,
      threadIds: [...ids],
    });
  }
}

/**
 * In-memory {@link RecoveryJournalSink} for hermetic tests. Uses synthetic ids
 * only and performs no I/O; enforces the same id-list invariants as the file
 * journal so a test cannot record an impossible state.
 */
export class InMemoryRecoveryJournal implements RecoveryJournalSink {
  #ids: string[] = [];
  #initialized = false;

  init(): Promise<void> {
    return settle(() => {
      this.#initialized = true;
      this.#ids = [];
    });
  }

  recordCreated(threadId: string): Promise<void> {
    return settle(() => {
      const next = this.#ids.includes(threadId) ? this.#ids : [...this.#ids, threadId];
      validateThreadIds(next);
      this.#ids = next;
    });
  }

  recordDeleted(threadId: string): Promise<void> {
    return settle(() => {
      this.#ids = this.#ids.filter((id) => id !== threadId);
    });
  }

  finalize(): Promise<void> {
    // Nothing to persist for the in-memory journal.
    return Promise.resolve();
  }

  ownedThreadIds(): readonly string[] {
    return [...this.#ids];
  }

  get initialized(): boolean {
    return this.#initialized;
  }
}
