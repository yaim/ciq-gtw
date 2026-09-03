/**
 * REAL-REDIS contract suite for cross-replica active-capacity accounting (Phase
 * 4D; specification section 19.2).
 *
 * The hermetic suites prove the arguments the store ships and the coordinator's
 * queueing logic against an in-memory fake. Only a live server can prove the
 * properties that make ONE active-permit budget span replicas: that a claim is
 * atomic, that the lease deadline is stamped from Redis's own clock inside the
 * script, that the strict registry validator really refuses hostile state
 * without repairing it — including a stored deadline further ahead than any
 * lease this cluster grants, judged against the SERVER's clock, and a component
 * that is a second spelling or the wrong length rather than an exact canonical
 * encoding — that the key's own lifetime tracks the latest lease, and that both
 * scripts survive a `SCRIPT FLUSH`.
 *
 * Safety: every value here is synthetic (no real credential, prompt, answer,
 * session, or thread id), the Redis key namespace is randomized per run, and
 * every key the suite creates is deleted in teardown. Like the other real-Redis
 * suites this one issues a SERVER-WIDE `SCRIPT FLUSH`, so it must only ever be
 * pointed at a disposable instance.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CapacityController, CapacityRequest } from "../../src/generation/types.js";
import { createRedisConnection, type RedisConnection } from "../../src/redis/index.js";
import {
  buildCapacityRegistryKey,
  CAPACITY_MEMBER_DELIMITER,
  CAPACITY_MEMBER_VERSION,
  CAPACITY_OWNER_TOKEN_CHARS,
  CAPACITY_SCOPE_CHARS,
  createRedisSharedCapacityStore,
  createSharedCapacityCoordinator,
  deriveCapacityScope,
  deriveSharedCapacityKeyring,
  encodeCapacityMember,
  isCanonicalCapacityOwner,
  isCanonicalCapacityScope,
  MAX_CAPACITY_LEASE_MS,
  MAX_CAPACITY_MEMBER_BYTES,
  MAX_CAPACITY_REGISTRY_MEMBERS,
  newCapacityOwnerToken,
  type CapacityCandidate,
  type CapacityClaimLimits,
  type SharedCapacityLimits,
  type SharedCapacityStore,
} from "../../src/shared-capacity/index.js";

const REDIS_URL = process.env["REDIS_TEST_URL"];

// Synthetic sentinels that must NEVER appear in Redis. The session, thread,
// prompt, and answer values are never even handed to this boundary — capacity
// accounting is given none of them — so their absence is a structural property
// rather than the result of redaction, and asserting it guards against a future
// change that starts passing request context down here.
const GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL-v4w5x6";
const OTHER_GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL-y7z8a9";
const SESSION_SENTINEL = "ses_fake_SENTINEL_b1c2d3";
const THREAD_SENTINEL = "thread-SENTINEL-e4f5g6";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-h7i8j9";
const ANSWER_SENTINEL = "ANSWER-SENTINEL-k1l2m3";

/**
 * The PROCESS-LOCAL capacity identity (specification section 9.1). It is
 * ordering dependent and meaningless outside one process, so it must never
 * become part of shared state.
 */
const LOCAL_KEY_ID = "k0";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveSharedCapacityKeyring(MASTER_KEY);
/** Randomized per run so parallel runs and leftovers can never interfere. */
const NAMESPACE = `ciqsc-${randomBytes(6).toString("hex")}`;

const SCOPE_A = deriveCapacityScope(KEYRING, GATEWAY_KEY_SENTINEL);
const SCOPE_B = deriveCapacityScope(KEYRING, OTHER_GATEWAY_KEY_SENTINEL);

/** The ONE namespace-level registry holding every active permit. */
const KEY = buildCapacityRegistryKey(KEYRING, NAMESPACE);

/** A model deadline in the configured range; the lease is derived from it. */
const REQUEST_TIMEOUT_MS = 90_000;
/** Default lease for a directly submitted candidate. */
const LEASE_MS = 60_000;

const SENTINELS: readonly string[] = [
  GATEWAY_KEY_SENTINEL,
  OTHER_GATEWAY_KEY_SENTINEL,
  SESSION_SENTINEL,
  THREAD_SENTINEL,
  PROMPT_SENTINEL,
  ANSWER_SENTINEL,
  MASTER_KEY,
];

/** A raw client used only to inspect and clean up, never by the code under test. */
let inspector: ReturnType<typeof createClient>;
const connections: RedisConnection[] = [];

function requireUrl(): string {
  if (REDIS_URL === undefined || REDIS_URL.trim() === "") {
    throw new Error(
      "REDIS_TEST_URL is not set. The real-Redis shared-capacity suite requires a running Redis " +
        "(see compose.yaml `redis` profile) and must not be skipped silently.",
    );
  }
  return REDIS_URL;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(connection: RedisConnection, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (connection.isReady()) return;
    await delay(25);
  }
  throw new Error("Redis did not become ready within the test deadline");
}

/** A connected connection registered for teardown. */
async function connected(): Promise<RedisConnection> {
  const connection = createRedisConnection({ url: requireUrl() });
  connections.push(connection);
  connection.connect();
  await waitReady(connection);
  return connection;
}

