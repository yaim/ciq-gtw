/**
 * Redis-backed implementation of the shared-capacity store (Phase 4D;
 * specification section 19.2).
 *
 * This module owns the two server-side Lua scripts and this boundary's reply
 * vocabulary; the coordinator above it sees only the narrow
 * {@link SharedCapacityStore} port. The connection belongs to the shared
 * substrate (`src/redis/`), which every Redis-backed feature shares, so the
 * process holds exactly one client.
 *
 * Five properties are load bearing and are enforced here rather than above:
 *
 *  - **Every mutation is one atomic server-side script.** There is no
 *    read-then-write anywhere in the correctness path, so two replicas racing
 *    the same registry are serialized by Redis rather than by any local lock.
 *    Occupancy is counted, the grant decision is made, and the members are added
 *    inside a single invocation, which is what makes the cluster-wide limit
 *    actually a limit.
 *
 *  - **The lease deadline always comes from Redis's own `TIME`, never a Node
 *    clock.** A replica with a skewed clock could otherwise mint a permit that
 *    outlives every other replica's view of it, or treat a live permit as
 *    expired and over-admit. The caller supplies a lease DURATION; the deadline
 *    is stamped server-side.
 *
 *  - **The COMPLETE registry is validated before it is mutated.** `TYPE` is
 *    checked before any ZSET command (a wrong-type key would otherwise raise a
 *    `WRONGTYPE` error and lose the `corrupt` classification), `ZCARD` bounds
 *    cardinality BEFORE any member is materialized, and every member, version,
 *    exact canonical component encoding, byte bound, score, and owner-token
 *    uniqueness is checked before the first write. Each stored deadline is also
 *    bounded ABOVE relative to the server's own clock, because a far-future
 *    deadline would pin the registry key's expiry and never prune, so one
 *    hostile write could under-admit the cluster indefinitely. A rejected
 *    registry is left byte-for-byte untouched — the gateway never sanitizes
 *    hostile state into valid state, and an expired lease is pruned rather than
 *    treated as invalid.
 *
 *  - **A reply is trusted only against the batch that was submitted.** A grant
 *    names owner tokens, and each named token must be canonical, submitted by
 *    THIS call, named once, and in candidate order. The granted set is an
 *    ordered subset rather than a prefix, so the check is an index cursor, and
 *    anything else is `unavailable` rather than a partially trusted grant list.
 *    Both closed replies carry exactly one element, so an unexpected arity is
 *    never read as a verdict.
 *
 *  - **There is no renewal script and no heartbeat.** A lease is a crash reaper
 *    derived from the holder's own deadline plus a margin, so a live request's
 *    permit cannot expire mid-completion while a hard-killed replica's permits
 *    are still reclaimed within a bounded window. Adding renewal would mean a
 *    starved replica could lose a permit it is legitimately using.
 *
 * Stored state is one namespace-level ZSET whose members carry only a version, a
 * random owner token, and an opaque capacity scope — no request, thread,
 * session, model, tool, prompt, answer, credential, raw gateway key, or
 * process-local identity.
 */
import { defineRedisScript, type RedisReply, type RedisSubstrate } from "../redis/index.js";
import {
  CAPACITY_MEMBER_VERSION,
  MAX_CAPACITY_CLAIM_BATCH,
  MAX_CAPACITY_LEASE_MS,
  MAX_CAPACITY_MEMBER_BYTES,
  MAX_CAPACITY_REGISTRY_MEMBERS,
} from "./limits.js";
import {
  CAPACITY_OWNER_FINAL_CHARS,
  CAPACITY_OWNER_TOKEN_CHARS,
  CAPACITY_SCOPE_CHARS,
  CAPACITY_SCOPE_FINAL_CHARS,
  isCanonicalCapacityOwner,
} from "./members.js";
import type {
  CapacityCandidate,
  CapacityClaimLimits,
  CapacityClaimResult,
  CapacityReleaseResult,
  SharedCapacityStore,
} from "./store.js";

/**
 * Shared prelude: argument validation, the Redis clock, the bounded and fully
 * validated registry read, expiry pruning, and the registry's own lifetime.
 *
 * Fixed leading `ARGV` layout, identical for both scripts:
 *
 * ```text
 * ARGV[1] member version      ARGV[4] max lease ms
 * ARGV[2] max member bytes    ARGV[5] max claim batch
 * ARGV[3] max registry members
 * ```
 *
 * Each script then appends its own arguments from `ARGV[6]`.
 */
