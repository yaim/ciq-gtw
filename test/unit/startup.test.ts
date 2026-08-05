import { describe, expect, it } from "vitest";
import { formatStartupError, INTERNAL_STARTUP_ERROR_MESSAGE } from "../../src/index.js";
import { ConfigError } from "../../src/config/load.js";

describe("formatStartupError", () => {
  it("hides message and stack of an unexpected Error", () => {
    const error = new Error("secret-message sk-LEAK at /Users/secret/path");
    error.stack = "Error: secret-message\n  at /Users/secret/path:1:1";
    const output = formatStartupError(error);
    expect(output).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(output).not.toContain("secret-message");
    expect(output).not.toContain("sk-LEAK");
    expect(output).not.toContain("/Users/secret/path");
  });

  it("hides a nested cause", () => {
    const error = new Error("outer", { cause: new Error("inner-secret-cause") });
    const output = formatStartupError(error);
    expect(output).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(output).not.toContain("inner-secret-cause");
  });

  it("does not invoke a hostile or throwing toString on a non-Error value", () => {
    const hostile = {
      toString() {
        throw new Error("toString-invoked sk-LEAK");
      },
    };
    let output = "";
    expect(() => {
      output = formatStartupError(hostile);
    }).not.toThrow();
    expect(output).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(output).not.toContain("sk-LEAK");
  });

  it("returns the fixed message for arbitrary non-Error values", () => {
    expect(formatStartupError("a raw string sk-LEAK")).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(formatStartupError(12345)).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(formatStartupError(null)).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(formatStartupError({ password: "hunter2" })).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
  });

  it("fails closed for a hostile Proxy whose getPrototypeOf trap throws", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("proxy startup sentinel");
        },
      },
    );
    let output = "";
    expect(() => {
      output = formatStartupError(hostile);
    }).not.toThrow();
    expect(output).toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
    expect(output).not.toContain("proxy startup sentinel");
  });

  it("returns the sanitized issue list for a ConfigError", () => {
    const error = new ConfigError([
      { field: "PORT", reason: "must be an integer" },
      { field: "models[0].answerSource", reason: "has unsupported value" },
    ]);
    const output = formatStartupError(error);
    expect(output).toContain("PORT: must be an integer");
    expect(output).toContain("models[0].answerSource: has unsupported value");
    expect(output).not.toBe(INTERNAL_STARTUP_ERROR_MESSAGE);
  });
});
