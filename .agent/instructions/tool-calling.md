# Tool Calling

## Status and Trust Boundary

Emulated tool calling is **implemented offline and EXPERIMENTAL** (Phase 3). It
converts an upstream text response containing a strict protocol JSON object into
OpenAI `tool_calls`. It does not make the response trusted and must not be enabled
as the default production OpenCode model until every release gate in
`.agent/docs/tech-software-spec.md` section 30 passes. Those gates and the
approval-gated live evaluator (`npm run eval:tools`) have **not been run or met**,
so emulated mode stays experimental even though every offline test passes.

Read specification sections 5.2–5.3, 8.7, 11.2, 12–13, 14.4, 21.4–21.5, 29.4, 30, and 34.1–34.2 before changing this area.

The gateway never executes, authorizes, simulates, or claims execution of a tool.
It returns model-PROPOSED calls only; OpenCode owns permissions, execution,
results, and loop limits.

**Implemented engine (offline, `src/tools/`).** The emulated engine lives under
`src/tools/`: `limits.ts` (the single source of truth for `MAX_TOOLS`=128,
`MAX_TOOL_SCHEMA_BYTES`=2 MiB, `MAX_TOOL_ARGUMENT_BYTES`=1 MiB,
`MAX_TOOL_CALLS_PER_RESPONSE`=8, `MAX_TOOL_JSON_DEPTH`=512), `copy.ts`
(`safeJsonCopy` — a descriptor-safe bounded deep copy to trusted plain JSON that
never triggers a getter/`[[Get]]`/`toJSON`/iterator and fails closed on
accessors/cycles/sparse/exotic/over-deep/non-finite/symbol/function/bigint),
`ids.ts` (`call_ciq_<ULID>` seam, `ulid` dependency), `schema.ts` (`compileToolset`
— a per-request Ajv compile that picks the meta-schema dialect from each schema's
root `$schema`: draft-07 by default when `$schema` is absent, and draft-07 or
draft 2020-12 by an exact URI allowlist (OpenCode 1.18.21's draft-2020-12 built-in
schemas compile; a non-string or unknown `$schema` fails closed); at most one
fresh instance per dialect per call, no coercion/defaults/property-removal, no
remote `$ref`, no cross-request retention), `normalize.ts`, `protocol.ts`
(`parseToolEnvelope`),
`canonicalize.ts`, `select.ts` (`selectGeneration`), and `request.ts`
(`normalizeToolRequest` + prior tool-history validation). Pinned deps: `ajv`
8.20.0, `ajv-formats` 3.0.1, `ulid` 2.4.0.

Only a `toolMode: "emulated"` model activates the engine; that mode REQUIRES
`promptMode: "protocol"` (enforced at config load). The opt-in
`collectiviq-claude-tools` model and the `collectiviq-tools-experimental` OpenCode
agent (wildcard permission `"ask"`) are the only tool-enabled surfaces; every
existing default stays `toolMode: "disabled"`. `toolMode: "native"` remains
unimplemented and is rejected at request time.

**Phase 2.1 text-compatibility bridge (unchanged for disabled models).** Because
OpenCode attaches `tools`/`tool_choice` to every request even when all tool
permissions are denied, the request boundary runs a model-policy-aware bridge
(`src/openai/chat-request.ts`, after model resolution) that, for a
`toolMode: "disabled"` model, TOLERATES that metadata: it accepts a bounded
`tools` array (≤`MAX_TOOLS` entries AND ≤`MAX_TOOL_SCHEMA_BYTES` aggregate JSON)
and a `tool_choice` of exactly `"auto"`/`"none"`, records only the NAME for the
diagnostic header, and DISCARDS the definitions. For a disabled model a tool
definition is never semantically interpreted, retained, serialized into the
prompt, forwarded upstream, logged, reflected, persisted, or executed; it is
traversed ONLY through data-property descriptors (`getOwnPropertyDescriptor`/
`Reflect.ownKeys`, no `[[Get]]`), so submitted accessors and executable hooks are
never invoked. For a disabled model, `required`/named `tool_choice`; a non-array,
over-count, or over-budget `tools`; an accessor, cycle, sparse/exotic/over-deep
structure, unsupported value, or descriptor/proxy failure; and any tool metadata
against a `native` model fail closed with a stable `unsupported_parameter` `400`.

