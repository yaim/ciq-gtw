/**
 * REAL-REDIS contract suite for the idempotency store and coordinator (Phase
 * 4A; specification sections 18, 22.2, 29).
 *
 * This is the only suite in the repository that requires an external service.
 * It runs against `REDIS_TEST_URL` and is excluded from ordinary Vitest
 * discovery and from `npm run validate`; CI runs it as a separate gate with a
 * pinned Redis service.
 *
 * Safety: every value here is synthetic (no real credential, prompt, answer, or
 * account data), the Redis key namespace is randomized per run, and every key
 * the suite creates is deleted in teardown.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createReadinessState } from "../../src/api/health-route.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { Clock, Sleeper } from "../../src/generation/types.js";
import {
  buildStorageKey,
  createIdempotencyCoordinator,
  createRedisIdempotencyStore,
  deriveIdempotencyKeyring,
  type ActiveLeases,
  type IdempotencyCoordinator,
} from "../../src/idempotency/index.js";
import { buildServer } from "../../src/server.js";
import { RESERVED_LEASE_MS } from "../../src/idempotency/limits.js";
import type { CachedResult } from "../../src/idempotency/payload.js";
import type { IdempotencyStore } from "../../src/idempotency/store.js";
import { createRedisConnection } from "../../src/redis/index.js";
import { createRedisRuntime } from "../../src/redis/runtime.js";

/**
 * One shared Redis connection plus the idempotency store it backs. The suite
 * still drives `connection.store`; only the composition changed when the client
 * moved into the shared substrate (`src/redis/`).
 */
interface RedisIdempotencyConnection {
  readonly store: IdempotencyStore;
  connect(): void;
  close(): Promise<void>;
  isReady(): boolean;
}

function openIdempotencyConnection(url: string): RedisIdempotencyConnection {
  const connection = createRedisConnection({ url });
  return {
    store: createRedisIdempotencyStore(connection.substrate),
    connect: () => connection.connect(),
    close: () => connection.close(),
    isReady: () => connection.isReady(),
  };
}

const REDIS_URL = process.env["REDIS_TEST_URL"];

// Synthetic sentinels that must NEVER appear in Redis in plaintext.
const PROMPT_SENTINEL = "PROMPT-SENTINEL-a1b2c3";
const ANSWER_SENTINEL = "ANSWER-SENTINEL-d4e5f6";
const TOOL_ARG_SENTINEL = "TOOL-ARG-SENTINEL-g7h8i9";
const GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL-j0k1l2";
const IDEMPOTENCY_KEY_SENTINEL = "idem-SENTINEL-m3n4o5";
const THREAD_SENTINEL = "thread-SENTINEL-p6q7r8";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveIdempotencyKeyring(MASTER_KEY);
/** Randomized per run so parallel runs and leftovers can never interfere. */
const NAMESPACE = `ciqtest-${randomBytes(6).toString("hex")}`;
const TTL_MS = 60_000;

const IDENTITY = {
  id: "chatcmpl_ciq_redis_contract",
  created: 1_700_000_000,
  model: "collectiviq-consensus",
};
const FINGERPRINT_A = "ZmluZ2VycHJpbnQtcmVkaXMtYQ";
const FINGERPRINT_B = "ZmluZ2VycHJpbnQtcmVkaXMtYg";

/** A raw client used only to inspect and clean up, never by the code under test. */
let inspector: ReturnType<typeof createClient>;
const connections: RedisIdempotencyConnection[] = [];

/** Synthetic application configuration wired to the real test Redis. */
function appConfig(): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: "sk-fake-upstream",
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY_SENTINEL],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHUTDOWN_DRAIN_MS: 30_000,
    REDIS_URL: requireUrl(),
    IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY,
    IDEMPOTENCY_TTL_MS: TTL_MS,
    REDIS_KEY_PREFIX: NAMESPACE,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    models: [
      {
        id: "collectiviq-consensus",
        displayName: "consensus",
        selectedLlms: ["gpt"],
        generateCombined: false,
        answerSource: "gpt",
        toolMode: "disabled",
        promptMode: "protocol",
        requestTimeoutMs: 90_000,
        pollIntervalMs: 2_000,
        maxPollIntervalMs: 5_000,
        maximumPromptBytes: 6_291_456,
      },
    ],
  };
}

