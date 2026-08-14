# Project Map and Architecture

## Source of Truth

Read `.agent/docs/tech-software-spec.md` sections 5–8, 15, 26, 27, and 36 for architectural principles, components, request state, planned paths, orchestration, and the final design.

**Implemented today (foundation):** `src/index.ts`, `src/server.ts`, `src/api/health-route.ts` (`/healthz`, `/readyz`, and the injected readiness state), `src/config/schema.ts`, `src/config/load.ts`, `src/observability/logger.ts`, and `src/shared/redaction.ts`, with tests under `test/`.

**Implemented (Phase 1A public model surface, offline):** `src/api/gateway-auth.ts` (fixed-length SHA-256 + `timingSafeEqual` gateway-key authentication), `src/api/v1-routes.ts` (the encapsulated authenticated `/v1` route group with its `onRequest` auth hook and scoped internal-error handler), `src/api/models-route.ts` (`GET /v1/models`, `GET /v1/models/:model`), `src/openai/errors.ts` (shared OpenAI error envelopes), `src/openai/models.ts` (public model objects), and `src/generation/model-catalog.ts` (immutable exact-case resolver with one captured `created` timestamp). These model metadata routes (and unauthenticated `/healthz`/`/readyz`) do not call CollectivIQ.

**Implemented (upstream boundary, offline Phase 0):** `src/collectiviq/` — the production adapter (`adapter.ts`), bounded transport (`http.ts`, including the discovery-only any-status `observeUpstreamJson` that is not exported from `index.ts`), shared pure request builders (`requests.ts`), provisional response validators (`validation.ts`), normalized error model (`errors.ts`), fixed endpoint paths (`endpoints.ts`), adapter types/capabilities (`types.ts`), value-free correlation (`correlation.ts`), and the opt-in **staged discovery session** plus SSE evidence and sanitized structural capture (`discovery.ts` — `DiscoverySessionRunner`, `readSseEvidence`, strict `exitCodeForBaseline`; thin `discovery-cli.ts`; `structural-capture.ts`). Discovery captures raw upstream structure, retains correlation ids privately, keeps a truthful cleanup ledger, and gates every destructive delete on approval. The filtered OpenAPI snapshot lives at `contract/collectiviq/`, its tooling at `scripts/openapi/`, and hermetic contract tests at `test/contract/`. **The production adapter is now wired into the Phase 1B completion path** (`POST /v1/chat/completions`; see the Phase 1B entry below). The discovery, recovery, SSE-evidence, and other operator tooling remain out-of-band and are not public production routes. Construction and import stay socket-free and perform no upstream I/O; only a real completion request reaches CollectivIQ.

**Implemented (Phase 1B non-streamed chat completions, offline):** `src/api/chat-completions-route.ts` (the authenticated `POST /v1/chat/completions` route, its child-scope framework-error mapping, and client-disconnect wiring), `src/openai/chat-types.ts`/`messages.ts`/`chat-request.ts` (request validation/normalization) and `chat-response.ts` (the non-streamed encoder), `src/prompts/conversation.ts` (deterministic versioned prompt), `src/generation/types.ts` (capacity/poller/serializer ports), `capacity.ts` (process-local global + per-key admission with a bounded queue), `polling.ts` (bounded polling + desired-source selection), `chat-completion.ts` (orchestration), `seams.ts` (clock/id), and `runtime.ts` (composition from validated config). The `ModelCatalog` now also resolves the internal `VirtualModel` policy (`resolveModel`) without changing public model output. `validateChatRequest` takes that resolver, returns the resolved `VirtualModel` alongside the frozen request, and runs the model-policy-aware **tool-metadata compatibility bridge (Phase 2.1)**: for a `toolMode: "disabled"` model it tolerates and discards OpenCode's automatic `tools`/`tool_choice` metadata (bounded to ≤128 entries AND ≤2 MiB aggregate JSON via a descriptor-only, iterative shape/byte accounting that never invokes `[[Get]]`/getters/`toJSON`; retained/serialized/forwarded nowhere) and rejects tool-requiring/named choices, over-budget/anomalous collections, and non-disabled modes — the raw-body access and tool-name recording stay inside the `src/openai/` boundary. The CollectivIQ adapter is now wired into this completion path (one new thread per request); construction still makes no upstream call.

**Implemented (Phase 2 text-only synthetic SSE streaming, offline):** `src/openai/chat-stream.ts` (the pure `chat.completion.chunk` frame encoders and the deterministic, code-point-safe content split — the OpenAI boundary owns frame encoding and splitting) and `src/api/chat-stream-response.ts` (the SSE transport — header commit after preparation, backpressure-aware serialized writes, keep-alive timers, terminal/`[DONE]` framing, content-free error records, and write-failure/disconnect cancellation — the API boundary owns SSE transport, backpressure, keep-alives, and cancellation). The same `POST /v1/chat/completions` route serves both paths; `chat-completion.ts` is split into a synchronous `prepare` and an async `run` so the API layer commits SSE headers only after preparation succeeds. `chat-request.ts`/`chat-types.ts` normalize `stream` to a boolean.

**Still planned:** `src/tools/` (emulated/native tool calling, including tool-call streaming), Redis/idempotency, metrics/tracing, and true upstream streaming. The boundary ownership rules below apply as those modules are created.

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

### Prompt and tool policy

- `src/prompts/` owns deterministic, versioned conversation and control-prompt construction.
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
- The full conversation is serialized on every completion request.
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
