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
 *   -> keyed request with unusable idempotency  -> 503 idempotency_unavailable
 *   -> prompt preparation
 *   -> cross-replica rate limit                 -> 429 / 503 (§19.1)
 *   -> idempotency claim, wait, or replay       -> 409 / 503 / cached result
 *   -> process-local capacity                   -> 429 gateway_capacity_exceeded
 *   -> upstream work
 * ```
 */
import { Type } from "@fastify/type-provider-typebox";
import type { FastifyError } from "fastify";
import type { GatewayServer } from "../server.js";
import { isAuthenticated, isHandlerStarted, markHandlerStarted } from "./request-phase.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import {
  ChatCompletionError,
  isChatCompletionError,
  isRequestCancelledError,
  type ChatCompletionService,
  type CompletionResult,
  type CompletionRunHooks,
  type PreparedCompletion,
} from "../generation/chat-completion.js";
import type { TitleBridge } from "../opencode/title-bridge.js";
import { SESSION_ID_HEADER, normalizeSessionId } from "../opencode/session-header.js";
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
import {
  COMPLETION_TIMEOUT_ERROR,
  gatewayRateLimitExceeded,
  IDEMPOTENCY_KEY_CONFLICT_ERROR,
  IDEMPOTENCY_UNAVAILABLE_ERROR,
  INTERNAL_ERROR,
  INVALID_IDEMPOTENCY_KEY_ERROR,
  INVALID_REQUEST_ERROR,
  OpenAIErrorSchema,
  RATE_LIMIT_UNAVAILABLE_ERROR,
  REQUEST_BODY_TOO_LARGE_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
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

        const sendError = (apiError: OpenAIApiError): OpenAIApiError["body"] => {
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
        const validated = validateChatRequest(request.body, (id) => deps.catalog.resolveModel(id));
        if (!validated.ok) return sendError(validated.error);
        const normalized = validated.request;
        const model = validated.model;

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
        const sessionId = normalizeSessionId(request.headers[SESSION_ID_HEADER]);
        const registerTitleCorrelation = (result: CompletionResult): void => {
          if (sessionId === null) return;
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
            signal,
            // The compiled toolset (emulated mode only) lets `run` parse/vote over
            // upstream tool-call candidates; it is not part of the frozen request.
            ...(validated.toolset !== undefined ? { toolset: validated.toolset } : {}),
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
          return encodeChatCompletion(
            result.kind === "tool_calls"
              ? { ...identity, kind: "tool_calls", toolCalls: result.toolCalls }
              : { ...identity, content: result.content },
          );
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
              });
            } finally {
              reply.raw.removeListener("close", onClose);
            }
            return reply;
          }
        }

        // --- Live completion (owner, or no idempotency at all) ---------------
        const session = owner;

        /** Settle the claim (`ambiguous` / compare-and-delete) before responding. */
        const finishClaim = async (): Promise<void> => {
          if (session === null) return;
          try {
            await session.finish();
          } catch {
            // Best effort only; it can never change the response.
          }
        };

        // ONE try/finally covers every remaining statement, so no path can leave
        // the claim unsettled. That matters more than a bounded leak would: an
        // unsettled owner session keeps renewing its own lease, so a leaked claim
        // would block the key until process exit rather than until the lease
        // elapsed.
        try {
          // A lost claim aborts the run, so upstream work stops promptly and no
          // other replica can proceed while this one is still working.
          const runSignal = session === null ? signal : AbortSignal.any([signal, session.signal]);
          const hooks: CompletionRunHooks | undefined =
            session === null
              ? undefined
              : {
                  // Runs after capacity is acquired and BEFORE `create_thread`. A
                  // failure here releases capacity and performs no upstream call.
                  onCapacityAcquired: async (): Promise<void> => {
                    if ((await session.markProcessing()) !== "ok") {
                      throw new ChatCompletionError(IDEMPOTENCY_UNAVAILABLE_ERROR);
                    }
                  },
                };

          const execute = async (innerSignal: AbortSignal): Promise<CompletionResult> => {
            if (session === null) return deps.service.run(prepared, innerSignal);
            try {
              const result = await deps.service.run(prepared, innerSignal, hooks);
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
          };

          // Synthetic-SSE path: authenticate/validate/resolve/prepare/claim all
          // happened above (pre-header), so from here on every failure is an SSE
          // record. The writer hijacks the reply and owns all response output.
          if (normalized.stream) {
            setIgnoredHeader(true);
            await streamChatCompletion({
              reply,
              meta: { id: prepared.id, created: prepared.created, model: prepared.model, index: 0 },
              run: execute,
              runSignal,
              clientAbort,
              // Register the correlation ONLY after the terminal chunk + [DONE]
              // were delivered — never on a failed/cancelled/disconnected stream.
              onCompleted: registerTitleCorrelation,
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
          reply.raw.removeListener("close", onClose);
        }
      },
    );
    done();
  });
}
