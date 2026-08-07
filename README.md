# CollectivIQ OpenAI-Compatible Gateway

A local or privately hosted HTTP service that will sit between OpenCode and
CollectivIQ, exposing a bounded OpenAI Chat Completions-compatible profile.

> **Status: runnable foundation plus an offline upstream adapter boundary.**
> This repository provides a secure, validated service skeleton and an
> OpenAPI-grounded CollectivIQ adapter with hermetic contract tests. It does
> **not** yet implement chat completions, model listing, live CollectivIQ calls,
> prompt serialization, tool calling, streaming, or Redis, and the adapter is
> **not wired into any request path**. Those remain planned per
> [`.agent/docs/tech-software-spec.md`](.agent/docs/tech-software-spec.md). The
> grounded upstream contract is documented in
> [`.agent/docs/collectiviq-upstream-contract.md`](.agent/docs/collectiviq-upstream-contract.md).

## What works today

- Strict configuration loading and validation (environment + YAML model file).
- A Fastify server that can be constructed in-process without binding a socket.
- Liveness (`GET /healthz`) and readiness (`GET /readyz`) endpoints. Neither
  calls CollectivIQ or any dependency.
- Credential-redacting Pino logging with content logging off by default.
- Graceful `SIGINT`/`SIGTERM` shutdown.
- Docker packaging and GitHub Actions CI.
- An OpenAPI-grounded CollectivIQ **adapter boundary** (`src/collectiviq/`) for
  the three core operations, with a bounded/cancellation-aware transport, a
  normalized content-free error model (with method-aware retry metadata),
  provisional response validation, an opt-in staged discovery session/CLI
  (preflight by default), a committed filtered OpenAPI snapshot
  (`contract/collectiviq/`), and hermetic mock-server contract tests
  (`test/contract/`). **Not wired into any route or completion path.**

## What is not implemented yet

`GET /v1/models`, `GET /v1/models/:model`, `POST /v1/chat/completions`,
`GET /metrics`, gateway authentication, prompt construction, emulated/native
tool calling, synthetic SSE streaming, polling, generation orchestration, and
any live CollectivIQ call. The adapter exists but is not connected to a public
endpoint. One authorized authenticated discovery baseline ran on 2026-08-06 and
**failed strict completeness (exited non-zero)**; its evidence is observed-once
and sanitized, not verified, and no live capture was promoted. Upstream response
shapes are therefore provisional or observed-once, and Phase 0 is not complete.

## Prerequisites

- Node.js 24 (`.nvmrc` pins major 24; `engines` requires `>=24 <25`).
- npm (the repository pins `packageManager` and commits `package-lock.json`).

```bash
nvm use
```

## Setup

```bash
cp .env.example .env
cp config/models.example.yaml config/models.yaml
npm ci
```

Both `.env` and `config/models.yaml` are git-ignored. All example credentials
are unmistakably fake placeholders — replace them with your own and never commit
real secrets. The model IDs and source names in the example
(`collectiviq-consensus`, `collectiviq-coder`, `collectiviq-fast`, and the
`selectedLlms` entries) are configurable examples only; they are not verified
against any CollectivIQ account and carry no context-window or token-limit
claims.

## Local development

```bash
npm run dev      # watch mode via tsx (loads .env if present)
npm run build    # compile TypeScript into dist/
npm start        # run dist/index.js with externally supplied environment
```

The service binds to `127.0.0.1:8787` by default (loopback only).

```bash
curl http://127.0.0.1:8787/healthz   # {"status":"ok"}
curl http://127.0.0.1:8787/readyz    # {"status":"ready"} once listening
```

## Validation

```bash
npm run validate        # format check, lint, typecheck, tests, build, build smoke
```

Individual checks:

| Command                    | Purpose                                       |
| -------------------------- | --------------------------------------------- |
| `npm run format:check`     | Prettier formatting check                     |
| `npm run lint`             | ESLint (typed rules)                          |
| `npm run typecheck`        | Strict `tsc --noEmit` over sources and tests  |
| `npm test`                 | Vitest unit + integration + contract suites   |
| `npm run test:unit`        | Unit tests only                               |
| `npm run test:integration` | Server integration tests only                 |
| `npm run test:contract`    | Hermetic upstream contract tests (mock HTTP)  |
| `npm run test:coverage`    | Tests with V8 coverage                        |
| `npm run build`            | Compile to `dist/`                            |
| `npm run test:build`       | Import compiled output; assert no open socket |

`validate` is hermetic: it makes no network, live-upstream, Docker, or load
checks. The contract suite runs against a local mock HTTP server.

## CollectivIQ contract tooling

