# AGENTS.md

## Scope and Precedence

These instructions apply to the entire repository unless a more specific `AGENTS.md` exists in a subdirectory. More specific instructions override broader ones for files under their scope.

Committed topic guidance lives in `.agent/instructions/`. Ephemeral notes, scratch work, checklists, and handoffs belong under `.agent/sessions/`.

When instructions conflict, follow this order:

1. System, platform, and user instructions.
2. The nearest applicable `AGENTS.md`.
3. Task-relevant `.agent/instructions/*.md`.
4. `.agent/docs/tech-software-spec.md` and other project documentation.
5. Existing code, tests, and configuration.

`.agent/docs/tech-software-spec.md` is the current product and architecture source of truth. Its normative requirements take precedence over summaries in agent documents. If documentation, code, tests, or instructions disagree, identify the conflict and resolve the affected sources together; ask the user when intended behavior is unclear.

## Repository Facts

- The project is the CollectivIQ OpenAI-Compatible Gateway: a local or privately hosted HTTP service between OpenCode and CollectivIQ.
- The compatibility target is the bounded OpenAI Chat Completions profile needed by `@ai-sdk/openai-compatible`, not the full OpenAI API.
- The reference stack is current supported Node.js LTS, strict TypeScript, Fastify, native `fetch` or Undici, schema validation, Pino, Prometheus-compatible metrics, Vitest, npm, and Docker.
- Each completion is stateless from the public API's perspective and creates exactly one new CollectivIQ thread in the initial architecture.
- Only the typed CollectivIQ adapter may know upstream endpoint paths and wire schemas.
- The gateway translates tool definitions and model-generated requests but never executes OpenCode tools.
- Input is text-only in the initial release. Responses support non-streamed output and buffered synthetic SSE streaming.
- Prompt content, source code, file paths, tool arguments/results, and model answers are neither logged nor retained by default.
- Emulated tool calling is experimental until all release gates in `.agent/docs/tech-software-spec.md` section 30 pass.
- The project has a runnable foundation: configuration loading/validation (including bounded gateway-key parsing — ≤64 keys, ≤8192 UTF-8 bytes/key), a Fastify server construction factory, `/healthz` and `/readyz` routes, credential-redacting logging, graceful shutdown, tests, Docker packaging, and CI. It also has the **Phase 1A** authenticated public model surface (offline, no live CollectivIQ call): mandatory gateway client authentication on every `/v1/*` route (`Authorization: Bearer` vs `COLLECTIVIQ_GATEWAY_KEYS`, case-insensitive scheme, exact-match token, fixed-length SHA-256 + `timingSafeEqual`, fixed `401`), an immutable virtual-model catalog/resolver (exact-case, config-order, one captured `created` timestamp per server instance), public OpenAI model objects, `GET /v1/models` and `GET /v1/models/:model`, and shared bounded OpenAI error envelopes (`401`/`404`/`500`). Health/readiness stay unauthenticated, and none of these routes — `/healthz`, `/readyz`, and the Phase 1A model metadata endpoints — call CollectivIQ. It also has an offline (Phase 0) CollectivIQ adapter boundary under `src/collectiviq/`: the production adapter for the three core operations, a bounded/cancellation-aware transport, a normalized content-free error model with method-aware retry metadata, provisional response validation, a shared dual-mode upstream credential provider (`src/collectiviq/auth.ts`: `bearer` default plus an OAuth2 password-exchange mode via `POST /login`, login **verified-live**, selected by `COLLECTIVIQ_AUTH_MODE`), an opt-in staged discovery session/CLI (preflight by default; token-inspection and abort discovery disabled), value-free cleanup diagnostics and a content-free recovery journal plus a recovery-only `contract:discovery:cleanup` command, a committed filtered OpenAPI snapshot of **ten** allowlisted operations (`contract/collectiviq/`), bounded extraction tooling (`scripts/openapi/`), and hermetic contract tests (`test/contract/`). The production adapter is now **wired into the authenticated, non-streamed Phase 1B `POST /v1/chat/completions` path** (detailed in the Phase 1B entry below); its discovery/recovery tooling remains operator-only and outside the public request path. A real completion request can call CollectivIQ, but import, construction, tests, and the build smoke do not, and the live OpenCode/CollectivIQ smoke test remains unrun and approval-gated. Four authorized authenticated baseline discovery runs were executed: two on 2026-08-06 and 2026-08-07 in `bearer` mode (both failed strict completeness), and two on **2026-08-11 in `password` mode that BOTH passed strict completeness (exited zero)** with **identical** sanitized results (`evidenceFormatVersion` 2). Password `POST /login` and the core create/submit/messages contract are therefore **verified-repeatable** and encoded into synthetic fixtures (`processAccepted202`, `messagesCreateTime`; no live value committed); `validation.ts` now maps `createdAt` from `create_time`. Thread-deletion outcomes were **credential/principal-dependent** (cause not established): the password/member principal deleted its own newly created thread (`200`, repeated) while re-deleting that same just-deleted id returned `403`; the API-key principal's own-thread delete returned `403` (2026-08-07); a cross-principal recovery attempt also returned `403` — consistent with a permission/scope check, but the provider's evaluation order is unconfirmed, so recovery's exact-`404` convergence was not exercised. Phase 0 has advanced substantially but is not auto-declared complete (open items: idempotency, ordering/pagination, prompt/rate limits, retention, native tools, true-streaming/SSE scope, token lifetime). Text-only synthetic SSE streaming (`stream: true`) is now implemented offline (**Phase 2**, detailed below). The tool, Redis, metrics/tracing, and idempotency features remain unimplemented, as does **true** upstream streaming; those paths are still planned until they actually exist. (Gateway client authentication and the public model endpoints are implemented per Phase 1A above.)
- **Phase 1B is implemented (offline; live upstream only at request time):** an authenticated, non-streamed, text-only `POST /v1/chat/completions` wired through the typed CollectivIQ adapter. It normalizes the OpenAI request (`src/openai/chat-request.ts`, `messages.ts`, `chat-types.ts`), rejects deferred features with stable `400`s, resolves the internal model policy (`ModelCatalog.resolveModel`), serializes a deterministic versioned prompt (`src/prompts/conversation.ts`), enforces process-local global + per-key capacity with a bounded queue (`src/generation/capacity.ts`), acquires capacity **before** creating exactly one upstream thread, submits once (never retrying `create_thread`/`process_message`), polls `get_messages` with a total deadline, capped 1.25 backoff + jitter, GET-only retry, and desired-source selection (`src/generation/polling.ts`), orchestrates the flow (`src/generation/chat-completion.ts`), and encodes the non-streamed response with zero/unavailable usage (`src/openai/chat-response.ts`). Client-disconnect + total-deadline + shutdown share one abort path; a deadline maps to `504`, a client disconnect sends no body, a shutdown cancellation (client still connected) maps to `503`. The runtime credential provider is built from validated config without re-reading the environment (`buildCredentialProviderFromConfig`), and construction opens no socket and makes no CollectivIQ/login call. Each completion creates a **new** CollectivIQ thread; the gateway retains no prompt/answer content after the request, but provider-side retention/training/deletion remain unknown. The orchestration is now split into a synchronous `prepare` (resolve model + serialize prompt + enforce `maximumPromptBytes` + mint the stream-stable id/`created`) and an async `run` (capacity → one thread → one submit → authoritative poll → trusted text) so the API layer owns JSON-vs-SSE encoding; all Phase 1B guarantees (capacity before thread creation, release on every exit path, no `create_thread`/`process_message` retry, authoritative deadline/cancellation, trap-safe error identity) are preserved. The live OpenCode/CollectivIQ smoke test is **not run** (pending separate approval).
- **Phase 2 is implemented (offline; live upstream only at request time):** text-only buffered **synthetic SSE** for `POST /v1/chat/completions` with `stream: true`, served by the same route alongside the non-streamed JSON path. Request normalization (`src/openai/chat-request.ts`, `chat-types.ts`) carries a normalized `stream: boolean` (absent/`false` → JSON, exactly `true` → SSE, every other value → stable `400`). The pure frame encoder + deterministic code-point-safe split live in `src/openai/chat-stream.ts` (target 128 / max 256 / min 32 code points; paragraph→sentence→whitespace boundaries; concatenation reproduces the answer exactly); the SSE transport — header commit after preparation succeeds, an assistant-role opener before any upstream work, a `: collectiviq-gateway keep-alive` comment every 15 s while polling, backpressure-aware serialized writes, keep-alive timer cleanup, a terminal `finish_reason: "stop"` chunk then `data: [DONE]`, content-free `data: {"error": …}` records (a `503` on shutdown only while the transport is still writable — an undrainable/failed-terminal response is force-closed, on a bounded `res.end()` fallback if needed, and may end silently), and write-failure/disconnect cancellation that stops polling and releases capacity — lives in `src/api/chat-stream-response.ts`, driven from `src/api/chat-completions-route.ts`. No `usage` is emitted on a stream; tool-call streaming stays Phase 3; streaming is synthetic (polling-backed), not true upstream streaming; the live streaming smoke test is **not run**.
- Implemented source lives under `src/` (`index.ts`, `server.ts`, `api/health-route.ts`, `api/gateway-auth.ts`, `api/models-route.ts`, `api/v1-routes.ts`, `api/chat-completions-route.ts`, `api/chat-stream-response.ts`, `openai/errors.ts`, `openai/models.ts`, `openai/chat-types.ts`, `openai/messages.ts`, `openai/chat-request.ts`, `openai/chat-response.ts`, `openai/chat-stream.ts`, `prompts/conversation.ts`, `generation/model-catalog.ts`, `generation/types.ts`, `generation/capacity.ts`, `generation/polling.ts`, `generation/chat-completion.ts`, `generation/seams.ts`, `generation/runtime.ts`, `config/`, `observability/logger.ts`, `shared/redaction.ts`, and `collectiviq/`); the committed upstream contract snapshot under `contract/collectiviq/`; extraction tooling under `scripts/openapi/`; tests under `test/` (including `test/contract/` and the separate hermetic `test/compatibility/` suite run only by `npm run test:compatibility`). The grounded upstream contract is documented in `.agent/docs/collectiviq-upstream-contract.md`. Package scripts, `package.json`, and `package-lock.json` exist — inspect them rather than assuming (the pinned `ai` / `@ai-sdk/openai-compatible` **dev** dependencies back the compatibility suite only).