function requireUrl(): string {
  if (REDIS_URL === undefined || REDIS_URL.trim() === "") {
    throw new Error(
      "REDIS_TEST_URL is not set. The real-Redis idempotency suite requires a running Redis " +
        "(see compose.yaml `redis` profile) and must not be skipped silently.",
    );
  }
  return REDIS_URL;
}

async function waitReady(connection: RedisIdempotencyConnection, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (connection.isReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Redis did not become ready within the test deadline");
}

/** Build a connected connection registered for teardown. */
async function connected(): Promise<RedisIdempotencyConnection> {
  const connection = openIdempotencyConnection(requireUrl());
  connections.push(connection);
  connection.connect();
  await waitReady(connection);
  return connection;
}

interface CoordinatorHarness {
  readonly coordinator: IdempotencyCoordinator;
  readonly connection: RedisIdempotencyConnection;
  setNow(ms: number): void;
}

/**
 * A coordinator over a REAL Redis with a controlled clock and an instant
 * sleeper, so waiter backoff costs no wall-clock time while Redis TTLs stay
 * genuinely server-side.
 */
async function coordinatorHarness(): Promise<CoordinatorHarness> {
  const connection = await connected();
  let nowMs = Date.now();
  const clock: Clock = { nowMs: () => nowMs };
  const sleeper: Sleeper = {
    sleep: (ms, signal) => {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      nowMs += ms;
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
  return {
    connection,
    coordinator: createIdempotencyCoordinator({
      store: connection.store,
      keyring: KEYRING,
      namespace: NAMESPACE,
      ttlMs: TTL_MS,
      clock,
      sleeper,
      random: () => 0,
      scheduleRenewal: () => ({ cancel: () => undefined }),
    }),
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

/**
 * A lease pair whose two durations are DISTINCT, so a test can tell which one
 * the renewal script actually applied.
 */
function leases(reserved: number, processing = reserved * 4): ActiveLeases {
  return { reserved, processing };
}

type BeginInput = Parameters<IdempotencyCoordinator["begin"]>[0];

function beginInput(over: Partial<BeginInput> = {}): BeginInput {
  return {
    clientKey: IDEMPOTENCY_KEY_SENTINEL,
    gatewayKeyScope: "scope-redis-contract",
    bodyFingerprint: FINGERPRINT_A,
    identity: IDENTITY,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    ...over,
  };
}

/** Every key this suite created (all live under the randomized namespace). */
async function suiteKeys(): Promise<string[]> {
  const found: string[] = [];
  for await (const batch of inspector.scanIterator({ MATCH: `${NAMESPACE}:*`, COUNT: 100 })) {
    const value: unknown = batch;
    const keys: readonly unknown[] = Array.isArray(value) ? value : [value];
    for (const key of keys) found.push(String(key));
  }
  return found;
}

async function deleteSuiteKeys(): Promise<void> {
  const keys = await suiteKeys();
  if (keys.length > 0) await inspector.del(keys);
}

beforeAll(async () => {
  inspector = createClient({ url: requireUrl() });
  inspector.on("error", () => undefined);
  await inspector.connect();
  await deleteSuiteKeys();
});

afterEach(async () => {
  await deleteSuiteKeys();
});

afterAll(async () => {
  await deleteSuiteKeys();
  for (const connection of connections) await connection.close();
  await inspector.close();
});

describe("real Redis: atomic claim and compare-and-transition", () => {
  it("lets exactly ONE of many concurrent claimants win", async () => {
    const connection = await connected();
    const key = `${NAMESPACE}:concurrent-claim`;
    const record = (owner: string): string =>
      JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: owner, e: Date.now() + 30_000 });

    const owners = Array.from({ length: 25 }, (_, i) => `owner-${String(i)}`);
    const results = await Promise.all(
      owners.map((owner) => connection.store.claim(key, record(owner), RESERVED_LEASE_MS)),
    );
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "exists")).toHaveLength(owners.length - 1);
    // Every loser observed the SAME winning record.
    const seen = new Set(results.flatMap((r) => (r.kind === "exists" ? [r.raw] : [])));
    expect(seen.size).toBe(1);
  });

  it("enforces the owner token and expected state on every transition", async () => {
    const connection = await connected();
    const key = `${NAMESPACE}:cas`;
    const owner = "owner-real";
    const reserved = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: owner, e: 1 });
    const processing = JSON.stringify({ v: 1, s: "processing", f: FINGERPRINT_A, o: owner, e: 1 });

    expect(await connection.store.claim(key, reserved, RESERVED_LEASE_MS)).toEqual({
      kind: "claimed",
    });
    // Wrong owner.
    expect(
      await connection.store.transition(key, "other", "reserved", processing, RESERVED_LEASE_MS),
    ).toEqual({ kind: "lost" });
    // Wrong expected state.
    expect(
      await connection.store.transition(key, owner, "processing", processing, RESERVED_LEASE_MS),
    ).toEqual({ kind: "state" });
    // Correct owner and state.
    expect(
      await connection.store.transition(key, owner, "reserved", processing, RESERVED_LEASE_MS),
    ).toEqual({ kind: "ok" });
    // The record really changed server-side.
    expect(await inspector.get(key)).toBe(processing);
    // A repeat of the same transition now fails the state guard.
    expect(
      await connection.store.transition(key, owner, "reserved", processing, RESERVED_LEASE_MS),
    ).toEqual({ kind: "state" });
  });

  it("compare-and-deletes only the owner's record in the expected state", async () => {
    const connection = await connected();
    const key = `${NAMESPACE}:release`;
    const owner = "owner-release";
    const reserved = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: owner, e: 1 });
    await connection.store.claim(key, reserved, RESERVED_LEASE_MS);

    expect(await connection.store.release(key, "other", "reserved")).toEqual({ kind: "lost" });
    expect(await connection.store.release(key, owner, "processing")).toEqual({ kind: "state" });
    expect(await inspector.get(key)).toBe(reserved);
    expect(await connection.store.release(key, owner, "reserved")).toEqual({ kind: "ok" });
    expect(await inspector.get(key)).toBeNull();
    expect(await connection.store.release(key, owner, "reserved")).toEqual({ kind: "missing" });
  });

  it("classifies every malformed record shape as corrupt, never as lost", async () => {
    // `cjson.decode` returns a Lua table for a JSON ARRAY as well as an object,
    // and the two are indistinguishable in Lua 5.1 — so without explicit type
    // guards an array (or a non-string `s`/`o`) would fall through to the owner
    // comparison and report `lost`. Both fail closed, but the coordinator's
    // handling differs, so the classification must be right.
    const connection = await connected();
    const key = `${NAMESPACE}:shapes`;
    const owner = "owner-shapes";
    for (const value of [
      "not json",
      "[]",
      "{}",
      "[1,2,3]",
      "null",
      "123",
      '"a string"',
      "true",
      '{"v":1,"s":"reserved","f":"x","o":123,"e":1}',
      '{"v":1,"s":"reserved","f":"x","o":true,"e":1}',
      '{"v":1,"s":123,"f":"x","o":"owner-shapes","e":1}',
      '{"v":1,"f":"x","o":"owner-shapes","e":1}',
    ]) {
      await inspector.set(key, value);
      expect(await connection.store.transition(key, owner, "reserved", "{}", 1_000)).toEqual({
        kind: "corrupt",
      });
      expect(await connection.store.renew(key, owner, leases(1_000))).toEqual({ kind: "corrupt" });
      expect(await connection.store.release(key, owner, "reserved")).toEqual({ kind: "corrupt" });
      // Nothing was mutated or deleted.
      expect(await inspector.get(key)).toBe(value);
    }
    await inspector.del(key);
  });

  it("refuses to transition a record written in an unsupported version", async () => {
    // Guards a mixed-version deployment: a replica must never compare-and-swap
    // a record whose format it does not understand, because the replacement it
    // writes would silently drop any field the newer format added.
    const connection = await connected();
    const key = `${NAMESPACE}:version`;
    const owner = "owner-version";
    for (const version of [0, 2, 99, "1"]) {
      const record = JSON.stringify({
        v: version,
        s: "reserved",
        f: FINGERPRINT_A,
        o: owner,
        e: 1,
      });
      await inspector.set(key, record);
      expect(await connection.store.transition(key, owner, "reserved", "{}", 1_000)).toEqual({
        kind: "corrupt",
      });
      expect(await connection.store.renew(key, owner, leases(1_000))).toEqual({ kind: "corrupt" });
      expect(await connection.store.release(key, owner, "reserved")).toEqual({ kind: "corrupt" });
      expect(await inspector.get(key)).toBe(record);
    }
    await inspector.del(key);
  });

  it("rejects an oversized value WITHOUT ever issuing a GET for it", async () => {
    // Load bearing: the assertion is not merely that the classification is
    // `corrupt`, but that the server's own command counters show no `GET` was
    // executed at all — proving the size guard short-circuits before the read
    // rather than after it.
    const connection = await connected();
    const key = `${NAMESPACE}:oversize`;
    await inspector.set(key, "x".repeat(9_000_000));

    // Reset AFTER the setup writes so only the operations under test are counted.
    await inspector.configResetStat();
    expect(await connection.store.read(key)).toEqual({ kind: "corrupt" });
    expect(await connection.store.renew(key, "any-owner", leases(1_000))).toEqual({
      kind: "corrupt",
    });

    const stats = await inspector.info("commandstats");
    expect(stats).toMatch(/cmdstat_strlen:/); // the bound really was checked...
    expect(stats).not.toMatch(/cmdstat_get:/); // ...and the value was never read.
    // The oversized record is neither deleted nor rewritten.
    expect(await inspector.strLen(key)).toBe(9_000_000);
    await inspector.del(key);
  });

  it("does issue the GET for a value within the bound", async () => {
    // The counter assertion above is only meaningful if a normal read DOES
    // register a `GET`; otherwise it would pass for the wrong reason.
    const connection = await connected();
    const key = `${NAMESPACE}:within-bound`;
    const record = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: "o", e: 1 });
    await inspector.set(key, record);

    await inspector.configResetStat();
    expect(await connection.store.read(key)).toEqual({ kind: "found", raw: record });

    const stats = await inspector.info("commandstats");
    expect(stats).toMatch(/cmdstat_get:/);
    await inspector.del(key);
  });

  it("survives a SCRIPT FLUSH via the EVALSHA -> EVAL fallback", async () => {
    const connection = await connected();
    const key = `${NAMESPACE}:noscript`;
    const record = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: "o", e: 1 });
    expect(await connection.store.claim(key, record, RESERVED_LEASE_MS)).toEqual({
      kind: "claimed",
    });
    await inspector.scriptFlush();
    // Every script must still work after its cached SHA disappears.
    expect(await connection.store.renew(key, "o", leases(RESERVED_LEASE_MS))).toEqual({
      kind: "ok",
      observedState: "reserved",
    });
    expect(await connection.store.release(key, "o", "reserved")).toEqual({ kind: "ok" });
    expect(await connection.store.claim(key, record, RESERVED_LEASE_MS)).toEqual({
      kind: "claimed",
    });
  });
});

