/**
 * Command-level contract for the Redis-backed GCRA limiter (Phase 4B;
 * specification section 19.1).
 *
 * These tests drive the limiter over the shared Redis substrate with an
 * INJECTED fake client that records every command, so they assert what the
 * gateway actually puts on the wire — the script's shape, its arguments, and
 * the reply vocabulary — without needing a Redis. Lua SEMANTICS are proven
 * separately against a real server by `test/redis/`.
 *
 * Everything here is synthetic.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRedisRateLimiter,
  deriveRateLimitKeyring,
  deriveRateLimitScope,
  MAX_TAT_VALUE_BYTES,
  type RateLimiter,
} from "../../src/rate-limit/index.js";
import {
  createRedisConnection,
  type MinimalRedisClient,
  type RedisSubstrate,
} from "../../src/redis/index.js";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveRateLimitKeyring(MASTER_KEY);
const NAMESPACE = "test-ns";
const SCOPE = deriveRateLimitScope(KEYRING, "gw-fake-key-alpha");

interface FakeClient extends MinimalRedisClient {
  readonly commands: readonly (readonly string[])[];
  isReady: boolean;
}

interface Harness {
  readonly limiter: RateLimiter;
  readonly substrate: RedisSubstrate;
  readonly client: FakeClient;
}

/**
 * Build the limiter over a fake client that answers each command from a queue
 * of scripted replies. An exhausted queue is a test bug, so it throws.
 */
function harness(
  replies: readonly unknown[],
  options: { requests?: number; windowMs?: number; burst?: number } = {},
): Harness {
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
    limiter: createRedisRateLimiter({
      substrate: connection.substrate,
      keyring: KEYRING,
      namespace: NAMESPACE,
      requests: options.requests ?? 60,
      windowMs: options.windowMs ?? 60_000,
      burst: options.burst ?? 8,
    }),
    substrate: connection.substrate,
    client,
  };
}

/** The Lua body the fake observed on an `EVAL` fallback. */
function evaluatedBody(client: FakeClient): string {
  const evalCommand = client.commands.find((command) => command[0] === "EVAL");
  if (evalCommand === undefined) throw new Error("no EVAL command was issued");
  return evalCommand[1] as string;
}

describe("rate limiter: command shape", () => {
  it("makes exactly ONE atomic script call per decision", async () => {
    const h = harness([["allowed"]]);
    expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "allowed" });

    expect(h.client.commands).toHaveLength(1);
    expect(h.client.commands[0]?.[0]).toBe("EVALSHA");
    // MUTATION GUARD: a read-then-write implementation would issue a GET (or a
    // SET) as a separate client command and lose atomicity across replicas.
    const verbs = h.client.commands.map((command) => command[0]);
    expect(verbs).not.toContain("GET");
    expect(verbs).not.toContain("SET");
    expect(verbs).not.toContain("INCR");
    expect(verbs).not.toContain("TIME");
  });

  it("ships one key and the derived GCRA parameters", async () => {
    const h = harness([["allowed"]]);
    await h.limiter.consume(SCOPE);

    // EVALSHA <sha> 1 <key> <maxBytes> <intervalUs> <toleranceUs>
    const [command] = h.client.commands;
    expect(command?.[2]).toBe("1");
    expect(command?.[3]).toBe(`${NAMESPACE}:rate:${(command?.[3] as string).split(":rate:")[1]}`);
    expect(command?.[3]).toMatch(new RegExp(`^${NAMESPACE}:rate:[A-Za-z0-9_-]+$`));
    expect(command?.slice(4)).toEqual([String(MAX_TAT_VALUE_BYTES), "1000000", "7000000"]);
  });

  it("derives the parameters from configuration, not from a hard-coded default", async () => {
    const h = harness([["allowed"]], { requests: 120, windowMs: 60_000, burst: 3 });
    await h.limiter.consume(SCOPE);
    expect(h.client.commands[0]?.slice(5)).toEqual(["500000", "1000000"]);
  });

  it("never puts the gateway scope or any raw material in the command", async () => {
    const h = harness([["allowed"]]);
    await h.limiter.consume(SCOPE);
    const flat = (h.client.commands[0] ?? []).join(" ");
    expect(flat).not.toContain(SCOPE);
    expect(flat).not.toContain(MASTER_KEY);
    expect(flat).not.toContain("gw-fake-key-alpha");
  });

  it("falls back to EVAL on NOSCRIPT and re-decides once", async () => {
    const h = harness([new Error("NOSCRIPT No matching script."), ["allowed"]]);
    expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "allowed" });
    expect(h.client.commands.map((command) => command[0])).toEqual(["EVALSHA", "EVAL"]);
  });
});

