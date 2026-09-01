import { defineConfig } from "vitest/config";

/**
 * Standalone config for the REAL-REDIS idempotency contract suite (Phase 4A;
 * specification sections 18, 22.2, 29).
 *
 * Unlike every other suite in this repository, these tests require a running
 * Redis reachable at `REDIS_TEST_URL`. They are therefore kept OUT of ordinary
 * hermetic Vitest discovery (`vitest.config.ts` excludes `test/redis/**`) and
 * out of `npm run validate`, which must stay hermetic and Redis-free. CI runs
 * this suite as a SEPARATE required gate with a pinned Redis service.
 *
 * The suite uses only synthetic credentials and synthetic content, randomizes
 * its Redis key prefix per run, and deletes every key it creates.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/redis/**/*.test.ts"],
    globals: false,
    // Concurrency races are exercised explicitly inside individual tests; files
    // run serially so per-file key cleanup cannot interleave.
    fileParallelism: false,
  },
});