describe("real Redis: lease renewal and expiry", () => {
  it("renews an active lease and never revives a terminal record", async () => {
    const connection = await connected();
    const key = `${NAMESPACE}:lease`;
    const owner = "owner-lease";
    const reserved = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: owner, e: 1 });
    await connection.store.claim(key, reserved, 400);

    // Renewing extends the server-side TTL.
    expect(await connection.store.renew(key, owner, leases(5_000))).toEqual({
      kind: "ok",
      observedState: "reserved",
    });
    const ttl = await inspector.pTTL(key);
    expect(Number(ttl)).toBeGreaterThan(1_000);

    // A `final` record is never revived by a renewal.
    const final = JSON.stringify({
      v: 1,
      s: "final",
      f: FINGERPRINT_A,
      o: owner,
      e: 1,
      p: { i: "AAAAAAAAAAAAAAAA", c: "Y2lwaGVy", t: "dGFn" },
    });
    await connection.store.transition(key, owner, "reserved", final, 5_000);
    expect(await connection.store.renew(key, owner, leases(60_000))).toEqual({ kind: "state" });
  });

  it("selects the lease from the STORED state, not from the caller's view", async () => {
    // The P1 race, at the server: a renewal issued while the caller still
    // believes the record is `reserved` must not shorten a record that Redis has
    // already advanced to `processing`.
    const connection = await connected();
    const key = `${NAMESPACE}:lease-selection`;
    const owner = "owner-selection";
    const reserved = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: owner, e: 1 });
    const processing = JSON.stringify({ v: 1, s: "processing", f: FINGERPRINT_A, o: owner, e: 1 });
    const pair = leases(2_000, 60_000);

    // Claim with a lease SHORTER than the reserved renewal lease, so a renewal
    // that silently no-op'd would leave a TTL below the asserted floor.
    await connection.store.claim(key, reserved, 1_000);
    expect(await connection.store.renew(key, owner, pair)).toEqual({
      kind: "ok",
      observedState: "reserved",
    });
    const reservedTtl = Number(await inspector.pTTL(key));
    // While `reserved`, the short lease applies — and it really was applied.
    expect(reservedTtl).toBeGreaterThan(1_000);
    expect(reservedTtl).toBeLessThanOrEqual(2_000);

    // Advance the stored state, then renew with the SAME lease pair.
    await connection.store.transition(key, owner, "reserved", processing, 2_000);
    expect(await connection.store.renew(key, owner, pair)).toEqual({
      kind: "ok",
      observedState: "processing",
    });
    // The long lease was applied — the caller supplied both and chose neither.
    const ttl = Number(await inspector.pTTL(key));
    expect(ttl).toBeGreaterThan(2_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    await inspector.del(key);
  });

  it("expires an unrenewed lease server-side and reports missing", async () => {
    const connection = await connected();
    const key = `${NAMESPACE}:expiry`;
    const owner = "owner-expiry";
    const reserved = JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT_A, o: owner, e: 1 });
    await connection.store.claim(key, reserved, 150);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await connection.store.read(key)).toEqual({ kind: "missing" });
    expect(await connection.store.renew(key, owner, leases(1_000))).toEqual({ kind: "missing" });
    // The key is genuinely gone, so a later request can claim it fresh.
    expect(await connection.store.claim(key, reserved, 1_000)).toEqual({ kind: "claimed" });
  });
});

