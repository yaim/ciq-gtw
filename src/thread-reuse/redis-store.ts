/**
 * Redis-backed implementation of the thread-reuse store (Phase 5A).
 *
 * This module owns the nine server-side Lua scripts and this boundary's reply
 * vocabulary; the coordinator above it sees only the narrow
 * {@link ThreadReuseStore} port. The connection belongs to the shared substrate
 * (`src/redis/`), which every Redis-backed feature shares, so the process holds
 * exactly one client.
 *
 * Three properties are load bearing and are enforced here rather than above:
 *
 *  - **Every mutation is one atomic server-side script.** There is no
 *    GET-then-SET anywhere in the correctness path, so two replicas racing the
 *    same OpenCode session are serialized by Redis rather than by any local
 *    lock. There is no direct client `GET` either: the read path is inside each
 *    script, guarded by `STRLEN` first, so an oversized or hostile value is
 *    classified corrupt without its bytes ever being materialized in Node.
 *
 *  - **The lease deadline always comes from Redis's own `TIME`, never a Node
 *    clock.** Redis `PX` holds the record's LIFETIME, not its lease, precisely
 *    so a record SURVIVES its lease: an expired `processing` record must become
 *    `ambiguous` rather than silently vanish and let the next turn start a fresh
 *    thread while the previous submit may still be running upstream. That means
 *    lease expiry is a comparison inside the script, and a replica with a skewed
 *    clock can neither steal a live lease nor extend its own. Because
 *    configuration may set a mapping TTL SHORTER than a lease, `ttlFor` gives
 *    each leased state at least its own lease plus a conversion grace.
 *
 *  - **A record is fully validated before it is mutated.** `readRecord` checks
 *    the exact key set, the version, the owner, the lease value, and every
 *    state-specific invariant, so a corrupt record is reported as such and left
 *    byte-for-byte untouched instead of being sanitized into a valid one.
 *
 *  - **Records are assembled server-side.** The caller cannot supply a whole
 *    record, because it cannot know the Redis-stamped lease deadline. The
 *    scripts rebuild the fixed fields and re-emit any carried sealed thread id
 *    through explicit string construction rather than `cjson.encode`, so the
 *    stored bytes stay fully deterministic. Every interpolated component is
 *    re-validated as bounded base64url first, so nothing a hostile writer put
 *    in Redis can inject JSON into a record this gateway writes.
 */
import { defineRedisScript, type RedisReply, type RedisSubstrate } from "../redis/index.js";
import { MAX_REUSE_RECORD_BYTES } from "./limits.js";
import { REUSE_RECORD_VERSION } from "./records.js";
import type {
  ReuseAcquireResult,
  ReuseCasResult,
  ReuseReleaseResult,
  ReuseTimings,
  ThreadReuseStore,
} from "./store.js";

/**
 * Shared prelude: argument validation, the Redis clock, bounded record reading,
 * and deterministic record assembly.
 *
 * Fixed `ARGV` layout, identical for every script so the caller never has to
 * remember a per-script order:
 *
 * ```text
 * ARGV[1] record version      ARGV[7]  owner token
 * ARGV[2] max record bytes    ARGV[8]  sealed nonce      (bind only, else "")
 * ARGV[3] reserved lease ms   ARGV[9]  sealed ciphertext (bind only, else "")
 * ARGV[4] processing lease ms ARGV[10] sealed tag        (bind only, else "")
 * ARGV[5] mapping TTL ms      ARGV[11] committed TTL ms
 * ARGV[6] ambiguous TTL ms
 * ```
 *
 * Both leases and every TTL are shipped to EVERY script. `leaseFor` and
 * `ttlFor` then pick from the state being WRITTEN, and the renewal script picks
 * from the state it READ, so a caller whose view is stale can never shorten a
 * live `processing` lease or give a record the wrong lifetime.
 */