/** An independent replica's store over its OWN connection. */
async function replicaStore(): Promise<SharedCapacityStore> {
  const connection = await connected();
  return createRedisSharedCapacityStore(connection.substrate);
}

/** An independent replica's coordinator over its OWN store and connection. */
async function replicaCoordinator(limits: SharedCapacityLimits): Promise<CapacityController> {
  return createSharedCapacityCoordinator({
    store: await replicaStore(),
    registryKey: KEY,
    limits,
  });
}

function claimLimits(maxActive: number, maxActivePerScope: number): CapacityClaimLimits {
  return { maxActive, maxActivePerScope };
}

function candidate(scope: string, leaseMs: number = LEASE_MS): CapacityCandidate {
  return { owner: newCapacityOwnerToken(), scope, leaseMs };
}

function capacityRequest(scope: string): CapacityRequest {
  return {
    keyId: LOCAL_KEY_ID,
    capacityScopeId: scope,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    signal: new AbortController().signal,
  };
}

/** The server's own millisecond clock, computed exactly as the Lua prelude does. */
async function redisNowMs(): Promise<number> {
  const [seconds, micros] = (await inspector.time()) as unknown as [string, string];
  return Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
}

/**
 * The registry key's ABSOLUTE expiry in ms, or the Redis sentinel (`-1` for a
 * key with no expiry, `-2` for an absent key).
 *
 * An absolute deadline rather than a remaining TTL, so "the key's lifetime was
 * left untouched" is an exact equality instead of a tolerance that would drift
 * with however long the assertion took.
 */
async function registryExpiryAt(): Promise<number> {
  return Number(await inspector.sendCommand<number>(["PEXPIRETIME", KEY]));
}

/** The base64url alphabet in encoding order, so a character's index IS its value. */
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same bytes, spelled NON-canonically.
 *
 * Unpadded base64url leaves spare LOW BITS in the final character of an encoding
 * whose byte count is not a multiple of 3, and a canonical encoder writes them
 * as zero. Taking the NEXT alphabet character keeps every data bit and dirties
 * only a spare one, so the result decodes to identical bytes while being a
 * second spelling of them — which must never be accepted as a distinct owner or
 * scope, because a member's identity IS its byte string.
 */
function reSpell(value: string): string {
  const final = value.slice(-1);
  return `${value.slice(0, -1)}${BASE64URL[BASE64URL.indexOf(final) + 1] ?? "B"}`;
}

interface RegistryEntry {
  readonly member: string;
  readonly score: string;
}

/**
 * One fixed complaint for a reply this helper cannot decode. It names no value,
 * only the broken expectation.
 */
const REGISTRY_DECODE_ERROR =
  "Unexpected ZRANGE WITHSCORES reply shape: the suite cannot compare registry state it " +
  "could not decode.";

/**
 * The complete registry, normalized for comparison.
 *
 * The MEMBER side is exact: a ZSET member is an opaque byte string, and the
 * client decodes it as UTF-8, which is lossless for every member this suite
 * writes because all of them are ASCII — so each one here is what the Lua
 * validator reads. The SCORE side cannot be, and this helper must not pretend
 * otherwise: a ZSET score is a NUMERIC Redis value, the client hands it back as
 * a JavaScript number, and Redis keeps no record of the textual spelling a
 * writer submitted. Each score is normalized to a stable string purely so an
 * "untouched" assertion stays one equality; it is evidence that the stored VALUE
 * did not change, not that particular bytes are stored.
 *
 * The typed command is used rather than a raw `sendCommand` because the reply
 * SHAPE is protocol dependent: RESP2 returns one FLAT member/score/member/score
 * array while RESP3 returns member/score TUPLES. This inspector takes the
 * client's default protocol (RESP3), while the production connection pins RESP2,
 * so only the command binding can be trusted to know which arrived. A
 * hand-rolled flat loop mis-decoded the tuple shape silently, putting a whole
 * tuple in `member` and `undefined` in `score`. None of that reaches production:
 * the Lua scripts issue their own `redis.call('ZRANGE', ..., 'WITHSCORES')`
 * INSIDE the server, which always yields the flat Lua table they parse.
 */
async function registryEntries(): Promise<RegistryEntry[]> {
  const rows = await inspector.zRangeWithScores(KEY, 0, -1);
  if (!Array.isArray(rows)) throw new Error(REGISTRY_DECODE_ERROR);
  return rows.map((row) => {
    // Throw rather than coerce: `String(undefined)`, or a stringified tuple,
    // would turn a decoding defect into a plausible-looking assertion value and
    // an "untouched" comparison that holds because BOTH sides are wrong.
    if (typeof row?.value !== "string") throw new Error(REGISTRY_DECODE_ERROR);
    // Every finite score is accepted and so are the infinities: the hostile-state
    // cases deliberately store values Redis accepts and the Lua validator must
    // reject, so this helper has to be able to read them back. Only NaN is
    // treated as a decoding failure — nothing here can store it, and it would
    // compare unequal to itself.
    if (typeof row.score !== "number" || Number.isNaN(row.score)) {
      throw new Error(REGISTRY_DECODE_ERROR);
    }
    return { member: row.value, score: String(row.score) };
  });
}

function memberNames(entries: readonly RegistryEntry[]): string[] {
  return entries.map((entry) => entry.member).sort();
}

