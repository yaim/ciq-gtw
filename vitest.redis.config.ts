import { defineConfig } from "vitest/config";

/**
 * Standalone config for the three REAL-REDIS contract suites: Phase 4A
 * idempotency (`idempotency-store.test.ts`; specification sections 18.1, 22.2,
 * 29.6), Phase 4B cross-replica rate limiting (`rate-limit-store.test.ts`;
 * sections 19.1, 29.7), and Phase 5A OpenCode thread reuse
 * (`thread-reuse-store.test.ts`; section 5.1.1).
 *
 * Unlike every other suite in this repository, these tests require a running
 * Redis reachable at `REDIS_TEST_URL`. They are therefore kept OUT of ordinary
 * hermetic Vitest discovery (`vitest.config.ts` excludes `test/redis/**`) and
 * out of `npm run validate`, which must stay hermetic and Redis-free. CI runs
 * them as a SEPARATE required gate with a pinned Redis service.
 *
 * All three suites use only synthetic credentials and synthetic content,
 * randomize their Redis key prefix per run, and delete every key they create.
 *
 * They are the ONLY place the server-side Lua is actually executed, so they are
 * what proves a strict validator or an atomic transition really behaves as
 * written; the hermetic suites can only assert the scripts the store sends.
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