const PRELUDE = `
local VERSION = tonumber(ARGV[1])
local MAXBYTES = tonumber(ARGV[2])
local LEASE_MS = tonumber(ARGV[3])
local PROCESSING_LEASE_MS = tonumber(ARGV[4])
local MAPPING_TTL = tonumber(ARGV[5])
local AMBIG_TTL = tonumber(ARGV[6])
local OWNER = ARGV[7]
if not VERSION or not MAXBYTES or MAXBYTES < 1 then return {'corrupt'} end
if not LEASE_MS or LEASE_MS < 1 then return {'corrupt'} end
if not PROCESSING_LEASE_MS or PROCESSING_LEASE_MS < 1 then return {'corrupt'} end
if not MAPPING_TTL or MAPPING_TTL < 1 then return {'corrupt'} end
if not AMBIG_TTL or AMBIG_TTL < 1 then return {'corrupt'} end
if type(OWNER) ~= 'string' or not string.match(OWNER, '^[A-Za-z0-9_-]+$') then
  return {'corrupt'}
end
if #OWNER > 128 then return {'corrupt'} end

local COMMITTED_TTL = tonumber(ARGV[11])
if not COMMITTED_TTL or COMMITTED_TTL < 1 then return {'corrupt'} end

local function leaseFor(state)
  if state == 'processing' then return PROCESSING_LEASE_MS end
  return LEASE_MS
end

-- Redis key lifetime for the state being WRITTEN.
--
-- A leased record must OUTLIVE its own lease: lease expiry is what lets a
-- competitor convert an abandoned 'processing' record into 'ambiguous', and if
-- the key simply vanished at the lease deadline the next turn would see no
-- mapping and silently start a replacement thread. Configuration can make the
-- lease longer than the mapping TTL (a 5-minute mapping TTL with a 10.5-minute
-- processing lease is permitted), so the leased states take the larger of the
-- two plus a grace window equal to the ambiguous TTL.
local function ttlFor(state)
  if state == 'ambiguous' then return AMBIG_TTL end
  if state == 'committed' then return COMMITTED_TTL end
  local lease = nil
  if state == 'processing' then lease = PROCESSING_LEASE_MS end
  if state == 'reserved' then lease = LEASE_MS end
  if lease == nil then return MAPPING_TTL end
  local floor = lease + AMBIG_TTL
  if floor > MAPPING_TTL then return floor end
  return MAPPING_TTL
end

local clock = redis.call('TIME')
if type(clock) ~= 'table' then return {'corrupt'} end
local secs = tonumber(clock[1])
local usecs = tonumber(clock[2])
if not secs or not usecs or secs < 0 or usecs < 0 then return {'corrupt'} end
local NOW_MS = secs * 1000 + math.floor(usecs / 1000)

local function b64ok(v, maxLen)
  if type(v) ~= 'string' then return false end
  if #v < 1 or #v > maxLen then return false end
  return string.match(v, '^[A-Za-z0-9_-]+$') ~= nil
end

-- Re-emit a decoded sealed thread id as deterministic JSON. Every field is
-- re-validated as bounded base64url, so a tampered record can never inject
-- JSON syntax into the record this script writes.
local function sealedJson(p)
  if type(p) ~= 'table' then return nil, false end
  local i, c, t = p['i'], p['c'], p['t']
  if not b64ok(i, 64) or not b64ok(c, MAXBYTES) or not b64ok(t, 64) then return nil, false end
  return '{"i":"' .. i .. '","c":"' .. c .. '","t":"' .. t .. '"}', true
end

-- '%d' rather than tostring: a 13-digit millisecond value must never be
-- rendered in exponential form.
local function buildRecord(state, owner, leaseAt, payloadJson)
  local out = '{"v":' .. string.format('%d', VERSION)
    .. ',"s":"' .. state .. '"'
    .. ',"o":"' .. owner .. '"'
    .. ',"l":' .. string.format('%d', leaseAt)
  if payloadJson then out = out .. ',"p":' .. payloadJson end
  return out .. '}'
end

-- The state being written selects its own Redis lifetime; no caller chooses it.
local function writeRecord(json, state)
  if #json > MAXBYTES then return false end
  redis.call('SET', KEYS[1], json, 'PX', string.format('%d', ttlFor(state)))
  return true
end

local function countKeys(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end

-- A lease deadline must be a real, non-negative, integral millisecond value.
-- The upper bound rejects a JSON infinity, which would otherwise satisfy both
-- the floor comparison and math.floor and could never expire.
local function leaseValueOk(v)
  if type(v) ~= 'number' then return false end
  if v ~= v then return false end
  if v < 0 or v >= 1e15 then return false end
  return v == math.floor(v)
end

-- The sealed thread id must be EXACTLY {i, c, t}, each bounded base64url. An
-- unknown key means the record was not written by this gateway.
local function sealedOk(p)
  if type(p) ~= 'table' then return false end
  if countKeys(p) ~= 3 then return false end
  return b64ok(p['i'], 64) and b64ok(p['c'], MAXBYTES) and b64ok(p['t'], 64)
end

-- Bounded, STRICTLY guarded read. Returns (record, nil) or (nil, 'missing'|'corrupt').
--
-- Validation is complete and state-specific BEFORE any caller mutates the key,
-- so a corrupt record is never silently sanitized and rewritten into a valid
-- one. A rejected record is left byte-for-byte untouched: every mutating script
-- calls this first and returns on error without writing.
local function readRecord()
  local size = redis.call('STRLEN', KEYS[1])
  if size == 0 then
    if redis.call('EXISTS', KEYS[1]) == 0 then return nil, 'missing' end
    return nil, 'corrupt'
  end
  if size > MAXBYTES then return nil, 'corrupt' end
  local raw = redis.call('GET', KEYS[1])
  if not raw then return nil, 'missing' end
  local ok, rec = pcall(cjson.decode, raw)
  if not ok or type(rec) ~= 'table' then return nil, 'corrupt' end

  if rec['v'] ~= VERSION then return nil, 'corrupt' end
  local state = rec['s']
  if type(state) ~= 'string' then return nil, 'corrupt' end
  if not b64ok(rec['o'], 128) then return nil, 'corrupt' end
  if not leaseValueOk(rec['l']) then return nil, 'corrupt' end

  -- Exact key set: the four base fields, plus 'p' only when one is present.
  -- Counting rejects every unknown top-level key.
  local hasPayload = rec['p'] ~= nil
  local expected = 4
  if hasPayload then expected = 5 end
  if countKeys(rec) ~= expected then return nil, 'corrupt' end

  if state == 'reserved' then
    -- A thread may or may not be bound yet, but a lease is mandatory.
    if rec['l'] <= 0 then return nil, 'corrupt' end
    if hasPayload and not sealedOk(rec['p']) then return nil, 'corrupt' end
  elseif state == 'processing' then
    if rec['l'] <= 0 then return nil, 'corrupt' end
    if not hasPayload or not sealedOk(rec['p']) then return nil, 'corrupt' end
  elseif state == 'committed' or state == 'active' then
    -- Terminal-but-bound: no lease, and the thread it refers to is mandatory.
    if rec['l'] ~= 0 then return nil, 'corrupt' end
    if not hasPayload or not sealedOk(rec['p']) then return nil, 'corrupt' end
  elseif state == 'ambiguous' then
    if rec['l'] ~= 0 or hasPayload then return nil, 'corrupt' end
  else
    return nil, 'corrupt'
  end
  return rec, nil
end
`;