describe("rate limiter: the shipped script", () => {
  it("reads Redis TIME rather than a process clock", async () => {
    const h = harness([new Error("NOSCRIPT nope"), ["allowed"]]);
    await h.limiter.consume(SCOPE);
    const body = evaluatedBody(h.client);
    // MUTATION GUARD: replacing Redis TIME with a Node clock (passing `now` in
    // as an argument) would remove this call and silently make the shared quota
    // depend on each replica's own clock.
    expect(body).toContain("redis.call('TIME')");
  });

  it("bounds the stored value with STRLEN BEFORE any internal GET", async () => {
    const h = harness([new Error("NOSCRIPT nope"), ["allowed"]]);
    await h.limiter.consume(SCOPE);
    const body = evaluatedBody(h.client);
    // MUTATION GUARD: an unbounded read would materialize a hostile
    // multi-megabyte value inside the script before rejecting it.
    expect(body).toContain("STRLEN");
    expect(body.indexOf("STRLEN")).toBeLessThan(body.indexOf("GET"));
    // Corrupt state is classified, never destroyed or reset.
    expect(body).not.toContain("DEL");
    expect(body).not.toContain("FLUSH");
  });

  it("writes the new timestamp only with a bounded expiry", async () => {
    const h = harness([new Error("NOSCRIPT nope"), ["allowed"]]);
    await h.limiter.consume(SCOPE);
    const body = evaluatedBody(h.client);
    // Every SET carries PX, so a quota key can never be written without a TTL.
    const sets = body.split("\n").filter((line) => line.includes("redis.call('SET'"));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toContain("'PX'");
  });

  it("validates the stored value strictly before trusting it", async () => {
    const h = harness([new Error("NOSCRIPT nope"), ["allowed"]]);
    await h.limiter.consume(SCOPE);
    const body = evaluatedBody(h.client);
    // A digits-only match plus a negativity guard: no `tonumber` shortcut that
    // would accept "1e400", " 12", or "-1".
    expect(body).toContain("string.match(raw, '^%d+$')");
    expect(body).toContain("stored < 0");
  });
});

describe("rate limiter: decision mapping", () => {
  it("maps a rejection to a bounded positive Retry-After", async () => {
    const h = harness([["limited", 2_500_000]]);
    expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "limited", retryAfterSeconds: 3 });
  });

  it("clamps an absurd rejection delay instead of reflecting it", async () => {
    const h = harness([["limited", Number.MAX_SAFE_INTEGER]]);
    const decision = await h.limiter.consume(SCOPE);
    expect(decision.kind).toBe("limited");
    if (decision.kind === "limited") {
      expect(decision.retryAfterSeconds).toBe(3_600);
    }
  });

  it("fails CLOSED on corrupt stored state rather than allowing", async () => {
    const h = harness([["corrupt"]]);
    // Never `allowed`: a scope whose state cannot be read is not admitted.
    expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "unavailable" });
  });

  it("fails closed on every unusable reply shape", async () => {
    for (const reply of [
      ["limited"], // missing delay
      ["limited", "not-a-number"],
      ["weird"],
      [],
      "not-an-array",
      null,
      42,
    ]) {
      const h = harness([reply]);
      expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "unavailable" });
    }
  });

  it("reports unavailable rather than deciding while disconnected", async () => {
    const h = harness([]);
    h.client.isReady = false;
    expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "unavailable" });
    expect(h.limiter.isReady()).toBe(false);
    // Nothing was even attempted, so no quota could have been spent.
    expect(h.client.commands).toHaveLength(0);
  });

  it("reports unavailable on a transport failure without inspecting it", async () => {
    const h = harness([new Error("ECONNRESET while writing to a socket")]);
    expect(await h.limiter.consume(SCOPE)).toEqual({ kind: "unavailable" });
  });

  it("never throws, whatever the client does", async () => {
    const h = harness([]);
    // An exhausted queue makes the fake throw synchronously inside sendCommand.
    await expect(h.limiter.consume(SCOPE)).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("rate limiter: cancellation", () => {
  it("short-circuits an already-aborted signal without touching Redis", async () => {
    const h = harness([]);
    const controller = new AbortController();
    controller.abort();
    expect(await h.limiter.consume(SCOPE, controller.signal)).toEqual({ kind: "cancelled" });
    expect(h.client.commands).toHaveLength(0);
  });

  it("reports cancellation, not unavailability, when the signal aborts mid-command", async () => {
    const controller = new AbortController();
    const commands: string[][] = [];
    const client: FakeClient = {
      commands,
      isReady: true,
      connect: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
      destroy: () => undefined,
      on: () => undefined,
      sendCommand: (args, options) => {
        commands.push([...args]);
        // The substrate must pass a signal down so an in-flight command is
        // aborted promptly rather than waiting out the command deadline.
        expect(options?.abortSignal).toBeDefined();
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    };
    const connection = createRedisConnection({
      url: "redis://127.0.0.1:6379",
      createRedisClient: () => client,
    });
    const limiter = createRedisRateLimiter({
      substrate: connection.substrate,
      keyring: KEYRING,
      namespace: NAMESPACE,
      requests: 60,
      windowMs: 60_000,
      burst: 8,
    });

    const pending = limiter.consume(SCOPE, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  it("still reports unavailable when the failure is not a cancellation", async () => {
    const h = harness([new Error("boom")]);
    const controller = new AbortController();
    expect(await h.limiter.consume(SCOPE, controller.signal)).toEqual({ kind: "unavailable" });
  });
});

describe("rate limiter: leaks nothing", () => {
  it("returns only closed literal outcomes with no dynamic text", async () => {
    for (const reply of [["allowed"], ["limited", 1], ["corrupt"], null]) {
      const h = harness([reply]);
      const decision = await h.limiter.consume(SCOPE, undefined);
      const serialized = JSON.stringify(decision);
      expect(serialized).not.toContain(SCOPE);
      expect(serialized).not.toContain(MASTER_KEY);
      expect(serialized).not.toContain(NAMESPACE);
      expect(["allowed", "limited", "unavailable", "cancelled"]).toContain(decision.kind);
    }
  });
});
