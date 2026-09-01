/**
 * node-redis implementation of the idempotency store (Phase 4A).
 *
 * This is the ONLY module that knows Redis exists. It owns the connection
 * lifecycle, the five server-side Lua scripts — four atomic MUTATION scripts
 * (claim, transition, renew, release) plus one bounded READ script, which
 * mutates nothing — and the reply normalization; the coordinator above it sees
 * only the narrow `IdempotencyStore` port.
 *
 * Client configuration (specification section 31.2):
 *  - a MANDATORY content-free `error` listener, so a transport error can never
 *    become an unhandled `EventEmitter` exception and no dynamic error text is
 *    ever logged;
 *  - automatic bounded reconnect with a capped backoff, so a restarted Redis is
 *    picked up without restarting the gateway;
 *  - the offline command queue DISABLED, so a command issued while disconnected
 *    fails fast (`unavailable` → `503`) instead of queueing unboundedly;
 *  - a bounded connect timeout and a bounded per-command deadline;
 *  - explicit `isReady`-based availability driving readiness.
 *
 * Every mutation is one atomic server-side script — there is no GET-then-SET
 * anywhere in the correctness path. Scripts are cached with `EVALSHA` over a
 * locally computed SHA-1 and fall back to `EVAL` on `NOSCRIPT` (a Redis restart
 * or `SCRIPT FLUSH`).
 *
 * No record read is issued as a direct client command: the read path is a script
 * too, so the stored size is checked with `STRLEN` before the script's own
 * internal `GET` and an over-budget value is classified without its bytes ever
 * reaching Node. The mutation scripts guard the same way before reading.
 *
 * Each MUTATION script reads only the record's `s` (state) and `o` (owner)
 * fields, guards `cjson.decode` with `pcall`, rejects an oversized or non-object
 * value before comparing, and validates its numeric arguments, so a corrupt or
 * hostile stored value can never cause a takeover, an unbounded expiry, or a
 * script abort. The read script decodes nothing: it returns the raw value for
 * strict validation in TypeScript.
 */
import { createHash } from "node:crypto";
import { createClient } from "redis";
import type { CasResult, IdempotencyStore } from "./store.js";
import { RECORD_VERSION, type RecordState } from "./records.js";
import {
  MAX_RECORD_BYTES,
  REDIS_CLOSE_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_RECONNECT_MAX_DELAY_MS,
} from "./limits.js";

/**
 * Atomically create a `reserved` record when the key is absent, else return the
 * existing raw value for strict validation in TypeScript. `SET` carries `PX`, so
 * a claim can never be created without a lease.
 */
/**
 * Shared Lua prelude: reject an oversized value by `STRLEN` BEFORE `GET`, so a
 * hostile or corrupt multi-megabyte value is never materialized, then decode
 * defensively.
 *
 * `cjson.decode` yields a Lua table for a JSON object AND for a JSON array, and
 * those are indistinguishable in Lua 5.1 — so an array value would reach the
 * owner comparison with `rec['o'] == nil` and report `lost` instead of
 * `corrupt`. The explicit `type(...) == 'string'` checks force every such shape
 * (and any non-string `s`/`o`) onto the `corrupt` path, which is what the
 * coordinator's diagnostics and fail-closed handling expect. The version check
 * additionally stops a replica from compare-and-transitioning a record written
 * in a format it does not understand during a mixed-version deployment.
 */
const GUARD_PRELUDE = `
local maxBytes = tonumber(ARGV[3])
if not maxBytes then return {'corrupt'} end
local size = redis.call('STRLEN', KEYS[1])
if size == 0 and redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if size > maxBytes then return {'corrupt'} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then return {'corrupt'} end
if type(rec['o']) ~= 'string' or type(rec['s']) ~= 'string' then return {'corrupt'} end
if rec['v'] ~= tonumber(ARGV[4]) then return {'corrupt'} end
if rec['o'] ~= ARGV[1] then return {'lost'} end
`;

const CLAIM_SCRIPT = `
local maxBytes = tonumber(ARGV[3])
if not maxBytes then return {'corrupt'} end
if redis.call('EXISTS', KEYS[1]) == 0 then
  local lease = tonumber(ARGV[2])
  if not lease or lease < 1 then return {'corrupt'} end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', lease)
  return {'claimed'}
end
if redis.call('STRLEN', KEYS[1]) > maxBytes then return {'corrupt'} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
return {'exists', raw}
`;

