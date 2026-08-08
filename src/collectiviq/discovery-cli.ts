/**
 * Opt-in CollectivIQ staged discovery command (NOT run during the offline
 * stage).
 *
 * The CLI runs a single bounded `baseline` session against a FIXED destination
 * origin. It accepts only a closed set of flags — never arbitrary methods,
 * paths, URLs, headers, bodies, thread ids, or run ids. Credentials and model
 * inputs are read from the environment at runtime only (never at module load,
 * and never in the default preflight path).
 *
 * Default invocation is PREFLIGHT ONLY: it validates the model selection and
 * reports bounded projected operation counts, the fixed origin, and which
 * approvals are set — without reading the upstream credential or making any
 * network request. Authenticated execution requires `--execute-approved`;
 * cleanup and not-found observation require their own separate approvals.
 *
 * Output is limited to sanitized objects (safe status, safe error code,
 * structural capture). With `--write`, only a sanitized capture is written
 * under the ignored `.agent/sessions/` directory; captures are never promoted
 * into committed fixtures automatically.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCredentialProviderFromEnv, CLI_MAX_LOGINS } from "./auth.js";
import {
  buildModelSelection,
  buildPreflightReport,
  DISCOVERY_ORIGIN,
  DISCOVERY_SESSION,
  DiscoverySessionRunner,
  exitCodeForBaseline,
  type DiscoveryBaselineReport,
  type DiscoveryPreflightReport,
  type DiscoverySession,
  type ExecuteBaselineOptions,
} from "./discovery.js";
import {
  defaultDiscoveryJournalDir,
  ensureSafeDiscoveryDir,
  FileRecoveryJournal,
  type RecoveryJournalSink,
} from "./recovery-journal.js";
import type { CollectivIQTransportConfig } from "./types.js";

// Re-exported so the CLI remains the single entry point operators (and tests)
// reach for; the strict completeness policy itself lives with the runner.
export { exitCodeForBaseline };

export interface DiscoveryCliArgs {
  readonly session: DiscoverySession;
  readonly executeApproved: boolean;
  readonly cleanupApproved: boolean;
  readonly observeNotFoundApproved: boolean;
  readonly recoveryJournalApproved: boolean;
  readonly write: boolean;
}

/**
 * Parse CLI arguments, accepting only the closed flag set. Throws on any
 * unknown argument, unsupported session, or an unsafe approval combination.
 */
export function parseDiscoveryArgs(argv: readonly string[]): DiscoveryCliArgs {
  let sessionSeen = false;
  let executeApproved = false;
  let cleanupApproved = false;
  let observeNotFoundApproved = false;
  let recoveryJournalApproved = false;
  let write = false;

  for (const arg of argv) {
    if (arg === "--execute-approved") {
      executeApproved = true;
      continue;
    }
    if (arg === "--cleanup-approved") {
      cleanupApproved = true;
      continue;
    }
    if (arg === "--observe-not-found-approved") {
      observeNotFoundApproved = true;
      continue;
    }
    if (arg === "--recovery-journal-approved") {
      recoveryJournalApproved = true;
      continue;
    }
    if (arg === "--write") {
      write = true;
      continue;
    }
    const match = /^--session=(.+)$/.exec(arg);
    if (match) {
      if (match[1] !== DISCOVERY_SESSION) throw new Error("unsupported session");
      sessionSeen = true;
      continue;
    }
    throw new Error("unrecognized argument");
  }

  if (!sessionSeen) throw new Error("missing --session=baseline");
  // Not-found observation performs a delete; it is unavailable unless cleanup
  // is also approved.
  if (observeNotFoundApproved && !cleanupApproved) {
    throw new Error("--observe-not-found-approved requires --cleanup-approved");
  }
  // Authenticated execution must keep session-owned threads recoverable, so the
  // recovery journal must be explicitly approved.
  if (executeApproved && !recoveryJournalApproved) {
    throw new Error("--execute-approved requires --recovery-journal-approved");
  }

  return {
    session: DISCOVERY_SESSION,
    executeApproved,
    cleanupApproved,
    observeNotFoundApproved,
    recoveryJournalApproved,
    write,
  };
}

function emit<T>(value: T): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function persist(session: DiscoverySession, report: unknown): void {
  const dir = defaultDiscoveryJournalDir();
  // Use the shared safe-directory helper so the report directory is a real,
  // private 0700 directory (never world/group readable).
  ensureSafeDiscoveryDir(dir);
  writeFileSync(resolve(dir, `${session}.json`), JSON.stringify(report, null, 2) + "\n", "utf8");
}

/** The minimal runner surface the seam drives (only the baseline entry point). */
export interface DiscoveryRunnerLike {
  executeBaseline(options: ExecuteBaselineOptions): Promise<DiscoveryBaselineReport>;
}

