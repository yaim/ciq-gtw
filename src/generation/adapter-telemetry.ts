/**
 * Upstream operation metrics via a transparent adapter decorator
 * (specification section 23.2).
 *
 * The decorator lives in the generation layer, not in `src/collectiviq/`, so
 * the upstream boundary stays free of observability policy: it keeps owning
 * endpoint paths, wire schemas, and the normalized error model, and knows
 * nothing about registries or label vocabularies.
 *
 * It is the SINGLE owner of `collectiviq_gateway_upstream_requests_total` and
 * `collectiviq_gateway_upstream_request_duration_seconds`, and it counts EVERY
 * call — including each individual `get_messages` poll, which the orchestrator
 * never sees because the poller drives the adapter directly.
 *
 * It deliberately owns no SPANS. `collectiviq.create_thread`,
 * `collectiviq.process_message`, and `collectiviq.poll` are created by the
 * orchestrator, which holds the parent `gateway.request` span; a span started
 * here would be an orphaned root.
 *
 * Behaviour is otherwise byte-for-byte transparent: it never retries, never
 * swallows, never re-shapes, and never inspects a thrown value beyond asking
 * the shared abort signal whether the call was cancelled.
 */
import type {
  CollectivIQAdapter,
  CreateThreadInput,
  CreateThreadResult,
  GetMessagesResult,
  GetThreadTitleResult,
  ProcessMessageInput,
  ProcessMessageResult,
} from "../collectiviq/types.js";
import type { UpstreamOperation, UpstreamOutcome } from "../observability/labels.js";
import type { GatewayMetrics } from "../observability/metrics.js";
import { elapsedSeconds } from "../shared/elapsed.js";

/**
 * Wrap `adapter` so every upstream call is measured.
 *
 * Returns the adapter unchanged when metrics are disabled, so the disabled
 * gateway performs no extra allocation, timing, or indirection.
 */
export function instrumentAdapter(
  adapter: CollectivIQAdapter,
  metrics: GatewayMetrics,
): CollectivIQAdapter {
  if (!metrics.enabled) return adapter;

  /**
   * Time one upstream call. A rejection is classified only by whether the
   * caller's own signal had aborted — the thrown value is re-thrown untouched
   * and is never read, so a hostile value cannot influence a label.
   */
  const measure = async <T>(
    operation: UpstreamOperation,
    signal: AbortSignal | undefined,
    call: () => Promise<T>,
  ): Promise<T> => {
    const startNs = process.hrtime.bigint();
    let outcome: UpstreamOutcome = "success";
    try {
      return await call();
    } catch (error) {
      outcome = signal?.aborted === true ? "cancelled" : "error";
      throw error;
    } finally {
      metrics.observeUpstreamRequest({
        operation,
        outcome,
        durationSeconds: elapsedSeconds(startNs),
      });
    }
  };

  return {
    createThread: (input: CreateThreadInput): Promise<CreateThreadResult> =>
      measure("create_thread", input.signal, () => adapter.createThread(input)),
    processMessage: (input: ProcessMessageInput): Promise<ProcessMessageResult> =>
      measure("process_message", input.signal, () => adapter.processMessage(input)),
    getMessages: (threadId: string, signal?: AbortSignal): Promise<GetMessagesResult> =>
      measure("get_messages", signal, () => adapter.getMessages(threadId, signal)),
    getThreadTitle: (threadId: string, signal?: AbortSignal): Promise<GetThreadTitleResult> =>
      measure("get_threads", signal, () => adapter.getThreadTitle(threadId, signal)),
  };
}
