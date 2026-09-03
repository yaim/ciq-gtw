import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { ConfigError, loadConfig } from "../../src/config/load.js";
import {
  MODEL_CONFIG_LIMITS,
  TRACING_LIMITS,
  type VirtualModelDefinition,
} from "../../src/config/schema.js";

const EXAMPLE_MODELS = resolve(process.cwd(), "config/models.example.yaml");

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ciq-cfg-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a model file and return its absolute path. */
function writeModelFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const validModel: VirtualModelDefinition = {
  displayName: "Test Model",
  selectedLlms: ["gpt", "claude"],
  generateCombined: true,
  answerSource: "combined",
  toolMode: "disabled",
  requestTimeoutMs: 90_000,
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 5_000,
  maximumPromptBytes: 2_048,
};

function modelFileFrom(overrides: Partial<VirtualModelDefinition>): string {
  return stringify({ models: { m1: { ...validModel, ...overrides } } });
}

/** A single-model file keyed by an arbitrary (possibly hostile) id. */
function modelFileWithId(id: string, overrides: Partial<VirtualModelDefinition> = {}): string {
  return stringify({ models: { [id]: { ...validModel, ...overrides } } });
}

/** Build a minimal, entirely fake environment; unknown keys are ignored. */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    COLLECTIVIQ_API_KEY: "sk-fake-upstream-000",
    COLLECTIVIQ_GATEWAY_KEYS: "gw-fake-a, gw-fake-b, gw-fake-a",
    MODEL_CONFIG_PATH: EXAMPLE_MODELS,
    ...overrides,
  };
}

function expectReject(path: string): void {
  expect(() => loadConfig({ env: baseEnv({ MODEL_CONFIG_PATH: path }) })).toThrow(ConfigError);
}

function expectLoads(path: string): ReturnType<typeof loadConfig> {
  return loadConfig({ env: baseEnv({ MODEL_CONFIG_PATH: path }) });
}

describe("loadConfig — environment", () => {
  it("loads a valid fake environment and the example model file", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(8787);
    expect(config.LOG_CONTENT).toBe(false);
    expect(config.ENVIRONMENT).toBe("production");
    expect(config.COLLECTIVIQ_GATEWAY_KEYS).toEqual(["gw-fake-a", "gw-fake-b"]);
    expect(config.models).toHaveLength(6);
    expect(config.models.map((m) => m.id)).toContain("collectiviq-fast");
    // The opt-in beta emulated tool model opts into tool mode (protocol prompt).
    expect(config.models.find((m) => m.id === "collectiviq-claude-tools")).toMatchObject({
      selectedLlms: ["claude"],
      answerSource: "claude",
      toolMode: "emulated",
      promptMode: "protocol",
    });
    expect(config.models.find((m) => m.id === "collectiviq-claude")).toMatchObject({
      selectedLlms: ["claude"],
      generateCombined: false,
      answerSource: "claude",
      toolMode: "disabled",
      // An explicit `promptMode: protocol` in the example loads as protocol.
      promptMode: "protocol",
    });
    // The example now includes the direct profile with its exact intended policy.
    expect(config.models.find((m) => m.id === "collectiviq-claude-direct")).toMatchObject({
      displayName: "CollectivIQ Claude Direct",
      selectedLlms: ["claude"],
      generateCombined: false,
      answerSource: "claude",
      toolMode: "disabled",
      promptMode: "direct",
    });
  });

  it("preserves safe defaults (loopback, content logging off)", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.LOG_CONTENT).toBe(false);
    expect(config.MAX_REQUEST_BODY_BYTES).toBe(8_388_608);
  });

  it("returns an immutable configuration", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.models)).toBe(true);
    expect(() => {
      (config as { PORT: number }).PORT = 1;
    }).toThrow();
  });

  it("fails when required secrets are missing", () => {
    expect(() => loadConfig({ env: baseEnv({ COLLECTIVIQ_API_KEY: undefined }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ COLLECTIVIQ_GATEWAY_KEYS: undefined }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ COLLECTIVIQ_GATEWAY_KEYS: "  , ," }) })).toThrow(
      ConfigError,
    );
  });

  it("rejects a malformed URL, port, boolean, and byte limit", () => {
    expect(() => loadConfig({ env: baseEnv({ COLLECTIVIQ_BASE_URL: "not-a-url" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ PORT: "not-an-int" }) })).toThrow(ConfigError);
    expect(() => loadConfig({ env: baseEnv({ PORT: "70000" }) })).toThrow(ConfigError);
    expect(() => loadConfig({ env: baseEnv({ LOG_CONTENT: "maybe" }) })).toThrow(ConfigError);
    expect(() => loadConfig({ env: baseEnv({ MAX_REQUEST_BODY_BYTES: "huge" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ MAX_REQUEST_BODY_BYTES: "10" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ ENVIRONMENT: "prod" }) })).toThrow(ConfigError);
    expect(() => loadConfig({ env: baseEnv({ LOG_LEVEL: "verbose" }) })).toThrow(ConfigError);
  });

  it("never echoes secret-bearing invalid values in errors", () => {
    const leak = "sk-DO-NOT-LEAK-123";
    const gwLeak = "gw-DO-NOT-LEAK-456";
    try {
      loadConfig({
        env: baseEnv({ COLLECTIVIQ_API_KEY: leak, COLLECTIVIQ_GATEWAY_KEYS: gwLeak, PORT: "x" }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      const serialized = `${configError.format()} ${JSON.stringify(configError.issues)}`;
      expect(serialized).not.toContain(leak);
      expect(serialized).not.toContain(gwLeak);
      expect(serialized).toContain("PORT");
    }
  });

  it("rejects LOG_CONTENT=true outside development", () => {
    expect(() => loadConfig({ env: baseEnv({ LOG_CONTENT: "true" }) })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ env: baseEnv({ LOG_CONTENT: "true", ENVIRONMENT: "staging" }) }),
    ).toThrow(ConfigError);
  });

  it("allows LOG_CONTENT=true in development", () => {
    const config = loadConfig({
      env: baseEnv({ LOG_CONTENT: "true", ENVIRONMENT: "development" }),
    });
    expect(config.LOG_CONTENT).toBe(true);
    expect(config.ENVIRONMENT).toBe("development");
  });
});

