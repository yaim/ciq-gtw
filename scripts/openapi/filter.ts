/**
 * Deterministic, offline OpenAPI contract filter for CollectivIQ.
 *
 * This module is pure (no network, no filesystem, no clock). It takes a full
 * OpenAPI document plus caller-supplied source metadata and produces a small,
 * stable, allowlisted contract snapshot for the ten operations the gateway
 * cares about. It fails closed on any drift from the shape the gateway relies
 * on (wrong OpenAPI major/minor, wrong API title, or a missing allowlisted
 * operation) so an incompatible upstream document can never be silently
 * committed.
 *
 * Descriptions and unrelated paths/components are excluded so that volatile
 * internal implementation detail is never imported into the repository. Only
 * schemas transitively referenced by the allowlisted operations are retained.
 */

/** One allowlisted upstream operation (method is lowercase). */
export interface AllowlistedOperation {
  readonly method: "get" | "post" | "delete";
  readonly path: string;
}

/**
 * The exact operations the gateway (production adapter + discovery tooling)
 * is permitted to know about. The extractor fails closed if any is absent.
 */
export const ALLOWLISTED_OPERATIONS: readonly AllowlistedOperation[] = [
  { method: "post", path: "/login" },
  { method: "post", path: "/create_thread" },
  { method: "post", path: "/process_message" },
  { method: "get", path: "/get_messages" },
  { method: "get", path: "/user/events" },
  { method: "get", path: "/available_llms" },
  { method: "post", path: "/abort_run" },
  { method: "get", path: "/thread_tokens" },
  { method: "get", path: "/thread_tokens/{combined_run_id}" },
  { method: "delete", path: "/delete_thread/{thread_id}" },
] as const;

/** Source metadata recorded alongside the filtered contract. */
export interface ContractMeta {
  /** The exact URL the full document was retrieved from. */
  readonly sourceUrl: string;
  /** UTC retrieval date (YYYY-MM-DD). */
  readonly retrievedAtUtc: string;
  /** SHA-256 hex digest of the complete downloaded document bytes. */
  readonly fullDocumentSha256: string;
  /** Number of paths in the complete document (context for drift review). */
  readonly fullPathCount: number;
}

/** The filtered, committed contract shape. */
export interface FilteredContract {
  readonly _meta: ContractMeta & {
    readonly note: string;
    readonly operationCount: number;
  };
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly securitySchemes: Record<string, unknown>;
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

/** Raised when the source document drifts from a shape we can rely on. */
export class OpenApiDriftError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`OpenAPI contract drift detected (${reasons.length} issue(s))`);
    this.name = "OpenApiDriftError";
    this.reasons = reasons;
  }
}

const SNAPSHOT_NOTE =
  "Filtered CollectivIQ contract snapshot. Descriptions and unrelated " +
  "paths/components are removed. The declared 200 response schemas are empty " +
  "in the source and therefore establish no runtime response contract; the " +
  "adapter's success shapes are provisional until verified by live discovery.";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RETRIEVED_AT = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively drop `description` keys; never mutates the input. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripDescriptions(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "description") continue;
      out[key] = stripDescriptions(inner);
    }
    return out;
  }
  return value;
}

/** Local component-schema name for a `#/components/schemas/X` ref, else null. */
function localSchemaRefName(ref: string): string | null {
  const prefix = "#/components/schemas/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

/** Collect every `#/components/schemas/*` name referenced within `value`. */
function collectSchemaRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "$ref" && typeof inner === "string") {
      const name = localSchemaRefName(inner);
      if (name !== null) into.add(name);
    } else {
      collectSchemaRefs(inner, into);
    }
  }
}

