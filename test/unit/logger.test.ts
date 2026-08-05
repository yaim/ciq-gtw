import { describe, expect, it } from "vitest";
import type { DestinationStream } from "pino";
import {
  CONTENT_LOGGING_WARNING_LINE,
  createLogger,
  emitContentLoggingWarning,
  type LoggerConfig,
} from "../../src/observability/logger.js";
import { REDACTION_PLACEHOLDER, SANITIZE_MARKERS } from "../../src/shared/redaction.js";

/** Build a logger whose output is captured and parseable. */
function capturingLogger(level: LoggerConfig["LOG_LEVEL"] = "info") {
  const lines: string[] = [];
  const stream: DestinationStream = {
    write: (chunk: string) => {
      lines.push(chunk);
    },
  };
  const logger = createLogger({ LOG_LEVEL: level }, stream);
  return {
    logger,
    lines,
    text: () => lines.join(""),
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger sanitization (actual output)", () => {
  it("redacts a three-plus-level nested API key", () => {
    const cap = capturingLogger();
    cap.logger.info({ a: { b: { c: { apiKey: "sk-DEEP" } } } }, "m");
    const rec = cap.records()[0] as { a: { b: { c: Record<string, string> } } };
    expect(rec.a.b.c["apiKey"]).toBe(REDACTION_PLACEHOLDER);
    expect(cap.text()).not.toContain("sk-DEEP");
  });

  it("redacts authorization nested inside arrays", () => {
    const cap = capturingLogger();
    cap.logger.info({ calls: [{ authorization: "Bearer sk-ARR" }] }, "m");
    expect(cap.text()).not.toContain("sk-ARR");
    expect(cap.text()).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts nested upstream and gateway keys", () => {
    const cap = capturingLogger();
    cap.logger.info({ ctx: { collectiviqApiKey: "sk-UP", gatewayKeys: ["gw-1", "gw-2"] } }, "m");
    const text = cap.text();
    expect(text).not.toContain("sk-UP");
    expect(text).not.toContain("gw-1");
    expect(text).not.toContain("gw-2");
  });

  it("keeps only safe metadata from error message, stack, and cause", () => {
    const cap = capturingLogger();
    const err = new Error("boom-secret at /Users/secret/x");
    (err as { cause?: unknown }).cause = new Error("secret-cause-text");
    cap.logger.error({ err }, "failed");
    const text = cap.text();
    expect(text).not.toContain("boom-secret");
    expect(text).not.toContain("/Users/secret/x");
    expect(text).not.toContain("secret-cause-text");
    const rec = cap.records()[0] as { err: Record<string, unknown> };
    expect(rec.err["name"]).toBe("Error");
  });

  it("sanitizes a nested secret inside a child-logger binding", () => {
    const cap = capturingLogger();
    const child = cap.logger.child({ scope: { token: "tok-CHILD" } });
    child.warn({ ok: 1 }, "child-msg");
    expect(cap.text()).not.toContain("tok-CHILD");
  });

  it("does not throw on circular input", () => {
    const cap = capturingLogger();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => cap.logger.info({ cyclic }, "m")).not.toThrow();
    expect(cap.text()).toContain(SANITIZE_MARKERS.circular);
  });

  it("does not invoke a throwing accessor", () => {
    const cap = capturingLogger();
    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter invoked");
      },
    });
    expect(() => cap.logger.info({ hostile }, "m")).not.toThrow();
    expect(invoked).toBe(false);
    expect(cap.text()).not.toContain("getter invoked");
  });

  it("bounds depth, property count, array length, and string length", () => {
    const cap = capturingLogger();
    let deep: Record<string, unknown> = { leaf: "deep-secret-leaf" };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    const wide: Record<string, number> = {};
    for (let i = 0; i < 150; i += 1) wide[`k${i}`] = i;
    cap.logger.info(
      { deep, wide, arr: Array.from({ length: 150 }, (_v, i) => i), big: "y".repeat(5000) },
      "m",
    );
    const text = cap.text();
    expect(text).toContain(SANITIZE_MARKERS.depthExceeded);
    expect(text).not.toContain("deep-secret-leaf");
    expect(text).toContain(SANITIZE_MARKERS.truncated);
    expect(text).not.toContain("y".repeat(5000));
  });

  it("keeps ordinary safe metadata available", () => {
    const cap = capturingLogger();
    cap.logger.info({ requestId: "req-1", status: 200 }, "m");
    const rec = cap.records()[0] as Record<string, unknown>;
    expect(rec["requestId"]).toBe("req-1");
    expect(rec["status"]).toBe(200);
  });

  it("redacts token-suffix credentials but keeps token usage counters", () => {
    const cap = capturingLogger();
    cap.logger.info(
      {
        authToken: "S_AUTH",
        access_token: "S_ACCESS",
        refreshToken: "S_REFRESH",
        bearerToken: "S_BEARER",
        idToken: "S_ID",
        sessionToken: "S_SESSION",
        tokenCount: 7,
        inputTokens: 8,
        outputTokens: 9,
        totalTokens: 10,
      },
      "m",
    );
    const text = cap.text();
    for (const sentinel of ["S_AUTH", "S_ACCESS", "S_REFRESH", "S_BEARER", "S_ID", "S_SESSION"]) {
      expect(text).not.toContain(sentinel);
    }
    const rec = cap.records()[0] as Record<string, unknown>;
    expect(rec["tokenCount"]).toBe(7);
    expect(rec["inputTokens"]).toBe(8);
    expect(rec["outputTokens"]).toBe(9);
    expect(rec["totalTokens"]).toBe(10);
  });

  it("never invokes array-index or Error constructor accessors through Pino", () => {
    const cap = capturingLogger();
    let arrayInvoked = false;
    let constructorInvoked = false;

    const array: unknown[] = [];
    Object.defineProperty(array, "0", {
      enumerable: true,
      configurable: true,
      get() {
        arrayInvoked = true;
        throw new Error("array getter sentinel");
      },
    });

    const err = new Error("boom");
    Object.defineProperty(err, "constructor", {
      configurable: true,
      get() {
        constructorInvoked = true;
        throw new Error("constructor getter sentinel");
      },
    });

    expect(() => cap.logger.info({ array, err }, "m")).not.toThrow();
    expect(arrayInvoked).toBe(false);
    expect(constructorInvoked).toBe(false);
    const text = cap.text();
    expect(text).not.toContain("array getter sentinel");
    expect(text).not.toContain("constructor getter sentinel");
  });

  it("emits no credential sentinel anywhere in serialized output", () => {
    const cap = capturingLogger();
    const sentinels = ["sk-DEEP", "sk-ARR", "sk-UP", "gw-1", "tok-CHILD", "boom-secret"];
    cap.logger.info(
      {
        a: { b: { apiKey: "sk-DEEP" } },
        calls: [{ authorization: "Bearer sk-ARR" }],
        ctx: { collectiviqApiKey: "sk-UP", gatewayKeys: ["gw-1"] },
      },
      "m",
    );
    cap.logger.child({ scope: { token: "tok-CHILD" } }).info("c");
    const text = cap.text();
    for (const sentinel of sentinels.filter((s) => s !== "boom-secret")) {
      expect(text).not.toContain(sentinel);
    }
  });
});

