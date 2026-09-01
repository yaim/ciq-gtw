/**
 * Public surface of the shared internal Redis substrate.
 *
 * Redis-backed features import from here; node-redis itself stays confined to
 * `client.ts`. The Redis COMPOSITION ROOT (`runtime.ts`) is deliberately NOT
 * re-exported: it depends on the feature boundaries, and keeping it out of this
 * barrel keeps the dependency direction one-way (features -> substrate).
 */
export {
  createRedisConnection,
  defineRedisScript,
  type MinimalRedisClient,
  type RedisClientConfig,
  type RedisConnection,
  type RedisConnectionOptions,
  type RedisEvalOptions,
  type RedisReply,
  type RedisReplyValue,
  type RedisScript,
  type RedisSubstrate,
} from "./client.js";
export {
  REDIS_CLOSE_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_RECONNECT_MAX_DELAY_MS,
} from "./limits.js";