describe("real Redis: two independent coordinators sharing one Redis", () => {
  it("executes the completion once and replays it to the other instance", async () => {
    const alpha = await coordinatorHarness();
    const bravo = await coordinatorHarness();

    const first = await alpha.coordinator.begin(beginInput());
    expect(first.kind).toBe("owner");
    if (first.kind !== "owner") throw new Error("unreachable");

    // The second INSTANCE (its own client and its own coordinator) sees the
    // claim and waits rather than starting its own completion.
    const second = await bravo.coordinator.begin(beginInput());
    expect(second.kind).toBe("existing");
    if (second.kind !== "existing") throw new Error("unreachable");

    expect(await first.session.markProcessing()).toBe("ok");
    const waiting = second.resolve();
    const result: CachedResult = { kind: "text", content: ANSWER_SENTINEL };
    expect(await first.session.commit(result)).toBe("ok");
    await first.session.finish();

    expect(await waiting).toEqual({ kind: "cached", cached: { ...IDENTITY, result } });
  });

  it("returns conflict across instances for a different body", async () => {
    const alpha = await coordinatorHarness();
    const bravo = await coordinatorHarness();
    const owner = await alpha.coordinator.begin(beginInput());
    if (owner.kind !== "owner") throw new Error("expected owner");
    expect(
      (await bravo.coordinator.begin(beginInput({ bodyFingerprint: FINGERPRINT_B }))).kind,
    ).toBe("conflict");
    await owner.session.finish();
  });

  it("lets exactly one of two racing instances become the owner", async () => {
    const alpha = await coordinatorHarness();
    const bravo = await coordinatorHarness();
    const input = beginInput({ clientKey: `${IDEMPOTENCY_KEY_SENTINEL}-race` });
    const [a, b] = await Promise.all([
      alpha.coordinator.begin(input),
      bravo.coordinator.begin(input),
    ]);
    const owners = [a, b].filter((outcome) => outcome.kind === "owner");
    expect(owners).toHaveLength(1);
    for (const outcome of [a, b]) {
      if (outcome.kind === "owner") await outcome.session.finish();
    }
  });

  it("blocks the other instance on an ambiguous record", async () => {
    const alpha = await coordinatorHarness();
    const bravo = await coordinatorHarness();
    const owner = await alpha.coordinator.begin(beginInput());
    if (owner.kind !== "owner") throw new Error("expected owner");
    await owner.session.markProcessing();
    await owner.session.finish(); // failed after processing -> ambiguous
    expect((await bravo.coordinator.begin(beginInput())).kind).toBe("unavailable");
  });
});

