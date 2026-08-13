import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config/load.js";
import { createLogger, emitContentLoggingWarning } from "./observability/logger.js";
import { createReadinessState } from "./api/health-route.js";
import { createCompletionRuntime } from "./generation/runtime.js";
import { buildServer } from "./server.js";

/** Fixed message returned for any non-{@link ConfigError} startup failure. */
export const INTERNAL_STARTUP_ERROR_MESSAGE = "gateway failed to start (internal error)";

/**
 * Format a startup failure for stderr without exposing any dynamic diagnostic
 * data. A {@link ConfigError} returns its already-sanitized issue list; every
 * other thrown value returns a single fixed message. This never reads an
 * arbitrary value's `message`, `stack`, `cause`, properties, or `toString()`.
 *
 * The entire detection and formatting path is guarded: any failure — including
 * a hostile Proxy whose `getPrototypeOf` trap throws during `instanceof`, or a
 * `format()` that throws or returns a non-string — fails closed to the fixed
 * internal message.
 */
export function formatStartupError(error: unknown): string {
  try {
    if (error instanceof ConfigError) {
      const formatted = error.format();
      if (typeof formatted === "string") return formatted;
    }
  } catch {
    return INTERNAL_STARTUP_ERROR_MESSAGE;
  }
  return INTERNAL_STARTUP_ERROR_MESSAGE;
}

/**
 * Injectable dependencies for {@link runGracefulShutdown}. Extracted so the exact
 * production shutdown orchestration can be exercised deterministically without a
 * real process, socket, or `process.exit`.
 */
export interface GracefulShutdownDeps {
  /** Mark the instance not-ready (readiness flips before anything else). */
  readonly setNotReady: () => void;
  /** Stop admitting new completions (reject queued/new capacity acquisitions). */
  readonly closeAdmission: () => void;
  /** Abort the shared in-flight signal (stops polling, releases permits). */
  readonly abortInFlight: () => void;
  /** Stop accepting connections and drain in-flight requests (e.g. `app.close`). */
  readonly close: () => Promise<void>;
  /** Bounded drain window (ms) before remaining work is force-cancelled. */
  readonly drainMs: number;
  /** Optional content-free error sink for a close() failure. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Run the graceful-shutdown sequence (specification section 31.3): mark
 * not-ready, stop new admission, allow a bounded drain window, then force-cancel
 * remaining work and clean up the drain timer. Never calls `process.exit` — the
 * caller owns process termination — and leaves no timer behind.
 */
export async function runGracefulShutdown(deps: GracefulShutdownDeps): Promise<void> {
  // 1. Flip readiness and 2. stop admitting new completions immediately.
  deps.setNotReady();
  deps.closeAdmission();
  // 3. Allow in-flight work a bounded drain period, then force-cancel by aborting
  //    the shared signal. `unref` so a pending timer cannot keep a process alive.
  const drainTimer = setTimeout(() => deps.abortInFlight(), deps.drainMs);
  if (typeof drainTimer.unref === "function") drainTimer.unref();
  try {
    await deps.close();
  } catch (error) {
    deps.onError?.(error);
  } finally {
    // 4. Clean up the drain timer and 5. ensure the signal is aborted even if
    //    close() resolved within the window (idempotent).
    clearTimeout(drainTimer);
    deps.abortInFlight();
  }
}

/**
 * Load configuration, construct the server, bind the listener, and wire signal
 * handling. Configuration is validated before the listener is bound; an
 * invalid configuration throws {@link ConfigError} before any socket is opened.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  emitContentLoggingWarning(config);
  const logger = createLogger(config);

  const readiness = createReadinessState(false);

  // Build the completion runtime once so the process root can share the same
  // capacity controller for shutdown draining. Construction opens no socket and
  // performs no CollectivIQ/login I/O (a password login stays lazy).
  const runtime = createCompletionRuntime(config);
  const shutdownController = new AbortController();
  const app = buildServer({
    config,
    readiness,
    logger,
    completion: {
      chatService: runtime.chatService,
      shutdownSignal: shutdownController.signal,
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    await runGracefulShutdown({
      setNotReady: () => readiness.setReady(false),
      closeAdmission: () => runtime.capacity.closeAdmission(),
      abortInFlight: () => shutdownController.abort(),
      close: () => app.close(),
      drainMs: config.SHUTDOWN_DRAIN_MS,
      onError: (error) =>
        logger.error(
          { err: { name: error instanceof Error ? error.name : "unknown" } },
          "error during shutdown",
        ),
    });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.HOST, port: config.PORT });
  readiness.setReady(true);
  logger.info({ host: config.HOST, port: config.PORT }, "gateway listening");
}

/** True when this module is executed directly (not merely imported). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatStartupError(error)}\n`);
    process.exit(1);
  });
}
