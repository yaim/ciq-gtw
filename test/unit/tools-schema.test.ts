import { describe, expect, it } from "vitest";
import { compileToolset } from "../../src/tools/schema.js";
import { deepFreezeJson } from "../../src/tools/copy.js";
import type { NormalizedTool } from "../../src/tools/types.js";

const tool = (name: string, parameters: unknown): NormalizedTool => ({
  name,
  parameters: parameters as NormalizedTool["parameters"],
});

describe("compileToolset — compilation", () => {
  it("compiles a draft-07 object schema once and validates arguments", () => {
    const result = compileToolset([
      tool("read", {
        type: "object",
        properties: { path: { type: "string" }, lines: { type: "integer" } },
        required: ["path"],
        additionalProperties: false,
      }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ts = result.toolset;
      expect(ts.has("read")).toBe(true);
      expect(ts.names.has("read")).toBe(true);
      expect(ts.validateArguments("read", { path: "a.ts" })).toBe(true);
      expect(ts.validateArguments("read", { path: "a.ts", lines: 3 })).toBe(true);
      expect(ts.validateArguments("read", {})).toBe(false); // missing required
      expect(ts.validateArguments("read", { path: 1 })).toBe(false); // wrong type
      expect(ts.validateArguments("read", { path: "a", extra: 1 })).toBe(false); // additionalProps
      expect(ts.validateArguments("unknown-tool", { path: "a" })).toBe(false);
    }
  });

  it("does NOT coerce types (string '3' is not an integer)", () => {
    const result = compileToolset([
      tool("t", { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolset.validateArguments("t", { n: "3" })).toBe(false);
  });

  it("validates standard formats via ajv-formats", () => {
    const result = compileToolset([
      tool("t", {
        type: "object",
        properties: { email: { type: "string", format: "email" } },
        required: ["email"],
      }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolset.validateArguments("t", { email: "x@y.com" })).toBe(true);
      expect(result.toolset.validateArguments("t", { email: "not-an-email" })).toBe(false);
    }
  });

  it("accepts an empty schema (any object argument is valid)", () => {
    const result = compileToolset([tool("t", {})]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolset.validateArguments("t", { anything: [1, 2] })).toBe(true);
  });

  it("fails closed on a malformed schema (type is not a valid keyword value)", () => {
    expect(compileToolset([tool("t", { type: 123 })]).ok).toBe(false);
  });

  it("fails closed on an unresolvable remote $ref (no remote loading)", () => {
    expect(compileToolset([tool("t", { $ref: "https://example.com/schema.json" })]).ok).toBe(false);
  });

  it("does not retain schemas across compilations (fresh instance per call)", () => {
    const a = compileToolset([tool("dup", { type: "object" })]);
    const b = compileToolset([tool("dup", { type: "object" })]);
    expect(a.ok && b.ok).toBe(true);
  });
});

/** OpenCode 1.18.21's `read` built-in tool schema, stamped with draft 2020-12. */
const openCodeRead2020 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    filePath: { type: "string" },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 0 },
  },
  required: ["filePath"],
  additionalProperties: false,
};

/** The same `read` schema explicitly declaring draft-07. */
const read07 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { filePath: { type: "string" } },
  required: ["filePath"],
  additionalProperties: false,
};

describe("compileToolset — dialect selection (draft-07 default + draft 2020-12)", () => {
  it("compiles OpenCode 1.18.21's draft-2020-12 read schema and validates arguments", () => {
    const result = compileToolset([tool("read", openCodeRead2020)]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ts = result.toolset;
      expect(ts.validateArguments("read", { filePath: "a.ts" })).toBe(true);
      expect(ts.validateArguments("read", { filePath: "a.ts", offset: 0, limit: 10 })).toBe(true);
      expect(ts.validateArguments("read", {})).toBe(false); // missing required filePath
      expect(ts.validateArguments("read", { filePath: 1 })).toBe(false); // wrong type
      expect(ts.validateArguments("read", { filePath: "a.ts", offset: -1 })).toBe(false); // negative
      expect(ts.validateArguments("read", { filePath: "a.ts", limit: 1.5 })).toBe(false); // non-integer
      expect(ts.validateArguments("read", { filePath: "a.ts", extra: 1 })).toBe(false); // additionalProps
    }
  });

  it("supports both a missing $schema and an explicit draft-07 $schema", () => {
    const missing = compileToolset([
      tool("m", { type: "object", properties: { a: { type: "string" } }, required: ["a"] }),
    ]);
    const explicit = compileToolset([tool("e", read07)]);
    expect(missing.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (missing.ok) expect(missing.toolset.validateArguments("m", { a: "x" })).toBe(true);
    if (explicit.ok) {
      expect(explicit.toolset.validateArguments("e", { filePath: "a.ts" })).toBe(true);
      expect(explicit.toolset.validateArguments("e", { filePath: "a.ts", extra: 1 })).toBe(false);
    }
  });

  it("recognizes every allowlisted draft-07 and draft-2020-12 URI form", () => {
    const draft07Ids = [
      "http://json-schema.org/draft-07/schema",
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft-07/schema",
      "https://json-schema.org/draft-07/schema#",
    ];
    const draft2020Ids = [
      "http://json-schema.org/draft/2020-12/schema",
      "http://json-schema.org/draft/2020-12/schema#",
      "https://json-schema.org/draft/2020-12/schema",
      "https://json-schema.org/draft/2020-12/schema#",
    ];
    for (const id of [...draft07Ids, ...draft2020Ids]) {
      const result = compileToolset([
        tool("t", { $schema: id, type: "object", properties: { a: { type: "string" } } }),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.toolset.validateArguments("t", { a: "x" })).toBe(true);
        expect(result.toolset.validateArguments("t", { a: 1 })).toBe(false);
      }
    }
  });

  it("compiles a MIXED draft-07 + draft-2020-12 toolset and validates each correctly", () => {
    const result = compileToolset([
      tool("read", openCodeRead2020),
      tool("legacy", read07),
      tool("plain", { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ts = result.toolset;
      expect(ts.validateArguments("read", { filePath: "a.ts", offset: 2 })).toBe(true);
      expect(ts.validateArguments("read", { filePath: "a.ts", offset: -1 })).toBe(false);
      expect(ts.validateArguments("legacy", { filePath: "a.ts" })).toBe(true);
      expect(ts.validateArguments("legacy", { filePath: "a.ts", extra: 1 })).toBe(false);
      expect(ts.validateArguments("plain", { n: 3 })).toBe(true);
      expect(ts.validateArguments("plain", { n: "3" })).toBe(false); // no coercion
    }
  });

  it("validates ajv-formats under BOTH dialects", () => {
    for (const id of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      const result = compileToolset([
        tool("t", {
          $schema: id,
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        }),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.toolset.validateArguments("t", { email: "x@y.com" })).toBe(true);
        expect(result.toolset.validateArguments("t", { email: "not-an-email" })).toBe(false);
      }
    }
  });

  it("neither dialect coerces, applies defaults, removes properties, or mutates arguments", () => {
    for (const id of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      const result = compileToolset([
        tool("t", {
          $schema: id,
          type: "object",
          properties: {
            n: { type: "integer" },
            withDefault: { type: "string", default: "DEFAULT" },
          },
          required: ["n"],
          // additionalProperties permitted (not false) so removeAdditional would
          // otherwise strip `extra` — it must NOT.
        }),
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const ts = result.toolset;
        expect(ts.validateArguments("t", { n: "3" })).toBe(false); // no coercion
        const args: Record<string, unknown> = { n: 3, extra: [1, 2] };
        expect(ts.validateArguments("t", args)).toBe(true);
        // No default applied, no property removed, object unchanged.
        expect(args).toEqual({ n: 3, extra: [1, 2] });
        expect(Object.hasOwn(args, "withDefault")).toBe(false);
      }
    }
  });

  it("fails closed on a non-string $schema", () => {
    expect(compileToolset([tool("t", { $schema: 123, type: "object" })]).ok).toBe(false);
    expect(compileToolset([tool("t", { $schema: null, type: "object" })]).ok).toBe(false);
    expect(compileToolset([tool("t", { $schema: { x: 1 }, type: "object" })]).ok).toBe(false);
  });

  it("fails closed on an unknown / unsupported $schema dialect", () => {
    expect(
      compileToolset([
        tool("t", { $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" }),
      ]).ok,
    ).toBe(false);
    expect(
      compileToolset([tool("t", { $schema: "http://example.com/custom", type: "object" })]).ok,
    ).toBe(false);
    // A near-miss (extra path segment / wrong casing) is not allowlisted.
    expect(
      compileToolset([
        tool("t", { $schema: "https://json-schema.org/draft-07/schema/", type: "object" }),
      ]).ok,
    ).toBe(false);
  });

  it("fails closed on an unresolvable remote $ref under BOTH dialects", () => {
    for (const id of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      expect(
        compileToolset([tool("t", { $schema: id, $ref: "https://example.com/schema.json" })]).ok,
      ).toBe(false);
    }
  });

  it("actually applies 2020-12 semantics (prefixItems is enforced, not ignored)", () => {
    // `prefixItems` is a draft-2020-12 keyword. Under draft-07 it is an unknown
    // keyword (ignored with strict:false), so it would NOT constrain the array;
    // enforcement therefore proves the 2020-12 instance compiled this schema.
    const result = compileToolset([
      tool("t", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        prefixItems: [{ type: "string" }],
      }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolset.validateArguments("t", ["a"])).toBe(true);
      expect(result.toolset.validateArguments("t", [1])).toBe(false); // enforced ⇒ 2020-12
    }
  });

  it("compiles a deeply FROZEN schema under both dialects (no in-place schema mutation)", () => {
    for (const id of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      const frozen = deepFreezeJson({
        $schema: id,
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      });
      const result = compileToolset([tool("t", frozen)]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.toolset.validateArguments("t", { a: "x" })).toBe(true);
    }
  });

  it("treats a boolean root schema as draft-07 (true accepts, false rejects)", () => {
    const permissive = compileToolset([tool("t", true)]);
    const forbidding = compileToolset([tool("t", false)]);
    expect(permissive.ok).toBe(true);
    expect(forbidding.ok).toBe(true);
    if (permissive.ok) expect(permissive.toolset.validateArguments("t", { any: 1 })).toBe(true);
    if (forbidding.ok) expect(forbidding.toolset.validateArguments("t", { any: 1 })).toBe(false);
  });
});
