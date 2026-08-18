import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGES,
  MAX_TEXT_PARTS_PER_MESSAGE,
  MAX_TOOL_SCHEMA_BYTES,
  MAX_TOOLS,
  validateChatRequest,
  type ModelResolver,
} from "../../src/openai/chat-request.js";
import type { VirtualModel } from "../../src/config/schema.js";

const user = (content: unknown) => ({ role: "user", content });

/** A minimal virtual model with the requested tool mode and prompt mode. */
function model(
  toolMode: VirtualModel["toolMode"],
  id = "m",
  promptMode: VirtualModel["promptMode"] = "protocol",
): VirtualModel {
  return {
    id,
    displayName: id,
    selectedLlms: ["gpt"],
    generateCombined: false,
    answerSource: "gpt",
    toolMode,
    promptMode,
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
  };
}

/** Resolvers used across the suite (default: every id resolves to a disabled model). */
const resolveDisabled: ModelResolver = (id) => model("disabled", id);
const resolveEmulated: ModelResolver = (id) => model("emulated", id);
const resolveNative: ModelResolver = (id) => model("native", id);
const resolveNone: ModelResolver = () => undefined;
/** A `promptMode: "direct"` disabled model (still text-only, no tool calling). */
const resolveDirect: ModelResolver = (id) => model("disabled", id, "direct");

/** An OpenCode-shaped function-tool definition (the SDK's legacy nested form). */
const openCodeTool = (name: string) => ({
  type: "function",
  function: {
    name,
    description: "A synthetic coding tool.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
});

/**
 * A single-tool collection whose only variable is an ASCII description of
 * `descBytes` characters. Because ASCII adds exactly one JSON byte per char, the
 * collection's total JSON byte size is `baseBytes + descBytes`, so callers can
 * target an exact aggregate size.
 */
const toolsWithAsciiDescription = (descBytes: number): unknown[] => [
  { type: "function", function: { name: "t", description: "x".repeat(descBytes) } },
];

/** Assert a rejection with an exact status/type/code/param. */
function expectReject(
  body: unknown,
  status: number,
  code: string,
  param: string | null,
  resolve: ModelResolver = resolveDisabled,
): void {
  const result = validateChatRequest(body, resolve);
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
  it("accepts a minimal request and returns the resolved model", () => {
    const result = validateChatRequest({ model: "m", messages: [user("hi")] }, resolveDisabled);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.model).toBe("m");
      expect(result.request.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(result.request.ignoredParameters).toEqual([]);
      expect(result.model.id).toBe("m");
      expect(result.model.toolMode).toBe("disabled");
    }
  });

  it("accepts all four text roles in order", () => {
    const messages = [
      { role: "system", content: "s" },
      { role: "developer", content: "d" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    const result = validateChatRequest({ model: "m", messages }, resolveDisabled);
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
    const result = validateChatRequest(
      {
        model: "m",
        messages: [
          user([
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ]),
        ],
      },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.messages[0]?.content).toBe("a\nb");
  });

  it("treats an empty content-part array as empty string", () => {
    const result = validateChatRequest({ model: "m", messages: [user([])] }, resolveDisabled);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.messages[0]?.content).toBe("");
  });

  it("records ignored parameter names (sorted) without their values", () => {
    const result = validateChatRequest(
      {
        model: "m",
        messages: [user("hi")],
        temperature: 0.7,
        top_p: 0.9,
        seed: 42,
        user: "abc",
      },
      resolveDisabled,
    );
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
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], temperature: undefined },
      resolveDisabled,
    );
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
    const result = validateChatRequest(body, resolveDisabled);
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
    const result = validateChatRequest(body, resolveDisabled);
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

  it("normalizes stream to false when absent or exactly false", () => {
    const absent = validateChatRequest({ model: "m", messages: [user("hi")] }, resolveDisabled);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.request.stream).toBe(false);

    const explicit = validateChatRequest(
      { model: "m", messages: [user("hi")], stream: false },
      resolveDisabled,
    );
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.request.stream).toBe(false);
  });

  it("normalizes stream to true for exactly stream:true (Phase 2 synthetic SSE)", () => {
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], stream: true },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.stream).toBe(true);
  });

  it("rejects stream:null, explicit undefined, and every non-boolean stream value", () => {
    // Presence with a non-boolean value fails closed — including an explicit
    // `undefined` supplied directly to the normalization boundary — and the
    // value is never coerced.
    for (const stream of [null, undefined, "false", "true", 0, 1, {}]) {
      expectReject(
        { model: "m", messages: [user("hi")], stream },
        400,
        "invalid_request",
        "stream",
      );
    }
  });

  it("rejects the presence of every model-independent deferred feature field, even empty/null/undefined/harmless", () => {
    // Presence alone rejects — including an explicit `undefined` supplied directly
    // to the normalization boundary — and the value is never read. `tools` and
    // `tool_choice` are handled by the model-aware bridge (tested separately).
    const deferred: Record<string, unknown[]> = {
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
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], parallel_tool_calls: true },
      resolveDisabled,
    );
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
    expect(
      validateChatRequest({ model: "m", messages: [user("hi")], n: 1 }, resolveDisabled).ok,
    ).toBe(true);
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

  it("returns 404 for an unknown or case-mismatched model without inspecting tool metadata", () => {
    // Model-not-found precedes the tool bridge: the tool policy is unknown until
    // the model resolves, so an unknown model with tool metadata is a 404.
    expectReject(
      { model: "nope", messages: [user("hi")], tools: [openCodeTool("read")] },
      404,
      "model_not_found",
      "model",
      resolveNone,
    );
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
    const result = validateChatRequest({ model: "m", messages: [message] }, resolveDisabled);
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
    const result = validateChatRequest(
      { model: "m", messages: [user(secret)], n: 2 },
      resolveDisabled,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(secret);
  });
});

