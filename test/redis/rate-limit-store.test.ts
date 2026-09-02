/**
 * REAL-REDIS contract suite for the cross-replica rate limiter (Phase 4B;
 * specification sections 19.1, 29.7).
 *
 * The hermetic suites prove the command SHAPE and the GCRA arithmetic; only a
 * live server can prove the properties that make the quota shared: that the
 * decision is atomic, that Redis's own clock drives it, that two independent
 * gateway instances enforce ONE budget, and that the script survives a
 * `SCRIPT FLUSH`.
 *
 * Safety: every value here is synthetic (no real credential, prompt, answer, or
 * account data), the Redis key namespace is randomized per run, and every key
 * the suite creates is deleted in teardown.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import { createRedisIdempotencyStore } from "../../src/idempotency/redis-store.js";
import {
  buildRateLimitKey,
  createRedisRateLimiter,
  deriveRateLimitKeyring,
  deriveRateLimitScope,
  MAX_TAT_VALUE_BYTES,
  type RateLimiter,
} from "../../src/rate-limit/index.js";
import { createRedisConnection, type RedisConnection } from "../../src/redis/index.js";
import { createRedisRuntime } from "../../src/redis/runtime.js";

const REDIS_URL = process.env["REDIS_TEST_URL"];

// Synthetic sentinels that must NEVER appear in Redis in plaintext.
const GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL-r8s9t0";
const OTHER_GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL-u1v2w3";
const PROMPT_SENTINEL = "PROMPT-SENTINEL-x4y5z6";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveRateLimitKeyring(MASTER_KEY);
/** Randomized per run so parallel runs and leftovers can never interfere. */
const NAMESPACE = `ciqrl-${randomBytes(6).toString("hex")}`;

const SCOPE_A = deriveRateLimitScope(KEYRING, GATEWAY_KEY_SENTINEL);
const SCOPE_B = deriveRateLimitScope(KEYRING, OTHER_GATEWAY_KEY_SENTINEL);

/** A raw client used only to inspect and clean up, never by the code under test. */
let inspector: ReturnType<typeof createClient>;
const connections: RedisConnection[] = [];

function requireUrl(): string {
  if (REDIS_URL === undefined || REDIS_URL.trim() === "") {
    throw new Error(
      "REDIS_TEST_URL is not set. The real-Redis rate-limit suite requires a running Redis " +
        "(see compose.yaml `redis` profile) and must not be skipped silently.",
    );
  }
  return REDIS_URL;
}

const MODEL: VirtualModel = {
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
};

/** Synthetic application configuration wired to the real test Redis. */
function appConfig(over: Partial<AppConfig> = {}): AppConfig {
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
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: NAMESPACE,
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: false,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    models: [MODEL],
    ...over,
  };
}

