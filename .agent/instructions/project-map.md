# Project Map and Architecture

## Source of Truth

Read `.agent/docs/tech-software-spec.md` sections 5–8, 15, 26, 27, and 36 for architectural principles, components, request state, planned paths, orchestration, and the final design.

**Implemented today (foundation):** `src/index.ts`, `src/server.ts`, `src/api/health-route.ts` (`/healthz`, `/readyz`, and the injected readiness state), `src/config/schema.ts`, `src/config/load.ts`, `src/observability/logger.ts`, and `src/shared/redaction.ts`, with tests under `test/`. **Still planned:** everything else below — `src/api/` auth/errors/model/chat routes, `src/openai/`, `src/collectiviq/`, `src/generation/`, `src/prompts/`, and `src/tools/`. The boundary ownership rules below apply as those modules are created.

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
