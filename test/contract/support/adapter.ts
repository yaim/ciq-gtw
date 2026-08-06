/**
 * Test helpers for building the adapter against a mock server, with small,
 * overridable per-operation timeouts.
 */
import { CollectivIQHttpAdapter } from "../../../src/collectiviq/adapter.js";
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

export function makeAdapter(
  baseUrl: string,
  timeouts: OperationTimeouts = FAST_TIMEOUTS,
  overrides: Partial<CollectivIQTransportConfig> = {},
): CollectivIQHttpAdapter {
  return new CollectivIQHttpAdapter({
    baseUrl,
    apiKey: TEST_API_KEY,
    timeouts: { createThread: timeouts, processMessage: timeouts, getMessages: timeouts },
    ...overrides,
  });
}