const PRELUDE = `
-- Every fixed numeric argument must be a POSITIVE INTEGER.
--
-- tonumber succeeding is NOT enough: it also accepts a fractional value, which
-- would satisfy every bound comparison below and then be used as a count, or
-- stored as a deadline the integer score predicates cannot reason about. The
-- explicit integrality test is what keeps those whole. It judges the VALUE, not
-- the spelling, so an exactly integral value written unusually is accepted on
-- its merits and cannot widen anything; each caller bounds magnitude separately.
-- The 1e15 ceiling keeps every accepted value far inside the range Lua 5.1
-- doubles represent exactly and is also what rejects an infinity, whose own
-- floor is itself, while NaN is refused by its own inequality.
local function posInt(n)
  if type(n) ~= 'number' then return false end
  if n ~= n or n < 1 or n >= 1e15 then return false end
  return n == math.floor(n)
end

local VERSION = ARGV[1]
local MAXMEMBER = tonumber(ARGV[2])
local MAXMEMBERS = tonumber(ARGV[3])
local MAXLEASE = tonumber(ARGV[4])
local MAXBATCH = tonumber(ARGV[5])
if type(VERSION) ~= 'string' or not string.match(VERSION, '^%d+$') then return {'corrupt'} end
if not posInt(MAXMEMBER) then return {'corrupt'} end
if not posInt(MAXMEMBERS) then return {'corrupt'} end
if not posInt(MAXLEASE) then return {'corrupt'} end
-- A batch ceiling wider than the registry may hold could never be honoured.
if not posInt(MAXBATCH) or MAXBATCH > MAXMEMBERS then return {'corrupt'} end

local clock = redis.call('TIME')
if type(clock) ~= 'table' then return {'corrupt'} end
local secs = tonumber(clock[1])
local usecs = tonumber(clock[2])
if not secs or not usecs or secs < 0 or usecs < 0 then return {'corrupt'} end
local NOW_MS = secs * 1000 + math.floor(usecs / 1000)

-- EXACT canonical unpadded base64url, per component, rather than a bounded
-- alphabet.
--
-- Unpadded base64url carries 6 bits per character, so a byte count that is not a
-- multiple of 3 leaves spare LOW BITS in the final character which a canonical
-- encoder writes as zero. That is why each final-character class below is far
-- narrower than the alphabet, and the narrowing is the whole point: a 16-byte
-- owner token spans 22 characters and leaves 4 spare bits, a 32-byte scope spans
-- 43 and leaves 2, so any other final character is a SECOND SPELLING of the same
-- bytes. A member's identity is its byte string, so two spellings of one owner
-- token would be two registry members for one permit.
--
-- The alphabet also excludes the member delimiter, so a component can never
-- forge an extra field inside a member.
--
-- Both lengths and both classes are interpolated from the same exported
-- constants the TypeScript validators use, so the server-side and client-side
-- notions of canonical cannot drift apart. Lua patterns have no counted
-- repetition, so the fixed-length prefix is assembled with string.rep.
local B64 = '[A-Za-z0-9_-]'
local OWNER_CHARS = ${String(CAPACITY_OWNER_TOKEN_CHARS)}
local SCOPE_CHARS = ${String(CAPACITY_SCOPE_CHARS)}
local OWNER_PATTERN =
  '^' .. string.rep(B64, ${String(CAPACITY_OWNER_TOKEN_CHARS - 1)}) .. '[${CAPACITY_OWNER_FINAL_CHARS}]$'
local SCOPE_PATTERN =
  '^' .. string.rep(B64, ${String(CAPACITY_SCOPE_CHARS - 1)}) .. '[${CAPACITY_SCOPE_FINAL_CHARS}]$'

local function ownerOk(v)
  if type(v) ~= 'string' or #v ~= OWNER_CHARS then return false end
  return string.match(v, OWNER_PATTERN) ~= nil
end

local function scopeOk(v)
  if type(v) ~= 'string' or #v ~= SCOPE_CHARS then return false end
  return string.match(v, SCOPE_PATTERN) ~= nil
end

-- Split a member into (owner, scope), or nil when it is not a member THIS
-- gateway could have written. The anchored pattern admits exactly two
-- delimiters, and each component validator re-rejects the delimiter.
local function parseMember(m)
  if type(m) ~= 'string' then return nil end
  if #m > MAXMEMBER then return nil end
  local v, o, s = string.match(m, '^([^|]+)|([^|]+)|([^|]+)$')
  if not v or v ~= VERSION then return nil end
  if not ownerOk(o) then return nil end
  if not scopeOk(s) then return nil end
  return o, s
end

-- A score must be a real, non-negative, integral millisecond deadline that THIS
-- registry could have minted. The digit-only pattern rejects a negative,
-- fractional, exponential, infinite, or NaN score outright rather than coercing
-- it, and the 15-digit cap keeps the value far inside the range Lua 5.1 doubles
-- represent exactly.
--
-- The upper bound is relative to the SERVER's own clock: an honest grant stamps
-- NOW_MS plus a lease of at most MAXLEASE, so no stored deadline can
-- legitimately sit further ahead than that. Without it, one forged far-future
-- deadline would pin the registry key's own expiry (finalize expires the key at
-- the latest lease) and, never expiring, would never be pruned either, so a
-- single hostile write could under-admit the whole cluster indefinitely.
--
-- An EXPIRED deadline is an entirely different matter and stays VALID: it is
-- pruned, after the complete registry has validated. Corrupt means "this
-- registry was not written by an honest gateway", not "this lease is over".
local function scoreOk(raw)
  if type(raw) ~= 'string' then return nil end
  if #raw < 1 or #raw > 15 then return nil end
  if not string.match(raw, '^%d+$') then return nil end
  local n = tonumber(raw)
  if not n or n < 0 or n >= 1e15 or n ~= math.floor(n) then return nil end
  if n > NOW_MS + MAXLEASE then return nil end
  return n
end

-- Bounded, STRICTLY guarded read of the COMPLETE registry.
--
-- Returns (live, nil, liveOwners, latest) or (nil, 'corrupt'). The live table
-- holds only the members whose lease has NOT expired, liveOwners is the set of
-- their owner tokens, and latest is the greatest surviving deadline. Every
-- return is four values, so a fifth added later cannot silently arrive as nil
-- on one path only.
--
-- Nothing is mutated here and nothing is mutated by any caller before this
-- returns, so a registry that fails validation is left byte-for-byte untouched.
local function readRegistry()
  local kind = redis.call('TYPE', KEYS[1])
  if type(kind) ~= 'table' then return nil, 'corrupt', nil, nil end
  local name = kind['ok']
  if name == 'none' then return {}, nil, {}, nil end
  -- Checked BEFORE any ZSET command: a wrong-type key would otherwise raise
  -- WRONGTYPE and abort the script, losing the closed 'corrupt' classification.
  if name ~= 'zset' then return nil, 'corrupt', nil, nil end

  -- Cardinality is bounded BEFORE a single member is materialized.
  local count = redis.call('ZCARD', KEYS[1])
  if type(count) ~= 'number' or count < 0 or count > MAXMEMBERS then
    return nil, 'corrupt', nil, nil
  end

  -- The explicit upper index makes the read bound structural rather than merely
  -- implied by the ZCARD check above.
  local flat = redis.call(
    'ZRANGE', KEYS[1], '0', string.format('%d', MAXMEMBERS - 1), 'WITHSCORES'
  )
  if type(flat) ~= 'table' then return nil, 'corrupt', nil, nil end
  if #flat ~= count * 2 then return nil, 'corrupt', nil, nil end

  local live = {}
  local liveOwners = {}
  local seenOwners = {}
  local latest = nil
  local i = 1
  while i <= #flat do
    local member = flat[i]
    local owner, scope = parseMember(member)
    if not owner then return nil, 'corrupt', nil, nil end
    local deadline = scoreOk(flat[i + 1])
    if not deadline then return nil, 'corrupt', nil, nil end
    -- REGISTRY INTEGRITY, judged across every stored member including expired
    -- ones: two members sharing an owner token means the registry was not
    -- written solely by honest gateways, which 128 bits of randomness makes
    -- unreachable. This is deliberately a different question from whether an
    -- incoming CANDIDATE collides, which is judged against liveOwners only —
    -- an expired member is about to be pruned, so its token is not in use.
    if seenOwners[owner] then return nil, 'corrupt', nil, nil end
    seenOwners[owner] = true
    if deadline > NOW_MS then
      live[#live + 1] = { owner = owner, scope = scope, deadline = deadline }
      liveOwners[owner] = true
      if latest == nil or deadline > latest then latest = deadline end
    end
    i = i + 2
  end
  return live, nil, liveOwners, latest
end

-- Drop every expired lease. Called ONLY after the complete registry validated,
-- so this can never remove a member that was not inspected first. Scores are
-- validated integers, so a score range is an exact expiry predicate.
local function pruneExpired()
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%d', NOW_MS))
end

-- Re-expire the registry at its LATEST active lease, or delete it when empty.
--
-- No grace is added: an absent registry and one holding no live member mean
-- exactly the same thing — no permits are held — so the tightest correct bound
-- is the latest deadline itself.
--
-- Only the release script can reach the delete branch. A claim that finds no
-- live member always grants its first candidate (occupancy is zero and every
-- per-scope limit is at least one), so it always finishes with a deadline.
local function finalize(latest)
  if latest == nil then
    redis.call('DEL', KEYS[1])
    return
  end
  redis.call('PEXPIREAT', KEYS[1], string.format('%d', latest))
end
`;

