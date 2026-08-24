import { describe, expect, it } from "vitest";
import { encodeChatCompletion } from "../../src/openai/chat-response.js";
import {
  terminalToolChunk,
  toolCallsChunk,
  type StreamMeta,
} from "../../src/openai/chat-stream.js";
import { canonicalCallSet } from "../../src/tools/canonicalize.js";
import type { ParsedToolCall } from "../../src/tools/types.js";

const CALLS: ParsedToolCall[] = [
  { id: "call_ciq_A", name: "read", argumentsJson: '{"path":"a.ts"}' },
  { id: "call_ciq_B", name: "write", argumentsJson: '{"path":"b.ts","text":"x"}' },
];

describe("encodeChatCompletion — tool-call response", () => {
  it("emits content:null, tool_calls, and finish_reason tool_calls with zero usage", () => {
    const encoded = encodeChatCompletion({
      id: "chatcmpl_ciq_1",
      created: 1_785_933_840,
      model: "collectiviq-claude-tools",
      kind: "tool_calls",
      toolCalls: CALLS,
    });
    expect(encoded.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_ciq_A",
            type: "function",
            function: { name: "read", arguments: '{"path":"a.ts"}' },
          },
          {
            id: "call_ciq_B",
            type: "function",
            function: { name: "write", arguments: '{"path":"b.ts","text":"x"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
    expect(encoded.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("still emits a text response with finish_reason stop", () => {
    const encoded = encodeChatCompletion({
      id: "chatcmpl_ciq_1",
      created: 1,
      model: "m",
      content: "hello",
    });
    expect(encoded.choices[0]?.message).toEqual({ role: "assistant", content: "hello" });
    expect(encoded.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("tool-call SSE chunks", () => {
  const meta: StreamMeta = { id: "chatcmpl_ciq_1", created: 1, model: "m", index: 0 };

  it("emits one indexed tool-call delta using the trusted call ids", () => {
    const chunk = toolCallsChunk(meta, CALLS);
    expect(chunk.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_ciq_A",
        type: "function",
        function: { name: "read", arguments: '{"path":"a.ts"}' },
      },
      {
        index: 1,
        id: "call_ciq_B",
        type: "function",
        function: { name: "write", arguments: '{"path":"b.ts","text":"x"}' },
      },
    ]);
    expect(chunk.choices[0]?.finish_reason).toBeNull();
  });

  it("emits a terminal chunk with finish_reason tool_calls and an empty delta", () => {
    const chunk = terminalToolChunk(meta);
    expect(chunk.choices[0]?.delta).toEqual({});
    expect(chunk.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("keeps the same call ids across the JSON and SSE encodings", () => {
    const json = encodeChatCompletion({
      id: "x",
      created: 1,
      model: "m",
      kind: "tool_calls",
      toolCalls: CALLS,
    });
    const sse = toolCallsChunk(meta, CALLS);
    const jsonIds = json.choices[0]?.message.tool_calls?.map((c) => c.id);
    const sseIds = sse.choices[0]?.delta.tool_calls?.map((c) => c.id);
    expect(jsonIds).toEqual(["call_ciq_A", "call_ciq_B"]);
    expect(sseIds).toEqual(["call_ciq_A", "call_ciq_B"]);
  });
});

describe("canonicalCallSet — determinism", () => {
  it("is order-independent when parallel calls are enabled", () => {
    const a = canonicalCallSet(
      [
        { name: "read", argumentsJson: '{"path":"a"}' },
        { name: "write", argumentsJson: '{"text":"x","path":"b"}' },
      ],
      true,
    );
    const b = canonicalCallSet(
      [
        { name: "write", argumentsJson: '{"path":"b","text":"x"}' },
        { name: "read", argumentsJson: '{"path":"a"}' },
      ],
      true,
    );
    expect(a).toBe(b); // key-sorted args + order-independent
  });

  it("is order-sensitive when parallel calls are disabled", () => {
    const a = canonicalCallSet([{ name: "read", argumentsJson: '{"path":"a"}' }], false);
    const b = canonicalCallSet([{ name: "read", argumentsJson: '{"path":"b"}' }], false);
    expect(a).not.toBe(b);
  });
});
