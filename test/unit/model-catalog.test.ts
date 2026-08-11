import { describe, expect, it } from "vitest";
import { createModelCatalog } from "../../src/generation/model-catalog.js";
import type { VirtualModel } from "../../src/config/schema.js";

const CREATED = 1_785_933_840;

function model(id: string, overrides: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id,
    displayName: `Display ${id}`,
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode: "disabled",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 2_048,
    ...overrides,
  };
}

const MODELS: readonly VirtualModel[] = [
  model("collectiviq-consensus"),
  model("collectiviq-coder"),
  model("collectiviq-fast"),
];

describe("createModelCatalog", () => {
  it("preserves configuration order in the listing", () => {
    const catalog = createModelCatalog(MODELS, CREATED);
    expect(catalog.list().map((m) => m.id)).toEqual([
      "collectiviq-consensus",
      "collectiviq-coder",
      "collectiviq-fast",
    ]);
  });

  it("resolves ids case-sensitively", () => {
    const catalog = createModelCatalog(MODELS, CREATED);
    expect(catalog.resolve("collectiviq-coder")?.id).toBe("collectiviq-coder");
    expect(catalog.resolve("Collectiviq-Coder")).toBeUndefined();
    expect(catalog.resolve("COLLECTIVIQ-CODER")).toBeUndefined();
    expect(catalog.resolve("unknown-model")).toBeUndefined();
    expect(catalog.resolve("")).toBeUndefined();
  });

  it("reuses one captured timestamp for every model object", () => {
    const catalog = createModelCatalog(MODELS, CREATED);
    expect(catalog.created).toBe(CREATED);
    for (const object of catalog.list()) {
      expect(object.created).toBe(CREATED);
    }
    expect(catalog.resolve("collectiviq-fast")?.created).toBe(CREATED);
  });

  it("exposes only the public OpenAI model fields", () => {
    const catalog = createModelCatalog(MODELS, CREATED);
    const object = catalog.resolve("collectiviq-consensus");
    expect(object).toEqual({
      id: "collectiviq-consensus",
      object: "model",
      created: CREATED,
      owned_by: "collectiviq-gateway",
    });
    // No internal policy leaks through the public object.
    expect(Object.keys(object ?? {})).toEqual(["id", "object", "created", "owned_by"]);
  });

  it("returns an immutable catalog that cannot mutate source configuration", () => {
    const source = MODELS.map((m) => ({ ...m }));
    const catalog = createModelCatalog(source, CREATED);
    const list = catalog.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    // Attempting to mutate a returned object does not alter later reads.
    expect(() => {
      (list[0] as { id: string }).id = "tampered";
    }).toThrow();
    expect(catalog.list()[0]?.id).toBe("collectiviq-consensus");
    // The source array/objects are untouched.
    expect(source[0]?.id).toBe("collectiviq-consensus");
  });
});
