/**
 * `contract:openapi:check` — fetch the public OpenAPI document, extract the
 * filtered contract in memory, and report any structural differences from the
 * committed snapshot. It never modifies tracked files and requires network
 * access, so it is not part of `validate` or CI.
 *
 * Exit code 0 means the committed snapshot still matches the live contract's
 * structure; exit code 1 means drift (or an incompatible document) was found.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildFilteredContract,
  diffContractCores,
  OpenApiDriftError,
  type FilteredContract,
} from "./filter.js";
import { fetchOpenApiDocument, OPENAPI_SOURCE_URL, utcDateStamp } from "./fetch-openapi.js";
import { COMMITTED_SNAPSHOT_PATH } from "./paths.js";

function readCommitted(): FilteredContract {
  const text = readFileSync(COMMITTED_SNAPSHOT_PATH, "utf8");
  return JSON.parse(text) as FilteredContract;
}

async function main(): Promise<void> {
  const committed = readCommitted();
  const fetched = await fetchOpenApiDocument();

  let fresh: FilteredContract;
  try {
    fresh = buildFilteredContract(fetched.doc, {
      sourceUrl: OPENAPI_SOURCE_URL,
      retrievedAtUtc: utcDateStamp(),
      fullDocumentSha256: fetched.sha256,
      fullPathCount: fetched.pathCount,
    });
  } catch (error) {
    if (error instanceof OpenApiDriftError) {
      process.stderr.write(
        `contract drift: the live document no longer matches the expected shape:\n` +
          error.reasons.map((r) => `  - ${r}`).join("\n") +
          "\n",
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const differences = diffContractCores(committed, fresh);
  const hashChanged = committed._meta.fullDocumentSha256 !== fetched.sha256;

  process.stdout.write(
    [
      "OpenAPI contract check:",
      `  committed sha256: ${committed._meta.fullDocumentSha256}`,
      `  live sha256:      ${fetched.sha256}`,
      `  full doc hash:    ${hashChanged ? "CHANGED" : "unchanged"}`,
      `  live path count:  ${fetched.pathCount}`,
      "",
    ].join("\n"),
  );

  if (differences.length === 0) {
    process.stdout.write("No structural differences in the allowlisted contract.\n");
    return;
  }
  process.stderr.write(
    `Structural differences found in section(s): ${differences.join(", ")}\n` +
      "Run `contract:openapi:refresh` and review the candidate before promoting.\n",
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`openapi check failed: ${name}\n`);
    process.exitCode = 1;
  });
}
