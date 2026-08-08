/**
 * Opt-in, network-only recovery command for session-owned threads a prior
 * authenticated baseline could not delete (NOT run during offline work, and
 * excluded from `validate`/CI).
 *
 * It is deliberately closed and bounded:
 * - The destination origin is fixed; there is no id/path/URL/host argument.
 * - Thread ids come ONLY from the validated recovery journal (at most two); it
 *   refuses to run for a missing, empty, or invalid journal.
 * - It requires explicit `--execute-approved`, `--cleanup-approved`, and
 *   `--recovery-journal-approved` flags, reads no model-selection variables, and
 *   reads the credential only at runtime on the authenticated path.
 * - It deletes through the same percent-encoded fixed delete path and bounded
 *   transport. A 2xx deletion or an EXACT 404 (already absent) resolves an id;
 *   the journal removal is persisted durably before the id is counted resolved,
 *   so recovery converges across a crash between a prior DELETE and its journal
 *   update. Unresolved ids (any other status/transport/timeout, or a failed
 *   journal write) stay recoverable, and it emits ONLY the value-free report.
 * - Importing this module performs no I/O and reads no credential.
 */
import { pathToFileURL } from "node:url";
import { buildCredentialProviderFromEnv, CLI_MAX_LOGINS } from "./auth.js";
import {
  resolveThreadDeletion,
  type RecoveryAttempt,
  type RecoveryCleanupReport,
} from "./cleanup.js";
import { DISCOVERY_ORIGIN } from "./discovery.js";
import {
  deleteRecoveryJournal,
  defaultDiscoveryJournalDir,
  ensureSafeDiscoveryDir,
  readRecoveryJournal,
  writeRecoveryJournal,
  RECOVERY_JOURNAL_FORMAT,
} from "./recovery-journal.js";
import {
  DEFAULT_OPERATION_TIMEOUTS,
  type CollectivIQTransportConfig,
  type OperationTimeouts,
} from "./types.js";

export interface RecoveryCliArgs {
  readonly executeApproved: boolean;
  readonly cleanupApproved: boolean;
  readonly recoveryJournalApproved: boolean;
}

/**
 * Parse the closed recovery flag set. All three approvals are mandatory; any
 * unknown argument, or a missing approval, is rejected.
 */
export function parseRecoveryArgs(argv: readonly string[]): RecoveryCliArgs {
  let executeApproved = false;
  let cleanupApproved = false;
  let recoveryJournalApproved = false;

  for (const arg of argv) {
    if (arg === "--execute-approved") {
      executeApproved = true;
      continue;
    }
    if (arg === "--cleanup-approved") {
      cleanupApproved = true;
      continue;
    }
    if (arg === "--recovery-journal-approved") {
      recoveryJournalApproved = true;
      continue;
    }
    throw new Error("unrecognized argument");
  }

  if (!executeApproved) throw new Error("recovery requires --execute-approved");
  if (!cleanupApproved) throw new Error("recovery requires --cleanup-approved");
  if (!recoveryJournalApproved) throw new Error("recovery requires --recovery-journal-approved");

  return { executeApproved, cleanupApproved, recoveryJournalApproved };
}

/**
 * Delete the (at most two) thread ids recorded in the recovery journal, updating
 * the journal after each resolved id and removing it once empty. Refuses a
 * missing/empty/invalid journal or an origin that does not match the config.
 *
 * Convergence: a 2xx deletion or an EXACT 404 (already absent) resolves an id;
 * the journal removal is persisted durably BEFORE the id is counted resolved. If
 * that persistence fails, the id stays pending (recoverable) and the run exits
 * non-zero so a later run retries and converges. Every other status, transport,
 * or timeout failure leaves the id pending. Returns only the value-free recovery
 * report (never an identifier).
 */
