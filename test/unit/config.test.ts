import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { ConfigError, loadConfig } from "../../src/config/load.js";
import { MODEL_CONFIG_LIMITS, type VirtualModelDefinition } from "../../src/config/schema.js";

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
    expect(config.models).toHaveLength(3);
    expect(config.models.map((m) => m.id)).toContain("collectiviq-fast");
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
