import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";
import type { GatewayAuthenticator } from "./gateway-auth.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import type { ChatCompletionService } from "../generation/chat-completion.js";
import { registerModelRoutes } from "./models-route.js";
import { registerChatCompletionsRoute } from "./chat-completions-route.js";
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
  }
}

/** Dependencies for the authenticated `/v1` route group. */
export interface V1RouteDeps {
  readonly authenticator: GatewayAuthenticator;
  readonly catalog: ModelCatalog;
  /** The chat-completions use case. */
  readonly chatService: ChatCompletionService;
  /** Aborts when the process begins its shutdown drain-cancel step. */
  readonly shutdownSignal: AbortSignal;
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

      // Default the identity so every request in this scope carries the property.
      scope.decorateRequest("gatewayKeyId", null);

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
        shutdownSignal: deps.shutdownSignal,
      });
      done();
    },
    { prefix: "/v1" },
  );
}