The upstream contract is grounded in the published OpenAPI document and captured
as a deterministic, filtered snapshot at
[`contract/collectiviq/openapi-filtered.json`](contract/collectiviq/openapi-filtered.json)
(nine allowlisted operations only; the full 422-path document is never
committed). See
[`.agent/docs/collectiviq-upstream-contract.md`](.agent/docs/collectiviq-upstream-contract.md).

These commands need network access and are **excluded from `validate` and CI**:

| Command                              | Purpose                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `npm run contract:openapi:check`     | Fetch the public OpenAPI doc and report drift vs the committed snapshot                                            |
| `npm run contract:openapi:refresh`   | Fetch and write a review candidate under `.agent/sessions/` (untracked)                                            |
| `npm run contract:discovery`         | Opt-in live discovery (requires credentials + explicit approval)                                                   |
| `npm run contract:discovery:cleanup` | Recovery-only: delete leaked session threads listed in the recovery journal (requires credentials + all approvals) |

One authorized `contract:discovery` baseline was run on 2026-08-06; it **failed
strict completeness (exited non-zero)**, its evidence is observed-once and
sanitized (not verified), and no live capture was promoted, so Phase 0 is not
complete. It runs a single
bounded `baseline` session against a **fixed** destination origin
(`https://api.prod.collectiviq.ai`) — no origin, path, thread-id, or run-id may
be supplied. The **default invocation is preflight only**: it validates the
model selection (`CIQ_DISCOVERY_SINGLE_LLM`, `CIQ_DISCOVERY_COMBINED_LLMS`) and
reports bounded projected operation counts and which approvals are set, **without
reading the credential or making any network request**. Authenticated execution
requires `--execute-approved` **and** `--recovery-journal-approved`; deleting
session-owned threads requires `--cleanup-approved` (never automatic); the
not-found probe requires `--observe-not-found-approved` **and**
`--cleanup-approved` (these invariants are also re-checked inside the runner
before any request). `--recovery-journal-approved` enables a private, content-free
recovery journal under the ignored `.agent/sessions/discovery/` that records at
most two created thread ids (format version + fixed origin + ids only — no
credentials, run ids, content, or timestamps) so a leaked thread can be recovered;
each id is recorded immediately and dropped after a confirmed deletion. If a run
leaves threads behind, `npm run contract:discovery:cleanup` (network-only, opt-in,
excluded from `validate`/CI; requires `--execute-approved`, `--cleanup-approved`,
and `--recovery-journal-approved`) deletes only the ids in that journal.
Token-inspection and abort discovery are disabled until request correlation is
safely established. Evidence
is captured from the **raw** upstream body for any status (so run ids and error
shapes survive) and immediately reduced to sanitized structure; correlation ids
stay private and are reported only as a value-free
`matched`/`not-matched`/`not-observed` comparison. Cleanup reports a truthful
`attempted`/`succeeded`/`failed`/`remaining` ledger (HTTP DELETE outcomes only)
plus `journalPersistenceFailed` and a bounded list of value-free per-attempt
summaries (phase, `ok`, HTTP status or null, safe error code or null, and
`journalPersisted` — `true`/`false`/`null` — no ids, paths, or bodies) so a
cleanup `403` is distinguishable from a timeout/network failure. A thread is
dropped from the in-memory ledger on a confirmed HTTP DELETE even when its
journal removal fails (the stale journal converges through recovery's exact-`404`
handling); any such `journalPersistenceFailed > 0` is a non-zero-exit condition.
The exit code follows strict session completeness. Strict completeness also requires an `available_llms` observation
and accepts either a **structurally valid** `2xx` success (top level a non-null,
non-array object with an own `llms` object holding at least one object entry;
extra properties allowed and no model value inspected) or exactly a `403` (an
observed inventory-access restriction) for that endpoint; a malformed `2xx` body
is a **failed** observation (`invalid_upstream_response`) that drives a non-zero
exit. If a thread is created upstream but its id cannot be durably persisted to
the recovery journal, the run **aborts immediately** — no further upstream
request — attempts cleanup for the already-owned thread, and exits non-zero with a
content-free `aborted: "journal-persistence-failed"` result. The recovery-only
`contract:discovery:cleanup` command resolves a journal-owned id on a `2xx`
(`deleted`) **or** an exact `404` (`already_absent`) so recovery converges after a
crash between a successful delete and the journal update, and reports
`{ attempted, resolved, unresolved, remaining, attempts }` (exit non-zero when
`unresolved > 0 || remaining > 0`). Output is limited to sanitized structural
captures (constant type markers only — no credentials, content, value lengths,
identifiers, headers, or raw bodies) stamped with an `evidenceFormatVersion`;
`--write` governs only whether a sanitized baseline evidence report is persisted
under `.agent/sessions/`. Run identifiers stay in memory and are never printed or
persisted; thread identifiers stay in memory except that, when
`--recovery-journal-approved` is set, at most two are written content-free to the
recovery journal (independently of `--write`, durable-first) purely for recovery
and removed after confirmed deletion.

