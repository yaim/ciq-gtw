/**
 * Production CollectivIQ adapter for the three core operations.
 *
 * This is the only implementation of {@link CollectivIQAdapter}. It owns the
 * request encodings (urlencoded thread creation, multipart message processing,
 * encoded polling query) and delegates transport, deadlines, size limits, and
 * cancellation to {@link requestUpstreamJson}. It never retries
 * `create_thread` or `process_message`, and it never implements polling or
 * desired-message selection — those belong to the generation layer.
 */
import { UpstreamError } from "./errors.js";
import { requestUpstreamJson } from "./http.js";
import {
  buildCreateThreadRequest,
  buildGetMessagesRequest,
  buildGetThreadsRequest,
  buildProcessMessageRequest,
} from "./requests.js";
import {
  normalizeCreateThread,
  normalizeGetMessages,
  normalizeGetThreadTitle,
  normalizeProcessMessage,
} from "./validation.js";
import {
  DEFAULT_OPERATION_TIMEOUTS,
  GET_THREADS_TIMEOUTS,
  type CollectivIQAdapter,
  type CollectivIQTransportConfig,
  type CreateThreadInput,
  type CreateThreadResult,
  type GetMessagesResult,
  type GetThreadTitleResult,
  type OperationTimeouts,
  type ProcessMessageInput,
  type ProcessMessageResult,
} from "./types.js";

export class CollectivIQHttpAdapter implements CollectivIQAdapter {
  readonly #config: CollectivIQTransportConfig;
  readonly #timeouts: {
    createThread: OperationTimeouts;
    processMessage: OperationTimeouts;
    getMessages: OperationTimeouts;
  };

  constructor(config: CollectivIQTransportConfig) {
    this.#config = config;
    this.#timeouts = {
      createThread: config.timeouts?.createThread ?? DEFAULT_OPERATION_TIMEOUTS.createThread,
      processMessage: config.timeouts?.processMessage ?? DEFAULT_OPERATION_TIMEOUTS.processMessage,
      getMessages: config.timeouts?.getMessages ?? DEFAULT_OPERATION_TIMEOUTS.getMessages,
    };
  }

  async createThread(input: CreateThreadInput): Promise<CreateThreadResult> {
    const { status, json } = await requestUpstreamJson(this.#config, {
      ...buildCreateThreadRequest({ title: input.title }),
      timeouts: this.#timeouts.createThread,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return normalizeCreateThread(json, status);
  }

  async processMessage(input: ProcessMessageInput): Promise<ProcessMessageResult> {
    if (input.threadId.trim() === "") {
      // Internal invariant: the gateway must always send a non-empty thread id.
      throw new UpstreamError("validation");
    }

    const { status, json } = await requestUpstreamJson(this.#config, {
      ...buildProcessMessageRequest({
        threadId: input.threadId,
        prompt: input.prompt,
        selectedLlms: input.selectedLlms,
        generateCombined: input.generateCombined,
      }),
      timeouts: this.#timeouts.processMessage,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return normalizeProcessMessage(json, status);
  }

  async getMessages(threadId: string, signal?: AbortSignal): Promise<GetMessagesResult> {
    if (threadId.trim() === "") {
      throw new UpstreamError("validation");
    }

    const { status, json } = await requestUpstreamJson(this.#config, {
      ...buildGetMessagesRequest({ threadId }),
      timeouts: this.#timeouts.getMessages,
      ...(signal ? { signal } : {}),
    });
    return normalizeGetMessages(json, status);
  }

  /**
   * OBSERVED-ONLY native-title lookup. Reads the target thread's server-generated
   * title via `get_threads` under bounded (5 s/5 s/4 MiB) transport with no
   * internal retry, and normalizes to a narrow pending/ready result. This creates
   * no thread and is never part of the completion flow. Best-effort and
   * account/principal-dependent; a lookup failure surfaces as a normalized
   * {@link UpstreamError}.
   */
  async getThreadTitle(threadId: string, signal?: AbortSignal): Promise<GetThreadTitleResult> {
    if (threadId.trim() === "") {
      throw new UpstreamError("validation");
    }

    const { status, json } = await requestUpstreamJson(this.#config, {
      ...buildGetThreadsRequest(),
      timeouts: this.#config.getThreadsTimeouts ?? GET_THREADS_TIMEOUTS,
      ...(signal ? { signal } : {}),
    });
    return normalizeGetThreadTitle(json, status, threadId);
  }
}
