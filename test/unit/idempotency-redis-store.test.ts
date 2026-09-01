/**
 * Command-level contract for the Redis idempotency store (Phase 4A).
 *
 * These tests drive `createRedisIdempotencyConnection` through an INJECTED fake
 * client that records every command, so they assert what the gateway actually
 * puts on the wire without needing a Redis. Lua SEMANTICS are proven separately
 * against a real server by `test/redis/`; what matters here is the command
 * SHAPE — in particular that the record-read path is bounded server side and
 * never issues a direct unbounded `GET`.
 */
import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES, RESERVED_LEASE_MS } from "../../src/idempotency/limits.js";
import { RECORD_VERSION } from "../../src/idempotency/records.js";
import {
  createRedisIdempotencyConnection,
  type MinimalRedisClient,
  type RedisClientConfig,
} from "../../src/idempotency/redis-store.js";

const KEY = "ns:idem:AAAA";
const OWNER = "b3duZXItdG9rZW4";

interface FakeClient extends MinimalRedisClient {
  readonly commands: readonly (readonly string[])[];
}

/**
 * Build a connection over a fake client that answers each command from a queue
 * of scripted replies. An exhausted queue is a test bug, so it throws.
 */
function harness(replies: readonly unknown[]): {
  readonly store: ReturnType<typeof createRedisIdempotencyConnection>["store"];
  readonly client: FakeClient;
  readonly config: RedisClientConfig;
} {
  const commands: string[][] = [];
  const queue = [...replies];
  let captured: RedisClientConfig | undefined;

  const client: FakeClient = {
    commands,
    isReady: true,
    connect: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
    destroy: () => undefined,
    on: () => undefined,
    sendCommand: (args: readonly string[]) => {
      commands.push([...args]);
      if (queue.length === 0) throw new Error("fake client: no scripted reply left");
      const reply = queue.shift();
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };

  const connection = createRedisIdempotencyConnection({
    url: "redis://127.0.0.1:6379",
    createRedisClient: (config) => {
      captured = config;
      return client;
    },
  });
  return { store: connection.store, client, config: captured as RedisClientConfig };
}

/** Every distinct command verb the fake observed. */
function verbs(client: FakeClient): string[] {
  return client.commands.map((command) => command[0] as string);
}

describe("redis store: bounded record reads", () => {
  it("reads through a script and NEVER issues a direct GET", async () => {
    const h = harness([["found", '{"v":1,"s":"reserved","f":"a","o":"b","e":1}']]);
    const result = await h.store.read(KEY);

    expect(result).toEqual({
      kind: "found",
      raw: '{"v":1,"s":"reserved","f":"a","o":"b","e":1}',
    });
    // Exactly one command, and it is a script evaluation — not a GET.
    expect(h.client.commands).toHaveLength(1);
    expect(verbs(h.client)).toEqual(["EVALSHA"]);
    expect(verbs(h.client)).not.toContain("GET");
    // ... EVALSHA <sha> 1 <key> <maxBytes>
    const [command] = h.client.commands;
    expect(command?.[2]).toBe("1");
    expect(command?.[3]).toBe(KEY);
    expect(command?.[4]).toBe(String(MAX_RECORD_BYTES));
  });

  it("classifies an oversized value as corrupt WITHOUT its bytes crossing the boundary", async () => {
    // The script returns before its GET, so the reply carries no value at all.
    const h = harness([["corrupt"]]);
    const result = await h.store.read(KEY);
    // Nothing but the bounded envelope came back; no oversized payload exists
    // anywhere in this process.
    expect(result).toEqual({ kind: "corrupt" });
    expect(verbs(h.client)).not.toContain("GET");
  });

  it("classifies a missing record", async () => {
    const h = harness([["missing"]]);
    expect(await h.store.read(KEY)).toEqual({ kind: "missing" });
    expect(verbs(h.client)).not.toContain("GET");
  });

  it("fails closed on an unrecognized reply shape", async () => {
    for (const reply of [["found"], ["weird"], [], "not-an-array", null]) {
      const h = harness([reply]);
      expect(await h.store.read(KEY)).toEqual({ kind: "unavailable" });
    }
  });

  it("falls back to EVAL on NOSCRIPT, shipping a script that bounds before reading", async () => {
    const noScript = new Error("NOSCRIPT No matching script.");
    const h = harness([noScript, ["missing"]]);
    expect(await h.store.read(KEY)).toEqual({ kind: "missing" });

    expect(verbs(h.client)).toEqual(["EVALSHA", "EVAL"]);
    const body = h.client.commands[1]?.[1] as string;
    // The shipped script checks the size before it ever reads the value.
    expect(body).toContain("STRLEN");
    expect(body.indexOf("STRLEN")).toBeLessThan(body.indexOf("GET"));
    expect(body).not.toContain("DEL"); // an oversized record is never destroyed
  });

  it("reports unavailable rather than reading while disconnected", async () => {
    const h = harness([]);
    (h.client as { isReady: boolean }).isReady = false;
    expect(await h.store.read(KEY)).toEqual({ kind: "unavailable" });
    expect(h.client.commands).toHaveLength(0);
  });
});

describe("redis store: renewal never trusts caller-local state", () => {
  it("ships BOTH lease durations so the script selects one from the record", async () => {
    const h = harness([["ok", "processing"]]);
    const result = await h.store.renew(KEY, OWNER, { reserved: 30_000, processing: 120_000 });

    // The applied lease is reported from the STORED state, not assumed.
    expect(result).toEqual({ kind: "ok", observedState: "processing" });

    const args = (h.client.commands[0] ?? []).slice(4);
    // owner, reservedLease, maxBytes, recordVersion, processingLease
    expect(args).toEqual([
      OWNER,
      "30000",
      String(MAX_RECORD_BYTES),
      String(RECORD_VERSION),
      "120000",
    ]);
    // Both leases are present, so no single caller-chosen duration exists.
    expect(args).toContain("30000");
    expect(args).toContain("120000");
  });

  it("reports the reserved lease when the record is still reserved", async () => {
    const h = harness([["ok", "reserved"]]);
    expect(
      await h.store.renew(KEY, OWNER, { reserved: RESERVED_LEASE_MS, processing: 120_000 }),
    ).toEqual({ kind: "ok", observedState: "reserved" });
  });

  it("omits the observed state when the reply does not carry a usable one", async () => {
    const h = harness([["ok", "final"]]);
    expect(await h.store.renew(KEY, OWNER, { reserved: 1, processing: 2 })).toEqual({ kind: "ok" });
  });

  it("maps every non-ok renewal tag without inventing a lease", async () => {
    for (const [tag, expected] of [
      ["missing", "missing"],
      ["lost", "lost"],
      ["state", "state"],
      ["corrupt", "corrupt"],
      ["nonsense", "unavailable"],
    ] as const) {
      const h = harness([[tag]]);
      expect(await h.store.renew(KEY, OWNER, { reserved: 1, processing: 2 })).toEqual({
        kind: expected,
      });
    }
  });
});

describe("redis store: script argument order", () => {
  // `GUARD_PRELUDE` consumes ARGV[1]/[3]/[4], and the remaining slots mean
  // DIFFERENT things per script (ARGV[2] is a lease for `renew` but an expected
  // state for `transition`/`release`; ARGV[5] is a lease for `renew` but a TTL
  // for `transition`). Pinning each layout keeps a future prelude edit from
  // silently shifting one script's arguments under another's meaning.
  it("pins the transition argument layout", async () => {
    const h = harness([["ok"]]);
    await h.store.transition(KEY, OWNER, "reserved", "{next}", 4_242);
    expect((h.client.commands[0] ?? []).slice(4)).toEqual([
      OWNER,
      "reserved",
      String(MAX_RECORD_BYTES),
      String(RECORD_VERSION),
      "4242",
      "{next}",
    ]);
  });

  it("pins the release argument layout", async () => {
    const h = harness([["ok"]]);
    await h.store.release(KEY, OWNER, "processing");
    expect((h.client.commands[0] ?? []).slice(4)).toEqual([
      OWNER,
      "processing",
      String(MAX_RECORD_BYTES),
      String(RECORD_VERSION),
    ]);
  });

  it("pins the claim argument layout", async () => {
    const h = harness([["claimed"]]);
    await h.store.claim(KEY, "{record}", 1_234);
    expect((h.client.commands[0] ?? []).slice(4)).toEqual([
      "{record}",
      "1234",
      String(MAX_RECORD_BYTES),
    ]);
  });

  it("uses a distinct cached script per operation", async () => {
    // A shared SHA would mean two operations executing the same body.
    const shas = new Set<string>();
    for (const run of [
      async (s: ReturnType<typeof harness>["store"]) => s.read(KEY),
      async (s: ReturnType<typeof harness>["store"]) => s.claim(KEY, "{}", 1),
      async (s: ReturnType<typeof harness>["store"]) =>
        s.renew(KEY, OWNER, { reserved: 1, processing: 2 }),
      async (s: ReturnType<typeof harness>["store"]) => s.release(KEY, OWNER, "reserved"),
      async (s: ReturnType<typeof harness>["store"]) =>
        s.transition(KEY, OWNER, "reserved", "{}", 1),
    ]) {
      const h = harness([["missing"]]);
      await run(h.store);
      shas.add(h.client.commands[0]?.[1] as string);
    }
    expect(shas.size).toBe(5);
  });
});

describe("redis store: client configuration", () => {
  it("pins the protocol, disables the offline queue, and bounds connect/reconnect", () => {
    const h = harness([]);
    expect(h.config.RESP).toBe(2);
    expect(h.config.disableOfflineQueue).toBe(true);
    expect(h.config.socket.connectTimeout).toBeGreaterThan(0);
    // Reconnect backoff is bounded, so a long outage never stalls recovery.
    const delays = [0, 1, 5, 50, 5_000].map((n) => h.config.socket.reconnectStrategy(n));
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
    expect(Math.min(...delays)).toBeGreaterThan(0);
  });
});
