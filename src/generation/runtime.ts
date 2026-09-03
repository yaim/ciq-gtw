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
import { createCapacityController, createUnavailableCapacityController } from "./capacity.js";
import { createPoller } from "./polling.js";
import { createChatCompletionService, type ChatCompletionService } from "./chat-completion.js";
import { createIdGenerator, systemClock } from "./seams.js";
import { createTitleBridge, type TitleBridge } from "../opencode/title-bridge.js";
import { createToolCallIdGenerator, type ToolCallIdGenerator } from "../tools/index.js";
import { DISABLED_TELEMETRY, type Telemetry } from "../observability/telemetry.js";
import { instrumentAdapter } from "./adapter-telemetry.js";
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
  /**
   * Explicit controller override, highest precedence. A TEST seam: it replaces
   * whichever controller configuration would otherwise select.
   */
  readonly capacity?: CapacityController;
  /**
   * The optional CROSS-REPLICA capacity controller (Phase 4D). Unlike the field
   * above this is COMPOSITION wiring: it rides the process-owned Redis
   * connection, so the Redis composition root builds it and passes it here.
   *
   * Whether shared capacity is ON comes from `config.SHARED_CAPACITY_ENABLED`,
   * never from this field. Omitting it while the feature is enabled is an
   * unavailable dependency, not a disabled feature, and every completion then
   * fails closed with `503 capacity_unavailable` — never a silent downgrade to
   * per-replica limits, which would multiply the configured cluster-wide limit
   * by the replica count.
   */
  readonly sharedCapacity?: CapacityController;
  readonly poller?: Poller;
  readonly serializer?: PromptSerializer;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
  readonly titleBridge?: TitleBridge;
  readonly toolCallIds?: ToolCallIdGenerator;
  /**
   * Observability ports. Unlike the fields above this is COMPOSITION wiring, not
   * a test fake: the process root passes the telemetry it also closes on
   * shutdown. Omitted means fully disabled, so no gauge is bound, no adapter is
   * wrapped, and no span is created.
   */
  readonly telemetry?: Telemetry;
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

/**
 * Select the admission controller from validated configuration.
 *
 * Exactly three outcomes, and the third is the reason configuration — not the
 * presence of an injected object — is authoritative:
 *
 *  - shared capacity DISABLED (the default): the process-local controller of
 *    specification §19, byte-for-byte the pre-Phase-4D behaviour, with no scope
 *    derived and no Redis capacity operation ever issued;
 *  - shared capacity ENABLED and wired: the injected cross-replica controller;
 *  - shared capacity ENABLED but UNWIRED: a fail-closed controller that admits
 *    nothing. Falling back to the local controller here would silently multiply
 *    the configured cluster-wide limit by the replica count.
 */
function selectCapacity(config: AppConfig, seams: CompletionRuntimeSeams): CapacityController {
  if (seams.capacity !== undefined) return seams.capacity;
  if (!config.SHARED_CAPACITY_ENABLED) {
    return createCapacityController({
      maxConcurrent: config.MAX_CONCURRENT_REQUESTS,
      maxConcurrentPerKey: config.MAX_CONCURRENT_REQUESTS_PER_KEY,
      maxQueued: config.MAX_QUEUED_REQUESTS,
      maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    });
  }
  return seams.sharedCapacity ?? createUnavailableCapacityController();
}

/** Compose the completion runtime from validated configuration. */
export function createCompletionRuntime(
  config: AppConfig,
  seams: CompletionRuntimeSeams = {},
): CompletionRuntime {
  const capacity = selectCapacity(config, seams);
  const telemetry = seams.telemetry ?? DISABLED_TELEMETRY;
  // The two capacity gauges are pull based: binding a snapshot source keeps the
  // controller free of any metrics dependency and cannot perturb admission. The
  // source is whichever controller is ACTIVE, so the gauges follow the local or
  // the shared controller without either knowing about metrics. Both stay
  // PER-INSTANCE views either way — no replica can observe cluster occupancy.
  // Skipped outright when metrics are disabled, so a disabled gateway never
  // hands the controller to a port at all.
  if (telemetry.metrics.enabled) telemetry.metrics.bindCapacitySource(capacity);
  // Wrap the adapter BEFORE the poller is built so each individual
  // `get_messages` poll is measured too. The wrapper is transparent and is
  // skipped entirely when metrics are disabled.
  const adapter = instrumentAdapter(seams.adapter ?? buildAdapter(config), telemetry.metrics);
  const poller = seams.poller ?? createPoller(adapter);
  const serializer = seams.serializer ?? createPromptSerializer();
  const ids = seams.ids ?? createIdGenerator();
  const clock = seams.clock ?? systemClock;
  const toolCallIds = seams.toolCallIds ?? createToolCallIdGenerator();

  const chatService = createChatCompletionService({
    serializer,
    capacity,
    adapter,
    poller,
    ids,
    clock,
    toolCallIds,
    telemetry,
  });
  // The title bridge shares the same adapter (its OBSERVED-ONLY `getThreadTitle`)
  // and clock. Construction opens no socket and makes no CollectivIQ call.
  const titleBridge = seams.titleBridge ?? createTitleBridge({ adapter, clock });
  return { chatService, capacity, titleBridge };
}
