/**
 * REAL-REDIS contract suite for OpenCode thread reuse (Phase 5A; specification
 * sections 5.1.1, 29.8).
 *
 * The hermetic suites prove the command SHAPE and the coordinator's logic
 * against an in-memory fake. Only a live server can prove the properties that
 * make one OpenCode session address one upstream thread across replicas: that
 * the acquire is atomic, that lease expiry is decided by Redis's own clock
 * inside the script, that two independent gateway instances serialize on one
 * mapping, and that the scripts survive a `SCRIPT FLUSH`.
 *
 * Safety: every value here is synthetic (no real credential, prompt, answer,
 * session, or thread id), the Redis key namespace is randomized per run, and
 * every key the suite creates is deleted in teardown.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { THREAD_REUSE_LIMITS, type VirtualModel } from "../../src/config/schema.js";
import { createRedisConnection, type RedisConnection } from "../../src/redis/index.js";
import {
  buildMappingIdentityDigest,
  buildReuseStorageKey,
  createRedisThreadReuseStore,
  createThreadReuseCoordinator,
  decodeReuseRecord,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  MAX_REUSE_PROCESSING_LEASE_MS,
  newReuseOwnerToken,
  openThreadId,
  REUSE_AMBIGUOUS_TTL_MS,
  REUSE_COMMITTED_TTL_MS,
  REUSE_LEASE_MS,
  sealThreadId,
  type MappingIdentity,
  type ReuseTimings,
  type ThreadReuseCoordinator,
  type ThreadReuseStore,
} from "../../src/thread-reuse/index.js";

const REDIS_URL = process.env["REDIS_TEST_URL"];

// Synthetic sentinels that must NEVER appear in Redis in plaintext.
const GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL-a1b2c3";
const SESSION_SENTINEL = "ses_fake_SENTINEL_d4e5f6";
const OTHER_SESSION_SENTINEL = "ses_fake_SENTINEL_g7h8i9";
const THREAD_SENTINEL = "thread-SENTINEL-j0k1l2";
const UPSTREAM_CREDENTIAL_SENTINEL = "sk-fake-upstream-SENTINEL-m3n4o5";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-p6q7r8";
const ANSWER_SENTINEL = "ANSWER-SENTINEL-s9t0u1";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveThreadReuseKeyring(MASTER_KEY);
/** Randomized per run so parallel runs and leftovers can never interfere. */
const NAMESPACE = `ciqtr-${randomBytes(6).toString("hex")}`;
const ORIGIN = "https://api.example.invalid";

/** A short mapping TTL keeps the suite fast; the sliding semantics are identical. */
const TIMINGS: ReuseTimings = {
  leaseMs: REUSE_LEASE_MS,
  // Derived from the model deadline in production; a fixed value here keeps the
  // suite's assertions about WHICH lease was applied unambiguous.
  processingLeaseMs: 120_000,
  mappingTtlMs: 600_000,
  ambiguousTtlMs: REUSE_AMBIGUOUS_TTL_MS,
  committedTtlMs: REUSE_COMMITTED_TTL_MS,
};

const MODEL: VirtualModel = {
  id: "collectiviq-claude-direct",
  displayName: "direct",
  selectedLlms: ["claude"],
  generateCombined: false,
  answerSource: "claude",
  toolMode: "disabled",
  promptMode: "direct",
  requestTimeoutMs: 90_000,
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 5_000,
  maximumPromptBytes: 6_291_456,
};

const PRINCIPAL = deriveUpstreamPrincipalFingerprint(KEYRING, {
  authMode: "bearer",
  credentialMaterial: UPSTREAM_CREDENTIAL_SENTINEL,
});

function identity(sessionId = SESSION_SENTINEL): MappingIdentity {
  return {
    gatewayKeyScope: deriveThreadReuseScope(KEYRING, GATEWAY_KEY_SENTINEL),
    sessionId,
    policyFingerprint: deriveModelPolicyFingerprint(KEYRING, MODEL),
    origin: ORIGIN,
    principalFingerprint: PRINCIPAL,
  };
}

