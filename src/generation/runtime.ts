/**
 * Completion runtime composition.
 *
 * Wires the validated configuration into the concrete completion pipeline
 * (credential provider → adapter → capacity → poller → prompt serializer →
 * completion service). Construction performs NO network or login I/O: the
 * adapter stores its config, and a password login is lazy. Every collaborator
 * is injectable so tests can supply fakes and so the process root can share the
 * capacity controller for shutdown.
 */
import type { AppConfig } from "../config/schema.js";
import { CollectivIQHttpAdapter } from "../collectiviq/adapter.js";
import { buildCredentialProviderFromConfig, RUNTIME_MAX_LOGINS } from "../collectiviq/auth.js";
import type { CollectivIQAdapter, TransportBase } from "../collectiviq/types.js";
import { createPromptSerializer } from "../prompts/serializer.js";
import { createCapacityController } from "./capacity.js";
import { createPoller } from "./polling.js";
import { createChatCompletionService, type ChatCompletionService } from "./chat-completion.js";
import { createIdGenerator, systemClock } from "./seams.js";
import { createTitleBridge, type TitleBridge } from "../opencode/title-bridge.js";
import type { CapacityController, Clock, IdGenerator, Poller, PromptSerializer } from "./types.js";

/** The completion pipeline plus the capacity controller the root drains. */
export interface CompletionRuntime {
  readonly chatService: ChatCompletionService;
  readonly capacity: CapacityController;
  /** Process-local native-title correlation service (best-effort OpenCode bridge). */
  readonly titleBridge: TitleBridge;
}

/** Optional injected collaborators (tests provide fakes; production omits them). */
export interface CompletionRuntimeSeams {
  readonly adapter?: CollectivIQAdapter;
  readonly capacity?: CapacityController;
  readonly poller?: Poller;
  readonly serializer?: PromptSerializer;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
  readonly titleBridge?: TitleBridge;
}

/** Build the upstream adapter from validated config (no I/O; login is lazy). */
function buildAdapter(config: AppConfig): CollectivIQAdapter {
  const base: TransportBase = { baseUrl: config.COLLECTIVIQ_BASE_URL };
  const { provider } = buildCredentialProviderFromConfig({
    mode: config.COLLECTIVIQ_AUTH_MODE,
    apiKey: config.COLLECTIVIQ_API_KEY,
    username: config.COLLECTIVIQ_USERNAME,
    password: config.COLLECTIVIQ_PASSWORD,
    base,
    maxLogins: RUNTIME_MAX_LOGINS,
  });
  return new CollectivIQHttpAdapter({
    baseUrl: config.COLLECTIVIQ_BASE_URL,
    credentials: provider,
  });
}

/** Compose the completion runtime from validated configuration. */
export function createCompletionRuntime(
  config: AppConfig,
  seams: CompletionRuntimeSeams = {},
): CompletionRuntime {
  const capacity =
    seams.capacity ??
    createCapacityController({
      maxConcurrent: config.MAX_CONCURRENT_REQUESTS,
      maxConcurrentPerKey: config.MAX_CONCURRENT_REQUESTS_PER_KEY,
      maxQueued: config.MAX_QUEUED_REQUESTS,
      maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    });
  const adapter = seams.adapter ?? buildAdapter(config);
  const poller = seams.poller ?? createPoller(adapter);
  const serializer = seams.serializer ?? createPromptSerializer();
  const ids = seams.ids ?? createIdGenerator();
  const clock = seams.clock ?? systemClock;

  const chatService = createChatCompletionService({
    serializer,
    capacity,
    adapter,
    poller,
    ids,
    clock,
  });
  // The title bridge shares the same adapter (its OBSERVED-ONLY `getThreadTitle`)
  // and clock. Construction opens no socket and makes no CollectivIQ call.
  const titleBridge = seams.titleBridge ?? createTitleBridge({ adapter, clock });
  return { chatService, capacity, titleBridge };
}
