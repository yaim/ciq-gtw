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
 */
import { Type } from "@fastify/type-provider-typebox";
import type { FastifyError } from "fastify";
import type { GatewayServer } from "../server.js";
import { isAuthenticated, isHandlerStarted, markHandlerStarted } from "./request-phase.js";
import type { ModelCatalog } from "../generation/model-catalog.js";
import {
  isChatCompletionError,
  isRequestCancelledError,
  type ChatCompletionService,
} from "../generation/chat-completion.js";
import { validateChatRequest } from "../openai/chat-request.js";
import { ChatCompletionSchema, encodeChatCompletion } from "../openai/chat-response.js";
import { streamChatCompletion } from "./chat-stream-response.js";
import {
  INTERNAL_ERROR,
  INVALID_REQUEST_ERROR,
  OpenAIErrorSchema,
  REQUEST_BODY_TOO_LARGE_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
  type OpenAIApiError,
} from "../openai/errors.js";

/** Dependencies for the chat-completions route. */
export interface ChatCompletionsRouteDeps {
  readonly service: ChatCompletionService;
  readonly catalog: ModelCatalog;
  /** Aborts when the process begins its shutdown drain-cancel step. */
  readonly shutdownSignal: AbortSignal;
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
          reply.code(apiError.status as 400 | 401 | 404 | 413 | 429 | 502 | 503 | 504 | 500);
          if (apiError.status === 429) reply.header("retry-after", "5");
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
        let prepared;
        try {
          prepared = deps.service.prepare({ request: normalized, model, keyId, signal });
        } catch (error) {
          reply.raw.removeListener("close", onClose);
          if (isChatCompletionError(error)) return sendError(error.apiError);
          return sendError(INTERNAL_ERROR);
        }

        // Synthetic-SSE path: authenticate/validate/resolve/prepare all happened
        // above (pre-header), so from here on every failure is an SSE record. The
        // writer hijacks the reply and owns all response output.
        if (normalized.stream) {
          if (normalized.ignoredParameters.length > 0) {
            reply.raw.setHeader(IGNORED_HEADER, normalized.ignoredParameters.join(","));
          }
          try {
            await streamChatCompletion({
              reply,
              meta: { id: prepared.id, created: prepared.created, model: prepared.model, index: 0 },
              run: (runSignal) => deps.service.run(prepared, runSignal),
              runSignal: signal,
              clientAbort,
            });
          } finally {
            reply.raw.removeListener("close", onClose);
          }
          return reply;
        }

        // Non-streamed JSON path.
        try {
          const result = await deps.service.run(prepared, signal);
          if (normalized.ignoredParameters.length > 0) {
            reply.header(IGNORED_HEADER, normalized.ignoredParameters.join(","));
          }
          return encodeChatCompletion({
            id: prepared.id,
            created: prepared.created,
            model: prepared.model,
            content: result.content,
          });
        } catch (error) {
          // Identify gateway errors by identity (trap-safe: no property read, no
          // instanceof/prototype trap). An untrusted thrown value is NEVER
          // inspected and is NEVER re-thrown to the framework — it fails closed to
          // the fixed 500 here, so neither this route nor Fastify ever touches it.
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
        } finally {
          reply.raw.removeListener("close", onClose);
        }
      },
    );
    done();
  });
}
