import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";
import type { GatewayAuthenticator } from "./gateway-auth.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import type { ChatCompletionService } from "../generation/chat-completion.js";
import type { TitleBridge } from "../opencode/title-bridge.js";
import type { IdempotencyCoordinator } from "../idempotency/index.js";
import type { RateLimiter } from "../rate-limit/index.js";
import type { ThreadReuseCoordinator } from "../thread-reuse/index.js";
import { registerModelRoutes } from "./models-route.js";
import { registerChatCompletionsRoute } from "./chat-completions-route.js";
import { registerOpenCodeTitleRoute } from "./opencode-title-route.js";
import { markAuthenticated } from "./request-phase.js";
import { INTERNAL_ERROR, INVALID_API_KEY_ERROR } from "../openai/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Opaque, stable per-configured-key identity set by the `/v1` auth hook on
     * success (never the raw key). Used only for process-local per-key capacity.
     * `null` until authenticated.
     */
    gatewayKeyId: string | null;
    /**
     * Opaque, stable CROSS-REPLICA idempotency scope for the matched key (never
     * the raw key). Independent of gateway-key ordering, identical on every
     * replica sharing the encryption key, and never logged or reflected. `null`
     * until authenticated, and also `null` when idempotency is disabled.
     */
    gatewayScopeId: string | null;
    /**
     * Opaque, stable CROSS-REPLICA rate-limit scope for the matched key (never
     * the raw key), derived under a different HKDF domain than
     * {@link FastifyRequest.gatewayScopeId} so the two features never share a
     * value. Never logged or reflected. `null` until authenticated, and also
     * `null` when rate limiting is disabled.
     */
    gatewayRateLimitScopeId: string | null;
    /**
     * Opaque, stable CROSS-REPLICA OpenCode thread-reuse scope for the matched
     * key (never the raw key), derived under a THIRD independent HKDF domain so
     * it shares no value with {@link FastifyRequest.gatewayScopeId} or
     * {@link FastifyRequest.gatewayRateLimitScopeId}. Never logged or reflected.
     * `null` until authenticated, and also `null` when thread reuse is disabled.
     */
    gatewayReuseScopeId: string | null;
  }
}

/** Dependencies for the authenticated `/v1` route group. */
export interface V1RouteDeps {
  readonly authenticator: GatewayAuthenticator;
  readonly catalog: ModelCatalog;
  /** The chat-completions use case. */
  readonly chatService: ChatCompletionService;
  /** Process-local native-title correlation service (best-effort OpenCode bridge). */
  readonly titleBridge: TitleBridge;
  /** Aborts when the process begins its shutdown drain-cancel step. */
  readonly shutdownSignal: AbortSignal;
  /**
   * Optional cross-replica idempotency coordinator. Absent means Redis-backed
   * idempotency is disabled for this instance: unkeyed requests are unaffected
   * and a supplied `Idempotency-Key` fails closed with `503`.
   */
  readonly idempotency?: IdempotencyCoordinator;
  /**
   * Whether validated configuration turned rate limiting ON
   * (`RATE_LIMIT_ENABLED`). REQUIRED and authoritative — see
   * {@link ChatCompletionsRouteDeps.rateLimitEnabled}.
   */
  readonly rateLimitEnabled: boolean;
  /**
   * The cross-replica rate limiter (Phase 4B). Omitting it is safe ONLY when
   * {@link V1RouteDeps.rateLimitEnabled} is `false`; omitting it while the
   * feature is enabled makes every completion fail closed with `503`.
   */
  readonly rateLimiter?: RateLimiter;
  /**
   * Whether validated configuration turned OpenCode thread reuse ON
   * (`OPENCODE_THREAD_REUSE_ENABLED`). REQUIRED and authoritative — see
   * {@link ChatCompletionsRouteDeps.threadReuseEnabled}.
   */
  readonly threadReuseEnabled: boolean;
  /**
   * The cross-replica thread-reuse coordinator (Phase 5A). Omitting it is safe
   * ONLY when {@link V1RouteDeps.threadReuseEnabled} is `false`; omitting it
   * while the feature is enabled makes every ELIGIBLE completion fail closed
   * with `503` (ineligible completions are unaffected).
   */
  readonly threadReuse?: ThreadReuseCoordinator;
}

