/**
 * The shared Redis substrate (`src/redis/client.ts`).
 *
 * The substrate is the ONE place that owns a node-redis client, so these tests
 * pin the properties every Redis-backed feature inherits from it: the bounded
 * client configuration, the generic multi-key `EVALSHA`→`EVAL` path, the
 * lifecycle, and — most importantly — that it is TOTAL, collapsing every failure
 * to `null` so a caller can always fail closed.
 *
 * Everything here is synthetic; no socket is opened.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createRedisConnection,
  defineRedisScript,
  type MinimalRedisClient,
  type RedisClientConfig,
} from "../../src/redis/index.js";

const SCRIPT = defineRedisScript("return {'ok'}");
const OTHER = defineRedisScript("return {'other'}");

interface FakeClient extends MinimalRedisClient {
  readonly commands: readonly (readonly string[])[];
  readonly listeners: readonly string[];
  isReady: boolean;
  closeCalls: number;
  destroyCalls: number;
  connectCalls: number;
}

interface Harness {
  readonly connection: ReturnType<typeof createRedisConnection>;
  readonly client: FakeClient;
  readonly config: RedisClientConfig;
}

function harness(
  replies: readonly unknown[],
  overrides: Partial<Pick<MinimalRedisClient, "close" | "connect" | "sendCommand">> = {},
): Harness {
  const commands: string[][] = [];
  const listeners: string[] = [];
  const queue = [...replies];
  let captured: RedisClientConfig | undefined;

  const client: FakeClient = {
    commands,
    listeners,
    isReady: true,
    closeCalls: 0,
    destroyCalls: 0,
    connectCalls: 0,
    connect:
      overrides.connect ??
      ((): Promise<unknown> => {
        client.connectCalls += 1;
        return Promise.resolve(undefined);
      }),
    close:
      overrides.close ??
      ((): Promise<void> => {
        client.closeCalls += 1;
        return Promise.resolve();
      }),
    destroy: () => {
      client.destroyCalls += 1;
    },
    on: (event: string) => {
      listeners.push(event);
      return undefined;
    },
    sendCommand:
      overrides.sendCommand ??
      ((args: readonly string[]): Promise<unknown> => {
        commands.push([...args]);
        if (queue.length === 0) throw new Error("fake client: no scripted reply left");
        const reply = queue.shift();
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      }),
  };

  const connection = createRedisConnection({
    url: "redis://127.0.0.1:6379",
    createRedisClient: (config) => {
      captured = config;
      return client;
    },
  });
  return { connection, client, config: captured as RedisClientConfig };
}

describe("redis substrate: client configuration", () => {
  it("pins the protocol, disables the offline queue, and bounds connect/reconnect", () => {
    const h = harness([]);
    expect(h.config.url).toBe("redis://127.0.0.1:6379");
    expect(h.config.RESP).toBe(2);
    // Fail fast rather than queue unboundedly while disconnected.
    expect(h.config.disableOfflineQueue).toBe(true);
    expect(h.config.socket.connectTimeout).toBeGreaterThan(0);
    const delays = [0, 1, 5, 50, 5_000].map((n) => h.config.socket.reconnectStrategy(n));
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
    expect(Math.min(...delays)).toBeGreaterThan(0);
    // Backoff grows before it caps, so a brief blip recovers quickly.
    expect(h.config.socket.reconnectStrategy(0)).toBeLessThan(
      h.config.socket.reconnectStrategy(10),
    );
  });

  it("attaches a MANDATORY error listener at construction", () => {
    // Without it a transport error becomes an unhandled EventEmitter exception
    // and takes the process down.
    expect(harness([]).client.listeners).toContain("error");
  });

  it("opens no socket at construction", () => {
    const h = harness([]);
    expect(h.client.connectCalls).toBe(0);
    expect(h.connection.isReady()).toBe(true); // the fake reports ready; nothing connected it
    h.connection.connect();
    expect(h.client.connectCalls).toBe(1);
  });
});

describe("redis substrate: script evaluation", () => {
  it("ships EVALSHA with the correct key count for a single key", async () => {
    const h = harness([["ok"]]);
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], ["a", "b"])).toEqual(["ok"]);
    expect(h.client.commands[0]).toEqual(["EVALSHA", SCRIPT.sha, "1", "k1", "a", "b"]);
  });

  it("supports multiple keys", async () => {
    const h = harness([["ok"]]);
    await h.connection.substrate.evalScript(SCRIPT, ["k1", "k2", "k3"], ["a"]);
    expect(h.client.commands[0]).toEqual(["EVALSHA", SCRIPT.sha, "3", "k1", "k2", "k3", "a"]);
  });

  it("supports no keys at all", async () => {
    const h = harness([["ok"]]);
    await h.connection.substrate.evalScript(SCRIPT, [], []);
    expect(h.client.commands[0]).toEqual(["EVALSHA", SCRIPT.sha, "0"]);
  });

  it("computes a distinct SHA per script body", () => {
    expect(SCRIPT.sha).not.toBe(OTHER.sha);
    expect(SCRIPT.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(defineRedisScript(SCRIPT.body).sha).toBe(SCRIPT.sha);
  });

  it("falls back to EVAL on NOSCRIPT, preserving keys and arguments", async () => {
    const h = harness([new Error("NOSCRIPT No matching script."), ["ok"]]);
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1", "k2"], ["a"])).toEqual(["ok"]);
    expect(h.client.commands).toEqual([
      ["EVALSHA", SCRIPT.sha, "2", "k1", "k2", "a"],
      ["EVAL", SCRIPT.body, "2", "k1", "k2", "a"],
    ]);
  });

  it("does NOT fall back for any other error", async () => {
    const h = harness([new Error("ERR unknown command")]);
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toBeNull();
    expect(h.client.commands.map((command) => command[0])).toEqual(["EVALSHA"]);
  });

  it("detects NOSCRIPT trap-safely, never invoking an accessor", async () => {
    // A hostile value whose `message` is an accessor claiming to be NOSCRIPT.
    // Reading it would both run the trap and let the value force an EVAL.
    let reads = 0;
    const hostile = Object.defineProperty({}, "message", {
      get: () => {
        reads += 1;
        return "NOSCRIPT";
      },
    }) as unknown as Error;

    let attempts = 0;
    const h = harness([], {
      sendCommand: () => {
        attempts += 1;
        return Promise.reject(hostile);
      },
    });

    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toBeNull();
    expect(reads).toBe(0);
    // No fallback was attempted, so the accessor could not smuggle in a second
    // command either.
    expect(attempts).toBe(1);
  });

  it("normalizes buffers, integers, and nulls in a reply", async () => {
    const h = harness([[Buffer.from("limited", "utf8"), 1_234, null]]);
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toEqual([
      "limited",
      1_234,
      null,
    ]);
  });

  it("returns null for any reply that is not a usable array", async () => {
    for (const reply of ["string", 7, null, undefined, {}, []]) {
      const h = harness([reply]);
      expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toBeNull();
    }
  });

  it("refuses to issue a command while disconnected", async () => {
    const h = harness([]);
    h.client.isReady = false;
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toBeNull();
    expect(h.client.commands).toHaveLength(0);
    expect(h.connection.isReady()).toBe(false);
  });

  it("treats a throwing isReady as not ready", async () => {
    const h = harness([]);
    Object.defineProperty(h.client, "isReady", {
      get: () => {
        throw new Error("hostile");
      },
    });
    expect(h.connection.isReady()).toBe(false);
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toBeNull();
  });

  it("short-circuits an already-aborted caller signal", async () => {
    const h = harness([]);
    const controller = new AbortController();
    controller.abort();
    expect(
      await h.connection.substrate.evalScript(SCRIPT, ["k1"], [], { signal: controller.signal }),
    ).toBeNull();
    expect(h.client.commands).toHaveLength(0);
  });

  it("passes an abort signal down so an in-flight command can be cancelled", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const h = harness([], {
      sendCommand: (_args, options) => {
        seen.push(options?.abortSignal);
        return Promise.resolve(["ok"]);
      },
    });
    await h.connection.substrate.evalScript(SCRIPT, ["k1"], []);
    const controller = new AbortController();
    await h.connection.substrate.evalScript(SCRIPT, ["k1"], [], { signal: controller.signal });
    // Both calls carry a signal: the bounded command deadline always, plus the
    // caller's own cancellation when supplied.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
    expect(seen[1]?.aborted).toBe(false);
    controller.abort();
    expect(seen[1]?.aborted).toBe(true);
  });
});

describe("redis substrate: lifecycle", () => {
  it("never rejects when connect fails", () => {
    const h = harness([], { connect: () => Promise.reject(new Error("refused")) });
    expect(() => h.connection.connect()).not.toThrow();
  });

  it("closes once, is idempotent, and fails commands closed afterwards", async () => {
    const h = harness([["ok"]]);
    await h.connection.close();
    expect(h.client.closeCalls).toBe(1);
    expect(h.connection.isReady()).toBe(false);
    expect(await h.connection.substrate.evalScript(SCRIPT, ["k1"], [])).toBeNull();

    await h.connection.close();
    expect(h.client.closeCalls).toBe(1);
    // A closed connection also refuses to reconnect.
    h.connection.connect();
    expect(h.client.connectCalls).toBe(0);
  });

  it("absorbs a rejecting close instead of failing shutdown", async () => {
    const h = harness([], { close: () => Promise.reject(new Error("half-open")) });
    await expect(h.connection.close()).resolves.toBeUndefined();
  });

  it("force-destroys the socket when a graceful close does not complete", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([], { close: () => new Promise<void>(() => undefined) });
      const closing = h.connection.close();
      await vi.advanceTimersByTimeAsync(2_500);
      await closing;
      // Shutdown can never hang on a half-open socket.
      expect(h.client.destroyCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a command that never settles", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([], { sendCommand: () => new Promise<unknown>(() => undefined) });
      const pending = h.connection.substrate.evalScript(SCRIPT, ["k1"], []);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