describe("real Redis: corrupt and tampered records fail closed", () => {
  it("never replays a corrupt, mis-versioned, or tampered record", async () => {
    const harness = await coordinatorHarness();
    // Establish a real committed record, then corrupt it in place.
    const owner = await harness.coordinator.begin(beginInput());
    if (owner.kind !== "owner") throw new Error("expected owner");
    await owner.session.markProcessing();
    await owner.session.commit({ kind: "text", content: ANSWER_SENTINEL });
    await owner.session.finish();

    const keys = await suiteKeys();
    expect(keys).toHaveLength(1);
    const key = keys[0] as string;
    const good = (await inspector.get(key)) as string;

    // Flip exactly one ciphertext character, chosen deterministically from the
    // decoded record rather than by pattern-matching the serialized JSON.
    const decoded = JSON.parse(good) as { p: { c: string } };
    const original = decoded.p.c;
    const flippedChar = original.startsWith("A") ? "B" : "A";
    const tamperedCiphertext = JSON.stringify({
      ...(JSON.parse(good) as Record<string, unknown>),
      p: { ...decoded.p, c: `${flippedChar}${original.slice(1)}` },
    });

    for (const tampered of ["not json", "[]", good.replace('"v":1', '"v":2'), tamperedCiphertext]) {
      await inspector.set(key, tampered);
      expect((await harness.coordinator.begin(beginInput())).kind).toBe("unavailable");
    }
    await inspector.del(key);
  });

  it("refuses a ciphertext RELOCATED to a different storage key", async () => {
    const harness = await coordinatorHarness();
    const originalClientKey = `${IDEMPOTENCY_KEY_SENTINEL}-origin`;
    const relocatedClientKey = `${IDEMPOTENCY_KEY_SENTINEL}-target`;

    const owner = await harness.coordinator.begin(beginInput({ clientKey: originalClientKey }));
    if (owner.kind !== "owner") throw new Error("expected owner");
    await owner.session.markProcessing();
    await owner.session.commit({ kind: "text", content: ANSWER_SENTINEL });
    await owner.session.finish();

    const originalKey = buildStorageKey(
      KEYRING,
      NAMESPACE,
      "scope-redis-contract",
      originalClientKey,
    );
    const relocatedKey = buildStorageKey(
      KEYRING,
      NAMESPACE,
      "scope-redis-contract",
      relocatedClientKey,
    );
    expect(relocatedKey).not.toBe(originalKey);

    // Copy the committed ciphertext to the key a DIFFERENT client key resolves
    // to. The associated data binds the original storage key, so it must fail
    // authentication rather than replay another request's answer.
    const good = (await inspector.get(originalKey)) as string;
    expect(good).not.toBeNull();
    await inspector.set(relocatedKey, good);

    expect(
      (await harness.coordinator.begin(beginInput({ clientKey: relocatedClientKey }))).kind,
    ).toBe("unavailable");
    // The legitimate key still replays correctly.
    const legitimate = await harness.coordinator.begin(
      beginInput({ clientKey: originalClientKey }),
    );
    expect(legitimate.kind).toBe("existing");
    if (legitimate.kind === "existing") {
      expect(await legitimate.resolve()).toEqual({
        kind: "cached",
        cached: { ...IDENTITY, result: { kind: "text", content: ANSWER_SENTINEL } },
      });
    }
  });
});