**Emulated mode (the one exception to "tools are discarded").** For a
`toolMode: "emulated"` model the boundary instead NORMALIZES and RETAINS the tool
policy: it descriptor-safe-copies the definitions into trusted plain data,
compiles the JSON Schemas once, validates prior assistant `tool_calls` + linked
tool results (unique ids, declared names, schema-valid arguments, exactly-one
correctly-linked result — orphan/duplicate/unresolved/mismatched relationships are
rejected before upstream work), and carries the compiled toolset through
`prepare`/`run`. In emulated mode the validated tool schemas, prior arguments, and
tool results ARE serialized into the prompt sent to CollectivIQ — they are still
never logged or retained by the gateway. A `required`/named `tool_choice` with no
declared tools is a stable `400 unsupported_parameter` before capacity/headers/
upstream. Each tool-loop round creates a NEW upstream thread.

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

- Enforce the configured maximum, with the specification's initial default of eight calls (`MAX_TOOL_CALLS_PER_RESPONSE`).
- When `parallel_tool_calls` is false, reject multiple calls (implemented — there is NO silent "select the first call" fallback).
- Generate all IDs before SSE encoding and keep them stable in every related chunk.
- A complete tool-call delta is acceptable; character-level argument streaming is not required. Tool-call streaming is **implemented** (`src/openai/chat-stream.ts` `toolCallsChunk`/`terminalToolChunk`, driven by `src/api/chat-stream-response.ts`): one complete indexed delta using the trusted `call_ciq_*` ids, then a terminal chunk with `finish_reason: "tool_calls"`, then `data: [DONE]`, with no `usage`.

## Validation and Release Evidence

Changes require unit and adversarial fixtures for valid, malformed, fenced, injected, unknown-name, schema-invalid, oversized, too-many, choice-mismatched, parallel, and deterministic-consensus cases.

**Implemented hermetic coverage (offline).** Unit: `test/unit/tools-{copy,schema,protocol,select,request,encoding}.test.ts` plus emulated-acceptance cases in `chat-request.test.ts` and the config invariant in `config.test.ts`. Integration: `test/integration/chat-completions-tools.test.ts` (JSON tool_calls, SSE tool deltas, pre-header `400`, ignored-header, native-title-after-tool-call). Contract: `test/contract/completion-flow-tools.test.ts` (real runtime + mock upstream — full flow with one create + one submit, `502` for required-with-no-call, `auto` text fallback, and a no-leak logger/response assertion while the schema is serialized into the prompt by design). Pinned-SDK compatibility (out of `validate`/CI): `test/compatibility/ai-sdk-tools.test.ts` (`generateText`/`streamText` real tool call + an in-memory three-step read/edit/test loop with synthetic tools only — no shell/fs/MCP/network). The **adversarial release-gate suite** `test/adversarial/tool-protocol-corpus.test.ts` (≥200 protocol cases; own `vitest.adversarial.config.ts`; `npm run test:adversarial`; excluded from `validate`/CI).

Multi-round compatibility tests must include actual assistant tool calls followed by linked tool results and further tool/final responses. The numerical gates in specification section 30 are product release criteria; do not weaken, reinterpret, or mark them passed without reproducible evidence over the required suites. The approval-gated `npm run eval:tools` live evaluator that would measure those gates is **implemented but has NOT been run** (network-only; never in `validate`/CI).

If gates fail, keep text-only models available and label tool mode experimental. A parser implementation and passing offline suites alone are not evidence that OpenCode agent workflows are production-ready. The current account may still reject the protocol wrapper; do not change the default or weaken parsing to work around that.
