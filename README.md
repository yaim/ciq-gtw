# CollectivIQ OpenAI-Compatible Gateway

A local or privately hosted HTTP service that will sit between OpenCode and
CollectivIQ, exposing a bounded OpenAI Chat Completions-compatible profile.

> **Status: runnable foundation, the Phase 1A public model surface, and the
> Phase 1B non-streamed chat-completions path — implemented offline.**
> This repository provides a secure, validated service skeleton, an
> OpenAPI-grounded CollectivIQ adapter with hermetic contract tests, the
> authenticated public model endpoints (`GET /v1/models`,
> `GET /v1/models/:model`), and an authenticated, non-streamed, text-only
> `POST /v1/chat/completions` wired through the adapter (one new CollectivIQ
> thread per request). The completion path calls CollectivIQ **only when a real
> request is served** — never during import, construction, or the build smoke
> test — and the live OpenCode/CollectivIQ smoke test is **not run** (pending
> separate approval). It does **not** implement streaming (`stream:true`), tool
> calling, Redis/idempotency, or metrics/tracing; those remain planned per
> [`.agent/docs/tech-software-spec.md`](.agent/docs/tech-software-spec.md). This
> is the bounded OpenCode Chat Completions profile, not full OpenAI API
> compatibility or production readiness. The grounded upstream contract is
> documented in
> [`.agent/docs/collectiviq-upstream-contract.md`](.agent/docs/collectiviq-upstream-contract.md).

## What works today

- Strict configuration loading and validation (environment + YAML model file).
- A Fastify server that can be constructed in-process without binding a socket.
- Liveness (`GET /healthz`) and readiness (`GET /readyz`) endpoints. Neither
  calls CollectivIQ or any dependency.
- Authenticated public model endpoints: `GET /v1/models` and
  `GET /v1/models/:model`. Every `/v1/*` route requires
  `Authorization: Bearer <gateway-key>` (case-insensitive scheme, exact-match
  token, fixed-length SHA-256 + `timingSafeEqual` comparison); `/healthz` and
  `/readyz` stay unauthenticated. Model objects expose only `id`, `object`,
  `created`, and `owned_by`, are listed in configuration order, and resolve
  case-sensitively. Missing/invalid credentials return a fixed OpenAI `401`;
  unknown/case-mismatched ids return a fixed OpenAI `404`; unexpected `/v1`
  failures return a fixed OpenAI `500`. These model metadata routes themselves do
  not call CollectivIQ.
- Credential-redacting Pino logging with content logging off by default.
- Graceful `SIGINT`/`SIGTERM` shutdown.
- Docker packaging and GitHub Actions CI.
- An OpenAPI-grounded CollectivIQ **adapter boundary** (`src/collectiviq/`) for
  the three core operations, with a bounded/cancellation-aware transport, a
  normalized content-free error model (with method-aware retry metadata),
  provisional response validation, an opt-in staged discovery session/CLI
  (preflight by default), a committed filtered OpenAPI snapshot
  (`contract/collectiviq/`), and hermetic mock-server contract tests
  (`test/contract/`).
- **Authenticated, non-streamed, text-only `POST /v1/chat/completions`**
  (Phase 1B), wired through the adapter. It validates/normalizes the OpenAI
  request (text roles and string/text-part content; `n` must be `1`), rejects
  `stream:true`, tools, `tool_choice`, `response_format`, `logprobs`, audio, and
  image/binary content with stable content-free `400`s, serializes a
  deterministic versioned prompt, enforces process-local global + per-key
  capacity with a bounded queue (`429` + `Retry-After: 5` when at capacity),
  creates one new CollectivIQ thread, submits once (no `create_thread`/
  `process_message` retries), polls `get_messages` under a total deadline with
  GET-only retry and desired-source selection, and encodes a non-streamed
  response with zero (unavailable) usage. Client disconnect, the total deadline
  (`504`), and shutdown share one cancellation path. **The live smoke test is not
  run** — see the status note above.

## What is not implemented yet

`GET /metrics`, emulated/native tool calling, synthetic SSE streaming
(`stream:true`), Redis/idempotency, and any live OpenCode/CollectivIQ smoke run.
(Gateway authentication, the model endpoints, and the non-streamed
`POST /v1/chat/completions` path are implemented — see "What works today".) Four authorized authenticated discovery baselines ran: two bearer-mode
runs (2026-08-06/07) **failed strict completeness (exited non-zero)**, and two
`password`-mode runs (2026-08-11) **both passed (exited zero)** with identical
sanitized safe facts. The core create/submit/messages contract and password
`POST /login` are therefore **verified-repeatable** (encoded into synthetic
fixtures; no live value promoted), while masked field names and all field
semantics stay provisional. Thread-deletion outcomes were observed to be
credential/principal-dependent (cause not established). Phase 0 has advanced
substantially but is **not complete** — several provider questions remain open
(see below).

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

