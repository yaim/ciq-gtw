import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The compatibility suite (`test/compatibility`) is hermetic but intentionally
    // separate from `validate`/CI; it is run only via `npm run test:compatibility`
    // with its own config. Keep it out of the default (and coverage) runs.
    exclude: [...configDefaults.exclude, "test/compatibility/**"],
    // The build smoke test runs compiled JavaScript directly via `npm run test:build`.
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