const KEY = buildReuseStorageKey(KEYRING, NAMESPACE, identity());
const OTHER_KEY = buildReuseStorageKey(KEYRING, NAMESPACE, identity(OTHER_SESSION_SENTINEL));

/** A raw client used only to inspect and clean up, never by the code under test. */
let inspector: ReturnType<typeof createClient>;
const connections: RedisConnection[] = [];

function requireUrl(): string {
  if (REDIS_URL === undefined || REDIS_URL.trim() === "") {
    throw new Error(
      "REDIS_TEST_URL is not set. The real-Redis thread-reuse suite requires a running Redis " +
        "(see compose.yaml `redis` profile) and must not be skipped silently.",
    );
  }
  return REDIS_URL;
}

/** A store over its OWN connection, so cross-replica behaviour is genuine. */
function newStore(): ThreadReuseStore {
  const connection = createRedisConnection({ url: requireUrl() });
  connection.connect();
  connections.push(connection);
  return createRedisThreadReuseStore(connection.substrate);
}

function newCoordinator(store: ThreadReuseStore): ThreadReuseCoordinator {
  return createThreadReuseCoordinator({
    store,
    keyring: KEYRING,
    namespace: NAMESPACE,
    origin: ORIGIN,
    principalFingerprint: PRINCIPAL,
    mappingTtlMs: TIMINGS.mappingTtlMs,
    scheduleRenewal: () => ({ cancel: () => undefined }),
  });
}

async function waitReady(store: ThreadReuseStore): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.isReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the Redis connection did not become ready");
}

function sealed(threadId = THREAD_SENTINEL, key = KEY): ReturnType<typeof sealThreadId> {
  return sealThreadId(KEYRING.aeadKey, threadId, {
    recordVersion: 1,
    storageKey: key,
    mappingIdentityDigest: buildMappingIdentityDigest(KEYRING, NAMESPACE, identity()),
  });
}

/** Delete every key this run could have created. */
async function purge(): Promise<void> {
  const keys = await inspector.keys(`${NAMESPACE}:*`);
  if (keys.length > 0) await inspector.del(keys);
}

let store: ThreadReuseStore;

beforeAll(async () => {
  inspector = createClient({ url: requireUrl() });
  inspector.on("error", () => undefined);
  await inspector.connect();
  store = newStore();
  await waitReady(store);
});

afterEach(async () => {
  await purge();
});

afterAll(async () => {
  await purge();
  for (const connection of connections) await connection.close();
  await inspector.quit();
});

