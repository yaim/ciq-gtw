/**
 * The shared-capacity ZSET member wire format (Phase 4D; specification section
 * 19.2).
 *
 * A member is a strict, versioned encoding of exactly two opaque components:
 *
 * ```text
 * <version>|<owner token>|<capacity scope>
 * ```
 *
 * Both components are unpadded base64url (`[A-Za-z0-9_-]`) and the delimiter is
 * deliberately OUTSIDE that alphabet, so a member splits unambiguously and no
 * component value can forge an extra field. The member carries no request,
 * thread, session, model, tool, prompt, answer, credential, raw gateway key, or
 * process-local `k<index>` identity, and its score — the lease deadline — is
 * always stamped from Redis's own clock.
 *
 * The PRODUCTION encoder is the Lua in `redis-store.ts`, which assembles each
 * member server-side so the stored bytes cannot depend on a caller. The encoder
 * here exists so hermetic tests and the real-Redis contract suite can assert
 * against the same format, and so a change to one is impossible to make without
 * noticing the other.
 */
import { randomBytes } from "node:crypto";
import {
  CAPACITY_MEMBER_DELIMITER,
  CAPACITY_MEMBER_VERSION,
  CAPACITY_OWNER_TOKEN_BYTES,
  CAPACITY_SCOPE_BYTES,
} from "./limits.js";

/**
 * Exact character length of a canonical unpadded base64url owner token
 * (`CAPACITY_OWNER_TOKEN_BYTES` = 16 bytes).
 */
export const CAPACITY_OWNER_TOKEN_CHARS = 22;

/**
 * Exact character length of a canonical unpadded base64url capacity scope
 * (`CAPACITY_SCOPE_BYTES` = one SHA-256 digest).
 */
export const CAPACITY_SCOPE_CHARS = 43;

/**
 * The only final characters a CANONICAL encoding of each component may end with.
 *
 * Unpadded base64url carries 6 bits per character, so an encoding whose byte
 * count is not a multiple of 3 has spare low bits in its last character that a
 * canonical encoder leaves ZERO. 16 bytes into 22 characters leaves 4 spare bits
 * (final character value divisible by 16); 32 bytes into 43 characters leaves 2
 * (divisible by 4). Anything else is a non-canonical encoding of the same bytes
 * — a second spelling of one value, which must never be accepted as a distinct
 * owner or scope.
 *
 * These are exported so the server-side Lua patterns and the TypeScript
 * validators below cannot drift apart; both are asserted against real encodings
 * by `test/unit/shared-capacity-keyring.test.ts`.
 */
export const CAPACITY_OWNER_FINAL_CHARS = "AQgw";
export const CAPACITY_SCOPE_FINAL_CHARS = "048AEIMQUYcgkosw";

/**
 * True only for a CANONICAL unpadded base64url encoding of exactly `bytes`
 * bytes.
 *
 * Decode/re-encode equality is the check, rather than a length-plus-alphabet
 * test: Node decodes a non-canonical trailing character silently (`…B` and
 * `…A` yield identical bytes), so only re-encoding proves the input was the one
 * canonical spelling. Rejecting the alternatives matters because a member's
 * identity IS its byte string — two spellings of one owner token would be two
 * registry members for one permit.
 */
function isCanonicalBase64Url(value: string, bytes: number, chars: number): boolean {
  if (typeof value !== "string" || value.length !== chars) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return false;
  }
  return decoded.length === bytes && decoded.toString("base64url") === value;
}

/** True only for a canonical 16-byte unpadded base64url owner token. */
export function isCanonicalCapacityOwner(value: string): boolean {
  return isCanonicalBase64Url(value, CAPACITY_OWNER_TOKEN_BYTES, CAPACITY_OWNER_TOKEN_CHARS);
}

/** True only for a canonical 32-byte unpadded base64url capacity scope. */
export function isCanonicalCapacityScope(value: string): boolean {
  return isCanonicalBase64Url(value, CAPACITY_SCOPE_BYTES, CAPACITY_SCOPE_CHARS);
}

/**
 * Mint a fresh 128-bit owner token for one waiter.
 *
 * The token is the ONLY thing that ties a stored member to the request holding
 * it, so it must be unguessable: a caller that could predict another replica's
 * token could release a permit it does not hold. 128 bits of CSPRNG output makes
 * a collision — which the Lua validator additionally rejects as corrupt —
 * unreachable in practice.
 */
export function newCapacityOwnerToken(): string {
  return randomBytes(CAPACITY_OWNER_TOKEN_BYTES).toString("base64url");
}

/**
 * Encode one member exactly as the server-side scripts do.
 *
 * Exported for tests only; production never sends a whole member to Redis.
 */
export function encodeCapacityMember(owner: string, scope: string): string {
  const d = CAPACITY_MEMBER_DELIMITER;
  return `${String(CAPACITY_MEMBER_VERSION)}${d}${owner}${d}${scope}`;
}
