/**
 * `POST /v1/chat/completions` — the authenticated, text-only completion route
 * (specification sections 9.4, 14). It serves both the non-streamed JSON path
 * (`stream` absent/`false`) and the synthetic-SSE path (`stream: true`) through
 * one bounded orchestration.
 *
 * Registered inside the already-authenticated `/v1` scope, so the gateway-auth
 * `onRequest` hook runs BEFORE any body parsing or use-case work. This route
 * lives in its own encapsulated child scope with a dedicated error handler so
 * Fastify content-type/parse/body-limit errors map to stable OpenAI envelopes
 * (never the generic `500`, and never serializing a framework error message).
 *
 * The handler validates and normalizes the request, resolves the internal model
 * policy, wires client-disconnect + shutdown cancellation, and PREPARES the
 * prompt (resolve + serialize + bound; mint the stream-stable identity) — all
 * before any response header is committed, so a preparation failure stays a
 * normal JSON error. It then delegates to `service.run` and encodes the result
 * as JSON, or hands the streamed path to {@link streamChatCompletion} which
 * commits SSE headers and owns all response output. Success and every failure
 * produce a bounded, content-free response; a disconnected client receives no
 * body.
 *
 * Admission order (both transports):
 *
 * ```text
 * gateway authentication (the /v1 onRequest hook)
 *   -> request validation, model resolution, tool normalization
 *   -> Idempotency-Key validation and canonical body fingerprinting
 *   -> thread-reuse eligibility                 -> 400 invalid_opencode_session_id
 *                                               -> 400 unsupported_parameter
 *   -> keyed request with unusable idempotency  -> 503 idempotency_unavailable
 *   -> prompt preparation
 *   -> cross-replica rate limit                 -> 429 / 503 (§19.1)
 *   -> OpenCode thread-reuse lease              -> 409 / 503 (§5.1.1)
 *   -> idempotency claim, wait, or replay       -> 409 / 503 / cached result
 *   -> process-local FIFO queue + capacity      -> 429 gateway_capacity_exceeded
 *      (optionally a shared active permit, §19.2) -> 503 capacity_unavailable
 *   -> upstream work
 * ```
 *
 * The capacity step is the same step in both capacity modes and stays inside
 * `service.run`: with `SHARED_CAPACITY_ENABLED=false` it is purely process
 * local, and with it enabled the local FIFO queue additionally acquires a
 * cluster-wide active permit (specification §19.2). Nothing above the capacity
 * port moves, so a streamed request still reaches it AFTER the SSE headers and
 * the assistant-role opener — which is why a capacity failure on that transport
 * is a safe SSE error record rather than an HTTP status.
 *
 * Thread reuse and idempotency are mutually exclusive by construction: an
 * eligible reuse request carrying an `Idempotency-Key` is rejected above, before
 * either feature touches Redis, so the claim and the lease can never both exist.
 */
import { Type } from "@fastify/type-provider-typebox";
import type { FastifyError } from "fastify";
import type { GatewayServer } from "../server.js";
import { isAuthenticated, isHandlerStarted, markHandlerStarted } from "./request-phase.js";
import { requestTelemetry } from "./request-telemetry.js";
import { toErrorCategory } from "../observability/labels.js";
import { DISABLED_TELEMETRY, type Telemetry } from "../observability/telemetry.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import {
  ChatCompletionError,
  isChatCompletionError,
  isRequestCancelledError,
  type ChatCompletionService,
  type CompletionResult,
  type CompletionRunOptions,
  type PreparedCompletion,
} from "../generation/chat-completion.js";
import type { TitleBridge } from "../opencode/title-bridge.js";
import {
  SESSION_ID_HEADER,
  hasSessionIdHeader,
  normalizeSessionId,
} from "../opencode/session-header.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  readIdempotencyKeyHeader,
  type CachedCompletion,
  type CachedResult,
  type IdempotencyCoordinator,
  type IdempotencyOwnerSession,
} from "../idempotency/index.js";
import { validateChatRequest } from "../openai/chat-request.js";
import { ChatCompletionSchema, encodeChatCompletion } from "../openai/chat-response.js";
import { streamChatCompletion } from "./chat-stream-response.js";
import type { RateLimiter } from "../rate-limit/index.js";
import type { ThreadReuseCoordinator, ThreadReuseSession } from "../thread-reuse/index.js";
import {
  COMPLETION_TIMEOUT_ERROR,
  gatewayRateLimitExceeded,
  IDEMPOTENCY_KEY_CONFLICT_ERROR,
  IDEMPOTENCY_UNAVAILABLE_ERROR,
  IDEMPOTENCY_WITH_THREAD_REUSE_ERROR,
  INTERNAL_ERROR,
  INVALID_IDEMPOTENCY_KEY_ERROR,
  INVALID_OPENCODE_SESSION_ID_ERROR,
  INVALID_REQUEST_ERROR,
  OpenAIErrorSchema,
  RATE_LIMIT_UNAVAILABLE_ERROR,
  REQUEST_BODY_TOO_LARGE_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
  THREAD_REUSE_BUSY_ERROR,
  THREAD_REUSE_UNAVAILABLE_ERROR,
  type OpenAIApiError,
} from "../openai/errors.js";

