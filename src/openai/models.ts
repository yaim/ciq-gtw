/**
 * Public OpenAI-shaped model objects (specification sections 9.2–9.3).
 *
 * A public model object exposes only the four OpenAI fields — `id`, `object`,
 * `created`, and `owned_by`. The internal virtual-model policy (display name,
 * selected sources, answer source, tool mode, timeouts, credentials, config
 * paths) is never encoded here.
 */
import { Type, type Static } from "typebox";

/** Fixed owner reported for every gateway virtual model. */
export const MODEL_OWNED_BY = "collectiviq-gateway";

/** A single public model object. */
export const ModelObjectSchema = Type.Object(
  {
    id: Type.String(),
    object: Type.Literal("model"),
    created: Type.Integer(),
    owned_by: Type.Literal(MODEL_OWNED_BY),
  },
  { additionalProperties: false },
);

export type ModelObject = Static<typeof ModelObjectSchema>;

/** The `GET /v1/models` list envelope. */
export const ModelListSchema = Type.Object(
  {
    object: Type.Literal("list"),
    data: Type.Array(ModelObjectSchema),
  },
  { additionalProperties: false },
);

export type ModelList = Static<typeof ModelListSchema>;

/** Encode one public model object from an id and the catalog timestamp. */
export function encodeModelObject(id: string, created: number): ModelObject {
  return { id, object: "model", created, owned_by: MODEL_OWNED_BY };
}

/** Encode the `GET /v1/models` list envelope from ordered model objects. */
export function encodeModelList(models: readonly ModelObject[]): ModelList {
  return { object: "list", data: [...models] };
}
