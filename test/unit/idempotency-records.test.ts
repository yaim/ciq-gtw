import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES, OWNER_TOKEN_BYTES } from "../../src/idempotency/limits.js";
import {
  decodeCachedCompletion,
  encodeCachedCompletion,
  PAYLOAD_VERSION,
  type CachedCompletion,
} from "../../src/idempotency/payload.js";
import {
  buildFinalRecord,
  buildRecord,
  decodeRecord,
  encodeRecord,
  newOwnerToken,
  RECORD_STATES,
  RECORD_VERSION,
} from "../../src/idempotency/records.js";

const FINGERPRINT = "Zm9vYmFyLWZpbmdlcnByaW50";
const OWNER = "b3duZXItdG9rZW4";
const SEALED = { i: "AAAAAAAAAAAAAAAA", c: "Y2lwaGVydGV4dA", t: "dGFn" } as const;

describe("newOwnerToken", () => {
  it("mints an unguessable base64url token of the configured size", () => {
    const token = newOwnerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(OWNER_TOKEN_BYTES);
    const seen = new Set(Array.from({ length: 256 }, () => newOwnerToken()));
    expect(seen.size).toBe(256);
  });
});

describe("record encode/decode", () => {
  it("round-trips every non-final state", () => {
    for (const state of ["reserved", "processing", "ambiguous"] as const) {
      const record = buildRecord({
        state,
        fingerprint: FINGERPRINT,
        owner: OWNER,
        expiresAtMs: 1_700_000_000_000,
      });
      const decoded = decodeRecord(encodeRecord(record));
      expect(decoded).toEqual({ ok: true, record });
    }
  });

  it("round-trips a final record with its sealed payload", () => {
    const record = buildFinalRecord({
      fingerprint: FINGERPRINT,
      owner: OWNER,
      expiresAtMs: 1_700_000_000_000,
      payload: SEALED,
    });
    expect(decodeRecord(encodeRecord(record))).toEqual({ ok: true, record });
  });

  it("declares exactly the four documented states", () => {
    expect([...RECORD_STATES]).toEqual(["reserved", "processing", "final", "ambiguous"]);
  });

  it("stores only opaque coordination metadata", () => {
    const encoded = encodeRecord(
      buildFinalRecord({
        fingerprint: FINGERPRINT,
        owner: OWNER,
        expiresAtMs: 1,
        payload: SEALED,
      }),
    );
    // The exact key set is version, state, fingerprint, owner, expiry, payload.
    expect(Object.keys(JSON.parse(encoded) as object).sort()).toEqual([
      "e",
      "f",
      "o",
      "p",
      "s",
      "v",
    ]);
  });
});

describe("decodeRecord: strict validation", () => {
  const valid = JSON.parse(
    encodeRecord(
      buildRecord({
        state: "reserved",
        fingerprint: FINGERPRINT,
        owner: OWNER,
        expiresAtMs: 5,
      }),
    ),
  ) as Record<string, unknown>;

  const rejectsRaw = (raw: string): void => {
    expect(decodeRecord(raw)).toEqual({ ok: false });
  };
  const rejectsObject = (over: Record<string, unknown>): void => {
    rejectsRaw(JSON.stringify({ ...valid, ...over }));
  };

  it("rejects malformed JSON and non-object roots", () => {
    for (const raw of ["", "not json", "[]", '"text"', "1", "null", "true"]) rejectsRaw(raw);
  });

  it("rejects an unsupported or missing version", () => {
    rejectsObject({ v: RECORD_VERSION + 1 });
    rejectsObject({ v: 0 });
    rejectsObject({ v: "1" });
    rejectsRaw(JSON.stringify({ s: "reserved", f: FINGERPRINT, o: OWNER, e: 1 }));
  });

  it("rejects an unknown state", () => {
    for (const s of ["", "RESERVED", "pending", "done", 1, null]) rejectsObject({ s });
  });

  it("rejects an unknown extra key", () => {
    rejectsObject({ extra: 1 });
    rejectsObject({ prompt: "leaked" });
  });

  it("rejects a missing or malformed fingerprint or owner", () => {
    for (const bad of ["", "not base64!", 1, null, {}]) {
      rejectsObject({ f: bad });
      rejectsObject({ o: bad });
    }
    rejectsRaw(JSON.stringify({ v: RECORD_VERSION, s: "reserved", o: OWNER, e: 1 }));
    rejectsRaw(JSON.stringify({ v: RECORD_VERSION, s: "reserved", f: FINGERPRINT, e: 1 }));
  });

  it("rejects a malformed expiry", () => {
    for (const e of [-1, 1.5, "1", null, Number.NaN]) rejectsObject({ e });
  });

  it("requires a payload on final and forbids one elsewhere", () => {
    rejectsObject({ s: "final" }); // final with no payload
    rejectsObject({ s: "reserved", p: SEALED });
    rejectsObject({ s: "processing", p: SEALED });
    rejectsObject({ s: "ambiguous", p: SEALED });
  });

  it("rejects a malformed payload on a final record", () => {
    const final = JSON.parse(
      encodeRecord(
        buildFinalRecord({
          fingerprint: FINGERPRINT,
          owner: OWNER,
          expiresAtMs: 1,
          payload: SEALED,
        }),
      ),
    ) as Record<string, unknown>;
    for (const p of [
      null,
      "text",
      [],
      {},
      { i: SEALED.i, c: SEALED.c },
      { i: SEALED.i, c: SEALED.c, t: SEALED.t, extra: 1 },
      { i: "", c: SEALED.c, t: SEALED.t },
      { i: SEALED.i, c: "not base64!", t: SEALED.t },
    ]) {
      rejectsRaw(JSON.stringify({ ...final, p }));
    }
  });

  it("rejects an oversized document before parsing it", () => {
    const oversized = `{"pad":"${"x".repeat(MAX_RECORD_BYTES)}"}`;
    expect(decodeRecord(oversized)).toEqual({ ok: false });
  });

  it("does not reflect a rejected value", () => {
    const result = decodeRecord('{"v":1,"s":"reserved","f":"SENTINEL!!","o":"x","e":1}');
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });
});