async function waitReady(connection: RedisConnection, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (connection.isReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Redis did not become ready within the test deadline");
}

/** A connected connection registered for teardown. */
async function connected(url = requireUrl()): Promise<RedisConnection> {
  const connection = createRedisConnection({ url });
  connections.push(connection);
  connection.connect();
  await waitReady(connection);
  return connection;
}

interface LimiterOptions {
  readonly requests?: number;
  readonly windowMs?: number;
  readonly burst?: number;
}

/** An independent gateway instance's limiter over its OWN connection. */
async function instance(options: LimiterOptions = {}): Promise<RateLimiter> {
  const connection = await connected();
  return createRedisRateLimiter({
    substrate: connection.substrate,
    keyring: KEYRING,
    namespace: NAMESPACE,
    requests: options.requests ?? 60,
    windowMs: options.windowMs ?? 60_000,
    burst: options.burst ?? 8,
  });
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

/** How many of `attempts` sequential consumptions were admitted. */
async function admit(limiter: RateLimiter, scope: string, attempts: number): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < attempts; i += 1) {
    const decision = await limiter.consume(scope);
    if (decision.kind === "allowed") allowed += 1;
  }
  return allowed;
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

describe("real Redis: exact burst and refill", () => {
  it("admits exactly the burst from a cold scope and then rejects", async () => {
    const limiter = await instance({ requests: 60, windowMs: 60_000, burst: 8 });
    expect(await admit(limiter, SCOPE_A, 8)).toBe(8);

    const rejected = await limiter.consume(SCOPE_A);
    expect(rejected.kind).toBe("limited");
    if (rejected.kind === "limited") {
      // One emission interval is one second at 60/minute.
      expect(rejected.retryAfterSeconds).toBe(1);
    }
  });

  it("refills against Redis's own clock, one slot per interval", async () => {
    // A 200 ms interval keeps this fast while still being wall-clock real.
    const limiter = await instance({ requests: 5, windowMs: 1_000, burst: 2 });
    expect(await admit(limiter, SCOPE_A, 2)).toBe(2);
    expect((await limiter.consume(SCOPE_A)).kind).toBe("limited");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");
    expect((await limiter.consume(SCOPE_A)).kind).toBe("limited");
  });

  it("never banks more than the burst however long the scope idles", async () => {
    const limiter = await instance({ requests: 5, windowMs: 1_000, burst: 2 });
    await admit(limiter, SCOPE_A, 2);
    await new Promise((resolve) => setTimeout(resolve, 800));
    // 800 ms is four intervals of idling, but the ceiling is still the burst.
    expect(await admit(limiter, SCOPE_A, 5)).toBe(2);
  });

  it("does not advance the stored timestamp on a rejection", async () => {
    const limiter = await instance({ requests: 5, windowMs: 1_000, burst: 1 });
    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");
    const key = buildRateLimitKey(KEYRING, NAMESPACE, SCOPE_A);
    const afterAllow = await inspector.get(key);

    for (let i = 0; i < 5; i += 1) {
      expect((await limiter.consume(SCOPE_A)).kind).toBe("limited");
    }
    // Five rejections must not push recovery out at all.
    expect(await inspector.get(key)).toBe(afterAllow);
  });
});

describe("real Redis: one quota across independent instances", () => {
  it("lets two separate gateway instances share ONE budget", async () => {
    // Two connections, two limiter objects — the analogue of two replicas.
    const first = await instance({ requests: 60, windowMs: 60_000, burst: 8 });
    const second = await instance({ requests: 60, windowMs: 60_000, burst: 8 });

    const admittedByFirst = await admit(first, SCOPE_A, 5);
    const admittedBySecond = await admit(second, SCOPE_A, 5);

    expect(admittedByFirst).toBe(5);
    // MUTATION GUARD: a process-local limiter would admit all five here too.
    expect(admittedBySecond).toBe(3);
    expect(admittedByFirst + admittedBySecond).toBe(8);
  });

  it("serializes a concurrent race so the combined total is exactly the burst", async () => {
    const first = await instance({ requests: 60, windowMs: 60_000, burst: 8 });
    const second = await instance({ requests: 60, windowMs: 60_000, burst: 8 });

    const decisions = await Promise.all(
      Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? first : second).consume(SCOPE_A)),
    );
    // Atomicity: no interleaving can over-admit, whatever the arrival order.
    expect(decisions.filter((d) => d.kind === "allowed")).toHaveLength(8);
    expect(decisions.filter((d) => d.kind === "limited")).toHaveLength(16);
  });

  it("isolates separate gateway keys", async () => {
    const limiter = await instance({ requests: 60, windowMs: 60_000, burst: 2 });
    expect(await admit(limiter, SCOPE_A, 2)).toBe(2);
    expect((await limiter.consume(SCOPE_A)).kind).toBe("limited");
    // A different key's quota is untouched.
    expect(await admit(limiter, SCOPE_B, 2)).toBe(2);
    expect((await limiter.consume(SCOPE_B)).kind).toBe("limited");
  });
});