## Read First

Before editing:

1. Read this file.
2. Inspect the working tree (`git status --short` when this is a Git worktree) and preserve user changes.
3. Read the task-relevant instruction file from `.agent/instructions/`.
4. Read the relevant sections of `.agent/docs/tech-software-spec.md` and any owner document identified by `.agent/instructions/documentation.md`.
5. Inspect directly related code, tests, and configuration if they exist.

Do not read every instruction file or the entire specification by default. Follow task routing and load only the relevant material.

## Task Routing

| Task touches | Read |
| --- | --- |
| Repository initialization, dependency selection, package scripts, TypeScript config, or initial scaffolding | `.agent/instructions/project-initialization.md`, `.agent/instructions/validation.md`, `.agent/instructions/security.md` |
| Package/module boundaries, service orchestration, state machine, IDs, timeouts, or shared utilities | `.agent/instructions/project-map.md`, `.agent/instructions/validation.md` |
| OpenAI request/response schemas, `/v1/models`, chat completions, errors, message normalization, or SSE | `.agent/instructions/openai-compatibility.md`, `.agent/instructions/validation.md` |
| CollectivIQ HTTP calls, upstream schemas, polling, response selection, retries, timeouts, or fixtures | `.agent/instructions/upstream-integration.md`, `.agent/instructions/validation.md`, `.agent/instructions/security.md` |
| Prompt serialization, tool schemas, tool parsing, candidate selection, or tool-call streaming | `.agent/instructions/tool-calling.md`, `.agent/instructions/openai-compatibility.md`, `.agent/instructions/security.md` |
| Auth, secrets, logging, privacy, limits, retention, Redis, dependencies, or untrusted data | `.agent/instructions/security.md` |
| Configuration, health/readiness, metrics, tracing, concurrency, cancellation, Docker, or shutdown | `.agent/instructions/operations.md`, `.agent/instructions/security.md`, `.agent/instructions/validation.md` |
| Tests, mocks, compatibility checks, adversarial cases, load tests, or release gates | `.agent/instructions/validation.md` plus the relevant domain instruction |
| Documentation-only or documentation-impacting changes | `.agent/instructions/documentation.md` |

