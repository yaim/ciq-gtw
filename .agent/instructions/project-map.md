# Project Map and Architecture

## Source of Truth

Read `.agent/docs/tech-software-spec.md` sections 5–8, 15, 26, 27, and 36 for architectural principles, components, request state, planned paths, orchestration, and the final design. Sections 9.5 and 25 own the OpenCode session-title extension endpoint and the OpenCode plugin / native-title propagation behavior.

**Implemented today (foundation):** `src/index.ts`, `src/server.ts`, `src/api/health-route.ts` (`/healthz`, `/readyz`, and the injected readiness state), `src/config/schema.ts`, `src/config/load.ts`, `src/observability/logger.ts`, and `src/shared/redaction.ts`, with tests under `test/`.

**Implemented (Phase 1A public model surface, offline):** `src/api/gateway-auth.ts` (fixed-length SHA-256 + `timingSafeEqual` gateway-key authentication), `src/api/v1-routes.ts` (the encapsulated authenticated `/v1` route group with its `onRequest` auth hook and scoped internal-error handler), `src/api/models-route.ts` (`GET /v1/models`, `GET /v1/models/:model`), `src/openai/errors.ts` (shared OpenAI error envelopes), `src/openai/models.ts` (public model objects), and `src/generation/model-catalog.ts` (immutable exact-case resolver with one captured `created` timestamp). These model metadata routes (and unauthenticated `/healthz`/`/readyz`) do not call CollectivIQ.

**Implemented (upstream boundary, offline Phase 0):** `src/collectiviq/` — the production adapter (`adapter.ts`), bounded transport (`http.ts`, including the discovery-only any-status `observeUpstreamJson` that is not exported from `index.ts`), shared pure request builders (`requests.ts`), provisional response validators (`validation.ts`), normalized error model (`errors.ts`), fixed endpoint paths (`endpoints.ts`), adapter types/capabilities (`types.ts`), value-free correlation (`correlation.ts`), and the opt-in **staged discovery session** plus SSE evidence and sanitized structural capture (`discovery.ts` — `DiscoverySessionRunner`, `readSseEvidence`, strict `exitCodeForBaseline`; thin `discovery-cli.ts`; `structural-capture.ts`). Discovery captures raw upstream structure, retains correlation ids privately, keeps a truthful cleanup ledger, and gates every destructive delete on approval. The filtered OpenAPI snapshot lives at `contract/collectiviq/`, its tooling at `scripts/openapi/`, and hermetic contract tests at `test/contract/`. **The production adapter is now wired into the Phase 1B completion path** (`POST /v1/chat/completions`; see the Phase 1B entry below). The discovery, recovery, SSE-evidence, and other operator tooling remain out-of-band and are not public production routes. Construction and import stay socket-free and perform no upstream I/O; only a real completion request reaches CollectivIQ.