describe("real Redis: stored state", () => {
  it("stores one bounded integer under the namespaced `rate` key with a TTL", async () => {
    const limiter = await instance({ requests: 60, windowMs: 60_000, burst: 8 });
    await limiter.consume(SCOPE_A);

    const keys = await suiteKeys();
    expect(keys).toEqual([buildRateLimitKey(KEYRING, NAMESPACE, SCOPE_A)]);
    const key = keys[0] as string;
    expect(key.startsWith(`${NAMESPACE}:rate:`)).toBe(true);

    const raw = (await inspector.get(key)) as string;
    expect(raw).toMatch(/^\d+$/);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MAX_TAT_VALUE_BYTES);

    // Redis owns the expiry: the record can never outlive its own debt.
    const ttl = await inspector.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_000);
  });

  it("expires the record once the allowance has fully replenished", async () => {
    const limiter = await instance({ requests: 10, windowMs: 1_000, burst: 1 });
    await limiter.consume(SCOPE_A);
    const key = buildRateLimitKey(KEYRING, NAMESPACE, SCOPE_A);
    expect(await inspector.exists(key)).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    // A fully replenished scope leaves nothing behind, so an idle key costs no
    // memory and a cold scope behaves identically to an expired one.
    expect(await inspector.exists(key)).toBe(0);
    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");
  });

  it("uses the Redis clock, not the caller's", async () => {
    const limiter = await instance({ requests: 60, windowMs: 60_000, burst: 8 });
    await limiter.consume(SCOPE_A);
    const stored = Number(await inspector.get(buildRateLimitKey(KEYRING, NAMESPACE, SCOPE_A)));
    const [seconds, micros] = (await inspector.time()) as unknown as [number, number];
    const redisNowUs = Number(seconds) * 1_000_000 + Number(micros);
    // The stored TAT is one interval ahead of REDIS time, within a wide margin.
    expect(stored - redisNowUs).toBeGreaterThan(0);
    expect(stored - redisNowUs).toBeLessThanOrEqual(1_000_000);
  });

  it("holds no credential, identity, or content sentinel", async () => {
    const limiter = await instance();
    await limiter.consume(SCOPE_A);
    await limiter.consume(SCOPE_B);

    const keys = await suiteKeys();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      const raw = (await inspector.get(key)) as string;
      for (const sentinel of [
        GATEWAY_KEY_SENTINEL,
        OTHER_GATEWAY_KEY_SENTINEL,
        PROMPT_SENTINEL,
        MASTER_KEY,
        SCOPE_A,
        SCOPE_B,
        "k0",
        "collectiviq-consensus",
      ]) {
        expect(key).not.toContain(sentinel);
        expect(raw).not.toContain(sentinel);
      }
      // The value is only a number; there is nothing else it could carry.
      expect(raw).toMatch(/^\d+$/);
    }
  });
});

describe("real Redis: corrupt and hostile state fails CLOSED", () => {
  it("rejects a non-numeric, negative, or empty value without resetting it", async () => {
    const limiter = await instance();
    const key = buildRateLimitKey(KEYRING, NAMESPACE, SCOPE_A);

    for (const value of ["", "not-a-number", "-1", "1.5", " 12", "1e9", "12abc"]) {
      await inspector.set(key, value);
      // Never `allowed`: an unreadable quota is not an empty quota.
      expect(await limiter.consume(SCOPE_A)).toEqual({ kind: "unavailable" });
      // The corrupt value is classified, never destroyed or silently repaired.
      expect(await inspector.get(key)).toBe(value);
    }
  });

  it("rejects an OVERSIZED value without materializing it", async () => {
    const limiter = await instance();
    const key = buildRateLimitKey(KEYRING, NAMESPACE, SCOPE_A);
    await inspector.set(key, "9".repeat(MAX_TAT_VALUE_BYTES + 1));

    const before = await inspector.info("commandstats");
    expect(await limiter.consume(SCOPE_A)).toEqual({ kind: "unavailable" });
    const after = await inspector.info("commandstats");

    // The script returned on STRLEN, before its own GET: the server's own
    // counters show no additional GET was executed at all.
    const getCalls = (info: string): number => {
      const match = /cmdstat_get:calls=(\d+)/.exec(info);
      return match === null ? 0 : Number(match[1]);
    };
    expect(getCalls(after)).toBe(getCalls(before));

    // Paired positive control, so the counter assertion cannot pass vacuously:
    // a within-bound value DOES register a GET.
    await inspector.set(key, "1");
    const beforeValid = await inspector.info("commandstats");
    await limiter.consume(SCOPE_A);
    const afterValid = await inspector.info("commandstats");
    expect(getCalls(afterValid)).toBeGreaterThan(getCalls(beforeValid));
  });

  it("survives a SCRIPT FLUSH by re-shipping the body once", async () => {
    const limiter = await instance({ requests: 60, windowMs: 60_000, burst: 8 });
    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");

    await inspector.scriptFlush();

    // EVALSHA now fails with NOSCRIPT; the fallback must recover transparently
    // AND preserve the already-spent state rather than resetting the quota.
    expect(await admit(limiter, SCOPE_A, 7)).toBe(7);
    expect((await limiter.consume(SCOPE_A)).kind).toBe("limited");
  });
});