/**
 * Atomically prune, count, and grant an ordered subset of candidates.
 *
 * ```text
 * ARGV[6]            candidate count
 * ARGV[7]            cluster-wide global active limit
 * ARGV[8]            cluster-wide per-scope active limit
 * ARGV[9 + 3i]       candidate i owner
 * ARGV[10 + 3i]      candidate i scope
 * ARGV[11 + 3i]      candidate i lease, in ms
 * ```
 *
 * Reply: `{'claimed', <owner>...}` (possibly no owners) | `{'corrupt'}`.
 *
 * A candidate whose scope is already at the per-scope limit is SKIPPED rather
 * than blocking the batch, so a later candidate with a different scope can still
 * be granted — the cross-replica analogue of the local controller's per-key
 * bypass. Granting stops the moment global occupancy reaches the global limit,
 * which is also why a batch may not exceed that limit: candidates beyond it are
 * work no reply could justify, and the coordinator already caps a batch there.
 */
const CLAIM_SCRIPT = `${PRELUDE}
local COUNT = tonumber(ARGV[6])
local MAX_ACTIVE = tonumber(ARGV[7])
local MAX_PER_SCOPE = tonumber(ARGV[8])
-- Every bound is enforced HERE, by the server, rather than only by the
-- coordinator that happens to build the batch: a caller cannot widen the bound
-- the registry is willing to materialize or grant. Each supplied limit is
-- additionally capped by the fixed ceiling above it, so a malformed input is
-- refused rather than silently truncated to something plausible.
if not posInt(MAX_ACTIVE) or MAX_ACTIVE > MAXBATCH then return {'corrupt'} end
if not posInt(MAX_PER_SCOPE) or MAX_PER_SCOPE > MAX_ACTIVE then return {'corrupt'} end
-- A batch larger than one claim could ever grant is a caller bug: the
-- coordinator caps a batch at the configured global limit, and materializing
-- candidates beyond it is work no reply could justify.
if not posInt(COUNT) or COUNT > MAXBATCH or COUNT > MAX_ACTIVE then return {'corrupt'} end
if #ARGV ~= 8 + COUNT * 3 then return {'corrupt'} end

local live, err, liveOwners, latest = readRegistry()
if err then return {'corrupt'} end

-- Every candidate is validated BEFORE anything is written, so a malformed batch
-- cannot leave a partially applied claim behind.
local candidates = {}
local seen = {}
for i = 0, COUNT - 1 do
  local owner = ARGV[9 + i * 3]
  local scope = ARGV[10 + i * 3]
  local leaseMs = tonumber(ARGV[11 + i * 3])
  if not ownerOk(owner) then return {'corrupt'} end
  if not scopeOk(scope) then return {'corrupt'} end
  if not posInt(leaseMs) or leaseMs > MAXLEASE then return {'corrupt'} end
  -- A repeated owner token inside one batch, or one already held by a LIVE
  -- member, would add a second member for the same permit. An EXPIRED member's
  -- token is not a conflict: it is pruned below, so rejecting it would leave
  -- the batch failing closed against state that is already gone.
  if seen[owner] or liveOwners[owner] then return {'corrupt'} end
  seen[owner] = true
  local member = VERSION .. '|' .. owner .. '|' .. scope
  if #member > MAXMEMBER then return {'corrupt'} end
  candidates[#candidates + 1] = {
    owner = owner, scope = scope, member = member, deadline = NOW_MS + leaseMs,
  }
end

-- Validation is complete; from here the registry may be mutated.
pruneExpired()

local active = #live
local perScope = {}
for i = 1, #live do
  local s = live[i].scope
  perScope[s] = (perScope[s] or 0) + 1
end

local granted = {'claimed'}
for i = 1, #candidates do
  if active >= MAX_ACTIVE then break end
  local c = candidates[i]
  local held = perScope[c.scope] or 0
  if held < MAX_PER_SCOPE then
    -- One ZADD per grant. The batch is bounded by the configured global limit,
    -- and a realistic batch is a handful of members, so this stays far cheaper
    -- than the varargs table an aggregated ZADD would need.
    redis.call('ZADD', KEYS[1], string.format('%d', c.deadline), c.member)
    perScope[c.scope] = held + 1
    active = active + 1
    if latest == nil or c.deadline > latest then latest = c.deadline end
    granted[#granted + 1] = c.owner
  end
end

finalize(latest)
return granted
`;

