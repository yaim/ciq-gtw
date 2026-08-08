import { describe, expect, it } from "vitest";
import {
  isSecretKey,
  REDACTION_PLACEHOLDER,
  SANITIZE_LIMITS,
  SANITIZE_MARKERS,
  sanitizeLogValue,
} from "../../src/shared/redaction.js";

describe("sanitizeLogValue", () => {
  it("redacts credential-named fields at arbitrary nesting", () => {
    const result = sanitizeLogValue({
      a: { b: { c: { apiKey: "sk-deep", authorization: "Bearer x" } } },
      ok: "keep",
    }) as { a: { b: { c: Record<string, string> } }; ok: string };
    expect(result.a.b.c["apiKey"]).toBe(REDACTION_PLACEHOLDER);
    expect(result.a.b.c["authorization"]).toBe(REDACTION_PLACEHOLDER);
    expect(result.ok).toBe("keep");
  });

  it("traverses arrays and redacts nested credentials", () => {
    const result = sanitizeLogValue({ items: [{ token: "t" }, { safe: 1 }] }) as {
      items: Array<Record<string, unknown>>;
    };
    expect(result.items[0]?.["token"]).toBe(REDACTION_PLACEHOLDER);
    expect(result.items[1]?.["safe"]).toBe(1);
  });

  it("reduces errors to the fixed name plus allowlisted code, without message/stack/cause", () => {
    // The name is always the fixed literal "Error" (never constructor-derived).
    const error = Object.assign(new TypeError("boom /Users/secret/path"), {
      code: "E_SAFE",
      apiKey: "sk-should-not-leak",
    });
    (error as { cause?: unknown }).cause = new Error("secret-cause");
    const result = sanitizeLogValue(error) as Record<string, unknown>;
    expect(result).toEqual({ name: "Error", code: "E_SAFE" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("boom");
    expect(serialized).not.toContain("secret-cause");
    expect(serialized).not.toContain("sk-should-not-leak");
    expect(serialized).not.toContain("/Users/secret/path");
  });

  it("never reads a throwing Error constructor accessor", () => {
    const error = new Error("error sentinel");
    let invoked = false;
    Object.defineProperty(error, "constructor", {
      configurable: true,
      get() {
        invoked = true;
        throw new Error("constructor getter sentinel");
      },
    });
    const result = sanitizeLogValue(error) as Record<string, unknown>;
    expect(invoked).toBe(false);
    expect(result).toEqual({ name: "Error" });
    expect(JSON.stringify(result)).not.toContain("constructor getter sentinel");
  });

  it("preserves an allowlisted Error code supplied as a data property", () => {
    const error = Object.assign(new Error("x"), { code: "E_THING" });
    expect(sanitizeLogValue(error)).toEqual({ name: "Error", code: "E_THING" });
  });

  it("never invokes an accessor at array index 0", () => {
    const array: unknown[] = [];
    let invoked = false;
    Object.defineProperty(array, "0", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        throw new Error("array getter sentinel");
      },
    });
    const result = sanitizeLogValue(array) as unknown[];
    expect(invoked).toBe(false);
    expect(result[0]).toBe(SANITIZE_MARKERS.unsupported);
  });

  it("does not throw on circular structures", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    const result = sanitizeLogValue(cyclic) as Record<string, unknown>;
    expect(result["name"]).toBe("root");
    expect(result["self"]).toBe(SANITIZE_MARKERS.circular);
  });

  it("does not invoke accessors", () => {
    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "danger", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter invoked");
      },
    });
    const result = sanitizeLogValue({ hostile }) as { hostile: Record<string, unknown> };
    expect(invoked).toBe(false);
    expect(result.hostile["danger"]).toBe(SANITIZE_MARKERS.unsupported);
  });

  it("replaces unsupported custom objects with a fixed marker", () => {
    const result = sanitizeLogValue({
      map: new Map([["k", "v"]]),
      when: new Date(0),
    }) as Record<string, unknown>;
    expect(result["map"]).toBe(SANITIZE_MARKERS.unsupported);
    expect(result["when"]).toBe(SANITIZE_MARKERS.unsupported);
  });

  it("bounds traversal depth", () => {
    let node: Record<string, unknown> = { leaf: "deep-secret-leaf" };
    for (let i = 0; i < 12; i += 1) node = { child: node };
    const serialized = JSON.stringify(sanitizeLogValue(node));
    expect(serialized).toContain(SANITIZE_MARKERS.depthExceeded);
    expect(serialized).not.toContain("deep-secret-leaf");
  });

  it("bounds object property count", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 150; i += 1) wide[`k${i}`] = i;
    const result = sanitizeLogValue(wide) as Record<string, unknown>;
    expect(Object.keys(result).length).toBeLessThanOrEqual(SANITIZE_LIMITS.maxProperties + 1);
    expect(result["__truncated__"]).toBe(SANITIZE_MARKERS.truncated);
  });

  it("bounds array length", () => {
    const long = Array.from({ length: 150 }, (_v, i) => i);
    const result = sanitizeLogValue(long) as unknown[];
    expect(result.length).toBe(SANITIZE_LIMITS.maxArrayItems + 1);
    expect(result[result.length - 1]).toBe(SANITIZE_MARKERS.truncated);
  });

  it("bounds string length", () => {
    const huge = "x".repeat(5000);
    const result = sanitizeLogValue({ big: huge }) as { big: string };
    expect(result.big.length).toBeLessThan(huge.length);
    expect(result.big.startsWith("x".repeat(SANITIZE_LIMITS.maxStringLength))).toBe(true);
    expect(result.big.endsWith(SANITIZE_MARKERS.truncated)).toBe(true);
  });

  it("keeps ordinary safe metadata usable", () => {
    const input = {
      requestId: "req-9",
      status: 200,
      durationMs: 12,
      tokenCount: 42,
      nested: { ok: true },
    };
    expect(sanitizeLogValue(input)).toEqual(input);
  });

  it("classifies credential keys but not innocent metadata", () => {
    expect(isSecretKey("authorization")).toBe(true);
    expect(isSecretKey("COLLECTIVIQ_GATEWAY_KEYS")).toBe(true);
    expect(isSecretKey("apiKey")).toBe(true);
    expect(isSecretKey("password")).toBe(true);
    expect(isSecretKey("requestId")).toBe(false);
    expect(isSecretKey("tokenCount")).toBe(false);
    expect(isSecretKey("status")).toBe(false);
  });

  it("classifies token-suffix keys as secret but not token usage metadata", () => {
    for (const key of [
      "authToken",
      "access_token",
      "refreshToken",
      "bearerToken",
      "idToken",
      "sessionToken",
      "token",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ["tokenCount", "inputTokens", "outputTokens", "totalTokens"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it("classifies OAuth password-mode identity and login-token keys as secret", () => {
    for (const key of [
      "username",
      "user_name",
      "COLLECTIVIQ_USERNAME",
      "email",
      "userEmail",
      "COLLECTIVIQ_PASSWORD",
      "access_token",
      "refresh_token",
      "accessToken",
      "refreshToken",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
    // Innocent metadata that must NOT be caught by the identity markers. The
    // constant `token_type` ("Bearer") is not a credential and stays usable.
    for (const key of ["requestId", "status", "userId", "userCount", "durationMs", "token_type"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it("redacts a nested login request/response object without leaking any value", () => {
    const result = sanitizeLogValue({
      loginRequest: {
        grant_type: "password",
        username: "SENTINEL-USERNAME",
        password: "SENTINEL-PASSWORD",
        scope: "",
      },
      loginResponse: {
        access_token: "SENTINEL-ACCESS-TOKEN",
        token_type: "Bearer",
        refresh_token: "SENTINEL-REFRESH-TOKEN",
      },
      headers: { authorization: "Bearer SENTINEL-BEARER" },
    }) as {
      loginRequest: Record<string, unknown>;
      loginResponse: Record<string, unknown>;
      headers: Record<string, unknown>;
    };
    expect(result.loginRequest["username"]).toBe(REDACTION_PLACEHOLDER);
    expect(result.loginRequest["password"]).toBe(REDACTION_PLACEHOLDER);
    // grant_type/scope carry no secret and stay usable.
    expect(result.loginRequest["grant_type"]).toBe("password");
    expect(result.loginRequest["scope"]).toBe("");
    expect(result.loginResponse["access_token"]).toBe(REDACTION_PLACEHOLDER);
    expect(result.loginResponse["refresh_token"]).toBe(REDACTION_PLACEHOLDER);
    // token_type is the non-secret constant "Bearer" and stays usable.
    expect(result.loginResponse["token_type"]).toBe("Bearer");
    expect(result.headers["authorization"]).toBe(REDACTION_PLACEHOLDER);

    const serialized = JSON.stringify(result);
    for (const sentinel of [
      "SENTINEL-USERNAME",
      "SENTINEL-PASSWORD",
      "SENTINEL-ACCESS-TOKEN",
      "SENTINEL-REFRESH-TOKEN",
      "SENTINEL-BEARER",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("redacts login credentials nested inside hostile arrays and error values", () => {
    const result = sanitizeLogValue({
      attempts: [
        { username: "SENTINEL-U1", note: "ok" },
        [{ password: "SENTINEL-P1" }, { access_token: "SENTINEL-T1" }],
      ],
      failure: Object.assign(new Error("boom"), {
        code: "E_AUTH",
        password: "SENTINEL-P2",
      }),
    });
    const serialized = JSON.stringify(result);
    for (const sentinel of ["SENTINEL-U1", "SENTINEL-P1", "SENTINEL-T1", "SENTINEL-P2", "boom"]) {
      expect(serialized).not.toContain(sentinel);
    }
    // The error still reduces to its fixed, allowlisted shape.
    expect(serialized).toContain("E_AUTH");
  });
});
