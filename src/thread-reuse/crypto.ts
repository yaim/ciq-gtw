/**
 * Authenticated encryption for the stored upstream thread id (Phase 5A;
 * specification sections 5.1.1, 22.2).
 *
 * AES-256-GCM with a fresh random 96-bit nonce per write and a 128-bit tag,
 * using only Node's built-in cryptography. The associated data binds each
 * ciphertext to:
 *
 *  - the record format version,
 *  - the Redis storage key, and
 *  - the independent mapping-identity digest,
 *
 * so a ciphertext copied to another mapping's key, rebound to a different
 * session/model/principal/origin, or carried across a record-version change
 * fails authentication and is treated as corrupt (fail closed, `503`) rather
 * than decrypted into a thread another session would then submit to.
 *
 * This deliberately does NOT reuse `src/idempotency/crypto.ts`. That module's
 * derivation constants, ciphertext format, and associated-data rule are a
 * committed Phase 4A contract over records that already exist in deployed Redis
 * instances; sharing code would make any future change here able to silently
 * invalidate them. The duplication is the same trade the rate limiter makes for
 * its key framing, and it is intentional.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, MAX_UPSTREAM_THREAD_ID_BYTES } from "./limits.js";

/** A sealed thread id as stored in the Redis record (all base64url). */
export interface SealedThread {
  /** Random 96-bit nonce, unique per write. */
  readonly i: string;
  /** Ciphertext. */
  readonly c: string;
  /** 128-bit GCM authentication tag. */
  readonly t: string;
}

/** The values bound into the associated data of every sealed thread id. */
export interface ThreadAeadBinding {
  readonly recordVersion: number;
  readonly storageKey: string;
  readonly mappingIdentityDigest: string;
}

function associatedData(binding: ThreadAeadBinding): Buffer {
  // Length-framed so no two different bindings can share associated data.
  const parts = [
    String(binding.recordVersion),
    binding.storageKey,
    binding.mappingIdentityDigest,
  ] as const;
  let framed = "";
  for (const part of parts) framed += `${Buffer.byteLength(part, "utf8")}:${part}|`;
  return Buffer.from(framed, "utf8");
}

/**
 * Seal a normalized upstream thread id under the AEAD subkey with a fresh
 * random nonce.
 *
 * Returns `null` — never throws — for an empty or oversized id, so a hostile or
 * malformed upstream value fails the mapping closed instead of being stored.
 */
export function sealThreadId(
  aeadKey: Buffer,
  threadId: string,
  binding: ThreadAeadBinding,
): SealedThread | null {
  try {
    const bytes = Buffer.from(threadId, "utf8");
    if (bytes.length === 0 || bytes.length > MAX_UPSTREAM_THREAD_ID_BYTES) return null;
    // A fresh random nonce per write: a nonce is NEVER derived from, or reused
    // across, records, so GCM's catastrophic nonce-reuse failure mode cannot
    // occur even though one mapping is re-sealed on every turn.
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
  } catch {
    return null;
  }
}

/**
 * Decrypt and authenticate a sealed thread id.
 *
 * Returns `null` — never throws to the caller and never inspects the thrown
 * value — for a wrong key, a tampered nonce/ciphertext/tag, a mismatched
 * binding, a malformed encoding, an oversized ciphertext, or a plaintext that
 * is empty or over the thread-id bound.
 */
export function openThreadId(
  aeadKey: Buffer,
  sealed: SealedThread,
  binding: ThreadAeadBinding,
): string | null {
  try {
    const nonce = Buffer.from(sealed.i, "base64url");
    const ciphertext = Buffer.from(sealed.c, "base64url");
    const tag = Buffer.from(sealed.t, "base64url");
    if (nonce.length !== GCM_NONCE_BYTES) return null;
    if (tag.length !== GCM_TAG_BYTES) return null;
    if (ciphertext.length === 0 || ciphertext.length > MAX_UPSTREAM_THREAD_ID_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", aeadKey, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const threadId = plaintext.toString("utf8");
    if (threadId.length === 0) return null;
    if (Buffer.byteLength(threadId, "utf8") > MAX_UPSTREAM_THREAD_ID_BYTES) return null;
    return threadId;
  } catch {
    // Authentication failure or malformed input: fail closed with no detail.
    return null;
  }
}
