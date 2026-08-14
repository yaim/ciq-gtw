import { describe, expect, it } from "vitest";
import {
  DONE_FRAME,
  KEEP_ALIVE_COMMENT,
  MAX_CHUNK_CODEPOINTS,
  contentChunk,
  roleChunk,
  splitAnswerIntoChunks,
  sseData,
  sseError,
  terminalChunk,
  type StreamMeta,
} from "../../src/openai/chat-stream.js";
import { COMPLETION_TIMEOUT_ERROR } from "../../src/openai/errors.js";

const META: StreamMeta = {
  id: "chatcmpl_ciq_x",
  created: 1_785_000_000,
  model: "collectiviq-fast",
  index: 0,
};

/** Count Unicode code points (surrogate-pair safe). */
const cp = (s: string): number => Array.from(s).length;

describe("chat-stream frame encoders", () => {
  it("builds the assistant-role opener chunk", () => {
    expect(roleChunk(META)).toEqual({
      id: "chatcmpl_ciq_x",
      object: "chat.completion.chunk",
      created: 1_785_000_000,
      model: "collectiviq-fast",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  });

  it("builds a content-delta chunk", () => {
    expect(contentChunk(META, "hello")).toEqual({
      id: "chatcmpl_ciq_x",
      object: "chat.completion.chunk",
      created: 1_785_000_000,
      model: "collectiviq-fast",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    });
  });

  it("builds the terminal chunk with an empty delta and stop reason", () => {
    expect(terminalChunk(META)).toEqual({
      id: "chatcmpl_ciq_x",
      object: "chat.completion.chunk",
      created: 1_785_000_000,
      model: "collectiviq-fast",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  });

  it("frames a chunk as one SSE data record followed by a blank line", () => {
    const frame = sseData(roleChunk(META));
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame).not.toContain("\n\ndata"); // exactly one record
    expect(JSON.parse(frame.slice("data: ".length, -2))).toMatchObject({
      object: "chat.completion.chunk",
    });
  });

  it("frames a safe error envelope without any upstream detail", () => {
    const frame = sseError(COMPLETION_TIMEOUT_ERROR.body);
    expect(frame).toBe(`data: ${JSON.stringify(COMPLETION_TIMEOUT_ERROR.body)}\n\n`);
    expect(JSON.parse(frame.slice("data: ".length, -2))).toEqual(COMPLETION_TIMEOUT_ERROR.body);
  });

  it("uses the fixed keep-alive comment and terminal [DONE] record", () => {
    expect(KEEP_ALIVE_COMMENT).toBe(": collectiviq-gateway keep-alive\n\n");
    expect(DONE_FRAME).toBe("data: [DONE]\n\n");
  });
});

describe("splitAnswerIntoChunks", () => {
  it("returns no chunks for an empty answer", () => {
    expect(splitAnswerIntoChunks("")).toEqual([]);
  });

  it("returns a single chunk for a short answer (shorter than the minimum is allowed)", () => {
    expect(splitAnswerIntoChunks("hi")).toEqual(["hi"]);
    const short = "a".repeat(20);
    expect(splitAnswerIntoChunks(short)).toEqual([short]);
  });

  it("keeps every chunk within the maximum and reconstructs the answer exactly", () => {
    const inputs = [
      "x".repeat(1000),
      "word ".repeat(400),
      "First sentence. Second sentence! Third? ".repeat(30),
      "Para one line.\n\nPara two line.\n\n".repeat(40),
      // Emoji (surrogate pairs) + CJK + combining marks, well over the max.
      "😀🎉👍🏽 ".repeat(200) + "日本語のテキスト。".repeat(60) + "café ".repeat(80),
    ];
    for (const input of inputs) {
      const chunks = splitAnswerIntoChunks(input);
      expect(chunks.join("")).toBe(input); // exact reconstruction
      for (const chunk of chunks) {
        expect(cp(chunk)).toBeLessThanOrEqual(MAX_CHUNK_CODEPOINTS);
      }
    }
  });

  it("never splits a surrogate pair (each chunk is well-formed UTF-16)", () => {
    // 500 emoji, each a single code point of two UTF-16 code units.
    const input = "😀".repeat(500);
    const chunks = splitAnswerIntoChunks(input);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      // A split surrogate would appear as a lone high/low surrogate code unit.
      for (let i = 0; i < chunk.length; i += 1) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          // high surrogate must be followed by a low surrogate
          const next = chunk.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
      }
      // No lone low surrogate at the START of a chunk (would mean a mid-pair cut).
      const first = chunk.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });

  it("prefers a paragraph boundary near the target", () => {
    // paragraph 1 (120 cp) + blank line, then a long second paragraph so the
    // total exceeds the max and a cut is forced.
    const p1 = "a".repeat(120);
    const input = `${p1}\n\n${"b".repeat(220)}`;
    const chunks = splitAnswerIntoChunks(input);
    expect(chunks.join("")).toBe(input);
    // The first chunk ends exactly at the paragraph break.
    expect(chunks[0]).toBe(`${p1}\n\n`);
  });

  it("prefers a sentence boundary when there is no paragraph break", () => {
    const s1 = `${"a".repeat(118)}. `; // 120 cp, sentence end near target
    const input = `${s1}${"b".repeat(220)}`;
    const chunks = splitAnswerIntoChunks(input);
    expect(chunks.join("")).toBe(input);
    expect(chunks[0]).toBe(s1);
  });

  it("falls back to a whitespace boundary, then a hard cut, deterministically", () => {
    // No paragraph/sentence boundaries; spaces every 10 chars.
    const input = "word01word0 ".repeat(60).trimEnd();
    const a = splitAnswerIntoChunks(input);
    const b = splitAnswerIntoChunks(input);
    expect(a).toEqual(b); // deterministic
    expect(a.join("")).toBe(input);
    // A no-whitespace blob still cuts at the target (hard cut) and reconstructs.
    const blob = "z".repeat(1000);
    const chunks = splitAnswerIntoChunks(blob);
    expect(chunks.join("")).toBe(blob);
    expect(cp(chunks[0] ?? "")).toBe(128); // hard cut at the target
  });
});
