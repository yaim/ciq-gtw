import { describe, expect, it } from "vitest";
import { normalizeToolRequest } from "../../src/tools/request.js";
import type { ProbedField } from "../../src/tools/request.js";
import type { NormalizedPriorToolCall, ToolHistoryMessage } from "../../src/tools/types.js";

const present = (value: unknown): ProbedField => ({ present: true, value });
const absent: ProbedField = { present: false, value: undefined };

const readTool = {
  type: "function",
  function: {
    name: "read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

function build(over: {
  tools?: ProbedField;
  toolChoice?: ProbedField;
  parallelToolCalls?: ProbedField;
  messages?: readonly ToolHistoryMessage[];
}) {
  return normalizeToolRequest({
    tools: over.tools ?? absent,
    toolChoice: over.toolChoice ?? absent,
    parallelToolCalls: over.parallelToolCalls ?? absent,
    messages: over.messages ?? [{ role: "user" }],
  });
}

const assistantCall = (id: string, name: string, argumentsJson: string): ToolHistoryMessage => ({
  role: "assistant",
  toolCalls: [{ id, name, argumentsJson } satisfies NormalizedPriorToolCall],
});
const toolResult = (toolCallId: string): ToolHistoryMessage => ({ role: "tool", toolCallId });

describe("normalizeToolRequest — definitions and choice", () => {
  it("normalizes tools and defaults an omitted choice to auto", () => {
    const result = build({ tools: present([readTool]) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools.map((t) => t.name)).toEqual(["read"]);
      expect(result.value.choice).toEqual({ kind: "auto" });
      expect(result.value.parallelToolCalls).toBe(true);
      expect(result.value.toolset.has("read")).toBe(true);
    }
  });

  it("defaults an omitted choice to none when no tools are present", () => {
    const result = build({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.choice).toEqual({ kind: "none" });
  });

  it("honors parallel_tool_calls: false", () => {
    const result = build({ tools: present([readTool]), parallelToolCalls: present(false) });
    expect(result.ok && result.value.parallelToolCalls).toBe(false);
  });

  it("honors an explicit parallel_tool_calls: true", () => {
    const result = build({ tools: present([readTool]), parallelToolCalls: present(true) });
    expect(result.ok && result.value.parallelToolCalls).toBe(true);
  });

  it("defaults parallel_tool_calls to true when absent", () => {
    const result = build({ tools: present([readTool]) });
    expect(result.ok && result.value.parallelToolCalls).toBe(true);
  });

  it("rejects a non-boolean parallel_tool_calls (param parallel_tool_calls)", () => {
    // Regression: a non-boolean must be a stable rejection, NOT tolerated as the
    // default `true`.
    for (const value of [null, "true", 1, 0, {}, [], "false"]) {
      expect(build({ tools: present([readTool]), parallelToolCalls: present(value) })).toEqual({
        ok: false,
        param: "parallel_tool_calls",
      });
    }
  });

  it("deep-freezes the retained tool schemas (immutable)", () => {
    const result = build({ tools: present([readTool]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const params = result.value.tools[0]?.parameters as { properties: { path: unknown } };
    expect(Object.isFrozen(result.value.tools)).toBe(true);
    expect(Object.isFrozen(result.value.tools[0])).toBe(true);
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.isFrozen(params.properties)).toBe(true);
  });

  it("freezes the synthesized default {} schema for a tool with omitted parameters", () => {
    const noParams = { type: "function", function: { name: "noparams" } };
    const result = build({ tools: present([noParams]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools[0]?.parameters).toEqual({});
    expect(Object.isFrozen(result.value.tools[0]?.parameters)).toBe(true);
  });

  it("freezes every normalized tool_choice variant", () => {
    const named = build({
      tools: present([readTool]),
      toolChoice: present({ type: "function", function: { name: "read" } }),
    });
    expect(named.ok && Object.isFrozen(named.value.choice)).toBe(true);
    for (const c of ["auto", "none", "required"] as const) {
      const r = build({ tools: present([readTool]), toolChoice: present(c) });
      expect(r.ok && Object.isFrozen(r.value.choice)).toBe(true);
    }
    // The omitted-choice defaults are frozen too.
    const dflt = build({ tools: present([readTool]) });
    expect(dflt.ok && Object.isFrozen(dflt.value.choice)).toBe(true);
    const none = build({});
    expect(none.ok && Object.isFrozen(none.value.choice)).toBe(true);
  });

  it("rejects required/named choice with no declared tools", () => {
    expect(build({ toolChoice: present("required") })).toEqual({ ok: false, param: "tool_choice" });
    expect(
      build({ toolChoice: present({ type: "function", function: { name: "read" } }) }),
    ).toEqual({ ok: false, param: "tool_choice" });
  });

  it("rejects a named choice that does not reference a declared tool", () => {
    expect(
      build({
        tools: present([readTool]),
        toolChoice: present({ type: "function", function: { name: "write" } }),
      }),
    ).toEqual({ ok: false, param: "tool_choice" });
  });

  it("rejects a malformed tool_choice value", () => {
    expect(build({ tools: present([readTool]), toolChoice: present("maybe") })).toEqual({
      ok: false,
      param: "tool_choice",
    });
  });

  it("rejects a non-array or over-budget tools value (param tools)", () => {
    expect(build({ tools: present("not an array") })).toEqual({ ok: false, param: "tools" });
    expect(build({ tools: present([{ type: "function", function: { name: "" } }]) })).toEqual({
      ok: false,
      param: "tools",
    });
  });

  it("fails closed on a malformed tool schema (param tools)", () => {
    const bad = { type: "function", function: { name: "t", parameters: { type: 5 } } };
    expect(build({ tools: present([bad]) })).toEqual({ ok: false, param: "tools" });
  });
});

describe("normalizeToolRequest — prior tool history", () => {
  const args = '{"path":"a.ts"}';
  const withTools = (messages: readonly ToolHistoryMessage[]) =>
    build({ tools: present([readTool]), toolChoice: present("auto"), messages });

  it("accepts a well-formed call → result linkage", () => {
    const result = withTools([
      { role: "user" },
      assistantCall("call_1", "read", args),
      toolResult("call_1"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an orphan tool result (no matching call)", () => {
    expect(withTools([{ role: "user" }, toolResult("call_missing")])).toEqual({
      ok: false,
      param: "messages",
    });
  });

  it("rejects an unresolved call (no linked result)", () => {
    expect(withTools([assistantCall("call_1", "read", args)])).toEqual({
      ok: false,
      param: "messages",
    });
  });

  it("rejects a duplicate result for one call", () => {
    expect(
      withTools([
        assistantCall("call_1", "read", args),
        toolResult("call_1"),
        toolResult("call_1"),
      ]),
    ).toEqual({ ok: false, param: "messages" });
  });

  it("rejects a duplicate call id", () => {
    expect(
      withTools([
        assistantCall("dup", "read", args),
        assistantCall("dup", "read", args),
        toolResult("dup"),
      ]),
    ).toEqual({ ok: false, param: "messages" });
  });

  it("rejects a call to an undeclared tool", () => {
    expect(withTools([assistantCall("c1", "exec", args), toolResult("c1")])).toEqual({
      ok: false,
      param: "messages",
    });
  });

  it("rejects a call with schema-invalid arguments", () => {
    expect(withTools([assistantCall("c1", "read", "{}"), toolResult("c1")])).toEqual({
      ok: false,
      param: "messages",
    });
  });

  it("rejects a call with unparseable argument JSON", () => {
    expect(withTools([assistantCall("c1", "read", "{not json"), toolResult("c1")])).toEqual({
      ok: false,
      param: "messages",
    });
  });
});