The `/v1/*` endpoints require a gateway key from `COLLECTIVIQ_GATEWAY_KEYS`
(replace the fake placeholder below with one of your configured keys):

```bash
# List configured virtual models
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer gw-fake-key-change-me"

# Retrieve one model by id
curl http://127.0.0.1:8787/v1/models/collectiviq-consensus \
  -H "Authorization: Bearer gw-fake-key-change-me"

# Missing/invalid credentials return a fixed OpenAI 401 envelope
curl -i http://127.0.0.1:8787/v1/models
```

### Chat completions (non-streamed, text only)

`POST /v1/chat/completions` accepts the bounded OpenCode Chat Completions
profile: text-only `system`/`developer`/`user`/`assistant` messages with string
or `{ "type": "text", "text": … }` content, `n` absent or `1`, and `stream`
absent or exactly `false`. Each request creates one new CollectivIQ thread, so a
live request needs a real `COLLECTIVIQ_*` upstream credential.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer gw-fake-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "collectiviq-consensus",
    "messages": [{ "role": "user", "content": "Explain this function." }]
  }'
```

The request surface is strict: `stream` (any value other than `false`), and the
mere **own-property presence** of `tools`, `tool_choice`, `response_format`,
`logprobs`, `audio`, message `tool_calls`, or a tool-role message — even when
empty, `null`, an explicit `undefined`, `"auto"`, `"none"`, or otherwise harmless
— is rejected with a stable `400`, as is any image/binary content. (Presence is
decided without reading the field's value, so a value getter is never invoked and
an inherited property never counts.) Accepted-but-ignored optional fields (`temperature`,
`top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `user`, `store`,
`parallel_tool_calls`) are surfaced by NAME only in an optional
`X-CollectivIQ-Ignored-Parameters` response header; their values are never read
or logged. Responses report `usage` zeros, which denote **unavailable** token
counts — not estimates and not exact billing usage.

For OpenCode, point `@ai-sdk/openai-compatible` at `http://127.0.0.1:8787/v1`
with a gateway key as `apiKey` (see specification section 25 for a full example).
The end-to-end OpenCode smoke test is **not run** in this repository and requires
separate approval before any live CollectivIQ traffic.

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
(ten allowlisted operations only, including `POST /login` for the OAuth2 password
mode; the full 422-path document is never committed). See
[`.agent/docs/collectiviq-upstream-contract.md`](.agent/docs/collectiviq-upstream-contract.md).

These commands need network access and are **excluded from `validate` and CI**:

| Command                              | Purpose                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `npm run contract:openapi:check`     | Fetch the public OpenAPI doc and report drift vs the committed snapshot                                            |
| `npm run contract:openapi:refresh`   | Fetch and write a review candidate under `.agent/sessions/` (untracked)                                            |
| `npm run contract:discovery`         | Opt-in live discovery (requires credentials + explicit approval)                                                   |
| `npm run contract:discovery:cleanup` | Recovery-only: delete leaked session threads listed in the recovery journal (requires credentials + all approvals) |