/** Retain only the fields of an operation that form a stable contract. */
function filterOperation(op: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("security" in op) out["security"] = stripDescriptions(op["security"]);

  if (Array.isArray(op["parameters"])) {
    out["parameters"] = op["parameters"].map((raw) => {
      const p = isRecord(raw) ? raw : {};
      return {
        name: p["name"],
        in: p["in"],
        required: p["required"] ?? false,
        schema: stripDescriptions(p["schema"]),
      };
    });
  }

  if (isRecord(op["requestBody"])) {
    const body = op["requestBody"];
    const content = isRecord(body["content"]) ? body["content"] : {};
    const filteredContent: Record<string, unknown> = {};
    for (const [contentType, media] of Object.entries(content)) {
      const schema = isRecord(media) ? media["schema"] : undefined;
      filteredContent[contentType] = { schema: stripDescriptions(schema) };
    }
    out["requestBody"] = {
      required: body["required"] ?? false,
      content: filteredContent,
    };
  }

  if (isRecord(op["responses"])) {
    const responses: Record<string, unknown> = {};
    for (const [status, raw] of Object.entries(op["responses"])) {
      const resp = isRecord(raw) ? raw : {};
      const filtered: Record<string, unknown> = {};
      if (isRecord(resp["content"])) {
        const content: Record<string, unknown> = {};
        for (const [contentType, media] of Object.entries(resp["content"])) {
          const schema = isRecord(media) ? media["schema"] : undefined;
          content[contentType] = { schema: stripDescriptions(schema) };
        }
        filtered["content"] = content;
      }
      responses[status] = filtered;
    }
    out["responses"] = responses;
  }

  return out;
}

/** Recursively sort object keys ascending for byte-stable serialization. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Build the filtered contract from a full OpenAPI document.
 * Throws {@link OpenApiDriftError} (with value-free reasons) on incompatible
 * drift. The returned object is deterministically key-sorted.
 */
export function buildFilteredContract(doc: unknown, meta: ContractMeta): FilteredContract {
  const reasons: string[] = [];

  if (!SHA256_HEX.test(meta.fullDocumentSha256)) reasons.push("meta.fullDocumentSha256 is invalid");
  if (!RETRIEVED_AT.test(meta.retrievedAtUtc)) reasons.push("meta.retrievedAtUtc is invalid");
  if (!Number.isInteger(meta.fullPathCount) || meta.fullPathCount < 1) {
    reasons.push("meta.fullPathCount is invalid");
  }

  if (!isRecord(doc)) {
    throw new OpenApiDriftError([...reasons, "document is not an object"]);
  }

  const openapi = doc["openapi"];
  if (typeof openapi !== "string" || !/^3\.1\./.test(openapi)) {
    reasons.push("openapi version is not 3.1.x");
  }

  const info = isRecord(doc["info"]) ? doc["info"] : {};
  if (info["title"] !== "CollectivIQ API") reasons.push("info.title is not 'CollectivIQ API'");
  const version = typeof info["version"] === "string" ? info["version"] : "";
  if (version === "") reasons.push("info.version is missing");

  const paths = isRecord(doc["paths"]) ? doc["paths"] : {};
  const filteredPaths: Record<string, Record<string, unknown>> = {};
  const refNames = new Set<string>();
  const securityNames = new Set<string>();

  for (const { method, path } of ALLOWLISTED_OPERATIONS) {
    const pathItem = paths[path];
    const op = isRecord(pathItem) ? pathItem[method] : undefined;
    if (!isRecord(op)) {
      reasons.push(`operation ${method.toUpperCase()} ${path} is missing`);
      continue;
    }
    const filtered = filterOperation(op);
    filteredPaths[path] ??= {};
    filteredPaths[path][method] = filtered;
    collectSchemaRefs(filtered, refNames);
    if (Array.isArray(filtered["security"])) {
      for (const requirement of filtered["security"]) {
        if (isRecord(requirement))
          for (const name of Object.keys(requirement)) securityNames.add(name);
      }
    }
  }

  // Fail closed before attempting to resolve schemas against a drifted document.
  if (reasons.length > 0) throw new OpenApiDriftError(reasons);

  // Transitively resolve the referenced component schemas.
  const components = isRecord(doc["components"]) ? doc["components"] : {};
  const sourceSchemas = isRecord(components["schemas"]) ? components["schemas"] : {};
  const includedSchemas: Record<string, unknown> = {};
  const queue = [...refNames];
  for (let head = 0; head < queue.length; head += 1) {
    const name = queue[head];
    if (name === undefined || name in includedSchemas) continue;
    const schema = sourceSchemas[name];
    if (schema === undefined) {
      reasons.push(`referenced schema '${name}' does not resolve`);
      continue;
    }
    const stripped = stripDescriptions(schema);
    includedSchemas[name] = stripped;
    const nested = new Set<string>();
    collectSchemaRefs(stripped, nested);
    for (const next of nested) if (!(next in includedSchemas)) queue.push(next);
  }

  // Retain only referenced security schemes.
  const sourceSecuritySchemes = isRecord(components["securitySchemes"])
    ? components["securitySchemes"]
    : {};
  const includedSecuritySchemes: Record<string, unknown> = {};
  for (const name of securityNames) {
    if (name in sourceSecuritySchemes) {
      includedSecuritySchemes[name] = stripDescriptions(sourceSecuritySchemes[name]);
    }
  }

  if (reasons.length > 0) throw new OpenApiDriftError(reasons);

  const contract: FilteredContract = {
    _meta: {
      sourceUrl: meta.sourceUrl,
      retrievedAtUtc: meta.retrievedAtUtc,
      fullDocumentSha256: meta.fullDocumentSha256,
      fullPathCount: meta.fullPathCount,
      operationCount: ALLOWLISTED_OPERATIONS.length,
      note: SNAPSHOT_NOTE,
    },
    openapi: openapi as string,
    info: { title: "CollectivIQ API", version },
    securitySchemes: includedSecuritySchemes,
    paths: filteredPaths,
    components: { schemas: includedSchemas },
  };

  return sortKeysDeep(contract) as FilteredContract;
}