/**
 * Atomically remove one exact member.
 *
 * ```text
 * ARGV[6] owner token
 * ARGV[7] capacity scope
 * ```
 *
 * Reply: `{'ok'}` | `{'corrupt'}`.
 *
 * IDEMPOTENT: an already-removed member (a repeat release, or one pruned by its
 * own lease expiry) still reports `ok`, because the post-condition the caller
 * needs is "this permit is not held", not "this call performed the removal".
 */
const RELEASE_SCRIPT = `${PRELUDE}
local OWNER = ARGV[6]
local SCOPE = ARGV[7]
if not ownerOk(OWNER) then return {'corrupt'} end
if not scopeOk(SCOPE) then return {'corrupt'} end
if #ARGV ~= 7 then return {'corrupt'} end

local live, err = readRegistry()
if err then return {'corrupt'} end

-- Validation is complete; from here the registry may be mutated.
pruneExpired()

local member = VERSION .. '|' .. OWNER .. '|' .. SCOPE
redis.call('ZREM', KEYS[1], member)

-- Compute the latest deadline from the members that actually remain, so
-- releasing the longest-leased permit shortens the registry's own lifetime
-- instead of leaving it pinned to a deadline nothing holds any more. The read's
-- own latest value is deliberately not reused: it still counts the member this
-- call just removed. The exclusion matches the FULL member the ZREM targeted,
-- not merely its owner, so a member this call did not remove keeps its deadline.
local latest = nil
for i = 1, #live do
  local l = live[i]
  if l.owner ~= OWNER or l.scope ~= SCOPE then
    if latest == nil or l.deadline > latest then latest = l.deadline end
  end
end

finalize(latest)
return {'ok'}
`;

