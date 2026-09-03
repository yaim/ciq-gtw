/**
 * Command-level contract for the Redis-backed shared-capacity store (Phase 4D;
 * specification section 19.2).
 *
 * These tests drive the store over a STUB substrate that records every
 * `evalScript` call and answers it from a queue of canned replies, so they
 * assert what the gateway actually puts on the wire — one key, the fixed `ARGV`
 * layout, the reply vocabulary, and the abort-signal policy — plus the static
 * invariants of the Lua it ships. Lua SEMANTICS are proven separately against a
 * real server by `test/redis/shared-capacity-store.test.ts`.
 *
 * Everything here is synthetic, and nothing here executes Lua.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defineRedisScript,
  type RedisEvalOptions,
  type RedisReply,
  type RedisScript,
  type RedisSubstrate,
} from "../../src/redis/index.js";
import {
  CAPACITY_MEMBER_VERSION,
  CAPACITY_OWNER_FINAL_CHARS,
  CAPACITY_OWNER_TOKEN_CHARS,
  CAPACITY_SCOPE_CHARS,
  CAPACITY_SCOPE_FINAL_CHARS,
  createRedisSharedCapacityStore,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
  isCanonicalCapacityOwner,
  MAX_CAPACITY_CLAIM_BATCH,
  MAX_CAPACITY_LEASE_MS,
  MAX_CAPACITY_MEMBER_BYTES,
  MAX_CAPACITY_REGISTRY_MEMBERS,
  newCapacityOwnerToken,
  type CapacityCandidate,
  type CapacityClaimLimits,
  type CapacityClaimResult,
  type CapacityReleaseResult,
  type SharedCapacityStore,
} from "../../src/shared-capacity/index.js";

const KEY = "test-ns:capacity:AAAA";

/**
 * Synthetic but CANONICAL fixtures, minted by the same functions production
 * uses.
 *
 * Both the server-side validator and the reply parser require an exact
 * canonical unpadded base64url encoding, so a readable placeholder like
 * `ownerAlpha` would now be rejected for its SPELLING rather than for whatever
 * a case is actually about.
 */
const KEYRING = deriveSharedCapacityKeyring(randomBytes(32).toString("base64url"));
const OWNER_A = newCapacityOwnerToken();
const OWNER_B = newCapacityOwnerToken();
const OWNER_C = newCapacityOwnerToken();
const SCOPE_A = deriveCapacityScope(KEYRING, "gw-fake-key-SENTINEL-alpha");
const SCOPE_B = deriveCapacityScope(KEYRING, "gw-fake-key-SENTINEL-bravo");

const LIMITS: CapacityClaimLimits = { maxActive: 12, maxActivePerScope: 4 };

/**
 * The fixed leading arguments both scripts receive. Taken from the boundary's
 * own constants, never from literals duplicated here: a bound that changed in
 * `limits.ts` without changing the wire would otherwise go unnoticed.
 */
const BASE_ARGS: readonly string[] = [
  String(CAPACITY_MEMBER_VERSION),
  String(MAX_CAPACITY_MEMBER_BYTES),
  String(MAX_CAPACITY_REGISTRY_MEMBERS),
  String(MAX_CAPACITY_LEASE_MS),
  String(MAX_CAPACITY_CLAIM_BATCH),
];

/** Arguments a claim ships before its per-candidate triples. */
const CLAIM_HEADER_ARGS = BASE_ARGS.length + 3;

/** Every ZSET command either script may issue. */
const ZSET_COMMANDS = ["ZCARD", "ZRANGE", "ZADD", "ZREM", "ZREMRANGEBYSCORE"] as const;

/** Every command either script may use to MUTATE the registry or its lifetime. */
const MUTATIONS = ["ZADD", "ZREM", "ZREMRANGEBYSCORE", "DEL", "PEXPIREAT"] as const;

/** The base64url alphabet in encoding order, so a character's index IS its value. */
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same bytes as `owner`, spelled NON-canonically.
 *
 * A canonical owner token's final character carries four SPARE low bits that the
 * encoder leaves zero, which is why only `A`, `Q`, `g`, and `w` (the values
 * divisible by 16) can terminate one. Taking the NEXT alphabet character keeps
 * both data bits and dirties only a spare one, so the result decodes to the
 * identical 16 bytes — when the canonical final is `A`, that character is `B`.
 * Replacing the final character with a fixed letter would not do: against a
 * token ending in `Q`, `g`, or `w` it would change the data bits too, and the
 * case would then be about different bytes rather than a second spelling.
 */