/** Write one member with an EXACT score string, bypassing any client formatting. */
async function writeMember(score: string, member: string): Promise<void> {
  await inspector.sendCommand(["ZADD", KEY, score, member]);
}

/** Delete every key this run could have created. */
async function purge(): Promise<void> {
  const keys = await inspector.keys(`${NAMESPACE}:*`);
  if (keys.length > 0) await inspector.del(keys);
}

let store: SharedCapacityStore;

beforeAll(async () => {
  inspector = createClient({ url: requireUrl() });
  inspector.on("error", () => undefined);
  await inspector.connect();
  store = await replicaStore();
  await purge();
});

afterEach(async () => {
  await purge();
});

afterAll(async () => {
  await purge();
  for (const connection of connections) await connection.close();
  await inspector.close();
});

describe("real Redis: atomic cluster-wide limits", () => {
  it("never exceeds the per-scope limit when two replicas race one scope", async () => {
    const [first, second] = await Promise.all([replicaStore(), replicaStore()]);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 === 0 ? first : second).claimBatch(KEY, [candidate(SCOPE_A)], claimLimits(8, 3)),
      ),
    );

    const granted = results.flatMap((result) =>
      result.kind === "claimed" ? [...result.granted] : [],
    );
    expect(results.every((result) => result.kind === "claimed")).toBe(true);
    // Atomicity: no interleaving of twelve concurrent claims can over-admit, and
    // the global limit of 8 is deliberately slack so only the per-scope limit
    // can be what caps this.
    expect(granted).toHaveLength(3);
    expect(await inspector.zCard(KEY)).toBe(3);
  });

  it("never exceeds the global limit when two replicas race across scopes", async () => {
    const [first, second] = await Promise.all([replicaStore(), replicaStore()]);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? first : second).claimBatch(
          KEY,
          [candidate(i < 4 ? SCOPE_A : SCOPE_B)],
          claimLimits(3, 2),
        ),
      ),
    );

    const granted = results.flatMap((result) =>
      result.kind === "claimed" ? [...result.granted] : [],
    );
    // The per-scope limits alone would admit 2 + 2; only a global count taken
    // across both scopes inside the same atomic step caps this at 3.
    expect(granted).toHaveLength(3);
    expect(await inspector.zCard(KEY)).toBe(3);
  });

  it("grants an ordered SUBSET, naming the exact owners rather than a prefix count", async () => {
    const firstA = candidate(SCOPE_A);
    const secondA = candidate(SCOPE_A);
    const onlyB = candidate(SCOPE_B);

    // The global limit is deliberately slack enough to admit the whole batch, so
    // only the PER-SCOPE limit can be what shapes the granted set.
    const result = await store.claimBatch(KEY, [firstA, secondA, onlyB], claimLimits(3, 1));

    // The blocked second candidate is SKIPPED, not fatal: a later distinct scope
    // is still granted, which is precisely why a count reply would be ambiguous.
    expect(result).toEqual({ kind: "claimed", granted: [firstA.owner, onlyB.owner] });
    expect(memberNames(await registryEntries())).toEqual(
      [
        encodeCapacityMember(firstA.owner, SCOPE_A),
        encodeCapacityMember(onlyB.owner, SCOPE_B),
      ].sort(),
    );
  });

  it("stops granting the moment global occupancy reaches the limit", async () => {
    const held = [candidate(SCOPE_A), candidate(SCOPE_B)];
    expect((await store.claimBatch(KEY, held, claimLimits(3, 3))).kind).toBe("claimed");

    const lastSlot = candidate(SCOPE_A);
    const blocked = [candidate(SCOPE_B), candidate(SCOPE_A)];
    const result = await store.claimBatch(KEY, [lastSlot, ...blocked], claimLimits(3, 3));

    // Per-scope headroom remains for all three, so the GLOBAL count taken across
    // both scopes is the only thing that can stop the scan after one grant.
    expect(result).toEqual({ kind: "claimed", granted: [lastSlot.owner] });
    expect(await inspector.zCard(KEY)).toBe(3);
  });

  it("refuses a batch larger than the global limit could ever grant", async () => {
    const batch = [candidate(SCOPE_A), candidate(SCOPE_B), candidate(SCOPE_A)];

    // The server enforces this bound itself rather than trusting the coordinator
    // that builds the batch (which already caps it at the configured global
    // limit), so candidates beyond what one claim could grant are refused rather
    // than materialized. Nothing is applied.
    expect(await store.claimBatch(KEY, batch, claimLimits(2, 2))).toEqual({ kind: "corrupt" });
    expect(await inspector.exists(KEY)).toBe(0);
  });

  it("holds ONE global limit across two independent coordinators", async () => {
    const limits: SharedCapacityLimits = {
      maxActive: 2,
      maxActivePerScope: 2,
      maxQueued: 4,
      maxQueueWaitMs: 400,
    };
    const [a, b] = await Promise.all([replicaCoordinator(limits), replicaCoordinator(limits)]);

    const first = await a.acquire(capacityRequest(SCOPE_A));
    const second = await b.acquire(capacityRequest(SCOPE_A));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // MUTATION GUARD: a process-local controller would admit this, because
    // neither replica holds two permits of its OWN. Being at the shared limit is
    // backpressure, so the waiter stays queued until its queue wait expires.
    expect(await b.acquire(capacityRequest(SCOPE_A))).toEqual({ ok: false, reason: "capacity" });
    expect(await inspector.zCard(KEY)).toBe(2);

    if (first.ok) first.permit.release();
    if (second.ok) second.permit.release();
    a.closeAdmission();
    b.closeAdmission();
    // Let the two fire-and-forget releases land before teardown inspects the key.
    await delay(100);
  }, 10_000);

  it("hands a permit released on one replica to a waiter on the other", async () => {
    const limits: SharedCapacityLimits = {
      maxActive: 1,
      maxActivePerScope: 1,
      maxQueued: 4,
      maxQueueWaitMs: 4_000,
    };
    const [a, b] = await Promise.all([replicaCoordinator(limits), replicaCoordinator(limits)]);

    const held = await a.acquire(capacityRequest(SCOPE_A));
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    // Started but not awaited: nothing this replica does can satisfy it, so the
    // only way it can be granted is the OTHER replica returning its permit.
    const waiting = b.acquire(capacityRequest(SCOPE_A));
    await delay(50);
    expect(await inspector.zCard(KEY)).toBe(1);

    held.permit.release();
    const granted = await waiting;
    expect(granted.ok).toBe(true);
    // The slot moved rather than being duplicated.
    expect(await inspector.zCard(KEY)).toBe(1);

    if (granted.ok) granted.permit.release();
    a.closeAdmission();
    b.closeAdmission();
    await delay(100);
  }, 10_000);
});