/**
 * Fixed `Retry-After`, in seconds, for a `429` whose envelope does not carry its
 * own value — process-local capacity and upstream quota (specification §19).
 * The rate limiter instead computes an exact per-response delay, which its
 * envelope supplies and which overrides this default for that response only.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Dependencies for the chat-completions route. */
export interface ChatCompletionsRouteDeps {
  readonly service: ChatCompletionService;
  readonly catalog: ModelCatalog;
  /** Process-local native-title correlation service (best-effort OpenCode bridge). */
  readonly titleBridge: TitleBridge;
  /** Aborts when the process begins its shutdown drain-cancel step. */
  readonly shutdownSignal: AbortSignal;
  /**
   * Optional cross-replica idempotency coordinator (Phase 4A). Absent means the
   * feature is disabled for this instance: unkeyed requests are completely
   * unaffected, and a supplied `Idempotency-Key` fails closed with `503`.
   */
  readonly idempotency?: IdempotencyCoordinator;
  /**
   * Whether validated configuration turned rate limiting ON
   * (`RATE_LIMIT_ENABLED`). This is REQUIRED and authoritative: configuration,
   * not the presence of an injected object, decides whether the gate runs.
   * Enabled-but-unwired must fail closed rather than silently admit unmetered
   * traffic, so the flag cannot be inferred from {@link rateLimiter}.
   */
  readonly rateLimitEnabled: boolean;
  /**
   * The cross-replica per-gateway-key rate limiter (Phase 4B).
   *
   * Omitting it is safe ONLY when {@link rateLimitEnabled} is `false` — that is
   * the consistent disabled state, in which no limiter or Redis operation ever
   * runs. Omitting it while the feature is ENABLED is an unavailable dependency,
   * not a disabled feature, and every completion then fails closed with `503`.
   */
  readonly rateLimiter?: RateLimiter;
  /**
   * Whether validated configuration turned OpenCode thread reuse ON
   * (`OPENCODE_THREAD_REUSE_ENABLED`, specification §5.1.1). REQUIRED and
   * authoritative for exactly the same reason as {@link rateLimitEnabled}: an
   * enabled-but-unwired instance must fail closed on eligible requests rather
   * than silently serve them statelessly, which would break the session
   * continuity the feature exists to provide.
   */
  readonly threadReuseEnabled: boolean;
  /**
   * The cross-replica thread-reuse coordinator (Phase 5A).
   *
   * Omitting it is safe ONLY when {@link threadReuseEnabled} is `false`.
   * Omitting it while the feature is ENABLED is an unavailable dependency, so
   * every ELIGIBLE completion fails closed with `503`; requests that are not
   * reuse eligible are entirely unaffected.
   */
  readonly threadReuse?: ThreadReuseCoordinator;
  /**
   * Observability ports (specification section 23). Telemetry is recorded
   * around the EXISTING admission order and never changes it: no gate moves, no
   * status changes, and a disabled telemetry port allocates nothing.
   */
  readonly telemetry?: Telemetry;
}

/**
 * Project a live completion result onto the cacheable shape.
 *
 * This is where the internal `upstreamThreadId` is DROPPED: it is used only for
 * process-local native-title correlation and is deliberately never persisted
 * (specification sections 9.5, 22.2).
 */
function toCachedResult(result: CompletionResult): CachedResult {
  return result.kind === "tool_calls"
    ? { kind: "tool_calls", toolCalls: result.toolCalls }
    : { kind: "text", content: result.content };
}

/** Diagnostic header listing accepted-but-ignored optional parameter names. */
const IGNORED_HEADER = "x-collectiviq-ignored-parameters";

/**
 * Classify a genuine framework parser/body-limit failure into a stable OpenAI
 * envelope, or `null` to fail closed to the fixed `500`. It is called ONLY after
 * the trusted request-phase markers prove the throw originated in Fastify's
 * parsing phase (auth completed, handler not started); an auth/hook/application
 * failure never reaches it. Its `code`/`statusCode` reads are additionally
 * guarded so any anomaly still fails closed.
 */
