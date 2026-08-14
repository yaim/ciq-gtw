import { defineConfig } from "vitest/config";

/**
 * Standalone config for the hermetic OpenAI-compatibility suite.
 *
 * This suite exercises the pinned `ai` / `@ai-sdk/openai-compatible` SDK against
 * an ephemeral loopback gateway with a fake completion implementation. It never
 * contacts CollectivIQ and never reads a real credential. It is intentionally
 * kept OUT of `validate`/CI (see `.agent/instructions/validation.md`) and is run
 * only via `npm run test:compatibility`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/compatibility/**/*.test.ts"],
    globals: false,
  },
});