describe("real Redis: leases, expiry, and crash recovery", () => {
  it("stamps the lease deadline from Redis's own clock", async () => {
    const only = candidate(SCOPE_A, LEASE_MS);

    const before = await redisNowMs();
    expect((await store.claimBatch(KEY, [only], claimLimits(4, 4))).kind).toBe("claimed");
    const after = await redisNowMs();

    const score = await inspector.zScore(KEY, encodeCapacityMember(only.owner, SCOPE_A));
    expect(score).not.toBeNull();
    // Bracketed by two reads of the SERVER's clock taken either side of the
    // claim, so the deadline is consistent with no other clock reading. It is a
    // millisecond integer, exactly as the prelude computes it.
    expect(Number(score)).toBeGreaterThanOrEqual(before + LEASE_MS);
    expect(Number(score)).toBeLessThanOrEqual(after + LEASE_MS);
    expect(Number.isInteger(Number(score))).toBe(true);
  });

  it("prunes a crashed holder's expired lease and regrants its slot", async () => {
    // A member written directly with a PAST deadline stands in for a replica
    // hard-killed while holding a permit: there is no heartbeat and no renewal
    // script, so only the lease itself can reclaim it.
    const ghost = encodeCapacityMember(newCapacityOwnerToken(), SCOPE_A);
    const past = (await redisNowMs()) - 60_000;
    await writeMember(String(past), ghost);

    const taker = candidate(SCOPE_A);
    const result = await store.claimBatch(KEY, [taker], claimLimits(1, 1));

    // The global limit of 1 would have blocked this had the dead lease still
    // counted towards occupancy.
    expect(result).toEqual({ kind: "claimed", granted: [taker.owner] });
    expect(memberNames(await registryEntries())).toEqual([
      encodeCapacityMember(taker.owner, SCOPE_A),
    ]);
  });

  it("expires the registry at its LATEST lease and shortens it on release", async () => {
    const short = candidate(SCOPE_A, 30_000);
    expect((await store.claimBatch(KEY, [short], claimLimits(4, 4))).kind).toBe("claimed");
    const shortTtl = await inspector.pTTL(KEY);
    expect(shortTtl).toBeGreaterThan(25_000);
    expect(shortTtl).toBeLessThanOrEqual(30_000);

    const long = candidate(SCOPE_A, 120_000);
    expect((await store.claimBatch(KEY, [long], claimLimits(4, 4))).kind).toBe("claimed");
    const extendedTtl = await inspector.pTTL(KEY);
    expect(extendedTtl).toBeGreaterThan(115_000);
    expect(extendedTtl).toBeLessThanOrEqual(120_000);

    // Releasing the LONGEST lease must pull the registry's own lifetime back to
    // the next-latest, rather than leaving it pinned to a deadline no member
    // holds any more.
    expect(await store.release(KEY, long.owner, SCOPE_A)).toEqual({ kind: "ok" });
    const shortenedTtl = await inspector.pTTL(KEY);
    expect(shortenedTtl).toBeGreaterThan(25_000);
    expect(shortenedTtl).toBeLessThanOrEqual(30_000);
  });

  it("deletes the registry once the last permit is released", async () => {
    const only = candidate(SCOPE_A);
    expect((await store.claimBatch(KEY, [only], claimLimits(4, 4))).kind).toBe("claimed");
    expect(await inspector.exists(KEY)).toBe(1);

    expect(await store.release(KEY, only.owner, SCOPE_A)).toEqual({ kind: "ok" });
    // An empty registry and an absent one mean exactly the same thing — no
    // permits are held — so no empty key is left behind to accumulate.
    expect(await inspector.exists(KEY)).toBe(0);
  });

  it("deletes a registry holding nothing but expired leases", async () => {
    const past = String((await redisNowMs()) - 5_000);
    await writeMember(past, encodeCapacityMember(newCapacityOwnerToken(), SCOPE_A));
    await writeMember(past, encodeCapacityMember(newCapacityOwnerToken(), SCOPE_B));

    // This caller holds nothing, so the ZREM removes nothing: pruning alone
    // empties the registry, and the key goes with it.
    expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_A)).toEqual({ kind: "ok" });
    expect(await inspector.exists(KEY)).toBe(0);
  });
});

