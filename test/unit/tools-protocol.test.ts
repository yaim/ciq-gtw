import { describe, expect, it } from "vitest";
import { compileToolset, type CompiledToolset } from "../../src/tools/schema.js";
import { parseToolEnvelope } from "../../src/tools/protocol.js";
import type { NormalizedToolChoice } from "../../src/tools/types.js";
import { MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_RESPONSE } from "../../src/tools/limits.js";

function toolset(): CompiledToolset {
  const result = compileToolset([
    {
      name: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
        additionalProperties: false,
      },
    },
  ]);
  if (!result.ok) throw new Error("toolset compile failed");
  return result.toolset;
}

const AUTO: NormalizedToolChoice = { kind: "auto" };
const opts = (choice: NormalizedToolChoice = AUTO, parallelToolCalls = true) => ({
  toolset: toolset(),
  choice,
  parallelToolCalls,
});

const toolCallEnvelope = (calls: unknown) =>
  JSON.stringify({ gateway_protocol: "1.0", type: "tool_calls", calls });
const finalEnvelope = (content: string) =>
  JSON.stringify({ gateway_protocol: "1.0", type: "final", content });

describe("parseToolEnvelope — valid envelopes", () => {
  it("parses a bare tool_calls object", () => {
    const env = parseToolEnvelope(
      toolCallEnvelope([{ name: "read", arguments: { path: "a.ts" } }]),
      opts(),
    );
    expect(env.kind).toBe("tool_calls");
    if (env.kind === "tool_calls") {
      expect(env.calls).toEqual([{ name: "read", argumentsJson: '{"path":"a.ts"}' }]);
    }
  });

  it("parses a final envelope", () => {
    const env = parseToolEnvelope(finalEnvelope("all done"), opts());
    expect(env).toEqual({ kind: "final", content: "all done" });
  });

  it("strips exactly one outer ```json fence and surrounding whitespace", () => {
    const raw =
      "  \n```json\n" +
      toolCallEnvelope([{ name: "read", arguments: { path: "a" } }]) +
      "\n```  \n";
    expect(parseToolEnvelope(raw, opts()).kind).toBe("tool_calls");
  });

  it("strips a bare ``` fence (no language token)", () => {
    const raw = "```\n" + finalEnvelope("x") + "\n```";
    expect(parseToolEnvelope(raw, opts())).toEqual({ kind: "final", content: "x" });
  });

  it("accepts an EXPLICIT empty arguments object when the schema allows it", () => {
    const ts = compileToolset([{ name: "ping", parameters: { type: "object" } }]);
    if (!ts.ok) throw new Error("compile");
    const env = parseToolEnvelope(toolCallEnvelope([{ name: "ping", arguments: {} }]), {
      toolset: ts.toolset,
      choice: AUTO,
      parallelToolCalls: true,
    });
    expect(env.kind).toBe("tool_calls");
    if (env.kind === "tool_calls") expect(env.calls[0]?.argumentsJson).toBe("{}");
  });

  it("REJECTS a call with an omitted arguments property (no repair to {})", () => {
    // Regression: an omitted `arguments` must NOT be silently repaired to `{}`.
    // Even a no-argument tool must emit an explicit `"arguments": {}`.
    const ts = compileToolset([{ name: "ping", parameters: { type: "object" } }]);
    if (!ts.ok) throw new Error("compile");
    const env = parseToolEnvelope(toolCallEnvelope([{ name: "ping" }]), {
      toolset: ts.toolset,
      choice: AUTO,
      parallelToolCalls: true,
    });
    expect(env).toEqual({ kind: "invalid" });
  });
});

