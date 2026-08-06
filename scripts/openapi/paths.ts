/** Shared filesystem locations for the OpenAPI contract tooling. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root (…/scripts/openapi -> repo root). */
export const REPO_ROOT = resolve(here, "..", "..");

/** The committed, deterministic filtered contract snapshot. */
export const COMMITTED_SNAPSHOT_PATH = resolve(
  REPO_ROOT,
  "contract",
  "collectiviq",
  "openapi-filtered.json",
);

/** Ignored session directory for review candidates produced by `refresh`. */
export const REFRESH_OUTPUT_DIR = resolve(REPO_ROOT, ".agent", "sessions", "openapi-refresh");