/** Atomically replace an owned record in a known state, resetting its expiry. */
const TRANSITION_SCRIPT = `${GUARD_PRELUDE}
if rec['s'] ~= ARGV[2] then return {'state'} end
local ttl = tonumber(ARGV[5])
if not ttl or ttl < 1 then return {'corrupt'} end
redis.call('SET', KEYS[1], ARGV[6], 'PX', ttl)
return {'ok'}
`;

/**
 * Atomically extend an owned ACTIVE record's lease, choosing the lease duration
 * from the AUTHORITATIVE STORED STATE rather than from the caller's view of it.
 *
 * This is load bearing. `reserved` and `processing` carry deliberately different
 * leases, and a renewal races the `reserved -> processing` transition: Redis can
 * apply the transition while the transitioning caller is still awaiting its
 * reply, so a renewal issued in that window would carry the caller's stale
 * `reserved` view. If the script trusted that view it would `PEXPIRE` a
 * `processing` record down to the short reserved lease, and the record could
 * then expire while its owner was legitimately mid-completion — allowing another
 * replica to claim the key and duplicate billed upstream work.
 *
 * Reading `rec['s']` inside the script removes the race entirely: the state and
 * the lease are chosen in the same atomic step, so no caller-local staleness can
 * shorten a lease. A `final` or `ambiguous` record is still never revived — its
 * TTL is owned by the commit/abandon transition — and the reply carries the
 * observed state so the caller can report which lease was applied.
 */
const RENEW_SCRIPT = `${GUARD_PRELUDE}
local lease
if rec['s'] == 'reserved' then
  lease = tonumber(ARGV[2])
elseif rec['s'] == 'processing' then
  lease = tonumber(ARGV[5])
else
  return {'state'}
end
if not lease or lease < 1 then return {'corrupt'} end
redis.call('PEXPIRE', KEYS[1], lease)
return {'ok', rec['s']}
`;

/** Atomically delete an owned record that is still in the expected state. */
const RELEASE_SCRIPT = `${GUARD_PRELUDE}
if rec['s'] ~= ARGV[2] then return {'state'} end
redis.call('DEL', KEYS[1])
return {'ok'}
`;

/**
 * Atomically read a record, rejecting an oversized value by `STRLEN` BEFORE the
 * `GET`. A plain `GET` would materialize a hostile or corrupt multi-megabyte
 * value in Node just to discard it; here the bytes never leave Redis. The record
 * is neither deleted nor mutated — the normative contract classifies an
 * unreadable record as corrupt and fails the request closed, and destroying it
 * would discard state another owner may still hold.
 */
const READ_SCRIPT = `
local maxBytes = tonumber(ARGV[1])
if not maxBytes or maxBytes < 1 then return {'corrupt'} end
local size = redis.call('STRLEN', KEYS[1])
if size == 0 and redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if size > maxBytes then return {'corrupt'} end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
if raw == '' then return {'corrupt'} end
return {'found', raw}
`;

function sha1(script: string): string {
  return createHash("sha1").update(script, "utf8").digest("hex");
}

const SCRIPTS = {
  claim: { body: CLAIM_SCRIPT, sha: sha1(CLAIM_SCRIPT) },
  transition: { body: TRANSITION_SCRIPT, sha: sha1(TRANSITION_SCRIPT) },
  renew: { body: RENEW_SCRIPT, sha: sha1(RENEW_SCRIPT) },
  release: { body: RELEASE_SCRIPT, sha: sha1(RELEASE_SCRIPT) },
  read: { body: READ_SCRIPT, sha: sha1(READ_SCRIPT) },
} as const;

type ScriptName = keyof typeof SCRIPTS;

/** The Redis connection plus the store it backs. */
export interface RedisIdempotencyConnection {
  readonly store: IdempotencyStore;
  /**
   * Begin connecting. Returns immediately and NEVER rejects, so process startup
   * is not blocked or failed by an unavailable Redis: the listener still binds,
   * `/healthz` stays `200`, `/readyz` stays `503` until the client is ready, and
   * the client reconnects automatically in the background.
   */
  connect(): void;
  /** Bounded graceful close with a force-destroy fallback. Never rejects. */
  close(): Promise<void>;
  /** Fixed, bounded, synchronous availability view backing readiness. */
  isReady(): boolean;
}

