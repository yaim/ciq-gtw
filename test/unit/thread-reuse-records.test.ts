/**
 * Strict decoding of the versioned thread-reuse record (Phase 5A;
 * specification sections 5.1.1, 22.2).
 *
 * Everything a hostile or corrupt Redis value could be must decode to
 * `{ ok: false }`, which the coordinator maps to a fixed `503`. That includes
 * state/field combinations the state machine can never produce — an `active`
 * mapping with no thread, a leased `ambiguous` tombstone — because accepting one
 * would let forged Redis state drive the machine into a shape its transitions
 * assume is impossible.
 *
 * Every value here is synthetic.
 */
import { describe, expect, it } from "vitest";
import { MAX_REUSE_RECORD_BYTES } from "../../src/thread-reuse/limits.js";
import {
  decodeReuseRecord,
  encodeReuseRecord,
  newReuseOwnerToken,
  REUSE_RECORD_STATES,
  REUSE_RECORD_VERSION,
  type ThreadReuseRecord,
} from "../../src/thread-reuse/index.js";

const OWNER = "b3Jhbmdl";
const SEALED = { i: "AAAA", c: "BBBB", t: "CCCC" } as const;
const LEASE_AT = 1_700_000_030_000;

function record(over: Partial<ThreadReuseRecord> = {}): ThreadReuseRecord {
  return { v: REUSE_RECORD_VERSION, s: "reserved", o: OWNER, l: LEASE_AT, ...over };
}

/** Encode a raw object that TypeScript would otherwise reject. */
function raw(value: unknown): string {
  return JSON.stringify(value);
}

describe("thread-reuse records", () => {
  it("mints unguessable, base64url owner tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 256; i += 1) {
      const token = newReuseOwnerToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(256);
  });

  it("round-trips every legal state", () => {
    const legal: ThreadReuseRecord[] = [
      record(),
      record({ p: SEALED }),
      record({ s: "processing", p: SEALED }),
      record({ s: "committed", l: 0, p: SEALED }),
      record({ s: "active", l: 0, p: SEALED }),
      record({ s: "ambiguous", l: 0 }),
    ];
    for (const value of legal) {
      const decoded = decodeReuseRecord(encodeReuseRecord(value));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.record).toEqual(value);
    }
    // Every declared state is covered above.
    expect(new Set(legal.map((r) => r.s))).toEqual(new Set(REUSE_RECORD_STATES));
  });

  it("rejects an unsupported version", () => {
    expect(decodeReuseRecord(raw({ ...record(), v: 2 })).ok).toBe(false);
    expect(decodeReuseRecord(raw({ ...record(), v: "1" })).ok).toBe(false);
    expect(decodeReuseRecord(raw({ s: "reserved", o: OWNER, l: LEASE_AT })).ok).toBe(false);
  });

  it("rejects an unknown or missing key", () => {
    expect(decodeReuseRecord(raw({ ...record(), extra: 1 })).ok).toBe(false);
    expect(decodeReuseRecord(raw({ v: REUSE_RECORD_VERSION, s: "reserved", l: LEASE_AT })).ok).toBe(
      false,
    );
    expect(decodeReuseRecord(raw({ v: REUSE_RECORD_VERSION, s: "reserved", o: OWNER })).ok).toBe(
      false,
    );
  });

  it("rejects a malformed root or malformed JSON", () => {
    for (const value of ["", "not json", "null", "42", '"text"', "[]", raw([record()])]) {
      expect(decodeReuseRecord(value).ok).toBe(false);
    }
  });

  it("rejects an unknown state or a non-base64url owner", () => {
    expect(decodeReuseRecord(raw({ ...record(), s: "final" })).ok).toBe(false);
    expect(decodeReuseRecord(raw({ ...record(), s: 1 })).ok).toBe(false);
    for (const owner of ["", "has space", "has/slash", "x".repeat(129), 7, null]) {
      expect(decodeReuseRecord(raw({ ...record(), o: owner })).ok).toBe(false);
    }
  });

  it("rejects a non-integer, negative, or unsafe lease deadline", () => {
    for (const lease of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "1700", null]) {
      expect(decodeReuseRecord(raw({ ...record(), l: lease })).ok).toBe(false);
    }
  });

  it("requires a lease on exactly the two leased states", () => {
    // A leased state with no deadline could never expire; an unleased state with
    // one would be taken over on a comparison that should not apply to it.
    expect(decodeReuseRecord(raw(record({ l: 0 }))).ok).toBe(false);
    expect(decodeReuseRecord(raw({ ...record({ s: "processing", p: SEALED }), l: 0 })).ok).toBe(
      false,
    );
    expect(decodeReuseRecord(raw({ ...record({ s: "active", p: SEALED }), l: LEASE_AT })).ok).toBe(
      false,
    );
    expect(
      decodeReuseRecord(raw({ ...record({ s: "committed", p: SEALED }), l: LEASE_AT })).ok,
    ).toBe(false);
    expect(decodeReuseRecord(raw({ ...record({ s: "ambiguous" }), l: LEASE_AT })).ok).toBe(false);
  });

  it("requires a bound thread wherever the state machine assumes one", () => {
    // `active` is what a later turn continues; `processing` is mid-submit;
    // `committed` is the acknowledged terminal state awaiting activation.
    expect(decodeReuseRecord(raw(record({ s: "active", l: 0 }))).ok).toBe(false);
    expect(decodeReuseRecord(raw(record({ s: "committed", l: 0 }))).ok).toBe(false);
    expect(decodeReuseRecord(raw(record({ s: "processing" }))).ok).toBe(false);
    // `ambiguous` deliberately drops the thread and must never carry one.
    expect(decodeReuseRecord(raw({ ...record({ s: "ambiguous", l: 0 }), p: SEALED })).ok).toBe(
      false,
    );
    // A bare reservation legitimately has none.
    expect(decodeReuseRecord(raw(record())).ok).toBe(true);
  });

  it("rejects a malformed sealed payload", () => {
    const cases: unknown[] = [
      null,
      "AAAA",
      [],
      { i: "AAAA", c: "BBBB" },
      { i: "AAAA", c: "BBBB", t: "CCCC", extra: 1 },
      { i: "", c: "BBBB", t: "CCCC" },
      { i: "AAAA", c: "BBBB", t: "not base64url!" },
      { i: "x".repeat(65), c: "BBBB", t: "CCCC" },
      { i: "AAAA", c: "BBBB", t: 7 },
    ];
    for (const p of cases) {
      expect(decodeReuseRecord(raw({ ...record({ s: "active", l: 0 }), p })).ok).toBe(false);
    }
  });

  it("rejects an oversized document before parsing it", () => {
    const padded = raw({ ...record({ s: "active", l: 0 }), p: { ...SEALED, c: "A".repeat(9000) } });
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(MAX_REUSE_RECORD_BYTES);
    expect(decodeReuseRecord(padded).ok).toBe(false);
  });

  it("treats `__proto__` as an ordinary unknown key rather than a prototype write", () => {
    const decoded = decodeReuseRecord('{"v":1,"s":"reserved","o":"b3Jhbmdl","l":1,"__proto__":{}}');
    expect(decoded.ok).toBe(false);
    expect(Object.prototype).not.toHaveProperty("s");
  });
});