/**
 * Register the authenticated public `/v1` route group.
 *
 * The group is an encapsulated Fastify scope so its authentication hook and
 * error handler apply to every route registered under `/v1` — including the
 * chat-completions route — without touching `/healthz` or `/readyz`, which stay
 * unauthenticated on the root instance.
 *
 * - The `onRequest` hook authenticates the gateway key BEFORE any body parsing
 *   and returns the fixed `401` envelope for any missing/malformed/empty/
 *   oversized/incorrect credential. On success it records only an opaque
 *   per-key identity on the request.
 * - The scoped error handler maps any unexpected thrown value to the fixed
 *   `500` envelope. It never inspects the thrown value. (The chat route nests a
 *   child scope whose handler additionally maps framework parse errors.)
 */
export function registerV1Routes(app: GatewayServer, deps: V1RouteDeps): void {
  app.register(
    (instance, _opts, done) => {
      const scope = instance.withTypeProvider<TypeBoxTypeProvider>();

      // Default the identities so every request in this scope carries them.
      scope.decorateRequest("gatewayKeyId", null);
      scope.decorateRequest("gatewayScopeId", null);
      scope.decorateRequest("gatewayRateLimitScopeId", null);
      scope.decorateRequest("gatewayReuseScopeId", null);

      // Any unexpected failure inside the group becomes the fixed internal
      // envelope. The thrown value's message/stack/cause/body is never read.
      scope.setErrorHandler((_error, _request, reply) => {
        reply.code(INTERNAL_ERROR.status);
        return INTERNAL_ERROR.body;
      });

      scope.addHook("onRequest", async (request, reply) => {
        const result = deps.authenticator.authenticate(request.headers.authorization);
        if (!result.ok) {
          // Awaiting the sent reply completes the lifecycle, so no handler runs.
          // The body is the fixed authentication envelope.
          await reply.code(INVALID_API_KEY_ERROR.status).send(INVALID_API_KEY_ERROR.body);
          return;
        }
        request.gatewayKeyId = result.keyId;
        request.gatewayScopeId = result.scopeId;
        request.gatewayRateLimitScopeId = result.rateLimitScopeId;
        request.gatewayReuseScopeId = result.reuseScopeId;
        // Trusted provenance marker: authentication completed normally. The chat
        // route's error boundary uses this (plus the not-yet-in-handler marker)
        // to prove a subsequent throw came from Fastify's parser phase — the only
        // failures allowed to map to 400/413. An auth-hook throw never reaches
        // this line, so a forged Fastify-like error cannot spoof a parser error.
        markAuthenticated(request);
      });

      registerModelRoutes(scope, deps.catalog);
      registerChatCompletionsRoute(scope, {
        service: deps.chatService,
        catalog: deps.catalog,
        titleBridge: deps.titleBridge,
        shutdownSignal: deps.shutdownSignal,
        ...(deps.idempotency !== undefined ? { idempotency: deps.idempotency } : {}),
        rateLimitEnabled: deps.rateLimitEnabled,
        ...(deps.rateLimiter !== undefined ? { rateLimiter: deps.rateLimiter } : {}),
        threadReuseEnabled: deps.threadReuseEnabled,
        ...(deps.threadReuse !== undefined ? { threadReuse: deps.threadReuse } : {}),
      });
      // Rate limiting is scoped to the completion route ONLY: model metadata and
      // the session-title extension are cheap, non-generative reads that must
      // stay available while a key's completion quota is exhausted.
      // Authenticated CollectivIQ/OpenCode extension (not OpenAI-compatible).
      registerOpenCodeTitleRoute(scope, {
        titleBridge: deps.titleBridge,
        shutdownSignal: deps.shutdownSignal,
      });
      done();
    },
    { prefix: "/v1" },
  );
}