function nonCanonicalOwner(owner: string): string {
  const final = owner.slice(-1);
  return `${owner.slice(0, -1)}${BASE64URL[BASE64URL.indexOf(final) + 1] ?? "B"}`;
}

interface RecordedEval {
  readonly script: RedisScript;
  readonly keys: readonly string[];
  readonly args: readonly string[];
  readonly options: RedisEvalOptions | undefined;
}

interface Harness {
  readonly store: SharedCapacityStore;
  readonly calls: readonly RecordedEval[];
  setReady(ready: boolean): void;
}

/**
 * Build the store over a stub substrate. An exhausted reply queue is a test bug,
 * so it throws loudly — the real substrate is total and returns `null` instead.
 */
function harness(replies: readonly (RedisReply | null)[] = []): Harness {
  const calls: RecordedEval[] = [];
  const queue = [...replies];
  let ready = true;

  const substrate: RedisSubstrate = {
    evalScript(script, keys, args, options) {
      calls.push({ script, keys: [...keys], args: [...args], options });
      if (queue.length === 0) throw new Error("stub substrate: no scripted reply left");
      return Promise.resolve(queue.shift() ?? null);
    },
    isReady: () => ready,
  };

  return {
    store: createRedisSharedCapacityStore(substrate),
    calls,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

function evaluated(h: Harness, index = 0): RecordedEval {
  const call = h.calls[index];
  if (call === undefined) throw new Error(`no script was evaluated at index ${String(index)}`);
  return call;
}

function candidate(owner: string, scope: string, leaseMs = 60_000): CapacityCandidate {
  return { owner, scope, leaseMs };
}

/** Submit `candidates`, answer the one claim with `reply`, and return the outcome. */
async function claimWith(
  reply: RedisReply | null,
  candidates: readonly CapacityCandidate[],
): Promise<CapacityClaimResult> {
  return harness([reply]).store.claimBatch(KEY, candidates, LIMITS);
}

/** The two script bodies the store actually ships, in one round trip each. */
async function shippedScripts(): Promise<{ claim: RedisScript; release: RedisScript }> {
  const h = harness([["claimed"], ["ok"]]);
  await h.store.claimBatch(KEY, [candidate(OWNER_A, SCOPE_A)], LIMITS);
  await h.store.release(KEY, OWNER_A, SCOPE_A);
  return { claim: evaluated(h, 0).script, release: evaluated(h, 1).script };
}

describe("shared-capacity store: claim command shape", () => {
  it("ships exactly ONE key and the documented argument layout", async () => {
    const h = harness([["claimed"]]);
    await h.store.claimBatch(
      KEY,
      [candidate(OWNER_A, SCOPE_A, 60_000), candidate(OWNER_B, SCOPE_B, 90_000)],
      LIMITS,
    );

    expect(h.calls).toHaveLength(1);
    const call = evaluated(h);
    // One namespace-level registry key: the global limit could not be counted
    // atomically across gateway keys from more than one key.
    expect(call.keys).toEqual([KEY]);
    expect(call.args).toEqual([
      ...BASE_ARGS,
      "2",
      String(LIMITS.maxActive),
      String(LIMITS.maxActivePerScope),
      OWNER_A,
      SCOPE_A,
      "60000",
      OWNER_B,
      SCOPE_B,
      "90000",
    ]);
    expect(call.args).toHaveLength(CLAIM_HEADER_ARGS + 3 * 2);
  });

  it("ships each canonical component VERBATIM, adding no encoding of its own", async () => {
    const h = harness([["claimed"]]);
    await h.store.claimBatch(KEY, [candidate(OWNER_A, SCOPE_A)], LIMITS);
    const shipped = evaluated(h).args.slice(CLAIM_HEADER_ARGS);
    // The script assembles the member from these exact bytes, so any
    // re-encoding, trimming, or case change here would store a different member
    // from the one the caller will later release.
    expect(shipped).toEqual([OWNER_A, SCOPE_A, "60000"]);
    expect(OWNER_A).toHaveLength(CAPACITY_OWNER_TOKEN_CHARS);
    expect(SCOPE_A).toHaveLength(CAPACITY_SCOPE_CHARS);
  });

  it("carries the fixed bounds from `limits.ts` as its leading arguments", async () => {
    const h = harness([["claimed"]]);
    await h.store.claimBatch(KEY, [candidate(OWNER_A, SCOPE_A, 1_000)], LIMITS);
    expect(evaluated(h).args.slice(0, BASE_ARGS.length)).toEqual(BASE_ARGS);
    // The script is TOLD each bound rather than trusting a caller's value, so it
    // can reject an over-long lease or an over-wide batch server-side.
    expect(BASE_ARGS[3]).toBe("630000");
    expect(BASE_ARGS[4]).toBe(String(MAX_CAPACITY_CLAIM_BATCH));
  });

  it("preserves the SUBMITTED candidate order, which is local FIFO order", async () => {
    const candidates = [
      candidate(OWNER_A, SCOPE_A, 31_000),
      candidate(OWNER_B, SCOPE_B, 32_000),
      candidate(OWNER_C, SCOPE_A, 33_000),
    ];
    const h = harness([["claimed"]]);
    await h.store.claimBatch(KEY, candidates, LIMITS);
    expect(evaluated(h).args.slice(CLAIM_HEADER_ARGS)).toEqual([
      OWNER_A,
      SCOPE_A,
      "31000",
      OWNER_B,
      SCOPE_B,
      "32000",
      OWNER_C,
      SCOPE_A,
      "33000",
    ]);
    expect(evaluated(h).args).toHaveLength(CLAIM_HEADER_ARGS + 3 * candidates.length);
  });

  it("issues NO command at all for an empty batch", async () => {
    const h = harness();
    expect(await h.store.claimBatch(KEY, [], LIMITS)).toEqual({ kind: "claimed", granted: [] });
    // An empty batch is a caller bug, not a Redis condition: answering it here
    // keeps the script free of a case it would otherwise have to reject.
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a batch past the ceiling without issuing a command", async () => {
    const h = harness();
    const oversized = Array.from({ length: MAX_CAPACITY_CLAIM_BATCH + 1 }, () =>
      candidate(newCapacityOwnerToken(), SCOPE_A),
    );
    expect(await h.store.claimBatch(KEY, oversized, LIMITS)).toEqual({ kind: "corrupt" });
    // The script would reject it too; not shipping a command whose one possible
    // answer is `corrupt` keeps a hostile argument list off the wire entirely.
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a batch holding one owner token twice, without issuing a command", async () => {
    const h = harness();
    expect(
      await h.store.claimBatch(
        KEY,
        [candidate(OWNER_A, SCOPE_A), candidate(OWNER_A, SCOPE_B)],
        LIMITS,
      ),
    ).toEqual({ kind: "corrupt" });
    // Same treatment as an oversized batch: a caller bug answered without a
    // round trip. It is also what makes the candidate index unambiguous, and
    // therefore what lets a reply's ORDER be checked at all.
    expect(h.calls).toHaveLength(0);
  });

  it("reports the substrate's availability without issuing a command", () => {
    const h = harness();
    expect(h.store.isReady()).toBe(true);
    h.setReady(false);
    expect(h.store.isReady()).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});

describe("shared-capacity store: claim reply mapping", () => {
  it("names the granted owner tokens, in candidate order", async () => {
    const candidates = [candidate(OWNER_A, SCOPE_A), candidate(OWNER_B, SCOPE_B)];
    expect(await claimWith(["claimed", OWNER_A, OWNER_B], candidates)).toEqual({
      kind: "claimed",
      granted: [OWNER_A, OWNER_B],
    });
  });

  it("accepts a SKIPPED ordered subset, which per-scope bypass legitimately produces", async () => {
    const candidates = [
      candidate(OWNER_A, SCOPE_A),
      candidate(OWNER_B, SCOPE_A),
      candidate(OWNER_C, SCOPE_B),
    ];
    // The granted set is an ordered SUBSET, not a prefix: the middle candidate's
    // scope was already at its limit, so the server skipped it and granted the
    // next distinct scope. A prefix check would wrongly reject this.
    expect(await claimWith(["claimed", OWNER_A, OWNER_C], candidates)).toEqual({
      kind: "claimed",
      granted: [OWNER_A, OWNER_C],
    });
  });

  it("treats a grant of nothing as a well-formed claim", async () => {
    // The one outcome worth retrying: the cluster is simply at its limit.
    expect(await claimWith(["claimed"], [candidate(OWNER_A, SCOPE_A)])).toEqual({
      kind: "claimed",
      granted: [],
    });
  });

  it("refuses a reply naming more owners than the batch submitted", async () => {
    // MUTATION GUARD: one candidate cannot earn two permits, so a second named
    // owner is a grant this call never asked for. Accepting it would admit a
    // waiter Redis never granted and leave a member nothing ever releases.
    expect(await claimWith(["claimed", OWNER_A, OWNER_B], [candidate(OWNER_A, SCOPE_A)])).toEqual({
      kind: "unavailable",
    });
  });

  it("fails closed on any reply the SUBMITTED batch cannot justify", async () => {
    const candidates = [candidate(OWNER_A, SCOPE_A), candidate(OWNER_B, SCOPE_B)];
    const unsubmitted = newCapacityOwnerToken();
    const cases: readonly (readonly [string, RedisReply])[] = [
      ["an owner that was never submitted", ["claimed", unsubmitted]],
      ["a submitted owner named twice", ["claimed", OWNER_A, OWNER_A]],
      ["submitted owners out of candidate order", ["claimed", OWNER_B, OWNER_A]],
      ["a numeric element", ["claimed", 7]],
      ["a null element", ["claimed", null]],
      ["an empty-string element", ["claimed", ""]],
      ["a granted owner beside an empty element", ["claimed", OWNER_A, ""]],
      ["a granted owner beside a numeric element", ["claimed", OWNER_A, 0]],
      ["an unrecognized tag", ["nonsense"]],
      ["the release tag", ["ok"]],
      ["an empty reply", []],
    ];
    for (const [label, reply] of cases) {
      // A grant list must be wholly trustworthy or wholly rejected: a partially
      // trusted list would hand a permit to a waiter Redis never granted.
      expect(await claimWith(reply, candidates), label).toEqual({ kind: "unavailable" });
    }
  });

  it("refuses a non-canonical or wrong-length owner even when it was submitted", async () => {
    const forged = nonCanonicalOwner(OWNER_A);
    const truncated = OWNER_A.slice(0, -1);
    // The forged spelling decodes to the SAME sixteen bytes, so only re-encoding
    // distinguishes it. A member's identity is its byte string, so accepting
    // both spellings would mean two registry members for one permit.
    expect(Buffer.from(forged, "base64url").equals(Buffer.from(OWNER_A, "base64url"))).toBe(true);
    expect(isCanonicalCapacityOwner(forged)).toBe(false);
    expect(isCanonicalCapacityOwner(truncated)).toBe(false);

    for (const owner of [forged, truncated]) {
      // Submitted as the candidate, so candidate MEMBERSHIP cannot be what
      // rejects it: only the canonical check can.
      expect(await claimWith(["claimed", owner], [candidate(owner, SCOPE_A)])).toEqual({
        kind: "unavailable",
      });
    }
  });

  it("classifies `corrupt` only at exact arity one", async () => {
    const candidates = [candidate(OWNER_A, SCOPE_A)];
    expect(await claimWith(["corrupt"], candidates)).toEqual({ kind: "corrupt" });
    // An extra field means the reply did not come from this script's closed
    // `corrupt` branch, so it is an unusable reply rather than a classification.
    // Neither outcome is ever retried or compensated by the coordinator: the
    // mutation may already have applied.
    expect(await claimWith(["corrupt", "extra"], candidates)).toEqual({ kind: "unavailable" });
    expect(await claimWith(["corrupt", null], candidates)).toEqual({ kind: "unavailable" });
  });

  it("fails closed when the dependency is unusable", async () => {
    expect(await claimWith(null, [candidate(OWNER_A, SCOPE_A)])).toEqual({ kind: "unavailable" });
  });
});

describe("shared-capacity store: release", () => {
  it("ships exactly one key and the exact member components", async () => {
    const h = harness([["ok"]]);
    await h.store.release(KEY, OWNER_A, SCOPE_A);
    const call = evaluated(h);
    expect(call.keys).toEqual([KEY]);
    expect(call.args).toEqual([...BASE_ARGS, OWNER_A, SCOPE_A]);
    expect(call.args).toHaveLength(BASE_ARGS.length + 2);
  });

  it("maps every closed outcome and fails closed on anything else", async () => {
    const cases: readonly [RedisReply | null, CapacityReleaseResult][] = [
      [["ok"], { kind: "ok" }],
      [["corrupt"], { kind: "corrupt" }],
      [null, { kind: "unavailable" }],
      [["nonsense"], { kind: "unavailable" }],
      [["claimed"], { kind: "unavailable" }],
      [[], { kind: "unavailable" }],
      // BOTH closed replies are exactly one element, so an extra field means the
      // reply did not come from this script and must not be classified at all.
      [["ok", "extra"], { kind: "unavailable" }],
      [["ok", null], { kind: "unavailable" }],
      [["ok", "ok"], { kind: "unavailable" }],
      [["corrupt", "extra"], { kind: "unavailable" }],
    ];
    for (const [reply, expected] of cases) {
      const h = harness([reply]);
      expect(await h.store.release(KEY, OWNER_A, SCOPE_A), JSON.stringify(reply)).toEqual(expected);
    }
  });
});

describe("shared-capacity store: cancellation policy", () => {
  it("forwards a supplied abort signal and passes NO options without one", async () => {
    const controller = new AbortController();
    const withSignal = harness([["claimed"], ["ok"]]);
    await withSignal.store.claimBatch(
      KEY,
      [candidate(OWNER_A, SCOPE_A)],
      LIMITS,
      controller.signal,
    );
    await withSignal.store.release(KEY, OWNER_A, SCOPE_A, controller.signal);
    expect(evaluated(withSignal, 0).options).toEqual({ signal: controller.signal });
    expect(evaluated(withSignal, 1).options).toEqual({ signal: controller.signal });

    // MUTATION GUARD: the coordinator deliberately passes NO signal for a shared
    // batch (it belongs to several waiters) and none for a release (a permit must
    // be returned even when its request was cancelled). Synthesizing an options
    // object here would make that impossible to express.
    const without = harness([["claimed"], ["ok"]]);
    await without.store.claimBatch(KEY, [candidate(OWNER_A, SCOPE_A)], LIMITS);
    await without.store.release(KEY, OWNER_A, SCOPE_A);
    expect(evaluated(without, 0).options).toBeUndefined();
    expect(evaluated(without, 1).options).toBeUndefined();
  });
});

describe("shared-capacity store: the shipped scripts", () => {
  it("uses two DISTINCT registered scripts and nothing else", async () => {
    const { claim, release } = await shippedScripts();
    expect(claim.body).not.toBe(release.body);
    expect(claim.sha).not.toBe(release.sha);
    // Registered through `defineRedisScript`, so the substrate's locally computed
    // SHA-1 drives `EVALSHA` with an `EVAL` fallback after a script flush.
    expect(defineRedisScript(claim.body)).toEqual(claim);
    expect(defineRedisScript(release.body)).toEqual(release);
    // There is deliberately no third script: no renewal, no heartbeat, no
    // reaper. A lease is derived from its holder's own deadline instead, so a
    // starved replica can never lose a permit it is legitimately using.
    expect(new Set([claim.sha, release.sha]).size).toBe(2);
  });

  it("takes its clock from Redis, never from a Node clock", async () => {
    const { claim, release } = await shippedScripts();
    for (const body of [claim.body, release.body]) {
      // MUTATION GUARD: passing `now` in as an argument would let a skewed
      // replica mint a permit that outlives every other replica's view of it.
      expect(body).toContain("redis.call('TIME')");
    }
  });

  it("checks TYPE before touching the key as a ZSET", async () => {
    const { claim, release } = await shippedScripts();
    for (const body of [claim.body, release.body]) {
      const typeAt = body.indexOf("'TYPE'");
      expect(typeAt).toBeGreaterThanOrEqual(0);
      // Each command is matched QUOTED, so a Lua comment naming one cannot
      // stand in for the call itself.
      const issued = ZSET_COMMANDS.map((command) => body.indexOf(`'${command}'`)).filter(
        (at) => at !== -1,
      );
      expect(issued.length).toBeGreaterThan(0);
      for (const at of issued) {
        // A wrong-type key would otherwise raise WRONGTYPE and abort the script,
        // losing the closed `corrupt` classification.
        expect(typeAt).toBeLessThan(at);
      }
    }
  });

  it("bounds cardinality with ZCARD before materializing any member", async () => {
    const { claim, release } = await shippedScripts();
    for (const body of [claim.body, release.body]) {
      const cardAt = body.indexOf("'ZCARD'");
      const rangeAt = body.indexOf("'ZRANGE'");
      expect(cardAt).toBeGreaterThanOrEqual(0);
      expect(rangeAt).toBeGreaterThanOrEqual(0);
      expect(cardAt).toBeLessThan(rangeAt);
      // STRLEN is the string-value guard of the other boundaries; on a ZSET it
      // would be meaningless, so its presence here would be a copied bug.
      expect(body).not.toContain("STRLEN");
    }
  });

  it("validates the whole registry and the whole batch before the first grant", async () => {
    const { claim } = await shippedScripts();
    // The CALL site, not the definition in the shared prelude.
    const readAt = claim.body.indexOf("= readRegistry()");
    const validateAt = claim.body.indexOf("for i = 0, COUNT - 1 do");
    const pruneAt = claim.body.indexOf("\npruneExpired()\n");
    const addAt = claim.body.indexOf("redis.call('ZADD'");
    for (const at of [readAt, validateAt, pruneAt, addAt]) {
      expect(at).toBeGreaterThanOrEqual(0);
    }
    // A malformed batch must not be able to leave a partially applied claim, and
    // a rejected registry must be left byte-for-byte untouched.
    expect(readAt).toBeLessThan(validateAt);
    expect(validateAt).toBeLessThan(pruneAt);
    expect(pruneAt).toBeLessThan(addAt);
    // An EXACT arity check, so a truncated or padded argument list is corrupt
    // rather than partially interpreted...
    expect(claim.body).toMatch(/if #ARGV ~= \d+ \+ COUNT \* 3 then return \{'corrupt'\} end/);
    // ...and the batch ceiling is enforced by the SERVER as well, so a caller
    // cannot widen the bound the registry is willing to materialize.
    expect(claim.body).toContain("COUNT > MAXBATCH");
  });

  it("removes the exact member only after the registry validated", async () => {
    const { release } = await shippedScripts();
    const readAt = release.body.indexOf("= readRegistry()");
    const pruneAt = release.body.indexOf("\npruneExpired()\n");
    const remAt = release.body.indexOf("redis.call('ZREM'");
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(pruneAt);
    expect(pruneAt).toBeLessThan(remAt);
    expect(release.body).toMatch(/if #ARGV ~= \d+ then return \{'corrupt'\} end/);
    // The member is assembled server-side from the components, exactly as
    // `encodeCapacityMember` documents, so the stored bytes never depend on a
    // whole member supplied by a caller.
    expect(release.body).toContain("VERSION .. '|' .. OWNER .. '|' .. SCOPE");
  });

  it("assembles each granted member server-side under the shipped version", async () => {
    const { claim } = await shippedScripts();
    expect(claim.body).toContain("local member = VERSION .. '|' .. owner .. '|' .. scope");
    expect(claim.body).toContain("if #member > MAXMEMBER then return {'corrupt'} end");
  });

  it("expires the registry at its latest lease and deletes it when empty", async () => {
    const { claim, release } = await shippedScripts();
    for (const body of [claim.body, release.body]) {
      expect(body).toContain("redis.call('PEXPIREAT', KEYS[1]");
      expect(body).toContain("redis.call('DEL', KEYS[1])");
      // No per-member refresh and no key-level renewal: the crash reaper is the
      // lease itself, so there is nothing to extend.
      expect(body).not.toContain("'PEXPIRE'");
      expect(body).not.toContain("'EXPIRE'");
      expect(body).not.toContain("'EXPIREAT'");
      expect(body).not.toContain("'PERSIST'");
      // Corrupt state is classified, never bulk-erased or "repaired".
      expect(body).not.toContain("FLUSH");
      expect(body).not.toContain("'SCAN'");
    }
  });

  it("bounds every stored deadline against Redis time and the lease ceiling", async () => {
    const { claim, release } = await shippedScripts();
    for (const body of [claim.body, release.body]) {
      const clockAt = body.indexOf("local NOW_MS =");
      const boundAt = body.indexOf("n > NOW_MS + MAXLEASE");
      expect(clockAt).toBeGreaterThanOrEqual(0);
      // MUTATION GUARD: without an upper bound relative to the SERVER's clock, a
      // forged far-future deadline pins the registry key's own expiry (it is
      // re-expired at the LATEST lease) and never prunes, so a single hostile
      // write would under-admit the whole cluster indefinitely.
      expect(boundAt).toBeGreaterThan(clockAt);
      // Judged on the way IN, before anything is written, so a registry holding
      // an over-bound deadline keeps every member, score, and its own TTL.
      for (const command of MUTATIONS) {
        const at = body.indexOf(`'${command}'`);
        if (at !== -1) expect(boundAt).toBeLessThan(at);
      }
    }
  });

  it("accepts only EXACT canonical component spellings", async () => {
    const { claim, release } = await shippedScripts();
    // Built from the SAME exported constants the TypeScript validators use, so
    // the server-side and client-side notions of canonical cannot drift apart.
    const ownerTail = `${String(CAPACITY_OWNER_TOKEN_CHARS - 1)}) .. '[${CAPACITY_OWNER_FINAL_CHARS}]$'`;
    const scopeTail = `${String(CAPACITY_SCOPE_CHARS - 1)}) .. '[${CAPACITY_SCOPE_FINAL_CHARS}]$'`;
    for (const body of [claim.body, release.body]) {
      expect(body).toContain(`local OWNER_CHARS = ${String(CAPACITY_OWNER_TOKEN_CHARS)}`);
      expect(body).toContain(`local SCOPE_CHARS = ${String(CAPACITY_SCOPE_CHARS)}`);
      expect(body).toContain("#v ~= OWNER_CHARS");
      expect(body).toContain("#v ~= SCOPE_CHARS");
      // Exact length AND the narrow final-character class, which is what makes a
      // second spelling of the same bytes inexpressible.
      expect(body).toContain(ownerTail);
      expect(body).toContain(scopeTail);
      // MUTATION GUARD: the broad 1..64 and 1..86 maxima this replaced accepted a
      // truncated, padded, or non-canonically spelled component as a distinct one.
      expect(body).not.toContain("OWNER_MAX");
      expect(body).not.toContain("SCOPE_MAX");
    }
    // Interpolating each class into a Lua character set is only safe while both
    // hold plain alphanumerics: a `-`, `^`, `%`, or `]` would redefine the set.
    expect(CAPACITY_OWNER_FINAL_CHARS).toMatch(/^[A-Za-z0-9]+$/);
    expect(CAPACITY_SCOPE_FINAL_CHARS).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("requires every numeric argument to be a positive integer inside its ceiling", async () => {
    const { claim, release } = await shippedScripts();
    for (const body of [claim.body, release.body]) {
      // MUTATION GUARD: `tonumber` succeeding is not enough, because it also
      // accepts a FRACTIONAL value, which would satisfy every bound comparison
      // and then serve as a count or be stored as a deadline the integer score
      // predicates cannot reason about.
      expect(body).toContain("n == math.floor(n)");
      for (const bound of ["MAXMEMBER", "MAXMEMBERS", "MAXLEASE", "MAXBATCH"]) {
        expect(body).toContain(`posInt(${bound})`);
      }
      // A batch ceiling wider than the registry may hold could not be honoured.
      expect(body).toContain("MAXBATCH > MAXMEMBERS");
    }
    for (const guarded of ["MAX_ACTIVE", "MAX_PER_SCOPE", "COUNT", "leaseMs"]) {
      expect(claim.body).toContain(`posInt(${guarded})`);
    }
    // Each supplied limit is bounded by the fixed ceiling above it, so a
    // malformed store input cannot widen what the registry is willing to grant.
    expect(claim.body).toContain("MAX_ACTIVE > MAXBATCH");
    expect(claim.body).toContain("MAX_PER_SCOPE > MAX_ACTIVE");
    expect(claim.body).toContain("COUNT > MAX_ACTIVE");
    expect(claim.body).toContain("leaseMs > MAXLEASE");
  });
});