const CLAIM = defineRedisScript(CLAIM_SCRIPT);
const RELEASE = defineRedisScript(RELEASE_SCRIPT);

/** The fixed leading arguments every script receives. */
const BASE_ARGS: readonly string[] = Object.freeze([
  String(CAPACITY_MEMBER_VERSION),
  String(MAX_CAPACITY_MEMBER_BYTES),
  String(MAX_CAPACITY_REGISTRY_MEMBERS),
  String(MAX_CAPACITY_LEASE_MS),
  String(MAX_CAPACITY_CLAIM_BATCH),
]);

/**
 * Read the granted owner tokens out of a `{'claimed', ...}` reply, validated
 * against the batch THIS call submitted.
 *
 * A named owner is an authorization to occupy a cluster-wide permit, so the
 * reply is trusted only when every element is a canonical owner token that this
 * call submitted, appears at most once, and appears in CANDIDATE ORDER.
 *
 * The granted set is an ordered SUBSET rather than a prefix — per-scope bypass
 * legitimately skips a candidate so a later distinct scope can still be granted
 * — which is why the check is a strictly increasing index cursor over a
 * candidate index map. A membership test alone would accept a duplicated or
 * reordered reply, and a prefix test would reject an honest one.
 *
 * Anything else yields `null`, which the caller maps to `unavailable`: a
 * partially trusted list would hand a permit to a waiter Redis never granted and
 * leave a member nothing ever releases. An EMPTY list is not a failure — it is
 * ordinary full-cluster backpressure. Classification is all this does: a
 * malformed reply is never retried or compensated, because the mutation may
 * already have applied.
 */
