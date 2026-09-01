import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openPayload, sealPayload, type AeadBinding } from "../../src/idempotency/crypto.js";
import {
  buildStorageKey,
  deriveGatewayKeyScope,
  deriveIdempotencyKeyring,
} from "../../src/idempotency/keyring.js";
import { GCM_NONCE_BYTES, MAX_PAYLOAD_BYTES } from "../../src/idempotency/limits.js";
import { RECORD_VERSION } from "../../src/idempotency/records.js";

const MASTER = randomBytes(32).toString("base64url");
const OTHER_MASTER = randomBytes(32).toString("base64url");
const KEYRING = deriveIdempotencyKeyring(MASTER);

const BINDING: AeadBinding = {
  recordVersion: RECORD_VERSION,
  storageKey: "collectiviq-gateway:idem:AAAA",
  bodyFingerprint: "BBBB",
};

describe("deriveIdempotencyKeyring", () => {
  it("is deterministic for the same master key", () => {
    const again = deriveIdempotencyKeyring(MASTER);
    expect(again.redisKey.equals(KEYRING.redisKey)).toBe(true);
    expect(again.bodyKey.equals(KEYRING.bodyKey)).toBe(true);
    expect(again.aeadKey.equals(KEYRING.aeadKey)).toBe(true);
  });

  it("produces three DISTINCT 32-byte subkeys (HKDF domain separation)", () => {
    const { redisKey, bodyKey, aeadKey } = KEYRING;
    for (const subkey of [redisKey, bodyKey, aeadKey]) expect(subkey).toHaveLength(32);
    expect(redisKey.equals(bodyKey)).toBe(false);
    expect(redisKey.equals(aeadKey)).toBe(false);
    expect(bodyKey.equals(aeadKey)).toBe(false);
  });

  it("never reproduces the master key in a subkey", () => {
    const master = Buffer.from(MASTER, "base64url");
    for (const subkey of [KEYRING.redisKey, KEYRING.bodyKey, KEYRING.aeadKey]) {
      expect(subkey.equals(master)).toBe(false);
    }
  });

  it("yields entirely different subkeys for a different master key", () => {
    const other = deriveIdempotencyKeyring(OTHER_MASTER);
    expect(other.redisKey.equals(KEYRING.redisKey)).toBe(false);
    expect(other.bodyKey.equals(KEYRING.bodyKey)).toBe(false);
    expect(other.aeadKey.equals(KEYRING.aeadKey)).toBe(false);
  });

  it("rejects a master key of the wrong size without echoing it", () => {
    const short = randomBytes(16).toString("base64url");
    expect(() => deriveIdempotencyKeyring(short)).toThrowError(/unsupported size/);
    try {
      deriveIdempotencyKeyring(short);
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });
});

describe("deriveGatewayKeyScope", () => {
  const KEY_A = "gw-fake-key-alpha";
  const KEY_B = "gw-fake-key-bravo";

  it("is stable for a key regardless of configured ORDER", () => {
    // The scope is derived from the key VALUE, so reordering or adding gateway
    // keys never re-partitions existing idempotency state.
    const first = ["z-key", KEY_A, "y-key"].map((k) => deriveGatewayKeyScope(KEYRING, k));
    const reordered = [KEY_A, "y-key", "z-key"].map((k) => deriveGatewayKeyScope(KEYRING, k));
    expect(first[1]).toBe(reordered[0]);
    expect(deriveGatewayKeyScope(KEYRING, KEY_A)).toBe(deriveGatewayKeyScope(KEYRING, KEY_A));
  });

  it("separates different gateway keys", () => {
    expect(deriveGatewayKeyScope(KEYRING, KEY_A)).not.toBe(deriveGatewayKeyScope(KEYRING, KEY_B));
  });

  it("never contains the raw key", () => {
    const scope = deriveGatewayKeyScope(KEYRING, KEY_A);
    expect(scope).not.toContain(KEY_A);
    expect(scope).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes with the master key, so replicas must share one", () => {
    const other = deriveIdempotencyKeyring(OTHER_MASTER);
    expect(deriveGatewayKeyScope(other, KEY_A)).not.toBe(deriveGatewayKeyScope(KEYRING, KEY_A));
  });
});

describe("buildStorageKey", () => {
  const SCOPE = deriveGatewayKeyScope(KEYRING, "gw-fake-key-alpha");
  const OTHER_SCOPE = deriveGatewayKeyScope(KEYRING, "gw-fake-key-bravo");

  it("is deterministic and namespace-prefixed", () => {
    const key = buildStorageKey(KEYRING, "ns", SCOPE, "client-key");
    expect(key).toBe(buildStorageKey(KEYRING, "ns", SCOPE, "client-key"));
    expect(key.startsWith("ns:idem:")).toBe(true);
  });

  it("never contains the client idempotency key", () => {
    const clientKey = "client-supplied-sentinel-value";
    expect(buildStorageKey(KEYRING, "ns", SCOPE, clientKey)).not.toContain(clientKey);
  });

  it("separates namespace, gateway-key scope, and client key", () => {
    const base = buildStorageKey(KEYRING, "ns", SCOPE, "k");
    expect(buildStorageKey(KEYRING, "other", SCOPE, "k")).not.toBe(base);
    expect(buildStorageKey(KEYRING, "ns", OTHER_SCOPE, "k")).not.toBe(base);
    expect(buildStorageKey(KEYRING, "ns", SCOPE, "k2")).not.toBe(base);
  });

  it("cannot be collided by shifting characters between components", () => {
    expect(buildStorageKey(KEYRING, "ab", SCOPE, "c")).not.toBe(
      buildStorageKey(KEYRING, "a", SCOPE, "bc"),
    );
  });
});

describe("sealPayload / openPayload", () => {
  const PLAINTEXT = '{"v":1,"id":"chatcmpl_ciq_test","c":1,"m":"model","k":"text","t":"answer"}';

  it("round-trips exactly", () => {
    const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, BINDING);
    expect(openPayload(KEYRING.aeadKey, sealed, BINDING)).toBe(PLAINTEXT);
  });

  it("round-trips an empty and a multibyte plaintext", () => {
    for (const text of ["", "答え — ünïcøde ✓"]) {
      const sealed = sealPayload(KEYRING.aeadKey, text, BINDING);
      expect(openPayload(KEYRING.aeadKey, sealed, BINDING)).toBe(text);
    }
  });

  it("uses a fresh random 96-bit nonce for every record", () => {
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, BINDING);
      expect(Buffer.from(sealed.i, "base64url")).toHaveLength(GCM_NONCE_BYTES);
      nonces.add(sealed.i);
      ciphertexts.add(sealed.c);
    }
    expect(nonces.size).toBe(64);
    // A fresh nonce also means identical plaintext never yields identical bytes.
    expect(ciphertexts.size).toBe(64);
  });

  it("never leaks the plaintext into the ciphertext", () => {
    const sealed = sealPayload(KEYRING.aeadKey, "SENTINEL-ANSWER-TEXT", BINDING);
    expect(JSON.stringify(sealed)).not.toContain("SENTINEL");
  });

  it("fails to open under a different key", () => {
    const other = deriveIdempotencyKeyring(OTHER_MASTER);
    const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, BINDING);
    expect(openPayload(other.aeadKey, sealed, BINDING)).toBeNull();
  });

  it("binds the record version, storage key, and body fingerprint", () => {
    const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, BINDING);
    expect(
      openPayload(KEYRING.aeadKey, sealed, { ...BINDING, recordVersion: RECORD_VERSION + 1 }),
    ).toBeNull();
    expect(
      openPayload(KEYRING.aeadKey, sealed, { ...BINDING, storageKey: "other:idem:AAAA" }),
    ).toBeNull();
    expect(
      openPayload(KEYRING.aeadKey, sealed, { ...BINDING, bodyFingerprint: "CCCC" }),
    ).toBeNull();
  });

  it("cannot be collided by shifting characters between bound components", () => {
    const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, {
      recordVersion: RECORD_VERSION,
      storageKey: "ab",
      bodyFingerprint: "c",
    });
    expect(
      openPayload(KEYRING.aeadKey, sealed, {
        recordVersion: RECORD_VERSION,
        storageKey: "a",
        bodyFingerprint: "bc",
      }),
    ).toBeNull();
  });

  it("detects tampering with the nonce, ciphertext, or tag", () => {
    const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, BINDING);
    const flip = (value: string): string => {
      const bytes = Buffer.from(value, "base64url");
      bytes[0] = (bytes[0] as number) ^ 0xff;
      return bytes.toString("base64url");
    };
    expect(openPayload(KEYRING.aeadKey, { ...sealed, i: flip(sealed.i) }, BINDING)).toBeNull();
    expect(openPayload(KEYRING.aeadKey, { ...sealed, c: flip(sealed.c) }, BINDING)).toBeNull();
    expect(openPayload(KEYRING.aeadKey, { ...sealed, t: flip(sealed.t) }, BINDING)).toBeNull();
  });

  it("rejects malformed or wrongly sized components without throwing", () => {
    const sealed = sealPayload(KEYRING.aeadKey, PLAINTEXT, BINDING);
    expect(openPayload(KEYRING.aeadKey, { ...sealed, i: "" }, BINDING)).toBeNull();
    expect(openPayload(KEYRING.aeadKey, { ...sealed, t: "AAAA" }, BINDING)).toBeNull();
    expect(openPayload(KEYRING.aeadKey, { ...sealed, c: "!!!not-base64!!!" }, BINDING)).toBeNull();
    expect(openPayload(KEYRING.aeadKey, { i: "x", c: "y", t: "z" }, BINDING)).toBeNull();
  });

  it("refuses to seal a plaintext beyond the payload bound", () => {
    const oversized = "x".repeat(MAX_PAYLOAD_BYTES + 1);
    expect(() => sealPayload(KEYRING.aeadKey, oversized, BINDING)).toThrowError(
      /maximum allowed size/,
    );
  });
});