/** The exact client configuration this module requires. */
export interface RedisClientConfig {
  readonly url: string;
  /**
   * Pinned protocol version so Lua replies decode identically across
   * deployments and across any Redis-compatible endpoint that predates RESP3.
   */
  readonly RESP: 2;
  readonly disableOfflineQueue: true;
  readonly socket: {
    readonly connectTimeout: number;
    readonly reconnectStrategy: (retries: number) => number;
  };
}

/** A minimal structural view of the client operations this module uses. */
export interface MinimalRedisClient {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  destroy(): void;
  sendCommand(args: readonly string[], options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly isReady: boolean;
}

export interface RedisIdempotencyOptions {
  /** The validated canonical `redis://` / `rediss://` endpoint. */
  readonly url: string;
  /** Optional injected client factory (tests only); production uses node-redis. */
  readonly createRedisClient?: (config: RedisClientConfig) => MinimalRedisClient;
}

/**
 * Production client factory. The cast is confined here: node-redis types
 * `RESP` through a class generic that cannot be expressed on a plain options
 * object, and the module consumes only the narrow {@link MinimalRedisClient}
 * surface above.
 */
function defaultCreateRedisClient(config: RedisClientConfig): MinimalRedisClient {
  const options = config as unknown as Parameters<typeof createClient>[0];
  return createClient(options);
}

/**
 * Race a bounded deadline without leaking an unhandled rejection: the losing
 * promise's rejection is always absorbed. This is defence in depth on top of the
 * `abortSignal` the command already carries.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True when a thrown value is Redis's `NOSCRIPT` reply. Trap-safe. */
function isNoScript(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  const message: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof message === "string" && message.startsWith("NOSCRIPT");
}

/** Normalize a Lua reply into `[tag, payload?]` of plain strings, or `null`. */
function normalizeReply(reply: unknown): readonly [string, string | undefined] | null {
  if (!Array.isArray(reply) || reply.length === 0) return null;
  const rawTag: unknown = reply[0];
  const tag =
    typeof rawTag === "string" ? rawTag : Buffer.isBuffer(rawTag) ? rawTag.toString("utf8") : null;
  if (tag === null) return null;
  const rawValue: unknown = reply[1];
  const value =
    typeof rawValue === "string"
      ? rawValue
      : Buffer.isBuffer(rawValue)
        ? rawValue.toString("utf8")
        : undefined;
  return [tag, value];
}

function casFromTag(tag: string): CasResult {
  switch (tag) {
    case "ok":
      return { kind: "ok" };
    case "missing":
      return { kind: "missing" };
    case "lost":
      return { kind: "lost" };
    case "state":
      return { kind: "state" };
    case "corrupt":
      return { kind: "corrupt" };
    default:
      return { kind: "unavailable" };
  }
}

/**
 * Build the Redis-backed connection and store.
 *
 * Construction opens NO socket: the client is created but `connect()` is left to
 * the process composition root, so `buildServer`, the test suites, and the
 * compiled-import smoke test stay socket-free.
 */
export function createRedisIdempotencyConnection(
  options: RedisIdempotencyOptions,
): RedisIdempotencyConnection {
  const factory = options.createRedisClient ?? defaultCreateRedisClient;
  const client = factory({
    url: options.url,
    RESP: 2,
    // Fail fast when disconnected rather than queueing commands unboundedly; a
    // keyed request then returns 503 instead of hanging.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      // Bounded automatic reconnect: linear backoff capped so a long outage
      // never produces an unbounded retry delay and readiness recovers promptly.
      reconnectStrategy: (retries: number) =>
        Math.min((retries + 1) * 200, REDIS_RECONNECT_MAX_DELAY_MS),
    },
  });

  // MANDATORY content-free error listener. A Redis transport error must never
  // crash the process, and its dynamic text (which can contain the endpoint or
  // credentials) must never be logged.
  client.on("error", () => {
    // Intentionally silent: availability is observed through `isReady()`.
  });

  let closed = false;