function classifyFrameworkError(error: unknown): OpenAIApiError | null {
  try {
    if (!(error instanceof Error)) return null;
    const code = (error as FastifyError).code;
    switch (code) {
      case "FST_ERR_CTP_BODY_TOO_LARGE":
        return REQUEST_BODY_TOO_LARGE_ERROR;
      case "FST_ERR_CTP_EMPTY_JSON_BODY":
      case "FST_ERR_CTP_INVALID_JSON":
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      case "FST_ERR_CTP_EMPTY_TYPE":
        return INVALID_REQUEST_ERROR;
      default:
        break;
    }
    // Some parse/unsupported-media/body-limit errors carry only a 4xx statusCode.
    const status = (error as FastifyError).statusCode;
    if (status === 413) return REQUEST_BODY_TOO_LARGE_ERROR;
    if (status === 400 || status === 415) return INVALID_REQUEST_ERROR;
    return null;
  } catch {
    // Fail closed on any unexpected access failure.
    return null;
  }
}

/** Register the chat-completions route in an encapsulated child scope. */
export function registerChatCompletionsRoute(
  app: GatewayServer,
  deps: ChatCompletionsRouteDeps,
): void {
  app.register((instance, _opts, done) => {
    // Fail-closed error boundary gated on trusted request PROVENANCE, not on the
    // structure of the thrown value. A framework parser/body-limit failure may
    // map to 400/413 ONLY when authentication has completed (`isAuthenticated`)
    // AND the handler body has not begun (`!isHandlerStarted`) — the exact window
    // in which nothing but Fastify's own parser runs. In every other case the
    // thrown value is an auth-hook or application failure and returns the fixed
    // 500 WITHOUT being inspected, serialized, logged, reflected, or re-thrown —
    // so a forged Fastify-like `code`/`statusCode` cannot spoof a parser error
    // and a hostile Proxy's traps are never triggered.
    instance.setErrorHandler((error, request, reply) => {
      const fromParserPhase = isAuthenticated(request) && !isHandlerStarted(request);
      const chosen = fromParserPhase
        ? (classifyFrameworkError(error) ?? INTERNAL_ERROR)
        : INTERNAL_ERROR;
      // The category comes from the envelope the gateway just chose, never from
      // the thrown value, which is still never inspected here.
      requestTelemetry(request)?.recordError(toErrorCategory(chosen.body.error.code));
      reply.code(chosen.status);
      return chosen.body;
    });

    instance.post(
      "/chat/completions",
      {
        schema: {
          // The request body is validated by the normalizer (not Fastify) so
          // rejections are stable, content-free OpenAI envelopes.
          body: Type.Unknown(),
          response: {
            200: ChatCompletionSchema,
            400: OpenAIErrorSchema,
            401: OpenAIErrorSchema,
            404: OpenAIErrorSchema,
            409: OpenAIErrorSchema,
            413: OpenAIErrorSchema,
            429: OpenAIErrorSchema,
            502: OpenAIErrorSchema,
            503: OpenAIErrorSchema,
            504: OpenAIErrorSchema,
            500: OpenAIErrorSchema,
          },
        },
      },
      async (request, reply) => {
        // Mark that handler execution has begun: from here on, any thrown value
        // reaching the error handler is an application error and fails closed.
        markHandlerStarted(request);

        const telemetry = deps.telemetry ?? DISABLED_TELEMETRY;
        const rt = requestTelemetry(request);
        // Resolved per request from ports whose `enabled` is fixed at
        // construction. Every telemetry statement below is guarded by one of
        // these, so a disabled gateway builds no span options and calls neither
        // port; `rt.span` is `null` for the same reason.
        const metricsOn = telemetry.metrics.enabled;
        const tracingOn = telemetry.tracing.enabled;

        const sendError = (apiError: OpenAIApiError): OpenAIApiError["body"] => {
          // Closed category read from the gateway's OWN envelope. This is what
          // keeps capacity, rate-limit, idempotency, and thread-reuse failures
          // individually distinguishable in `errors_total`.
          rt?.recordError(toErrorCategory(apiError.body.error.code));
          // Every envelope status is a declared response code; the cast satisfies
          // the typed reply without widening the public contract.
          reply.code(apiError.status as 400 | 401 | 404 | 409 | 413 | 429 | 502 | 503 | 504 | 500);
          // An envelope that carries its own value wins (the rate limiter's exact
          // delay, idempotency's fixed `2`); every other `429` keeps the
          // long-standing fixed `5`.
          const retryAfter =
            apiError.retryAfterSeconds ??
            (apiError.status === 429 ? DEFAULT_RETRY_AFTER_SECONDS : undefined);
          if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));
          return apiError.body;
        };

        // Validate + normalize against the resolved model policy; the raw body
        // never flows past this point. The validator resolves the INTERNAL model
        // policy (never exposed to the client) so the model-aware tool-metadata
        // bridge runs inside the boundary that already owns raw-body access.
        // `rt` is non-null whenever either port is enabled, so the handle reads
        // inside this branch are safe; the fallbacks keep the compiler honest.
        const validateSpan = tracingOn
          ? telemetry.tracing.startSpan("gateway.validate", {
              ...(rt?.span != null ? { parent: rt.span } : {}),
              attributes: { endpoint: rt?.endpoint ?? "other" },
            })
          : null;
        let validated: ReturnType<typeof validateChatRequest>;
        try {
          validated = validateChatRequest(request.body, (id) => deps.catalog.resolveModel(id));
        } catch (error) {
          // The validator is designed never to throw on a hostile body, but a
          // span must not be left open if it ever did. The request still fails
          // closed through the scope's error handler, whose envelope is the
          // fixed internal error — the trusted category recorded here.
          validateSpan?.setError("internal_error");
          validateSpan?.end();
          throw error;
        }
        if (!validated.ok) {
          // A rejection whose `param` is `tools` means the SUBMITTED tool
          // definitions could not be compiled or bounded — the single owner of
          // `tool_schema_failures_total`. The model is unknown at this point on
          // some paths, so it is reported as `null` rather than guessed.
          if (metricsOn && validated.error.body.error.param === "tools") {
            telemetry.metrics.observeToolSchemaFailure(null);
          }
          // Read inside the optional call, so a disabled tracer performs no
          // property loads for a value only the span would use.
          validateSpan?.setError(toErrorCategory(validated.error.body.error.code));
          validateSpan?.end();
          return sendError(validated.error);
        }
        const normalized = validated.request;
        const model = validated.model;
        // Model and tool metadata are recorded only AFTER successful validation,
        // so a rejected request can never introduce an unresolved label value.
        rt?.setModel(model.id);
        if (validateSpan !== null) {
          rt?.span?.setAttributes({ model: model.id, toolMode: model.toolMode });
          validateSpan.setAttributes({ model: model.id, toolMode: model.toolMode });
          validateSpan.end();
        }

        // The auth hook guarantees an identity before the handler runs.
        const keyId = request.gatewayKeyId;
        if (keyId === null) return sendError(INTERNAL_ERROR);

        // Optional cross-replica idempotency (specification section 18). The
        // header is read AFTER normal request validation so an invalid body
        // still produces its usual error, and the body is fingerprinted while
        // the ORIGINAL parsed value is still available — every submitted field
        // participates, including tolerated-and-discarded tool metadata.
        const header = readIdempotencyKeyHeader(
          request.headers[IDEMPOTENCY_KEY_HEADER],
          request.raw.rawHeaders,
        );
        if (header.kind === "invalid") return sendError(INVALID_IDEMPOTENCY_KEY_ERROR);

        // --- OpenCode thread-reuse eligibility (specification §5.1.1) --------
        // Decided here, before ANY Redis operation, capacity, or upstream work,
        // and before the keyed-idempotency availability check below, so the two
        // mutually exclusive features can never both engage.
        //
        // Eligibility is narrow on purpose: reuse only applies to the
        // direct-prompt, tool-free profile whose turns are plain text. A
        // protocol-mode model resubmits its whole history every turn and an
        // emulated tool loop creates a thread per round; making either stateful
        // would change their prompt semantics, which this phase does not do.
        const rawSessionHeader = request.headers[SESSION_ID_HEADER];
        const sessionId = normalizeSessionId(rawSessionHeader);
        const reuseCandidate =
          deps.threadReuseEnabled &&
          model.promptMode === "direct" &&
          model.toolMode === "disabled" &&
          hasSessionIdHeader(rawSessionHeader);
        if (reuseCandidate && sessionId === null) {
          // The caller asked for a session-scoped conversation and got the
          // header wrong. Silently ignoring it (the pre-Phase-5A behaviour, kept
          // for every ineligible request) would strand each turn in its own
          // thread with no signal, so an eligible model reports it.
          return sendError(INVALID_OPENCODE_SESSION_ID_ERROR);
        }
        const reuseSessionId = reuseCandidate ? sessionId : null;
        if (reuseSessionId !== null && header.kind === "key") {
          // Rejected BEFORE rate limiting, any reuse Redis operation, capacity,
          // and any upstream call.
          return sendError(IDEMPOTENCY_WITH_THREAD_REUSE_ERROR);
        }

        let claim: {
          readonly coordinator: IdempotencyCoordinator;
          readonly clientKey: string;
          readonly scopeId: string;
          readonly fingerprint: string;
        } | null = null;
        if (header.kind === "key") {
          // A supplied key REQUIRES configured, healthy Redis. Failing closed
          // here means no completion work is started for a request whose
          // idempotency guarantee the gateway cannot honour.
          const coordinator = deps.idempotency;
          const scopeId = request.gatewayScopeId;
          if (coordinator === undefined || scopeId === null || !coordinator.isAvailable()) {
            return sendError(IDEMPOTENCY_UNAVAILABLE_ERROR);
          }
          const fingerprint = coordinator.fingerprintBody(request.body);
          if (!fingerprint.ok) return sendError(INVALID_IDEMPOTENCY_KEY_ERROR);
          claim = {
            coordinator,
            clientKey: header.value,
            scopeId,
            fingerprint: fingerprint.fingerprint,
          };
        }

        // Native-title correlation (best-effort). A valid OpenCode session header
        // arms a one-thread title bridge; an absent/malformed header simply skips
        // it and the completion behaves normally. The header value is never logged
        // or reflected. Registration happens ONLY after a confirmed success and is
        // synchronous, bounded, and non-throwing, so it cannot alter the response.
        //
        // A REUSED thread registers nothing: the provider generates its native
        // title once, for the turn that created the thread, so a later turn has
        // no new title to propagate and re-registering would only spend the
        // bridge's bounded lookup budget.
        const registerTitleCorrelation = (result: CompletionResult): void => {
          if (sessionId === null) return;
          if (!result.upstreamThreadCreated) return;
          deps.titleBridge.register({
            keyId,
            sessionId,
            upstreamThreadId: result.upstreamThreadId,
          });
        };

        // Combine client-disconnect and shutdown into one request abort signal.
        // The response socket's `close` event is the canonical client-disconnect
        // signal: it fires when the connection is terminated before the response
        // has finished (`writableEnded` guards against the normal-completion
        // close, which also emits this event).
        const clientAbort = new AbortController();
        const onClose = (): void => {
          if (!reply.raw.writableEnded) clientAbort.abort();
        };
        reply.raw.on("close", onClose);
        const signal = AbortSignal.any([clientAbort.signal, deps.shutdownSignal]);

        // Prepare (resolve + serialize + bound the prompt, mint the stream-stable
        // identity) BEFORE committing any SSE header. A preparation failure (e.g.
        // an oversized prompt) always stays a normal JSON error — never SSE.
        let prepared: PreparedCompletion;
        try {
          prepared = deps.service.prepare({
            request: normalized,
            model,
            keyId,
            // Opaque cross-replica capacity scope (Phase 4D), or `null` when
            // shared capacity is disabled. The capacity port is the only
            // collaborator that interprets it.
            capacityScopeId: request.gatewayCapacityScopeId,
            signal,
            // The compiled toolset (emulated mode only) lets `run` parse/vote over
            // upstream tool-call candidates; it is not part of the frozen request.
            ...(validated.toolset !== undefined ? { toolset: validated.toolset } : {}),
            // Explicit span parent: every generation span becomes a child of
            // this request rather than an orphaned root. Omitted entirely when
            // tracing is disabled, so generation starts no span at all.
            ...(rt?.span != null ? { requestSpan: rt.span } : {}),
          });
        } catch (error) {
          reply.raw.removeListener("close", onClose);
          if (isChatCompletionError(error)) return sendError(error.apiError);
          return sendError(INTERNAL_ERROR);
        }

        // --- Cross-replica rate limiting (specification §19.1) ---------------
        // Positioned deliberately: AFTER authentication, request validation,
        // prompt preparation, and idempotency-header/fingerprint validation — so
        // a rejected or unusable request never spends quota, and a supplied key
        // whose idempotency guarantee cannot be honoured still reports
        // `idempotency_unavailable` rather than being metered — and BEFORE the
        // idempotency claim, process-local capacity, any SSE header, and any
        // upstream call. Every otherwise-valid attempt therefore consumes exactly
        // one unit, including an owner, a waiter, a cached replay, and a
        // different-body conflict; quota is never refunded by a later failure.
        //
        // CONFIGURATION is authoritative for whether the gate runs. Keying it on
        // the injected limiter instead would mean an enabled-but-unwired instance
        // silently served unmetered traffic — the failure mode this control
        // exists to prevent. The gate therefore also runs when a limiter was
        // injected without configuration deriving a scope, so an inconsistent
        // wiring fails closed instead of being treated as "disabled".
        if (deps.rateLimitEnabled || deps.rateLimiter !== undefined) {
          const limiter = deps.rateLimiter;
          const rateScopeId = request.gatewayRateLimitScopeId;
          const decision =
            limiter === undefined || rateScopeId === null
              ? // Enabled but unwired, or wired without a scope: an unavailable
                // dependency. Never call the limiter, never admit the request.
                ({ kind: "unavailable" } as const)
              : await limiter
                  .consume(rateScopeId, signal)
                  .catch(() => ({ kind: "unavailable" }) as const);

          if (decision.kind !== "allowed") {
            reply.raw.removeListener("close", onClose);
            if (decision.kind === "limited") {
              return sendError(gatewayRateLimitExceeded(decision.retryAfterSeconds));
            }
            if (decision.kind === "cancelled") {
              // Same semantics as every other cancellation on this route: a gone
              // client gets no body, a shutdown keeps the existing `503`.
              if (clientAbort.signal.aborted) {
                reply.hijack();
                return reply;
              }
              return sendError(SERVICE_UNAVAILABLE_ERROR);
            }
            return sendError(RATE_LIMIT_UNAVAILABLE_ERROR);
          }
        }

        const setIgnoredHeader = (streamed: boolean): void => {
          if (normalized.ignoredParameters.length === 0) return;
          const value = normalized.ignoredParameters.join(",");
          if (streamed) reply.raw.setHeader(IGNORED_HEADER, value);
          else reply.header(IGNORED_HEADER, value);
        };

        /** Emit an already-completed result (live or replayed) as JSON. */
        const encodeJson = (
          identity: { id: string; created: number; model: string },
          result: CachedResult,
        ): ReturnType<typeof encodeChatCompletion> => {
          setIgnoredHeader(false);
          const encodeSpan = tracingOn
            ? telemetry.tracing.startSpan("gateway.encode", {
                ...(rt?.span != null ? { parent: rt.span } : {}),
                attributes: {
                  model: model.id,
                  transport: "json",
                  ...(result.kind === "tool_calls"
                    ? { toolCallCount: result.toolCalls.length }
                    : {}),
                },
              })
            : null;
          try {
            return encodeChatCompletion(
              result.kind === "tool_calls"
                ? { ...identity, kind: "tool_calls", toolCalls: result.toolCalls }
                : { ...identity, content: result.content },
            );
          } catch (error) {
            // An encoder failure becomes the route's fixed internal error.
            encodeSpan?.setError("internal_error");
            throw error;
          } finally {
            encodeSpan?.end();
          }
        };

        // --- Idempotent replay / wait ---------------------------------------
        // Resolved BEFORE any SSE header is committed, because a replay must use
        // the ORIGINAL response identity: the duplicate `prepare` above minted a
        // fresh id that is now discarded and must never be returned.
        let owner: IdempotencyOwnerSession | null = null;
        if (claim !== null) {
          const { coordinator } = claim;
          let cached: CachedCompletion | null = null;
          try {
            const begun = await coordinator.begin({
              clientKey: claim.clientKey,
              gatewayKeyScope: claim.scopeId,
              bodyFingerprint: claim.fingerprint,
              identity: { id: prepared.id, created: prepared.created, model: prepared.model },
              signal,
              timeoutMs: model.requestTimeoutMs,
            });
            if (begun.kind === "conflict") {
              reply.raw.removeListener("close", onClose);
              return sendError(IDEMPOTENCY_KEY_CONFLICT_ERROR);
            }
            if (begun.kind === "unavailable") {
              reply.raw.removeListener("close", onClose);
              return sendError(IDEMPOTENCY_UNAVAILABLE_ERROR);
            }
            if (begun.kind === "owner") {
              owner = begun.session;
            } else {
              const resolved = await begun.resolve();
              if (resolved.kind !== "cached") {
                reply.raw.removeListener("close", onClose);
                if (resolved.kind === "conflict") return sendError(IDEMPOTENCY_KEY_CONFLICT_ERROR);
                if (resolved.kind === "timeout") return sendError(COMPLETION_TIMEOUT_ERROR);
                if (resolved.kind === "cancelled") {
                  // Disconnect and shutdown keep their existing behaviour.
                  if (clientAbort.signal.aborted) {
                    reply.hijack();
                    return reply;
                  }
                  return sendError(SERVICE_UNAVAILABLE_ERROR);
                }
                return sendError(IDEMPOTENCY_UNAVAILABLE_ERROR);
              }
              cached = resolved.cached;
            }
          } catch {
            // The coordinator is total and should never throw; fail closed
            // without inspecting the thrown value.
            reply.raw.removeListener("close", onClose);
            return sendError(IDEMPOTENCY_UNAVAILABLE_ERROR);
          }

          if (owner === null) {
            // Replay. A waiter/replay NEVER registers a native-title correlation:
            // that is the original owner's process-local concern and the upstream
            // thread id is deliberately not cached.
            if (cached === null) {
              reply.raw.removeListener("close", onClose);
              return sendError(IDEMPOTENCY_UNAVAILABLE_ERROR);
            }
            const replayed = cached;
            if (!normalized.stream) {
              reply.raw.removeListener("close", onClose);
              return encodeJson(replayed, replayed.result);
            }
            setIgnoredHeader(true);
            rt?.setTransport("sse");
            try {
              await streamChatCompletion({
                reply,
                meta: {
                  id: replayed.id,
                  created: replayed.created,
                  model: replayed.model,
                  index: 0,
                },
                // Deterministic frames from the original metadata and result;
                // timing and keep-alive comments are not reproduced.
                run: () => Promise.resolve(replayed.result),
                runSignal: signal,
                clientAbort,
                telemetry,
                ...(rt?.span != null ? { parentSpan: rt.span } : {}),
                model: model.id,
                // A replay cannot fail in `run`, but a transport failure after
                // the header still needs the same closed category as a live
                // stream rather than the generic `other` fallback. Built only
                // when a handle exists, so a disabled request allocates no
                // callback at all.
                ...(rt !== null
                  ? {
                      onErrorEnvelope: (apiError: OpenAIApiError): void => {
                        rt.recordError(toErrorCategory(apiError.body.error.code));
                      },
                    }
                  : {}),
              });
            } finally {
              reply.raw.removeListener("close", onClose);
            }
            return reply;
          }
        }

        // --- Live completion (owner, or no idempotency at all) ---------------
        const session = owner;

        /**
         * The reuse lease, assigned as the FIRST statement inside the settled
         * region below. It is a mutable binding only so the `finally` can settle
         * whatever was acquired; nothing else reassigns it.
         */
        let acquiredLease: ThreadReuseSession | null = null;

        /** Settle the claim (`ambiguous` / compare-and-delete) before responding. */
        const finishClaim = async (): Promise<void> => {
          if (session === null) return;
          try {
            await session.finish();
          } catch {
            // Best effort only; it can never change the response.
          }
        };

        /** Settle the reuse mapping (restore, or tombstone) before responding. */
        const finishLease = async (): Promise<void> => {
          if (acquiredLease === null) return;
          try {
            await acquiredLease.finish();
          } catch {
            // Best effort only; it can never change the response.
          }
        };

        // ONE try/finally covers the lease acquisition and every statement after
        // it, so no path — including the reuse gate's own rejections — can leave
        // the claim or the lease unsettled. That matters more than a bounded leak
        // would: an unsettled session keeps renewing its own lease, so a leak
        // would block the key (or the OpenCode session) until process exit rather
        // than until the lease elapsed.
        try {
          // --- OpenCode thread-reuse lease (specification §5.1.1) ------------
          // Logically this gate sits immediately after the rate limit and before
          // the idempotency claim. It runs here because the two features are
          // MUTUALLY EXCLUSIVE — an eligible reuse request carrying an
          // `Idempotency-Key` was already rejected above, so for such a request
          // the whole idempotency block above is a no-op and nothing observable
          // happens between the rate-limit decision and this point.
          if (reuseSessionId !== null) {
            const coordinator = deps.threadReuse;
            const reuseScopeId = request.gatewayReuseScopeId;
            // Enabled but unwired, or wired without a derived scope: an
            // unavailable dependency, never a silent downgrade to a fresh thread.
            if (coordinator === undefined || reuseScopeId === null || !coordinator.isAvailable()) {
              return sendError(THREAD_REUSE_UNAVAILABLE_ERROR);
            }
            const leaseOutcome = await coordinator
              .acquire({ gatewayKeyScope: reuseScopeId, sessionId: reuseSessionId, model })
              .catch(() => ({ kind: "unavailable" }) as const);
            if (leaseOutcome.kind !== "leased") {
              // A live competing turn is a caller-resolvable conflict; everything
              // else (disconnected Redis, corrupt or ambiguous state, a mapping
              // this gateway cannot authenticate) fails closed.
              return sendError(
                leaseOutcome.kind === "busy"
                  ? THREAD_REUSE_BUSY_ERROR
                  : THREAD_REUSE_UNAVAILABLE_ERROR,
              );
            }
            acquiredLease = leaseOutcome.session;
          }
          /** Narrowed for the closures below; never reassigned past this point. */
          const lease = acquiredLease;

          // A lost claim or a lost reuse lease aborts the run, so upstream work
          // stops promptly and no other replica can proceed while this one is
          // still working.
          const ownedSignals: AbortSignal[] = [];
          if (session !== null) ownedSignals.push(session.signal);
          if (lease !== null) ownedSignals.push(lease.signal);
          const runSignal =
            ownedSignals.length === 0 ? signal : AbortSignal.any([signal, ...ownedSignals]);

          let runOptions: CompletionRunOptions | undefined;
          if (session !== null) {
            runOptions = {
              // Runs after capacity is acquired and BEFORE `create_thread`. A
              // failure here releases capacity and performs no upstream call.
              onCapacityAcquired: async (): Promise<void> => {
                if ((await session.markProcessing()) !== "ok") {
                  throw new ChatCompletionError(IDEMPOTENCY_UNAVAILABLE_ERROR);
                }
              },
            };
          } else if (lease !== null) {
            const leasedThreadId = lease.existingThreadId;
            runOptions = {
              ...(leasedThreadId !== null ? { leasedThreadId } : {}),
              // Binds a freshly created thread to the mapping while the record
              // is still `reserved`. On failure no submit happens; the blank
              // upstream thread is deliberately not deleted.
              onThreadCreated: async (threadId: string): Promise<void> => {
                if ((await lease.bindThread(threadId)) !== "ok") {
                  throw new ChatCompletionError(THREAD_REUSE_UNAVAILABLE_ERROR);
                }
              },
              // The last point at which a failure is provably pre-submit.
              onBeforeSubmit: async (): Promise<void> => {
                if ((await lease.markProcessing()) !== "ok") {
                  throw new ChatCompletionError(THREAD_REUSE_UNAVAILABLE_ERROR);
                }
              },
            };
          }

          const execute = async (innerSignal: AbortSignal): Promise<CompletionResult> => {
            if (session !== null) {
              try {
                const result = await deps.service.run(prepared, innerSignal, runOptions);
                // Durably committed before the JSON body and before any SSE
                // content/terminal frame (§18.1). The SSE headers and role opener
                // were already written by design, so a failure here surfaces as an
                // SSE error record on that path.
                if ((await session.commit(toCachedResult(result))) !== "ok") {
                  throw new ChatCompletionError(IDEMPOTENCY_UNAVAILABLE_ERROR);
                }
                return result;
              } catch (error) {
                // A cancellation caused by a LOST CLAIM is an idempotency failure,
                // not a client disconnect or a shutdown.
                if (session.ownershipLost && isRequestCancelledError(error)) {
                  throw new ChatCompletionError(IDEMPOTENCY_UNAVAILABLE_ERROR);
                }
                throw error;
              }
            }
            if (lease !== null) {
              try {
                const result = await deps.service.run(prepared, innerSignal, runOptions);
                // The mapping must record this turn's thread BEFORE the answer is
                // emitted (§5.1.1), on exactly the same terms as the idempotency
                // commit above: on the SSE path the headers and role opener were
                // already written, so a failure here is an SSE error record.
                if ((await lease.finalize()) !== "ok") {
                  throw new ChatCompletionError(THREAD_REUSE_UNAVAILABLE_ERROR);
                }
                return result;
              } catch (error) {
                // A cancellation caused by a LOST LEASE is a reuse failure, not a
                // client disconnect or a shutdown.
                if (lease.leaseLost && isRequestCancelledError(error)) {
                  throw new ChatCompletionError(THREAD_REUSE_UNAVAILABLE_ERROR);
                }
                throw error;
              }
            }
            return deps.service.run(prepared, innerSignal);
          };

          // Synthetic-SSE path: authenticate/validate/resolve/prepare/claim all
          // happened above (pre-header), so from here on every failure is an SSE
          // record. The writer hijacks the reply and owns all response output.
          if (normalized.stream) {
            setIgnoredHeader(true);
            rt?.setTransport("sse");
            await streamChatCompletion({
              reply,
              meta: { id: prepared.id, created: prepared.created, model: prepared.model, index: 0 },
              run: execute,
              runSignal,
              clientAbort,
              // Register the correlation ONLY after the terminal chunk + [DONE]
              // were delivered — never on a failed/cancelled/disconnected stream.
              onCompleted: registerTitleCorrelation,
              telemetry,
              ...(rt?.span != null ? { parentSpan: rt.span } : {}),
              model: model.id,
              // A post-header failure never reaches `sendError`, so the SSE
              // transport reports its own closed error category. The closure is
              // built only when a handle exists, so a disabled gateway allocates
              // nothing here either.
              ...(rt !== null
                ? {
                    onErrorEnvelope: (apiError: OpenAIApiError): void => {
                      rt.recordError(toErrorCategory(apiError.body.error.code));
                    },
                  }
                : {}),
            });
            return reply;
          }

          // Non-streamed JSON path.
          try {
            const result = await execute(runSignal);
            // Register the native-title correlation after run() succeeded and
            // before returning the encoded response (synchronous, bounded,
            // non-throwing).
            registerTitleCorrelation(result);
            return encodeJson(
              { id: prepared.id, created: prepared.created, model: prepared.model },
              toCachedResult(result),
            );
          } catch (error) {
            // Identify gateway errors by identity (trap-safe: no property read, no
            // instanceof/prototype trap). An untrusted thrown value is NEVER
            // inspected and is NEVER re-thrown to the framework — it fails closed
            // to the fixed 500 here, so neither this route nor Fastify ever
            // touches it.
            if (isChatCompletionError(error)) {
              return sendError(error.apiError);
            }
            if (isRequestCancelledError(error)) {
              if (clientAbort.signal.aborted) {
                // The client is gone; do not attempt to send a body.
                reply.hijack();
                return reply;
              }
              // Cancelled by shutdown while the client is still connected.
              return sendError(SERVICE_UNAVAILABLE_ERROR);
            }
            // Unexpected/untrusted: fail closed without inspecting or reflecting it.
            return sendError(INTERNAL_ERROR);
          }
        } finally {
          await finishClaim();
          await finishLease();
          reply.raw.removeListener("close", onClose);
        }
      },
    );
    done();
  });
}