describe("parseToolEnvelope — rejects malformed input", () => {
  const cases: Array<[string, string]> = [
    ["not JSON at all", "the answer is 42"],
    ["prose before JSON", "Here you go: " + finalEnvelope("x")],
    ["prose after JSON", finalEnvelope("x") + " hope that helps"],
    ["two JSON objects", finalEnvelope("a") + finalEnvelope("b")],
    ["a JSON array, not an object", "[]"],
    ["a bare string", '"just a string"'],
    [
      "wrong protocol version",
      JSON.stringify({ gateway_protocol: "2.0", type: "final", content: "x" }),
    ],
    ["missing gateway_protocol", JSON.stringify({ type: "final", content: "x" })],
    ["unknown type", JSON.stringify({ gateway_protocol: "1.0", type: "search", q: "x" })],
    [
      "unknown envelope field",
      JSON.stringify({ gateway_protocol: "1.0", type: "final", content: "x", extra: 1 }),
    ],
    [
      "final content not a string",
      JSON.stringify({ gateway_protocol: "1.0", type: "final", content: 42 }),
    ],
    ["partial fence (opening only)", "```json\n" + finalEnvelope("x")],
    ["unknown tool name", toolCallEnvelope([{ name: "exec", arguments: {} }])],
    [
      "unknown field in a call",
      toolCallEnvelope([{ name: "read", arguments: { path: "a" }, id: "x" }]),
    ],
    [
      "schema-invalid arguments (missing required)",
      toolCallEnvelope([{ name: "read", arguments: {} }]),
    ],
    [
      "schema-invalid arguments (wrong type)",
      toolCallEnvelope([{ name: "read", arguments: { path: 1 } }]),
    ],
    [
      "additional property rejected by strict schema",
      toolCallEnvelope([{ name: "read", arguments: { path: "a", x: 1 } }]),
    ],
    ["arguments not an object", toolCallEnvelope([{ name: "read", arguments: "a.ts" }])],
    ["empty calls array", toolCallEnvelope([])],
  ];
  for (const [label, raw] of cases) {
    it(`rejects: ${label}`, () => {
      expect(parseToolEnvelope(raw, opts())).toEqual({ kind: "invalid" });
    });
  }

  it("rejects more than the max number of calls", () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_RESPONSE + 1 }, () => ({
      name: "read",
      arguments: { path: "a" },
    }));
    expect(parseToolEnvelope(toolCallEnvelope(calls), opts()).kind).toBe("invalid");
  });

  it("rejects an oversized argument object", () => {
    const big = "x".repeat(MAX_TOOL_ARGUMENT_BYTES + 100);
    const raw = toolCallEnvelope([{ name: "write", arguments: { path: "a", text: big } }]);
    expect(parseToolEnvelope(raw, opts()).kind).toBe("invalid");
  });
});

describe("parseToolEnvelope — tool_choice and parallel enforcement", () => {
  it("required: a final envelope stays final (selector rejects it), a tool call parses", () => {
    const required: NormalizedToolChoice = { kind: "required" };
    expect(parseToolEnvelope(finalEnvelope("no thanks"), opts(required)).kind).toBe("final");
    expect(
      parseToolEnvelope(
        toolCallEnvelope([{ name: "read", arguments: { path: "a" } }]),
        opts(required),
      ).kind,
    ).toBe("tool_calls");
  });

  it("named: only calls to the named function are valid", () => {
    const named: NormalizedToolChoice = { kind: "function", name: "read" };
    expect(
      parseToolEnvelope(toolCallEnvelope([{ name: "read", arguments: { path: "a" } }]), opts(named))
        .kind,
    ).toBe("tool_calls");
    expect(
      parseToolEnvelope(
        toolCallEnvelope([{ name: "write", arguments: { path: "a", text: "b" } }]),
        opts(named),
      ).kind,
    ).toBe("invalid");
  });

  it("rejects multiple calls when parallel calls are disabled (no first-call fallback)", () => {
    const raw = toolCallEnvelope([
      { name: "read", arguments: { path: "a" } },
      { name: "read", arguments: { path: "b" } },
    ]);
    expect(parseToolEnvelope(raw, opts(AUTO, false)).kind).toBe("invalid");
    expect(parseToolEnvelope(raw, opts(AUTO, true)).kind).toBe("tool_calls");
  });
});

describe("parseToolEnvelope — determinism", () => {
  it("produces identical output for identical input", () => {
    const raw = toolCallEnvelope([{ name: "read", arguments: { path: "a", z: undefined } }]);
    const a = JSON.stringify(parseToolEnvelope(raw, opts()));
    const b = JSON.stringify(parseToolEnvelope(raw, opts()));
    expect(a).toBe(b);
  });
});