## Core Workflow

1. Inspect applicable instructions, relevant specification sections, and directly related files before planning edits.
2. Preserve existing user changes and ignore unrelated files.
3. Use `rg` and `rg --files` for discovery.
4. For non-trivial work, make a short plan covering outcome, affected boundaries, validation, documentation impact, and approval gates.
5. Implement the narrowest complete change that respects the architecture and current delivery phase.
6. Validate with the smallest relevant test or check first, then broaden in proportion to risk.
7. Update the owning documentation when behavior, contracts, architecture, operations, security, or terminology changes.
8. Review the final diff for unrelated changes, speculative scaffolding, generated artifacts, weakened tests, sensitive content, and contradictions.

Use `.agent/sessions/<branch-or-task>/<worker-id>/` only for ephemeral collaboration artifacts. Durable decisions must be moved into source documentation before the task is complete.

## Command Policy

`package.json` defines the canonical scripts; prefer them and the locked package manager (npm, `packageManager` pinned) over ad hoc tool commands. Inspect the file before citing or running a script. The default aggregate check is `npm run validate` (format check, lint, typecheck, tests, build, compiled-import smoke test).

Implemented canonical scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:unit`, `test:integration`, `test:contract`, `test:coverage`, `test:build`, `validate`, plus the standalone hermetic `test:compatibility` (own `vitest.compatibility.config.ts`) and the network-only, opt-in `contract:openapi:check`, `contract:openapi:refresh`, `contract:discovery`, and `contract:discovery:cleanup` (the recovery-only cleanup command). The hermetic upstream contract suite (`test:contract`) is implemented and runs inside `validate` via the `test` glob. `test:compatibility` is hermetic (an ephemeral loopback gateway with a fake completion; no network, credentials, or CollectivIQ calls) but is intentionally **excluded** from `validate`/CI and run on its own. The network-only `contract:*` commands (including `contract:discovery:cleanup`) must never be added to `validate` or CI. Adversarial and load suites are not implemented yet and must not be added to `validate`; see `.agent/instructions/validation.md`.

Do not claim a command exists or passed when it was unavailable. Do not install dependencies, regenerate a lockfile broadly, or choose package versions as a side effect of unrelated work.

## Architectural Invariants

- Keep the public API stateless. Do not reuse upstream threads until the specification's correlation, cleanup, and reliability prerequisites are met.
- Preserve full ordered conversation history and declared roles in the versioned JSON envelope.
- Keep upstream schemas and endpoint knowledge inside the CollectivIQ adapter.
- Treat every upstream response as untrusted and validate it before use.
- Never execute tools in the gateway.
- Polling remains authoritative until request-scoped upstream event correlation is verified.
- Do not automatically retry `create_thread` or `process_message` without proven idempotency.
- Acquire concurrency capacity before creating an upstream thread, and release it on every exit path.
- Propagate client cancellation through pending upstream work and stop polling promptly.
- Return OpenAI-style public errors; never expose raw production upstream bodies.
- Do not present estimated token counts as exact usage.
- Do not broaden compatibility or enable experimental tool mode by default without the corresponding tests, documentation, and release evidence.

## Critical Risk Index

Read the routed security and domain instructions before changing:

- credential handling, authentication, gateway binding, TLS assumptions, or metrics exposure;
- prompt serialization, role precedence, boundary generation, or content logging;
- tool parsing, JSON Schema validation, tool-choice enforcement, or fallback voting;
- upstream retries, timeouts, polling completion, duplicate-message selection, or cancellation;
- request/body/prompt/tool/upstream size limits, queues, concurrency, or rate limits;
- Redis idempotency, response caching, retention, or cross-replica state;
- SSE framing, keep-alives, terminal chunks, or disconnect handling;
- error/status mappings and any raw upstream diagnostic data.

## Approval Required

Ask for explicit user approval before initiating:

- destructive file operations, mass deletion, recursive moves, overwrite scripts, or cleanup commands;
- Git history changes, force pushes, shared-branch rebases, commits, pushes, tags, releases, or PR publication unless explicitly requested;
- deployment, package publishing, infrastructure mutation, secret-store changes, or other external writes;
- reading, printing, copying, rotating, or modifying real credentials or sensitive prompt/response data;
- major dependency upgrades, package-manager migrations, or broad lockfile regeneration outside the task;
- live CollectivIQ probes that transmit repository content or may create material cost/thread volume;
- enabling content logging, persistent prompt/response storage, or experimental tool mode in a production configuration;
- large mechanical rewrites, generated-code refreshes, or formatting sweeps across many files.

State the exact action, why it is needed, what it can change or expose, and a safer alternative when one exists.

## Security and Privacy Musts

- Keep the upstream credentials — `COLLECTIVIQ_API_KEY` (bearer mode) or `COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` (password mode) — separate from gateway client keys, and redact all of them everywhere.
- Never commit real secrets or include them in commands, logs, fixtures, examples, errors, traces, snapshots, or session notes.
- Keep production content logging off. Development content logging requires both the explicit development-only switches and a prominent warning.
- Default binding is loopback. Non-loopback exposure requires explicit configuration plus authentication and deployment controls.
- Validate and bound request bodies, prompts, tool collections/schemas/arguments, upstream responses, queues, concurrency, and durations.
- Hash correlation identities only when needed; do not use prompt-derived permanent identifiers across trust boundaries.
- Sanitize every live upstream fixture before committing it.
- Treat prompt injection as an inherent trust-boundary risk, not something JSON delimiters eliminate.
- Preserve the default no-content-retention behavior; short-lived caches require an explicit design and security review.

Use `.agent/instructions/security.md` for the complete task checklist.

## Documentation Rule

Behavior, API contracts, architecture, upstream assumptions, configuration, security posture, deployment, testing, or terminology changes must update their owner documentation in the same task.

Agent instructions summarize how to work; they must not silently redefine the product specification. Use `.agent/instructions/documentation.md` for ownership and synchronization rules.

## Git and Change Hygiene

- Do not invent a branch model; none is defined by the specification.
- Do not commit, push, open or merge PRs, tag, publish, or deploy unless the user explicitly asks.
- Keep dependency versions locked once the package is initialized.
- Avoid unrelated refactors, formatting sweeps, generated files, and lockfile churn.
- Never discard user changes to make validation pass.

## Final Response Format

When finishing a change, report:

1. **Summary**: what changed and why.
2. **Files changed**: key files and their purpose.
3. **Validation**: exact commands run and results.
4. **Documentation**: owner docs updated, or why none were needed.
5. **Risks or follow-ups**: assumptions, unavailable checks, known limitations, or reviewer attention.

Keep the response concise, factual, and tied to the actual diff.

## Done Definition

A task is done when:

- The requested behavior is complete and scoped to the current delivery phase.
- Public and upstream contracts remain explicit and validated.
- Relevant tests or checks have run, or the reason they could not run is reported.
- Security, privacy, cancellation, limits, and approval gates have been considered where applicable.
- Owner documentation is accurate and internally consistent.
- The diff contains no unrelated rewrites, sensitive values, unsanitized fixtures, local-only artifacts, or weakened tests.
- A reviewer can understand what changed, why, how it was checked, and what remains uncertain.
