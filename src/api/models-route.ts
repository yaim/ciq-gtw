import { Type } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import { ModelListSchema, ModelObjectSchema, encodeModelList } from "../openai/models.js";
import { MODEL_NOT_FOUND_ERROR, OpenAIErrorSchema } from "../openai/errors.js";

/** Path parameters for `GET /v1/models/:model`. */
const ModelParams = Type.Object({ model: Type.String() });

/**
 * Register the public model catalog routes on an (already authenticated) route
 * group. Paths are relative to the group prefix, so they resolve to
 * `GET /v1/models` and `GET /v1/models/:model`.
 *
 * The handlers read only the public catalog; they never touch CollectivIQ or
 * internal model policy. An unknown or case-mismatched id returns the fixed
 * OpenAI `model_not_found` envelope without reflecting the submitted id.
 */
export function registerModelRoutes(app: GatewayServer, catalog: ModelCatalog): void {
  app.get(
    "/models",
    {
      schema: {
        response: {
          200: ModelListSchema,
          401: OpenAIErrorSchema,
          500: OpenAIErrorSchema,
        },
      },
    },
    () => encodeModelList(catalog.list()),
  );

  app.get(
    "/models/:model",
    {
      schema: {
        params: ModelParams,
        response: {
          200: ModelObjectSchema,
          401: OpenAIErrorSchema,
          404: OpenAIErrorSchema,
          500: OpenAIErrorSchema,
        },
      },
    },
    (request, reply) => {
      const resolved = catalog.resolve(request.params.model);
      if (resolved === undefined) {
        // Literal status keeps the typed response-schema union satisfied; the
        // value equals MODEL_NOT_FOUND_ERROR.status (404).
        reply.code(404);
        return MODEL_NOT_FOUND_ERROR.body;
      }
      return resolved;
    },
  );
}
