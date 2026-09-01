# Project Initialization

## Purpose

Use this guide while extending the runnable foundation into the strict TypeScript reference implementation. `.agent/docs/tech-software-spec.md` sections 7, 26, 29, and 31 own the stack, planned structure, test strategy, and packaging requirements.

## Implemented Decisions (foundation)

The initial scaffold is in place. The concrete choices made are:

- **Runtime:** Node.js 24 LTS. `.nvmrc` pins major `24`; `package.json` `engines` requires `>=24 <25`; `.npmrc` sets `engine-strict=true` and `save-exact=true`.
- **Package manager:** npm, with `packageManager` pinned and a single committed `package-lock.json`.
- **Module system:** ESM (`"type": "module"`) with TypeScript `NodeNext` module/resolution; relative imports use explicit `.js` extensions.
- **Language:** strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, and `noEmitOnError`. Production build (`tsconfig.json`) emits `src/` to `dist/`; `tsconfig.test.json` type-checks sources and tests with no emit.
- **Schema validation:** TypeBox (the `typebox` package) with `@fastify/type-provider-typebox`, used for configuration, model-file, and route response schemas. Do not introduce a second validation library.
- **HTTP/logging:** Fastify and Pino.
- **Tooling:** Vitest (+ V8 coverage), ESLint flat config with typed `typescript-eslint` rules, and Prettier (scoped so `.agent/` docs and the specification are not reformatted).
- **Packaging/CI:** multi-stage Dockerfile pinned to a Node 24 bookworm-slim digest running as non-root `node`; Compose publishing to host loopback only; GitHub Actions running `npm run validate` plus a no-push Docker build, with actions pinned to commit SHAs.
- **Model-config safety limits and diagnostics:** the model file is bounded by `MODEL_CONFIG_LIMITS` in `src/config/schema.ts` (documented in spec section 24.1). Configuration and startup diagnostics are value-free (a single fixed internal message for unexpected startup errors; stable field/reason pairs for configuration issues), and log records are recursively sanitized with bounded depth/width/length. Do not weaken these limits or reintroduce library error text into diagnostics.

Note: TypeScript is pinned within the range supported by `typescript-eslint`. The OpenAI, CollectivIQ, generation, and prompts modules now exist and are wired into the implemented `POST /v1/chat/completions` path (non-streamed Phase 1B and synthetic-SSE Phase 2); the hermetic contract suite exists. The `src/tools/` emulated tool-calling engine is also implemented offline (Phase 3, supported opt-in beta / non-default), as are the hermetic compatibility and adversarial suites. Still planned: `native` tool mode, true upstream streaming, Redis, metrics/tracing, and the load and live/OpenCode test suites.

## Initialization Principles

- Create only the structure required by the current delivery phase or task. Do not prefill every planned module with placeholders.
- Use the current supported Node.js LTS at initialization time and record the supported range in the package metadata and setup documentation.
- Use npm and commit exactly one lockfile. Install reproducibly in CI and containers.
- Enable strict TypeScript from the first source file. Do not defer strictness through broad `any`, unchecked assertions, or blanket compiler exclusions.
- Prefer platform capabilities before adding dependencies: native `fetch` is acceptable when it meets timeout, cancellation, multipart, and response-limit needs.
- Choose one schema-validation approach and use it consistently across configuration, public API input, tool envelopes, and upstream responses.
- Keep runtime dependencies minimal. Development-only tools belong in development dependencies.
- Pin container base images deliberately and use a non-root runtime user in the production image.

## Planned Shape, Not Existing State

The module tree in specification section 26 is the architectural target. Create paths when real behavior needs them, while preserving these boundaries:

- `src/config/`: validated configuration and model-file loading;
- `src/api/`: HTTP-only concerns such as routes, auth, limits, and public error mapping;
- `src/openai/`: OpenAI request normalization and response/SSE encoding;
- `src/collectiviq/`: the sole upstream protocol boundary;
- `src/generation/`: use-case orchestration, state, polling, concurrency, and model resolution;
- `src/prompts/`: versioned, deterministic serialization and control templates;
- `src/tools/`: emulated tool protocol and deterministic selection;
- `src/observability/`: content-safe logging, metrics, and tracing;
- `src/shared/`: small policy-free utilities only;
- `test/`: unit, contract, integration, compatibility, adversarial, load, and sanitized fixtures as they become relevant.

Do not create barrel files or generic `utils`/`common` modules unless an actual cohesive API justifies them.

## Package and Tooling Decisions

When creating `package.json`:

- make the supported Node version explicit;
- keep module format, TypeScript module resolution, and runtime invocation internally consistent;
- define canonical scripts for type checking, lint/format checks, unit tests, broader tests, build, and local run as those capabilities are added;
- separate fast default validation from networked, load, and live-upstream checks;
- ensure test and build output is untracked or ignored;
- document every script in `.agent/instructions/validation.md` once its name is real.

Before selecting exact versions, verify current compatible releases from primary package documentation. Dependency choice is implementation work; do not encode floating tags or unverified versions in agent documentation.

## Configuration Bootstrap

- Validate environment variables and model configuration before starting the HTTP listener.
- Provide safe examples, never functional secrets.
- Default to `HOST=127.0.0.1`, content logging off, conservative limits, and polling-based upstream completion.
- Keep environment parsing separate from application configuration types.
- Treat the model file as untrusted configuration and reject invalid or duplicate virtual-model definitions.
- Do not publish context-window or token-limit claims without observed or documented upstream evidence.

## Delivery Order

Keep implementation aligned with specification section 32:

1. Phase 0: upstream contract discovery and sanitized fixtures.
2. Phase 1: authenticated non-streamed text gateway and Docker/OpenCode smoke path.
3. Phase 2: buffered synthetic streaming and disconnect cancellation.
4. Phase 3: opt-in beta emulated tool calling and its release evidence.
5. Phase 4: production hardening such as Redis, tracing, load tests, and runbooks.
6. Phase 5: verified native upstream capabilities only.

Do not pull later-phase complexity into an earlier phase without a task-specific need.

## Initialization Validation

At minimum, verify:

- clean dependency installation from the lockfile;
- strict type checking;
- a test can import the built application without opening a real listener;
- configuration rejects missing/invalid values and redacts secrets;
- the server can be constructed separately from the process entry point;
- build output starts on the supported Node runtime;
- container configuration binds host publishing to loopback in the supplied local deployment;
- no real secrets or content-bearing fixtures enter the diff.

Update the validation guide and setup owner docs as commands become available.
