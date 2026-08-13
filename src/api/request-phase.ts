/**
 * Trusted per-request lifecycle markers for the authenticated `/v1` scope.
 *
 * These markers establish the PROVENANCE of a thrown value inside the chat
 * route's error boundary WITHOUT ever inspecting the value itself. Each marker
 * is a `WeakSet` keyed on the genuine Fastify request identity (never a Proxy,
 * never an untrusted object), so membership is decided by identity alone — no
 * property read, no `instanceof`, no coercion, and no getter/Proxy trap.
 *
 * Lifecycle for a chat-completions request:
 *
 *   onRequest (gateway auth) ── success ─▶ markAuthenticated
 *        │ throws                                   │
 *        ▼                                          ▼
 *     (unmarked)                          Fastify body parsing / body-limit
 *        │                                          │ throws
 *        │                                          ▼
 *        │                                   (still only authenticated)
 *        │                                          │ parsed OK
 *        │                                          ▼
 *        │                                    handler body ─▶ markHandlerStarted
 *        ▼
 *   error boundary: NOT authenticated ⇒ fixed 500 (auth/hook failure)
 *   error boundary: authenticated && NOT handler-started ⇒ genuine parser phase
 *   error boundary: handler-started ⇒ fixed 500 (application failure)
 *
 * The only code that runs between `markAuthenticated` and `markHandlerStarted`
 * is Fastify's own content-type/JSON/body-limit parsing, so a thrown value seen
 * in that window is provably a framework parser/body-limit failure — the sole
 * case allowed to map to `400`/`413`.
 */
import type { FastifyRequest } from "fastify";

const authenticated = new WeakSet<FastifyRequest>();
const handlerStarted = new WeakSet<FastifyRequest>();

/** Record that gateway authentication for this request completed normally. */
export function markAuthenticated(request: FastifyRequest): void {
  authenticated.add(request);
}

/** True only when {@link markAuthenticated} ran for this request (auth passed). */
export function isAuthenticated(request: FastifyRequest): boolean {
  return authenticated.has(request);
}

/** Record that the chat-completions handler body has begun executing. */
export function markHandlerStarted(request: FastifyRequest): void {
  handlerStarted.add(request);
}

/** True once the handler body has begun (any later throw is an application error). */
export function isHandlerStarted(request: FastifyRequest): boolean {
  return handlerStarted.has(request);
}