describe("real Redis: hostile registry state fails CLOSED", () => {
  it("classifies a wrong-type key as corrupt without touching it", async () => {
    await inspector.set(KEY, "not-a-zset");

    expect(await store.claimBatch(KEY, [candidate(SCOPE_A)], claimLimits(4, 4))).toEqual({
      kind: "corrupt",
    });
    expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_A)).toEqual({ kind: "corrupt" });
    // TYPE is checked before any ZSET command, so WRONGTYPE never aborts the
    // script and the closed classification survives with the value intact.
    expect(await inspector.get(KEY)).toBe("not-a-zset");
  });

  it("rejects an over-cardinality registry without pruning or adding anything", async () => {
    const oversized = MAX_CAPACITY_REGISTRY_MEMBERS + 1;
    const deadline = String((await redisNowMs()) + 300_000);
    // INDIVIDUALLY VALID: a canonical minted owner token, a real derived scope,
    // and an in-bound deadline, so cardinality is the ONLY defect and the
    // classification cannot be coming from a member the validator would have
    // rejected anyway.
    const args: string[] = ["ZADD", KEY];
    for (let i = 0; i < oversized; i += 1) {
      args.push(deadline, encodeCapacityMember(newCapacityOwnerToken(), SCOPE_A));
    }
    await inspector.sendCommand(args);
    expect(await inspector.zCard(KEY)).toBe(oversized);

    expect(await store.claimBatch(KEY, [candidate(SCOPE_B)], claimLimits(4, 4))).toEqual({
      kind: "corrupt",
    });
    expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_B)).toEqual({
      kind: "corrupt",
    });
    // ZCARD is bounded BEFORE a single member is materialized, so nothing was
    // read, pruned, or added — the gateway never sanitizes hostile state.
    expect(await inspector.zCard(KEY)).toBe(oversized);
  }, 30_000);

  it("rejects every malformed member, leaving the registry byte-for-byte untouched", async () => {
    const owner = newCapacityOwnerToken();
    // A member built from EXACT canonical components is always 68 bytes, so the
    // whole-member byte cap is now defence in depth rather than a reachable
    // predicate: any member long enough to exceed it must already have failed a
    // component pattern. Recording the arithmetic keeps that claim honest
    // instead of implying the byte cap is what rejects the oversized case below.
    expect(Buffer.byteLength(encodeCapacityMember(owner, SCOPE_A), "utf8")).toBe(68);
    expect(Buffer.byteLength(encodeCapacityMember(owner, SCOPE_A), "utf8")).toBeLessThan(
      MAX_CAPACITY_MEMBER_BYTES,
    );
    const oversizedMember = `1|${"A".repeat(64)}|${"B".repeat(86)}`;
    expect(Buffer.byteLength(oversizedMember, "utf8")).toBeGreaterThan(MAX_CAPACITY_MEMBER_BYTES);

    // Each non-canonical spelling decodes to the same bytes as the real value, so
    // only re-encoding tells them apart.
    const reSpelledOwner = reSpell(owner);
    const reSpelledScope = reSpell(SCOPE_A);
    expect(Buffer.from(reSpelledOwner, "base64url").equals(Buffer.from(owner, "base64url"))).toBe(
      true,
    );
    expect(isCanonicalCapacityOwner(reSpelledOwner)).toBe(false);
    expect(isCanonicalCapacityScope(reSpelledScope)).toBe(false);

    const cases: readonly (readonly [string, string])[] = [
      ["wrong version prefix", `2|${owner}|${SCOPE_A}`],
      ["too few delimiters", `1|${owner}${SCOPE_A}`],
      ["too many delimiters", `1|${owner}|${SCOPE_A}|${owner}`],
      ["character outside base64url", `1|${owner.slice(0, -1)}.|${SCOPE_A}`],
      ["oversized member with non-canonical components", oversizedMember],
      ["empty component", `1||${SCOPE_A}`],
      // EXACT canonical encodings, so a second spelling of a real token is not a
      // distinct owner and a truncated or padded component is not a member at
      // all. A broad maximum-length check would have admitted every one of these.
      ["non-canonical owner trailing bits", `1|${reSpelledOwner}|${SCOPE_A}`],
      ["non-canonical scope trailing bits", `1|${owner}|${reSpelledScope}`],
      ["owner one character short", `1|${owner.slice(0, -1)}|${SCOPE_A}`],
      ["owner one character long", `1|${owner}A|${SCOPE_A}`],
      ["scope one character short", `1|${owner}|${SCOPE_A.slice(0, -1)}`],
      ["scope one character long", `1|${owner}|${SCOPE_A}A`],
      // Each component rejected in the OTHER's role, which only exact lengths
      // can distinguish.
      ["scope-shaped owner", `1|${SCOPE_A}|${SCOPE_A}`],
      ["owner-shaped scope", `1|${owner}|${owner}`],
    ];

    for (const [label, member] of cases) {
      await inspector.del(KEY);
      await writeMember(String((await redisNowMs()) + 300_000), member);
      // An explicit expiry the scripts would never choose, so "the key's own
      // lifetime was left untouched" is observable rather than vacuous.
      const pinnedExpiry = (await redisNowMs()) + 900_000;
      await inspector.sendCommand(["PEXPIREAT", KEY, String(pinnedExpiry)]);
      const before = await registryEntries();

      // The claim candidate and both release arguments are well formed, so the
      // classification can only have come from the STORED registry.
      expect(await store.claimBatch(KEY, [candidate(SCOPE_A)], claimLimits(4, 4)), label).toEqual({
        kind: "corrupt",
      });
      expect(await store.release(KEY, owner, SCOPE_A), label).toEqual({ kind: "corrupt" });
      expect(await registryEntries(), label).toEqual(before);
      expect(await registryExpiryAt(), label).toBe(pinnedExpiry);
    }
  });

  it("refuses a stored deadline further ahead than any lease this cluster grants", async () => {
    const member = encodeCapacityMember(newCapacityOwnerToken(), SCOPE_A);

    // The BOUNDARY is valid. Taken from a clock read just before the write, so
    // the script's own later read can only make the value more comfortably
    // inside the bound — never less.
    await writeMember(String((await redisNowMs()) + MAX_CAPACITY_LEASE_MS), member);
    expect((await store.claimBatch(KEY, [candidate(SCOPE_B)], claimLimits(4, 4))).kind).toBe(
      "claimed",
    );
    await inspector.del(KEY);
    await writeMember(String((await redisNowMs()) + MAX_CAPACITY_LEASE_MS), member);
    expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_B)).toEqual({ kind: "ok" });

    // PAST the boundary is corrupt from BOTH scripts. An honest grant stamps the
    // server's own clock plus a lease of at most the ceiling, so a deadline
    // beyond that was not written by this gateway; left unchecked it would pin
    // the key's expiry (which tracks the LATEST lease) and, never expiring,
    // would never be pruned either — one write would under-admit the whole
    // cluster indefinitely.
    //
    // The overshoot is 2 s rather than 1 ms because the script re-reads `TIME`
    // after the fixture is written: a literal one-millisecond overshoot would
    // become legal if the server clock advanced during the round trip. The
    // margin only makes the case deterministic; the predicate exercised is the
    // same strict comparison, and the post-hoc clock guard below proves the
    // server never reached the value that would have legalized it.
    const overshootMs = 2_000;
    const cases: readonly (readonly [string, number])[] = [
      ["just past the ceiling", MAX_CAPACITY_LEASE_MS + overshootMs],
      ["far future", 30 * 24 * 60 * 60 * 1_000],
    ];

    for (const [label, ahead] of cases) {
      await inspector.del(KEY);
      const score = (await redisNowMs()) + ahead;
      await writeMember(String(score), member);
      const pinnedExpiry = (await redisNowMs()) + 900_000;
      await inspector.sendCommand(["PEXPIREAT", KEY, String(pinnedExpiry)]);
      const before = await registryEntries();

      expect(await store.claimBatch(KEY, [candidate(SCOPE_B)], claimLimits(4, 4)), label).toEqual({
        kind: "corrupt",
      });
      expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_B), label).toEqual({
        kind: "corrupt",
      });
      // Validation completes before the expiry prune and before any write, so
      // every member, every score, and the key's own lifetime survive intact.
      expect(await registryEntries(), label).toEqual(before);
      expect(await registryExpiryAt(), label).toBe(pinnedExpiry);
      // The score stayed strictly above what the server clock could justify for
      // the whole case, so the strict comparison is what rejected it.
      expect(await redisNowMs(), label).toBeLessThan(score - MAX_CAPACITY_LEASE_MS);
    }
  });

  it("still treats an EXPIRED deadline as valid rather than corrupt", async () => {
    const ghost = encodeCapacityMember(newCapacityOwnerToken(), SCOPE_A);
    await writeMember(String((await redisNowMs()) - 60_000), ghost);

    // MUTATION GUARD: bounding a deadline from ABOVE must not turn the lower end
    // into a validity test. An expired lease is ordinary state — it is pruned
    // after the complete registry validated — while "corrupt" means the registry
    // was not written by an honest gateway.
    const taker = candidate(SCOPE_A);
    expect(await store.claimBatch(KEY, [taker], claimLimits(1, 1))).toEqual({
      kind: "claimed",
      granted: [taker.owner],
    });
    expect(memberNames(await registryEntries())).toEqual([
      encodeCapacityMember(taker.owner, SCOPE_A),
    ]);
  });

  it("rejects every malformed score, leaving the registry byte-for-byte untouched", async () => {
    const member = encodeCapacityMember(newCapacityOwnerToken(), SCOPE_A);
    const cases: readonly (readonly [string, string])[] = [
      ["negative", "-1"],
      ["fractional", "1.5"],
      ["infinite", "+inf"],
      // Exactly representable as a double and 16 digits wide, so it exceeds the
      // digit cap that keeps every accepted score far inside the range Lua 5.1
      // doubles represent exactly. It is also far beyond the clock-relative
      // upper bound, so two independent predicates reject it.
      ["more than 15 digits", "1234567890123456"],
    ];

    for (const [label, score] of cases) {
      await inspector.del(KEY);
      await writeMember(score, member);
      const before = await registryEntries();
      // Redis re-formats a score on read, so the case is pinned on the ONE
      // predicate the validator applies rather than on the exact bytes it wrote.
      expect(/^\d{1,15}$/.test(before[0]?.score ?? ""), label).toBe(false);

      expect(await store.claimBatch(KEY, [candidate(SCOPE_B)], claimLimits(4, 4)), label).toEqual({
        kind: "corrupt",
      });
      expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_A), label).toEqual({
        kind: "corrupt",
      });
      // A negative score would have been swept by the expiry prune had
      // validation not completed first.
      expect(await registryEntries(), label).toEqual(before);
    }
  });

  it("rejects a registry holding one owner token twice", async () => {
    const owner = newCapacityOwnerToken();
    const deadline = String((await redisNowMs()) + 300_000);
    await writeMember(deadline, encodeCapacityMember(owner, SCOPE_A));
    await writeMember(deadline, encodeCapacityMember(owner, SCOPE_B));
    const before = await registryEntries();

    // 128 bits of randomness cannot collide, so a repeated token means the
    // registry was not written solely by honest gateways.
    expect(await store.claimBatch(KEY, [candidate(SCOPE_A)], claimLimits(8, 8))).toEqual({
      kind: "corrupt",
    });
    expect(await store.release(KEY, owner, SCOPE_A)).toEqual({ kind: "corrupt" });
    expect(await registryEntries()).toEqual(before);
  });

  it("refuses a candidate whose owner already holds a permit", async () => {
    const held = candidate(SCOPE_A);
    expect((await store.claimBatch(KEY, [held], claimLimits(8, 8))).kind).toBe("claimed");
    const before = await registryEntries();

    // A second member for one permit would make occupancy wrong and leave the
    // release unable to give the whole permit back.
    expect(await store.claimBatch(KEY, [{ ...held, scope: SCOPE_B }], claimLimits(8, 8))).toEqual({
      kind: "corrupt",
    });
    expect(await registryEntries()).toEqual(before);
  });

  it("rejects the WHOLE batch on any invalid candidate, applying nothing", async () => {
    const cases: readonly (readonly [string, CapacityCandidate])[] = [
      ["empty owner", { owner: "", scope: SCOPE_A, leaseMs: LEASE_MS }],
      ["empty scope", { owner: newCapacityOwnerToken(), scope: "", leaseMs: LEASE_MS }],
      // A candidate is held to the SAME exact canonical encoding as a stored
      // member, so a second spelling can never become a distinct permit and a
      // truncated or padded component is never accepted at all.
      [
        "non-canonical owner trailing bits",
        { owner: reSpell(newCapacityOwnerToken()), scope: SCOPE_A, leaseMs: LEASE_MS },
      ],
      [
        "non-canonical scope trailing bits",
        { owner: newCapacityOwnerToken(), scope: reSpell(SCOPE_A), leaseMs: LEASE_MS },
      ],
      [
        "owner one character short",
        { owner: newCapacityOwnerToken().slice(0, -1), scope: SCOPE_A, leaseMs: LEASE_MS },
      ],
      [
        "owner one character long",
        { owner: `${newCapacityOwnerToken()}A`, scope: SCOPE_A, leaseMs: LEASE_MS },
      ],
      [
        "scope one character short",
        { owner: newCapacityOwnerToken(), scope: SCOPE_A.slice(0, -1), leaseMs: LEASE_MS },
      ],
      ["scope-shaped owner", { owner: SCOPE_A, scope: SCOPE_A, leaseMs: LEASE_MS }],
      ["zero lease", { owner: newCapacityOwnerToken(), scope: SCOPE_A, leaseMs: 0 }],
      ["negative lease", { owner: newCapacityOwnerToken(), scope: SCOPE_A, leaseMs: -1 }],
      ["fractional lease", { owner: newCapacityOwnerToken(), scope: SCOPE_A, leaseMs: 1.5 }],
      [
        "lease above the ceiling",
        { owner: newCapacityOwnerToken(), scope: SCOPE_A, leaseMs: MAX_CAPACITY_LEASE_MS + 1 },
      ],
    ];

    expect(await inspector.exists(KEY)).toBe(0);
    for (const [label, invalid] of cases) {
      // The invalid candidate is LAST, behind two that would otherwise be
      // granted: every candidate is validated before the first write, so a
      // rejected batch can never be partially applied.
      const result = await store.claimBatch(
        KEY,
        [candidate(SCOPE_A), candidate(SCOPE_B), invalid],
        claimLimits(8, 8),
      );
      expect(result, label).toEqual({ kind: "corrupt" });
      expect(await inspector.exists(KEY), label).toBe(0);
    }
  });
});

