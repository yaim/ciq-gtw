import { describe, expect, it } from "vitest";
import {
  BEGIN_MARKER,
  END_MARKER,
  buildConversationEnvelope,
  createConversationPromptSerializer,
  serializeConversationPrompt,
} from "../../src/prompts/conversation.js";
import type { NormalizedChatRequest } from "../../src/openai/chat-types.js";

function request(messages: NormalizedChatRequest["messages"]): NormalizedChatRequest {
  return { model: "m", messages, ignoredParameters: [] };
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

  it("implements the PromptSerializer port", () => {
    const serializer = createConversationPromptSerializer();
    const req = request([{ role: "user", content: "hi" }]);
    expect(serializer.serialize(req)).toBe(serializeConversationPrompt(req));
  });
});
