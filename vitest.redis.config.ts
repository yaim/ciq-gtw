import { defineConfig } from "vitest/config";

/**
 * Standalone config for the REAL-REDIS contract suites: Phase 4A idempotency
 * (`idempotency-store.test.ts`; specification sections 18.1, 22.2, 29.6) and
 * Phase 4B cross-replica rate limiting (`rate-limit-store.test.ts`; sections
 * 19.1, 29.7).
 *
 * Unlike every other suite in this repository, these tests require a running
 * Redis reachable at `REDIS_TEST_URL`. They are therefore kept OUT of ordinary
 * hermetic Vitest discovery (`vitest.config.ts` excludes `test/redis/**`) and
 * out of `npm run validate`, which must stay hermetic and Redis-free. CI runs
 * them as a SEPARATE required gate with a pinned Redis service.
 *
 * Both suites use only synthetic credentials and synthetic content, randomize
 * their Redis key prefix per run, and delete every key they create.
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