describe("loadConfig — capacity and shutdown", () => {
  it("applies conservative defaults", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.MAX_CONCURRENT_REQUESTS).toBe(4);
    expect(config.MAX_CONCURRENT_REQUESTS_PER_KEY).toBe(2);
    expect(config.MAX_QUEUED_REQUESTS).toBe(20);
    expect(config.MAX_QUEUE_WAIT_MS).toBe(5_000);
    expect(config.SHUTDOWN_DRAIN_MS).toBe(30_000);
  });

  it("accepts valid overrides, including a zero-length queue", () => {
    const config = loadConfig({
      env: baseEnv({
        MAX_CONCURRENT_REQUESTS: "8",
        MAX_CONCURRENT_REQUESTS_PER_KEY: "8",
        MAX_QUEUED_REQUESTS: "0",
        MAX_QUEUE_WAIT_MS: "1000",
        SHUTDOWN_DRAIN_MS: "0",
      }),
    });
    expect(config.MAX_CONCURRENT_REQUESTS).toBe(8);
    expect(config.MAX_QUEUED_REQUESTS).toBe(0);
    expect(config.SHUTDOWN_DRAIN_MS).toBe(0);
  });

  it("rejects non-integer and out-of-range capacity values", () => {
    expect(() => loadConfig({ env: baseEnv({ MAX_CONCURRENT_REQUESTS: "x" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ MAX_CONCURRENT_REQUESTS: "0" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: baseEnv({ MAX_QUEUE_WAIT_MS: "0" }) })).toThrow(ConfigError);
    expect(() => loadConfig({ env: baseEnv({ MAX_QUEUED_REQUESTS: "-1" }) })).toThrow(ConfigError);
  });

  it("rejects a per-key limit greater than the global limit", () => {
    try {
      loadConfig({
        env: baseEnv({ MAX_CONCURRENT_REQUESTS: "2", MAX_CONCURRENT_REQUESTS_PER_KEY: "4" }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const fields = (error as ConfigError).issues.map((i) => i.field);
      expect(fields).toContain("MAX_CONCURRENT_REQUESTS_PER_KEY");
    }
  });
});

describe("loadConfig — optional Redis idempotency", () => {
  const VALID_KEY = randomBytes(32).toString("base64url");

  /** The value-free issues raised by a given environment. */
  function issuesFor(overrides: Record<string, string | undefined>): ConfigError["issues"] {
    try {
      loadConfig({ env: baseEnv(overrides) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
  }

  it("disables Redis when REDIS_URL is absent or blank", () => {
    for (const REDIS_URL of [undefined, "", "   "]) {
      const config = loadConfig({ env: baseEnv({ REDIS_URL }) });
      expect(config.REDIS_URL).toBeUndefined();
      // The encryption key is not required while Redis is disabled.
      expect(config.IDEMPOTENCY_ENCRYPTION_KEY).toBeUndefined();
      // The TTL and namespace always carry their validated defaults.
      expect(config.IDEMPOTENCY_TTL_MS).toBe(600_000);
      expect(config.REDIS_KEY_PREFIX).toBe("collectiviq-gateway");
    }
  });

  it("accepts canonical redis:// and rediss:// URLs", () => {
    for (const url of [
      "redis://127.0.0.1:6379",
      "redis://redis:6379",
      "rediss://cache.example.internal:6380",
      "redis://cache:6379/0",
      "redis://user:p%40ss@cache:6379",
      "redis://[::1]:6379",
    ]) {
      const config = loadConfig({
        env: baseEnv({ REDIS_URL: url, IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY }),
      });
      expect(config.REDIS_URL).toBe(url);
    }
  });

  it("rejects a non-canonical or unsupported Redis URL", () => {
    for (const url of [
      "REDIS://cache:6379", // non-canonical scheme casing
      "http://cache:6379",
      "https://cache:6379",
      "rediss//cache:6379",
      "cache:6379",
      "redis://", // no host
      "redis://cache:6379?db=1", // query rejected
      "redis://cache:6379#frag", // fragment rejected
      "not a url",
    ]) {
      const issues = issuesFor({ REDIS_URL: url, IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY });
      expect(issues).toContainEqual({
        field: "REDIS_URL",
        reason: "must be a canonical redis:// or rediss:// URL",
      });
      // The submitted URL is never echoed (it may embed credentials).
      expect(JSON.stringify(issues)).not.toContain("cache");
    }
  });

  it("requires the encryption key whenever Redis is enabled", () => {
    expect(issuesFor({ REDIS_URL: "redis://127.0.0.1:6379" })).toContainEqual({
      field: "IDEMPOTENCY_ENCRYPTION_KEY",
      reason: "is required",
    });
  });

  it("accepts exactly 32 bytes of canonical unpadded base64url", () => {
    const config = loadConfig({
      env: baseEnv({ REDIS_URL: "redis://127.0.0.1:6379", IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY }),
    });
    expect(config.IDEMPOTENCY_ENCRYPTION_KEY).toBe(VALID_KEY);
  });

  it("rejects a wrongly sized, padded, non-canonical, or wrong-alphabet key", () => {
    const padded = `${Buffer.from(randomBytes(32)).toString("base64")}`; // standard base64 + "="
    // 43 base64url characters whose final character carries non-zero trailing
    // bits: it decodes to 32 bytes but is NOT the canonical encoding of them.
    const nonCanonical = `${"A".repeat(42)}B`;
    for (const key of [
      randomBytes(16).toString("base64url"),
      randomBytes(64).toString("base64url"),
      padded,
      nonCanonical,
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}/`,
      `  ${VALID_KEY}  `,
    ]) {
      const issues = issuesFor({
        REDIS_URL: "redis://127.0.0.1:6379",
        IDEMPOTENCY_ENCRYPTION_KEY: key,
      });
      expect(issues).toContainEqual({
        field: "IDEMPOTENCY_ENCRYPTION_KEY",
        reason: "must be 32 bytes encoded as canonical unpadded base64url",
      });
      expect(JSON.stringify(issues)).not.toContain(key.trim().slice(0, 8));
    }
  });

  it("treats a whitespace-only encryption key as absent", () => {
    // Blank means "not set", so with Redis enabled it is a required-field issue
    // rather than a format issue.
    expect(
      issuesFor({ REDIS_URL: "redis://127.0.0.1:6379", IDEMPOTENCY_ENCRYPTION_KEY: "   " }),
    ).toContainEqual({ field: "IDEMPOTENCY_ENCRYPTION_KEY", reason: "is required" });
  });

  it("enforces the TTL bounds", () => {
    const at = (value: string): number =>
      loadConfig({ env: baseEnv({ IDEMPOTENCY_TTL_MS: value }) }).IDEMPOTENCY_TTL_MS;
    expect(at("60000")).toBe(60_000);
    expect(at("3600000")).toBe(3_600_000);
    for (const value of ["59999", "3600001", "0", "-1", "abc", "1.5"]) {
      expect(() => loadConfig({ env: baseEnv({ IDEMPOTENCY_TTL_MS: value }) })).toThrow(
        ConfigError,
      );
    }
  });

  it("enforces the key-prefix bounds and alphabet", () => {
    for (const prefix of ["a", "collectiviq-gateway", "A_b-9", "x".repeat(64)]) {
      expect(loadConfig({ env: baseEnv({ REDIS_KEY_PREFIX: prefix }) }).REDIS_KEY_PREFIX).toBe(
        prefix,
      );
    }
    for (const prefix of ["has space", "has:colon", "has.dot", "café", "%"]) {
      expect(issuesFor({ REDIS_KEY_PREFIX: prefix })).toContainEqual({
        field: "REDIS_KEY_PREFIX",
        reason: "has unsupported value",
      });
    }
    // An over-long but otherwise well-formed prefix is a bounds issue.
    expect(issuesFor({ REDIS_KEY_PREFIX: "x".repeat(65) })).toContainEqual({
      field: "REDIS_KEY_PREFIX",
      reason: "length is outside allowed bounds",
    });
  });

  it("requires the TTL to cover the largest model requestTimeoutMs", () => {
    // A TTL shorter than a model's own deadline means a client retrying after
    // its attempt timed out finds nothing cached and silently pays for a
    // duplicate upstream completion. The example catalog uses 90 s deadlines.
    const redis = {
      REDIS_URL: "redis://127.0.0.1:6379",
      IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY,
    };
    expect(
      loadConfig({ env: baseEnv({ ...redis, IDEMPOTENCY_TTL_MS: "90000" }) }).IDEMPOTENCY_TTL_MS,
    ).toBe(90_000);
    expect(issuesFor({ ...redis, IDEMPOTENCY_TTL_MS: "60000" })).toContainEqual({
      field: "IDEMPOTENCY_TTL_MS",
      reason: "must not be less than the largest model requestTimeoutMs",
    });
    // The check applies only when Redis is enabled.
    expect(loadConfig({ env: baseEnv({ IDEMPOTENCY_TTL_MS: "60000" }) }).IDEMPOTENCY_TTL_MS).toBe(
      60_000,
    );
  });

  it("never echoes the Redis URL or the encryption key in a formatted error", () => {
    const secretUrl = "redis://admin:SUPERSECRET@cache.example:6379";
    try {
      loadConfig({
        env: baseEnv({ REDIS_URL: `${secretUrl}?x=1`, IDEMPOTENCY_ENCRYPTION_KEY: "SENSITIVE" }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      const formatted = (error as ConfigError).format();
      expect(formatted).not.toContain("SUPERSECRET");
      expect(formatted).not.toContain("SENSITIVE");
      expect(formatted).not.toContain("cache.example");
    }
  });
});

describe("loadConfig — optional cross-replica rate limiting", () => {
  const VALID_KEY = randomBytes(32).toString("base64url");
  /** The Redis settings that make enabling the limiter valid. */
  const REDIS = {
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY,
  } as const;

  function issuesFor(overrides: Record<string, string | undefined>): ConfigError["issues"] {
    try {
      loadConfig({ env: baseEnv(overrides) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
  }

  it("is DISABLED by default, with the documented defaults still validated", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.RATE_LIMIT_ENABLED).toBe(false);
    expect(config.RATE_LIMIT_REQUESTS).toBe(60);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(config.RATE_LIMIT_BURST).toBe(8);
  });

  it("accepts only the strict boolean syntax", () => {
    expect(loadConfig({ env: baseEnv({ RATE_LIMIT_ENABLED: "false" }) }).RATE_LIMIT_ENABLED).toBe(
      false,
    );
    expect(
      loadConfig({ env: baseEnv({ ...REDIS, RATE_LIMIT_ENABLED: "true" }) }).RATE_LIMIT_ENABLED,
    ).toBe(true);
    // Surrounding whitespace and case are tolerated exactly as for LOG_CONTENT.
    expect(
      loadConfig({ env: baseEnv({ ...REDIS, RATE_LIMIT_ENABLED: " TRUE " }) }).RATE_LIMIT_ENABLED,
    ).toBe(true);
    for (const value of ["1", "0", "yes", "no", "on", "enabled", "maybe"]) {
      expect(issuesFor({ ...REDIS, RATE_LIMIT_ENABLED: value })).toContainEqual({
        field: "RATE_LIMIT_ENABLED",
        reason: 'must be "true" or "false"',
      });
    }
  });

  it("REQUIRES a Redis endpoint when explicitly enabled", () => {
    // A shared quota cannot be enforced from process-local state, so enabling
    // it without Redis is an error rather than a silent downgrade.
    expect(issuesFor({ RATE_LIMIT_ENABLED: "true" })).toContainEqual({
      field: "REDIS_URL",
      reason: "is required when RATE_LIMIT_ENABLED is true",
    });
    for (const REDIS_URL of ["", "   "]) {
      expect(issuesFor({ RATE_LIMIT_ENABLED: "true", REDIS_URL })).toContainEqual({
        field: "REDIS_URL",
        reason: "is required when RATE_LIMIT_ENABLED is true",
      });
    }
  });

  it("does not double-report a Redis URL that was supplied but rejected", () => {
    const issues = issuesFor({ RATE_LIMIT_ENABLED: "true", REDIS_URL: "http://nope" });
    expect(issues.filter((issue) => issue.field === "REDIS_URL")).toEqual([
      { field: "REDIS_URL", reason: "must be a canonical redis:// or rediss:// URL" },
    ]);
  });

  it("still requires the encryption key transitively when enabled", () => {
    // Enabling the limiter requires Redis, and Redis already requires the
    // master key the rate-limit subkey is derived from.
    expect(
      issuesFor({ RATE_LIMIT_ENABLED: "true", REDIS_URL: "redis://127.0.0.1:6379" }),
    ).toContainEqual({ field: "IDEMPOTENCY_ENCRYPTION_KEY", reason: "is required" });
  });

  it("does not require Redis while the feature stays disabled", () => {
    const config = loadConfig({
      env: baseEnv({ RATE_LIMIT_ENABLED: "false", RATE_LIMIT_REQUESTS: "10" }),
    });
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.RATE_LIMIT_REQUESTS).toBe(10);
  });

  it("enforces each numeric range", () => {
    for (const [field, invalid] of [
      ["RATE_LIMIT_REQUESTS", ["0", "-1", "100001"]],
      ["RATE_LIMIT_WINDOW_MS", ["0", "999", "3600001"]],
      ["RATE_LIMIT_BURST", ["0", "-1", "10001"]],
    ] as const) {
      for (const value of invalid) {
        expect(issuesFor({ [field]: value })).toContainEqual({
          field,
          reason: "is outside allowed range",
        });
      }
      expect(issuesFor({ [field]: "not-an-int" })).toContainEqual({
        field,
        reason: "must be an integer",
      });
    }
  });

  it("accepts each boundary value", () => {
    const config = loadConfig({
      env: baseEnv({
        RATE_LIMIT_REQUESTS: "100000",
        RATE_LIMIT_WINDOW_MS: "3600000",
        RATE_LIMIT_BURST: "10000",
      }),
    });
    expect(config.RATE_LIMIT_REQUESTS).toBe(100_000);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(3_600_000);
    expect(config.RATE_LIMIT_BURST).toBe(10_000);
    const minimal = loadConfig({
      env: baseEnv({
        RATE_LIMIT_REQUESTS: "1",
        RATE_LIMIT_WINDOW_MS: "1000",
        RATE_LIMIT_BURST: "1",
      }),
    });
    expect(minimal.RATE_LIMIT_BURST).toBe(1);
  });

  it("rejects a burst larger than the window budget", () => {
    // An immediate burst above the sustained budget would let one instant of
    // traffic exceed the very limit the window exists to enforce.
    expect(issuesFor({ RATE_LIMIT_REQUESTS: "10", RATE_LIMIT_BURST: "11" })).toContainEqual({
      field: "RATE_LIMIT_BURST",
      reason: "must not exceed RATE_LIMIT_REQUESTS",
    });
    // Exactly equal is allowed.
    expect(
      loadConfig({ env: baseEnv({ RATE_LIMIT_REQUESTS: "10", RATE_LIMIT_BURST: "10" }) })
        .RATE_LIMIT_BURST,
    ).toBe(10);
  });

  it("validates a PRESENT value even while the feature is disabled", () => {
    // A deployment must not be able to carry a silently broken setting that
    // only fails the day someone switches rate limiting on.
    expect(issuesFor({ RATE_LIMIT_ENABLED: "false", RATE_LIMIT_REQUESTS: "0" })).toContainEqual({
      field: "RATE_LIMIT_REQUESTS",
      reason: "is outside allowed range",
    });
    expect(issuesFor({ RATE_LIMIT_ENABLED: "false", RATE_LIMIT_BURST: "99" })).toContainEqual({
      field: "RATE_LIMIT_BURST",
      reason: "must not exceed RATE_LIMIT_REQUESTS",
    });
  });

  it("keeps every rate-limit failure value-free", () => {
    const issues = issuesFor({
      RATE_LIMIT_ENABLED: "SENSITIVE-VALUE",
      RATE_LIMIT_REQUESTS: "SENSITIVE-REQUESTS",
    });
    const formatted = new ConfigError(issues).format();
    expect(formatted).not.toContain("SENSITIVE-VALUE");
    expect(formatted).not.toContain("SENSITIVE-REQUESTS");
  });
});

describe("loadConfig — optional observability", () => {
  function issuesFor(overrides: Record<string, string | undefined>): ConfigError["issues"] {
    try {
      loadConfig({ env: baseEnv(overrides) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
  }

  it("leaves BOTH features disabled by default with a stable configuration shape", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.METRICS_ENABLED).toBe(false);
    expect(config.TRACING_ENABLED).toBe(false);
    expect(config.TRACING_OTLP_ENDPOINT).toBeUndefined();
    expect(config.TRACING_SAMPLE_RATIO).toBe(1);
  });

  it("accepts only the strict boolean syntax for both switches", () => {
    expect(loadConfig({ env: baseEnv({ METRICS_ENABLED: "true" }) }).METRICS_ENABLED).toBe(true);
    expect(loadConfig({ env: baseEnv({ METRICS_ENABLED: " TRUE " }) }).METRICS_ENABLED).toBe(true);
    for (const value of ["1", "0", "yes", "on", "enabled"]) {
      expect(issuesFor({ METRICS_ENABLED: value })).toContainEqual({
        field: "METRICS_ENABLED",
        reason: 'must be "true" or "false"',
      });
      expect(issuesFor({ TRACING_ENABLED: value })).toContainEqual({
        field: "TRACING_ENABLED",
        reason: 'must be "true" or "false"',
      });
    }
  });

  it("REQUIRES an OTLP endpoint when tracing is explicitly enabled", () => {
    // Tracing exports over OTLP/HTTP by definition; there is no local sink to
    // silently fall back to.
    expect(issuesFor({ TRACING_ENABLED: "true" })).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "is required when TRACING_ENABLED is true",
    });
    for (const TRACING_OTLP_ENDPOINT of ["", "   "]) {
      expect(issuesFor({ TRACING_ENABLED: "true", TRACING_OTLP_ENDPOINT })).toContainEqual({
        field: "TRACING_OTLP_ENDPOINT",
        reason: "is required when TRACING_ENABLED is true",
      });
    }
  });

  it("accepts only a canonical absolute http(s) endpoint", () => {
    const ok = loadConfig({
      env: baseEnv({
        TRACING_ENABLED: "true",
        TRACING_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      }),
    });
    expect(ok.TRACING_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318/v1/traces");
    expect(
      loadConfig({
        env: baseEnv({
          TRACING_ENABLED: "true",
          TRACING_OTLP_ENDPOINT: "https://collector.internal:4318/v1/traces",
        }),
      }).TRACING_OTLP_ENDPOINT,
    ).toBe("https://collector.internal:4318/v1/traces");

    for (const endpoint of [
      "redis://127.0.0.1:6379",
      "ftp://collector/v1/traces",
      "HTTP://127.0.0.1:4318/v1/traces", // non-canonical scheme casing
      "http://127.0.0.1:4318", // a bare origin does not round-trip
      "http://127.0.0.1:4318/v1/traces?tenant=a", // query rejected
      "http://127.0.0.1:4318/v1/traces#frag", // fragment rejected
      "http:///v1/traces", // no host
      "not-a-url",
    ]) {
      expect(issuesFor({ TRACING_OTLP_ENDPOINT: endpoint })).toContainEqual({
        field: "TRACING_OTLP_ENDPOINT",
        reason: "must be a canonical absolute http(s) URL",
      });
    }
  });

  it("validates a PRESENT endpoint even while tracing is disabled", () => {
    // The same rule the rate-limit and thread-reuse settings follow: a broken
    // value must fail at deploy time, not on the day the feature is enabled.
    expect(issuesFor({ TRACING_ENABLED: "false", TRACING_OTLP_ENDPOINT: "nope" })).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "must be a canonical absolute http(s) URL",
    });
  });

  it("rejects an endpoint embedding credentials, including percent-encoded userinfo", () => {
    // The gateway attaches no exporter authentication, so userinfo could never
    // authenticate anything — it would only park a secret in a setting that is
    // neither documented nor handled as one. Each of these parses, round-trips
    // byte-for-byte, and carries a real path, so the userinfo rule is the only
    // thing standing between them and acceptance.
    for (const endpoint of [
      "https://user@collector.internal/v1/traces",
      "https://user:pass@collector.internal/v1/traces",
      "https://us%65r:p%61ss@collector.internal/v1/traces",
      "http://user:pass@127.0.0.1:4318/v1/traces",
    ]) {
      for (const TRACING_ENABLED of ["true", "false"]) {
        expect(issuesFor({ TRACING_ENABLED, TRACING_OTLP_ENDPOINT: endpoint })).toContainEqual({
          field: "TRACING_OTLP_ENDPOINT",
          reason: "must not embed credentials",
        });
      }
    }
  });

  it("rejects a root-only endpoint", () => {
    // OTLP/HTTP posts spans to a traces path; a bare origin would send them to
    // the collector root.
    for (const endpoint of [
      "http://collector.internal/",
      "https://collector.internal/",
      "http://127.0.0.1:4318/",
    ]) {
      for (const TRACING_ENABLED of ["true", "false"]) {
        expect(issuesFor({ TRACING_ENABLED, TRACING_OTLP_ENDPOINT: endpoint })).toContainEqual({
          field: "TRACING_OTLP_ENDPOINT",
          reason: "must include a non-root path",
        });
      }
    }
  });

  it("rejects a trailing query or fragment delimiter even when its value is EMPTY", () => {
    // The WHATWG parser keeps a bare trailing `?`/`#` in `href` while reporting
    // an empty `search`/`hash`, so these round-trip byte-for-byte and neither the
    // emptiness check nor the canonical comparison sees anything wrong. The
    // delimiter itself has to be rejected, or an operator's endpoint would not
    // be the string the exporter is told to POST to.
    for (const endpoint of [
      "http://127.0.0.1:4318/v1/traces?",
      "http://127.0.0.1:4318/v1/traces#",
      "https://collector.internal/v1/traces?",
      "https://collector.internal/v1/traces#",
    ]) {
      // Guard against the day the parser changes: this case only means
      // something while the value really does survive both existing checks.
      const parsed = new URL(endpoint);
      expect(parsed.href).toBe(endpoint);
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");

      for (const TRACING_ENABLED of ["true", "false"]) {
        expect(issuesFor({ TRACING_ENABLED, TRACING_OTLP_ENDPOINT: endpoint })).toContainEqual({
          field: "TRACING_OTLP_ENDPOINT",
          reason: "must be a canonical absolute http(s) URL",
        });
      }
    }
  });

  it("reports embedded credentials ahead of a trailing delimiter", () => {
    // Precedence matters for the operator's sake: a value carrying BOTH faults
    // must still be reported as a credential, which is the actionable one.
    expect(
      issuesFor({ TRACING_OTLP_ENDPOINT: "https://user:pass@collector.internal/v1/traces?" }),
    ).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "must not embed credentials",
    });
  });

  it("accepts percent-encoded delimiter characters inside the path", () => {
    // `%3F` and `%23` are ordinary path data, not a query or fragment. Rejecting
    // the DELIMITER must not turn into rejecting encoded bytes that merely
    // decode to one.
    for (const endpoint of [
      "http://127.0.0.1:4318/v1/tr%3Faces",
      "http://127.0.0.1:4318/v1/tr%23aces",
      "https://collector.internal/otel/ingest%3Fv1",
    ]) {
      expect(
        loadConfig({ env: baseEnv({ TRACING_OTLP_ENDPOINT: endpoint }) }).TRACING_OTLP_ENDPOINT,
      ).toBe(endpoint);
    }
  });

  it("accepts any non-root path, including a custom collector route", () => {
    // Which path is deliberately NOT constrained: an operator may front a
    // collector on a route that is not `/v1/traces`.
    for (const endpoint of [
      "http://127.0.0.1:4318/v1/traces",
      "https://collector.internal:4318/v1/traces",
      "https://collector.internal/otel/ingest",
    ]) {
      for (const TRACING_ENABLED of ["true", "false"]) {
        expect(
          loadConfig({ env: baseEnv({ TRACING_ENABLED, TRACING_OTLP_ENDPOINT: endpoint }) })
            .TRACING_OTLP_ENDPOINT,
        ).toBe(endpoint);
      }
    }
  });

  it("rejects an over-bound endpoint on the BOUND, not on a parse failure", () => {
    // The oversized value below is a well-formed, canonical, non-root https URL:
    // size is its ONLY defect, so a length rejection proves the bound ran before
    // the parser rather than a parse failure standing in for it.
    const base = "https://collector.internal/";
    const oversized = base + "a".repeat(TRACING_LIMITS.endpointBytes);
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(TRACING_LIMITS.endpointBytes);

    const issues = issuesFor({ TRACING_OTLP_ENDPOINT: oversized });
    expect(issues).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "length is outside allowed bounds",
    });
    expect(issues).not.toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "must be a canonical absolute http(s) URL",
    });

    // The same URL cut to exactly the bound is accepted.
    const atBound = base + "a".repeat(TRACING_LIMITS.endpointBytes - base.length);
    expect(Buffer.byteLength(atBound, "utf8")).toBe(TRACING_LIMITS.endpointBytes);
    expect(
      loadConfig({ env: baseEnv({ TRACING_OTLP_ENDPOINT: atBound }) }).TRACING_OTLP_ENDPOINT,
    ).toBe(atBound);
  });

  it("measures the endpoint bound in UTF-8 bytes, not string length", () => {
    const base = "https://collector.internal/v1/traces/";
    // "é" costs two UTF-8 bytes, so byte count and string length diverge.
    const padChars = Math.floor((TRACING_LIMITS.endpointBytes - base.length) / 2);
    const underBound = base + "é".repeat(padChars);
    const overBound = base + "é".repeat(padChars + 1);

    expect(Buffer.byteLength(underBound, "utf8")).toBeLessThanOrEqual(TRACING_LIMITS.endpointBytes);
    expect(Buffer.byteLength(overBound, "utf8")).toBeGreaterThan(TRACING_LIMITS.endpointBytes);
    // Both string lengths stay well under the bound; only the byte count crosses
    // it, so a string-length check would let the oversized value through.
    expect(overBound.length).toBeLessThan(TRACING_LIMITS.endpointBytes);

    // Under the bound the value reaches the parser, which rejects it because a
    // non-ASCII path is percent-encoded and no longer round-trips.
    expect(issuesFor({ TRACING_OTLP_ENDPOINT: underBound })).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "must be a canonical absolute http(s) URL",
    });

    const overIssues = issuesFor({ TRACING_OTLP_ENDPOINT: overBound });
    expect(overIssues).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "length is outside allowed bounds",
    });
    expect(overIssues).not.toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "must be a canonical absolute http(s) URL",
    });
  });

  it("bounds the RAW endpoint value, not the trimmed one", () => {
    // The bound exists to keep an oversized environment value away from the URL
    // parser, so it must measure what the operator actually set. Trimming first
    // would shrink each of these back under the cap and accept it.
    const endpoint = "http://127.0.0.1:4318/v1/traces";
    const pad = " ".repeat(TRACING_LIMITS.endpointBytes);

    for (const padded of [pad + endpoint, endpoint + pad, pad + endpoint + pad]) {
      expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(TRACING_LIMITS.endpointBytes);
      expect(padded.trim()).toBe(endpoint);

      const issues = issuesFor({ TRACING_OTLP_ENDPOINT: padded });
      expect(issues).toContainEqual({
        field: "TRACING_OTLP_ENDPOINT",
        reason: "length is outside allowed bounds",
      });
      expect(issues).not.toContainEqual({
        field: "TRACING_OTLP_ENDPOINT",
        reason: "must be a canonical absolute http(s) URL",
      });
    }
  });

  it("measures the RAW bound in UTF-8 bytes even when the padding is multibyte", () => {
    const endpoint = "http://127.0.0.1:4318/v1/traces";
    // U+3000 IDEOGRAPHIC SPACE costs three UTF-8 bytes and IS stripped by
    // `trim()`, so the raw value crosses the byte bound while its string length
    // stays far below it: a character count would let it through twice over.
    const padded = "\u3000".repeat(800) + endpoint;
    expect(padded.length).toBeLessThan(TRACING_LIMITS.endpointBytes);
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(TRACING_LIMITS.endpointBytes);
    expect(padded.trim()).toBe(endpoint);

    const issues = issuesFor({ TRACING_OTLP_ENDPOINT: padded });
    expect(issues).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "length is outside allowed bounds",
    });
    expect(issues).not.toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "must be a canonical absolute http(s) URL",
    });
  });

  it("accepts a raw value at exactly the byte bound and rejects one byte more", () => {
    const endpoint = "http://127.0.0.1:4318/v1/traces";
    const atBound = " ".repeat(TRACING_LIMITS.endpointBytes - endpoint.length) + endpoint;
    expect(Buffer.byteLength(atBound, "utf8")).toBe(TRACING_LIMITS.endpointBytes);
    // Exactly at the bound the value is still trimmed and stored canonically.
    expect(
      loadConfig({ env: baseEnv({ TRACING_OTLP_ENDPOINT: atBound }) }).TRACING_OTLP_ENDPOINT,
    ).toBe(endpoint);

    const oneOver = ` ${atBound}`;
    expect(Buffer.byteLength(oneOver, "utf8")).toBe(TRACING_LIMITS.endpointBytes + 1);
    expect(issuesFor({ TRACING_OTLP_ENDPOINT: oneOver })).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "length is outside allowed bounds",
    });

    // The same boundary with no padding at all, so the +/-1 behaviour is not an
    // artefact of trimming.
    const base = "https://collector.internal/";
    const pathAtBound = base + "a".repeat(TRACING_LIMITS.endpointBytes - base.length);
    expect(Buffer.byteLength(pathAtBound, "utf8")).toBe(TRACING_LIMITS.endpointBytes);
    expect(
      loadConfig({ env: baseEnv({ TRACING_OTLP_ENDPOINT: pathAtBound }) }).TRACING_OTLP_ENDPOINT,
    ).toBe(pathAtBound);
    expect(issuesFor({ TRACING_OTLP_ENDPOINT: `${pathAtBound}a` })).toContainEqual({
      field: "TRACING_OTLP_ENDPOINT",
      reason: "length is outside allowed bounds",
    });
  });

  it("still trims a within-bound endpoint before storing it", () => {
    // Bounding the raw value must not change what an ordinary padded setting
    // resolves to.
    for (const TRACING_ENABLED of ["true", "false"]) {
      expect(
        loadConfig({
          env: baseEnv({
            TRACING_ENABLED,
            TRACING_OTLP_ENDPOINT: "  http://127.0.0.1:4318/v1/traces  ",
          }),
        }).TRACING_OTLP_ENDPOINT,
      ).toBe("http://127.0.0.1:4318/v1/traces");
    }
  });

  it("never hands an over-bound endpoint to the URL parser", () => {
    // Keeping an oversized value out of the parser is the reason the bound
    // exists, so assert it directly rather than inferring it from the reason.
    // Other settings (the upstream base URL) legitimately parse during the same
    // load, so the assertion is that neither spelling of THIS value appears.
    const overBound = " ".repeat(TRACING_LIMITS.endpointBytes) + "http://127.0.0.1:4318/v1/traces";
    const parsed: string[] = [];
    vi.stubGlobal(
      "URL",
      new Proxy(URL, {
        construct(target, args: unknown[], newTarget): object {
          const input = args[0];
          if (typeof input === "string") parsed.push(input);
          return Reflect.construct(target, args, newTarget) as object;
        },
      }),
    );

    try {
      expect(issuesFor({ TRACING_OTLP_ENDPOINT: overBound })).toContainEqual({
        field: "TRACING_OTLP_ENDPOINT",
        reason: "length is outside allowed bounds",
      });
    } finally {
      vi.unstubAllGlobals();
    }

    // The upstream base URL is parsed during the same load, so a non-empty
    // record proves the stub was actually in effect and the assertion below is
    // not vacuously true.
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed).not.toContain(overBound);
    expect(parsed).not.toContain(overBound.trim());
  });

  it("never echoes an endpoint's host, path, or embedded credentials", () => {
    const issues = issuesFor({
      TRACING_OTLP_ENDPOINT:
        "https://SENSITIVE-USER:SENSITIVE-PASS@sensitive.host.internal/SENSITIVE-PATH",
    });
    const formatted = new ConfigError(issues).format();
    for (const sentinel of [
      "SENSITIVE-USER",
      "SENSITIVE-PASS",
      "SENSITIVE-PATH",
      "sensitive.host.internal",
    ]) {
      expect(formatted).not.toContain(sentinel);
    }
    expect(formatted).toContain("TRACING_OTLP_ENDPOINT: must not embed credentials");
  });

  it("bounds the sample ratio to a plain decimal in [0, 1]", () => {
    for (const [raw, expected] of [
      ["0", 0],
      ["1", 1],
      ["0.05", 0.05],
      [" 0.5 ", 0.5],
    ] as const) {
      expect(loadConfig({ env: baseEnv({ TRACING_SAMPLE_RATIO: raw }) }).TRACING_SAMPLE_RATIO).toBe(
        expected,
      );
    }
    // Out of range is a bounds failure; unparseable is a syntax failure. Both
    // are rejected rather than clamped, so a mistyped probability is visible.
    expect(issuesFor({ TRACING_SAMPLE_RATIO: "1.5" })).toContainEqual({
      field: "TRACING_SAMPLE_RATIO",
      reason: "is outside allowed range",
    });
    for (const value of ["-0.1", "1e-2", "0x1", "abc", "NaN", "Infinity", ".5", "1,0"]) {
      expect(issuesFor({ TRACING_SAMPLE_RATIO: value })).toContainEqual({
        field: "TRACING_SAMPLE_RATIO",
        reason: "must be a decimal ratio",
      });
    }
  });

  it("needs no Redis, credential, or other feature to enable either switch", () => {
    const config = loadConfig({
      env: baseEnv({
        METRICS_ENABLED: "true",
        TRACING_ENABLED: "true",
        TRACING_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        TRACING_SAMPLE_RATIO: "0.25",
      }),
    });
    expect(config.METRICS_ENABLED).toBe(true);
    expect(config.TRACING_ENABLED).toBe(true);
    expect(config.TRACING_SAMPLE_RATIO).toBe(0.25);
    expect(config.REDIS_URL).toBeUndefined();
  });

  it("keeps every observability failure value-free", () => {
    const issues = issuesFor({
      METRICS_ENABLED: "SENSITIVE-METRICS",
      TRACING_ENABLED: "SENSITIVE-TRACING",
      TRACING_OTLP_ENDPOINT: "http://collector.internal/SENSITIVE-PATH?token=SENSITIVE-TOKEN",
      TRACING_SAMPLE_RATIO: "SENSITIVE-RATIO",
    });
    const formatted = new ConfigError(issues).format();
    for (const sentinel of [
      "SENSITIVE-METRICS",
      "SENSITIVE-TRACING",
      "SENSITIVE-PATH",
      "SENSITIVE-TOKEN",
      "SENSITIVE-RATIO",
      "collector.internal",
    ]) {
      expect(formatted).not.toContain(sentinel);
    }
  });
});