describe("real Redis: release semantics", () => {
  it("releases idempotently, removing exactly one member", async () => {
    const first = candidate(SCOPE_A);
    const second = candidate(SCOPE_B);
    expect((await store.claimBatch(KEY, [first, second], claimLimits(8, 8))).kind).toBe("claimed");

    expect(await store.release(KEY, first.owner, SCOPE_A)).toEqual({ kind: "ok" });
    // The post-condition the caller needs is "this permit is not held", not
    // "this call performed the removal".
    expect(await store.release(KEY, first.owner, SCOPE_A)).toEqual({ kind: "ok" });

    expect(memberNames(await registryEntries())).toEqual([
      encodeCapacityMember(second.owner, SCOPE_B),
    ]);
  });

  it("never removes a permit this caller does not hold", async () => {
    const held = candidate(SCOPE_A);
    expect((await store.claimBatch(KEY, [held], claimLimits(8, 8))).kind).toBe("claimed");
    const before = await registryEntries();

    expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_A)).toEqual({ kind: "ok" });
    // The ZREM targets the FULL `version|owner|scope` member, so a caller whose
    // view of its own scope drifted can never take someone else's permit.
    expect(await store.release(KEY, held.owner, SCOPE_B)).toEqual({ kind: "ok" });

    expect(await registryEntries()).toEqual(before);
  });

  it("reports `ok` for a release against an absent registry", async () => {
    expect(await inspector.exists(KEY)).toBe(0);
    expect(await store.release(KEY, newCapacityOwnerToken(), SCOPE_A)).toEqual({ kind: "ok" });
    expect(await inspector.exists(KEY)).toBe(0);
  });
});