describe("real Redis: readiness and availability", () => {
  it("reports not-ready before connect and after close, failing commands closed", async () => {
    const connection = openIdempotencyConnection(requireUrl());
    expect(connection.isReady()).toBe(false);
    // Commands fail closed while disconnected (the offline queue is disabled).
    expect(await connection.store.read(`${NAMESPACE}:before-connect`)).toEqual({
      kind: "unavailable",
    });

    connection.connect();
    await waitReady(connection);
    expect(connection.isReady()).toBe(true);
    expect(await connection.store.read(`${NAMESPACE}:absent`)).toEqual({ kind: "missing" });

    await connection.close();
    expect(connection.isReady()).toBe(false);
    expect(await connection.store.read(`${NAMESPACE}:after-close`)).toEqual({
      kind: "unavailable",
    });
    // Closing twice is safe.
    await connection.close();
  });

  it("never rejects or throws when the endpoint is unreachable", async () => {
    // Port 1 is reserved and refuses connections; the client must retry in the
    // background, stay not-ready, and never surface an unhandled error.
    const connection = openIdempotencyConnection("redis://127.0.0.1:1");
    expect(() => connection.connect()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connection.isReady()).toBe(false);
    expect(await connection.store.read(`${NAMESPACE}:unreachable`)).toEqual({
      kind: "unavailable",
    });
    await expect(connection.close()).resolves.toBeUndefined();
  });
});

