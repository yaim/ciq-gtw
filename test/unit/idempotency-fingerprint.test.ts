import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprintRequestBody } from "../../src/idempotency/fingerprint.js";
import { MAX_FINGERPRINT_DEPTH } from "../../src/idempotency/limits.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function fp(body: unknown, key: Buffer = KEY): string {
  const result = fingerprintRequestBody(body, key);
  if (!result.ok) throw new Error("expected a fingerprint");
  return result.fingerprint;
}

function rejects(body: unknown): void {
  expect(fingerprintRequestBody(body, KEY)).toEqual({ ok: false });
}

/** A realistic chat-completions body shape. */
function chatBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "collectiviq-claude-direct",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Explain a binary search." },
    ],
    stream: false,
    ...over,
  };
}

describe("fingerprintRequestBody: canonical equivalence", () => {
  it("ignores object-key order recursively", () => {
    const a = { model: "m", messages: [{ role: "user", content: "hi" }], stream: false };
    const b = { stream: false, messages: [{ content: "hi", role: "user" }], model: "m" };
    expect(fp(a)).toBe(fp(b));
  });

  it("ignores JSON whitespace (the parsed values are identical)", () => {
    const compact: unknown = JSON.parse('{"a":1,"b":[2,3]}');
    const spaced: unknown = JSON.parse('{\n  "b" : [ 2 , 3 ],\n  "a" : 1\n}');
    expect(fp(compact)).toBe(fp(spaced));
  });

  it("preserves array order as significant", () => {
    expect(fp({ m: [1, 2] })).not.toBe(fp({ m: [2, 1] }));
    expect(fp(chatBody())).not.toBe(
      fp(
        chatBody({
          messages: [
            { role: "user", content: "Explain a binary search." },
            { role: "system", content: "You are helpful." },
          ],
        }),
      ),
    );
  });

  it("is deterministic across repeated calls", () => {
    const body = chatBody();
    expect(fp(body)).toBe(fp(body));
    expect(fp(body)).toBe(fp(chatBody()));
  });

  it("normalizes -0 to 0 so the two spellings agree", () => {
    expect(fp({ n: -0 })).toBe(fp({ n: 0 }));
  });
});

describe("fingerprintRequestBody: differences", () => {
  it("differs for any changed submitted field", () => {
    const base = fp(chatBody());
    expect(fp(chatBody({ model: "collectiviq-claude" }))).not.toBe(base);
    expect(fp(chatBody({ stream: true }))).not.toBe(base);
    expect(fp(chatBody({ temperature: 0.5 }))).not.toBe(base);
    expect(fp(chatBody({ messages: [{ role: "user", content: "different" }] }))).not.toBe(base);
  });

  it("differs when TOLERATED-and-discarded tool metadata changes", () => {
    // `tools` / `tool_choice` are accepted and thrown away for a text-only
    // model, but they are still part of the submitted body, so they MUST
    // participate in the fingerprint.
    const withoutTools = fp(chatBody());
    const withTools = fp(
      chatBody({
        tools: [
          {
            type: "function",
            function: { name: "read", description: "Read a file", parameters: { type: "object" } },
          },
        ],
        tool_choice: "auto",
      }),
    );
    const differentTools = fp(
      chatBody({
        tools: [
          {
            type: "function",
            function: { name: "edit", description: "Read a file", parameters: { type: "object" } },
          },
        ],
        tool_choice: "auto",
      }),
    );
    expect(withTools).not.toBe(withoutTools);
    expect(differentTools).not.toBe(withTools);
    expect(fp(chatBody({ tool_choice: "none" }))).not.toBe(fp(chatBody({ tool_choice: "auto" })));
  });

  it("distinguishes an absent key from an explicit null", () => {
    expect(fp({ a: 1 })).not.toBe(fp({ a: 1, b: null }));
  });

  it("distinguishes types that share a textual form", () => {
    expect(fp({ a: 1 })).not.toBe(fp({ a: "1" }));
    expect(fp({ a: true })).not.toBe(fp({ a: "true" }));
    expect(fp({ a: [] })).not.toBe(fp({ a: {} }));
  });

  it("cannot be collided by shifting characters between a key and a value", () => {
    // Length-prefixed tokens make the stream unambiguous.
    expect(fp({ ab: "c" })).not.toBe(fp({ a: "bc" }));
    expect(fp({ a: "b", c: "" })).not.toBe(fp({ a: "b", "c\u0000": "" }));
  });

  it("is keyed: the same body under a different subkey differs", () => {
    expect(fp(chatBody(), KEY)).not.toBe(fp(chatBody(), OTHER_KEY));
  });
});

