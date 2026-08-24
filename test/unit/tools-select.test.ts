import { describe, expect, it } from "vitest";
import { compileToolset, type CompiledToolset } from "../../src/tools/schema.js";
import { selectGeneration, type SelectionInput } from "../../src/tools/select.js";
import type { ToolCallIdGenerator } from "../../src/tools/ids.js";
import type { NormalizedToolChoice } from "../../src/tools/types.js";

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
  ]);
  if (!result.ok) throw new Error("compile");
  return result.toolset;
}

function fixedIds(): ToolCallIdGenerator {
  let n = 0;
  return { toolCallId: () => `call_ciq_ID${n++}` };
}

const callEnv = (path: string) =>
  JSON.stringify({
    gateway_protocol: "1.0",
    type: "tool_calls",
    calls: [{ name: "read", arguments: { path } }],
  });
const finalEnv = (content: string) =>
  JSON.stringify({ gateway_protocol: "1.0", type: "final", content });

function input(over: Partial<SelectionInput>): SelectionInput {
  return {
    desired: null,
    individuals: [],
    toolset: toolset(),
    choice: { kind: "auto" } satisfies NormalizedToolChoice,
    parallelToolCalls: true,
    selectedLlms: ["claude", "gpt", "gemini"],
    idGen: fixedIds(),
    ...over,
  };
}

describe("selectGeneration — desired source and choice modes", () => {
  it("none: returns the desired text verbatim (no protocol)", () => {
    const result = selectGeneration(
      input({ choice: { kind: "none" }, desired: { content: "plain answer" } }),
    );
    expect(result).toEqual({ ok: true, generation: { kind: "text", content: "plain answer" } });
  });

  it("auto: a valid desired tool envelope wins as desired-source", () => {
    const result = selectGeneration(input({ desired: { content: callEnv("a.ts") } }));
    expect(result.ok).toBe(true);
    if (result.ok && result.generation.kind === "tool_calls") {
      expect(result.generation.source).toBe("desired-source");
      expect(result.generation.calls).toEqual([
        { id: "call_ciq_ID0", name: "read", argumentsJson: '{"path":"a.ts"}' },
      ]);
    }
  });

  it("auto: a valid desired final is ordinary text", () => {
    const result = selectGeneration(input({ desired: { content: finalEnv("hello") } }));
    expect(result).toEqual({ ok: true, generation: { kind: "text", content: "hello" } });
  });

  it("auto: an invalid desired response with no tool candidates falls back to its raw text", () => {
    const result = selectGeneration(input({ desired: { content: "just prose, not protocol" } }));
    expect(result).toEqual({
      ok: true,
      generation: { kind: "text", content: "just prose, not protocol" },
    });
  });

  it("required: no valid tool call → 502 invalid_tool_response (never text)", () => {
    const result = selectGeneration(
      input({
        choice: { kind: "required" },
        desired: { content: finalEnv("I won't call a tool") },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_tool_response" });
  });

  it("named: no valid tool call → 502 invalid_tool_response", () => {
    const result = selectGeneration(
      input({ choice: { kind: "function", name: "read" }, desired: { content: "prose" } }),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_tool_response" });
  });
});

describe("selectGeneration — individual-source consensus", () => {
  it("falls back to a single valid individual when the desired source is invalid", () => {
    const result = selectGeneration(
      input({
        desired: { content: "invalid" },
        individuals: [{ source: "claude", content: callEnv("a.ts"), percentUsage: null }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.generation.kind === "tool_calls") {
      expect(result.generation.source).toBe("individual-single");
    }
  });

  it("prefers the call set with the greatest summed percent_usage", () => {
    const result = selectGeneration(
      input({
        desired: { content: "invalid" },
        individuals: [
          { source: "claude", content: callEnv("a.ts"), percentUsage: 0.2 },
          { source: "gpt", content: callEnv("b.ts"), percentUsage: 0.5 },
          { source: "gemini", content: callEnv("b.ts"), percentUsage: 0.3 }, // b.ts total 0.8 > a.ts 0.2
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.generation.kind === "tool_calls") {
      expect(result.generation.source).toBe("individual-consensus");
      expect(result.generation.calls[0]?.argumentsJson).toBe('{"path":"b.ts"}');
    }
  });

  it("uses agreement count when percent_usage is unavailable", () => {
    const result = selectGeneration(
      input({
        desired: { content: "invalid" },
        individuals: [
          { source: "claude", content: callEnv("a.ts"), percentUsage: null },
          { source: "gpt", content: callEnv("b.ts"), percentUsage: null },
          { source: "gemini", content: callEnv("b.ts"), percentUsage: null }, // b.ts count 2 > a.ts 1
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.generation.kind === "tool_calls") {
      expect(result.generation.calls[0]?.argumentsJson).toBe('{"path":"b.ts"}');
    }
  });

  it("breaks ties by configured selectedLlms order", () => {
    // Two equally-agreed groups (count 1 each); claude precedes gpt in selectedLlms.
    const result = selectGeneration(
      input({
        desired: { content: "invalid" },
        selectedLlms: ["claude", "gpt"],
        individuals: [
          { source: "gpt", content: callEnv("b.ts"), percentUsage: null },
          { source: "claude", content: callEnv("a.ts"), percentUsage: null },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.generation.kind === "tool_calls") {
      expect(result.generation.calls[0]?.argumentsJson).toBe('{"path":"a.ts"}');
    }
  });

  it("is deterministic across repeated identical inputs", () => {
    const build = () =>
      selectGeneration(
        input({
          desired: { content: "invalid" },
          individuals: [
            { source: "claude", content: callEnv("a.ts"), percentUsage: 0.4 },
            { source: "gpt", content: callEnv("b.ts"), percentUsage: 0.4 },
          ],
          selectedLlms: ["claude", "gpt"],
        }),
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