describe("real Redis: script cache and stored state", () => {
  it("recovers from a SCRIPT FLUSH through the EVALSHA → EVAL fallback", async () => {
    const held = candidate(SCOPE_A);
    expect((await store.claimBatch(KEY, [held], claimLimits(8, 8))).kind).toBe("claimed");

    // SCRIPT FLUSH is SERVER-WIDE: this gate must only ever target a disposable
    // instance, never a shared or production Redis.
    await inspector.scriptFlush();

    // EVALSHA now fails with NOSCRIPT; BOTH scripts must recover by shipping
    // their body once, and the already-held permit must survive rather than the
    // registry being reset.
    const next = candidate(SCOPE_B);
    expect(await store.claimBatch(KEY, [next], claimLimits(8, 8))).toEqual({
      kind: "claimed",
      granted: [next.owner],
    });
    expect(await store.release(KEY, held.owner, SCOPE_A)).toEqual({ kind: "ok" });
    expect(memberNames(await registryEntries())).toEqual([
      encodeCapacityMember(next.owner, SCOPE_B),
    ]);
  });

  it("stores nothing but a version, an owner token, and an opaque scope", async () => {
    const a = candidate(SCOPE_A);
    const b = candidate(SCOPE_B);
    expect((await store.claimBatch(KEY, [a, b], claimLimits(8, 8))).kind).toBe("claimed");

    const keys = await inspector.keys(`${NAMESPACE}:*`);
    expect(keys).toEqual([KEY]);
    // The key is the operator-readable namespace, the fixed category that keeps
    // it out of the `idem`, `rate`, and `reuse` keyspaces, and an HMAC digest.
    expect(KEY).toMatch(new RegExp(`^${NAMESPACE}:capacity:[A-Za-z0-9_-]{43}$`));

    // Exhaustive rather than a search: every stored byte is accounted for by the
    // version, the minted owner token, and the derived scope, so there is no
    // room left for anything else to have been written.
    const entries = await registryEntries();
    expect(memberNames(entries)).toEqual(
      [encodeCapacityMember(a.owner, SCOPE_A), encodeCapacityMember(b.owner, SCOPE_B)].sort(),
    );
    for (const entry of entries) {
      expect(entry.score).toMatch(/^\d{1,15}$/);
      // Exactly three fields at exactly the canonical component lengths: there
      // is no room in a stored member for anything the encoding does not name.
      const [version, member, digest] = entry.member.split(CAPACITY_MEMBER_DELIMITER);
      expect(version).toBe(String(CAPACITY_MEMBER_VERSION));
      expect(member).toHaveLength(CAPACITY_OWNER_TOKEN_CHARS);
      expect(digest).toHaveLength(CAPACITY_SCOPE_CHARS);
      expect(isCanonicalCapacityOwner(member ?? "")).toBe(true);
      expect(isCanonicalCapacityScope(digest ?? "")).toBe(true);
      // A component comparison, not a substring scan: `k0` is short enough to
      // occur by chance inside a random base64url digest, and what actually
      // matters is that it is not a FIELD of any member.
      expect(entry.member.split(CAPACITY_MEMBER_DELIMITER)).not.toContain(LOCAL_KEY_ID);
      for (const sentinel of SENTINELS) {
        expect(entry.member).not.toContain(sentinel);
        expect(KEY).not.toContain(sentinel);
      }
    }
  });

  it("leaves the randomized namespace completely empty after cleanup", async () => {
    expect((await store.claimBatch(KEY, [candidate(SCOPE_A)], claimLimits(8, 8))).kind).toBe(
      "claimed",
    );
    await purge();
    expect(await inspector.keys(`${NAMESPACE}:*`)).toEqual([]);
  });
});
