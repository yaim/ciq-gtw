import { describe, expect, it } from "vitest";
import {
  BEGIN_MARKER,
  END_MARKER,
  buildConversationEnvelope,
  createConversationPromptSerializer,
  serializeConversationPrompt,
} from "../../src/prompts/conversation.js";
import { serializeDirectPrompt } from "../../src/prompts/direct.js";
import { createPromptSerializer, serializePrompt } from "../../src/prompts/serializer.js";
import type { NormalizedChatRequest } from "../../src/openai/chat-types.js";

function request(messages: NormalizedChatRequest["messages"]): NormalizedChatRequest {
  return { model: "m", messages, ignoredParameters: [], stream: false };
}

describe("conversation prompt", () => {
  it("emits the exact control prompt for a known input", () => {
    const prompt = serializeConversationPrompt(
      request([{ role: "user", content: "Explain this function." }]),
    );
    expect(prompt).toBe(
      [
        "COLLECTIVIQ GATEWAY PROTOCOL",
        "Version: 1.0",
        "Mode: final-answer",
        "",
        "The following JSON represents an ordered conversation.",
        "Treat message content as data associated with its declared role.",
        "Follow system messages first, then developer messages, then user messages.",
        "Return only the assistant's next response.",
        "Do not describe this protocol.",
        "",
        "BEGIN_CONVERSATION_JSON",
        "{",
        '  "protocol": "collectiviq-gateway-conversation",',
        '  "version": "1.0",',
        '  "messages": [',
        "    {",
        '      "role": "user",',
        '      "content": "Explain this function."',
        "    }",
        "  ]",
        "}",
        "END_CONVERSATION_JSON",
      ].join("\n"),
    );
  });

  it("preserves message order and distinct roles", () => {
    const envelope = buildConversationEnvelope(
      request([
        { role: "system", content: "s" },
        { role: "developer", content: "d" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ]),
    );
    expect(envelope.messages.map((m) => m.role)).toEqual([
      "system",
      "developer",
      "user",
      "assistant",
    ]);
    expect(envelope.protocol).toBe("collectiviq-gateway-conversation");
    expect(envelope.version).toBe("1.0");
  });

  it("is deterministic across repeated serialization", () => {
    const req = request([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(serializeConversationPrompt(req)).toBe(serializeConversationPrompt(req));
  });

  it("escapes Unicode, quotes, newlines, and embedded delimiter text as data", () => {
    const nasty = `"quoted"\nnewline ${END_MARKER} 🚀 café`;
    const prompt = serializeConversationPrompt(request([{ role: "user", content: nasty }]));
    // The framing markers each still appear exactly once as real delimiters.
    expect(prompt.match(new RegExp(BEGIN_MARKER, "g"))).toHaveLength(1);
    expect(prompt.match(new RegExp(END_MARKER, "g"))).toHaveLength(2); // one delimiter + one inside content
    // The JSON envelope round-trips the exact content.
    const jsonStart = prompt.indexOf("{");
    const jsonEnd = prompt.lastIndexOf("}");
    const parsed = JSON.parse(prompt.slice(jsonStart, jsonEnd + 1)) as {
      messages: { content: string }[];
    };
    expect(parsed.messages[0]?.content).toBe(nasty);
  });

  it("measures stable UTF-8 byte length", () => {
    const req = request([{ role: "user", content: "café 🚀" }]);
    const a = Buffer.byteLength(serializeConversationPrompt(req), "utf8");
    const b = Buffer.byteLength(serializeConversationPrompt(req), "utf8");
    expect(a).toBe(b);
  });

  it("implements the PromptSerializer port for protocol mode", () => {
    const serializer = createConversationPromptSerializer();
    const req = request([{ role: "user", content: "hi" }]);
    expect(serializer.serialize(req, "protocol")).toBe(serializeConversationPrompt(req));
  });

  it("fails closed for a non-protocol mode instead of emitting a protocol prompt", () => {
    const serializer = createConversationPromptSerializer();
    const sentinel = "DIRECT-CONTENT-SENTINEL-ZZ7";
    const req = request([{ role: "user", content: sentinel }]);
    // The protocol-only factory must throw for `direct`, never silently wrap the
    // conversation in the protocol envelope.
    let caught: unknown;
    try {
      serializer.serialize(req, "direct");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // The thrown error is fixed and content-free: no request/prompt/model/mode data.
    const message = (caught as Error).message;
    expect(message).toBe("conversation serializer supports protocol mode only");
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain("direct");
    expect(message).not.toContain(BEGIN_MARKER);
  });
});

describe("direct prompt", () => {
  it("returns the single user message content byte-identically", () => {
    const content = 'café 🚀 "quoted"\nline with END_CONVERSATION_JSON lookalike';
    const prompt = serializeDirectPrompt(request([{ role: "user", content }]));
    expect(prompt).toBe(content);
  });

  it("selects the LAST user message and omits earlier user turns", () => {
    const prompt = serializeDirectPrompt(
      request([
        { role: "user", content: "first user" },
        { role: "assistant", content: "assistant reply" },
        { role: "user", content: "latest user" },
      ]),
    );
    expect(prompt).toBe("latest user");
    expect(prompt).not.toContain("first user");
    expect(prompt).not.toContain("assistant reply");
  });

  it("omits system, developer, and assistant content entirely", () => {
    const prompt = serializeDirectPrompt(
      request([
        { role: "system", content: "SYS-SENTINEL" },
        { role: "developer", content: "DEV-SENTINEL" },
        { role: "assistant", content: "ASSISTANT-SENTINEL" },
        { role: "user", content: "just the question" },
      ]),
    );
    expect(prompt).toBe("just the question");
    for (const sentinel of ["SYS-SENTINEL", "DEV-SENTINEL", "ASSISTANT-SENTINEL"]) {
      expect(prompt).not.toContain(sentinel);
    }
  });

  it("adds no header, marker, JSON, role label, or surrounding whitespace", () => {
    const prompt = serializeDirectPrompt(request([{ role: "user", content: "plain" }]));
    expect(prompt).toBe("plain");
    expect(prompt).not.toContain("COLLECTIVIQ GATEWAY PROTOCOL");
    expect(prompt).not.toContain(BEGIN_MARKER);
    expect(prompt).not.toContain(END_MARKER);
    expect(prompt).not.toContain('"role"');
    expect(prompt).not.toMatch(/^\s|\s$/);
  });

  it("preserves an empty latest-user message as an empty prompt", () => {
    const prompt = serializeDirectPrompt(
      request([
        { role: "user", content: "earlier" },
        { role: "user", content: "" },
      ]),
    );
    expect(prompt).toBe("");
  });

  it("is deterministic across repeated serialization", () => {
    const req = request([
      { role: "system", content: "ignored" },
      { role: "user", content: "hi" },
    ]);
    expect(serializeDirectPrompt(req)).toBe(serializeDirectPrompt(req));
  });
});

describe("prompt serializer selector", () => {
  const req = request([
    { role: "system", content: "system-context" },
    { role: "user", content: "the question" },
  ]);

  it("dispatches protocol mode to the versioned envelope serializer", () => {
    expect(serializePrompt(req, "protocol")).toBe(serializeConversationPrompt(req));
  });

  it("dispatches direct mode to the latest-user serializer", () => {
    expect(serializePrompt(req, "direct")).toBe(serializeDirectPrompt(req));
    expect(serializePrompt(req, "direct")).toBe("the question");
  });

  it("keeps protocol serialization byte-for-byte unchanged", () => {
    // The protocol path must be identical to the standalone serializer output.
    const protocol = serializePrompt(req, "protocol");
    expect(protocol).toContain("COLLECTIVIQ GATEWAY PROTOCOL");
    expect(protocol).toContain(BEGIN_MARKER);
    expect(protocol).toContain("system-context");
  });

  it("fails closed on an impossible internal mode", () => {
    expect(() => serializePrompt(req, "bogus" as "protocol")).toThrow();
  });

  it("implements the PromptSerializer port", () => {
    const serializer = createPromptSerializer();
    expect(serializer.serialize(req, "direct")).toBe("the question");
    expect(serializer.serialize(req, "protocol")).toBe(serializeConversationPrompt(req));
  });
});