/**
 * Take the mapping's lease.
 *
 * The five cases are the whole cross-replica contract: a fresh session, a
 * continuing session, a live competitor, a crashed pre-submit owner (safe to
 * take over, thread and all), and a crashed mid-submit owner (never taken over
 * — the thread's contents are unknown, so the mapping is tombstoned instead).
 */
const ACQUIRE_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err == 'corrupt' then return {'corrupt'} end

local payload = nil
if err == nil then
  local state = rec['s']
  if state == 'ambiguous' then return {'blocked'} end
  -- 'committed' is NEVER acquirable. Its terminal transition was not confirmed,
  -- so handing the mapping to a later turn could continue a thread whose last
  -- answer the gateway cannot account for. It fails closed exactly like
  -- 'ambiguous' and clears when its own bounded TTL elapses.
  if state == 'committed' then return {'blocked'} end
  if state == 'active' then
    local pj, ok = sealedJson(rec['p'])
    if not ok then return {'corrupt'} end
    payload = pj
  elseif state == 'reserved' or state == 'processing' then
    if rec['l'] > NOW_MS then return {'busy'} end
    if state == 'processing' then
      local tomb = buildRecord('ambiguous', rec['o'], 0, nil)
      if not writeRecord(tomb, 'ambiguous') then return {'corrupt'} end
      return {'blocked'}
    end
    if rec['p'] ~= nil then
      local pj, ok = sealedJson(rec['p'])
      if not ok then return {'corrupt'} end
      payload = pj
    end
  else
    return {'corrupt'}
  end
