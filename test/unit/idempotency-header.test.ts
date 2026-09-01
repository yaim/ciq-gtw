import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, readIdempotencyKeyHeader } from "../../src/idempotency/header.js";
import {
  MAX_IDEMPOTENCY_KEY_BYTES,
  MIN_IDEMPOTENCY_KEY_BYTES,
} from "../../src/idempotency/limits.js";

/** Node's flat rawHeaders shape: name, value, name, value, … */
function rawHeaders(...pairs: readonly (readonly [string, string])[]): string[] {
  return pairs.flatMap(([name, value]) => [name, value]);
}

describe("readIdempotencyKeyHeader", () => {
  it("reports an absent header without inventing a key", () => {
    expect(readIdempotencyKeyHeader(undefined)).toEqual({ kind: "absent" });
  });

  it("preserves an accepted value byte-for-byte with no normalization", () => {
    // Case, punctuation, and internal structure are all preserved exactly.
    for (const value of ["a", "A-Very_Mixed.Case:Key/1", "0123456789", "~!@#$%^&*()_+{}|"]) {
      expect(readIdempotencyKeyHeader(value)).toEqual({ kind: "key", value });
    }
  });

  it("enforces the 1-255 byte bounds by UTF-8 length", () => {
    expect(MIN_IDEMPOTENCY_KEY_BYTES).toBe(1);
    expect(MAX_IDEMPOTENCY_KEY_BYTES).toBe(255);

    const atCap = "k".repeat(MAX_IDEMPOTENCY_KEY_BYTES);
    expect(readIdempotencyKeyHeader(atCap)).toEqual({ kind: "key", value: atCap });
    expect(readIdempotencyKeyHeader(`${atCap}k`)).toEqual({ kind: "invalid" });
    expect(readIdempotencyKeyHeader("")).toEqual({ kind: "invalid" });
  });

  it("rejects space, control, and non-ASCII characters", () => {
    for (const value of [
      "has space",
      " leading",
      "trailing ",
      "tab\there",
      "newline\nhere",
      "carriage\rreturn",
      "null\u0000byte",
      "delete\u007f",
      "café", // non-ASCII
      "emoji-🙂",
    ]) {
      expect(readIdempotencyKeyHeader(value)).toEqual({ kind: "invalid" });
    }
  });

  it("rejects an array-valued header", () => {
    expect(readIdempotencyKeyHeader(["a", "b"])).toEqual({ kind: "invalid" });
    // Even a single-element array is a duplicate signal, not a usable key.
    expect(readIdempotencyKeyHeader(["a"])).toEqual({ kind: "invalid" });
  });

  it("rejects a duplicated header through rawHeaders", () => {
    const headers = rawHeaders(
      ["Idempotency-Key", "alpha"],
      ["content-type", "application/json"],
      ["IDEMPOTENCY-KEY", "bravo"],
    );
    expect(readIdempotencyKeyHeader("alpha", headers)).toEqual({ kind: "invalid" });
  });

  it("accepts a single occurrence in rawHeaders and tolerates their absence", () => {
    const single = rawHeaders(["Idempotency-Key", "alpha"], ["accept", "*/*"]);
    expect(readIdempotencyKeyHeader("alpha", single)).toEqual({ kind: "key", value: "alpha" });
    // A stack that does not expose rawHeaders still works via the character rules.
    expect(readIdempotencyKeyHeader("alpha", undefined)).toEqual({ kind: "key", value: "alpha" });
    expect(readIdempotencyKeyHeader("alpha", [] as string[])).toEqual({
      kind: "key",
      value: "alpha",
    });
  });

  it("rejects Node's comma-space joined form of a duplicated header", () => {
    // Node joins duplicate non-set-cookie headers with ", ". The space alone
    // makes that form invalid even when rawHeaders is unavailable.
    expect(readIdempotencyKeyHeader("alpha, bravo")).toEqual({ kind: "invalid" });
  });

  it("exposes the canonical lowercase header name Fastify/Node use", () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe("idempotency-key");
  });

  it("never reflects the submitted value in a rejection", () => {
    const rejection = readIdempotencyKeyHeader("secret value with space");
    expect(rejection).toEqual({ kind: "invalid" });
    expect(JSON.stringify(rejection)).not.toContain("secret");
  });
});
