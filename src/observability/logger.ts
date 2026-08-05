import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import {
  REDACT_PATHS,
  REDACTION_PLACEHOLDER,
  sanitizeLogRecord,
  sanitizeLogValue,
} from "../shared/redaction.js";
import type { AppConfig } from "../config/schema.js";

export type { Logger };

/** Configuration the logger cares about. */
export type LoggerConfig = Pick<AppConfig, "LOG_LEVEL">;

/**
 * Create the application logger.
 *
 * Every emitted record — per-call fields, child-logger bindings, and error
 * objects — is passed through the bounded sanitizer so nested credentials,
 * error internals, and oversized/hostile values cannot reach the output.
 * Pino's own redact paths are retained as defense in depth. Request, prompt,
 * answer, tool, and repository content are never logged.
 *
 * @param destination optional stream (used by tests to capture output).
 */
export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTION_PLACEHOLDER,
    },
    hooks: {
      // Convert Error arguments to safe objects before Pino can copy an error
      // message into `msg` (which bypasses the formatters below).
      logMethod(inputArgs, method) {
        const safeArgs = inputArgs.map((arg) =>
          arg instanceof Error ? sanitizeLogValue(arg) : arg,
        );
        return method.apply(this, safeArgs as Parameters<typeof method>);
      },
    },
    formatters: {
      // Per-call fields and child bindings are sanitized in the real pipeline.
      // formatters.log runs before Pino's default error serializer, so Errors
      // reduced here are never re-expanded.
      log: (record) => sanitizeLogRecord(record),
      bindings: (bindings) => sanitizeLogRecord(bindings),
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

/** The single fixed line emitted when content logging is enabled. */
export const CONTENT_LOGGING_WARNING_LINE =
  JSON.stringify({
    level: "warn",
    code: "content_logging_enabled",
    message:
      "LOG_CONTENT is enabled for development; request and model content logging remains unimplemented.",
  }) + "\n";

/**
 * Emit the required content-logging warning exactly once when
 * `LOG_CONTENT=true`. The line is fixed (no configuration values, credentials,
 * paths, or dynamic data) and is written directly to an injected writer so it
 * cannot be suppressed by the configured Pino log level.
 */
export function emitContentLoggingWarning(
  config: Pick<AppConfig, "LOG_CONTENT">,
  write: (line: string) => void = (line) => void process.stderr.write(line),
): void {
  if (!config.LOG_CONTENT) return;
  write(CONTENT_LOGGING_WARNING_LINE);
}
