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
import {
  resolveThreadDeletion,
  type RecoveryAttempt,
  type RecoveryCleanupReport,
} from "./cleanup.js";
import { DISCOVERY_ORIGIN } from "./discovery.js";
import {
  deleteRecoveryJournal,
  defaultDiscoveryJournalDir,
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

/** Read a required environment variable or fail closed (no value in the error). */
function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") throw new Error(`missing required env ${key}`);
  return value.trim();
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

async function main(): Promise<void> {
  // Parsing enforces all three approvals before anything else happens.
  parseRecoveryArgs(process.argv.slice(2));

  const config: CollectivIQTransportConfig = {
    baseUrl: DISCOVERY_ORIGIN,
    apiKey: requireEnv(process.env, "COLLECTIVIQ_API_KEY"),
  };
  const report = await runRecoveryCleanup(config, defaultDiscoveryJournalDir());

  emit({ ...report, destinationOrigin: DISCOVERY_ORIGIN });
  if (report.unresolved > 0 || report.remaining > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`recovery failed: ${name}\n`);
    process.exitCode = 1;
  });
}