describe("loadConfig — optional OpenCode thread reuse", () => {
  const VALID_KEY = randomBytes(32).toString("base64url");
  /** The Redis settings that make enabling thread reuse valid. */
  const REDIS = {
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY,
  } as const;

  function issuesFor(overrides: Record<string, string | undefined>): ConfigError["issues"] {
    try {
      loadConfig({ env: baseEnv(overrides) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
  }

  it("is DISABLED by default, with a seven-day mapping TTL", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.OPENCODE_THREAD_REUSE_ENABLED).toBe(false);
    expect(config.OPENCODE_THREAD_REUSE_TTL_MS).toBe(604_800_000);
  });

  it("accepts only the strict boolean syntax", () => {
    expect(
      loadConfig({ env: baseEnv({ OPENCODE_THREAD_REUSE_ENABLED: "false" }) })
        .OPENCODE_THREAD_REUSE_ENABLED,
    ).toBe(false);
    expect(
      loadConfig({ env: baseEnv({ ...REDIS, OPENCODE_THREAD_REUSE_ENABLED: "true" }) })
        .OPENCODE_THREAD_REUSE_ENABLED,
    ).toBe(true);
    for (const value of ["1", "0", "yes", "no", "on", "enabled"]) {
      expect(issuesFor({ ...REDIS, OPENCODE_THREAD_REUSE_ENABLED: value })).toContainEqual({
        field: "OPENCODE_THREAD_REUSE_ENABLED",
        reason: 'must be "true" or "false"',
      });
    }
  });

  it("REQUIRES a Redis endpoint when explicitly enabled", () => {
    // A session-to-thread mapping must be visible to every replica and leased
    // atomically, so enabling reuse without Redis is an error rather than a
    // silent downgrade to one thread per completion.
    expect(issuesFor({ OPENCODE_THREAD_REUSE_ENABLED: "true" })).toContainEqual({
      field: "REDIS_URL",
      reason: "is required when OPENCODE_THREAD_REUSE_ENABLED is true",
    });
    for (const REDIS_URL of ["", "   "]) {
      expect(issuesFor({ OPENCODE_THREAD_REUSE_ENABLED: "true", REDIS_URL })).toContainEqual({
        field: "REDIS_URL",
        reason: "is required when OPENCODE_THREAD_REUSE_ENABLED is true",
      });
    }
  });

  it("still requires the encryption key transitively when enabled", () => {
    // Enabling reuse requires Redis, and Redis already requires the master key
    // the four thread-reuse subkeys are derived from. No new secret is added.
    expect(
      issuesFor({
        OPENCODE_THREAD_REUSE_ENABLED: "true",
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toContainEqual({ field: "IDEMPOTENCY_ENCRYPTION_KEY", reason: "is required" });
  });

  it("enforces the TTL range and accepts each boundary", () => {
    for (const value of ["0", "-1", "299999", "2592000001"]) {
      expect(issuesFor({ OPENCODE_THREAD_REUSE_TTL_MS: value })).toContainEqual({
        field: "OPENCODE_THREAD_REUSE_TTL_MS",
        reason: "is outside allowed range",
      });
    }
    expect(issuesFor({ OPENCODE_THREAD_REUSE_TTL_MS: "not-an-int" })).toContainEqual({
      field: "OPENCODE_THREAD_REUSE_TTL_MS",
      reason: "must be an integer",
    });
    expect(
      loadConfig({ env: baseEnv({ OPENCODE_THREAD_REUSE_TTL_MS: "300000" }) })
        .OPENCODE_THREAD_REUSE_TTL_MS,
    ).toBe(300_000);
    expect(
      loadConfig({ env: baseEnv({ OPENCODE_THREAD_REUSE_TTL_MS: "2592000000" }) })
        .OPENCODE_THREAD_REUSE_TTL_MS,
    ).toBe(2_592_000_000);
  });

  it("validates a PRESENT TTL even while the feature is disabled", () => {
    // A deployment must not be able to carry a silently broken setting that
    // only fails the day someone switches reuse on.
    expect(
      issuesFor({
        OPENCODE_THREAD_REUSE_ENABLED: "false",
        OPENCODE_THREAD_REUSE_TTL_MS: "1000",
      }),
    ).toContainEqual({
      field: "OPENCODE_THREAD_REUSE_TTL_MS",
      reason: "is outside allowed range",
    });
  });

  it("does not require Redis while the feature stays disabled", () => {
    const config = loadConfig({
      env: baseEnv({
        OPENCODE_THREAD_REUSE_ENABLED: "false",
        OPENCODE_THREAD_REUSE_TTL_MS: "300000",
      }),
    });
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.OPENCODE_THREAD_REUSE_TTL_MS).toBe(300_000);
  });

  it("composes with rate limiting over the same Redis endpoint", () => {
    const config = loadConfig({
      env: baseEnv({
        ...REDIS,
        RATE_LIMIT_ENABLED: "true",
        OPENCODE_THREAD_REUSE_ENABLED: "true",
      }),
    });
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.OPENCODE_THREAD_REUSE_ENABLED).toBe(true);
  });

  it("keeps every thread-reuse failure value-free", () => {
    const issues = issuesFor({
      OPENCODE_THREAD_REUSE_ENABLED: "SENSITIVE-VALUE",
      OPENCODE_THREAD_REUSE_TTL_MS: "SENSITIVE-TTL",
    });
    const formatted = new ConfigError(issues).format();
    expect(formatted).not.toContain("SENSITIVE-VALUE");
    expect(formatted).not.toContain("SENSITIVE-TTL");
  });
});

describe("loadConfig — optional cross-replica shared capacity", () => {
  const VALID_KEY = randomBytes(32).toString("base64url");
  /** The Redis settings that make enabling shared capacity valid. */
  const REDIS = {
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: VALID_KEY,
  } as const;

  function issuesFor(overrides: Record<string, string | undefined>): ConfigError["issues"] {
    try {
      loadConfig({ env: baseEnv(overrides) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
  }

  it("is DISABLED by default, leaving the two active limits per replica", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.SHARED_CAPACITY_ENABLED).toBe(false);
    expect(config.MAX_CONCURRENT_REQUESTS).toBe(4);
    expect(config.MAX_CONCURRENT_REQUESTS_PER_KEY).toBe(2);
  });

  it("accepts only the strict boolean syntax", () => {
    expect(
      loadConfig({ env: baseEnv({ SHARED_CAPACITY_ENABLED: "false" }) }).SHARED_CAPACITY_ENABLED,
    ).toBe(false);
    expect(
      loadConfig({ env: baseEnv({ ...REDIS, SHARED_CAPACITY_ENABLED: "true" }) })
        .SHARED_CAPACITY_ENABLED,
    ).toBe(true);
    for (const value of ["1", "0", "yes", "no", "on", "enabled"]) {
      expect(issuesFor({ ...REDIS, SHARED_CAPACITY_ENABLED: value })).toContainEqual({
        field: "SHARED_CAPACITY_ENABLED",
        reason: 'must be "true" or "false"',
      });
    }
  });

  it("REQUIRES a Redis endpoint when explicitly enabled", () => {
    // A cluster-wide active budget cannot be enforced from process-local state,
    // so enabling it without Redis is an error rather than a silent downgrade
    // that would multiply the configured limit by the replica count.
    expect(issuesFor({ SHARED_CAPACITY_ENABLED: "true" })).toContainEqual({
      field: "REDIS_URL",
      reason: "is required when SHARED_CAPACITY_ENABLED is true",
    });
    for (const REDIS_URL of ["", "   "]) {
      expect(issuesFor({ SHARED_CAPACITY_ENABLED: "true", REDIS_URL })).toContainEqual({
        field: "REDIS_URL",
        reason: "is required when SHARED_CAPACITY_ENABLED is true",
      });
    }
  });

  it("rejects a PRESENT invalid value rather than resolving it to disabled", () => {
    // Silently falling back to the default would leave a deployment believing
    // shared capacity is on while every replica counts its own permits.
    const issues = issuesFor({ SHARED_CAPACITY_ENABLED: "yes" });
    expect(issues).toContainEqual({
      field: "SHARED_CAPACITY_ENABLED",
      reason: 'must be "true" or "false"',
    });
    // An unparsed switch is never read as `true`, so it raises no Redis
    // requirement of its own.
    expect(issues).not.toContainEqual({
      field: "REDIS_URL",
      reason: "is required when SHARED_CAPACITY_ENABLED is true",
    });
  });

  it("keeps every shared-capacity failure value-free", () => {
    const issues = issuesFor({ SHARED_CAPACITY_ENABLED: "SENSITIVE-VALUE" });
    const formatted = new ConfigError(issues).format();
    expect(formatted).not.toContain("SENSITIVE-VALUE");
    expect(formatted).toContain("SHARED_CAPACITY_ENABLED");
  });
});

describe("loadConfig — gateway keys", () => {
  /** Load with a raw gateway-key string, returning either config or issues. */
  function loadWithKeys(rawKeys: string): ReturnType<typeof loadConfig> {
    return loadConfig({ env: baseEnv({ COLLECTIVIQ_GATEWAY_KEYS: rawKeys }) });
  }

  /** The value-free issues raised by loading a given raw gateway-key string. */
  function keyIssues(rawKeys: string): ConfigError["issues"] {
    try {
      loadWithKeys(rawKeys);
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
  }

  it("accepts a single configured key", () => {
    const config = loadWithKeys("gw-only");
    expect(config.COLLECTIVIQ_GATEWAY_KEYS).toEqual(["gw-only"]);
  });

  it("accepts exactly 64 configured keys", () => {
    const keys = Array.from({ length: 64 }, (_v, i) => `gw-fake-${i}`);
    const config = loadWithKeys(keys.join(","));
    expect(config.COLLECTIVIQ_GATEWAY_KEYS).toHaveLength(64);
  });

  it("rejects 65 configured keys value-free", () => {
    const keys = Array.from({ length: 65 }, (_v, i) => `gw-fake-${i}`);
    const issues = keyIssues(keys.join(","));
    const relevant = issues.filter((i) => i.field === "COLLECTIVIQ_GATEWAY_KEYS");
    expect(relevant.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(issues);
    for (const key of keys) expect(serialized).not.toContain(key);
  });

  it("accepts an 8192-byte UTF-8 key", () => {
    const key = "a".repeat(8192);
    const config = loadWithKeys(key);
    expect(config.COLLECTIVIQ_GATEWAY_KEYS).toEqual([key]);
  });

  it("rejects an 8193-byte key value-free", () => {
    const key = "a".repeat(8193);
    const issues = keyIssues(key);
    const relevant = issues.filter((i) => i.field === "COLLECTIVIQ_GATEWAY_KEYS");
    expect(relevant.some((i) => i.reason === "length is outside allowed bounds")).toBe(true);
    expect(JSON.stringify(issues)).not.toContain(key);
  });

  it("measures the key byte cap in UTF-8 bytes, not string length", () => {
    // 4096 × "é" (2 bytes each) = 8192 bytes with a string length of 4096.
    const ok = "é".repeat(4096);
    expect(ok.length).toBe(4096);
    expect(Buffer.byteLength(ok, "utf8")).toBe(8192);
    expect(loadWithKeys(ok).COLLECTIVIQ_GATEWAY_KEYS).toEqual([ok]);

    // 4097 × "é" = 8194 bytes: string length (4097) is well under the cap, but
    // the UTF-8 byte length exceeds it, so it must be rejected.
    const tooBig = "é".repeat(4097);
    expect(tooBig.length).toBeLessThan(8192);
    expect(Buffer.byteLength(tooBig, "utf8")).toBe(8194);
    const issues = keyIssues(tooBig);
    expect(
      issues.some(
        (i) =>
          i.field === "COLLECTIVIQ_GATEWAY_KEYS" && i.reason === "length is outside allowed bounds",
      ),
    ).toBe(true);
  });

  it("trims, drops empty entries, and de-duplicates", () => {
    const config = loadWithKeys(" gw-a , , gw-a ,gw-b, gw-b ");
    expect(config.COLLECTIVIQ_GATEWAY_KEYS).toEqual(["gw-a", "gw-b"]);
  });
});

describe("loadConfig — upstream authentication mode", () => {
  it("defaults to bearer mode and requires the API key", () => {
    const config = loadConfig({ env: baseEnv() });
    expect(config.COLLECTIVIQ_AUTH_MODE).toBe("bearer");
    expect(config.COLLECTIVIQ_API_KEY).toBe("sk-fake-upstream-000");
    // Bearer mode does not populate password-mode credentials.
    expect(config.COLLECTIVIQ_USERNAME).toBeUndefined();
    expect(config.COLLECTIVIQ_PASSWORD).toBeUndefined();
  });

  it("preserves the bearer token exactly (no trimming) within the 16 KiB bound", () => {
    const padded = "  sk-padded-token  ";
    const config = loadConfig({ env: baseEnv({ COLLECTIVIQ_API_KEY: padded }) });
    expect(config.COLLECTIVIQ_API_KEY).toBe(padded);
    expect(() => loadConfig({ env: baseEnv({ COLLECTIVIQ_API_KEY: "x".repeat(16_385) }) })).toThrow(
      ConfigError,
    );
  });

  it("loads password mode with username/password and ignores the (inactive) API key", () => {
    const config = loadConfig({
      env: baseEnv({
        COLLECTIVIQ_AUTH_MODE: "password",
        COLLECTIVIQ_USERNAME: "  probe-user@example.com  ",
        COLLECTIVIQ_PASSWORD: "  keep-exactly  ",
        // Inactive-mode credential present but ignored:
        COLLECTIVIQ_API_KEY: "sk-should-be-ignored",
      }),
    });
    expect(config.COLLECTIVIQ_AUTH_MODE).toBe("password");
    // Username is trimmed; password is preserved exactly (incl. whitespace).
    expect(config.COLLECTIVIQ_USERNAME).toBe("probe-user@example.com");
    expect(config.COLLECTIVIQ_PASSWORD).toBe("  keep-exactly  ");
    // The inactive bearer credential is NOT read into the config.
    expect(config.COLLECTIVIQ_API_KEY).toBeUndefined();
  });

  it("runs password mode WITHOUT an API key present", () => {
    const config = loadConfig({
      env: baseEnv({
        COLLECTIVIQ_AUTH_MODE: "password",
        COLLECTIVIQ_USERNAME: "u@example.com",
        COLLECTIVIQ_PASSWORD: "p",
        COLLECTIVIQ_API_KEY: undefined,
      }),
    });
    expect(config.COLLECTIVIQ_AUTH_MODE).toBe("password");
  });

  it("rejects an unsupported auth mode and missing/oversized credentials", () => {
    expect(() => loadConfig({ env: baseEnv({ COLLECTIVIQ_AUTH_MODE: "token" }) })).toThrow(
      ConfigError,
    );
    // Password mode requires BOTH username and password.
    expect(() =>
      loadConfig({
        env: baseEnv({ COLLECTIVIQ_AUTH_MODE: "password", COLLECTIVIQ_PASSWORD: "p" }),
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        env: baseEnv({ COLLECTIVIQ_AUTH_MODE: "password", COLLECTIVIQ_USERNAME: "u" }),
      }),
    ).toThrow(ConfigError);
    // Byte bounds.
    expect(() =>
      loadConfig({
        env: baseEnv({
          COLLECTIVIQ_AUTH_MODE: "password",
          COLLECTIVIQ_USERNAME: "u".repeat(321),
          COLLECTIVIQ_PASSWORD: "p",
        }),
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        env: baseEnv({
          COLLECTIVIQ_AUTH_MODE: "password",
          COLLECTIVIQ_USERNAME: "u@example.com",
          COLLECTIVIQ_PASSWORD: "p".repeat(4_097),
        }),
      }),
    ).toThrow(ConfigError);
  });

  it("never echoes password-mode secret values in errors", () => {
    const userLeak = "user-DO-NOT-LEAK@example.com";
    const passLeak = "pw-DO-NOT-LEAK-9999";
    try {
      loadConfig({
        env: baseEnv({
          COLLECTIVIQ_AUTH_MODE: "password",
          COLLECTIVIQ_USERNAME: userLeak,
          COLLECTIVIQ_PASSWORD: passLeak,
          PORT: "x", // force a failure so the error path runs
        }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const serialized = `${(error as ConfigError).format()} ${JSON.stringify(
        (error as ConfigError).issues,
      )}`;
      expect(serialized).not.toContain(userLeak);
      expect(serialized).not.toContain(passLeak);
      expect(serialized).toContain("PORT");
    }
  });
});

describe("loadConfig — model file validation", () => {
  it("rejects duplicate YAML keys", () => {
    expectReject(
      writeModelFile("dup.yaml", "models:\n  m1:\n    displayName: A\n  m1:\n    displayName: B\n"),
    );
  });

  it("rejects YAML aliases", () => {
    const alias =
      "models:\n" +
      "  m1: &m\n" +
      "    displayName: A\n" +
      "    selectedLlms: [gpt]\n" +
      "    generateCombined: false\n" +
      "    answerSource: gpt\n" +
      "    toolMode: disabled\n" +
      "    requestTimeoutMs: 90000\n" +
      "    pollIntervalMs: 2000\n" +
      "    maxPollIntervalMs: 5000\n" +
      "    maximumPromptBytes: 2048\n" +
      "  m2: *m\n";
    expectReject(writeModelFile("alias.yaml", alias));
  });

  it("rejects a non-regular model path", () => {
    expectReject(dir); // a directory, not a regular file
  });

  it("rejects an empty model map", () => {
    expectReject(writeModelFile("empty-map.yaml", stringify({ models: {} })));
  });

  it("rejects unknown model fields", () => {
    expectReject(
      writeModelFile("unknown.yaml", stringify({ models: { m1: { ...validModel, extra: 1 } } })),
    );
  });

  it("rejects empty or duplicate selected sources", () => {
    expectReject(writeModelFile("empty-llms.yaml", modelFileFrom({ selectedLlms: [] })));
    expectReject(writeModelFile("dup-llms.yaml", modelFileFrom({ selectedLlms: ["gpt", "gpt"] })));
  });

  it("rejects an invalid answer-source / combined policy", () => {
    expectReject(
      writeModelFile(
        "combined.yaml",
        modelFileFrom({ generateCombined: false, answerSource: "combined" }),
      ),
    );
    expectReject(
      writeModelFile(
        "source.yaml",
        modelFileFrom({ generateCombined: false, answerSource: "grok", selectedLlms: ["gpt"] }),
      ),
    );
  });

  it("enforces existing timeout/poll ordering", () => {
    expectReject(
      writeModelFile(
        "poll.yaml",
        modelFileFrom({ pollIntervalMs: 6_000, maxPollIntervalMs: 5_000 }),
      ),
    );
    expectReject(
      writeModelFile(
        "poll2.yaml",
        modelFileFrom({ maxPollIntervalMs: 50_000, requestTimeoutMs: 40_000 }),
      ),
    );
  });

  it("reports an unreadable model file without leaking a path", () => {
    const missing = join(dir, "does-not-exist.yaml");
    try {
      loadConfig({ env: baseEnv({ MODEL_CONFIG_PATH: missing }) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).format()).not.toContain(dir);
    }
  });

  it("keeps hostile model ids and unknown field names out of errors", () => {
    const hostileId = "sk-SECRET-MODELID-9999";
    const path = writeModelFile(
      "hostile.yaml",
      stringify({ models: { [hostileId]: { ...validModel, SECRET_UNKNOWN_FIELD: "leak" } } }),
    );
    try {
      loadConfig({ env: baseEnv({ MODEL_CONFIG_PATH: path }) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const serialized = `${(error as ConfigError).format()} ${JSON.stringify(
        (error as ConfigError).issues,
      )}`;
      expect(serialized).not.toContain("SECRET-MODELID");
      expect(serialized).not.toContain("SECRET_UNKNOWN_FIELD");
    }
  });

  it("normalizes an omitted promptMode to protocol", () => {
    // validModel omits promptMode entirely.
    const config = expectLoads(writeModelFile("no-prompt-mode.yaml", modelFileFrom({})));
    expect(config.models[0]?.promptMode).toBe("protocol");
  });

  it("loads an explicit protocol and an explicit direct promptMode", () => {
    const protocol = expectLoads(
      writeModelFile("prompt-protocol.yaml", modelFileFrom({ promptMode: "protocol" })),
    );
    expect(protocol.models[0]?.promptMode).toBe("protocol");
    const direct = expectLoads(
      writeModelFile(
        "prompt-direct.yaml",
        modelFileFrom({
          promptMode: "direct",
          generateCombined: false,
          answerSource: "gpt",
          selectedLlms: ["gpt"],
        }),
      ),
    );
    expect(direct.models[0]?.promptMode).toBe("direct");
  });

  it("rejects an unsupported promptMode value with a value-free ordinal issue", () => {
    const path = writeModelFile(
      "prompt-bad.yaml",
      stringify({ models: { m1: { ...validModel, promptMode: "verbose" } } }),
    );
    try {
      loadConfig({ env: baseEnv({ MODEL_CONFIG_PATH: path }) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.some((i) => i.field === "models[0].promptMode")).toBe(true);
      const serialized = `${(error as ConfigError).format()} ${JSON.stringify(issues)}`;
      // The submitted value is never echoed.
      expect(serialized).not.toContain("verbose");
    }
  });

  it("rejects toolMode: emulated with a non-protocol promptMode (invariant)", () => {
    const path = writeModelFile(
      "emulated-direct.yaml",
      stringify({ models: { m1: { ...validModel, toolMode: "emulated", promptMode: "direct" } } }),
    );
    try {
      loadConfig({ env: baseEnv({ MODEL_CONFIG_PATH: path }) });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.some((i) => i.field === "models[0].promptMode")).toBe(true);
    }
  });

  it("accepts toolMode: emulated with promptMode: protocol", () => {
    const config = expectLoads(
      writeModelFile(
        "emulated-protocol.yaml",
        modelFileFrom({ toolMode: "emulated", promptMode: "protocol" }),
      ),
    );
    expect(config.models[0]?.toolMode).toBe("emulated");
    expect(config.models[0]?.promptMode).toBe("protocol");
  });
});

describe("loadConfig — model limits", () => {
  const overhead = 2; // "\n#"

  function sizedFile(name: string, targetBytes: number): string {
    const base = stringify({ models: { m1: validModel } });
    const pad = targetBytes - Buffer.byteLength(base, "utf8") - overhead;
    const content = `${base}\n#${"x".repeat(Math.max(pad, 0))}`;
    return writeModelFile(name, content);
  }

  it("accepts a file at the byte limit and rejects one byte over", () => {
    const atLimit = sizedFile("at-limit.yaml", MODEL_CONFIG_LIMITS.fileBytes);
    expect(statSync(atLimit).size).toBe(MODEL_CONFIG_LIMITS.fileBytes);
    expect(expectLoads(atLimit).models).toHaveLength(1);
    expectReject(sizedFile("over-limit.yaml", MODEL_CONFIG_LIMITS.fileBytes + 1));
  });

  it("accepts exactly the maximum model count and rejects one over", () => {
    const make = (count: number) => {
      const models: Record<string, VirtualModelDefinition> = {};
      for (let i = 0; i < count; i += 1) {
        models[`m${i}`] = {
          ...validModel,
          generateCombined: false,
          answerSource: "gpt",
          selectedLlms: ["gpt"],
        };
      }
      return stringify({ models });
    };
    expect(
      expectLoads(writeModelFile("max-models.yaml", make(MODEL_CONFIG_LIMITS.models.max))).models,
    ).toHaveLength(MODEL_CONFIG_LIMITS.models.max);
    expectReject(writeModelFile("over-models.yaml", make(MODEL_CONFIG_LIMITS.models.max + 1)));
  });

  it("accepts exactly the maximum selected-source count and rejects one over", () => {
    const sources = (count: number) => Array.from({ length: count }, (_v, i) => `s${i}`);
    expectLoads(
      writeModelFile(
        "max-sources.yaml",
        modelFileFrom({
          selectedLlms: sources(MODEL_CONFIG_LIMITS.selectedLlms.max),
          generateCombined: false,
          answerSource: "s0",
        }),
      ),
    );
    expectReject(
      writeModelFile(
        "over-sources.yaml",
        modelFileFrom({
          selectedLlms: sources(MODEL_CONFIG_LIMITS.selectedLlms.max + 1),
          generateCombined: false,
          answerSource: "s0",
        }),
      ),
    );
  });

  it("rejects blank and padded model ids", () => {
    expectReject(writeModelFile("blank-id.yaml", modelFileWithId("   ")));
    expectReject(writeModelFile("padded-id.yaml", modelFileWithId(" model-a ")));
  });

  it("rejects blank and padded display, source, and answer-source strings", () => {
    expectReject(writeModelFile("blank-name.yaml", modelFileFrom({ displayName: "   " })));
    expectReject(writeModelFile("padded-name.yaml", modelFileFrom({ displayName: " Name " })));
    expectReject(
      writeModelFile(
        "padded-source.yaml",
        modelFileFrom({ selectedLlms: [" gpt "], answerSource: "combined" }),
      ),
    );
    expectReject(
      writeModelFile(
        "padded-answer.yaml",
        modelFileFrom({ generateCombined: false, selectedLlms: ["gpt"], answerSource: "gpt " }),
      ),
    );
  });

  it("accepts exact maximum string lengths and rejects one-over", () => {
    expectLoads(
      writeModelFile(
        "id-max.yaml",
        modelFileWithId("i".repeat(MODEL_CONFIG_LIMITS.modelIdLength.max)),
      ),
    );
    expectReject(
      writeModelFile(
        "id-over.yaml",
        modelFileWithId("i".repeat(MODEL_CONFIG_LIMITS.modelIdLength.max + 1)),
      ),
    );

    expectLoads(
      writeModelFile(
        "name-max.yaml",
        modelFileFrom({ displayName: "d".repeat(MODEL_CONFIG_LIMITS.displayNameLength.max) }),
      ),
    );
    expectReject(
      writeModelFile(
        "name-over.yaml",
        modelFileFrom({ displayName: "d".repeat(MODEL_CONFIG_LIMITS.displayNameLength.max + 1) }),
      ),
    );

    const maxSource = "s".repeat(MODEL_CONFIG_LIMITS.sourceLength.max);
    expectLoads(
      writeModelFile(
        "source-max.yaml",
        modelFileFrom({
          generateCombined: false,
          selectedLlms: [maxSource],
          answerSource: maxSource,
        }),
      ),
    );
    expectReject(
      writeModelFile(
        "source-over.yaml",
        modelFileFrom({
          generateCombined: false,
          selectedLlms: ["s".repeat(MODEL_CONFIG_LIMITS.sourceLength.max + 1)],
          answerSource: "gpt",
        }),
      ),
    );
  });

  it("accepts numeric boundaries and rejects one-outside", () => {
    // requestTimeoutMs
    expectLoads(
      writeModelFile(
        "rt-min.yaml",
        modelFileFrom({
          requestTimeoutMs: MODEL_CONFIG_LIMITS.requestTimeoutMs.min,
          pollIntervalMs: 100,
          maxPollIntervalMs: 100,
        }),
      ),
    );
    expectReject(
      writeModelFile(
        "rt-below.yaml",
        modelFileFrom({
          requestTimeoutMs: MODEL_CONFIG_LIMITS.requestTimeoutMs.min - 1,
          pollIntervalMs: 100,
          maxPollIntervalMs: 100,
        }),
      ),
    );
    expectLoads(
      writeModelFile(
        "rt-max.yaml",
        modelFileFrom({ requestTimeoutMs: MODEL_CONFIG_LIMITS.requestTimeoutMs.max }),
      ),
    );
    expectReject(
      writeModelFile(
        "rt-above.yaml",
        modelFileFrom({ requestTimeoutMs: MODEL_CONFIG_LIMITS.requestTimeoutMs.max + 1 }),
      ),
    );

    // pollIntervalMs
    expectLoads(
      writeModelFile(
        "poll-min.yaml",
        modelFileFrom({
          pollIntervalMs: MODEL_CONFIG_LIMITS.pollIntervalMs.min,
          maxPollIntervalMs: 100,
        }),
      ),
    );
    expectReject(
      writeModelFile(
        "poll-below.yaml",
        modelFileFrom({ pollIntervalMs: MODEL_CONFIG_LIMITS.pollIntervalMs.min - 1 }),
      ),
    );

    // maximumPromptBytes
    expectLoads(
      writeModelFile(
        "prompt-min.yaml",
        modelFileFrom({ maximumPromptBytes: MODEL_CONFIG_LIMITS.maximumPromptBytes.min }),
      ),
    );
    expectReject(
      writeModelFile(
        "prompt-below.yaml",
        modelFileFrom({ maximumPromptBytes: MODEL_CONFIG_LIMITS.maximumPromptBytes.min - 1 }),
      ),
    );
  });
});