describe("validateChatRequest — tool-compatibility bridge (toolMode: disabled)", () => {
  it("accepts a non-empty OpenCode-shaped tools array and records only the name", () => {
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: [openCodeTool("read"), openCodeTool("edit")] },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.ignoredParameters).toEqual(["tools"]);
      // The definitions are never retained on the normalized request.
      expect(Object.hasOwn(result.request, "tools")).toBe(false);
      const serialized = JSON.stringify(result.request);
      expect(serialized).not.toContain("function");
      expect(serialized).not.toContain("parameters");
    }
  });

  it("accepts an empty tools array and an exactly-128-entry array", () => {
    const empty = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: [] },
      resolveDisabled,
    );
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.request.ignoredParameters).toEqual(["tools"]);

    const max = Array.from({ length: MAX_TOOLS }, (_, i) => openCodeTool(`t${i}`));
    const atLimit = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: max },
      resolveDisabled,
    );
    expect(atLimit.ok).toBe(true);
    if (atLimit.ok) expect(atLimit.request.ignoredParameters).toEqual(["tools"]);
  });

  it("rejects a tools array over 128 entries", () => {
    const over = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => openCodeTool(`t${i}`));
    expectReject(
      { model: "m", messages: [user("hi")], tools: over },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("rejects a non-array, null, or explicit-undefined tools value", () => {
    for (const tools of [{}, "read", 5, null, undefined]) {
      expectReject(
        { model: "m", messages: [user("hi")], tools },
        400,
        "unsupported_parameter",
        "tools",
      );
    }
  });

  it("rejects an accessor-backed tool entry without invoking its getters (byte accounting cannot accept executable descriptors)", () => {
    // Byte accounting reads data-property descriptors only; an accessor anywhere
    // in the collection fails closed, and its getter is never invoked.
    let entryReads = 0;
    const hostileEntry = {
      get type() {
        entryReads += 1;
        return "function";
      },
      get function() {
        entryReads += 1;
        return { name: "leak" };
      },
    };
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: [hostileEntry] },
      resolveDisabled,
    );
    expect(result.ok).toBe(false);
    expect(entryReads).toBe(0);
    if (!result.ok) {
      expect(result.error.body.error.param).toBe("tools");
      expect(result.error.body.error.code).toBe("unsupported_parameter");
      expect(JSON.stringify(result.error)).not.toContain("leak");
    }
  });

  it("never invokes an accessor-backed tools getter and fails closed", () => {
    let reads = 0;
    const body = {
      model: "m",
      messages: [user("hi")],
      get tools() {
        reads += 1;
        return [];
      },
    };
    const result = validateChatRequest(body, resolveDisabled);
    expect(reads).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
      expect(result.error.body.error.param).toBe("tools");
      expect(result.error.body.error.code).toBe("unsupported_parameter");
    }
  });

  it("fails closed when a descriptor/proxy read throws for tools", () => {
    const target = { model: "m", messages: [user("hi")], tools: [] };
    const body = new Proxy(target, {
      getOwnPropertyDescriptor(t, key) {
        if (key === "tools") throw new Error("hostile descriptor");
        return Object.getOwnPropertyDescriptor(t, key);
      },
    });
    const result = validateChatRequest(body, resolveDisabled);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.body.error.param).toBe("tools");
      // The thrown value is never inspected or serialized.
      expect(JSON.stringify(result.error)).not.toContain("hostile descriptor");
    }
  });

  it("accepts tool_choice 'auto' and 'none', recording only the name", () => {
    for (const choice of ["auto", "none"] as const) {
      const result = validateChatRequest(
        { model: "m", messages: [user("hi")], tool_choice: choice },
        resolveDisabled,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.request.ignoredParameters).toEqual(["tool_choice"]);
    }
  });

  it("rejects tool_choice 'required', named functions, objects, null, undefined, and malformed values", () => {
    const values: unknown[] = [
      "required",
      "REQUIRED",
      "unknown",
      { type: "function", function: { name: "read" } },
      { type: "auto" },
      {},
      null,
      undefined,
      1,
      true,
    ];
    for (const tool_choice of values) {
      expectReject(
        { model: "m", messages: [user("hi")], tool_choice },
        400,
        "unsupported_parameter",
        "tool_choice",
      );
    }
  });

  it("never invokes an accessor-backed tool_choice getter and fails closed", () => {
    let reads = 0;
    const body = {
      model: "m",
      messages: [user("hi")],
      get tool_choice() {
        reads += 1;
        return "auto";
      },
    };
    const result = validateChatRequest(body, resolveDisabled);
    expect(reads).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.body.error.param).toBe("tool_choice");
  });

  it("validates tools before tool_choice when both are invalid", () => {
    // A non-array `tools` and a `required` `tool_choice` are both invalid; the
    // deterministic order surfaces the `tools` violation first.
    expectReject(
      { model: "m", messages: [user("hi")], tools: "bad", tool_choice: "required" },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("merges accepted tool names into the sorted, frozen, value-free ignored collection", () => {
    const result = validateChatRequest(
      {
        model: "m",
        messages: [user("hi")],
        temperature: 0.5,
        tools: [openCodeTool("read")],
        tool_choice: "auto",
      },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.ignoredParameters).toEqual(["temperature", "tool_choice", "tools"]);
      expect(Object.isFrozen(result.request.ignoredParameters)).toBe(true);
      expect(JSON.stringify(result.request.ignoredParameters)).not.toContain("read");
    }
  });
});

