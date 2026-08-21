/**
 * `GET /v1/opencode/session-title` — the authenticated native-title extension.
 *
 * This is a CollectivIQ/OpenCode EXTENSION, not part of the OpenAI compatibility
 * profile. It is registered inside the authenticated `/v1` scope, so the gateway
 * Bearer auth hook and per-key identity apply exactly as they do to the OpenAI
 * routes. It returns the best-effort, process-local native title correlated to a
 * prior successful completion for the caller's OpenCode session.
 *
 * Responses (all with `Cache-Control: no-store`):
 *   200 {"status":"ready","title":"…"}   — the provider title is available
 *   202 {"status":"pending"}   + Retry-After: 2
 *   400 {"status":"unavailable"}          — missing/malformed session header
 *   404 {"status":"unavailable"}          — unknown, expired, or exhausted
 *
 * The `404` intentionally conflates unknown/expired/exhausted, and an upstream
 * lookup failure stays content-free (pending while attempts remain, then 404).
 * The endpoint never returns an upstream thread id, raw body, status text,
 * credential, or diagnostic message. Client disconnect and shutdown are composed
 * into the lookup's abort signal so a disconnected title lookup does not leave
 * upstream work running.
 */
import { Type } from "@fastify/type-provider-typebox";
import type { GatewayServer } from "../server.js";
import type { TitleBridge } from "../opencode/title-bridge.js";
import { SESSION_ID_HEADER, normalizeSessionId } from "../opencode/session-header.js";
import { OpenAIErrorSchema } from "../openai/errors.js";

/** Dependencies for the session-title route. */
export interface OpenCodeTitleRouteDeps {
  readonly titleBridge: TitleBridge;
  /** Aborts when the process begins its shutdown drain-cancel step. */
  readonly shutdownSignal: AbortSignal;
}

const ReadySchema = Type.Object(
  { status: Type.Literal("ready"), title: Type.String() },
  { additionalProperties: false },
);
const PendingSchema = Type.Object(
  { status: Type.Literal("pending") },
  { additionalProperties: false },
);
const UnavailableSchema = Type.Object(
  { status: Type.Literal("unavailable") },
  { additionalProperties: false },
);

/** Register the session-title route on the (already authenticated) `/v1` group. */
export function registerOpenCodeTitleRoute(app: GatewayServer, deps: OpenCodeTitleRouteDeps): void {
  app.get(
    "/opencode/session-title",
    {
      schema: {
        response: {
          200: ReadySchema,
          202: PendingSchema,
          400: UnavailableSchema,
          // The gateway-auth hook sends the shared OpenAI `401` envelope.
          401: OpenAIErrorSchema,
          404: UnavailableSchema,
        },
      },
    },
    async (request, reply) => {
      // Every response is non-cacheable (a correlation is short-lived and per-key).
      reply.header("cache-control", "no-store");

      const sessionId = normalizeSessionId(request.headers[SESSION_ID_HEADER]);
      if (sessionId === null) {
        reply.code(400);
        return { status: "unavailable" as const };
      }
      // The auth hook guarantees an identity; treat an absent one as unavailable.
      const keyId = request.gatewayKeyId;
      if (keyId === null) {
        reply.code(404);
        return { status: "unavailable" as const };
      }

      // Compose client-disconnect + shutdown into the lookup's abort signal so a
      // disconnected title lookup does not leave upstream work running.
      const clientAbort = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) clientAbort.abort();
      };
      reply.raw.on("close", onClose);
      const signal = AbortSignal.any([clientAbort.signal, deps.shutdownSignal]);

      try {
        const outcome = await deps.titleBridge.lookup({ keyId, sessionId }, signal);
        if (outcome.kind === "ready") {
          reply.code(200);
          return { status: "ready" as const, title: outcome.title };
        }
        if (outcome.kind === "pending") {
          reply.code(202);
          reply.header("retry-after", "2");
          return { status: "pending" as const };
        }
        reply.code(404);
        return { status: "unavailable" as const };
      } finally {
        reply.raw.removeListener("close", onClose);
      }
    },
  );
}