/** Validate an already-built contract; returns value-free reasons (empty = ok). */
export function validateFilteredContract(contract: unknown): string[] {
  const reasons: string[] = [];
  if (!isRecord(contract)) return ["contract is not an object"];

  const openapi = contract["openapi"];
  if (typeof openapi !== "string" || !/^3\.1\./.test(openapi)) {
    reasons.push("openapi version is not 3.1.x");
  }
  const info = isRecord(contract["info"]) ? contract["info"] : {};
  if (info["title"] !== "CollectivIQ API") reasons.push("info.title is not 'CollectivIQ API'");

  const paths = isRecord(contract["paths"]) ? contract["paths"] : {};
  const seen = new Set<string>();
  for (const { method, path } of ALLOWLISTED_OPERATIONS) {
    const key = `${method} ${path}`;
    if (seen.has(key)) reasons.push(`duplicate operation ${key}`);
    seen.add(key);
    const item = paths[path];
    if (!isRecord(item) || !isRecord(item[method])) {
      reasons.push(`operation ${method.toUpperCase()} ${path} is missing`);
    }
  }

  const components = isRecord(contract["components"]) ? contract["components"] : {};
  const schemas = isRecord(components["schemas"]) ? components["schemas"] : {};
  const refs = new Set<string>();
  collectSchemaRefs({ paths, schemas }, refs);
  for (const name of refs) {
    if (!(name in schemas)) reasons.push(`referenced schema '${name}' does not resolve`);
  }

  return reasons;
}

/** The structural part of a contract, excluding volatile source metadata. */
export function contractCore(contract: unknown): unknown {
  if (!isRecord(contract)) return contract;
  const { _meta, ...rest } = contract;
  void _meta;
  return sortKeysDeep(rest);
}

/** Byte-stable canonical serialization (trailing newline) for snapshot files. */
export function serializeContract(contract: FilteredContract): string {
  return JSON.stringify(sortKeysDeep(contract), null, 2) + "\n";
}

/**
 * Compare two contracts' structural cores. Returns a list of top-level section
 * keys that differ (empty = identical). Volatile `_meta` is ignored.
 */
export function diffContractCores(committed: unknown, fresh: unknown): string[] {
  const a = contractCore(committed);
  const b = contractCore(fresh);
  if (!isRecord(a) || !isRecord(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : ["(root)"];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const differing: string[] = [];
  for (const key of [...keys].sort()) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) differing.push(key);
  }
  return differing;
}
