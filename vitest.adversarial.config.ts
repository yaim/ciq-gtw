import { defineConfig } from "vitest/config";

/**
 * Standalone config for the ADVERSARIAL tool-protocol release-gate suite
 * (specification sections 29.4, 30).
 *
 * This suite runs a large deterministic corpus of hostile/malformed protocol
 * inputs against the pure tool engine (no sockets, no network, no CollectivIQ,
 * no credentials). It is a RELEASE GATE, not a fast unit check: it is
 * intentionally kept OUT of `validate`/CI (see `.agent/instructions/validation.md`)
 * and is run only via `npm run test:adversarial`.
 *
 * Passing this suite is necessary but NOT sufficient to declare emulated tool
 * mode production-ready — the numerical section-30 gates additionally require the
 * approval-gated live evaluator, which has not been run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/adversarial/**/*.test.ts"],
    globals: false,
  },
});
