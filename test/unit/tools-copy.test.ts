import { describe, expect, it } from "vitest";
import { deepFreezeJson, safeJsonCopy } from "../../src/tools/copy.js";
import { canonicalCall, canonicalJson } from "../../src/tools/canonicalize.js";
import { compileToolset } from "../../src/tools/schema.js";

const L = { maxBytes: 1_000_000, maxDepth: 512 };

/** A proxy whose ordinary `get` trap throws — proving copy never uses `[[Get]]`. */
function noGetProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    get() {
      throw new Error("get trap must never be invoked");
    },
  });
}

describe("safeJsonCopy — fidelity and byte accounting", () => {
  it("copies plain JSON into a fresh, equal tree", () => {
    const input = { a: 1, b: "x", c: [true, null, { d: 2.5 }], e: false };
    const result = safeJsonCopy(input, L);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      expect(result.value).not.toBe(input); // a fresh copy, not a reference
    }
  });

  it("accumulates bytes equal to JSON.stringify of the copy", () => {
    const inputs: unknown[] = [
      "hello",
      42,
      -3.14,
      true,
      false,
      null,
      [],
      {},
      { nested: { deep: [1, "two", { three: 3 }] } },
      'emoji 😀 and quotes " \\ /',
      "日本語のテキスト",
    ];
    for (const input of inputs) {
      const result = safeJsonCopy(input, L);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.value), "utf8"));
      }
    }
  });

  it("does not invoke a value getter anywhere (descriptor-only traversal)", () => {
    const hostile = { tools: noGetProxy({ a: noGetProxy({ b: 1 }) }) };
    // The proxies expose descriptors (their own data props) but throw on `[[Get]]`.
    const result = safeJsonCopy(hostile, L);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ tools: { a: { b: 1 } } });
  });
});

describe("safeJsonCopy — fail-closed anomalies", () => {
  it("rejects accessor (getter) properties without invoking them", () => {
    let invoked = false;
    const obj = {};
    Object.defineProperty(obj, "x", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    expect(safeJsonCopy(obj, L).ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it("rejects a getter descriptor that throws (fail closed, no leak)", () => {
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom-should-never-surface");
        },
        ownKeys() {
          return ["x"];
        },
      },
    );
    expect(safeJsonCopy(proxy, L).ok).toBe(false);
  });

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(safeJsonCopy(a, L).ok).toBe(false);
  });

  it("rejects sparse arrays and array holes", () => {
    const sparse = [1, , 3] as unknown[]; // eslint-disable-line no-sparse-arrays
    expect(safeJsonCopy(sparse, L).ok).toBe(false);
  });

  it("rejects non-finite numbers, functions, symbols, bigint, and undefined", () => {
    expect(safeJsonCopy({ x: Number.NaN }, L).ok).toBe(false);
    expect(safeJsonCopy({ x: Number.POSITIVE_INFINITY }, L).ok).toBe(false);
    expect(safeJsonCopy({ x: () => 1 }, L).ok).toBe(false);
    expect(safeJsonCopy({ x: Symbol("s") }, L).ok).toBe(false);
    expect(safeJsonCopy({ x: 1n }, L).ok).toBe(false);
    expect(safeJsonCopy({ x: undefined }, L).ok).toBe(false);
  });

  it("rejects symbol keys", () => {
    const obj = { a: 1 } as Record<string | symbol, unknown>;
    obj[Symbol("s")] = 2;
    expect(safeJsonCopy(obj, L).ok).toBe(false);
  });

  it("rejects exotic (non-plain) objects", () => {
    expect(safeJsonCopy(new Date(), L).ok).toBe(false);
    expect(safeJsonCopy(new Map(), L).ok).toBe(false);
    class Custom {
      x = 1;
    }
    expect(safeJsonCopy(new Custom(), L).ok).toBe(false);
  });

  it("rejects structures deeper than maxDepth (iterative, no stack overflow)", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) deep = [deep];
    expect(safeJsonCopy(deep, { maxBytes: 10_000_000, maxDepth: 512 }).ok).toBe(false);
  });

  it("rejects a tree over the byte budget", () => {
    const big = { s: "x".repeat(2000) };
    expect(safeJsonCopy(big, { maxBytes: 100, maxDepth: 512 }).ok).toBe(false);
  });

  it("omits non-enumerable own properties (matching JSON.stringify)", () => {
    const obj = { a: 1 };
    Object.defineProperty(obj, "hidden", { enumerable: false, value: 2 });
    const result = safeJsonCopy(obj, L);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }), "utf8"));
    }
  });
});

