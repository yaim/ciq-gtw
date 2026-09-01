import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The compatibility suite (`test/compatibility`) and the adversarial
    // release-gate suite (`test/adversarial`) are hermetic but intentionally
    // separate from `validate`/CI; each is run only via its own npm script with
    // its own config. The Redis idempotency contract suite (`test/redis`)
    // additionally requires a running Redis at `REDIS_TEST_URL`, so it must
    // never enter the default run — `validate` stays hermetic and Redis-free.
    // Keep all three out of the default (and coverage) runs.
    exclude: [
      ...configDefaults.exclude,
      "test/compatibility/**",
      "test/adversarial/**",
      "test/redis/**",
    ],
    // The build smoke test runs compiled JavaScript directly via `npm run test:build`.
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
