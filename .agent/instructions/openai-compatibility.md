# OpenAI Compatibility

## Compatibility Boundary

The gateway implements the OpenAI Chat Completions subset required by OpenCode's `@ai-sdk/openai-compatible` integration. It must describe itself as “OpenAI Chat Completions compatible for the OpenCode integration profile,” never as fully OpenAI-compatible.

Read `.agent/docs/tech-software-spec.md` sections 8.1–8.2, 8.8, 9, 14, 20, 25, and 33 before changing public behavior.

## Public Endpoints

- `GET /v1/models`
- `GET /v1/models/:model`
- `POST /v1/chat/completions`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics` with network controls or separate auth

Only the first three are part of the OpenAI-shaped API surface. Do not add Responses API or unrelated OpenAI endpoints without a specification change.

## Request Validation

**Implementation status (Phase 1B / Phase 2, implemented).** `POST
/v1/chat/completions` is authenticated and text-only, with a **strict** request
surface, and serves both the non-streamed JSON path and (Phase 2) the synthetic
SSE path. `src/openai/chat-request.ts` + `messages.ts` validate/normalize to the
**deeply frozen** `NormalizedChatRequest` (`chat-types.ts`, which now carries a
normalized `stream: boolean`); `src/prompts/conversation.ts` serializes the
deterministic versioned prompt; `src/openai/chat-response.ts` encodes the
non-streamed response with zero (unavailable) usage, and `src/openai/chat-stream.ts`
encodes the SSE frames (see Streaming below). `stream` is normalized to a
boolean: absent/`false` → JSON, exactly `true` → SSE, every other value (`null`,
explicit `undefined`, `"true"`, `0`, `1`, objects) → stable `400`. Deferred
features are rejected by **own-property presence alone** (`Object.hasOwn`; even
empty/`null`/explicit `undefined`/`"auto"`/`"none"`/harmless values, never reading
the value or counting an inherited property): request `tools`, request
`tool_choice`, `response_format`, `logprobs`, audio, image/binary content parts,
tool-role messages, and message `tool_calls`. `parallel_tool_calls` stays an
ignored compatibility option only because no other tool surface is accepted. The
ignored optional-parameter NAMES are echoed in `X-CollectivIQ-Ignored-Parameters`.
Tool calling (and tool-call streaming) remain planned (Phase 3).

- Require a configured `model` and an ordered non-empty `messages` collection according to the public schema.
- Accept supported roles and text content forms exactly as specified.
- Reject image, audio, file, binary, response-format, logprobs, and other unsupported combinations with a stable OpenAI error envelope.
- Require `n = 1` when present.
- Tolerate documented optional sampling/storage fields even when upstream cannot honor them; normalize and record ignored parameter names without logging values.
- Validate tools and `tool_choice` before prompt construction.
- Calculate limits from UTF-8 bytes, not JavaScript string length or invented token estimates.
- Never let the raw request object leak into application logic.

## Message Normalization

- Preserve message order, declared role, assistant text/tool calls, tool-call IDs, tool names/argument JSON, and tool results.
- Normalize string and text-part content to one explicit internal representation.
- Preserve `system` and `developer` roles distinctly even though the upstream prompt interface weakens their trust boundary.
- Reject malformed prior tool-call/tool-result relationships when the supported schema requires a link.
- Use deterministic serialization so fixtures and retries of pure stages reproduce identical prompts except intentionally randomized boundary data.

## Response Encoding

- Text responses use assistant content and `finish_reason: "stop"`.
- Tool responses use `content: null`, OpenAI function `tool_calls`, and `finish_reason: "tool_calls"`.
- Tool arguments stay a JSON string in the public response but must already have passed JSON and exact schema validation.
- Generated completion and call IDs are unique and stable across chunks for one response.
- Return zero usage or omit it according to verified client compatibility; never label estimates as exact upstream usage.
- Keep public errors stable according to specification section 20 and exclude raw upstream bodies.

## Streaming

**Implementation status (Phase 2, implemented — text-only).** `stream: true` is
served as buffered synthetic SSE, not true upstream streaming. The pure frame
encoder + deterministic code-point-safe split live in `src/openai/chat-stream.ts`;
the SSE transport (header commit, keep-alive timers, backpressure, cancellation)
lives in `src/api/chat-stream-response.ts`, driven from
`src/api/chat-completions-route.ts`. Tool-call streaming (step 5 below) stays
Phase 3.

1. Authenticate, validate, resolve the model, and prepare the prompt BEFORE
   committing any SSE header, so a pre-header failure stays a normal JSON error;
   then respond `200`/`text/event-stream` and emit the assistant-role chunk
   promptly (before capacity/upstream work).
2. Send `: collectiviq-gateway keep-alive` comment keep-alives every 15 s while
   the authoritative polling flow waits.
3. Parse the complete upstream result before emitting answer content.
4. Split text on code-point-safe boundaries (target 128 / max 256 / min 32 code
   points), preferring paragraph, then sentence, then whitespace boundaries;
   concatenating all content deltas reproduces the answer exactly.
5. (Planned, Phase 3) emit tool calls with stable IDs and indices.
6. Emit a terminal chunk with `finish_reason: "stop"`, then `data: [DONE]`. An
   empty answer emits role + terminal + `[DONE]` and no content frames. No
   `usage` is emitted on a stream.

A post-header failure is encoded as one content-free `data: {"error": …}` record
then `data: [DONE]` (no terminal chunk); a shutdown emits the `503`
`service_unavailable` record + `[DONE]` **only while the transport remains
writable** — a backpressured/undrainable response, or one whose terminal
`res.end()` throws or never completes, is force-closed (destroyed, on a bounded
next-turn fallback if needed) to keep the shutdown drain authoritative, so it may
end silently and `503` delivery is not guaranteed. Writes are serialized and
honour backpressure; a write failure / client disconnect aborts polling, releases
capacity, clears keep-alive timers, and writes no body to a gone client. Never
continue polling merely to finish an already disconnected SSE response.

Do not consume `/user/events` for request streaming until correlation, filtering, ordering, reconnect, and concurrency behavior are verified; polling remains authoritative.

## Compatibility Change Checklist

For every public-contract change, cover as applicable:

- schema accept/reject cases;
- normalized internal representation;
- non-streamed response shape;
- SSE first, content/tool, terminal, and `[DONE]` frames;
- OpenAI error status/type/code/param mapping;
- direct HTTP and AI SDK compatibility tests;
- OpenCode smoke behavior;
- cancellation and timeout behavior;
- documentation and examples.

Do not use a permissive compatibility parser to hide invalid upstream or tool behavior. Public tolerance applies only to the documented optional request fields.