describe("safeJsonCopy — dangerous JSON keys stay ordinary own properties", () => {
  // Regression: a plain `record[key] = …` assignment treats an own JSON key named
  // "__proto__" as the inherited prototype SETTER, mutating the prototype and
  // silently dropping the key (so the copy loses data and its byte count lies).
  it("keeps a top-level __proto__ as an own data property without prototype mutation", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as object;
    const result = safeJsonCopy(input, L);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.prototype.hasOwnProperty.call(result.value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype); // not mutated
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined(); // no global pollution
    // The encoding round-trips exactly and the byte total is truthful.
    expect(JSON.stringify(result.value)).toBe('{"__proto__":{"polluted":true},"ok":1}');
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.value), "utf8"));
  });

  it("keeps nested __proto__ / constructor / prototype keys as own properties", () => {
    const input = JSON.parse(
      '{"outer":{"__proto__":1,"constructor":2,"prototype":3,"safe":4}}',
    ) as object;
    const result = safeJsonCopy(input, L);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outer = (result.value as { outer: Record<string, unknown> }).outer;
    expect(Object.keys(outer).sort()).toEqual(["__proto__", "constructor", "prototype", "safe"]);
    expect(Object.getPrototypeOf(outer)).toBe(Object.prototype);
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.value), "utf8"));
  });

  it("does not mutate the input object", () => {
    const input = JSON.parse('{"__proto__":{"x":1},"a":2}') as Record<string, unknown>;
    const before = JSON.stringify(input);
    safeJsonCopy(input, L);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("still fails closed on an accessor named __proto__", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "__proto__", {
      enumerable: true,
      configurable: true,
      get: () => 1,
    });
    expect(safeJsonCopy(obj, L).ok).toBe(false);
  });

  it("compiles and validates a schema that preserves a __proto__ property key", () => {
    // additionalProperties:false must SEE the __proto__ key (and reject it),
    // proving the key survives copy → schema validation as an ordinary property.
    const compiled = compileToolset([
      {
        name: "t",
        parameters: {
          type: "object",
          properties: { a: { type: "number" } },
          additionalProperties: false,
        },
      },
    ]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const args = safeJsonCopy(JSON.parse('{"a":1,"__proto__":9}'), L);
    expect(args.ok).toBe(true);
    if (!args.ok) return;
    expect(compiled.toolset.validateArguments("t", args.value)).toBe(false);
  });

  it("canonicalizes distinct __proto__-bearing objects to distinct keys", () => {
    // Before the fix both collapsed to {"a":2} because the key was dropped.
    const a = canonicalCall({ name: "x", argumentsJson: '{"__proto__":1,"a":2}' });
    const b = canonicalCall({ name: "x", argumentsJson: '{"a":2}' });
    expect(a).not.toBe(b);
    expect(a).toContain("__proto__");
    expect(canonicalJson(JSON.parse('{"b":1,"__proto__":2}'))).toBe('{"__proto__":2,"b":1}');
  });
});

describe("deepFreezeJson", () => {
  it("deeply freezes a nested trusted JSON tree in place", () => {
    const copied = safeJsonCopy({ a: { b: [1, { c: 2 }] } }, L);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const frozen = deepFreezeJson(copied.value);
    expect(frozen).toBe(copied.value); // same reference
    expect(Object.isFrozen(frozen)).toBe(true);
    const root = frozen as { a: { b: [number, { c: number }] } };
    expect(Object.isFrozen(root.a)).toBe(true);
    expect(Object.isFrozen(root.a.b)).toBe(true);
    expect(Object.isFrozen(root.a.b[1])).toBe(true);
  });

  it("returns primitives unchanged", () => {
    expect(deepFreezeJson(5)).toBe(5);
    expect(deepFreezeJson(null)).toBe(null);
    expect(deepFreezeJson("s")).toBe("s");
  });
});
