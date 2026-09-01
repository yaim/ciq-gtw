/**
 * Redis-backed GCRA rate limiter (Phase 4B; specification section 19.1).
 *
 * One request produces exactly ONE atomic server-side decision. There is no
 * read-then-write anywhere: the script reads Redis's own clock, reads the stored
 * theoretical arrival time (TAT), decides, and — only when it admits the request
 * — writes the new TAT, all inside a single script invocation. That is what
 * makes the quota correct across replicas: two gateways racing the same scope
 * are serialized by Redis, not by any local lock or counter.
 *
 * The clock is Redis's `TIME`, never `Date.now()`. Replica clocks drift and can
 * jump; a process clock would make the shared quota inconsistent between
 * gateways and would let a skewed replica admit a burst that another replica had
 * already spent. Redis is the single source of time exactly as it is the single
 * source of state.
 *
 * Stored state is one bounded decimal integer (microseconds) and nothing else —
 * no counter history, no key, no identity, no content. Its size is checked with
 * `STRLEN` BEFORE the script's own internal `GET`, so an oversized or hostile
 * value is classified corrupt without its bytes ever being read; there is no
 * direct client `GET` at all. Every unusable state (missing-but-present empty
 * value, non-numeric, negative, oversized, unparseable) fails CLOSED as
 * `corrupt`, which the caller maps to `503` — the script never resets the value
 * and never silently admits the request.
 */
import { defineRedisScript, type RedisSubstrate } from "../redis/index.js";
import { computeGcraParameters, retryAfterSecondsForDelay } from "./gcra.js";
import { buildRateLimitKey, type RateLimitKeyring } from "./keyring.js";
import { MAX_TAT_VALUE_BYTES } from "./limits.js";
import type { RateLimitDecision, RateLimiter } from "./types.js";

/**
 * The single atomic GCRA decision.
 *
 * `KEYS[1]`  quota key
 * `ARGV[1]`  maximum accepted stored-value size, in bytes
 * `ARGV[2]`  emission interval, in microseconds
 * `ARGV[3]`  burst tolerance, in microseconds
 *
 * Replies: `{'allowed'}` | `{'limited', <delayUs>}` | `{'corrupt'}`.
 *
 * `redis.call('TIME')` returns `{seconds, microseconds}` as strings. Both the
 * current time (~1.8e15 µs) and any TAT it produces stay far inside the 2^53
 * range that Lua 5.1 doubles represent exactly, so the arithmetic below is
 * lossless. Values are formatted with `%d` because `tostring` would render a
 * 16-digit number in exponential form and lose precision.
 */
const DECIDE_SCRIPT = `
local maxBytes = tonumber(ARGV[1])
local intervalUs = tonumber(ARGV[2])
local toleranceUs = tonumber(ARGV[3])
if not maxBytes or maxBytes < 1 then return {'corrupt'} end
if not intervalUs or intervalUs < 1 then return {'corrupt'} end
if not toleranceUs or toleranceUs < 0 then return {'corrupt'} end

local clock = redis.call('TIME')
if type(clock) ~= 'table' then return {'corrupt'} end
local seconds = tonumber(clock[1])
local micros = tonumber(clock[2])
if not seconds or not micros or seconds < 0 or micros < 0 then return {'corrupt'} end
local nowUs = seconds * 1000000 + micros

local size = redis.call('STRLEN', KEYS[1])
if size > maxBytes then return {'corrupt'} end

local tat = nowUs
if size > 0 then
  local raw = redis.call('GET', KEYS[1])
  if not raw then return {'corrupt'} end
  if not string.match(raw, '^%d+$') then return {'corrupt'} end
  local stored = tonumber(raw)
  if not stored or stored < 0 then return {'corrupt'} end
  if stored > nowUs then tat = stored end
elseif redis.call('EXISTS', KEYS[1]) == 1 then
  return {'corrupt'}
end

if nowUs >= tat - toleranceUs then
  local newTat = tat + intervalUs
  local ttlMs = math.ceil((newTat - nowUs) / 1000)
  if ttlMs < 1 then ttlMs = 1 end
  redis.call('SET', KEYS[1], string.format('%d', newTat), 'PX', string.format('%d', ttlMs))
  return {'allowed'}
end

return {'limited', tat - toleranceUs - nowUs}
`;

const DECIDE = defineRedisScript(DECIDE_SCRIPT);

export interface RedisRateLimiterOptions {
  readonly substrate: RedisSubstrate;
  readonly keyring: RateLimitKeyring;
  /** Readable Redis namespace (`REDIS_KEY_PREFIX`); shared across replicas. */
  readonly namespace: string;
  /** `RATE_LIMIT_REQUESTS`: sustained requests per window. */
  readonly requests: number;
  /** `RATE_LIMIT_WINDOW_MS`: the window the sustained rate is expressed over. */
  readonly windowMs: number;
  /** `RATE_LIMIT_BURST`: requests admitted immediately from a cold scope. */
  readonly burst: number;
}

/**
 * Build the cross-replica limiter over the shared Redis substrate.
 *
 * Construction opens no socket and issues no command; the GCRA parameters are
 * derived once from validated configuration.
 */
export function createRedisRateLimiter(options: RedisRateLimiterOptions): RateLimiter {
  const { intervalUs, toleranceUs } = computeGcraParameters(
    options.requests,
    options.windowMs,
    options.burst,
  );
  const args = [String(MAX_TAT_VALUE_BYTES), String(intervalUs), String(toleranceUs)] as const;

  return {
    async consume(gatewayKeyScope: string, signal?: AbortSignal): Promise<RateLimitDecision> {
      // Read through a helper so the signal is re-observed after the await; a
      // direct check would be narrowed to its pre-await value.
      const cancelled = (): boolean => signal !== undefined && signal.aborted;
      if (cancelled()) return { kind: "cancelled" };

      const key = buildRateLimitKey(options.keyring, options.namespace, gatewayKeyScope);
      const reply = await options.substrate.evalScript(
        DECIDE,
        [key],
        args,
        signal === undefined ? undefined : { signal },
      );

      if (reply === null) {
        // The substrate collapses every failure to `null`; only the caller's own
        // signal distinguishes a cancellation from an unavailable dependency.
        return cancelled() ? { kind: "cancelled" } : { kind: "unavailable" };
      }

      const tag = reply[0];
      if (tag === "allowed") return { kind: "allowed" };
      if (tag === "limited") {
        const delayUs = reply[1];
        if (typeof delayUs !== "number") return { kind: "unavailable" };
        return { kind: "limited", retryAfterSeconds: retryAfterSecondsForDelay(delayUs) };
      }
      // `corrupt` and any unrecognized tag: fail closed, never allow.
      return { kind: "unavailable" };
    },

    isReady(): boolean {
      return options.substrate.isReady();
    },
  };
}
