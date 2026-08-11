import { describe, expect, it, vi } from "vitest";
import { timingSafeEqual } from "node:crypto";
import {
  PRESENTED_TOKEN_MAX_BYTES,
  createGatewayAuthenticator,
} from "../../src/api/gateway-auth.js";

const KEY_A = "gw-fake-key-alpha";
const KEY_B = "gw-fake-key-bravo-longer-than-alpha";

describe("createGatewayAuthenticator", () => {
  it("accepts every configured key with a case-insensitive scheme", () => {
    const auth = createGatewayAuthenticator([KEY_A, KEY_B]);
    expect(auth.authenticate(`Bearer ${KEY_A}`)).toBe(true);
    expect(auth.authenticate(`Bearer ${KEY_B}`)).toBe(true);
    expect(auth.authenticate(`bearer ${KEY_A}`)).toBe(true);
    expect(auth.authenticate(`BEARER ${KEY_A}`)).toBe(true);
    expect(auth.authenticate(`BeArEr ${KEY_B}`)).toBe(true);
  });

  it("rejects missing, malformed, empty, wrong-scheme, and wrong tokens alike", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    expect(auth.authenticate(undefined)).toBe(false); // missing header
    expect(auth.authenticate("")).toBe(false); // empty header
    expect(auth.authenticate(KEY_A)).toBe(false); // no scheme separator
    expect(auth.authenticate("Bearer")).toBe(false); // scheme only, no token
    expect(auth.authenticate("Bearer ")).toBe(false); // empty token
    expect(auth.authenticate("Basic " + KEY_A)).toBe(false); // wrong scheme
    expect(auth.authenticate("Token " + KEY_A)).toBe(false); // wrong scheme
    expect(auth.authenticate("Bearer gw-wrong-key")).toBe(false); // wrong token
  });

  it("compares the token exactly, rejecting any extra whitespace", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    // Only the first space delimits the scheme; further whitespace is part of
    // the token and must not match the exact configured key.
    expect(auth.authenticate(`Bearer  ${KEY_A}`)).toBe(false); // leading space
    expect(auth.authenticate(`Bearer ${KEY_A} `)).toBe(false); // trailing space
    expect(auth.authenticate(`Bearer ${KEY_A}\t`)).toBe(false); // trailing tab
    expect(auth.authenticate(`Bearer ${KEY_A.toUpperCase()}`)).toBe(false); // wrong case token
  });

  it("rejects an oversized presented token before it can match", () => {
    const auth = createGatewayAuthenticator([KEY_A]);
    const oversized = "a".repeat(PRESENTED_TOKEN_MAX_BYTES + 1);
    expect(auth.authenticate(`Bearer ${oversized}`)).toBe(false);
    // A token exactly at the cap is allowed to be compared (still wrong here).
    const atCap = "a".repeat(PRESENTED_TOKEN_MAX_BYTES);
    expect(auth.authenticate(`Bearer ${atCap}`)).toBe(false);
  });

  it("authenticates keys regardless of differing lengths", () => {
    const short = "g";
    const long = "gw-" + "z".repeat(500);
    const auth = createGatewayAuthenticator([short, long]);
    expect(auth.authenticate(`Bearer ${short}`)).toBe(true);
    expect(auth.authenticate(`Bearer ${long}`)).toBe(true);
    expect(auth.authenticate(`Bearer gw-${"z".repeat(499)}`)).toBe(false);
  });

  it("does not short-circuit the comparison loop when a key matches", () => {
    // A spy comparator (over SHA-256 digests, never raw keys) proves every
    // configured key is compared even though the FIRST one matches.
    const compare = vi.fn((a: Buffer, b: Buffer) => timingSafeEqual(a, b));
    const auth = createGatewayAuthenticator([KEY_A, KEY_B], compare);
    expect(auth.authenticate(`Bearer ${KEY_A}`)).toBe(true);
    expect(compare).toHaveBeenCalledTimes(2);
    // The comparator only ever sees 32-byte digests, not key material.
    for (const call of compare.mock.calls) {
      expect(call[0]).toHaveLength(32);
      expect(call[1]).toHaveLength(32);
    }
  });

  it("never returns the presented token or a configured key", () => {
    // The interface exposes only a boolean; there is no path that surfaces
    // secret material. This guards against an accidental API widening.
    const auth = createGatewayAuthenticator([KEY_A]);
    const result = auth.authenticate(`Bearer ${KEY_A}`);
    expect(typeof result).toBe("boolean");
  });
});
