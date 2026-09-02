/**
 * Command-level contract for the Redis-backed thread-reuse store (Phase 5A;
 * specification section 5.1.1).
 *
 * These tests drive the store over the shared Redis substrate with an INJECTED
 * fake client that records every command, so they assert what the gateway
 * actually puts on the wire — one script per mutation, the fixed `ARGV` layout,
 * the reply vocabulary, and the `EVALSHA → EVAL` fallback — without needing a
 * Redis. Lua SEMANTICS are proven separately against a real server by
 * `test/redis/thread-reuse-store.test.ts`.
 *
 * Everything here is synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  createRedisConnection,
  type MinimalRedisClient,
  type RedisSubstrate,
} from "../../src/redis/index.js";
import {
  createRedisThreadReuseStore,
  MAX_REUSE_RECORD_BYTES,
  REUSE_RECORD_VERSION,
  type ReuseTimings,
  type ThreadReuseStore,
} from "../../src/thread-reuse/index.js";

const KEY = "test-ns:reuse:AAAA";
const OWNER = "b3Jhbmdl";
const SEALED = { i: "AAAA", c: "BBBB", t: "CCCC" } as const;

const TIMINGS: ReuseTimings = {
  leaseMs: 30_000,
  processingLeaseMs: 120_000,
  mappingTtlMs: 604_800_000,
  ambiguousTtlMs: 900_000,
  committedTtlMs: 900_000,
};

interface FakeClient extends MinimalRedisClient {
  readonly commands: readonly (readonly string[])[];
  isReady: boolean;
}

interface Harness {
  readonly store: ThreadReuseStore;
  readonly substrate: RedisSubstrate;
  readonly client: FakeClient;
}

function harness(replies: readonly unknown[]): Harness {
  const commands: string[][] = [];
  const queue = [...replies];

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

  const connection = createRedisConnection({
    url: "redis://127.0.0.1:6379",
    createRedisClient: () => client,
  });
  return {
    store: createRedisThreadReuseStore(connection.substrate),
    substrate: connection.substrate,
    client,
  };
}

/** The `ARGV` of the last command, past `EVALSHA <sha> <numkeys> <key>`. */
function argsOf(client: FakeClient): readonly string[] {
  const last = client.commands.at(-1);
  if (last === undefined) throw new Error("no command was issued");
  return last.slice(4);
}

