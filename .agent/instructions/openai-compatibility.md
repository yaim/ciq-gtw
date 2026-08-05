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

Initial streaming is buffered synthetic SSE, not true upstream streaming:

1. Open the SSE response and emit the assistant-role chunk promptly.
2. Send comment keep-alives while the authoritative polling flow waits.
3. Parse the complete upstream result before emitting answer content/tool calls.
4. Split text on code-point-safe boundaries, preferring semantic boundaries within the configured size range.
5. Emit tool calls with stable IDs and indices.
6. Emit a terminal chunk with the correct finish reason, then `data: [DONE]`.

Handle backpressure and client disconnects. Never continue polling merely to finish an already disconnected SSE response.

Do not consume `/user/events` for request streaming until correlation, filtering, ordering, reconnect, and concurrency behavior are verified.

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