describe("real Redis — thread-reuse state machine", () => {
  it("carries a bound thread from `active` into the next turn's reservation", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("ok");

    const next = newReuseOwnerToken();
    const acquired = await store.acquire(KEY, next, TIMINGS);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    const decoded = decodeReuseRecord(acquired.raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record.s).toBe("reserved");
    expect(decoded.record.o).toBe(next);
    expect(decoded.record.p).toBeDefined();
  });

  it("serializes two INDEPENDENT coordinators on one session", async () => {
    // The property that makes the mapping cross-replica: two gateways, two
    // connections, one Redis, and only one of them may hold the session.
    const a = newCoordinator(newStore());
    const b = newCoordinator(newStore());
    await waitReady(store);

    const first = await a.acquire({
      gatewayKeyScope: identity().gatewayKeyScope,
      sessionId: SESSION_SENTINEL,
      model: MODEL,
    });
    expect(first.kind).toBe("leased");

    const second = await b.acquire({
      gatewayKeyScope: identity().gatewayKeyScope,
      sessionId: SESSION_SENTINEL,
      model: MODEL,
    });
    expect(second.kind).toBe("busy");

    // A DIFFERENT session is unaffected by the held lease.
    const other = await b.acquire({
      gatewayKeyScope: identity().gatewayKeyScope,
      sessionId: OTHER_SESSION_SENTINEL,
      model: MODEL,
    });
    expect(other.kind).toBe("leased");
    if (first.kind === "leased") await first.session.finish();
    if (other.kind === "leased") await other.session.finish();
  });

  it("admits exactly one winner when many requests race the same new session", async () => {
    const stores = [store, newStore(), newStore(), newStore()];
    await Promise.all(stores.map(waitReady));
    const owners = stores.map(() => newReuseOwnerToken());
    const results = await Promise.all(
      stores.map((s, i) => s.acquire(KEY, owners[i] as string, TIMINGS)),
    );
    expect(results.filter((r) => r.kind === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "busy")).toHaveLength(stores.length - 1);
  });

  it("lets an expired RESERVED lease be taken over, keeping the bound thread", async () => {
    const owner = newReuseOwnerToken();
    // A one-millisecond lease stands in for a crashed pre-submit owner.
    const brief: ReuseTimings = { ...TIMINGS, leaseMs: 1 };
    expect((await store.acquire(KEY, owner, brief)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, brief)).kind).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const taker = newReuseOwnerToken();
    const acquired = await store.acquire(KEY, taker, TIMINGS);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    const decoded = decodeReuseRecord(acquired.raw);
    expect(decoded.ok && decoded.record.p !== undefined).toBe(true);
    // The previous owner can no longer advance the mapping.
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("lost");
  });

  it("turns an expired PROCESSING lease into `ambiguous`, never into a reusable mapping", async () => {
    const owner = newReuseOwnerToken();
    // BOTH leases are shortened: `markProcessing` writes the PROCESSING lease,
    // so shortening only the reserved one would leave a two-minute record.
    const brief: ReuseTimings = { ...TIMINGS, leaseMs: 1, processingLeaseMs: 1 };
    expect((await store.acquire(KEY, owner, brief)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, brief)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, brief)).kind).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await store.acquire(KEY, newReuseOwnerToken(), TIMINGS)).kind).toBe("blocked");
    const raw = await inspector.get(KEY);
    const decoded = decodeReuseRecord(raw ?? "");
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record.s).toBe("ambiguous");
    // The tombstone drops the thread and carries its own shorter TTL.
    expect(decoded.record.p).toBeUndefined();
    const ttl = await inspector.pTTL(KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REUSE_AMBIGUOUS_TTL_MS);
  });

  it("renews from the AUTHORITATIVE stored state, never a caller's stale view", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    expect(await store.renew(KEY, owner, TIMINGS)).toEqual({
      kind: "ok",
      observedState: "reserved",
    });
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");
    // The renewal reports what Redis actually holds, so a caller mid-transition
    // cannot misapply a lease.
    expect(await store.renew(KEY, owner, TIMINGS)).toEqual({
      kind: "ok",
      observedState: "processing",
    });
    // ...and it applied the PROCESSING lease, not the short reserved one, so a
    // caller whose view lagged the transition cannot expire a live completion.
    const midRecord = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(midRecord.ok).toBe(true);
    if (midRecord.ok) {
      expect(midRecord.record.l - Date.now()).toBeGreaterThan(TIMINGS.leaseMs + 1_000);
    }
    // A finalized mapping is never revived by a stray renewal.
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.renew(KEY, owner, TIMINGS)).kind).toBe("state");
    const decoded = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(decoded.ok && decoded.record.s).toBe("active");
    expect(decoded.ok && decoded.record.l).toBe(0);
  });

  it("resets the sliding mapping TTL on every write", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("ok");

    const first = await inspector.pTTL(KEY);
    expect(first).toBeGreaterThan(TIMINGS.mappingTtlMs - 5_000);
    expect(first).toBeLessThanOrEqual(TIMINGS.mappingTtlMs);

    // A seven-day TTL is the production default; the sliding behaviour is the
    // same at any configured value, so the assertion is on the RESET rather than
    // on a literal duration.
    const week: ReuseTimings = { ...TIMINGS, mappingTtlMs: 604_800_000 };
    const next = newReuseOwnerToken();
    expect((await store.acquire(KEY, next, week)).kind).toBe("acquired");
    const extended = await inspector.pTTL(KEY);
    expect(extended).toBeGreaterThan(TIMINGS.mappingTtlMs);
  });

  it("restores a bound reservation to `active` and deletes an unbound one", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    expect(await store.release(KEY, owner, TIMINGS)).toEqual({ kind: "ok", restored: false });
    expect(await inspector.exists(KEY)).toBe(0);

    const second = newReuseOwnerToken();
    expect((await store.acquire(KEY, second, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, second, payload, TIMINGS)).kind).toBe("ok");
    expect(await store.release(KEY, second, TIMINGS)).toEqual({ kind: "ok", restored: true });
    const decoded = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(decoded.ok && decoded.record.s).toBe("active");
  });

  it("retires an unusable mapping under the ambiguous TTL so it ages out", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.discardUnusable(KEY, owner, TIMINGS)).kind).toBe("ok");

    const decoded = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(decoded.ok && decoded.record.s).toBe("ambiguous");
    expect(decoded.ok && decoded.record.p).toBeUndefined();
    // The SHORT TTL is the point: a restore would slide the mapping TTL forward
    // on every retry and the broken mapping would never age out.
    const ttl = await inspector.pTTL(KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REUSE_AMBIGUOUS_TTL_MS);
    expect(ttl).toBeLessThan(TIMINGS.mappingTtlMs);
  });

  it("guards every transition by owner AND expected state", async () => {
    const owner = newReuseOwnerToken();
    const stranger = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    expect((await store.markProcessing(KEY, stranger, TIMINGS)).kind).toBe("lost");
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("state");
    expect((await store.abandon(KEY, owner, TIMINGS)).kind).toBe("state");
    expect((await store.discardUnusable(KEY, stranger, TIMINGS)).kind).toBe("lost");
    // A submit cannot be marked without a bound thread.
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("corrupt");
    // Every operation on an absent key reports `missing`, never invents state.
    expect((await store.renew(OTHER_KEY, owner, TIMINGS)).kind).toBe("missing");
  });

  it("recovers from a SCRIPT FLUSH through the EVALSHA → EVAL fallback", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    await inspector.scriptFlush();
    // The very next call must still succeed by shipping the script body.
    expect(await store.renew(KEY, owner, TIMINGS)).toEqual({
      kind: "ok",
      observedState: "reserved",
    });
  });

  it("fails closed on a corrupt or oversized stored value, without repairing it", async () => {
    const owner = newReuseOwnerToken();
    for (const value of [
      "not json",
      "[]",
      '{"v":2,"s":"active","o":"AAAA","l":0}',
      '{"v":1,"s":"active","o":"has space","l":0}',
      "x".repeat(9000),
    ]) {
      await inspector.set(KEY, value);
      expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("corrupt");
      // The value is never rewritten or deleted: silently starting a
      // replacement thread is exactly what this feature must not do.
      expect(await inspector.get(KEY)).toBe(value);
    }
  });

  it("rejects every structurally invalid record, byte-for-byte untouched", async () => {
    // The Lua guard must validate the COMPLETE record — exact key sets and
    // state-specific invariants — before any transition. A partial guard would
    // let a corrupt record be sanitized and rewritten into a valid-looking one,
    // which is how a forged record becomes a real mapping.
    const owner = newReuseOwnerToken();
    const seal = '{"i":"AAAA","c":"BBBB","t":"CCCC"}';
    const invalid: readonly [string, string][] = [
      ["unknown top-level key", `{"v":1,"s":"active","o":"AAAA","l":0,"p":${seal},"x":1}`],
      [
        "unknown sealed-payload key",
        `{"v":1,"s":"active","o":"AAAA","l":0,"p":{"i":"AAAA","c":"BBBB","t":"CCCC","z":1}}`,
      ],
      ["active with a nonzero lease", `{"v":1,"s":"active","o":"AAAA","l":123,"p":${seal}}`],
      ["committed with a nonzero lease", `{"v":1,"s":"committed","o":"AAAA","l":123,"p":${seal}}`],
      ["processing without a payload", '{"v":1,"s":"processing","o":"AAAA","l":123}'],
      ["committed without a payload", '{"v":1,"s":"committed","o":"AAAA","l":0}'],
      ["ambiguous carrying a payload", `{"v":1,"s":"ambiguous","o":"AAAA","l":0,"p":${seal}}`],
      ["reserved with a zero lease", '{"v":1,"s":"reserved","o":"AAAA","l":0}'],
      ["non-integral lease", '{"v":1,"s":"reserved","o":"AAAA","l":1.5}'],
      ["negative lease", '{"v":1,"s":"reserved","o":"AAAA","l":-1}'],
      ["non-numeric lease", '{"v":1,"s":"reserved","o":"AAAA","l":"123"}'],
      ["missing lease", '{"v":1,"s":"reserved","o":"AAAA"}'],
      ["unknown state", `{"v":1,"s":"nope","o":"AAAA","l":0,"p":${seal}}`],
      ["null payload", '{"v":1,"s":"active","o":"AAAA","l":0,"p":null}'],
      ["array payload", '{"v":1,"s":"active","o":"AAAA","l":0,"p":["AAAA","BBBB","CCCC"]}'],
      [
        "non-base64url payload field",
        '{"v":1,"s":"active","o":"AAAA","l":0,"p":{"i":"AA AA","c":"BBBB","t":"CCCC"}}',
      ],
      ["empty owner", `{"v":1,"s":"active","o":"","l":0,"p":${seal}}`],
      ["non-string owner", `{"v":1,"s":"active","o":123,"l":0,"p":${seal}}`],
      [
        "empty sealed field",
        '{"v":1,"s":"active","o":"AAAA","l":0,"p":{"i":"","c":"BBBB","t":"CCCC"}}',
      ],
      ["missing sealed field", '{"v":1,"s":"active","o":"AAAA","l":0,"p":{"i":"AAAA","c":"BBBB"}}'],
      // A JSON infinity satisfies both a floor comparison and math.floor, so it
      // would pass a naive integral check and then never expire.
      ["non-finite lease", '{"v":1,"s":"reserved","o":"AAAA","l":1e999}'],
      ["missing version", '{"s":"active","o":"AAAA","l":0,"p":' + seal + "}"],
      ["missing state", `{"v":1,"o":"AAAA","l":0,"p":${seal}}`],
    ];

    for (const [label, value] of invalid) {
      await inspector.set(KEY, value);
      // Every mutating entry point must refuse it, not just `acquire`.
      expect((await store.acquire(KEY, owner, TIMINGS)).kind, label).toBe("corrupt");
      expect((await store.renew(KEY, owner, TIMINGS)).kind, label).toBe("corrupt");
      expect((await store.commit(KEY, owner, TIMINGS)).kind, label).toBe("corrupt");
      expect((await store.activate(KEY, owner, TIMINGS)).kind, label).toBe("corrupt");
      expect((await store.abandon(KEY, owner, TIMINGS)).kind, label).toBe("corrupt");
      expect((await store.release(KEY, owner, TIMINGS)).kind, label).toBe("corrupt");
      // Untouched: a rejected record is never sanitized into a valid one.
      expect(await inspector.get(KEY), label).toBe(value);
    }
  });

  it("keeps a leased key alive past its lease on the shortest mapping TTL", async () => {
    // Configuration permits a mapping TTL far shorter than a processing lease.
    // The key must still outlive the lease, or an abandoned `processing` record
    // would vanish instead of becoming `ambiguous`.
    const owner = newReuseOwnerToken();
    const squeezed: ReuseTimings = {
      ...TIMINGS,
      processingLeaseMs: MAX_REUSE_PROCESSING_LEASE_MS,
      mappingTtlMs: THREAD_REUSE_LIMITS.ttlMs.min,
    };
    expect((await store.acquire(KEY, owner, squeezed)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, squeezed)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, squeezed)).kind).toBe("ok");

    const ttl = await inspector.pTTL(KEY);
    expect(ttl).toBeGreaterThan(squeezed.mappingTtlMs);
    // Not merely "at least the lease": the record must survive its lease by a
    // full conversion window, or an abandoned `processing` record could expire
    // before any competitor observes the expired lease and tombstones it.
    expect(ttl).toBeGreaterThanOrEqual(
      squeezed.processingLeaseMs + squeezed.ambiguousTtlMs - 1_000,
    );
    expect(ttl).toBeLessThanOrEqual(squeezed.processingLeaseMs + squeezed.ambiguousTtlMs);
  });

  it("splits the terminal transition and never exposes `committed` as reusable", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");

    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");
    // Idempotent: a lost reply can still be acknowledged by a retry.
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");
    const committed = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(committed.ok && committed.record.s).toBe("committed");
    // Bounded, and NOT acquirable by anyone.
    const committedTtl = await inspector.pTTL(KEY);
    expect(committedTtl).toBeGreaterThan(0);
    expect(committedTtl).toBeLessThanOrEqual(REUSE_COMMITTED_TTL_MS);
    expect((await store.acquire(KEY, newReuseOwnerToken(), TIMINGS)).kind).toBe("blocked");

    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("ok");
    const active = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(active.ok && active.record.s).toBe("active");
  });

  it("tombstones a record that vanished between commit and activation", async () => {
    // Without this, an evicted/deleted key would leave activation reporting
    // `missing` over an ABSENT key, and the session's next acquire would create
    // a replacement thread — a silent break in conversation continuity.
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");

    await inspector.del(KEY);
    expect(await inspector.get(KEY)).toBeNull();

    // The caller still receives the definitive failure...
    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("missing");

    // ...but the key is now a valid, thread-free tombstone rather than absent.
    const decoded = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(decoded.ok && decoded.record.s).toBe("ambiguous");
    expect(decoded.ok && decoded.record.p).toBeUndefined();
    const ttl = await inspector.pTTL(KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REUSE_AMBIGUOUS_TTL_MS);

    // A competitor is blocked instead of being handed a clean slate.
    expect((await store.acquire(KEY, newReuseOwnerToken(), TIMINGS)).kind).toBe("blocked");
  });

  it("lets settlement tombstone a `committed` record whose commit was unacknowledged", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");

    expect((await store.abandon(KEY, owner, TIMINGS)).kind).toBe("ok");
    const decoded = decodeReuseRecord((await inspector.get(KEY)) ?? "");
    expect(decoded.ok && decoded.record.s).toBe("ambiguous");
    expect(decoded.ok && decoded.record.p).toBeUndefined();
  });

  it("stores nothing sensitive under any key it writes", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    const payload = sealed();
    if (payload === null) throw new Error("expected a sealed thread");
    expect((await store.bind(KEY, owner, payload, TIMINGS)).kind).toBe("ok");
    expect((await store.markProcessing(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.commit(KEY, owner, TIMINGS)).kind).toBe("ok");
    expect((await store.activate(KEY, owner, TIMINGS)).kind).toBe("ok");

    const keys = await inspector.keys(`${NAMESPACE}:*`);
    expect(keys).toEqual([KEY]);
    const raw = (await inspector.get(KEY)) ?? "";
    const sentinels = [
      GATEWAY_KEY_SENTINEL,
      SESSION_SENTINEL,
      THREAD_SENTINEL,
      UPSTREAM_CREDENTIAL_SENTINEL,
      PROMPT_SENTINEL,
      ANSWER_SENTINEL,
      MASTER_KEY,
      ORIGIN,
      MODEL.id,
    ];
    for (const sentinel of sentinels) {
      expect(KEY).not.toContain(sentinel);
      expect(raw).not.toContain(sentinel);
    }
    // Only the owner of the right key AND binding can recover the thread id.
    const decoded = decodeReuseRecord(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.record.p === undefined) return;
    expect(
      openThreadId(KEYRING.aeadKey, decoded.record.p, {
        recordVersion: 1,
        storageKey: KEY,
        mappingIdentityDigest: buildMappingIdentityDigest(KEYRING, NAMESPACE, identity()),
      }),
    ).toBe(THREAD_SENTINEL);
  });

  it("leaves the randomized namespace completely empty after cleanup", async () => {
    const owner = newReuseOwnerToken();
    expect((await store.acquire(KEY, owner, TIMINGS)).kind).toBe("acquired");
    await purge();
    expect(await inspector.keys(`${NAMESPACE}:*`)).toEqual([]);
  });
});
