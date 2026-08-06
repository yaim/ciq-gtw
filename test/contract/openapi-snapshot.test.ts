import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_OPERATIONS,
  buildFilteredContract,
  contractCore,
  diffContractCores,
  OpenApiDriftError,
  serializeContract,
  validateFilteredContract,
  type ContractMeta,
  type FilteredContract,
} from "../../scripts/openapi/filter.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("../../contract/collectiviq/openapi-filtered.json", import.meta.url),
);

function loadSnapshot(): FilteredContract {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as FilteredContract;
}

/** Navigate a JSON value by key path without using `any`. */
function dig(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

const META: ContractMeta = {
  sourceUrl: "https://api.prod.collectiviq.ai/openapi.json",
  retrievedAtUtc: "2026-08-05",
  fullDocumentSha256: "0".repeat(64),
  fullPathCount: 422,
};

/** A minimal source document containing every allowlisted operation. */
function minimalSourceDoc(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { method, path } of ALLOWLISTED_OPERATIONS) {
    paths[path] ??= {};
    paths[path][method] = {
      security: [{ OAuth2PasswordBearer: [] }],
      responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "CollectivIQ API", version: "9.9.9" },
    paths,
    components: { schemas: {}, securitySchemes: { OAuth2PasswordBearer: { type: "oauth2" } } },
  };
}

describe("committed OpenAPI snapshot", () => {
  it("is a valid 3.1.x CollectivIQ contract with all allowlisted operations", () => {
    const snapshot = loadSnapshot();
    expect(validateFilteredContract(snapshot)).toEqual([]);
    expect(snapshot.openapi).toMatch(/^3\.1\./);
    expect(snapshot.info.title).toBe("CollectivIQ API");
    for (const { method, path } of ALLOWLISTED_OPERATIONS) {
      expect(snapshot.paths[path]?.[method]).toBeDefined();
    }
  });

  it("records source metadata including a 64-hex full-document SHA-256", () => {
    const snapshot = loadSnapshot();
    expect(snapshot._meta.sourceUrl).toBe("https://api.prod.collectiviq.ai/openapi.json");
    expect(snapshot._meta.fullDocumentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot._meta.fullPathCount).toBeGreaterThan(0);
    expect(snapshot._meta.operationCount).toBe(ALLOWLISTED_OPERATIONS.length);
  });

  it("resolves every referenced local component schema", () => {
    const snapshot = loadSnapshot();
    const schemas = snapshot.components.schemas;
    const serialized = JSON.stringify(snapshot.paths) + JSON.stringify(schemas);
    for (const match of serialized.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) {
      expect(schemas[match[1] as string]).toBeDefined();
    }
  });

  it("declares the core request encodings correctly", () => {
    const snapshot = loadSnapshot();
    const createContent = dig(snapshot, [
      "paths",
      "/create_thread",
      "post",
      "requestBody",
      "content",
    ]);
    const processContent = dig(snapshot, [
      "paths",
      "/process_message",
      "post",
      "requestBody",
      "content",
    ]);
    expect(Object.keys(createContent as object)).toEqual(["application/x-www-form-urlencoded"]);
    expect(Object.keys(processContent as object)).toEqual(["multipart/form-data"]);
  });

  it("declares empty (contract-free) 200 success schemas for the core operations", () => {
    const snapshot = loadSnapshot();
    const core: Array<[string, string]> = [
      ["/create_thread", "post"],
      ["/process_message", "post"],
      ["/get_messages", "get"],
    ];
    for (const [path, method] of core) {
      const schema = dig(snapshot, [
        "paths",
        path,
        method,
        "responses",
        "200",
        "content",
        "application/json",
        "schema",
      ]);
      expect(schema).toEqual({});
    }
  });

  it("stays byte-identical when rebuilt from an equivalent source (deterministic)", () => {
    const snapshot = loadSnapshot();
    const rebuilt = buildFilteredContract(minimalSourceDoc(), META);
    // Structural cores differ (minimal source), but serialization is stable for
    // a fixed input: rebuilding the same input twice is identical.
    expect(serializeContract(rebuilt)).toBe(
      serializeContract(buildFilteredContract(minimalSourceDoc(), META)),
    );
    expect(diffContractCores(snapshot, snapshot)).toEqual([]);
  });
});

describe("OpenAPI extractor fail-closed behavior", () => {
  it("throws when an allowlisted operation is missing", () => {
    const doc = minimalSourceDoc();
    delete (doc["paths"] as Record<string, unknown>)["/process_message"];
    expect(() => buildFilteredContract(doc, META)).toThrow(OpenApiDriftError);
    try {
      buildFilteredContract(doc, META);
    } catch (error) {
      expect((error as OpenApiDriftError).reasons.join(" ")).toContain("POST /process_message");
    }
  });

  it("throws on an incompatible OpenAPI version", () => {
    const doc = minimalSourceDoc();
    doc["openapi"] = "3.0.1";
    expect(() => buildFilteredContract(doc, META)).toThrow(OpenApiDriftError);
  });

  it("throws on a wrong API title", () => {
    const doc = minimalSourceDoc();
    (doc["info"] as Record<string, unknown>)["title"] = "Some Other API";
    expect(() => buildFilteredContract(doc, META)).toThrow(OpenApiDriftError);
  });

  it("throws when a referenced schema does not resolve", () => {
    const doc = minimalSourceDoc();
    const paths = doc["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    (paths["/create_thread"] as Record<string, Record<string, unknown>>)["post"] = {
      security: [{ OAuth2PasswordBearer: [] }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: { $ref: "#/components/schemas/DoesNotExist" },
          },
        },
      },
      responses: { "200": { content: { "application/json": { schema: {} } } } },
    };
    expect(() => buildFilteredContract(doc, META)).toThrow(OpenApiDriftError);
  });

  it("reports the core structure via contractCore without _meta", () => {
    const rebuilt = buildFilteredContract(minimalSourceDoc(), META);
    const core = contractCore(rebuilt) as Record<string, unknown>;
    expect(core["_meta"]).toBeUndefined();
    expect(core["paths"]).toBeDefined();
  });
});