end

local next = buildRecord('reserved', OWNER, NOW_MS + leaseFor('reserved'), payload)
if not writeRecord(next, 'reserved') then return {'corrupt'} end
return {'acquired', next}
`;

/** Attach a freshly created thread to the caller's own reservation. */
const BIND_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
if rec['s'] ~= 'reserved' then return {'state'} end
-- Never overwrite an existing binding: the reservation already carries a
-- thread, so a second create would silently strand the first.
if rec['p'] ~= nil then return {'state'} end
if not b64ok(ARGV[8], 64) or not b64ok(ARGV[9], MAXBYTES) or not b64ok(ARGV[10], 64) then
  return {'corrupt'}
end
local pj = '{"i":"' .. ARGV[8] .. '","c":"' .. ARGV[9] .. '","t":"' .. ARGV[10] .. '"}'
local next = buildRecord('reserved', OWNER, NOW_MS + leaseFor('reserved'), pj)
if not writeRecord(next, 'reserved') then return {'corrupt'} end
return {'ok'}
`;

/** Move the caller's own reservation to `processing`, immediately before submitting. */
const MARK_PROCESSING_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
if rec['s'] ~= 'reserved' then return {'state'} end
local pj, ok = sealedJson(rec['p'])
if not ok then return {'corrupt'} end
local next = buildRecord('processing', OWNER, NOW_MS + leaseFor('processing'), pj)
if not writeRecord(next, 'processing') then return {'corrupt'} end
return {'ok'}
`;

/**
 * Extend the caller's own lease, taking the state from the AUTHORITATIVE stored
 * record.
 *
 * A renewal races the caller's own transitions: Redis can apply
 * `reserved -> processing` while the transitioning caller is still awaiting its
 * reply, so a renewal issued in that window carries a stale view. Reading the
 * state here means the record is rewritten in the state it actually holds WITH
 * THE LEASE THAT STATE DESERVES — a stale `reserved` view can never shorten a
 * live `processing` record's lease down to 30 s — and an `active` or `ambiguous`
 * record is never revived.
 */
const RENEW_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
local state = rec['s']
if state ~= 'reserved' and state ~= 'processing' then return {'state'} end
local pj = nil
if rec['p'] ~= nil then
  local j, ok = sealedJson(rec['p'])
  if not ok then return {'corrupt'} end
  pj = j
end
if state == 'processing' and pj == nil then return {'corrupt'} end
local next = buildRecord(state, OWNER, NOW_MS + leaseFor(state), pj)
if not writeRecord(next, state) then return {'corrupt'} end
return {'ok', state}
`;

/**
 * FIRST half of the terminal transition: `processing -> committed`.
 *
 * IDEMPOTENT for the same owner. If the mutation applied but its reply never
 * reached the caller, a bounded retry finds the record already `committed` by
 * this owner and acknowledges it. Without that, the caller would conclude
 * "failed" and answer `503` while the mapping had in fact moved on — and under
 * the old single-step transition it would have moved on to a REUSABLE state,
 * so a later turn could continue a thread whose answer was never delivered.
 *
 * `committed` is not acquirable, so an unacknowledged commit can only ever block
 * the session, never leak a reusable mapping to another owner.
 */