describe("validateChatRequest — tool-collection byte budget + descriptor-only accounting", () => {
  it("accepts a realistic multi-tool collection well under the byte budget", () => {
    const tools = Array.from({ length: 20 }, (_, i) => openCodeTool(`tool_${i}`));
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], tools },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.ignoredParameters).toEqual(["tools"]);
  });

  it("accepts a collection at exactly the byte budget and rejects one byte over", () => {
    const base = Buffer.byteLength(JSON.stringify(toolsWithAsciiDescription(0)), "utf8");
    const pad = MAX_TOOL_SCHEMA_BYTES - base;

    const atLimit = toolsWithAsciiDescription(pad);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(MAX_TOOL_SCHEMA_BYTES);
    const under = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: atLimit },
      resolveDisabled,
    );
    expect(under.ok).toBe(true);

    const over = toolsWithAsciiDescription(pad + 1);
    expect(Buffer.byteLength(JSON.stringify(over), "utf8")).toBe(MAX_TOOL_SCHEMA_BYTES + 1);
    expectReject(
      { model: "m", messages: [user("hi")], tools: over },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("counts UTF-8 multibyte and escaped-string bytes exactly (by encoded size, not char count)", () => {
    // "€" is 3 UTF-8 bytes, "😀" is 4, and each of " \\ \n \t escapes to 2 bytes.
    const multibyte = "€".repeat(1000) + "😀".repeat(1000) + '"\\\n\t';
    const build = (asciiPad: number): unknown[] => [
      { type: "function", function: { name: "t", description: multibyte + "x".repeat(asciiPad) } },
    ];
    const base = Buffer.byteLength(JSON.stringify(build(0)), "utf8");
    // Encoded size reflects multibyte/escape bytes, not the ~2004 UTF-16 chars.
    expect(base).toBeGreaterThan(1000 * 3 + 1000 * 4);

    const pad = MAX_TOOL_SCHEMA_BYTES - base;
    const atLimit = build(pad);
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(MAX_TOOL_SCHEMA_BYTES);
    expect(
      validateChatRequest({ model: "m", messages: [user("hi")], tools: atLimit }, resolveDisabled)
        .ok,
    ).toBe(true);
    expectReject(
      { model: "m", messages: [user("hi")], tools: build(pad + 1) },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("counts multiple tools toward one aggregate budget", () => {
    const bigDesc = "x".repeat(1_200_000);
    const one = [{ type: "function", function: { name: "a", description: bigDesc } }];
    expect(
      validateChatRequest({ model: "m", messages: [user("hi")], tools: one }, resolveDisabled).ok,
    ).toBe(true);

    const two = [
      { type: "function", function: { name: "a", description: bigDesc } },
      { type: "function", function: { name: "b", description: bigDesc } },
    ];
    expectReject(
      { model: "m", messages: [user("hi")], tools: two },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("records zero ordinary get-trap calls while accounting a proxied tools array", () => {
    let getCalls = 0;
    const realTools = [openCodeTool("read"), openCodeTool("edit")];
    const proxied = new Proxy(realTools, {
      get(target, prop, receiver): unknown {
        getCalls += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: proxied },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    expect(getCalls).toBe(0);
  });

  it("fails closed when an index descriptor read throws during accounting", () => {
    const arr = [openCodeTool("read")];
    const proxied = new Proxy(arr, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") throw new Error("boom-index");
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: proxied },
      resolveDisabled,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.body.error.param).toBe("tools");
      expect(JSON.stringify(result.error)).not.toContain("boom-index");
    }
  });

  it("never invokes a toJSON function or getter inside a tool entry (fails closed)", () => {
    let toJsonFnCalls = 0;
    const withToJsonFn = [
      {
        type: "function",
        function: {
          name: "t",
          toJSON() {
            toJsonFnCalls += 1;
            return "leak";
          },
        },
      },
    ];
    const r1 = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: withToJsonFn },
      resolveDisabled,
    );
    expect(r1.ok).toBe(false); // a function value is not JSON-representable
    expect(toJsonFnCalls).toBe(0);

    let toJsonGetterCalls = 0;
    const withToJsonGetter = [
      {
        type: "function",
        function: {
          get toJSON() {
            toJsonGetterCalls += 1;
            return () => "leak";
          },
        },
      },
    ];
    const r2 = validateChatRequest(
      { model: "m", messages: [user("hi")], tools: withToJsonGetter },
      resolveDisabled,
    );
    expect(r2.ok).toBe(false); // an accessor fails closed
    expect(toJsonGetterCalls).toBe(0);
  });

  it("rejects a sparse tools array (holes)", () => {
    const sparse: unknown[] = [openCodeTool("a")];
    sparse[2] = openCodeTool("b"); // index 1 is a hole; length becomes 3
    expectReject(
      { model: "m", messages: [user("hi")], tools: sparse },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("rejects a cyclic tool structure without hanging or throwing", () => {
    const entry: Record<string, unknown> = { type: "function" };
    entry["self"] = entry; // cycle
    expectReject(
      { model: "m", messages: [user("hi")], tools: [entry] },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("rejects unsupported primitive values anywhere in the collection", () => {
    const cases: unknown[] = [
      [{ type: "function", function: { name: 1n } }], // bigint
      [{ type: "function", function: { name: Symbol("x") } }], // symbol value
      [{ type: "function", function: { name: () => 0 } }], // function
      [{ type: "function", function: { name: undefined } }], // undefined value
      [{ type: "function", function: { n: Number.NaN } }], // non-finite number
      [{ type: "function", function: { n: Number.POSITIVE_INFINITY } }], // non-finite number
    ];
    for (const tools of cases) {
      expectReject(
        { model: "m", messages: [user("hi")], tools },
        400,
        "unsupported_parameter",
        "tools",
      );
    }
  });

  it("rejects exotic (non-plain) objects in the collection", () => {
    const cases: unknown[] = [
      [{ type: "function", when: new Date() }],
      [{ type: "function", map: new Map([["a", 1]]) }],
      [new Date()],
    ];
    for (const tools of cases) {
      expectReject(
        { model: "m", messages: [user("hi")], tools },
        400,
        "unsupported_parameter",
        "tools",
      );
    }
  });

  it("rejects a symbol-keyed object in the collection", () => {
    const entry = { type: "function", [Symbol("hidden")]: 1 };
    expectReject(
      { model: "m", messages: [user("hi")], tools: [entry] },
      400,
      "unsupported_parameter",
      "tools",
    );
  });

  it("rejects an over-deep nested structure without overflowing the stack", () => {
    let deep: unknown = {};
    for (let i = 0; i < 2000; i += 1) deep = { nested: deep };
    const tools = [{ type: "function", function: { schema: deep } }];
    expectReject(
      { model: "m", messages: [user("hi")], tools },
      400,
      "unsupported_parameter",
      "tools",
    );
  });
});

describe("validateChatRequest — tool metadata against non-disabled models", () => {
  it("fails closed for tools sent to an emulated or native model (mode not activated)", () => {
    for (const resolve of [resolveEmulated, resolveNative]) {
      expectReject(
        { model: "m", messages: [user("hi")], tools: [openCodeTool("read")] },
        400,
        "unsupported_parameter",
        "tools",
        resolve,
      );
    }
  });

  it("fails closed for tool_choice sent to an emulated or native model, even 'auto'/'none'", () => {
    for (const resolve of [resolveEmulated, resolveNative]) {
      for (const choice of ["auto", "none"] as const) {
        expectReject(
          { model: "m", messages: [user("hi")], tool_choice: choice },
          400,
          "unsupported_parameter",
          "tool_choice",
          resolve,
        );
      }
    }
  });
});

describe("validateChatRequest — immutability", () => {
  it("returns a deeply frozen normalized request", () => {
    const result = validateChatRequest(
      {
        model: "m",
        messages: [user("a"), { role: "system", content: "b" }],
        temperature: 0.5,
      },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const req = result.request;
    expect(Object.isFrozen(req)).toBe(true);
    expect(Object.isFrozen(req.messages)).toBe(true);
    expect(Object.isFrozen(req.ignoredParameters)).toBe(true);
    for (const message of req.messages) expect(Object.isFrozen(message)).toBe(true);
  });

  it("silently ignores mutation attempts on every level (strict-mode throws)", () => {
    const result = validateChatRequest(
      { model: "m", messages: [user("a")], top_p: 0.9 },
      resolveDisabled,
    );
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

describe("validateChatRequest — direct prompt mode", () => {
  it("accepts a direct-mode request that has a user-role message", () => {
    const result = validateChatRequest(
      { model: "m", messages: [{ role: "system", content: "s" }, user("hi")] },
      resolveDirect,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The normalized request is unchanged by the prompt mode: full history is
      // preserved here; the direct serializer selects the latest user content
      // downstream during prepare().
      expect(result.model.promptMode).toBe("direct");
      expect(result.request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    }
  });

  it("rejects a direct-mode request with no user-role message (fixed 400)", () => {
    expectReject(
      {
        model: "m",
        messages: [
          { role: "system", content: "s" },
          { role: "assistant", content: "a" },
        ],
      },
      400,
      "invalid_request",
      "messages",
      resolveDirect,
    );
  });

  it("still accepts the same no-user role sequence for a protocol model", () => {
    const result = validateChatRequest(
      {
        model: "m",
        messages: [
          { role: "system", content: "s" },
          { role: "assistant", content: "a" },
        ],
      },
      resolveDisabled,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.promptMode).toBe("protocol");
  });

  it("rejects the direct no-user request before reflecting any content", () => {
    const result = validateChatRequest(
      { model: "m", messages: [{ role: "developer", content: "SECRET-DEVELOPER" }] },
      resolveDirect,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error.body)).not.toContain("SECRET-DEVELOPER");
      expect(result.error.body.error.type).toBe("invalid_request_error");
    }
  });
});
