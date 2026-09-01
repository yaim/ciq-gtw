/**
 * The shared internal Redis substrate.
 *
 * This is the ONLY module that imports node-redis. Every optional Redis-backed
 * feature — idempotency (`src/idempotency/`, specification section 18.1) and
 * cross-replica rate limiting (`src/rate-limit/`, section 19.1) — runs its
 * server-side Lua through the narrow {@link RedisSubstrate} port below, so the
 * gateway process holds exactly ONE client and ONE connection lifecycle no
 * matter how many features are enabled.
 *
 * Client configuration (specification section 31.2):
 *  - a MANDATORY content-free `error` listener, so a transport error can never
 *    become an unhandled `EventEmitter` exception and no dynamic error text is
 *    ever logged;
 *  - automatic bounded reconnect with a capped backoff, so a restarted Redis is
 *    picked up without restarting the gateway;
 *  - the offline command queue DISABLED, so a command issued while disconnected
 *    fails fast instead of queueing unboundedly;
 *  - a bounded connect timeout and a bounded per-command deadline;
 *  - explicit `isReady`-based availability driving readiness.
 *
 * Scripts are cached with `EVALSHA` over a locally computed SHA-1 and fall back
 * to `EVAL` on `NOSCRIPT` (a Redis restart or `SCRIPT FLUSH`). The substrate is
 * deliberately ignorant of what a script means: it ships arguments, bounds the
 * call, and normalizes the array reply into plain strings/integers. Every
 * feature owns its own Lua, its own reply vocabulary, and its own key shape.
 *
 * `evalScript` is TOTAL: transport, protocol, abort, and timeout failures all
 * return `null` rather than throwing, so a caller can always fail closed
 * without inspecting a thrown value.
 */
import { createHash } from "node:crypto";
import { createClient } from "redis";
import {
  REDIS_CLOSE_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_RECONNECT_MAX_DELAY_MS,
} from "./limits.js";

/** A server-side script plus its locally computed SHA-1, used for `EVALSHA`. */
export interface RedisScript {
  readonly body: string;
  readonly sha: string;
}

/** Register a script body. The SHA is computed once, at module load. */
export function defineRedisScript(body: string): RedisScript {
  return { body, sha: createHash("sha1").update(body, "utf8").digest("hex") };
}

/** One normalized element of a Lua array reply. */
export type RedisReplyValue = string | number | null;

/** A normalized Lua array reply: plain strings, finite integers, and nulls. */
export type RedisReply = readonly RedisReplyValue[];

/** Optional per-command inputs. */
export interface RedisEvalOptions {
  /**
   * Caller cancellation (client disconnect, shutdown, deadline). An already
   * aborted signal short-circuits before any command is issued; an abort during
   * the call aborts the in-flight command. The caller distinguishes
   * `cancelled` from `unavailable` by re-checking its own signal.
   */
  readonly signal?: AbortSignal;
}

/** The narrow port every Redis-backed feature depends on. */
export interface RedisSubstrate {
  /**
   * Evaluate `script` atomically. Returns the normalized array reply, or `null`
   * for ANY failure (disconnected, closed, timed out, aborted, transport or
   * protocol error, non-array reply). Never throws.
   */
  evalScript(
    script: RedisScript,
    keys: readonly string[],
    args: readonly string[],
    options?: RedisEvalOptions,
  ): Promise<RedisReply | null>;
  /** Fixed, bounded, synchronous availability view. Performs no I/O. */
  isReady(): boolean;
}

/** The one process-owned connection plus the substrate it backs. */
export interface RedisConnection {
  readonly substrate: RedisSubstrate;
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

export interface RedisConnectionOptions {
  /** The validated canonical `redis://` / `rediss://` endpoint. */
  readonly url: string;
  /** Optional injected client factory (tests only); production uses node-redis. */
  readonly createRedisClient?: (config: RedisClientConfig) => MinimalRedisClient;
}

/**
 * Production client factory. The cast is confined here: node-redis types
 * `RESP` through a class generic that cannot be expressed on a plain options
 * object, and this module consumes only the narrow {@link MinimalRedisClient}
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

/** Normalize one reply element; an unrepresentable element becomes `null`. */
function normalizeElement(value: unknown): RedisReplyValue {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Normalize a Lua array reply, or `null` when the reply is not a usable array. */
function normalizeReply(reply: unknown): RedisReply | null {
  if (!Array.isArray(reply) || reply.length === 0) return null;
  return reply.map(normalizeElement);
}

/**
 * Create the one process-owned Redis connection.
 *
 * Construction opens NO socket: the client is created but `connect()` is left to
 * the process composition root, so `buildServer`, the test suites, and the
 * compiled-import smoke test stay socket-free.
 */
export function createRedisConnection(options: RedisConnectionOptions): RedisConnection {
  const factory = options.createRedisClient ?? defaultCreateRedisClient;
  const client = factory({
    url: options.url,
    RESP: 2,
    // Fail fast when disconnected rather than queueing commands unboundedly; a
    // dependent request then fails closed instead of hanging.
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

  const isReady = (): boolean => {
    try {
      return !closed && client.isReady === true;
    } catch {
      return false;
    }
  };

  const substrate: RedisSubstrate = {
    async evalScript(script, keys, args, evalOptions) {
      if (evalOptions?.signal?.aborted === true) return null;
      if (!isReady()) return null;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REDIS_COMMAND_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();
      // A caller signal aborts the in-flight command alongside the deadline, so
      // a disconnected client or a shutdown never waits out the full timeout.
      const abortSignal =
        evalOptions?.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, evalOptions.signal]);
      try {
        const send = (command: readonly string[]): Promise<unknown> =>
          client.sendCommand(command, { abortSignal });
        const keyCount = String(keys.length);

        let reply: unknown;
        try {
          reply = await withDeadline(
            send(["EVALSHA", script.sha, keyCount, ...keys, ...args]),
            REDIS_COMMAND_TIMEOUT_MS,
          );
        } catch (error) {
          if (!isNoScript(error)) return null;
          // The script cache was flushed (or Redis restarted): ship the body once.
          reply = await withDeadline(
            send(["EVAL", script.body, keyCount, ...keys, ...args]),
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
    },

    isReady,
  };

  return {
    substrate,
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
    isReady,
  };
}