const COMMIT_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
local state = rec['s']
if state == 'committed' then return {'ok'} end
if state ~= 'processing' then return {'state'} end
local pj, ok = sealedJson(rec['p'])
if not ok then return {'corrupt'} end
local next = buildRecord('committed', OWNER, 0, pj)
if not writeRecord(next, 'committed') then return {'corrupt'} end
return {'ok'}
`;

/**
 * SECOND half: `committed -> active`. The mapping becomes reusable and its
 * sliding TTL is reset.
 *
 * Also idempotent for the same owner, so a lost reply here is recoverable too.
 * It must never run before {@link COMMIT_SCRIPT} was positively acknowledged.
 *
 * A genuinely ABSENT key is the one failure this script repairs rather than
 * merely reports — see the inline reasoning below.
 */
const ACTIVATE_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err == 'missing' then
  -- The record VANISHED between an acknowledged commit and this activation: an
  -- eviction, an operator delete, or a lifetime that simply ran out.
  --
  -- Reporting 'missing' and writing nothing would leave the key ABSENT, and the
  -- session's very next acquire would see no mapping and silently create a
  -- REPLACEMENT thread — the one behaviour this feature must never have, and a
  -- silent break in conversation continuity rather than a visible failure.
  --
  -- Converting the absence into a tombstone inside THIS script is what makes it
  -- safe: Redis runs the script atomically, so no competing acquire can observe
  -- the gap between the absence check and the write. The next turn is blocked
  -- for the ambiguous TTL and then starts cleanly — the same bounded outcome as
  -- every other post-submit uncertainty. The caller still gets the definitive
  -- 'missing' and still fails closed.
  --
  -- Only absence is repaired. A record that exists under another owner ('lost'),
  -- in another state ('state'), or that is unreadable ('corrupt') is reported
  -- untouched below, because in those cases something else owns the truth.
  local tomb = buildRecord('ambiguous', OWNER, 0, nil)
  if not writeRecord(tomb, 'ambiguous') then return {'corrupt'} end
  return {'missing'}
end
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
local state = rec['s']
if state == 'active' then return {'ok'} end
if state ~= 'committed' then return {'state'} end
local pj, ok = sealedJson(rec['p'])
if not ok then return {'corrupt'} end
local next = buildRecord('active', OWNER, 0, pj)
if not writeRecord(next, 'active') then return {'corrupt'} end
return {'ok'}
`;

/**
 * Settle a PROVEN pre-submit failure.
 *
 * A reservation that carries a thread is restored to `active`, so a capacity
 * rejection or a cancelled request leaves the session exactly as it found it —
 * including the case where this request created the thread but never submitted,
 * which turns what would otherwise be a blank orphan into the session's next
 * usable thread. A reservation that never bound one is simply deleted.
 */
const RELEASE_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
if rec['s'] ~= 'reserved' then return {'state'} end
if rec['p'] == nil then
  redis.call('DEL', KEYS[1])
  return {'ok', '0'}
end
local pj, ok = sealedJson(rec['p'])
if not ok then return {'corrupt'} end
local next = buildRecord('active', OWNER, 0, pj)
if not writeRecord(next, 'active') then return {'corrupt'} end
return {'ok', '1'}
`;

/**
 * Tombstone the caller's own `processing` OR `committed` record; the sealed
 * thread is dropped.
 *
 * `committed` is accepted because a commit whose reply was lost leaves the
 * record in a state its own caller does not know it reached, and settlement
 * must still be able to retire it. No other owner can have taken it in the
 * meantime, because `committed` is not acquirable.
 */
const ABANDON_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
local state = rec['s']
if state ~= 'processing' and state ~= 'committed' then return {'state'} end
local next = buildRecord('ambiguous', OWNER, 0, nil)
if not writeRecord(next, 'ambiguous') then return {'corrupt'} end
return {'ok'}
`;

/**
 * Retire the caller's own `reserved` record whose sealed thread turned out to be
 * UNUSABLE — a ciphertext this gateway cannot authenticate, or a record it just
 * wrote and cannot re-validate.
 *
 * Neither ordinary settlement is right here. `release` would restore the record
 * to `active` and, because every write resets the sliding mapping TTL, each
 * retry would extend the unusable mapping's life — a permanently stuck `503` for
 * that session. Deleting it outright would silently start a replacement thread
 * on the very next request, which is the one behaviour this feature must never
 * have. Tombstoning gives the required outcome: fail closed now, bounded by the
 * ambiguous TTL, then a clean fresh thread.
 */
const DISCARD_SCRIPT = `${PRELUDE}
local rec, err = readRecord()
if err then return {err} end
if rec['o'] ~= OWNER then return {'lost'} end
if rec['s'] ~= 'reserved' then return {'state'} end
local next = buildRecord('ambiguous', OWNER, 0, nil)
if not writeRecord(next, 'ambiguous') then return {'corrupt'} end
return {'ok'}
`;

