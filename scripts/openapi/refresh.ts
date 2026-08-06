/**
 * `contract:openapi:refresh` — fetch the public OpenAPI document and write a
 * filtered review candidate beneath the ignored `.agent/sessions/` directory.
 *
 * This never modifies tracked files. A human reviews the candidate and, if the
 * drift is expected, promotes it to the committed snapshot deliberately. The
 * command requires network access and is therefore never part of `validate`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildFilteredContract, OpenApiDriftError, serializeContract } from "./filter.js";
import { fetchOpenApiDocument, OPENAPI_SOURCE_URL, utcDateStamp } from "./fetch-openapi.js";
import { REFRESH_OUTPUT_DIR } from "./paths.js";

async function main(): Promise<void> {
  const fetched = await fetchOpenApiDocument();
  const retrievedAtUtc = utcDateStamp();
  const contract = buildFilteredContract(fetched.doc, {
    sourceUrl: OPENAPI_SOURCE_URL,
    retrievedAtUtc,
    fullDocumentSha256: fetched.sha256,
    fullPathCount: fetched.pathCount,
  });

  mkdirSync(REFRESH_OUTPUT_DIR, { recursive: true });
  const outPath = resolve(REFRESH_OUTPUT_DIR, `openapi-filtered.${retrievedAtUtc}.json`);
  writeFileSync(outPath, serializeContract(contract), "utf8");

  process.stdout.write(
    [
      "OpenAPI refresh candidate written (review before promoting):",
      `  path:            ${outPath}`,
      `  full sha256:     ${fetched.sha256}`,
      `  full path count: ${fetched.pathCount}`,
      `  operations:      ${contract._meta.operationCount}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`openapi refresh failed: ${describe(error)}\n`);
    process.exitCode = 1;
  });
}

/** Value-free error description (never prints response bodies). */
function describe(error: unknown): string {
  if (error instanceof OpenApiDriftError) {
    return `drift detected -> ${error.reasons.join("; ")}`;
  }
  if (error instanceof Error && typeof error.name === "string") return error.name;
  return "unknown error";
}