function grantedOwners(
  reply: RedisReply,
  candidateIndex: ReadonlyMap<string, number>,
): readonly string[] | null {
  const granted: string[] = [];
  let cursor = -1;
  for (let i = 1; i < reply.length; i += 1) {
    const owner = reply[i];
    // The canonical check also rejects a non-string, an empty string, a
    // wrong-length token, and a second spelling of a real token's bytes.
    if (typeof owner !== "string" || !isCanonicalCapacityOwner(owner)) return null;
    const at = candidateIndex.get(owner);
    if (at === undefined) return null;
    // STRICTLY increasing, so a duplicate (the same index twice) and a
    // reordering (a lower index) are both refused while a skip is not.
    if (at <= cursor) return null;
    cursor = at;
    granted.push(owner);
  }
  return granted;
}

/**
 * Build the shared-capacity store over the shared Redis substrate.
 *
 * Construction opens NO socket and creates no client: the connection is owned by
 * the process composition root, so `buildServer`, the test suites, and the
 * compiled-import smoke test stay socket-free.
 */
export function createRedisSharedCapacityStore(substrate: RedisSubstrate): SharedCapacityStore {
  return {
    async claimBatch(
      key: string,
      candidates: readonly CapacityCandidate[],
      limits: CapacityClaimLimits,
      signal?: AbortSignal,
    ): Promise<CapacityClaimResult> {
      // An empty batch is a caller bug, not a Redis condition: answer it without
      // issuing a command rather than shipping a script that must reject it.
      if (candidates.length === 0) return { kind: "claimed", granted: [] };
      // Keep the boundary total in its own right. The script enforces the same
      // ceiling, so this only avoids shipping a command whose one possible
      // answer is `corrupt`; the coordinator already caps a batch at the
      // configured global limit, so neither check is reachable from the gateway.
      if (candidates.length > MAX_CAPACITY_CLAIM_BATCH) return { kind: "corrupt" };

      // A duplicated owner token is the same class of caller bug, answered the
      // same way: without a round trip. It is also what makes the index below
      // unambiguous, and therefore what lets a reply's ORDER be checked at all.
      const candidateIndex = new Map<string, number>();
      for (const [index, entry] of candidates.entries()) {
        if (candidateIndex.has(entry.owner)) return { kind: "corrupt" };
        candidateIndex.set(entry.owner, index);
      }

      const args: string[] = [
        ...BASE_ARGS,
        String(candidates.length),
        String(limits.maxActive),
        String(limits.maxActivePerScope),
      ];
      for (const candidate of candidates) {
        args.push(candidate.owner, candidate.scope, String(candidate.leaseMs));
      }

      const reply = await substrate.evalScript(
        CLAIM,
        [key],
        args,
        signal === undefined ? undefined : { signal },
      );
      // The substrate collapses every failure to `null`; the coordinator
      // distinguishes a cancellation from an unusable dependency by re-checking
      // its own signals after the await.
      if (reply === null) return { kind: "unavailable" };
      // The closed `corrupt` branch is exactly one element, so an extra field
      // means the reply did not come from it and must not be classified as a
      // verdict about the registry.
      if (reply[0] === "corrupt") {
        return reply.length === 1 ? { kind: "corrupt" } : { kind: "unavailable" };
      }
      if (reply[0] !== "claimed") return { kind: "unavailable" };
      const granted = grantedOwners(reply, candidateIndex);
      return granted === null ? { kind: "unavailable" } : { kind: "claimed", granted };
    },

    async release(
      key: string,
      owner: string,
      scope: string,
      signal?: AbortSignal,
    ): Promise<CapacityReleaseResult> {
      const reply = await substrate.evalScript(
        RELEASE,
        [key],
        [...BASE_ARGS, owner, scope],
        signal === undefined ? undefined : { signal },
      );
      if (reply === null) return { kind: "unavailable" };
      // BOTH closed replies are exactly one element, so any extra field means
      // the reply did not come from this script; neither outcome may then be
      // inferred, and neither is ever retried or compensated.
      if (reply.length !== 1) return { kind: "unavailable" };
      if (reply[0] === "ok") return { kind: "ok" };
      if (reply[0] === "corrupt") return { kind: "corrupt" };
      return { kind: "unavailable" };
    },

    isReady(): boolean {
      return substrate.isReady();
    },
  };
}
