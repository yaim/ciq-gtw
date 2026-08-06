import { describe, expect, it } from "vitest";
import {
  classifyTransportFailure,
  UpstreamError,
  upstreamErrorForStatus,
} from "../../src/collectiviq/errors.js";
import { sanitizeLogValue } from "../../src/shared/redaction.js";

describe("upstream error model", () => {
  it("maps statuses to the documented categories", () => {
    expect(upstreamErrorForStatus(401).category).toBe("authentication");
    expect(upstreamErrorForStatus(403).category).toBe("authentication");
    expect(upstreamErrorForStatus(429).category).toBe("quota");
    expect(upstreamErrorForStatus(400).category).toBe("validation");
    expect(upstreamErrorForStatus(422).category).toBe("validation");
    expect(upstreamErrorForStatus(502).category).toBe("transient_http");
    expect(upstreamErrorForStatus(503).category).toBe("transient_http");
    expect(upstreamErrorForStatus(504).category).toBe("transient_http");
    expect(upstreamErrorForStatus(500).category).toBe("unexpected_upstream");
    expect(upstreamErrorForStatus(404).category).toBe("unexpected_upstream");
  });

  it("classifies transport failures deterministically", () => {
    expect(classifyTransportFailure({ cancelled: true, timedOut: false }).category).toBe(
      "cancellation",
    );
    expect(classifyTransportFailure({ cancelled: false, timedOut: true }).category).toBe("timeout");
    expect(classifyTransportFailure({ cancelled: false, timedOut: false }).category).toBe(
      "network",
    );
    // Cancellation takes precedence over a coincident deadline.
    expect(classifyTransportFailure({ cancelled: true, timedOut: true }).category).toBe(
      "cancellation",
    );
  });

  it("marks retryable only for idempotent GET network/transient failures", () => {
    // GET: network and selected transient statuses are retryable.
    expect(new UpstreamError("network", undefined, "GET").retryable).toBe(true);
    expect(new UpstreamError("transient_http", 503, "GET").retryable).toBe(true);
    expect(upstreamErrorForStatus(503, "GET").retryable).toBe(true);
    expect(
      classifyTransportFailure({ cancelled: false, timedOut: false, method: "GET" }).retryable,
    ).toBe(true);
    // GET timeout is not retryable (ambiguous whether work started).
    expect(new UpstreamError("timeout", undefined, "GET").retryable).toBe(false);

    // POST/DELETE: never retryable, even for network/transient failures.
    expect(new UpstreamError("network", undefined, "POST").retryable).toBe(false);
    expect(new UpstreamError("transient_http", 503, "POST").retryable).toBe(false);
    expect(upstreamErrorForStatus(503, "POST").retryable).toBe(false);
    expect(new UpstreamError("network", undefined, "DELETE").retryable).toBe(false);
    expect(
      classifyTransportFailure({ cancelled: false, timedOut: false, method: "DELETE" }).retryable,
    ).toBe(false);

    // Unknown method (a local guard, not a transport failure) is non-retryable.
    expect(new UpstreamError("network").retryable).toBe(false);
    expect(new UpstreamError("transient_http", 503).retryable).toBe(false);
  });

  it("exposes only name and safe code once passed through the log sanitizer", () => {
    const error = new UpstreamError("authentication", 401);
    const sanitized = sanitizeLogValue(error);
    // The sanitizer reduces any Error to name + allowlisted code only. Category,
    // rawStatus, retryability, and the message never appear.
    expect(sanitized).toEqual({ name: "Error", code: "upstream_authentication_failed" });
    expect(Object.keys(sanitized as object).sort()).toEqual(["code", "name"]);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("401");
    expect(serialized).not.toContain("Upstream authentication failed");
  });
});