## Docker

The image is multi-stage, pinned to a Node 24 bookworm-slim digest, and runs as
the non-root `node` user. It contains no secrets.

```bash
docker build -t collectiviq-gateway:local .
```

With Compose (publishes only to host loopback):

```bash
cp config/models.example.yaml config/models.yaml
export COLLECTIVIQ_API_KEY=sk-fake-upstream-key-change-me
export COLLECTIVIQ_GATEWAY_KEYS=gw-fake-key-change-me
docker compose up --build
```

The container binds `HOST=0.0.0.0` internally, but Compose publishes the port
only on `127.0.0.1:8787`. Credentials are supplied via environment
interpolation; none are stored in `compose.yaml`.

## Configuration reference

| Variable                   | Required | Default                           | Notes                                                  |
| -------------------------- | -------- | --------------------------------- | ------------------------------------------------------ |
| `ENVIRONMENT`              | no       | `production`                      | `development` \| `staging` \| `production`             |
| `HOST`                     | no       | `127.0.0.1`                       | Loopback by default                                    |
| `PORT`                     | no       | `8787`                            | 1–65535                                                |
| `COLLECTIVIQ_BASE_URL`     | no       | `https://api.prod.collectiviq.ai` | Must be an absolute http(s) URL                        |
| `COLLECTIVIQ_API_KEY`      | **yes**  | —                                 | Upstream credential; keep separate from gateway keys   |
| `COLLECTIVIQ_GATEWAY_KEYS` | **yes**  | —                                 | Comma-separated client keys; trimmed and de-duplicated |
| `MODEL_CONFIG_PATH`        | no       | `./config/models.yaml`            | Path to the YAML model file                            |
| `LOG_LEVEL`                | no       | `info`                            | Pino level                                             |
| `LOG_CONTENT`              | no       | `false`                           | May be `true` only when `ENVIRONMENT=development`      |
| `MAX_REQUEST_BODY_BYTES`   | no       | `8388608`                         | 1024 – 67108864                                        |

`COLLECTIVIQ_API_KEY` authenticates the gateway to CollectivIQ.
`COLLECTIVIQ_GATEWAY_KEYS` are **intended to authenticate clients (OpenCode) to
the gateway once gateway authentication is implemented**. Gateway authentication
is not implemented in this foundation: the keys are validated and held, but no
endpoint enforces them yet. The upstream and gateway credentials are never
conflated or forwarded, and both are redacted from logs. Even in development,
this scaffold does not log request or model content; enabling `LOG_CONTENT=true`
(development only) emits a single fixed warning line and nothing else.

## Model configuration limits

The model file is bounded by fixed, non-overridable foundation limits. Relaxing
any of them is a configuration-contract/security change, not a runtime override.

| Limit                         |                   Value |
| ----------------------------- | ----------------------: |
| Model file size               | 1,048,576 bytes (1 MiB) |
| Virtual models                |                    1–64 |
| Selected sources per model    |                    1–32 |
| Model id length               |             1–128 chars |
| Display-name length           |             1–256 chars |
| Source / answer-source length |             1–128 chars |
| Request timeout               |        1,000–600,000 ms |
| Poll interval                 |           100–60,000 ms |
| Maximum poll interval         |           100–60,000 ms |
| Maximum prompt bytes          |        1,024–67,108,864 |

Additional rules: the path must be a regular file; YAML aliases and duplicate
keys are rejected; the model map must be non-empty; model ids, display names, and
source names must be non-empty and free of leading/trailing whitespace
(case-sensitive); and `pollIntervalMs ≤ maxPollIntervalMs ≤ requestTimeoutMs`.
Invalid configuration is reported as stable, value-free field/reason pairs that
never include model ids, unknown field names, submitted values, file contents,
or filesystem paths.

## Diagnostics and logging

- **Startup failures** print either a sanitized configuration issue list (field
  names and fixed reasons only) or the single fixed line
  `gateway failed to start (internal error)`. Arbitrary exception messages,
  stacks, causes, and paths are never emitted.
- **Log sanitization**: the logger recursively sanitizes every record — nested
  fields, arrays, and child-logger bindings — with bounded depth, width, and
  string length, redacts credential-shaped keys, and reduces error objects to a
  fixed name/code. This is defense in depth; request and model content are never
  logged in the first place.
- **Content warning**: when `LOG_CONTENT=true` (development only), a single fixed
  warning line is written to stderr regardless of `LOG_LEVEL` — including
  `silent`.

## Security

See [SECURITY.md](SECURITY.md). Health and readiness responses are fixed,
bounded JSON and make no live CollectivIQ call.
