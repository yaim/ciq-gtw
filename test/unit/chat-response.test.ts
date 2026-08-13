import { describe, expect, it } from "vitest";
import { encodeChatCompletion } from "../../src/openai/chat-response.js";

describe("encodeChatCompletion", () => {
  it("emits exactly the supported fields with zero usage", () => {
    const response = encodeChatCompletion({
      id: "chatcmpl_ciq_abc",
      created: 1_785_933_840,
      model: "collectiviq-consensus",
      content: "The generated answer.",
    });
    expect(response).toEqual({
      id: "chatcmpl_ciq_abc",
      object: "chat.completion",
      created: 1_785_933_840,
      model: "collectiviq-consensus",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "The generated answer." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
});
