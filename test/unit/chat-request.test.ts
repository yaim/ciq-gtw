import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGES,
  MAX_TEXT_PARTS_PER_MESSAGE,
  validateChatRequest,
} from "../../src/openai/chat-request.js";

const user = (content: unknown) => ({ role: "user", content });

/** Assert a rejection with an exact status/type/code/param. */
function expectReject(body: unknown, status: number, code: string, param: string | null): void {
  const result = validateChatRequest(body);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.status).toBe(status);
    expect(result.error.body.error.code).toBe(code);
    expect(result.error.body.error.param).toBe(param);
    expect(result.error.body.error.type).toBe(
      status === 400 ? "invalid_request_error" : result.error.body.error.type,
    );
  }
}

describe("validateChatRequest — accept", () => {
  it("accepts a minimal request", () => {
    const result = validateChatRequest({ model: "m", messages: [user("hi")] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.model).toBe("m");
      expect(result.request.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(result.request.ignoredParameters).toEqual([]);
    }
  });

  it("accepts all four text roles in order", () => {
    const messages = [
      { role: "system", content: "s" },
      { role: "developer", content: "d" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    const result = validateChatRequest({ model: "m", messages });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.messages.map((m) => m.role)).toEqual([
        "system",
        "developer",
        "user",
        "assistant",
      ]);
    }
  });

  it("accepts text content parts and joins them with newlines", () => {
    const result = validateChatRequest({
      model: "m",
      messages: [
        user([
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ]),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.messages[0]?.content).toBe("a\nb");
  });

  it("treats an empty content-part array as empty string", () => {
    const result = validateChatRequest({ model: "m", messages: [user([])] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.messages[0]?.content).toBe("");
  });

  it("records ignored parameter names (sorted) without their values", () => {
    const result = validateChatRequest({
      model: "m",
      messages: [user("hi")],
      temperature: 0.7,
      top_p: 0.9,
      seed: 42,
      user: "abc",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.ignoredParameters).toEqual(["seed", "temperature", "top_p", "user"]);
      // Values never surface anywhere in the normalized request.
      expect(JSON.stringify(result.request)).not.toContain("0.7");
      expect(JSON.stringify(result.request)).not.toContain("abc");
    }
  });

  it("records an ignored-parameter name by own-property presence, even when its value is explicit undefined", () => {
    // Presence semantics: an own property counts as supplied regardless of value,
    // and the value is never read to decide whether to record the name.
    const result = validateChatRequest({
      model: "m",
      messages: [user("hi")],
      temperature: undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.ignoredParameters).toEqual(["temperature"]);
  });

  it("does not record an ignored-parameter name inherited from the prototype", () => {
    // Only OWN properties count; a name on the prototype chain is never supplied.
    const proto = { temperature: 0.7 };
    const body = Object.assign(Object.create(proto) as object, {
      model: "m",
      messages: [user("hi")],
    });
    const result = validateChatRequest(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.ignoredParameters).toEqual([]);
  });

  it("records an ignored-parameter name without invoking its value getter", () => {
    // Presence is decided by Object.hasOwn, which never triggers a getter, so a
    // value is never read merely to record the name.
    let reads = 0;
    const body = {
      model: "m",
      messages: [user("hi")],
      get temperature() {
        reads += 1;
        return 0.7;
      },
    };
    const result = validateChatRequest(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.ignoredParameters).toEqual(["temperature"]);
    expect(reads).toBe(0);
  });
});

describe("validateChatRequest — reject", () => {
  it("rejects a non-object body", () => {
    expectReject(null, 400, "invalid_request", null);
    expectReject([], 400, "invalid_request", null);
    expectReject("x", 400, "invalid_request", null);
  });

  it("accepts stream absent or exactly false", () => {
    expect(validateChatRequest({ model: "m", messages: [user("hi")] }).ok).toBe(true);
    expect(validateChatRequest({ model: "m", messages: [user("hi")], stream: false }).ok).toBe(
      true,
    );
  });

  it("rejects stream:true, stream:null, explicit undefined, and every non-false stream value", () => {
    // An explicit `undefined` own property is supplied (presence), so it is
    // rejected exactly like any other non-false value.
    for (const stream of [true, null, undefined, "false", 0, {}]) {
      expectReject(
        { model: "m", messages: [user("hi")], stream },
        400,
        "unsupported_parameter",
        "stream",
      );
    }
  });

  it("rejects the presence of every deferred feature field, even empty/null/undefined/harmless", () => {
    // Presence alone rejects — including an explicit `undefined` supplied directly
    // to the normalization boundary — and the value is never read.
    const deferred: Record<string, unknown[]> = {
      tools: [[{ type: "function" }], [], null, undefined, {}],
      tool_choice: ["required", "auto", "none", null, undefined, { type: "function" }],
      response_format: [{ type: "json_object" }, null, undefined, "text"],
      audio: [{ voice: "x" }, null, undefined],
      logprobs: [true, false, null, undefined, 0, ""],
    };
    for (const [field, values] of Object.entries(deferred)) {
      for (const value of values) {
        expectReject(
          { model: "m", messages: [user("hi")], [field]: value },
          400,
          "unsupported_parameter",
          field,
        );
      }
    }
  });

  it("keeps parallel_tool_calls an ignored compatibility option when no tools are present", () => {
    const result = validateChatRequest({
      model: "m",
      messages: [user("hi")],
      parallel_tool_calls: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.ignoredParameters).toEqual(["parallel_tool_calls"]);
  });

  it("rejects a missing or empty model", () => {
    expectReject({ messages: [user("hi")] }, 400, "invalid_request", "model");
    expectReject({ model: "", messages: [user("hi")] }, 400, "invalid_request", "model");
    expectReject({ model: 5, messages: [user("hi")] }, 400, "invalid_request", "model");
  });

  it("rejects n != 1, including an explicit undefined", () => {
    expectReject({ model: "m", messages: [user("hi")], n: 2 }, 400, "invalid_request", "n");
    expectReject({ model: "m", messages: [user("hi")], n: undefined }, 400, "invalid_request", "n");
    expect(validateChatRequest({ model: "m", messages: [user("hi")], n: 1 }).ok).toBe(true);
  });

  it("rejects missing, empty, or non-array messages", () => {
    expectReject({ model: "m" }, 400, "invalid_request", "messages");
    expectReject({ model: "m", messages: [] }, 400, "invalid_request", "messages");
    expectReject({ model: "m", messages: "x" }, 400, "invalid_request", "messages");
  });

  it("rejects more than MAX_MESSAGES messages", () => {
    const many = Array.from({ length: MAX_MESSAGES + 1 }, () => user("hi"));
    expectReject({ model: "m", messages: many }, 400, "invalid_request", "messages");
  });

  it("rejects a tool-role message", () => {
    expectReject(
      { model: "m", messages: [{ role: "tool", content: "r", tool_call_id: "c" }] },
      400,
      "invalid_request",
      "messages",
    );
  });

  it("rejects the presence of message tool_calls, even empty, null, or explicit undefined", () => {
    for (const toolCalls of [[{ id: "c" }], [], null, undefined]) {
      expectReject(
        { model: "m", messages: [{ role: "assistant", content: "text", tool_calls: toolCalls }] },
        400,
        "unsupported_parameter",
        "messages",
      );
    }
  });

  it("does not treat a prototype-inherited tool_calls as supplied", () => {
    // Only an OWN `tool_calls` is a tool signal; one on the prototype is ignored.
    const proto = { tool_calls: [{ id: "c" }] };
    const message = Object.assign(Object.create(proto) as object, {
      role: "assistant",
      content: "text",
    });
    const result = validateChatRequest({ model: "m", messages: [message] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.messages[0]?.content).toBe("text");
  });

  it("rejects image and unknown content-part types with unsupported_content_type", () => {
    expectReject(
      { model: "m", messages: [user([{ type: "image_url", image_url: { url: "x" } }])] },
      400,
      "unsupported_content_type",
      "messages",
    );
    expectReject(
      { model: "m", messages: [user([{ type: "input_audio", input_audio: {} }])] },
      400,
      "unsupported_content_type",
      "messages",
    );
  });

  it("rejects malformed content and content parts", () => {
    expectReject({ model: "m", messages: [user(null)] }, 400, "invalid_request", "messages");
    expectReject({ model: "m", messages: [user(5)] }, 400, "invalid_request", "messages");
    expectReject(
      { model: "m", messages: [user([{ type: "text" }])] },
      400,
      "invalid_request",
      "messages",
    );
    expectReject({ model: "m", messages: [user(["nope"])] }, 400, "invalid_request", "messages");
  });

  it("rejects too many content parts", () => {
    const parts = Array.from({ length: MAX_TEXT_PARTS_PER_MESSAGE + 1 }, () => ({
      type: "text",
      text: "x",
    }));
    expectReject({ model: "m", messages: [user(parts)] }, 400, "invalid_request", "messages");
  });

  it("never reflects a submitted value in a rejection", () => {
    const secret = "SUPER-SECRET-PROMPT-TEXT";
    const result = validateChatRequest({ model: "m", messages: [user(secret)], n: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(secret);
  });
});

describe("validateChatRequest — immutability", () => {
  it("returns a deeply frozen normalized request", () => {
    const result = validateChatRequest({
      model: "m",
      messages: [user("a"), { role: "system", content: "b" }],
      temperature: 0.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = result.request;
    expect(Object.isFrozen(req)).toBe(true);
    expect(Object.isFrozen(req.messages)).toBe(true);
    expect(Object.isFrozen(req.ignoredParameters)).toBe(true);
    for (const message of req.messages) expect(Object.isFrozen(message)).toBe(true);
  });

  it("silently ignores mutation attempts on every level (strict-mode throws)", () => {
    const result = validateChatRequest({ model: "m", messages: [user("a")], top_p: 0.9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = result.request;
    // Frozen: writes throw in this module's strict (ESM) context.
    expect(() => {
      (req as { model: string }).model = "hacked";
    }).toThrow();
    expect(() => {
      (req.messages as { length: number }).length = 0;
    }).toThrow();
    expect(() => {
      (req.messages[0] as { content: string }).content = "hacked";
    }).toThrow();
    expect(() => {
      (req.ignoredParameters as string[]).push("x");
    }).toThrow();
    // Values are unchanged after the failed mutations.
    expect(req.model).toBe("m");
    expect(req.messages[0]?.content).toBe("a");
    expect(req.ignoredParameters).toEqual(["top_p"]);
  });
});
