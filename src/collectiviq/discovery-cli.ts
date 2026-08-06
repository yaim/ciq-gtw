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
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
} from "./discovery.js";
import type { CollectivIQTransportConfig } from "./types.js";

// Re-exported so the CLI remains the single entry point operators (and tests)
// reach for; the strict completeness policy itself lives with the runner.
export { exitCodeForBaseline };

export interface DiscoveryCliArgs {
  readonly session: DiscoverySession;
  readonly executeApproved: boolean;
  readonly cleanupApproved: boolean;
  readonly observeNotFoundApproved: boolean;
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

  return {
    session: DISCOVERY_SESSION,
    executeApproved,
    cleanupApproved,
    observeNotFoundApproved,
    write,
  };
}

/** Read a required environment variable or fail closed (no value in the error). */
function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") throw new Error(`missing required env ${key}`);
  return value.trim();
}

/**
 * Build the transport config for authenticated execution. The origin is fixed;
 * only the credential is read from the environment. This is never called on the
 * preflight path.
 */
function buildExecutionConfig(env: NodeJS.ProcessEnv): CollectivIQTransportConfig {
  return { baseUrl: DISCOVERY_ORIGIN, apiKey: requireEnv(env, "COLLECTIVIQ_API_KEY") };
}

function emit<T>(value: T): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function persist(session: DiscoverySession, report: unknown): void {
  const dir = resolve(fileURLToPath(new URL("../../.agent/sessions/discovery", import.meta.url)));
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${session}.json`), JSON.stringify(report, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const args = parseDiscoveryArgs(process.argv.slice(2));

  if (!args.executeApproved) {
    // PREFLIGHT ONLY: no credential read, no network request.
    const report: DiscoveryPreflightReport = buildPreflightReport(process.env, {
      cleanupApproved: args.cleanupApproved,
      notFoundObservationApproved: args.observeNotFoundApproved,
    });
    emit(report);
    return;
  }

  const selection = buildModelSelection(process.env);
  const config = buildExecutionConfig(process.env);
  const runner = new DiscoverySessionRunner(config);

  const report: DiscoveryBaselineReport = await runner.executeBaseline({
    selection,
    cleanupApproved: args.cleanupApproved,
    observeNotFoundApproved: args.observeNotFoundApproved,
  });

  // Report the fixed destination origin rather than any configured value.
  emit({ ...report, destinationOrigin: DISCOVERY_ORIGIN });

  // A failed approved cleanup makes the process exit non-zero.
  const code = exitCodeForBaseline(report);
  if (code !== 0) process.exitCode = code;

  if (args.write) persist(args.session, { ...report, destinationOrigin: DISCOVERY_ORIGIN });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`discovery failed: ${name}\n`);
    process.exitCode = 1;
  });
}
