/**
 * Thread-reuse runtime composition (Phase 5A; specification section 5.1.1).
 *
 * Wires validated configuration into the concrete reuse layer: derive the
 * keyring, fingerprint the active upstream principal exactly once, build the
 * store over the SHARED Redis substrate, and build the coordinator. The feature
 * is OFF unless `OPENCODE_THREAD_REUSE_ENABLED=true`, which configuration
 * validation additionally requires to be accompanied by a valid `REDIS_URL`
 * (and therefore, by the existing Phase 4A rule, by
 * `IDEMPOTENCY_ENCRYPTION_KEY`). When it is off this module produces nothing at
 * all: no scope is derived, no coordinator is built, and no Redis command is
 * ever issued for thread reuse.
 *
 * Construction performs NO I/O and creates no client: the connection is owned by
 * the Redis composition root (`src/redis/runtime.ts`).
 */
import type { AppConfig } from "../config/schema.js";
import type { RedisSubstrate } from "../redis/index.js";
import { createThreadReuseCoordinator, type ThreadReuseCoordinator } from "./coordinator.js";
import {
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  type ThreadReuseKeyring,
} from "./keyring.js";
import { createRedisThreadReuseStore } from "./redis-store.js";

/**
 * Derives the per-gateway-key reuse scope. Present only when reuse is enabled;
 * the gateway authenticator exposes `reuseScopeId: null` otherwise.
 */
export type ThreadReuseScopeDeriver = (rawGatewayKey: string) => string;

/**
 * Derive the keyring when reuse is enabled. Requires the master key, which
 * configuration validation guarantees is present whenever the feature is
 * enabled (enabling it requires Redis, and Redis requires the key).
 */
function buildKeyring(config: AppConfig): ThreadReuseKeyring | null {
  if (!config.OPENCODE_THREAD_REUSE_ENABLED) return null;
  if (config.IDEMPOTENCY_ENCRYPTION_KEY === undefined) return null;
  return deriveThreadReuseKeyring(config.IDEMPOTENCY_ENCRYPTION_KEY);
}

/**
 * Build the per-gateway-key scope deriver from validated configuration, or
 * `null` when reuse is disabled. Pure: HKDF/HMAC only, no I/O, no socket — so
 * `buildServer` can call it during construction.
 */
export function buildThreadReuseScopeDeriver(config: AppConfig): ThreadReuseScopeDeriver | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;
  return (rawGatewayKey: string) => deriveThreadReuseScope(keyring, rawGatewayKey);
}

/**
 * Select the credential material that identifies the ACTIVE upstream principal.
 *
 * Bearer mode uses the configured token; password mode uses the configured
 * USERNAME rather than the transient access token, which rotates on every login
 * and would needlessly re-partition mappings for one principal. The value is
 * read here exactly once and is immediately reduced to an HMAC.
 */
function principalMaterial(config: AppConfig): string | null {
  if (config.COLLECTIVIQ_AUTH_MODE === "bearer") return config.COLLECTIVIQ_API_KEY ?? null;
  return config.COLLECTIVIQ_USERNAME ?? null;
}

/**
 * Compose the reuse coordinator over the shared Redis substrate, or `null` when
 * reuse is disabled. Performs no I/O.
 *
 * A missing credential for the active auth mode also yields `null`. Validated
 * configuration makes that unreachable, and the route treats an unwired
 * coordinator as an unavailable dependency (`503`) rather than as a disabled
 * feature — so even this impossible state fails closed.
 */
export function createThreadReuseCoordinatorFromConfig(
  config: AppConfig,
  substrate: RedisSubstrate,
): ThreadReuseCoordinator | null {
  const keyring = buildKeyring(config);
  if (keyring === null) return null;
  const material = principalMaterial(config);
  if (material === null) return null;

  return createThreadReuseCoordinator({
    store: createRedisThreadReuseStore(substrate),
    keyring,
    namespace: config.REDIS_KEY_PREFIX,
    origin: config.COLLECTIVIQ_BASE_URL,
    principalFingerprint: deriveUpstreamPrincipalFingerprint(keyring, {
      authMode: config.COLLECTIVIQ_AUTH_MODE,
      credentialMaterial: material,
    }),
    mappingTtlMs: config.OPENCODE_THREAD_REUSE_TTL_MS,
  });
}
