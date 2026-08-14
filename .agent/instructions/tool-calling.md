# Tool Calling

## Status and Trust Boundary

Emulated tool calling is experimental. It converts an upstream text response containing a strict protocol JSON object into OpenAI `tool_calls`. It does not make the response trusted and must not be enabled as the default production OpenCode model until every release gate in `.agent/docs/tech-software-spec.md` section 30 passes.

Read specification sections 5.2–5.3, 8.7, 11.2, 12–13, 14.4, 21.4–21.5, 29.4, 30, and 34.1–34.2 before changing this area.

The gateway never executes, authorizes, simulates, or claims execution of a tool. OpenCode owns permissions, execution, results, and loop limits.

**Phase 2.1 text-compatibility bridge (current behavior).** Tool calling is not
yet implemented and every virtual model is `toolMode: "disabled"`. Because
OpenCode attaches `tools`/`tool_choice` to every request even when all tool
permissions are denied, the request boundary runs a model-policy-aware bridge
(`src/openai/chat-request.ts`, after model resolution) that TOLERATES that
metadata for a disabled model: it accepts a bounded `tools` array (≤128 entries
AND ≤2 MiB aggregate JSON — `MAX_TOOL_SCHEMA_BYTES`, spec §21.6) and a
`tool_choice` of exactly `"auto"`/`"none"`, records only the NAME for the
diagnostic header. A tool definition is never semantically interpreted, retained,
serialized into the prompt, forwarded upstream, logged, reflected, persisted, or
executed; it is traversed ONLY through data-property descriptors for bounded
JSON-shape and byte accounting (`getOwnPropertyDescriptor`/`Reflect.ownKeys`, no
`[[Get]]`), so submitted accessors and executable hooks (getters, `toJSON`,
iterators) are never invoked. This is NOT tool calling: `required`/named
`tool_choice`; a non-array, over-count, or over-budget `tools`; an accessor,
cycle, sparse/exotic/over-deep structure, unsupported value, or descriptor/proxy
failure anywhere; and any tool metadata against an `emulated`/`native` model fail
closed with a stable `unsupported_parameter` `400`. Do not use this bridge to
activate emulated/native mode or emit tool calls; those stay Phase 3 and gated by
section 30.

## Prompt Protocol

- Use the versioned `tool-or-final` control prompt and one versioned conversation envelope.
- Include only the tool definitions supplied and validated for the current request.
- Require exactly one complete JSON object with either `type: "tool_calls"` or `type: "final"`.
- Keep conversation and tool boundary markers explicit and high entropy where implemented.
- Preserve tool-result messages and IDs so the next model action has the actual execution history.
- Do not claim delimiters restore a cryptographic role boundary; prompt injection remains possible.

## Parsing and Validation

Apply the full ordered algorithm from specification section 12.2:

1. trim Unicode whitespace;
2. remove at most one outer JSON Markdown fence when present;
3. parse JSON with a real parser;
4. validate protocol version and action type;
5. allow only names declared in the request;
6. validate each argument object against the exact supplied JSON Schema;
7. honor strict-object/unknown-property behavior;
8. enforce `tool_choice`, call-count, parallel-call, and argument-byte limits;
9. generate gateway-owned `call_ciq_<ULID>` identifiers.

Never extract a tool call from prose with regular expressions, repair arbitrary malformed JSON silently, trust upstream call IDs, or accept a schema near-match.

## Tool Choice

- `none`: do not include or parse the tool protocol for the request.
- `auto`: accept a valid tool envelope or final envelope; invalid desired-source protocol may fall back to ordinary final text exactly as specified.
- `required`: require at least one valid call; never silently return text.
- named function: require valid call(s) to that function according to the supported policy.

Required or named choice with no valid call maps to the specified `502 invalid_tool_response` error.

## Candidate Selection

Use deterministic priority:

1. valid configured answer-source response;
2. agreement among valid individual responses;
3. one deterministic valid individual response;
4. failure.

For consensus fallback, canonicalize tool name, recursively key-sorted argument JSON, and call ordering unless parallel behavior explicitly makes ordering irrelevant. Score with available `percent_usage`, otherwise agreement count, and break ties through configured source priority.

Canonicalization must be pure, stable, and covered by fixtures. Parser output should identify the selection path as bounded metadata without recording arguments.

## Parallel Calls and Streaming

- Enforce the configured maximum, with the specification's initial default of eight calls.
- When `parallel_tool_calls` is false, reject multiple calls by default. Selecting only the first requires an explicit compatibility mode and tests.
- Generate all IDs before SSE encoding and keep them stable in every related chunk.
- A complete tool-call delta is acceptable; character-level argument streaming is not required.

## Validation and Release Evidence

Changes require unit and adversarial fixtures for valid, malformed, fenced, injected, unknown-name, schema-invalid, oversized, too-many, choice-mismatched, parallel, and deterministic-consensus cases.

Multi-round compatibility tests must include actual assistant tool calls followed by linked tool results and further tool/final responses. The numerical gates in specification section 30 are product release criteria; do not weaken, reinterpret, or mark them passed without reproducible evidence over the required suites.

If gates fail, keep text-only models available and label tool mode experimental. A parser implementation alone is not evidence that OpenCode agent workflows are production-ready.