const SCRIPTS = {
  acquire: defineRedisScript(ACQUIRE_SCRIPT),
  bind: defineRedisScript(BIND_SCRIPT),
  markProcessing: defineRedisScript(MARK_PROCESSING_SCRIPT),
  renew: defineRedisScript(RENEW_SCRIPT),
  commit: defineRedisScript(COMMIT_SCRIPT),
  activate: defineRedisScript(ACTIVATE_SCRIPT),
  release: defineRedisScript(RELEASE_SCRIPT),
  abandon: defineRedisScript(ABANDON_SCRIPT),
  discardUnusable: defineRedisScript(DISCARD_SCRIPT),
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

/** The failure tags shared by every compare-and-transition reply. */
function failureFromTag(tag: string): Exclude<ReuseCasResult, { kind: "ok" }> {
  switch (tag) {
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

function casFromTag(tag: string): ReuseCasResult {
  return tag === "ok" ? { kind: "ok" } : failureFromTag(tag);
}

/**
 * Build the thread-reuse store over the shared Redis substrate.
 *
 * Construction opens NO socket and creates no client: the connection is owned by
 * the process composition root, so `buildServer`, the test suites, and the
 * compiled-import smoke test stay socket-free.
 */
export function createRedisThreadReuseStore(substrate: RedisSubstrate): ThreadReuseStore {
  /**
   * The complete fixed `ARGV` layout. Every script receives every argument, so
   * a script can select a lease or a TTL from the state it is writing or reading
   * without the caller ever choosing one. `seal` is blank except for `bind`.
   */
  const argsFor = (
    owner: string,
    timings: ReuseTimings,
    seal: readonly [string, string, string] = ["", "", ""],
  ): readonly string[] => [
    String(REUSE_RECORD_VERSION),
    String(MAX_REUSE_RECORD_BYTES),
    String(timings.leaseMs),
    String(timings.processingLeaseMs),
    String(timings.mappingTtlMs),
    String(timings.ambiguousTtlMs),
    owner,
    ...seal,
    String(timings.committedTtlMs),
  ];

  async function evalScript(
    name: ScriptName,
    key: string,
    args: readonly string[],
  ): Promise<readonly [string, string | undefined] | null> {
    return taggedReply(await substrate.evalScript(SCRIPTS[name], [key], args));
  }

  return {
    async acquire(key, owner, timings): Promise<ReuseAcquireResult> {
      const reply = await evalScript("acquire", key, argsFor(owner, timings));
      if (reply === null) return { kind: "unavailable" };
      const [tag, value] = reply;
      if (tag === "acquired" && value !== undefined) return { kind: "acquired", raw: value };
      if (tag === "busy") return { kind: "busy" };
      if (tag === "blocked") return { kind: "blocked" };
      if (tag === "corrupt") return { kind: "corrupt" };
      return { kind: "unavailable" };
    },

    async bind(key, owner, sealed, timings): Promise<ReuseCasResult> {
      const reply = await evalScript(
        "bind",
        key,
        argsFor(owner, timings, [sealed.i, sealed.c, sealed.t]),
      );
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async markProcessing(key, owner, timings): Promise<ReuseCasResult> {
      const reply = await evalScript("markProcessing", key, argsFor(owner, timings));
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async renew(key, owner, timings): Promise<ReuseCasResult> {
      const reply = await evalScript("renew", key, argsFor(owner, timings));
      if (reply === null) return { kind: "unavailable" };
      const result = casFromTag(reply[0]);
      if (result.kind !== "ok") return result;
      const observed = reply[1];
      return observed === "reserved" || observed === "processing"
        ? { kind: "ok", observedState: observed }
        : { kind: "ok" };
    },

    async commit(key, owner, timings): Promise<ReuseCasResult> {
      const reply = await evalScript("commit", key, argsFor(owner, timings));
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async activate(key, owner, timings): Promise<ReuseCasResult> {
      const reply = await evalScript("activate", key, argsFor(owner, timings));
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async release(key, owner, timings): Promise<ReuseReleaseResult> {
      const reply = await evalScript("release", key, argsFor(owner, timings));
      if (reply === null) return { kind: "unavailable" };
      const [tag, value] = reply;
      if (tag !== "ok") return failureFromTag(tag);
      return { kind: "ok", restored: value === "1" };
    },

    async abandon(key, owner, timings): Promise<ReuseCasResult> {
      const reply = await evalScript("abandon", key, argsFor(owner, timings));
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async discardUnusable(key, owner, timings): Promise<ReuseCasResult> {
      const reply = await evalScript("discardUnusable", key, argsFor(owner, timings));
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    isReady(): boolean {
      return substrate.isReady();
    },
  };
}