describe("real Redis: connection lifecycle", () => {
  it("reports not-ready before connect and after close, failing decisions closed", async () => {
    const connection = createRedisConnection({ url: requireUrl() });
    connections.push(connection);
    const limiter = createRedisRateLimiter({
      substrate: connection.substrate,
      keyring: KEYRING,
      namespace: NAMESPACE,
      requests: 60,
      windowMs: 60_000,
      burst: 8,
    });

    expect(limiter.isReady()).toBe(false);
    expect(await limiter.consume(SCOPE_A)).toEqual({ kind: "unavailable" });

    connection.connect();
    await waitReady(connection);
    expect(limiter.isReady()).toBe(true);
    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");

    await connection.close();
    expect(limiter.isReady()).toBe(false);
    expect(await limiter.consume(SCOPE_A)).toEqual({ kind: "unavailable" });
  });

  it("never throws when the endpoint is unreachable", async () => {
    // Port 1 is reserved and refuses connections; the client must retry in the
    // background, stay not-ready, and never surface an unhandled error.
    const connection = createRedisConnection({ url: "redis://127.0.0.1:1" });
    connections.push(connection);
    const limiter = createRedisRateLimiter({
      substrate: connection.substrate,
      keyring: KEYRING,
      namespace: NAMESPACE,
      requests: 60,
      windowMs: 60_000,
      burst: 8,
    });
    expect(() => connection.connect()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await limiter.consume(SCOPE_A)).toEqual({ kind: "unavailable" });
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("honours caller cancellation without admitting the request", async () => {
    const limiter = await instance();
    const controller = new AbortController();
    controller.abort();
    expect(await limiter.consume(SCOPE_A, controller.signal)).toEqual({ kind: "cancelled" });
    // Nothing was charged, so a cancelled attempt costs the client no quota.
    expect(await suiteKeys()).toEqual([]);
  });
});

describe("real Redis: ONE connection backs both features", () => {
  it("drives idempotency and rate limiting over a single shared client", async () => {
    const connection = await connected();
    const store = createRedisIdempotencyStore(connection.substrate);
    const limiter = createRedisRateLimiter({
      substrate: connection.substrate,
      keyring: KEYRING,
      namespace: NAMESPACE,
      requests: 60,
      windowMs: 60_000,
      burst: 8,
    });

    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");
    const idempotencyKey = `${NAMESPACE}:idem:shared-connection`;
    const record = JSON.stringify({
      v: 1,
      s: "reserved",
      f: "ZmluZ2VycHJpbnQ",
      o: "owner-shared",
      e: Date.now() + 30_000,
    });
    expect(await store.claim(idempotencyKey, record, 30_000)).toEqual({ kind: "claimed" });
    expect((await limiter.consume(SCOPE_A)).kind).toBe("allowed");
    expect((await store.read(idempotencyKey)).kind).toBe("found");

    // Both categories coexist under one namespace without colliding.
    const keys = (await suiteKeys()).sort();
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.includes(":rate:"))).toBe(true);
    expect(keys.some((key) => key.includes(":idem:"))).toBe(true);

    // Closing the ONE connection degrades both, exactly as readiness reports.
    await connection.close();
    expect(await limiter.consume(SCOPE_A)).toEqual({ kind: "unavailable" });
    expect(await store.read(idempotencyKey)).toEqual({ kind: "unavailable" });
  });

  it("composes both features from configuration over one connection", async () => {
    const runtime = createRedisRuntime(appConfig());
    if (runtime === null || runtime.rateLimiter === null || runtime.idempotency === null) {
      throw new Error("expected both Redis-backed services");
    }
    runtime.connect();
    const deadline = Date.now() + 5_000;
    while (!runtime.isReady() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runtime.isReady()).toBe(true);

    try {
      // One readiness view, and both features actually reach the same server.
      expect(runtime.idempotency.isAvailable()).toBe(true);
      expect(runtime.rateLimiter.isReady()).toBe(true);
      expect((await runtime.rateLimiter.consume(SCOPE_A)).kind).toBe("allowed");

      const begun = await runtime.idempotency.begin({
        clientKey: "idem-composed-runtime",
        gatewayKeyScope: "scope-composed-runtime",
        bodyFingerprint: "ZmluZ2VycHJpbnQtY29tcG9zZWQ",
        identity: { id: "chatcmpl_ciq_composed", created: 1_700_000_000, model: MODEL.id },
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      });
      expect(begun.kind).toBe("owner");

      // Both categories were written through the SAME connection, under one
      // namespace, without colliding. Checked while the claim is still held:
      // finishing an unpromoted `reserved` claim releases it (spec §18.1).
      const keys = await suiteKeys();
      expect(keys.some((key) => key.includes(":rate:"))).toBe(true);
      expect(keys.some((key) => key.includes(":idem:"))).toBe(true);

      if (begun.kind === "owner") await begun.session.finish();
    } finally {
      await runtime.close();
      expect(runtime.isReady()).toBe(false);
      // Closing once degrades every feature that shared it.
      expect(runtime.rateLimiter.isReady()).toBe(false);
      expect(runtime.idempotency.isAvailable()).toBe(false);
    }
  });
});
