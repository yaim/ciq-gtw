/**
 * Redis-backed implementation of the idempotency store (Phase 4A).
 *
 * This module owns the five server-side Lua scripts — four atomic MUTATION
 * scripts (claim, transition, renew, release) plus one bounded READ script,
 * which mutates nothing — and the idempotency reply vocabulary; the coordinator
 * above it sees only the narrow `IdempotencyStore` port. The connection itself
 * belongs to the shared substrate (`src/redis/`), which every Redis-backed
 * feature shares, so the process holds exactly one client.
 *
 * Every mutation is one atomic server-side script — there is no GET-then-SET
 * anywhere in the correctness path. The substrate caches each script with
 * `EVALSHA` over a locally computed SHA-1 and falls back to `EVAL` on `NOSCRIPT`
 * (a Redis restart or `SCRIPT FLUSH`).
 *
 * No record read is issued as a direct client command: the read path is a script
 * too, so the stored size is checked with `STRLEN` before the script's own
 * internal `GET` and an over-budget value is classified without its bytes ever
 * reaching Node. The mutation scripts guard the same way before reading.
 *
 * Each MUTATION script reads only the record's `s` (state) and `o` (owner)
 * fields, guards `cjson.decode` with `pcall`, rejects an oversized or non-object
 * value before comparing, and validates its numeric arguments, so a corrupt or
 * hostile stored value can never cause a takeover, an unbounded expiry, or a
 * script abort. The read script decodes nothing: it returns the raw value for
 * strict validation in TypeScript.
 */
import { defineRedisScript, type RedisReply, type RedisSubstrate } from "../redis/index.js";
import type { CasResult, IdempotencyStore } from "./store.js";
import { RECORD_VERSION, type RecordState } from "./records.js";
import { MAX_RECORD_BYTES } from "./limits.js";

/**
 * Atomically create a `reserved` record when the key is absent, else return the
 * existing raw value for strict validation in TypeScript. `SET` carries `PX`, so
 * a claim can never be created without a lease.
 */
/**
 * Shared Lua prelude: reject an oversized value by `STRLEN` BEFORE `GET`, so a
 * hostile or corrupt multi-megabyte value is never materialized, then decode
 * defensively.
 *
 * `cjson.decode` yields a Lua table for a JSON object AND for a JSON array, and
 * those are indistinguishable in Lua 5.1 — so an array value would reach the
 * owner comparison with `rec['o'] == nil` and report `lost` instead of
 * `corrupt`. The explicit `type(...) == 'string'` checks force every such shape
 * (and any non-string `s`/`o`) onto the `corrupt` path, which is what the
 * coordinator's diagnostics and fail-closed handling expect. The version check
 * additionally stops a replica from compare-and-transitioning a record written
 * in a format it does not understand during a mixed-version deployment.
 */
const GUARD_PRELUDE = `
local maxBytes = tonumber(ARGV[3])
if not maxBytes then return {'corrupt'} end
local size = redis.call('STRLEN', KEYS[1])
if size == 0 and redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if size > maxBytes then return {'corrupt'} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then return {'corrupt'} end
if type(rec['o']) ~= 'string' or type(rec['s']) ~= 'string' then return {'corrupt'} end
if rec['v'] ~= tonumber(ARGV[4]) then return {'corrupt'} end
if rec['o'] ~= ARGV[1] then return {'lost'} end
`;

const CLAIM_SCRIPT = `
local maxBytes = tonumber(ARGV[3])
if not maxBytes then return {'corrupt'} end
if redis.call('EXISTS', KEYS[1]) == 0 then
  local lease = tonumber(ARGV[2])
  if not lease or lease < 1 then return {'corrupt'} end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', lease)
  return {'claimed'}
end
if redis.call('STRLEN', KEYS[1]) > maxBytes then return {'corrupt'} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
return {'exists', raw}
`;

/** Atomically replace an owned record in a known state, resetting its expiry. */
const TRANSITION_SCRIPT = `${GUARD_PRELUDE}
if rec['s'] ~= ARGV[2] then return {'state'} end
local ttl = tonumber(ARGV[5])
if not ttl or ttl < 1 then return {'corrupt'} end
redis.call('SET', KEYS[1], ARGV[6], 'PX', ttl)
return {'ok'}
`;

/**
 * Atomically extend an owned ACTIVE record's lease, choosing the lease duration
 * from the AUTHORITATIVE STORED STATE rather than from the caller's view of it.
 *
 * This is load bearing. `reserved` and `processing` carry deliberately different
 * leases, and a renewal races the `reserved -> processing` transition: Redis can
 * apply the transition while the transitioning caller is still awaiting its
 * reply, so a renewal issued in that window would carry the caller's stale
 * `reserved` view. If the script trusted that view it would `PEXPIRE` a
 * `processing` record down to the short reserved lease, and the record could
 * then expire while its owner was legitimately mid-completion — allowing another
 * replica to claim the key and duplicate billed upstream work.
 *
 * Reading `rec['s']` inside the script removes the race entirely: the state and
 * the lease are chosen in the same atomic step, so no caller-local staleness can
 * shorten a lease. A `final` or `ambiguous` record is still never revived — its
 * TTL is owned by the commit/abandon transition — and the reply carries the
 * observed state so the caller can report which lease was applied.
 */