describe("cached payload encode/decode", () => {
  const TEXT: CachedCompletion = {
    id: "chatcmpl_ciq_original",
    created: 1_700_000_000,
    model: "collectiviq-claude-direct",
    result: { kind: "text", content: "the original answer" },
  };
  const TOOLS: CachedCompletion = {
    id: "chatcmpl_ciq_tools",
    created: 1_700_000_001,
    model: "collectiviq-claude-tools",
    result: {
      kind: "tool_calls",
      toolCalls: [
        { id: "call_ciq_01", name: "read", argumentsJson: '{"path":"a.txt"}' },
        { id: "call_ciq_02", name: "test", argumentsJson: "{}" },
      ],
    },
  };

  it("round-trips a text completion", () => {
    expect(decodeCachedCompletion(encodeCachedCompletion(TEXT))).toEqual(TEXT);
  });

  it("round-trips a tool-call completion", () => {
    expect(decodeCachedCompletion(encodeCachedCompletion(TOOLS))).toEqual(TOOLS);
  });

  it("round-trips an empty answer", () => {
    const empty: CachedCompletion = { ...TEXT, result: { kind: "text", content: "" } };
    expect(decodeCachedCompletion(encodeCachedCompletion(empty))).toEqual(empty);
  });

  it("never persists an upstream thread id", () => {
    // A live CompletionResult carries `upstreamThreadId`; the cached shape does
    // not, and the encoder reads only the fields it declares.
    const withThread = {
      ...TEXT,
      result: { kind: "text", content: "answer", upstreamThreadId: "thread-sentinel" },
    } as unknown as CachedCompletion;
    const encoded = encodeCachedCompletion(withThread);
    expect(encoded).not.toContain("thread-sentinel");
    expect(encoded).not.toContain("upstreamThreadId");
  });

  it("rejects malformed, mis-versioned, and structurally invalid payloads", () => {
    const valid = JSON.parse(encodeCachedCompletion(TEXT)) as Record<string, unknown>;
    const rejects = (over: Record<string, unknown>): void => {
      expect(decodeCachedCompletion(JSON.stringify({ ...valid, ...over }))).toBeNull();
    };
    for (const raw of ["", "nope", "[]", "null", '"s"']) {
      expect(decodeCachedCompletion(raw)).toBeNull();
    }
    rejects({ v: PAYLOAD_VERSION + 1 });
    rejects({ id: "" });
    rejects({ c: -1 });
    rejects({ c: "1" });
    rejects({ m: 1 });
    rejects({ k: "other" });
    rejects({ t: 1 });
    rejects({ extra: 1 });
    // A discriminator that disagrees with the fields present.
    rejects({ k: "tool_calls" });
    rejects({ l: [{ i: "a", n: "b", a: "{}" }] }); // text payload carrying calls
  });

  it("rejects malformed tool-call entries", () => {
    const valid = JSON.parse(encodeCachedCompletion(TOOLS)) as Record<string, unknown>;
    for (const l of [
      [],
      "text",
      [null],
      [{ i: "a", n: "b" }],
      [{ i: "a", n: "b", a: 1 }],
      [{ i: "", n: "b", a: "{}" }],
      [{ i: "a", n: "b", a: "{}", extra: 1 }],
    ]) {
      expect(decodeCachedCompletion(JSON.stringify({ ...valid, l }))).toBeNull();
    }
  });
});