describe("real Redis: the full HTTP route against a real Redis", () => {
  it("executes once, replays identically, and leaves only opaque bytes", async () => {
    // End to end through the REAL route, the REAL coordinator, and a REAL
    // Redis — the closest hermetic analogue of production, with a fake
    // completion service so no CollectivIQ call is made.
    const runtime = createRedisRuntime(appConfig());
    if (runtime === null || runtime.idempotency === null) {
      throw new Error("expected an idempotency coordinator");
    }
    runtime.connect();
    const deadline = Date.now() + 5_000;
    while (!runtime.isReady() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runtime.isReady()).toBe(true);

    let runs = 0;
    const app = buildServer({
      config: appConfig(),
      readiness: createReadinessState(true),
      completion: {
        chatService: {
          prepare: (ctx) => ({
            id: "chatcmpl_ciq_route_evidence",
            created: 1_700_000_000,
            model: ctx.request.model,
            prompt: "PROMPT",
            policy: ctx.model,
            selectedLlms: ctx.model.selectedLlms,
            keyId: ctx.keyId,
          }),
          run: async (_prepared, signal, hooks) => {
            runs += 1;
            await hooks?.onCapacityAcquired?.(signal);
            return {
              kind: "text",
              content: ANSWER_SENTINEL,
              upstreamThreadId: THREAD_SENTINEL,
              upstreamThreadCreated: true,
            };
          },
        },
        titleBridge: {
          register: () => undefined,
          lookup: () => Promise.resolve({ kind: "unavailable" }),
        },
        shutdownSignal: new AbortController().signal,
      },
      idempotency: runtime.idempotency,
    });

    try {
      const headers = {
        authorization: `Bearer ${GATEWAY_KEY_SENTINEL}`,
        "idempotency-key": IDEMPOTENCY_KEY_SENTINEL,
      };
      const payload = {
        model: "collectiviq-consensus",
        messages: [{ role: "user", content: PROMPT_SENTINEL }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: TOOL_ARG_SENTINEL,
              parameters: { type: "object" },
            },
          },
        ],
        tool_choice: "auto",
      };
      const url = "/v1/chat/completions";
      const first = await app.inject({ method: "POST", url, headers, payload });
      const second = await app.inject({ method: "POST", url, headers, payload });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Exactly one upstream completion, and a byte-identical replay.
      expect(runs).toBe(1);
      expect(second.json()).toEqual(first.json());
      expect(first.json<{ id: string }>().id).toBe("chatcmpl_ciq_route_evidence");

      // Exactly one record exists, and it carries only the documented opaque
      // fields with no sentinel anywhere in the key or the stored value.
      const keys = await suiteKeys();
      expect(keys).toHaveLength(1);
      const key = keys[0] as string;
      const raw = (await inspector.get(key)) as string;
      const record = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual(["e", "f", "o", "p", "s", "v"]);
      expect(record["s"]).toBe("final");
      for (const sentinel of [
        PROMPT_SENTINEL,
        ANSWER_SENTINEL,
        TOOL_ARG_SENTINEL,
        GATEWAY_KEY_SENTINEL,
        IDEMPOTENCY_KEY_SENTINEL,
        THREAD_SENTINEL,
        MASTER_KEY,
        "chatcmpl_ciq_route_evidence",
        "collectiviq-consensus",
      ]) {
        expect(key).not.toContain(sentinel);
        expect(raw).not.toContain(sentinel);
      }
    } finally {
      await app.close();
      await runtime.close();
    }
  });
});

