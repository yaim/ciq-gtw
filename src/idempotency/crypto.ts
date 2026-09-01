/**
 * Authenticated encryption for the cached final response (Phase 4A;
 * specification section 22.2, which requires encryption at rest for a cached
 * final response).
 *
 * AES-256-GCM with a fresh random 96-bit nonce per record and 128-bit tag,
 * using only Node's built-in cryptography. The associated data binds each
 * ciphertext to:
 *
 *  - the record format version,
 *  - the Redis storage key, and
 *  - the keyed body fingerprint.
 *
 * so a ciphertext copied to a different key, replayed against a different body,
 * or carried across a record-version change fails authentication and is treated
 * as corrupt (fail closed, `503`) rather than decrypted.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, MAX_PAYLOAD_BYTES } from "./limits.js";

/** A sealed payload as stored in the Redis record (all base64url). */
export interface SealedPayload {
  /** Random 96-bit nonce, unique per record. */
  readonly i: string;
  /** Ciphertext. */
  readonly c: string;
  /** 128-bit GCM authentication tag. */
  readonly t: string;
}

/** The values bound into the associated data of every sealed payload. */
export interface AeadBinding {
  readonly recordVersion: number;
  readonly storageKey: string;
  readonly bodyFingerprint: string;
}

function associatedData(binding: AeadBinding): Buffer {
  // Length-framed so no two different bindings can share associated data.
  const parts = [
    String(binding.recordVersion),
    binding.storageKey,
    binding.bodyFingerprint,
  ] as const;
  let framed = "";
  for (const part of parts) framed += `${Buffer.byteLength(part, "utf8")}:${part}|`;
  return Buffer.from(framed, "utf8");
}

/**
 * Encrypt `plaintext` under the AEAD subkey with a fresh random nonce.
 *
 * @throws {Error} when the plaintext exceeds {@link MAX_PAYLOAD_BYTES}. The
 *   message contains no content.
 */
export function sealPayload(
  aeadKey: Buffer,
  plaintext: string,
  binding: AeadBinding,
): SealedPayload {
  const bytes = Buffer.from(plaintext, "utf8");
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error("idempotency payload exceeds the maximum allowed size");
  }
  // A fresh random nonce per record: a nonce is NEVER derived from, or reused
  // across, records, so GCM's catastrophic nonce-reuse failure mode cannot occur.
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", aeadKey, nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(associatedData(binding));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    i: nonce.toString("base64url"),
    c: ciphertext.toString("base64url"),
    t: cipher.getAuthTag().toString("base64url"),
  };
}

/**
 * Decrypt and authenticate a sealed payload.
 *
 * Returns `null` — never throws to the caller and never inspects the thrown
 * value — for a wrong key, a tampered nonce/ciphertext/tag, a mismatched
 * binding, a malformed encoding, or an oversized ciphertext.
 */
export function openPayload(
  aeadKey: Buffer,
  sealed: SealedPayload,
  binding: AeadBinding,
): string | null {
  try {
    const nonce = Buffer.from(sealed.i, "base64url");
    const ciphertext = Buffer.from(sealed.c, "base64url");
    const tag = Buffer.from(sealed.t, "base64url");
    if (nonce.length !== GCM_NONCE_BYTES) return null;
    if (tag.length !== GCM_TAG_BYTES) return null;
    if (ciphertext.length > MAX_PAYLOAD_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", aeadKey, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // Authentication failure or malformed input: fail closed with no detail.
    return null;
  }
}