export async function runRecoveryCleanup(
  config: CollectivIQTransportConfig,
  dir: string,
  timeouts: OperationTimeouts = DEFAULT_OPERATION_TIMEOUTS.getMessages,
  signal?: AbortSignal,
): Promise<RecoveryCleanupReport> {
  const journal = readRecoveryJournal(dir);
  if (journal === null || journal.threadIds.length === 0) {
    throw new Error("no recovery journal to clean up");
  }
  if (journal.destinationOrigin !== config.baseUrl) {
    throw new Error("recovery journal origin mismatch");
  }

  const attempts: RecoveryAttempt[] = [];
  // `remaining` mirrors what the journal currently holds on disk.
  let remaining = [...journal.threadIds];
  let attempted = 0;
  let resolved = 0;
  let unresolved = 0;

  for (const threadId of journal.threadIds) {
    attempted += 1;
    const outcome = await resolveThreadDeletion(config, threadId, timeouts, signal);
    let persisted = false;
    if (outcome.resolved) {
      const next = remaining.filter((id) => id !== threadId);
      try {
        // Durable-first: persist the removal before counting the id resolved, so a
        // crash between the DELETE and the journal update cannot lose the record.
        if (next.length === 0) deleteRecoveryJournal(dir);
        else {
          writeRecoveryJournal(dir, {
            formatVersion: RECOVERY_JOURNAL_FORMAT,
            destinationOrigin: journal.destinationOrigin,
            threadIds: next,
          });
        }
        remaining = next;
        persisted = true;
        resolved += 1;
      } catch {
        // The upstream is clean but the journal update failed: keep the id pending
        // (remaining unchanged) so a later recovery run retries and converges.
        unresolved += 1;
      }
    } else {
      unresolved += 1;
    }
    attempts.push({
      ok: outcome.diagnostics.ok,
      status: outcome.diagnostics.status,
      errorCode: outcome.diagnostics.errorCode,
      resolved: outcome.resolved && persisted,
      resolution: outcome.resolved && persisted ? outcome.resolution : null,
      persisted,
    });
  }

  return { attempted, resolved, unresolved, remaining: remaining.length, attempts };
}

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * The narrow, injectable dependency surface for {@link runRecoveryCli}. It exists
 * ONLY so hermetic tests can exercise the SAME precondition ordering production
 * uses against a temp journal directory, with no live/network/credential access.
 * The FIXED destination origin ({@link DISCOVERY_ORIGIN}) is intentionally NOT
 * part of this surface — it stays hardcoded inside the seam so a test can never
 * broaden the destination. These types are deliberately NOT re-exported through
 * `src/collectiviq/index.ts`.
 */
export interface RecoveryCliDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The recovery journal directory (defaults to the fixed sessions directory). */
  readonly dir: string;
  /** Build the credential provider (defaults to the real env-backed builder). */
  readonly buildProvider: typeof buildCredentialProviderFromEnv;
  /** Execute the bounded recovery cleanup (defaults to {@link runRecoveryCleanup}). */
  readonly runCleanup: (
    config: CollectivIQTransportConfig,
    dir: string,
  ) => Promise<RecoveryCleanupReport>;
  /** Emit a sanitized value to the operator (defaults to stdout JSON). */
  readonly emit: (value: unknown) => void;
}

/** The production dependency set: fixed directory, real provider, real cleanup. */
export function defaultRecoveryCliDeps(): RecoveryCliDeps {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    dir: defaultDiscoveryJournalDir(),
    buildProvider: buildCredentialProviderFromEnv,
    runCleanup: (config, dir) => runRecoveryCleanup(config, dir),
    emit,
  };
}

/**
 * The recovery CLI orchestration seam. Production `main()` is a thin wrapper
 * around `runRecoveryCli(defaultRecoveryCliDeps())`; tests inject fakes/a temp
 * directory to assert the exact ordering. The ordering is fixed: parse →
 * ensureSafeDiscoveryDir → read + validate journal (non-empty, fixed origin) →
 * build provider → runCleanup → emit → exit code. The destination origin is
 * hardcoded here (never injected).
 */
export async function runRecoveryCli(deps: RecoveryCliDeps): Promise<void> {
  // Recovery ordering (defense in depth, independent of runRecoveryCleanup):
  // 1. Parsing enforces all three approvals before anything else happens.
  parseRecoveryArgs(deps.argv);

  const dir = deps.dir;
  // 2. Validate the fixed journal directory/file and ensure it contains work,
  //    tightening the shared directory to 0700 first (write-capable approved).
  ensureSafeDiscoveryDir(dir);
  const journal = readRecoveryJournal(dir);
  if (journal === null || journal.threadIds.length === 0) {
    throw new Error("no recovery journal to clean up");
  }
  // 3. Validate the journal origin against the fixed production origin.
  if (journal.destinationOrigin !== DISCOVERY_ORIGIN) {
    throw new Error("recovery journal origin mismatch");
  }

  // 4. Only now read the credentials and build the provider (login is lazy,
  //    on the first DELETE), bounded by the hard two-login budget. The base is
  //    fixed to the hardcoded discovery origin.
  const resolved = deps.buildProvider(
    deps.env,
    { baseUrl: DISCOVERY_ORIGIN },
    { maxLogins: CLI_MAX_LOGINS },
  );
  const config: CollectivIQTransportConfig = {
    baseUrl: DISCOVERY_ORIGIN,
    credentials: resolved.provider,
  };
  const report = await deps.runCleanup(config, dir);

  // Attach the value-free authentication observation ONLY in password mode.
  const auth = resolved.passwordProvider?.authObservation();
  deps.emit({ ...report, destinationOrigin: DISCOVERY_ORIGIN, ...(auth ? { auth } : {}) });
  if (report.unresolved > 0 || report.remaining > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  await runRecoveryCli(defaultRecoveryCliDeps());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`recovery failed: ${name}\n`);
    process.exitCode = 1;
  });
}