describe("real Redis: stored bytes carry no sentinels", () => {
  it("stores only opaque keys and ciphertext for text and tool-call results", async () => {
    const harness = await coordinatorHarness();

    const textOwner = await harness.coordinator.begin(
      beginInput({ clientKey: IDEMPOTENCY_KEY_SENTINEL }),
    );
    if (textOwner.kind !== "owner") throw new Error("expected owner");
    await textOwner.session.markProcessing();
    await textOwner.session.commit({ kind: "text", content: ANSWER_SENTINEL });
    await textOwner.session.finish();

    const toolOwner = await harness.coordinator.begin(
      beginInput({ clientKey: `${IDEMPOTENCY_KEY_SENTINEL}-tools` }),
    );
    if (toolOwner.kind !== "owner") throw new Error("expected owner");
    await toolOwner.session.markProcessing();
    await toolOwner.session.commit({
      kind: "tool_calls",
      toolCalls: [
        { id: "call_ciq_01", name: "read", argumentsJson: `{"path":"${TOOL_ARG_SENTINEL}"}` },
      ],
    });
    await toolOwner.session.finish();

    const keys = await suiteKeys();
    expect(keys.length).toBeGreaterThanOrEqual(2);

    const sentinels = [
      PROMPT_SENTINEL,
      ANSWER_SENTINEL,
      TOOL_ARG_SENTINEL,
      GATEWAY_KEY_SENTINEL,
      IDEMPOTENCY_KEY_SENTINEL,
      MASTER_KEY,
      IDENTITY.id,
      IDENTITY.model,
      "collectiviq-consensus",
      "call_ciq_01",
    ];
    for (const key of keys) {
      const raw = (await inspector.get(key)) as string;
      for (const sentinel of sentinels) {
        expect(key).not.toContain(sentinel);
        expect(raw).not.toContain(sentinel);
      }
      // Only the documented opaque fields are present.
      expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["e", "f", "o", "p", "s", "v"]);
    }
  });
});