/**
 * The narrow, injectable dependency surface for {@link runDiscoveryCli}. It
 * exists ONLY so hermetic tests can exercise the SAME ordering production uses
 * without any live/network/credential/journal-directory access. The FIXED
 * destination origin ({@link DISCOVERY_ORIGIN}) is intentionally NOT part of this
 * surface — it stays hardcoded inside the seam so a test can never broaden the
 * destination. These types are deliberately NOT re-exported through
 * `src/collectiviq/index.ts`.
 */
export interface DiscoveryCliDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Construct the recovery journal sink for the fixed directory/origin. */
  readonly makeJournal: (dir: string, origin: string) => RecoveryJournalSink;
  /** Build the credential provider (defaults to the real env-backed builder). */
  readonly buildProvider: typeof buildCredentialProviderFromEnv;
  /** Construct the baseline runner from the (fixed-origin) transport config. */
  readonly makeRunner: (config: CollectivIQTransportConfig) => DiscoveryRunnerLike;
  /** Emit a sanitized value to the operator (defaults to stdout JSON). */
  readonly emit: (value: unknown) => void;
  /** Persist a sanitized report under the ignored sessions directory. */
  readonly persist: (session: DiscoverySession, report: unknown) => void;
}

/** The production dependency set: real journal, provider, runner, and I/O. */
export function defaultDiscoveryCliDeps(): DiscoveryCliDeps {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    makeJournal: (dir, origin) => new FileRecoveryJournal(dir, origin),
    buildProvider: buildCredentialProviderFromEnv,
    makeRunner: (config) => new DiscoverySessionRunner(config),
    emit,
    persist,
  };
}

/**
 * The discovery CLI orchestration seam. Production `main()` is a thin wrapper
 * around `runDiscoveryCli(defaultDiscoveryCliDeps())`; tests inject fakes to
 * assert the exact ordering. The ordering is fixed: parse → model selection →
 * journal.init → build provider → executeBaseline → emit → exit code → persist.
 * The destination origin is hardcoded here (never injected).
 */
export async function runDiscoveryCli(deps: DiscoveryCliDeps): Promise<void> {
  const args = parseDiscoveryArgs(deps.argv);

  if (!args.executeApproved) {
    // PREFLIGHT ONLY: no credential read, no network request, no journal I/O.
    const report: DiscoveryPreflightReport = buildPreflightReport(deps.env, {
      cleanupApproved: args.cleanupApproved,
      notFoundObservationApproved: args.observeNotFoundApproved,
      recoveryJournalApproved: args.recoveryJournalApproved,
    });
    deps.emit(report);
    return;
  }

  // Authenticated ordering (defense in depth, independent of the runner):
  // 1. flags parsed above; 2. canonicalize the model selection;
  const selection = buildModelSelection(deps.env);
  // 3. validate/initialize the recovery journal BEFORE any credential is read.
  //    This creates/tightens the fixed private directory and enforces the
  //    fixed origin and no-unrecovered-threads guard with NO network and NO
  //    credential access.
  const journal = deps.makeJournal(defaultDiscoveryJournalDir(), DISCOVERY_ORIGIN);
  await journal.init();
  // 4. Only now read the credentials and build the provider (bearer static
  //    token, or a password provider with the hard two-login budget). Login
  //    itself happens lazily on the first upstream request. The base is fixed to
  //    the hardcoded discovery origin.
  const resolved = deps.buildProvider(
    deps.env,
    { baseUrl: DISCOVERY_ORIGIN },
    { maxLogins: CLI_MAX_LOGINS },
  );
  const config: CollectivIQTransportConfig = {
    baseUrl: DISCOVERY_ORIGIN,
    credentials: resolved.provider,
  };
  const runner = deps.makeRunner(config);

  const report: DiscoveryBaselineReport = await runner.executeBaseline({
    selection,
    cleanupApproved: args.cleanupApproved,
    observeNotFoundApproved: args.observeNotFoundApproved,
    recoveryJournalApproved: args.recoveryJournalApproved,
    recoveryJournal: journal,
  });

  // Attach the value-free authentication observation ONLY in password mode.
  const auth = resolved.passwordProvider?.authObservation();
  const finalReport = {
    ...report,
    destinationOrigin: DISCOVERY_ORIGIN,
    ...(auth ? { auth } : {}),
  };

  // Report the fixed destination origin rather than any configured value.
  deps.emit(finalReport);

  // A failed approved cleanup makes the process exit non-zero.
  const code = exitCodeForBaseline(report);
  if (code !== 0) process.exitCode = code;

  if (args.write) deps.persist(args.session, finalReport);
}

async function main(): Promise<void> {
  await runDiscoveryCli(defaultDiscoveryCliDeps());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`discovery failed: ${name}\n`);
    process.exitCode = 1;
  });
}
