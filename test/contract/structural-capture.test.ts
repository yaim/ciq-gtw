import { describe, expect, it } from "vitest";
import {
  captureStructure,
  STRUCTURAL_CAPTURE_FORMAT,
  type CaptureLimits,
} from "../../src/collectiviq/structural-capture.js";

const LIMITS: CaptureLimits = {
  maxDepth: 6,
  maxArrayItems: 20,
  maxObjectKeys: 40,
  maxOutputBytes: 16_384,
};

describe("structural capture: values and names", () => {
  it("preserves safe field names but collapses values to constant markers", () => {
    const captured = captureStructure({ status: "ok", count: 3, active: true, missing: null });
    expect(captured).toEqual({
      status: "<string>",
      count: "<number>",
      active: "<boolean>",
      missing: "<null>",
    });
  });

  it("replaces credential-like and content-bearing names positionally", () => {
    const captured = captureStructure({
      authorization: "Bearer SECRET",
      apiKey: "SECRET",
      content: "SECRET ANSWER",
      prompt: "SECRET PROMPT",
      email: "a@b.c",
    });
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("email");
    // All five become positional placeholders.
    expect(serialized).toContain("field_0");
    expect(serialized).toContain("field_4");
  });

  it("leaks no original value and no value length", () => {
    const captured = captureStructure({
      thread_id: "thread-SECRET-123",
      source: "gpt-secret",
      note: "a very specific secret string",
    });
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("thread-SECRET-123");
    expect(serialized).not.toContain("gpt-secret");
    expect(serialized).not.toContain("very specific secret");
    // The old length-revealing form is gone entirely.
    expect(serialized).not.toContain("len=");
  });

  it("replaces reserved names positionally to avoid prototype pollution", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as unknown;
    const captured = captureStructure(hostile) as Record<string, unknown>;
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("__proto__");
  });
});

describe("structural capture: arrays", () => {
  it("marks accessor elements unsupported without invoking them", () => {
    const arr: unknown[] = [];
    let invoked = false;
    Object.defineProperty(arr, "0", {
      get() {
        invoked = true;
        return "SECRET";
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(arr, "length", { value: 1 });
    const captured = captureStructure(arr) as unknown[];
    expect(invoked).toBe(false);
    expect(captured[0]).toBe("<unsupported>");
  });

  it("marks sparse-array holes with a constant marker", () => {
    // eslint-disable-next-line no-sparse-arrays
    const captured = captureStructure([1, , 3]) as unknown[];
    expect(captured).toEqual(["<number>", "<hole>", "<number>"]);
  });

  it("bounds array width with a constant truncation marker", () => {
    const wide = Array.from({ length: 1000 }, (_v, i) => `s-${i}`);
    const captured = captureStructure(wide) as unknown[];
    expect(captured.length).toBe(LIMITS.maxArrayItems + 1);
    expect(captured[captured.length - 1]).toBe("<truncated>");
    expect(JSON.stringify(captured)).not.toContain("+");
  });

  it("reads array length via its descriptor and never triggers a proxy get trap", () => {
    let getInvoked = false;
    const proxy = new Proxy([1, 2, 3], {
      get(target, key, receiver): unknown {
        // Any property read (including `length` or an index) would trip this.
        getInvoked = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const captured = captureStructure(proxy) as unknown[];
    expect(getInvoked).toBe(false);
    expect(captured).toEqual(["<number>", "<number>", "<number>"]);
  });

  it("fails closed when the array length descriptor throws", () => {
    const proxy = new Proxy([] as unknown[], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") throw new Error("hostile length");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(captureStructure(proxy)).toBe("<capture-error>");
  });

  it("fails closed when the array length is not a nonnegative safe integer", () => {
    // A proxy target array whose reported length is invalid collapses closed
    // rather than iterating an unbounded or nonsensical range.
    const proxy = new Proxy([] as unknown[], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") {
          return { value: -1, writable: true, enumerable: false, configurable: false };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(captureStructure(proxy)).toBe("<capture-error>");
  });
});

describe("structural capture: hostile input fails closed", () => {
  it("returns a capture-error marker for a throwing proxy", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile");
        },
      },
    );
    expect(captureStructure(proxy)).toBe("<capture-error>");
  });

  it("fails closed when descriptor inspection throws", () => {
    // A throwing `getOwnPropertyDescriptor` trap makes even key enumeration
    // throw, so the whole node collapses to a constant marker.
    const proxy = new Proxy(
      { a: 1, b: 2 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile");
        },
      },
    );
    expect(captureStructure(proxy)).toBe("<capture-error>");
  });

  it("handles cycles without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const captured = captureStructure(cyclic) as Record<string, unknown>;
    expect(() => JSON.stringify(captured)).not.toThrow();
    expect(captured["self"]).toBe("<circular>");
  });
});

describe("structural capture: bounds and determinism", () => {
  it("collapses objects/arrays beyond the depth bound", () => {
    let nested: unknown = { leaf: 1 };
    for (let i = 0; i < 10; i += 1) nested = { deeper: nested };
    const serialized = JSON.stringify(captureStructure(nested, LIMITS));
    expect(serialized).toContain("<object>");
    expect(serialized).not.toContain("leaf");
  });

  it("returns a truncation marker when the encoded size bound is exceeded", () => {
    const captured = captureStructure({ a: 1, b: 2, c: 3 }, { ...LIMITS, maxOutputBytes: 4 });
    expect(captured).toBe("<truncated>");
  });

  it("produces deterministic key ordering regardless of insertion order", () => {
    const a = JSON.stringify(captureStructure({ b: 1, a: 2, c: 3 }));
    const b = JSON.stringify(captureStructure({ c: 3, a: 2, b: 1 }));
    expect(a).toBe(b);
  });

  it("exposes an explicit evidence format version constant", () => {
    // The version is stamped onto real discovery reports (see discovery tests),
    // not onto an isolated envelope helper.
    expect(STRUCTURAL_CAPTURE_FORMAT).toBe(2);
  });
});