const RENEW_SCRIPT = `${GUARD_PRELUDE}
local lease
if rec['s'] == 'reserved' then
  lease = tonumber(ARGV[2])
elseif rec['s'] == 'processing' then
  lease = tonumber(ARGV[5])
else
  return {'state'}
end
if not lease or lease < 1 then return {'corrupt'} end
redis.call('PEXPIRE', KEYS[1], lease)
return {'ok', rec['s']}
`;

/** Atomically delete an owned record that is still in the expected state. */
const RELEASE_SCRIPT = `${GUARD_PRELUDE}
if rec['s'] ~= ARGV[2] then return {'state'} end
redis.call('DEL', KEYS[1])
return {'ok'}
`;

/**
 * Atomically read a record, rejecting an oversized value by `STRLEN` BEFORE the
 * `GET`. A plain `GET` would materialize a hostile or corrupt multi-megabyte
 * value in Node just to discard it; here the bytes never leave Redis. The record
 * is neither deleted nor mutated — the normative contract classifies an
 * unreadable record as corrupt and fails the request closed, and destroying it
 * would discard state another owner may still hold.
 */
const READ_SCRIPT = `
local maxBytes = tonumber(ARGV[1])
if not maxBytes or maxBytes < 1 then return {'corrupt'} end
local size = redis.call('STRLEN', KEYS[1])
if size == 0 and redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if size > maxBytes then return {'corrupt'} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
if raw == '' then return {'corrupt'} end
return {'found', raw}
`;

const SCRIPTS = {
  claim: defineRedisScript(CLAIM_SCRIPT),
  transition: defineRedisScript(TRANSITION_SCRIPT),
  renew: defineRedisScript(RENEW_SCRIPT),
  release: defineRedisScript(RELEASE_SCRIPT),
  read: defineRedisScript(READ_SCRIPT),
} as const;

type ScriptName = keyof typeof SCRIPTS;

/** Reduce a normalized substrate reply to this boundary's `[tag, payload?]`. */
function taggedReply(reply: RedisReply | null): readonly [string, string | undefined] | null {
  if (reply === null || reply.length === 0) return null;
  const tag = reply[0];
  if (typeof tag !== "string") return null;
  const value = reply[1];
  return [tag, typeof value === "string" ? value : undefined];
}

function casFromTag(tag: string): CasResult {
  switch (tag) {
    case "ok":
      return { kind: "ok" };
    case "missing":
      return { kind: "missing" };
    case "lost":
      return { kind: "lost" };
    case "state":
      return { kind: "state" };
    case "corrupt":
      return { kind: "corrupt" };
    default:
      return { kind: "unavailable" };
  }
}

/**
 * Build the idempotency store over the shared Redis substrate.
 *
 * Construction opens NO socket and creates no client: the connection is owned by
 * the process composition root, so `buildServer`, the test suites, and the
 * compiled-import smoke test stay socket-free.
 */
export function createRedisIdempotencyStore(substrate: RedisSubstrate): IdempotencyStore {
  async function evalScript(
    name: ScriptName,
    key: string,
    args: readonly string[],
  ): Promise<readonly [string, string | undefined] | null> {
    return taggedReply(await substrate.evalScript(SCRIPTS[name], [key], args));
  }

  return {
    async claim(key, record, leaseMs) {
      const reply = await evalScript("claim", key, [
        record,
        String(leaseMs),
        String(MAX_RECORD_BYTES),
      ]);
      if (reply === null) return { kind: "unavailable" };
      const [tag, value] = reply;
      if (tag === "claimed") return { kind: "claimed" };
      if (tag === "corrupt") return { kind: "corrupt" };
      if (tag === "exists" && value !== undefined) return { kind: "exists", raw: value };
      return { kind: "unavailable" };
    },

    async read(key) {
      // Bounded server side: the script rejects an oversized value on STRLEN
      // before any GET, so an over-budget entry is classified `corrupt` without
      // its bytes ever being materialized here.
      const reply = await evalScript("read", key, [String(MAX_RECORD_BYTES)]);
      if (reply === null) return { kind: "unavailable" };
      const [tag, value] = reply;
      if (tag === "missing") return { kind: "missing" };
      if (tag === "corrupt") return { kind: "corrupt" };
      if (tag === "found" && value !== undefined) return { kind: "found", raw: value };
      return { kind: "unavailable" };
    },

    async transition(key, owner, from: RecordState, next, ttlMs) {
      const reply = await evalScript("transition", key, [
        owner,
        from,
        String(MAX_RECORD_BYTES),
        String(RECORD_VERSION),
        String(ttlMs),
        next,
      ]);
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async renew(key, owner, leases) {
      // BOTH leases are shipped; the script picks one from the stored state, so
      // a caller whose view of that state is stale cannot shorten the lease.
      const reply = await evalScript("renew", key, [
        owner,
        String(leases.reserved),
        String(MAX_RECORD_BYTES),
        String(RECORD_VERSION),
        String(leases.processing),
      ]);
      if (reply === null) return { kind: "unavailable" };
      const result = casFromTag(reply[0]);
      if (result.kind !== "ok") return result;
      const observed = reply[1];
      return observed === "reserved" || observed === "processing"
        ? { kind: "ok", observedState: observed }
        : { kind: "ok" };
    },

    async release(key, owner, from: RecordState) {
      const reply = await evalScript("release", key, [
        owner,
        from,
        String(MAX_RECORD_BYTES),
        String(RECORD_VERSION),
      ]);
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    isReady(): boolean {
      return substrate.isReady();
    },
  };
}
