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
- The project is currently specification-first. Paths in the recommended project structure are planned until they actually exist; do not assume scaffolding or package scripts have already been created.

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

The repository does not yet define package scripts. Once `package.json` exists, prefer its scripts and the locked package manager over ad hoc tool commands. Inspect the file before citing or running a script.

Expected validation categories are type checking, formatting/linting, unit tests, contract tests, compatibility tests, integration tests, and build/package checks. Their canonical command names must be documented in `package.json` and `.agent/instructions/validation.md` when established.

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

- Keep `COLLECTIVIQ_API_KEY` separate from gateway client keys and redact both everywhere.
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