describe("fingerprintRequestBody: lossless UTF-16 string encoding", () => {
  // A raw UTF-8 encoding maps every unpaired surrogate — and a literal U+FFFD —
  // onto the same three replacement bytes, so distinct bodies would collide and
  // a repeat could replay a cached answer instead of returning 409.
  const HIGH_A = "\ud800";
  const HIGH_B = "\ud801";
  const LOW = "\udc00";
  const REPLACEMENT = "\ufffd";

  it("distinguishes distinct lone surrogates as VALUES", () => {
    expect(fp({ m: HIGH_A })).not.toBe(fp({ m: HIGH_B }));
    expect(fp({ m: HIGH_A })).not.toBe(fp({ m: LOW }));
  });

  it("distinguishes distinct lone surrogates as OBJECT KEYS", () => {
    expect(fp({ [HIGH_A]: 1 })).not.toBe(fp({ [HIGH_B]: 1 }));
    expect(fp({ [HIGH_A]: 1 })).not.toBe(fp({ [LOW]: 1 }));
  });

  it("distinguishes each lone surrogate from a real U+FFFD", () => {
    for (const surrogate of [HIGH_A, HIGH_B, LOW]) {
      expect(fp({ m: surrogate })).not.toBe(fp({ m: REPLACEMENT }));
      expect(fp({ [surrogate]: 1 })).not.toBe(fp({ [REPLACEMENT]: 1 }));
    }
  });

  it("distinguishes a lone surrogate from the well-formed pair containing it", () => {
    // "\ud800\udc00" is a single astral code point; the parts are not.
    expect(fp({ m: `${HIGH_A}${LOW}` })).not.toBe(fp({ m: HIGH_A }));
    expect(fp({ m: `${HIGH_A}${LOW}` })).not.toBe(fp({ m: `${HIGH_A}x${LOW}` }));
  });

  it("keeps surrogate-bearing fingerprints deterministic and key-order insensitive", () => {
    const a = { [HIGH_A]: HIGH_B, other: 1 };
    const b = { other: 1, [HIGH_A]: HIGH_B };
    expect(fp(a)).toBe(fp(b));
    expect(fp(a)).toBe(fp({ [HIGH_A]: HIGH_B, other: 1 }));
  });

  it("cannot be forged by string content shaped like the token grammar", () => {
    // The canonical stream uses `n`/`t`/`f`/`#`/`s`/`k`/`[`/`]`/`{`/`}` as token
    // leaders. String content that imitates them must never be re-read as
    // structure — self-delimitation comes from the JSON quoting.
    const pairs: readonly (readonly [unknown, unknown])[] = [
      [{ x: "n" }, { x: null }],
      [{ x: "t" }, { x: true }],
      [{ x: "f" }, { x: false }],
      [{ x: "#1" }, { x: 1 }],
      [{ x: "[]" }, { x: [] }],
      [{ x: "{}" }, { x: {} }],
      [{ x: 's3:"a"' }, { x: "a" }],
      [{ x: 'ks1:"y"' }, { y: "" }],
      [{ x: "a", y: "b" }, { x: 'a"},"y":"b' }],
      [{ "": "" }, {}],
      [{ x: [1, 2] }, { x: ["1", "2"] }],
      [{ x: [[1]] }, { x: [1] }],
    ];
    for (const [a, b] of pairs) {
      expect(fp(a)).not.toBe(fp(b));
    }
    // Every one of those bodies is distinct from every other.
    const all = pairs.flatMap(([a, b]) => [fp(a), fp(b)]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("still round-trips ordinary and astral text without expansion surprises", () => {
    for (const text of ["", "plain", "héllo — ✓", "😀 astral", "tab\tand\nnewline", '"quoted\\']) {
      expect(fp({ m: text })).toBe(fp({ m: text }));
    }
    // Distinct ordinary strings stay distinct.
    expect(fp({ m: "a" })).not.toBe(fp({ m: "b" }));
    expect(fp({ m: '"' })).not.toBe(fp({ m: "\\" }));
    // An escaped-looking literal is not confused with the character it escapes.
    expect(fp({ m: "\\n" })).not.toBe(fp({ m: "\n" }));
    expect(fp({ m: "\\ud800" })).not.toBe(fp({ m: HIGH_A }));
  });
});

describe("fingerprintRequestBody: descriptor safety and fail-closed bounds", () => {
  it("never invokes a getter and rejects an accessor property", () => {
    let invoked = 0;
    const hostile = {};
    Object.defineProperty(hostile, "model", {
      get() {
        invoked += 1;
        return "m";
      },
      enumerable: true,
      configurable: true,
    });
    rejects(hostile);
    expect(invoked).toBe(0);
  });

  it("never invokes toJSON", () => {
    let invoked = 0;
    const body = {
      a: 1,
      toJSON() {
        invoked += 1;
        return { a: 2 };
      },
    };
    // `toJSON` is a function VALUE, which is not JSON-representable: fail closed.
    rejects(body);
    expect(invoked).toBe(0);
  });

  it("never triggers a Proxy get trap", () => {
    const traps: string[] = [];
    const target = { model: "m", messages: [] as unknown[] };
    const proxied = new Proxy(target, {
      get(t, p, r): unknown {
        traps.push(String(p));
        return Reflect.get(t, p, r);
      },
    });
    const result = fingerprintRequestBody(proxied, KEY);
    expect(result.ok).toBe(true);
    expect(traps).toEqual([]);
  });

  it("fails closed when a descriptor read throws", () => {
    const hostile = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor");
        },
      },
    );
    rejects(hostile);
  });

  it("fails closed on a cycle", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    rejects(cyclic);

    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    rejects(cyclicArray);
  });

  it("allows a shared (acyclic) reference in two sibling positions", () => {
    const shared = { x: 1 };
    const result = fingerprintRequestBody({ a: shared, b: shared }, KEY);
    expect(result.ok).toBe(true);
  });

  it("fails closed on a sparse array or an array with an extra own property", () => {
    const sparse = [1, 2, 3];
    // A genuine hole (not `undefined`): `delete` is the only way to create one.
    Reflect.deleteProperty(sparse, 1);
    rejects(sparse);

    const extra = [1, 2];
    (extra as unknown as Record<string, unknown>)["extra"] = 3;
    rejects(extra);
  });

  it("fails closed on exotic objects and non-plain prototypes", () => {
    rejects(new Date());
    rejects(new Map([["a", 1]]));
    rejects(new Set([1]));
    rejects(Object.create({ inherited: 1 }));
    rejects(/regex/u);
  });

  it("fails closed on values JSON cannot represent", () => {
    rejects({ a: undefined });
    rejects({ a: () => 1 });
    rejects({ a: Symbol("s") });
    rejects({ a: 10n });
    rejects({ a: Number.NaN });
    rejects({ a: Number.POSITIVE_INFINITY });
    rejects(undefined);
  });

  it("fails closed on a symbol-keyed property", () => {
    const body: Record<string | symbol, unknown> = { a: 1 };
    body[Symbol("hidden")] = 2;
    rejects(body);
  });

  it("fails closed beyond the depth bound without overflowing the stack", () => {
    const build = (depth: number): unknown => {
      let node: unknown = 1;
      for (let i = 0; i < depth; i += 1) node = { n: node };
      return node;
    };
    // Well within the bound.
    expect(fingerprintRequestBody(build(MAX_FINGERPRINT_DEPTH - 2), KEY).ok).toBe(true);
    // Far beyond it: iterative traversal rejects rather than throwing a
    // RangeError from deep recursion.
    expect(fingerprintRequestBody(build(200_000), KEY)).toEqual({ ok: false });
  });

  it("accepts a JSON key literally named __proto__ without prototype pollution", () => {
    const polluted = JSON.parse('{"__proto__":{"x":1},"a":2}') as Record<string, unknown>;
    const plain = JSON.parse('{"a":2}') as Record<string, unknown>;
    const withProto = fingerprintRequestBody(polluted, KEY);
    expect(withProto.ok).toBe(true);
    // The `__proto__` key participates, so the two bodies differ.
    expect(withProto.ok && withProto.fingerprint).not.toBe(fp(plain));
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("distinguishes constructor and prototype keys as ordinary data", () => {
    const a: unknown = JSON.parse('{"constructor":1}');
    const b: unknown = JSON.parse('{"prototype":1}');
    expect(fp(a)).not.toBe(fp(b));
  });

  it("accepts scalar and empty roots", () => {
    for (const root of [null, true, false, 0, 1.5, "", "text", [], {}]) {
      expect(fingerprintRequestBody(root, KEY).ok).toBe(true);
    }
  });
});
