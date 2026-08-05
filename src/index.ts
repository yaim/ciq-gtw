import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config/load.js";
import { createLogger, emitContentLoggingWarning } from "./observability/logger.js";
import { createReadinessState } from "./api/health-route.js";
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
 * Load configuration, construct the server, bind the listener, and wire signal
 * handling. Configuration is validated before the listener is bound; an
 * invalid configuration throws {@link ConfigError} before any socket is opened.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  emitContentLoggingWarning(config);
  const logger = createLogger(config);

  const readiness = createReadinessState(false);
  const app = buildServer({ config, readiness, logger });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    readiness.setReady(false);
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
    } catch (error) {
      logger.error(
        { err: { name: error instanceof Error ? error.name : "unknown" } },
        "error during shutdown",
      );
    }
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