  async function evalScript(
    name: ScriptName,
    key: string,
    args: readonly string[],
  ): Promise<readonly [string, string | undefined] | null> {
    if (closed || !client.isReady) return null;
    const script = SCRIPTS[name];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REDIS_COMMAND_TIMEOUT_MS);
    if (typeof timeout.unref === "function") timeout.unref();
    try {
      const send = (command: readonly string[]): Promise<unknown> =>
        client.sendCommand(command, { abortSignal: controller.signal });

      let reply: unknown;
      try {
        reply = await withDeadline(
          send(["EVALSHA", script.sha, "1", key, ...args]),
          REDIS_COMMAND_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isNoScript(error)) return null;
        // The script cache was flushed (or Redis restarted): ship the body once.
        reply = await withDeadline(
          send(["EVAL", script.body, "1", key, ...args]),
          REDIS_COMMAND_TIMEOUT_MS,
        );
      }
      if (reply === "timeout") return null;
      return normalizeReply(reply);
    } catch {
      // Transport/protocol/abort failure: fail closed without inspecting it.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  const store: IdempotencyStore = {
    async claim(key, record, leaseMs) {
      const reply = await evalScript("claim", key, [
        record,
        String(leaseMs),
        String(MAX_RECORD_BYTES),
      ]);
      if (reply === null) return { kind: "unavailable" };
      const [tag, value] = reply;
      if (tag === "claimed") return { kind: "claimed" };
      if (tag === "corrupt") return { kind: "corrupt" };
      if (tag === "exists" && value !== undefined) return { kind: "exists", raw: value };
      return { kind: "unavailable" };
    },

    async read(key) {
      // Bounded server side: the script rejects an oversized value on STRLEN
      // before any GET, so an over-budget entry is classified `corrupt` without
      // its bytes ever being materialized here.
      const reply = await evalScript("read", key, [String(MAX_RECORD_BYTES)]);
      if (reply === null) return { kind: "unavailable" };
      const [tag, value] = reply;
      if (tag === "missing") return { kind: "missing" };
      if (tag === "corrupt") return { kind: "corrupt" };
      if (tag === "found" && value !== undefined) return { kind: "found", raw: value };
      return { kind: "unavailable" };
    },

    async transition(key, owner, from: RecordState, next, ttlMs) {
      const reply = await evalScript("transition", key, [
        owner,
        from,
        String(MAX_RECORD_BYTES),
        String(RECORD_VERSION),
        String(ttlMs),
        next,
      ]);
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    async renew(key, owner, leases) {
      // BOTH leases are shipped; the script picks one from the stored state, so
      // a caller whose view of that state is stale cannot shorten the lease.
      const reply = await evalScript("renew", key, [
        owner,
        String(leases.reserved),
        String(MAX_RECORD_BYTES),
        String(RECORD_VERSION),
        String(leases.processing),
      ]);
      if (reply === null) return { kind: "unavailable" };
      const result = casFromTag(reply[0]);
      if (result.kind !== "ok") return result;
      const observed = reply[1];
      return observed === "reserved" || observed === "processing"
        ? { kind: "ok", observedState: observed }
        : { kind: "ok" };
    },

    async release(key, owner, from: RecordState) {
      const reply = await evalScript("release", key, [
        owner,
        from,
        String(MAX_RECORD_BYTES),
        String(RECORD_VERSION),
      ]);
      return reply === null ? { kind: "unavailable" } : casFromTag(reply[0]);
    },

    isReady(): boolean {
      try {
        return !closed && client.isReady === true;
      } catch {
        return false;
      }
    },
  };

  return {
    store,
    connect(): void {
      if (closed) return;
      // Fire and forget: a failed initial connection is retried by the
      // reconnect strategy and never rejects startup.
      void Promise.resolve(client.connect()).catch(() => undefined);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Bounded graceful close; force-destroy when it does not complete in time
      // so shutdown can never hang on a half-open socket.
      const outcome = await withDeadline(
        Promise.resolve(client.close()).catch(() => undefined),
        REDIS_CLOSE_TIMEOUT_MS,
      );
      if (outcome === "timeout") {
        try {
          client.destroy();
        } catch {
          /* a concurrent destroy is not worth surfacing */
        }
      }
    },
    isReady(): boolean {
      return store.isReady();
    },
  };
}