Four authorized `contract:discovery` baselines were run: two on 2026-08-06 and
2026-08-07 in **bearer** mode (both failed strict completeness), and two on
**2026-08-11 in `password` mode that BOTH passed strict completeness (exited
zero)** with **identical** sanitized results. The core create/submit/messages
contract and password `POST /login` are therefore **verified-repeatable** and
encoded into synthetic fixtures (no live value committed). Thread-deletion
outcomes were **credential/principal-dependent** (cause not established): the
password/member principal deleted its own newly created thread (`200`, repeated)
while re-deleting that same just-deleted id returned `403`; the API-key
principal's own-thread delete returned `403` (2026-08-07); a cross-principal
recovery attempt also returned `403` — consistent with a permission/scope check,
but the provider's evaluation order is unconfirmed, so recovery's exact-`404`
convergence was not exercised. Phase 0 has advanced substantially but is not
auto-declared complete — open provider questions remain (idempotency,
ordering/pagination, prompt/rate limits, retention, native tools, SSE scope,
token lifetime). It runs a single
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
# bearer mode (default):
export COLLECTIVIQ_API_KEY=sk-fake-upstream-key-change-me
# or password mode instead:
#   export COLLECTIVIQ_AUTH_MODE=password
#   export COLLECTIVIQ_USERNAME=fake-user@example.com
#   export COLLECTIVIQ_PASSWORD=fake-password-change-me
export COLLECTIVIQ_GATEWAY_KEYS=gw-fake-key-change-me
docker compose up --build
```

The container binds `HOST=0.0.0.0` internally, but Compose publishes the port
only on `127.0.0.1:8787`. Credentials are supplied via environment
interpolation; none are stored in `compose.yaml`. Compose forwards
`COLLECTIVIQ_AUTH_MODE` and both credential sets softly and no longer
hard-requires `COLLECTIVIQ_API_KEY` — `password` mode runs without it — while the
gateway validates the mode-appropriate credential at startup. Only
`COLLECTIVIQ_GATEWAY_KEYS` keeps a fail-fast guard.

## Configuration reference

| Variable                          | Required | Default                           | Notes                                                                                                     |
| --------------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`                     | no       | `production`                      | `development` \| `staging` \| `production`                                                                |
| `HOST`                            | no       | `127.0.0.1`                       | Loopback by default                                                                                       |
| `PORT`                            | no       | `8787`                            | 1–65535                                                                                                   |
| `COLLECTIVIQ_BASE_URL`            | no       | `https://api.prod.collectiviq.ai` | Must be an absolute http(s) URL                                                                           |
| `COLLECTIVIQ_AUTH_MODE`           | no       | `bearer`                          | `bearer` \| `password`; selects the upstream credential                                                   |
| `COLLECTIVIQ_API_KEY`             | bearer   | —                                 | Bearer-mode upstream token (≤16 KiB, preserved exactly); required when `COLLECTIVIQ_AUTH_MODE=bearer`     |
| `COLLECTIVIQ_USERNAME`            | password | —                                 | Password-mode username (trimmed, ≤320 bytes); required when `COLLECTIVIQ_AUTH_MODE=password`              |
| `COLLECTIVIQ_PASSWORD`            | password | —                                 | Password-mode password (preserved exactly, ≤4096 bytes); required when `COLLECTIVIQ_AUTH_MODE=password`   |
| `COLLECTIVIQ_GATEWAY_KEYS`        | **yes**  | —                                 | Comma-separated client keys; trimmed, de-duplicated, ≤64 keys, ≤8192 UTF-8 bytes/key; enforced on `/v1/*` |
| `MODEL_CONFIG_PATH`               | no       | `./config/models.yaml`            | Path to the YAML model file                                                                               |
| `LOG_LEVEL`                       | no       | `info`                            | Pino level                                                                                                |
| `LOG_CONTENT`                     | no       | `false`                           | May be `true` only when `ENVIRONMENT=development`                                                         |
| `MAX_REQUEST_BODY_BYTES`          | no       | `8388608`                         | 1024 – 67108864                                                                                           |
| `MAX_CONCURRENT_REQUESTS`         | no       | `4`                               | Global active completions (process-local); 1–1024                                                         |
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | no       | `2`                               | Per-gateway-key active completions; 1–1024 and ≤ `MAX_CONCURRENT_REQUESTS`                                |
| `MAX_QUEUED_REQUESTS`             | no       | `20`                              | Bounded admission queue length; 0–100000 (0 disables queueing)                                            |
| `MAX_QUEUE_WAIT_MS`               | no       | `5000`                            | Max time in the admission queue before a `429`; 1–600000                                                  |
| `SHUTDOWN_DRAIN_MS`               | no       | `30000`                           | Graceful-shutdown drain before in-flight polling is cancelled; 0–600000                                   |

The upstream credential authenticates the gateway to CollectivIQ: in `bearer`
mode `COLLECTIVIQ_API_KEY` is sent as a static bearer token; in `password` mode
`COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` are exchanged at `POST /login` for a
short-lived bearer token held in memory (login **verified-live** on 2026-08-11;
token lifetime/refresh still unverified). The inactive mode's credentials may be
set but are ignored.
`COLLECTIVIQ_GATEWAY_KEYS` authenticate clients (OpenCode) to the gateway.
Gateway authentication is **implemented and mandatory** on every `/v1/*` route
(`/healthz` and `/readyz` stay open): a client presents
`Authorization: Bearer <gateway-key>`, the scheme is matched case-insensitively,
and the token is compared **exactly** against the configured keys with a
fixed-length SHA-256 + `timingSafeEqual` comparison. There is no
authentication-disable switch. The upstream and gateway credentials are never
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