describe("redis thread-reuse store", () => {
  it("issues exactly one script per mutation with the fixed ARGV layout", async () => {
    const h = harness([["acquired", '{"v":1,"s":"reserved","o":"b3Jhbmdl","l":1}']]);
    await h.store.acquire(KEY, OWNER, TIMINGS);
    expect(h.client.commands).toHaveLength(1);
    const [command] = h.client.commands;
    expect(command?.[0]).toBe("EVALSHA");
    expect(command?.[2]).toBe("1");
    expect(command?.[3]).toBe(KEY);
    expect(argsOf(h.client)).toEqual([
      String(REUSE_RECORD_VERSION),
      String(MAX_REUSE_RECORD_BYTES),
      "30000",
      // BOTH leases and EVERY TTL ship on every call so the SCRIPT picks from
      // the state it is writing or reading, never the caller's stale view.
      "120000",
      "604800000",
      "900000",
      OWNER,
      "",
      "",
      "",
      "900000",
    ]);
  });

  it("ships the sealed thread only on `bind`", async () => {
    const h = harness([["ok"]]);
    await h.store.bind(KEY, OWNER, SEALED, TIMINGS);
    expect(argsOf(h.client).slice(7, 10)).toEqual([SEALED.i, SEALED.c, SEALED.t]);
  });

  it("uses a DISTINCT script for every operation", async () => {
    const shas = new Set<string>();
    for (const run of [
      (s: ThreadReuseStore) => s.acquire(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.bind(KEY, OWNER, SEALED, TIMINGS),
      (s: ThreadReuseStore) => s.markProcessing(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.renew(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.commit(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.activate(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.release(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.abandon(KEY, OWNER, TIMINGS),
      (s: ThreadReuseStore) => s.discardUnusable(KEY, OWNER, TIMINGS),
    ]) {
      const h = harness([["ok"]]);
      await run(h.store);
      shas.add(h.client.commands[0]?.[1] ?? "");
    }
    expect(shas.size).toBe(9);
  });

  it("retires an unusable mapping under the AMBIGUOUS TTL, not the mapping TTL", async () => {
    // MUTATION GUARD at the wire level: `discardUnusable` must be its own script
    // writing the short tombstone TTL. Routing it through `release` would reset
    // the seven-day sliding TTL on every retry and pin the session on a
    // permanent `503`.
    const h = harness([new Error("NOSCRIPT"), ["ok"]]);
    expect((await h.store.discardUnusable(KEY, OWNER, TIMINGS)).kind).toBe("ok");
    const body = h.client.commands[1]?.[1] ?? "";
    expect(body).toContain("buildRecord('ambiguous'");
    expect(body).toContain("writeRecord(next, 'ambiguous')");
    expect(body).toContain("if rec['s'] ~= 'reserved' then return {'state'} end");
    expect(body).toContain("if rec['o'] ~= OWNER then return {'lost'} end");
  });

  it("derives every record's Redis lifetime from the state being written", async () => {
    // MUTATION GUARD for the TTL policy. Writing `PX = MAPPING_TTL` everywhere
    // lets a leased record expire before its own lease when configuration sets a
    // mapping TTL shorter than the lease.
    const h = harness([new Error("NOSCRIPT"), ["ok"]]);
    await h.store.markProcessing(KEY, OWNER, TIMINGS);
    const body = h.client.commands[1]?.[1] ?? "";
    expect(body).toContain("local function ttlFor(state)");
    expect(body).toContain("local floor = lease + AMBIG_TTL");
    expect(body).toContain("writeRecord(next, 'processing')");
    // No script may hard-code the mapping TTL as a record's lifetime.
    expect(body).not.toContain("writeRecord(next, MAPPING_TTL)");
  });

  it("validates the whole record, state by state, before any mutation", async () => {
    // MUTATION GUARD for strict validation: a partial guard would let a corrupt
    // record be sanitized and rewritten into a structurally valid one.
    const h = harness([new Error("NOSCRIPT"), ["ok"]]);
    await h.store.commit(KEY, OWNER, TIMINGS);
    const body = h.client.commands[1]?.[1] ?? "";
    // Exact key sets, for the record and for the sealed payload.
    expect(body).toContain("if countKeys(rec) ~= expected then return nil, 'corrupt' end");
    expect(body).toContain("if countKeys(p) ~= 3 then return false end");
    // State-specific invariants.
    expect(body).toContain("elseif state == 'committed' or state == 'active' then");
    expect(body).toContain("elseif state == 'ambiguous' then");
    expect(body).toContain("if rec['l'] ~= 0 or hasPayload then return nil, 'corrupt' end");
    expect(body).toContain("if not leaseValueOk(rec['l']) then return nil, 'corrupt' end");
    // An unknown state is rejected outright rather than falling through: the
    // state chain ends in an `else` that returns corrupt.
    const stateChain = body.slice(body.indexOf("if state == 'reserved' then"));
    expect(stateChain.slice(0, stateChain.indexOf("return rec, nil"))).toMatch(
      /else\s+return nil, 'corrupt'\s+end/,
    );
    // Validation precedes every write.
    expect(body.indexOf("local function readRecord()")).toBeLessThan(
      body.indexOf("local rec, err = readRecord()"),
    );
  });

  it("splits the terminal transition into an idempotent commit and activate", async () => {
    const commit = harness([new Error("NOSCRIPT"), ["ok"]]);
    await commit.store.commit(KEY, OWNER, TIMINGS);
    const commitBody = commit.client.commands[1]?.[1] ?? "";
    // Idempotent for this owner, so a lost reply can still be acknowledged.
    expect(commitBody).toContain("if state == 'committed' then return {'ok'} end");
    expect(commitBody).toContain("buildRecord('committed'");
    expect(commitBody).toContain("writeRecord(next, 'committed')");

    const activate = harness([new Error("NOSCRIPT"), ["ok"]]);
    await activate.store.activate(KEY, OWNER, TIMINGS);
    const activateBody = activate.client.commands[1]?.[1] ?? "";
    expect(activateBody).toContain("if state == 'active' then return {'ok'} end");
    expect(activateBody).toContain("if state ~= 'committed' then return {'state'} end");
    expect(activateBody).toContain("writeRecord(next, 'active')");
    // A genuinely absent key is tombstoned in the SAME script, so no competing
    // acquire can slip into the gap and start a replacement thread.
    expect(activateBody).toContain("if err == 'missing' then");
    expect(activateBody).toContain("buildRecord('ambiguous', OWNER, 0, nil)");
    expect(activateBody).toContain("return {'missing'}");
    // Only absence is repaired; every other definitive outcome is reported.
    expect(activateBody).toContain("if err then return {err} end");
    expect(activateBody).toContain("if rec['o'] ~= OWNER then return {'lost'} end");

    // `committed` is never acquirable, and settlement can still retire it.
    const acquire = harness([new Error("NOSCRIPT"), ["busy"]]);
    await acquire.store.acquire(KEY, OWNER, TIMINGS);
    expect(acquire.client.commands[1]?.[1] ?? "").toContain(
      "if state == 'committed' then return {'blocked'} end",
    );
    const abandon = harness([new Error("NOSCRIPT"), ["ok"]]);
    await abandon.store.abandon(KEY, OWNER, TIMINGS);
    expect(abandon.client.commands[1]?.[1] ?? "").toContain(
      "if state ~= 'processing' and state ~= 'committed' then return {'state'} end",
    );
  });

  it("maps the acquire reply vocabulary", async () => {
    const raw = '{"v":1,"s":"reserved","o":"b3Jhbmdl","l":1}';
    const cases: [unknown, string][] = [
      [["acquired", raw], "acquired"],
      [["busy"], "busy"],
      [["blocked"], "blocked"],
      [["corrupt"], "corrupt"],
      [["missing"], "unavailable"],
      [["acquired"], "unavailable"],
      [["nonsense"], "unavailable"],
      [[], "unavailable"],
      [null, "unavailable"],
      ["not an array", "unavailable"],
    ];
    for (const [reply, expected] of cases) {
      const h = harness([reply]);
      const result = await h.store.acquire(KEY, OWNER, TIMINGS);
      expect(result.kind).toBe(expected);
      if (result.kind === "acquired") expect(result.raw).toBe(raw);
    }
  });

  it("maps the compare-and-transition reply vocabulary", async () => {
    const cases: [unknown, string][] = [
      [["ok"], "ok"],
      [["missing"], "missing"],
      [["lost"], "lost"],
      [["state"], "state"],
      [["corrupt"], "corrupt"],
      [["unexpected"], "unavailable"],
      [null, "unavailable"],
    ];
    for (const [reply, expected] of cases) {
      const h = harness([reply]);
      expect((await h.store.markProcessing(KEY, OWNER, TIMINGS)).kind).toBe(expected);
    }
  });

  it("reports the observed state from a renewal", async () => {
    for (const observed of ["reserved", "processing"] as const) {
      const h = harness([["ok", observed]]);
      const result = await h.store.renew(KEY, OWNER, TIMINGS);
      expect(result).toEqual({ kind: "ok", observedState: observed });
    }
    // An unrecognized state string is dropped rather than trusted.
    const h = harness([["ok", "active"]]);
    expect(await h.store.renew(KEY, OWNER, TIMINGS)).toEqual({ kind: "ok" });
  });

  it("reports whether a release restored or deleted the mapping", async () => {
    const restored = harness([["ok", "1"]]);
    expect(await restored.store.release(KEY, OWNER, TIMINGS)).toEqual({
      kind: "ok",
      restored: true,
    });
    const deleted = harness([["ok", "0"]]);
    expect(await deleted.store.release(KEY, OWNER, TIMINGS)).toEqual({
      kind: "ok",
      restored: false,
    });
    const failed = harness([["lost"]]);
    expect((await failed.store.release(KEY, OWNER, TIMINGS)).kind).toBe("lost");
  });

  it("falls back from EVALSHA to EVAL after a script flush", async () => {
    const h = harness([new Error("NOSCRIPT No matching script"), ["ok"]]);
    expect((await h.store.commit(KEY, OWNER, TIMINGS)).kind).toBe("ok");
    expect(h.client.commands).toHaveLength(2);
    expect(h.client.commands[0]?.[0]).toBe("EVALSHA");
    expect(h.client.commands[1]?.[0]).toBe("EVAL");
    // The retried command ships the script BODY with identical keys and args.
    expect(h.client.commands[1]?.[1]).toContain("redis.call('TIME')");
    expect(h.client.commands[1]?.slice(2)).toEqual(h.client.commands[0]?.slice(2));
  });

  it("fails closed when the connection is not ready and issues no command", async () => {
    const h = harness([["ok"]]);
    h.client.isReady = false;
    expect((await h.store.acquire(KEY, OWNER, TIMINGS)).kind).toBe("unavailable");
    expect((await h.store.abandon(KEY, OWNER, TIMINGS)).kind).toBe("unavailable");
    expect(h.client.commands).toHaveLength(0);
    expect(h.store.isReady()).toBe(false);
  });

  it("fails closed on a transport error without throwing", async () => {
    const h = harness([new Error("connection reset")]);
    expect((await h.store.renew(KEY, OWNER, TIMINGS)).kind).toBe("unavailable");
  });

  it("takes its clock from Redis and never from the process", async () => {
    // Every script must read `TIME` server-side: a Node clock would let a
    // skewed replica steal a live lease or extend its own.
    const h = harness([new Error("NOSCRIPT"), ["ok"]]);
    await h.store.acquire(KEY, OWNER, TIMINGS);
    const body = h.client.commands[1]?.[1] ?? "";
    expect(body).toContain("redis.call('TIME')");
    // The lease is stamped inside the record; `PX` carries the mapping TTL.
    expect(body).toContain("NOW_MS + leaseFor(");
    expect(body).toContain("'PX'");
    // The size guard precedes any GET.
    expect(body.indexOf("STRLEN")).toBeLessThan(body.indexOf("redis.call('GET'"));
  });
});
