/**
 * Virtual-model catalog and resolver (specification section 8.3).
 *
 * The catalog is the application-layer boundary that turns the validated
 * configuration models into the immutable, public OpenAI-shaped catalog served
 * by `GET /v1/models` and `GET /v1/models/:model`. It lives outside the
 * CollectivIQ adapter: it exposes no upstream wire knowledge and no internal
 * model policy (display name, selected sources, answer source, tool mode,
 * timeouts, credentials, config paths).
 *
 * A single Unix-seconds timestamp is captured when the catalog is constructed
 * and reused for every model object the catalog serves, so one server instance
 * reports a stable `created` value. A restart may capture a new timestamp.
 * Resolution is exact-case; an unknown id or a case mismatch does not resolve.
 */
import type { VirtualModel } from "../config/schema.js";
import { encodeModelObject, type ModelObject } from "../openai/models.js";

/** Immutable public catalog over the configured virtual models. */
export interface ModelCatalog {
  /** The captured Unix-seconds catalog timestamp shared by every model. */
  readonly created: number;
  /** Public model objects in configuration order (never mutates config). */
  list(): readonly ModelObject[];
  /** Resolve one public model object by exact-case id, or `undefined`. */
  resolve(id: string): ModelObject | undefined;
  /**
   * Resolve the INTERNAL virtual-model policy by exact-case id, or `undefined`.
   * This is used only by the generation layer; it exposes the model's execution
   * policy (selected sources, answer source, timeouts, prompt limits, tool mode)
   * and must never be encoded into a public response. The public `resolve`
   * above stays the only source for `GET /v1/models/:model` output.
   */
  resolveModel(id: string): VirtualModel | undefined;
}

/**
 * Build the immutable catalog from validated configuration models.
 *
 * @param models the validated virtual models, in configuration order.
 * @param created the Unix-seconds timestamp to stamp on every model object;
 *   captured once by the caller when the server/catalog is constructed.
 */
export function createModelCatalog(models: readonly VirtualModel[], created: number): ModelCatalog {
  // Encode public objects once, preserving configuration order. Only the id is
  // read from each model; no internal policy field is exposed.
  const ordered: readonly ModelObject[] = Object.freeze(
    models.map((model) => Object.freeze(encodeModelObject(model.id, created))),
  );
  // Exact-case lookup index. Later duplicates cannot occur: configured ids are
  // unique map keys, but a first-wins insert keeps resolution deterministic.
  const byId = new Map<string, ModelObject>();
  const policyById = new Map<string, VirtualModel>();
  for (const object of ordered) {
    if (!byId.has(object.id)) byId.set(object.id, object);
  }
  for (const model of models) {
    if (!policyById.has(model.id)) policyById.set(model.id, model);
  }

  return {
    created,
    list: () => ordered,
    resolve: (id: string) => byId.get(id),
    resolveModel: (id: string) => policyById.get(id),
  };
}
