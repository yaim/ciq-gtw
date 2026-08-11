import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";
import type { GatewayAuthenticator } from "./gateway-auth.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import { registerModelRoutes } from "./models-route.js";
import { INTERNAL_ERROR, INVALID_API_KEY_ERROR } from "../openai/errors.js";

/** Dependencies for the authenticated `/v1` route group. */
export interface V1RouteDeps {
  readonly authenticator: GatewayAuthenticator;
  readonly catalog: ModelCatalog;
}

/**
 * Register the authenticated public `/v1` route group.
 *
 * The group is an encapsulated Fastify scope so its authentication hook and
 * error handler apply to every route registered under `/v1` — including future
 * Chat Completions routes — without touching `/healthz` or `/readyz`, which stay
 * unauthenticated on the root instance.
 *
 * - The `onRequest` hook authenticates the gateway key and returns the fixed
 *   `401` envelope for any missing/malformed/empty/oversized/incorrect
 *   credential, before any handler runs.
 * - The scoped error handler maps any unexpected thrown value to the fixed
 *   `500` envelope. It never inspects the thrown value.
 */
export function registerV1Routes(app: GatewayServer, deps: V1RouteDeps): void {
  app.register(
    (instance, _opts, done) => {
      const scope = instance.withTypeProvider<TypeBoxTypeProvider>();

      // Any unexpected failure inside the group becomes the fixed internal
      // envelope. The thrown value's message/stack/cause/body is never read.
      scope.setErrorHandler((_error, _request, reply) => {
        reply.code(INTERNAL_ERROR.status);
        return INTERNAL_ERROR.body;
      });

      scope.addHook("onRequest", async (request, reply) => {
        if (!deps.authenticator.authenticate(request.headers.authorization)) {
          // Awaiting the sent reply completes the lifecycle, so no handler runs.
          // The body is the fixed authentication envelope.
          await reply.code(INVALID_API_KEY_ERROR.status).send(INVALID_API_KEY_ERROR.body);
        }
      });

      registerModelRoutes(scope, deps.catalog);
      done();
    },
    { prefix: "/v1" },
  );
}