describe("emitContentLoggingWarning", () => {
  it("emits exactly one fixed line when LOG_CONTENT=true", () => {
    const out: string[] = [];
    emitContentLoggingWarning({ LOG_CONTENT: true }, (line) => out.push(line));
    expect(out).toEqual([CONTENT_LOGGING_WARNING_LINE]);
    const parsed = JSON.parse(out[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["code"]).toBe("content_logging_enabled");
    expect(parsed["level"]).toBe("warn");
  });

  it("emits even when the logger level would suppress warnings", () => {
    // The warning does not go through Pino, so a silent logger cannot hide it.
    const silent = capturingLogger("silent");
    silent.logger.warn("suppressed");
    expect(silent.lines).toHaveLength(0);

    const out: string[] = [];
    emitContentLoggingWarning({ LOG_CONTENT: true }, (line) => out.push(line));
    expect(out).toHaveLength(1);
  });

  it("does not emit when LOG_CONTENT=false", () => {
    const out: string[] = [];
    emitContentLoggingWarning({ LOG_CONTENT: false }, (line) => out.push(line));
    expect(out).toHaveLength(0);
  });

  it("contains no configuration values, credentials, or paths", () => {
    expect(CONTENT_LOGGING_WARNING_LINE).not.toMatch(/\//);
    expect(CONTENT_LOGGING_WARNING_LINE).not.toMatch(/sk-|gw-/);
  });
});
