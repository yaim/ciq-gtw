/**
 * Authenticated encryption of the stored upstream thread id (Phase 5A;
 * specification sections 5.1.1, 22.2).
 *
 * The thread id is the one piece of upstream state this feature persists, and
 * every failure mode here is a real risk: a reused nonce would break GCM
 * outright, and an unbound ciphertext could be relocated so one OpenCode
 * session submitted into another session's thread.
 *
 * Every value here is synthetic.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_UPSTREAM_THREAD_ID_BYTES,
  openThreadId,
  sealThreadId,
  type SealedThread,
  type ThreadAeadBinding,
} from "../../src/thread-reuse/index.js";

const KEY = randomBytes(32);
const THREAD_ID = "thread-sentinel-4711";

const BINDING: ThreadAeadBinding = {
  recordVersion: 1,
  storageKey: "test-ns:reuse:AAAA",
  mappingIdentityDigest: "BBBB",
};

function seal(threadId = THREAD_ID, binding = BINDING, key = KEY): SealedThread {
  const sealed = sealThreadId(key, threadId, binding);
  if (sealed === null) throw new Error("expected the thread id to seal");
  return sealed;
}

describe("thread-reuse crypto", () => {
  it("round-trips a thread id and never stores it in the clear", () => {
    const sealed = seal();
    expect(openThreadId(KEY, sealed, BINDING)).toBe(THREAD_ID);
    for (const field of [sealed.i, sealed.c, sealed.t]) {
      expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(field).not.toContain(THREAD_ID);
    }
  });

  it("uses a fresh nonce for every write", () => {
    // One mapping is re-sealed on every turn, so nonce reuse would be a
    // catastrophic, silent GCM failure rather than a theoretical one.
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const sealed = seal();
      nonces.add(sealed.i);
      ciphertexts.add(sealed.c);
    }
    expect(nonces.size).toBe(64);
    // Identical plaintext under distinct nonces must not produce identical bytes.
    expect(ciphertexts.size).toBe(64);
  });

  it("binds the ciphertext to the record version, storage key, and identity digest", () => {
    const sealed = seal();
    const rebound: ThreadAeadBinding[] = [
      { ...BINDING, recordVersion: 2 },
      { ...BINDING, storageKey: "test-ns:reuse:CCCC" },
      { ...BINDING, mappingIdentityDigest: "DDDD" },
    ];
    for (const binding of rebound) expect(openThreadId(KEY, sealed, binding)).toBeNull();
  });

  it("cannot be fooled by shifting a boundary inside the associated data", () => {
    const sealed = sealThreadId(KEY, THREAD_ID, {
      recordVersion: 1,
      storageKey: "ab",
      mappingIdentityDigest: "c",
    });
    expect(sealed).not.toBeNull();
    expect(
      openThreadId(KEY, sealed as SealedThread, {
        recordVersion: 1,
        storageKey: "a",
        mappingIdentityDigest: "bc",
      }),
    ).toBeNull();
  });

  it("rejects a wrong key", () => {
    expect(openThreadId(randomBytes(32), seal(), BINDING)).toBeNull();
  });

  it("rejects a tampered nonce, ciphertext, or tag", () => {
    const sealed = seal();
    const flip = (value: string): string =>
      value.startsWith("A") ? `B${value.slice(1)}` : `A${value.slice(1)}`;
    expect(openThreadId(KEY, { ...sealed, i: flip(sealed.i) }, BINDING)).toBeNull();
    expect(openThreadId(KEY, { ...sealed, c: flip(sealed.c) }, BINDING)).toBeNull();
    expect(openThreadId(KEY, { ...sealed, t: flip(sealed.t) }, BINDING)).toBeNull();
  });

  it("rejects a malformed or wrongly sized envelope without throwing", () => {
    const sealed = seal();
    const cases: SealedThread[] = [
      { ...sealed, i: "" },
      { ...sealed, i: randomBytes(11).toString("base64url") },
      { ...sealed, i: randomBytes(13).toString("base64url") },
      { ...sealed, t: randomBytes(15).toString("base64url") },
      { ...sealed, t: randomBytes(17).toString("base64url") },
      { ...sealed, c: "" },
      { ...sealed, c: randomBytes(MAX_UPSTREAM_THREAD_ID_BYTES + 1).toString("base64url") },
      { ...sealed, c: "not base64url !!" },
    ];
    for (const candidate of cases) expect(openThreadId(KEY, candidate, BINDING)).toBeNull();
  });

  it("refuses to seal an empty or oversized thread id", () => {
    expect(sealThreadId(KEY, "", BINDING)).toBeNull();
    expect(sealThreadId(KEY, "x".repeat(MAX_UPSTREAM_THREAD_ID_BYTES + 1), BINDING)).toBeNull();
    // Exactly at the bound is accepted.
    const maximal = "x".repeat(MAX_UPSTREAM_THREAD_ID_BYTES);
    expect(openThreadId(KEY, seal(maximal), BINDING)).toBe(maximal);
  });

  it("preserves a non-ASCII thread id byte-for-byte", () => {
    // The adapter normalizes upstream ids, but nothing here may assume ASCII.
    const id = "thread-ünïcøde-🧵";
    expect(openThreadId(KEY, seal(id), BINDING)).toBe(id);
  });
});
