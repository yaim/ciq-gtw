/**
 * Test helpers for building the adapter against a mock server, with small,
 * overridable per-operation timeouts.
 */
import { CollectivIQHttpAdapter } from "../../../src/collectiviq/adapter.js";
import { staticBearerCredentialProvider } from "../../../src/collectiviq/auth.js";
import type {
  CollectivIQTransportConfig,
  OperationTimeouts,
} from "../../../src/collectiviq/types.js";

export const TEST_API_KEY = "sk-test-upstream-DO-NOT-LOG";

export const FAST_TIMEOUTS: OperationTimeouts = {
  headerTimeoutMs: 2_000,
  bodyTimeoutMs: 2_000,
  maxResponseBytes: 1_048_576,
};

/** A static bearer credential provider carrying the fixed synthetic test token. */
export function testCredentials() {
  return staticBearerCredentialProvider(TEST_API_KEY);
}

/**
 * Build a transport config using a static bearer provider (the fixed test
 * token). Extra fields (e.g. `fetch`, `timeouts`) can be merged via `overrides`.
 */
export function testTransportConfig(
  baseUrl: string,
  overrides: Partial<CollectivIQTransportConfig> = {},
): CollectivIQTransportConfig {
  return { baseUrl, credentials: staticBearerCredentialProvider(TEST_API_KEY), ...overrides };
}

export function makeAdapter(
  baseUrl: string,
  timeouts: OperationTimeouts = FAST_TIMEOUTS,
  overrides: Partial<CollectivIQTransportConfig> = {},
): CollectivIQHttpAdapter {
  return new CollectivIQHttpAdapter(
    testTransportConfig(baseUrl, {
      timeouts: { createThread: timeouts, processMessage: timeouts, getMessages: timeouts },
      ...overrides,
    }),
  );
}