**Implemented (Phase 1B non-streamed chat completions, offline):** `src/api/chat-completions-route.ts` (the authenticated `POST /v1/chat/completions` route, its child-scope framework-error mapping, and client-disconnect wiring), `src/openai/chat-types.ts`/`messages.ts`/`chat-request.ts` (request validation/normalization) and `chat-response.ts` (the non-streamed encoder), `src/prompts/conversation.ts` (protocol-mode full-history versioned serializer), `src/prompts/direct.ts` (direct-mode latest-user-only serializer), `src/prompts/serializer.ts` (the model-policy-aware router that dispatches on the resolved model's validated `promptMode` — never a model-id string — with `protocol` the backward-compatible default and `direct` intentionally lossy, limited to the latest normalized user message), `src/generation/types.ts` (capacity/poller/serializer ports), `capacity.ts` (process-local global + per-key admission with a bounded queue), `polling.ts` (bounded polling + desired-source selection), `chat-completion.ts` (orchestration), `seams.ts` (clock/id), and `runtime.ts` (composition from validated config). The `ModelCatalog` now also resolves the internal `VirtualModel` policy (`resolveModel`) without changing public model output. `validateChatRequest` takes that resolver, returns the resolved `VirtualModel` alongside the frozen request, and runs the model-policy-aware **tool-metadata compatibility bridge (Phase 2.1)**: for a `toolMode: "disabled"` model it tolerates and discards OpenCode's automatic `tools`/`tool_choice` metadata (bounded to ≤128 entries AND ≤2 MiB aggregate JSON via a descriptor-only, iterative shape/byte accounting that never invokes `[[Get]]`/getters/`toJSON`; retained/serialized/forwarded nowhere) and rejects required/named choices and malformed/over-budget collections; a `native` model is unimplemented, so any tool metadata is rejected. A `toolMode: "emulated"` model instead normalizes and retains the tool policy (owned by the Phase 3 inventory below). The raw-body access and tool-name recording stay inside the `src/openai/` boundary. The CollectivIQ adapter is now wired into this completion path (one new thread per request); construction still makes no upstream call.

**Implemented (Phase 2 text-only synthetic SSE streaming, offline):** `src/openai/chat-stream.ts` (the pure `chat.completion.chunk` frame encoders and the deterministic, code-point-safe content split — the OpenAI boundary owns frame encoding and splitting) and `src/api/chat-stream-response.ts` (the SSE transport — header commit after preparation, backpressure-aware serialized writes, keep-alive timers, terminal/`[DONE]` framing, content-free error records, and write-failure/disconnect cancellation — the API boundary owns SSE transport, backpressure, keep-alives, and cancellation). The same `POST /v1/chat/completions` route serves both paths; `chat-completion.ts` is split into a synchronous `prepare` and an async `run` so the API layer commits SSE headers only after preparation succeeds. `chat-request.ts`/`chat-types.ts` normalize `stream` to a boolean.

**Implemented (native-title propagation; spec §§9.5 and 25):** `src/api/opencode-title-route.ts` owns the authenticated `GET /v1/opencode/session-title` route — a CollectivIQ/OpenCode **extension**, not part of the OpenAI profile. `src/opencode/title-bridge.ts` owns the bounded, process-local correlation from `gatewayKeyId + sessionId` to the upstream thread id (never a title/prompt/answer; TTL 60 s, caps 128/32). `.opencode/plugins/collectiviq-native-title.ts` is the dependency-free OpenCode plugin that best-effort renames the OpenCode session from the CollectivIQ provider-native title via that extension endpoint. The plugin's entry module **default-exports the OpenCode V1 `{ id, server }` plugin object** so OpenCode 1.18.21's loader invokes only `default.server` and never scans the module's named runtime exports. Its provider match reads own data-property descriptors only and fails closed: it accepts the flat runtime `provider.id` as authoritative and falls back to the nested SDK `provider.info.id` only when the flat property is absent (offline hardening). Global and project-local discovery share **one** process-wide hooks/state instance through a `Symbol.for(...)`/`globalThis` singleton (first initialization wins). OpenCode's hidden LLM `title` agent stays disabled in the committed `opencode.jsonc`, so propagation adds no separate completion/thread. The **historical 2026-08-21 sequence** was: the plugin entry module never loaded — its earlier bare-function default was rejected by OpenCode's legacy export scan (`Plugin export is not a function`) — so provider matching, header attachment, polling, and rename never ran (the flat/nested provider support was not that live cause); then, after the V1 default-module loader fix, a trace showed the poller stop before its first title lookup because it resolved its key only from `process.env.COLLECTIVIQ_GATEWAY_KEY` (absent). Both are fixed: the plugin default-exports the V1 module, and it performs one bounded, descriptor-safe connection resolution that reuses the resolved CollectivIQ provider `options.apiKey` (merged-over-embedded) with `COLLECTIVIQ_GATEWAY_KEY` as a lazy fallback, keeping the key local to the poll (never stored/logged). The provider-config→environment precedence and the lazy env fallback are hermetically verified. A sanitized, user-authorized **2026-08-22 live smoke observed the complete propagation path succeed for the tested local configuration** (OpenCode 1.18.21): exactly one new foreground CollectivIQ thread, no hidden title thread, a provider-native title generated for that thread, and the OpenCode top-level session title changed from its default to that provider-native title (the foreground response completed and was relevant, with no alert/tool call). This is a single-local-configuration observation — not production readiness or a cross-account/cross-version guarantee, and it does not establish which credential source was exercised; propagation stays best-effort/bounded/non-fatal, a failure leaves the OpenCode default or manual title, and further live runs remain approval-gated.

**Implemented (Phase 3 emulated tool calling, offline; EXPERIMENTAL):** `src/tools/` — the emulated engine (`limits.ts`, `types.ts`, `copy.ts` descriptor-safe bounded JSON copy, `ids.ts` `call_ciq_<ULID>`, `schema.ts` per-request Ajv compile with root-`$schema` dialect selection (draft-07 default; draft-07 + draft 2020-12 by exact URI allowlist so OpenCode 1.18.21's draft-2020-12 schemas compile; unknown/non-string `$schema` fails closed; no cross-request retention), `normalize.ts`, `protocol.ts` strict §12.2 parser, `canonicalize.ts`, `select.ts` §12.3 voting, `request.ts` normalization + prior tool-history validation; `index.ts` barrel). The request boundary retains and validates the tool policy for a `toolMode: "emulated"` model (`chat-request.ts`/`messages.ts`; `NormalizedChatRequest` gains `tools`/`toolChoice`/`parallelToolCalls`; the compiled toolset rides on `ChatRequestResult`, not the frozen request); `conversation.ts` adds the `tool-or-final` protocol when tools are active (text-only serialization byte-for-byte unchanged); `polling.ts` returns the validated message snapshot (`selectWinningMessage`); `chat-completion.ts` returns a discriminated `CompletionResult` (`text` | `tool_calls`); `chat-response.ts`/`chat-stream.ts` encode tool calls for JSON and synthetic SSE. `src/eval/` holds the approval-gated LIVE tool evaluator (`tools-eval-cli.ts`, `cases.ts`; `npm run eval:tools`) — preflight-by-default, fixed origin, password-only, bounded (200 single + 20 three-step, hard cap 280 completions), ID-only recovery journal, value-free output. Its checkpoint/report boundary lives in `src/eval/checkpoint.ts` and `src/eval/report.ts`, with hermetic coverage in `test/contract/eval-checkpoint.test.ts` and `test/contract/tools-eval-cli.test.ts`. It persists resume state as report v5 / checkpoint v4 at the ignored `.agent/sessions/eval/tools-eval-checkpoint.json`, gated behind `--resume-approved`, with corpus-bound semantic validation before any credential read or network I/O; `.agent/instructions/validation.md` owns the evaluator's operational and resume contracts, and specification section 30 owns its release gates and campaign evidence. The gateway returns model-PROPOSED calls only and never executes a tool.

**Implemented (shared state-aware transition engine, offline).** `src/eval/scenario-engine.ts` owns the ordered synthetic workflow `read → edit → test → final text` and is consumed by BOTH live evaluators, so their expectations can never drift. It owns the prerequisite-gated transition rules (`read` needs the exact synthetic path; `edit` needs a successful `read` plus an exact path+text match; `test` needs a successful `edit` and matching content), the ordered fold of a parallel batch, the deterministic content-safe synthetic tool results, the derived expectation (`pendingStepIndex`/`expectedStepTool`), the per-step gate-evidence helpers plus their bitmask packing, and `assertCorpusMatchesEngine` — the value-free preflight guard both CLIs call before any credential read or network I/O, which requires every multi-step case's declared expected-tool sequence to equal the engine's ordered workflow EXACTLY (a correct count in the wrong order is rejected). It deliberately does not live in `buildEvalCorpusProjection`, so standalone projection/validator tests can still exercise non-uniform structural corpora. All state is synthetic and process-local: no filesystem, shell, MCP, external service, repository content, or real user data, and no tool execution. Hermetic coverage lives in `test/unit/scenario-engine.test.ts`.

**Implemented (multi-step transition diagnostic, offline; approval-gated; ONE live v2 run completed, v3 NOT run live).** `src/eval/` gains four more modules with strict ownership:

- `live-round.ts` owns the SHARED create → recovery-journal record → submit → poll → exactly-one-immediate-delete → journal-drop lifecycle for one upstream completion, plus the pure `buildRoundRequest`. It was extracted verbatim from `tools-eval-cli.ts`, and BOTH evaluators consume it — the round lifecycle must never be duplicated. It owns the exactly-one-DELETE, no-POST-retry, independent-cleanup-signal, create-time-journal-short-circuit, trap-safe-error, and never-throws guarantees.
- `diagnostic-report.ts` owns the INDEPENDENT version-3 diagnostic output union (`preflight | progress | blocked | executed`) and the closed classification unions `AllowedCallRelation`, `DiagnosticSelectionSource`, and `DiagnosticCallMultiplicity`, their fixed integer code maps with closed-`switch` decoders, the reason ⇄ dimension contract, and the pure TRANSITION-aware relation classifier (prior/future buckets judged against SUCCESSFULLY completed transitions, taking `satisfiedTools`/`pendingTools` and failing closed on an incomplete, duplicated, or overlapping scenario view). The v2 member `expected-already-invoked` is REMOVED as unreachable under a state-aware expectation; ledger codes 1–6 keep their meaning and code 7 is no longer decoded. It reuses `report.ts`'s closed abort/cleanup/failure-reason vocabulary rather than re-declaring it, so the two evaluators cannot disagree on what a stage or reason means. Its version moves independently of the release evaluator's report v5.
- `diagnostic-checkpoint.ts` owns the SEPARATE version-3 diagnostic checkpoint format (versions 1 and 2 rejected, no migration), its own hard-coded filename and location, the fingerprint-bound diagnostic corpus selection/projection, corpus-bound semantic validation (including the per-committed-scenario `scenarioEvidence` tuple `[executedRounds, satisfiedSteps]` and the terminal diagnostic's scope-vs-satisfied-state agreement), and rehydration. It is deliberately self-contained and imports nothing from `checkpoint.ts`, so the diagnostic structurally cannot read, overwrite, finalize, or remove the release checkpoint.
- `tools-diagnostic-cli.ts` owns preflight, approval parsing, the multi-step-only orchestration, progress, resume, cleanup, and final reporting (`npm run eval:tools:diagnose`). It reuses the release evaluator's exported failure classifier and its production transport wiring, and assigns every dep field explicitly so the diagnostic checkpoint store can never be inherited by accident. It also owns the scenario-local transition state that makes the relation state-aware (read from the shared engine before each round runs, discarded at scenario end) and the rule that a resumable checkpoint never encodes a complete-corpus cursor — the final scenario's commit stays in memory so the last durable file remains resume-valid.

Hermetic coverage lives in `test/contract/tools-diagnostic-cli.test.ts`, `test/contract/eval-diagnostic-checkpoint.test.ts`, and `test/contract/eval-diagnostic-report.test.ts`. The diagnostic establishes NO release gate; specification section 30.1 owns its normative contract and `.agent/instructions/validation.md` owns its operational detail.

**Phase 3 release status (summary only).** The corrected report-v4 evaluator completed a full live campaign on 2026-08-31: six of the eight section-30 gates passed, while **tool-name accuracy and multi-step success failed**. Section 30 therefore remains **unmet**, remediation was deliberately **deferred**, and Phase 3 stays experimental, opt-in, and non-default. The evaluator has since moved to **report v5 / checkpoint v4** state-aware multi-step scoring, which is offline only and has **NOT been run live**, so it supersedes no campaign number. See specification section 30 for the campaign record and gate evidence, and `.agent/instructions/validation.md` for the operational validation detail. Do not maintain a campaign ledger in this document.

**Still planned:** native tool mode, Redis/idempotency, metrics/tracing, and true upstream streaming. The boundary ownership rules below apply as those modules are created.

## Request Flow

The intended dependency and data flow is:

```text
Fastify API boundary
  -> authentication and normalized OpenAI request
  -> virtual model resolution and prompt serialization
  -> capacity acquisition
  -> generation orchestration
  -> typed CollectivIQ adapter and polling
  -> text/tool response parsing
  -> OpenAI object or SSE encoding
```

Observability records metadata around each stage without taking ownership of domain flow or content.

## Boundary Ownership

### Process and composition

- `src/index.ts` is the process entry point: load configuration, construct dependencies, start, and handle signals.
- `src/server.ts` constructs the application without forcing a listening socket, so tests can exercise it in-process.
- Startup fails before listening when required configuration is invalid.

### API boundary

- `src/api/` owns HTTP routing, gateway authentication, body/content-type limits, request IDs, public status/header behavior, and OpenAI-style error envelopes.
- Route handlers delegate use cases; they do not know CollectivIQ wire formats or implement tool parsing.

### OpenAI boundary

- `src/openai/` owns the supported Chat Completions compatibility profile: input schemas, normalization, response objects, and SSE framing.
- Raw public requests must become normalized internal values before they reach generation logic.

### Generation application layer

- `src/generation/` owns orchestration, state transitions, model resolution, polling policy, capacity, cancellation, and deadlines.
- It depends on typed ports and normalized domain values, not Fastify request/reply objects.
- Capacity is acquired before thread creation and released in `finally`-equivalent cleanup.

### Upstream boundary

- `src/collectiviq/` is the only code allowed to know `/create_thread`, `/process_message`, `/get_messages`, multipart field names, bearer-header details, or provisional upstream response schemas.
- The adapter returns validated, normalized types and normalized failures.

### OpenCode session-title extension

- `src/opencode/` owns the process-local session-to-upstream-thread correlation (`title-bridge.ts`) that backs the `GET /v1/opencode/session-title` extension route (`src/api/opencode-title-route.ts`, owned by the API boundary). It stores only opaque ids and the upstream thread id under bounded TTL/caps — never a title, prompt, or answer — and is synchronous, bounded, and non-throwing.
- `.opencode/plugins/collectiviq-native-title.ts` is the OpenCode-side plugin (not part of the gateway service): it arms an eligible foreground session, then propagates the CollectivIQ provider-native title back to the OpenCode session by polling that extension endpoint. It is descriptor-safe, best-effort, and process-wide idempotent (see the implementation entry above); it does not know CollectivIQ wire formats and never executes tools. Detailed behavior belongs to spec §§9.5 and 25 — do not restate it in full here.

### Prompt and tool policy

- `src/prompts/` owns deterministic prompt construction: the versioned full-history conversation/control prompt (`conversation.ts`, `promptMode: "protocol"`), the latest-user-only direct prompt (`direct.ts`, `promptMode: "direct"`), and the model-policy-aware selector (`serializer.ts`) that dispatches on the validated `promptMode` — never a model-id string.
- `src/tools/` owns the emulated protocol envelope, JSON/schema validation, canonicalization, candidate voting, and call-ID generation policy.
- Neither area executes tools.

### Cross-cutting support

- `src/config/` owns validation and loading, not mutable global state.
- `src/observability/` owns safe logging/metrics/tracing APIs and redaction defaults.
- `src/shared/` is for small cohesive primitives such as IDs, abort-aware deadlines, and redaction helpers. It must not become a dumping ground.

## Core Domain Types

Prefer explicit types for:

- normalized chat requests and messages;
- virtual model execution policy;
- request context, state, and terminal failure category;
- upstream adapter inputs/results/capabilities;
- parsed text versus parsed tool-call generations;
- public error codes and response encoding inputs.

Keep raw public and upstream payload types at their boundaries. Do not pass arbitrary objects or framework request types through the service.

## State and Lifecycle Invariants

- One public completion maps to one new upstream thread.
- The full conversation is serialized on every completion request for `promptMode: "protocol"` models (the default). The `promptMode: "direct"` compatibility profile is the one exception — it serializes only the latest user message and intentionally drops the rest (spec §8.4.1) — and must not be generalized to protocol models.
- A concurrency permit covers thread creation through parsing and cleanup.
- Client abort and total deadline share a cancellation path that stops polling and releases resources.
- A public response is encoded only from a validated parsed generation.
- State-transition instrumentation never includes prompt or response content.
- Persistent thread reuse and upstream event streaming remain out of scope until the prerequisites in the specification are verified.

## Change Guidance

- Add behavior to the component that owns the policy; do not shortcut boundaries for convenience.
- If a new upstream field is useful, validate it in the adapter before exposing a normalized field.
- If a public compatibility behavior changes, update schemas, encoders, compatibility tests, and documentation together.
- If orchestration changes, test success, timeout, cancellation, and cleanup paths.
- Avoid speculative interfaces for unverified CollectivIQ features. Represent capability uncertainty explicitly.
- Keep components independently testable through dependency injection or narrow constructor/factory inputs.
