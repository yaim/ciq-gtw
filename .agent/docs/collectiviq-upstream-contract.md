# CollectivIQ Upstream Contract

Owner document for the CollectivIQ upstream contract as the gateway currently
understands it. It distinguishes what the published OpenAPI document declares
from what remains provisional or unverified. It is the reference for the adapter
under `src/collectiviq/`, the filtered snapshot under `contract/collectiviq/`,
and the hermetic contract tests under `test/contract/`.

This document must be updated in the same change as any adapter behavior,
snapshot refresh, or newly captured live evidence.

## Evidence states

Every claim below is tagged with one of:

- **documented** — declared by the published OpenAPI document (`3.1.0`).
- **provisional** — the gateway's own working assumption, NOT guaranteed by the
  OpenAPI document (whose success schemas are empty) and NOT yet observed live.
- **observed** — seen in a sanitized capture from an authorized live probe.
- **verified** — observed repeatably and encoded into deterministic fixtures.

Four authorized authenticated baseline discovery runs have been executed: two on
2026-08-06 and 2026-08-07 in **bearer** mode (both exited non-zero; see those
sections below), and two on **2026-08-11 in `password` mode** (see "2026-08-11
authorized password baseline" below). **Both 2026-08-11 runs exited zero** (each
passed strict completeness) and their sanitized structural captures
(`evidenceFormatVersion` 2) are **identical across every safe contract fact**
(statuses, ok flags, error codes, per-stage structure shapes, correlation,
cleanup counts, not-found, and the auth observation). Facts that repeated
identically across those two independently-approved runs **and** are encoded into
a deterministic synthetic fixture are now tagged **verified**; the affected fixtures
carry SYNTHETIC values only (no live value was ever copied). The earlier bearer
runs remain **observed-once** corroboration.

Every runtime response shape that was not exercised by these runs remains
**provisional**, and a mapping stays provisional where the observed field NAME was
masked by structural capture (e.g. message `content`, whose real field name never
appeared in the sanitized evidence). Phase 0 has **advanced substantially** — the
core create/submit/messages contract and password login are now
verified-repeatable, and thread-deletion and inventory-access outcomes were
observed to be credential/principal-dependent (cause not established).

**Phase 1B now consumes this contract (implemented, offline).** The production
adapter is wired into `POST /v1/chat/completions` via
`src/generation/runtime.ts`/`chat-completion.ts`: each completion creates one
**new** thread, submits once (never retrying `create_thread`/`process_message`),
and polls `get_messages` under the model's total deadline with GET-only retry and
the timestamp → sortable-id → array-position selection above. Normalized
`UpstreamError`s map to public OpenAI envelopes by closed category only (spec
section 20). The earlier user-observed, sanitized **2026-08-15** foreground
transport smoke used the protocol-mode `collectiviq-claude` request: it returned a
response and synthetic streaming completed, but the returned model response
**objected to the gateway's serialized protocol wrapper as embedded
identity/instruction manipulation**, so a clean end-to-end valid answer was **not**
established for that path. The offline `collectiviq-claude-direct`
prompt-serialization profile (specification section 8.4; latest-user-only prompt,
no protocol wrapper) is the mitigation for that refusal, and a sanitized,
user-authorized **2026-08-18** smoke **observed it succeed for the tested
account**: direct mode submitted only the latest user text, a natural TypeScript
coding request returned a relevant answer, the foreground OpenCode interaction
produced no protocol objection / tool alert / tool call, and the hidden
`collectiviq-fast` title request returned a valid title on its first attempt (see
the "2026-08-18 authorized observation" section below). This meets the Phase 1
semantic / OpenCode smoke criterion **for the tested account**, but is an observed
single-account result — **not** production readiness or a repeatable upstream
guarantee, and it does not establish combined answers, long-duration streaming, or
generic non-Claude routing. No live CollectivIQ request is made from this
repository except when a real completion is served. Because each completion sends
the prompt into a new CollectivIQ-managed thread, provider-side
retention/training/deletion/regional behavior remains a
**production/provider-confirmation gate**, unchanged by this phase; the gateway
itself retains no prompt/answer content after the request.

**Phase 0 text-readiness gate — satisfied.** The verified-repeatable
login/create/submit/messages contract is sufficient to **enter Phase 1
conservative text development** (spec section 32). This is a scoped entry gate,
not a claim that every upstream question is resolved or that the gateway is
production-ready, and it asserts **no new live evidence**. The remaining open
questions are non-blocking under the Phase 1 safeguards: `create_thread` and
`process_message` are never auto-retried; each completion uses a fresh thread; no
message ordering is assumed (duplicate desired-source messages fall back to
timestamp → sortable-id → array-position); pagination is unneeded with a fresh
thread and full-history read; prompt limits are a conservative gateway bound, not
a verified upstream maximum; and password-token `401` invalidation plus
next-request re-login cover the absence of a refresh endpoint. Phase 0 is
therefore **not** auto-declared fully complete: idempotency and `status`
semantics, message ordering/pagination, prompt/rate limits, retention, native
tools, SSE scope, and token lifetime/refresh remain open later-phase gates (see
the gap matrix in spec section 35).

## Source metadata

| Field | Value |
| --- | --- |
| Source URL | `https://api.prod.collectiviq.ai/openapi.json` |
| OpenAPI version | `3.1.0` |
| API title | `CollectivIQ API` |
| API version | `0.1.0` |
| Retrieved (UTC) | `2026-08-05` |
| Full document SHA-256 | `c66332fd7fddd5bc085f984e8a9e34865b1ff7cd2e833942c207c52853fe8e63` |
| Full document path count | `422` |
| Committed filtered snapshot | [`contract/collectiviq/openapi-filtered.json`](../../contract/collectiviq/openapi-filtered.json) |

The full 422-path document is intentionally **not** committed. Only the ten
allowlisted operations, their transitively referenced schemas, and source
metadata are retained. Refresh with `npm run contract:openapi:refresh` (writes a
review candidate under `.agent/sessions/`) and compare the live document with
`npm run contract:openapi:check`. Both require network access and are excluded
from `validate` and CI.

## Authentication (documented; password login verified-live, extra fields provisional)

- Security scheme `OAuth2PasswordBearer` (`type: oauth2`); its password flow's
  `tokenUrl` is `/login`, which is **used by the optional password mode**
  described below (login **verified-live**; response fields beyond the validated
  minimal shape and token lifetime/refresh remain provisional). All core and
  supporting operations except `/user/events` declare the scheme.
- The gateway attaches a **lease bearer token** — `Authorization: Bearer
  <token>` — on every request, via a shared credential-provider boundary
  (`src/collectiviq/auth.ts`) used by the production adapter, discovery, the SSE
  path, deletion, and recovery tooling. `COLLECTIVIQ_AUTH_MODE` (`bearer` |
  `password`, default `bearer`) selects the token source; the inactive mode's
  credentials may be present but are ignored. Either token is never logged and
  never appears in errors.
  - **`bearer` (default):** the static `COLLECTIVIQ_API_KEY` is the bearer token.
  - **`password`:** `COLLECTIVIQ_USERNAME` + `COLLECTIVIQ_PASSWORD` are exchanged
    at `POST /login` for a short-lived bearer token, held **in memory only** and
    then attached like any other bearer. The login exchange is **verified-live**:
    the two 2026-08-11 authorized password baselines each performed exactly one
    `POST /login` returning HTTP `200` whose body normalized to a `Bearer`
    `access_token` (auth observation `{ mode: password, loginAttempts: 1, status:
    200, normalized: true }`), and a standalone create+delete probe confirmed the
    minted bearer authorizes core operations. Response fields **beyond** the
    validated `access_token`/`token_type` were never captured (masked), and token
    **lifetime/refresh** behaviour remains unverified.
- **Lease behaviour (both the JSON transport and the SSE path share it).** Each
  request acquires a lease and attaches its bearer token. An HTTP `401`
  **invalidates that lease** — the request is **not** replayed — so the next
  *distinct* request may reauthenticate; an HTTP `403` does **not** invalidate the
  lease. There is no automatic replay of create/submit/delete or any request, and
  no auto-retry inside a login.
- `GET /user/events` declares **no** OAuth2 requirement but documents an optional
  `Authorization` header parameter; it uses header-based bearer auth, not query
  authentication.

### Login contract (verified-live; extra fields provisional)

The password mode's login exchange is the gateway's own working contract; the
published document's `200` response schema for `/login` is empty. The gateway's
minimal validator (a `Bearer` `access_token`) is now **verified-live** by the two
2026-08-11 password baselines, but any response field beyond that is masked and
unverified, as is token lifetime/refresh.

- **Request** (documented `application/x-www-form-urlencoded`): `grant_type=password`,
  `username`, `password`, and `scope=` (empty). `client_id`/`client_secret` are
  omitted, and no `Authorization` header is sent (login is unauthenticated).
- **Bounds:** a bounded unauthenticated call — 20 s header + 20 s body timeouts,
  a 64 KiB response cap, strict UTF-8, JSON content type, exactly HTTP `200`
  required, `redirect: "error"`. The provider keeps an in-memory token cache,
  coalesces concurrent acquisitions into a single login (single-flight), applies
  generation-safe invalidation (a late `401` from an older token cannot clear a
  newer one), and enforces a hard **two-login budget per process** for
  discovery/recovery (exceeding it fails closed with the normalized authentication
  error).
- **Response validator (minimal shape verified-live; extra fields provisional):**
  requires a non-array object with an own `access_token` (non-empty string,
  ≤ 16 KiB) and an own `token_type` equal to `Bearer` (case-insensitive). This
  minimal `Bearer access_token`/`token_type` shape is **verified-live** by the two
  2026-08-11 password baselines; any field beyond it (including any refresh token)
  is masked/unverified, ignored, and never retained, as is token lifetime/refresh.
- **No refresh or logout.** `/auth/refresh` exists in the published document but
  both its request and response schemas are empty; it is **not** implemented.
  There is no refresh, logout, cookie, browser-localStorage, SSO, or
  browser-session handling.
- **Credential bounds (config + CLI, value-free errors):** username is trimmed,
  canonical non-empty, ≤ 320 UTF-8 bytes; password is non-empty, ≤ 4096 UTF-8
  bytes, preserved exactly including whitespace; a bearer token is non-empty,
  ≤ 16 KiB, preserved exactly.
- **Residual risk:** the username/password remain resident in process
  environment/config memory so a later login can run, and a JavaScript string's
  bytes cannot be deterministically erased.
- Normal gateway startup remains **network-free**: no login occurs during module
  import, configuration loading, server construction, or startup while no
  completion route consumes the adapter.

## Core operations

### `POST /create_thread` (documented request; verified-repeatable success shape)

- Content type **`application/x-www-form-urlencoded`** (documented). This
  corrects earlier text that described it as multipart.
- Fields: `thread_title` (required, string); `is_title_from_user` (default
  `false`); `project_id` (`integer | null`, optional).
- The gateway sends the fixed placeholder `thread_title=New Thread` and
  `is_title_from_user=false`, and omits `project_id`. The placeholder is
  content-free and never derived from prompts, repositories, filenames, or
  personal data. It is deliberately the exact temporary title `New Thread` (see
  the 2026-08-18 observation below): in a sanitized 2026-08-18 probe this was the
  minimal gateway-compatible trigger that caused CollectivIQ to natively generate
  a server-side, prompt-related thread title after `process_message`. The
  URL-encoded request is otherwise unchanged (`is_title_from_user=false`, current
  `process_message` fields including `llms_explicitly_set=true`); still exactly
  one thread per completion, capacity acquired before create, and no
  `create_thread`/`process_message` retry. The gateway never derives, logs,
  caches, or retains the provider-generated title. It reads that title only
  **transiently** via the observed-only `get_threads` lookup (below) to serve the
  OpenCode session-title extension (`GET /v1/opencode/session-title`, spec
  section 9.5); native-title propagation adds only bounded GET requests and no
  additional thread.
- Success shape: a top-level object with a `thread_id` that is a positive integer
  or a non-empty string, normalized to a string. Declared `200` schema is empty
  (`{}`). **Verified-repeatable:** across the 2026-08-06/07 bearer runs and both
  2026-08-11 password runs, every create returned HTTP `200` with a top-level
  **numeric** `thread_id`, which the production normalizer accepted.
  Structure-only; no value was captured.

### `POST /process_message` (documented request; verified-repeatable success shape)

- Content type **`multipart/form-data`** (documented).
- Fields sent by the gateway: `prompt`, `thread_id` (documented type: string),
  `selected_llms` (comma-separated), `generate_combined` (`"true"`/`"false"`,
  documented type: string, default `"true"`), and `llms_explicitly_set="true"`.
- `llms_explicitly_set` is `string | null`, default `"false"`; the gateway sets
  it to `"true"` because its configuration explicitly selects the models. **Its
  runtime effect is provisional** until live discovery confirms it.
- **Account-specific source-routing limitation (value-free observation).** For
  the CollectivIQ account used during discovery, generic gateway prompts were
  classified account-side as Atlassian queries, and non-Claude sources were
  skipped as unsupported for that query category. `selected_llms`,
  `generate_combined`, and `llms_explicitly_set="true"` did **not** provide a
  verified routing override for that classification, and the filtered OpenAPI
  snapshot exposes **no** documented generic/non-Atlassian routing field. So for
  this account only `claude` is currently observed to answer, and the gateway
  cannot claim verified GPT/Gemini/Grok execution for it — hence the committed
  OpenCode foreground/top-level/`small_model` default for this account is
  `collectiviq-claude-direct`, a Claude-only source selection whose
  `promptMode: "direct"` drops the protocol wrapper this account objected to;
  `collectiviq-claude` remains available as the protocol-mode Claude alternative.
  Direct mode was observed live on 2026-08-18 to resolve that semantic refusal
  for the tested account: a natural coding/OpenCode foreground request returned a
  relevant answer with no protocol objection, tool alert, or tool call, and
  synthetic streaming completed. This is a sanitized single-account observation,
  not a production-readiness claim or repeatable upstream guarantee; the generic
  non-Claude routing/provider question remains open (see specification sections
  25, 34.7, and 36, and `opencode.jsonc`). This is a value-free, account-specific
  note (no live response text, prompt, Jira identifier, thread id, or model
  answer is recorded) and does **not** generalize to every account; a supported
  generic-routing mechanism remains an open provider question (specification
  section 35, item 27).
- Documented but out-of-scope fields the gateway never sends: `files`,
  `client_timezone`, `client_location`, `clarification_origin_run_id`,
  `suppress_user_bubble`, `response_format`, `tier`.
- **Provisional** success rule: a top-level JSON object; a present `detail`
  field is a failure even on HTTP 2xx. Declared `200` schema is empty.
- **Verified-repeatable:** across the 2026-08-06/07 bearer runs and both
  2026-08-11 password runs, every submission returned HTTP **`202` (Accepted)**
  with a top-level object whose safe field names were `thread_id` (string here),
  `combined_run_id` (string), `status` (string), and `has_rag_files` (boolean),
  with **no** top-level `detail`, so the normalizer accepted it. A run identifier
  (`combined_run_id`) is therefore present. Encoded as the synthetic fixture
  `processAccepted202` (`test/contract/fixtures/collectiviq/responses.ts`) and
  covered by `adapter-process-message.test.ts`. Still **unknown/unresolved:** the
  meaning of the `status` field, whether `202` implies accepted-versus-failed
  work, and idempotency. Structure-only; no value was captured.

### `GET /get_messages` (documented request; verified-repeatable shape; content mapping still provisional)

- Query parameters (documented): `thread_id` (string, declared **optional**) and
  `since_id` (`string | null`, optional).
- The gateway always **requires and sends a non-empty `thread_id`** despite the
  OpenAPI document marking it optional, and **intentionally omits `since_id`** in
  this phase so full thread history is returned.
- Success shape: a top-level object with a `messages` array. Each message is
  normalized to `{ source, content, percentUsage, createdAt, id }`. `source`
  (string) and `percentUsage` (from `percent_usage`) and `id` are
  verified-repeatable safe fields.
- **`createdAt` mapping reconciled (verified-repeatable):** both 2026-08-11
  password runs (corroborating 2026-08-06) show the creation-time field is
  **`create_time`** (with a separate `updated_at`), **not** the earlier
  provisional `created_at`. `src/collectiviq/validation.ts` now maps `createdAt`
  from `create_time` first, keeping `created_at` as a backward-compatible
  fallback (`updated_at` is intentionally not mapped — its selection semantics
  are unverified). Encoded as the synthetic fixture `messagesCreateTime` and
  covered by `adapter-get-messages.test.ts`.
- **`content` mapping stays provisional:** the message content field NAME is
  content-bearing, so structural capture masks it — it never appeared in the
  sanitized evidence, so the `content` mapping is unconfirmed. Observed
  safe-named entry fields included `source`, `id` (number), `combined_run_id`,
  `create_time`/`updated_at` (strings), `thread_id` (number), `percent_usage`
  (null in these runs), plus other booleans/nulls. Structure-only; no value was
  captured.

## Empty / incomplete success schemas

The declared `200` response schema for **every** allowlisted operation is empty
(`{}`). The OpenAPI document therefore establishes **no** runtime response
contract, and all success validation in `src/collectiviq/validation.ts` is the
gateway's own minimal contract. That contract is **mixed-evidence**: safe field
names and statuses that repeated identically across the two 2026-08-11 password
baselines are verified-repeatable (and encoded as synthetic fixtures), while
masked field names (e.g. message `content`) and all field *semantics* remain
provisional. The minimal success **rules** themselves (e.g. "an object without an
own `detail`") are gateway-owned working rules, not provider guarantees, and are
labeled as such in code.

## Supporting operations (documented endpoints; NOT gateway capabilities)

These are documented in the OpenAPI snapshot but are **not** part of the
production `CollectivIQAdapter` and are used by no completion path.

| Operation | Method | Notes |
| --- | --- | --- |
| `/available_llms` | GET | Model metadata. Only a `200` is declared (no `422`). **Access is credential/principal-dependent (cause not established):** both 2026-08-11 password (member) runs returned HTTP **`200`** (repeated) with a structurally valid `llms` object of model-family descriptors (family keys `claude`/`gemini`/`gpt`/`grok`/`llama4`/`nemotron`/`specialty`; per-model values masked), whereas the earlier 2026-08-06/07 API-key runs returned **`403`**. The empty-bearer auth probe returns `401`. No account-specific model value is inspected or retained. |
| `/user/events` | GET | SSE; header-based auth; optional `last_event_id`. **Repeated:** `200` with `text/event-stream`, bounded `event-limit` termination, and thread **and** run correlation both `matched` in both 2026-08-11 password runs (corroborating 2026-08-06). Whether the stream is account-wide vs connection-specific is **unknown**, so the streaming capability stays `false`. |
| `/abort_run` | POST | urlencoded, required `combined_run_id`. **Cooperative**: already-running provider calls may finish, be saved, and be billed while later combination work is skipped. |
| `/thread_tokens` | GET | Required `thread_id` (**integer** here — an inconsistency with the string `thread_id` used elsewhere), plus `limit`/`offset`/`rollup`/`include`. |
| `/thread_tokens/{combined_run_id}` | GET | Path `combined_run_id` (string) + optional `include`. |
| `/delete_thread/{thread_id}` | DELETE | Path `thread_id` (string). **Credential/principal-dependent behavior observed (cause not established).** Value-free outcomes: the password/member principal deleting its own newly created thread → `200` (repeated: both 2026-08-11 runs' cleanup + a standalone probe); re-deleting that same just-deleted id → `403` (repeated); the API-key principal deleting its own newly created thread → `403` (observed in the 2026-08-07 run); a cross-principal recovery attempt → `403` (observed during the approved recovery attempt). This is consistent with a permission/scope check, but the provider's evaluation order is unconfirmed. The recovery command's exact-`404` convergence was **not exercised** by these cases; its handling (see the discovery section) is retained unchanged. |

Documented existence does not make any of these a gateway feature. Thread
deletion, account-wide `/user/events`, cooperative abort, and token reporting
remain out of scope until verified and deliberately adopted. **Token-inspection
(`/thread_tokens*`) and abort (`/abort_run`) discovery are currently disabled**:
they are not reachable from the discovery session or CLI, and remain so until
request-scoped correlation is safely established. Their endpoint constants are
retained only for contract completeness (`src/collectiviq/endpoints.ts`).

## 2026-08-06 authorized baseline

On 2026-08-06 an explicitly user-approved authenticated `baseline` discovery run
was executed once against the fixed origin `https://api.prod.collectiviq.ai`. All
facts below are **observed once and not repeatably verified**; the evidence is a
value-free structural capture (`evidenceFormatVersion` 2 — constant type markers
only, no values or value lengths).

- **Overall result: non-zero exit** — the run failed strict completeness, so
  Phase 0 remains incomplete and **no live capture was promoted** into a committed
  fixture. The contract tests still use synthetic fixtures.
- **Core stages (observed once):** `POST /create_thread` → `200` (numeric
  `thread_id`); `POST /process_message` → `202` (top-level `thread_id`,
  `combined_run_id`, `status`, `has_rag_files`; no `detail`); `GET /get_messages`
  → `200` (`messages` array accepted). See the per-endpoint rows above, including
  the `created_at`-vs-`create_time` discrepancy that keeps message-metadata
  mapping provisional.
- **Probes (expected failures):** empty-bearer `GET /available_llms` → `401` →
  `upstream_authentication_failed`; `GET /get_messages` with no `thread_id` →
  `400` → `upstream_validation_failed`.
- **`GET /available_llms` (authenticated):** `403`, normalized to the
  authentication/authorization category. Observation-only: the same configured
  credential received successful core-operation responses **and** an HTTP `403`
  from the model-inventory endpoint; the reason and scope are **unknown**, and
  **no causal claim** (about authentication, authorization scope, or why the
  `403` occurred) is made.
- **SSE `GET /user/events`:** `200`, `text/event-stream`, bounded `event-limit`
  termination; thread and run correlation both `matched` **once**. Whether the
  stream is account-wide vs connection-specific is **unknown**, and the match is
  not repeatably verified.
- **Cleanup:** all three DELETE attempts failed and two session-owned threads
  remained at process exit. The **old** cleanup report discarded DELETE
  status/error detail, so the failed run's report could not show the delete
  status; therefore **no claim is made that the DELETEs returned `403`** or that
  API thread deletion works. The user has since **manually deleted** both
  remaining threads. The remediation below adds value-free cleanup diagnostics and
  a recovery journal/command so a future run distinguishes a cleanup `403` from a
  timeout/network failure and can recover leaked ids.

## 2026-08-07 authorized baseline

On 2026-08-07 a **second** explicitly user-approved authenticated `baseline`
discovery run reached production against the same fixed origin
(`https://api.prod.collectiviq.ai`), **in addition to** the 2026-08-06 run. Like
the first, all facts are **observed once and not repeatably verified**
(`evidenceFormatVersion` 2). This run is **distinct** from 2026-08-06; the two
are not conflated.

- **Overall result: non-zero exit** — the run again failed strict completeness,
  so Phase 0 remains incomplete and **no live capture was promoted**. The contract
  tests still use synthetic fixtures only.
- **Corroboration, not verification:** the core statuses/shapes (`create_thread`
  `200`, `process_message` `202`, `get_messages` `200`) and the SSE **thread and
  run** correlation repeated consistently with 2026-08-06. Repetition across the
  two runs is corroboration; it does **not** promote any shape to **verified**
  (that still requires an independently approved run under a promoted, sanitized
  fixture).
- **Cleanup diagnostics (now remediated) observed `DELETE` `403`.** Unlike
  2026-08-06 — whose old report discarded delete status and made **no** `403`
  claim, and whose leftover threads were manually deleted — the 2026-08-07 run
  used the value-free cleanup diagnostics and **observed `DELETE` returning HTTP
  `403`**. Two recovery-journal-owned threads were left **unresolved** at process
  exit and are recorded in the recovery journal for the opt-in recovery command;
  their identifiers are never exposed. No causal claim is made about why the `403`
  occurred or whether API thread deletion is supported.
- **Password authentication was implemented offline but remained unverified** for
  this run; the approval-gated recovery/baseline stages had not yet exercised the
  `POST /login` exchange live.

## 2026-08-11 authorized password baseline (two verified-repeatable runs)

On 2026-08-11 two explicitly user-approved authenticated `baseline` runs were
executed in **`password` mode** against the fixed origin
`https://api.prod.collectiviq.ai`. **Both exited zero** (each passed strict
completeness), and their sanitized structural captures
(`evidenceFormatVersion` 2) are **identical across every safe contract fact** — a
programmatic comparison of statuses, ok flags, error codes, per-stage structure
shapes, correlation, cleanup counts, not-found, and the auth observation matched
exactly. Facts below are therefore **verified-repeatable**; no live value was
captured or promoted (fixtures are synthetic).

- **Password login (verified-live):** each run performed exactly one `POST /login`
  → HTTP `200`, body normalized to a `Bearer` `access_token`
  (`auth = { mode: password, loginAttempts: 1, status: 200, normalized: true }`).
- **Core stages:** `create_thread` → `200` (numeric `thread_id`);
  `process_message` → `202` (`thread_id`/`combined_run_id`/`status`/
  `has_rag_files`, no `detail`); `get_messages` → `200` (`messages` array;
  `create_time`/`updated_at` metadata).
- **`available_llms` → `200`** with a valid `llms` object for the password/member
  principal; the API-key principal had returned `403` in the earlier bearer runs
  (credential/principal-dependent, cause not established).
- **Probes:** empty-bearer `available_llms` → `401`; no-`thread_id`
  `get_messages` → `400` (expected failures).
- **SSE `/user/events`:** `200`, `text/event-stream`, `event-limit` termination,
  thread **and** run correlation both **matched** in both runs. The stream carried
  a value-masked `user_id`, `triage`, and `correlation_id`; whether it is
  account-wide vs connection-specific is **still unknown**, so the streaming
  capability stays `false`.
- **Cleanup (deletions succeeded for this principal):** all cleanup DELETEs
  returned `200` (`failed: 0`, `remaining: 0`, `journalPersistenceFailed: 0`), and
  the recovery journal was absent after each run. The observed re-delete of the
  same just-deleted own thread returned **`403`** (not `404`); this is consistent
  with a permission/scope check, but the provider's evaluation order is
  unconfirmed, so the recovery command's exact-`404` convergence was not exercised.
- **Standalone create+delete probe:** a separate one-shot probe created a thread
  and deleted it (`200`/`200`), isolating that the password/member principal's
  login bearer authorizes both create and delete.
- **Promotion:** the verified-repeatable core shapes are encoded as synthetic
  fixtures (`processAccepted202`, `messagesCreateTime`) with matching contract
  tests, and `validation.ts` now maps `createdAt` from `create_time`. The ignored
  live reports and recovery journal are **not** committed.

## 2026-08-18 authorized observation (direct-mode smoke + native title behavior)

On 2026-08-18 a user-authorized, sanitized session recorded two distinct
observations. All facts below are **observed** (a value-free structural/behavioral
capture from a single authorized run), **not** an official or repeatable upstream
guarantee and **not** production-consumed. No live identifier, title, prompt,
answer, timestamp, credential, account field, or raw SSE/HAR/inventory body is
recorded.

### Direct-mode / OpenCode smoke (observed successful)

- The `collectiviq-claude-direct` model (`promptMode: "direct"`) submitted only
  the latest user text; the CollectivIQ UI showed no protocol wrapper.
- A natural TypeScript coding request returned a relevant, correct answer.
- A foreground OpenCode interaction returned a relevant answer, completed
  synthetic streaming, and produced **no** protocol objection, **no** tool alert,
  and **no** tool call.
- OpenCode's hidden `collectiviq-fast` title request returned a valid title on its
  **first** attempt and updated the OpenCode terminal session title.
- This establishes the Phase 1 semantic / OpenCode smoke criterion **for the
  tested account** (resolving the 2026-08-15 protocol-wrapper refusal for this
  account and path), but does **not** establish production readiness,
  combined-answer support, long-duration streaming, generic non-Claude foreground
  routing, or any other open provider gate.

### Native CollectivIQ title behavior (observed)

A bounded probe created three synthetic threads; all three were observed as
present by the **first** 15-second inventory check:

1. A URL-encoded `create_thread` with `thread_title=New Thread`,
   `is_title_from_user=false`, and current gateway `process_message` fields.
2. A Firefox-style multipart create plus the current gateway submission.
3. A Firefox-style create and submission control.

In this observed run:

- The minimal gateway-compatible trigger for native server-side title generation
  was the exact temporary title `New Thread`.
- Firefox-only extras were **not** required: multipart creation, `role=owner`,
  `llms_explicitly_set=false`, and `client_timezone`.
- `get_threads` returned an object whose `threads` property was **keyed by
  normalized thread-ID strings**; each entry contained `title` and did **not**
  redundantly contain a `thread_id`.
- Browser/network evidence showed the server-generated title first in a
  `/user/events` SSE message and **later** in `get_threads`; **no** separate
  client title-update POST was observed — persistence was server-side.
- Every gateway completion now starts with the `New Thread` placeholder;
  CollectivIQ may **asynchronously** replace it with a prompt-related,
  provider-generated title after `process_message`. That provider title is
  prompt-derived provider metadata (additional provider-side metadata/retention
  exposure) and is **distinct** from the OpenCode session title.
- Observed behavior for one account and run, **not** an official, documented,
  repeatable, or request-scoped upstream guarantee.

### `GET /get_threads` — OBSERVED-ONLY / provisional native-title lookup

**Consumed by exactly one non-completion path: the OpenCode session-title
extension** (`GET /v1/opencode/session-title`, spec section 9.5), and only as
OBSERVED-ONLY, account/principal-dependent, provisional evidence — **not** a
documented, repeatable, request-scoped, or generally supported provider capability,
and **not** part of any completion path. `get_threads` is **not** in the committed
filtered OpenAPI snapshot (the allowlist is unchanged); a bounded snapshot refresh
to add it is deferred to a separately-approved stage.

- Adapter operation `getThreadTitle(threadId)` issues a bare `GET /get_threads`
  under the bounded transport (5 s header, 5 s body, 4 MiB max body) with **no**
  internal retry, reusing the shared credential provider/transport.
- It reads **only the single target thread entry** from the observed
  thread-id-keyed `threads` map; it never enumerates, retains, serializes, or logs
  unrelated entries, and issues **no** thread-creating POST.
- Narrow pending/ready contract: a target absent from the map, or a title still
  equal to the fixed `New Thread` placeholder, is **pending**; a **ready** title
  must be a string that trims to non-empty, is single-line, is free of C0/C1
  control characters, and is ≤ 512 UTF-8 bytes; any malformed target or title is a
  normalized, content-free `UpstreamError` (no raw body, title, or identifier
  leaks).
- Because access is principal/account-dependent, this lookup (like thread deletion
  and `/available_llms`) may fail or return `pending` indefinitely on some
  accounts. No live identifier or title value is recorded here.

## Discovery session (four authorized runs; opt-in)

Live evidence is captured only through the staged discovery session
(`DiscoverySessionRunner` in `src/collectiviq/discovery.ts`) and its thin CLI
(`src/collectiviq/discovery-cli.ts`). Four authorized baselines have been run (see
above: two 2026-08-06/07 bearer runs and two 2026-08-11 password runs); it is
otherwise opt-in and preflight-only by default. Key properties:

- A single bounded `baseline` session against a **fixed** origin
  (`https://api.prod.collectiviq.ai`); no origin/path/thread-id/run-id may be
  supplied by the environment or CLI.
- **Default is preflight only**: it validates the model selection
  (`CIQ_DISCOVERY_SINGLE_LLM` = exactly one id; `CIQ_DISCOVERY_COMBINED_LLMS` =
  1–32 unique ids) and reports bounded projected counts (max 2 threads, 2
  submissions, 1 single-stage job, `combined` list length combined-stage jobs, 1
  synthesis job) plus approval flags — **without reading the credential or making
  any network request**.
- Authenticated execution requires `--execute-approved`; the single stage sends
  `generate_combined=false` with one model, the combined stage
  `generate_combined=true` with the validated list. Requests are encoded through
  the **same builders** the production adapter uses (`src/collectiviq/requests.ts`)
  over the same bounded HTTP core, so methods/paths/query/bodies are identical.
- **Raw evidence, captured then sanitized — but capture does not replace
  validation.** Discovery reads responses through a discovery-only bounded
  observation path (`observeUpstreamJson`, not exported from `index.ts`) that may
  parse JSON for **any** HTTP status, so the raw structure — including
  `process_message` run ids and the raw `auth`/`validation`/not-found error
  shapes — is captured (value-free) **before** any normalization and retained even
  when normalization then fails. The raw JSON is immediately reduced to a
  value-free structural capture and never enters a report, error, log, or
  persisted file. (The production adapter path is unchanged and still discards
  non-2xx bodies.)
- **Required 2xx stages must pass the production normalizer.** Capturing raw
  structure is evidence only; a required positive stage (`create_thread`,
  `process_message`, `get_messages`) is marked successful **only** after the same
  production normalizer the adapter uses
  (`normalizeCreateThread`/`normalizeProcessMessage`/`normalizeGetMessages`)
  accepts the 2xx body. On normalization failure the sanitized raw structure and
  HTTP status are preserved and only the closed, safe `UpstreamError` code is
  emitted (no raw value, id, prompt, model name, or error detail); the stage is a
  failure, so `exitCodeForBaseline` is non-zero. Only the **normalized top-level
  thread id** advances the workflow, takes ownership, is deleted, and is the
  thread-correlation target — a nested or unvalidated id is never used, never
  owned, and never deleted. Run-correlation candidates are extracted only **after**
  `normalizeProcessMessage` succeeds. Non-2xx responses keep their raw
  error-structure observation unchanged.
- **Private correlation, targeting the combined-model request that immediately
  precedes the stream.** The SSE correlation target is an atomic pair: the
  **normalized combined-stage thread id** plus the run candidates from the
  **successfully validated combined submission** only. Establishing the combined
  thread target resets run candidates, so a missing combined run id can never fall
  back to the single stage; single-stage identifiers are never mixed in. The run
  dimension compares the observed SSE run values against the **set of all usable
  run candidates** from that submission (`run_id` and `combined_run_id`, deduped)
  and reports `matched` when **any** candidate appears in the observed set,
  `not-matched` when a run was requested and some run was observed but the sets are
  disjoint, and `not-observed` when no run was requested or none was observed. If
  combined thread creation fails, thread and run correlation are `not-observed`; if
  creation succeeds but submission fails or exposes no run id, thread correlation
  may still be evaluated while run stays `not-observed`. Candidate values are
  extracted descriptor-only (bounded, cycle-safe; accessors/Proxy `get` traps never
  invoked) into **private in-memory** state and are never printed, persisted,
  logged, hashed, or returned. The report carries only a value-free `thread`/`run`
  comparison of `matched` / `not-matched` / `not-observed`. Capability flags are
  **not** flipped by this — streaming/cancellation/token usage stay `false` until
  repeatable evidence is reviewed.
- Selection and approval invariants are **canonicalized and re-validated inside
  the runner** before any request, with the same rules the CLI parser enforces
  (defense in depth, not delegated to the CLI): the single id is trimmed and must
  be non-empty and comma-free; the combined selection must be a 1–32 element array
  of strings, each trimmed, non-empty, and comma-free (one element is never
  reinterpreted as several models), with duplicates rejected **after** trimming.
  The runner uses the canonical (trimmed) copy for every projection and outbound
  request and never mutates the caller's array; invalid direct input is rejected
  before the first fetch. Not-found approval still requires cleanup approval.
- Cleanup of session-owned threads requires `--cleanup-approved` (never
  automatic). The not-found probe requires `--observe-not-found-approved` **and**
  `--cleanup-approved`; it deletes one session-owned id (counted as cleanup work)
  and then re-deletes the **same** id (never a guessed id) to capture the
  not-found shape — the second, already-deleted delete is **not** counted as
  cleanup. If the first deletion fails, ownership is retained, the second delete
  is skipped, the not-found evidence is left incomplete, and final cleanup retries
  the id; a failed first deletion remains a recorded failure even if a later retry
  succeeds. Cleanup reports cumulative bounded counts `attempted`/`succeeded`/
  `failed`/`remaining` — never identifiers.
- **Cleanup diagnostics (added by the 2026-08-06 remediation).** The cleanup
  report (`DiscoveryCleanupReport`) now also carries, besides the cumulative
  counts (which describe HTTP DELETE outcomes only), a `journalPersistenceFailed`
  count and a bounded list of value-free per-attempt summaries — each with a
  `phase` (`not-found-initial` | `final-cleanup` | `recovery-cleanup`), `ok`, an
  HTTP `status` or null, a normalized safe `errorCode` or null, and
  `journalPersisted` (`true` = DELETE + journal removal both persisted; `false` =
  DELETE succeeded but journal removal failed; `null` = DELETE failed, none
  attempted). No id, path, body, or message. A thread is dropped from the
  in-memory ownership ledger on a confirmed HTTP DELETE even when its journal
  removal fails — so a filesystem fault cannot resurrect it — and the stale
  journal converges through recovery's exact-`404` handling;
  `journalPersistenceFailed > 0` is itself a non-zero-exit condition. This lets a
  future run distinguish a cleanup `403` from a timeout/network failure without
  exposing anything. Shared helper `observeThreadDeletion` lives in
  `src/collectiviq/cleanup.ts`.
- **Recovery journal (added by the 2026-08-06 remediation).**
  `src/collectiviq/recovery-journal.ts` maintains a private on-disk journal at a
  fixed path under the ignored `.agent/sessions/discovery/`
  (`recovery-journal.json`), separate from the sanitized `baseline.json`. It
  stores **only** a format version (1), the fixed destination origin, and at most
  two normalized thread ids — never credentials, model ids, run ids, prompts,
  titles, answers, bodies, statuses, timestamps, or account/user data. It is
  written atomically (private temp file, mode `0600`, `O_NOFOLLOW`, then rename)
  and rejects symlinks, non-regular files, wrong origin, malformed JSON,
  unsupported version, duplicate ids, more than two ids, empty ids, oversized ids,
  and oversized files. Authenticated baseline execution now **requires** explicit
  recovery-journal approval (a new `--recovery-journal-approved` CLI flag,
  re-checked inside the runner before any request) and verifies journal
  writability before the first request; each created thread id is recorded
  immediately and dropped only after a confirmed successful deletion; the journal
  is removed when empty and retains remaining ids if cleanup fails. Preflight only
  reports the approval boolean and does **no** journal I/O. The recovery journal
  is maintained **independently of `--write`**: `--write` governs only whether a
  sanitized baseline evidence report is persisted under the ignored
  `.agent/sessions/`, while an authenticated approved run
  (`--execute-approved` + `--recovery-journal-approved`) always maintains the
  id-only journal (a separate private file, `recovery-journal.json`) whether or
  not `--write` is given. Sink transitions are **durable-first**: the on-disk
  journal state is written successfully before the in-memory ownership ledger
  changes.
- **Fatal abort on journal-persistence failure (added by the 2026-08-06
  remediation).** If a thread is created upstream but the recovery journal cannot
  durably persist that id (`recordCreated` fails), the baseline run **aborts
  immediately**: no further upstream request is made (no message submission and no
  second thread create). The created thread is placed in the in-memory ownership
  ledger **before** the journal write is attempted, so the already-approved
  cleanup is still attempted for it. The run returns a fixed, content-free aborted
  result (report field `aborted: "journal-persistence-failed"`) and always exits
  non-zero; no filesystem path, id, or raw error is ever serialized. A journal
  **initialization** failure (before any create) makes **zero** network calls.
- **Recovery-only cleanup command (added by the 2026-08-06 remediation).**
  `npm run contract:discovery:cleanup` (thin CLI
  `src/collectiviq/discovery-recovery-cli.ts`) is network-only, opt-in, and
  **excluded from `validate`/CI**. It targets the fixed origin only, reads thread
  ids **only** from the validated recovery journal (at most two), takes no
  id/path/URL argument, reads no model-selection variables, and requires
  `--execute-approved`, `--cleanup-approved`, and `--recovery-journal-approved`.
  It refuses a missing/empty/invalid journal, deletes through the same
  percent-encoded fixed delete path and bounded transport, resolves an id on an
  HTTP `2xx` (`deleted`) **or** an exact `404` (`already_absent`) while every
  other status/transport/timeout stays unresolved, drops a resolved id from the
  journal **only after** that resolved state is durably persisted (a persistence
  failure keeps the id pending), emits only the value-free cleanup report, and
  exits non-zero when `unresolved > 0 || remaining > 0` (see the convergence
  detail below).
- **Recovery convergence on an exact `404` (added by the 2026-08-06
  remediation).** `runRecoveryCleanup` now resolves a journal-owned id when the
  DELETE returns HTTP `2xx` (`deleted`) **or** an exact HTTP `404`
  (`already_absent`). Both resolve ownership so recovery converges across the crash
  window where a prior DELETE succeeded but the journal update did not. Every
  **other** status (e.g. `403`, `410`), transport failure, or timeout stays
  unresolved and is retried on a later run. HTTP truth is preserved in per-attempt
  diagnostics — a `404` is still recorded as a non-`2xx` response (`ok: false`,
  `status: 404`), never relabeled as an HTTP success; the recovery classification
  is separate (`resolved` with `resolution: "deleted" | "already_absent"`). An id
  is removed from the journal **only after** the resolved state is durably
  persisted; if that journal write fails the id stays pending and the run exits
  non-zero so a later run converges. The recovery report shape is now
  `{ attempted, resolved, unresolved, remaining, attempts: [{ ok, status,
  errorCode, resolved, resolution, persisted }] }` (it is **no longer**
  `succeeded`/`failed`), and the exit is non-zero when
  `unresolved > 0 || remaining > 0`.
- **`/available_llms` completeness policy (added by the 2026-08-06 remediation).**
  Strict baseline completeness still requires an `available_llms` observation, but
  now accepts either a **structurally valid** `2xx` success **or** exactly a `403`
  normalized to the authentication/authorization category as an observed
  inventory-access restriction; it still fails on `401`/`429`/`5xx`/transport/
  timeout/missing/malformed. A `2xx` body is accepted as a valid inventory **only**
  when the top level is a non-null, non-array object with an own `llms` property
  that is itself a non-null, non-array object holding **at least one** entry, and
  every entry is a non-null, non-array object. A malformed `2xx` body is **not** a
  silent success: it produces a **failed** observation with error code
  `invalid_upstream_response` and drives a non-zero exit, while its sanitized
  structure is still retained. No account-specific model value is required,
  inspected, or retained, and extra top-level and per-descriptor properties are
  allowed (forward compatible). The `403` outcome is accepted only as an *exact*
  status and no inference is drawn about why the provider returned it. All other
  gates (core create/submit/messages, auth probe, validation probe, SSE
  usefulness, requested not-found evidence, cleanup) remain strict.
- **Strict completeness exit code** (`exitCodeForBaseline`): non-zero when any
  required positive stage failed, the auth/validation probes did not yield their
  expected failures, requested not-found evidence was not obtained, the SSE
  evidence is invalid/incomplete, or cleanup left any `failed` or `remaining`
  owned thread **or** any `cleanup.journalPersistenceFailed > 0` (a confirmed HTTP
  delete whose journal removal failed). Expected auth/validation errors are not
  themselves failures.
- Evidence is a **sanitized structural capture** (evidence format version
  `STRUCTURAL_CAPTURE_FORMAT = 2`, stamped as `evidenceFormatVersion` on every
  authenticated baseline report and every persisted discovery file): constant type
  markers only (`<string>`, `<number>`, …) with **no values and no value lengths**;
  safe identifier-like field names are preserved and every
  reserved/credential-like/content-bearing or non-identifier name becomes a
  positional `field_N`; depth/width/output are bounded; cycles, sparse holes,
  accessors, and hostile Proxies fail closed. An array's `length` is read once via
  its own **data** descriptor (never a `get` trap/accessor); a
  missing/accessor/invalid/throwing length collapses the array to a fixed marker.
- SSE evidence (`readSseEvidence`) rejects and cancels a non-2xx response before
  parsing (normalized to a failed observation, never `ok`), requires a
  `text/event-stream` content type, decodes strict UTF-8 and **finalizes the fatal
  decoder at end of stream** (a truncated terminal multibyte becomes
  `malformed-utf8`, not `eof`), supports LF and CRLF record separators split
  across chunks, bounds header/body/total/event size — including enforcing the
  per-event bound against an **unterminated pending record** so an oversized event
  with no delimiter is caught — retains only safe event names, sanitizes each
  event's JSON `data` through structural capture, extracts SSE correlation
  candidates value-free, and reports a bounded termination reason:
  useful = `completed`/`eof`/`timeout`/`event-limit`; incomplete =
  `body-limit`/`malformed-utf8`/`invalid-content-type`/`cancelled`/`stream-error`
  (external cancellation, body-read timeout, and a mid-stream reset are
  distinguished). The reader is cancelled and timers/listeners cleared on every
  exit path.

## Error behavior

- `422` uses `HTTPValidationError` → `ValidationError[]`, whose entries may carry
  content-bearing `input`, `msg`, and `ctx`. These are **never** logged or
  exposed. The adapter maps `422` to a normalized `validation` error and never
  reads the body.
- The adapter's normalized error model (`src/collectiviq/errors.ts`) is a closed
  category/code union: `authentication`, `quota`, `validation`, `transient_http`,
  `network`, `timeout`, `cancellation`, `response_too_large`, `upstream_protocol`,
  `unexpected_upstream`. Errors carry only the category, a stable safe code, an
  optional raw HTTP status, a **method-aware** retryability hint, and the request
  method when known — never bodies, headers, credentials, prompts, answers,
  `detail`/`msg`/`input`/`ctx`, or identifiers.
- Status mapping: `401`/`403` → authentication; `429` → quota; `400`/`422` →
  validation; `502`/`503`/`504` → transient; other non-2xx → unexpected.
  Transport failures classify to cancellation (caller abort), timeout (deadline),
  or network. The method is carried through the error factory so retryability is
  decided once.
- **Method-aware retryability.** The `retryable` hint is advisory only (the
  adapter never auto-retries). It is `true` **only** for an idempotent `GET`
  whose failure is a network error or a selected transient status
  (`502`/`503`/`504`). Every `POST`/`DELETE` failure is `retryable: false`,
  because after an ambiguous transmission the side effect may already have
  occurred and cannot be proven not to have. A `GET` timeout is also
  non-retryable. When the method is unknown (a local guard, not a transport
  failure), the failure is non-retryable.
- `create_thread` and `process_message` are **never** automatically retried
  (and, being POSTs, are never marked retryable).
- `process_message` success requires the absence of an **own `detail` property**:
  if a parsed 2xx body has its own `detail` key, the response is a failure
  regardless of the property's value (`null`, `undefined`, empty string, object,
  or array), and the raw value is never read or exposed.

## OpenAPI retrieval bounds

`scripts/openapi/fetch-openapi.ts` retrieves the public document under strict
bounds: it targets only the fixed source URL (no caller-supplied URL), enforces
an overall deadline with cancellation, requires a JSON-compatible content type,
rejects an over-declared `Content-Length` before reading, reads the body
incrementally and rejects as soon as accumulated bytes exceed 16 MiB (before the
whole body is buffered), cancels the reader/response on overflow/timeout/decode
failure, decodes strict UTF-8, and parses JSON only after the bounded read. A
`fetchImpl` may be injected for tests, but it is always invoked with the fixed
source URL. No credentials are ever sent, and the command stays out of
`validate`/CI.

## Capability matrix

Per spec section 13, every capability defaults to `false` until documentation or
repeatable sanitized evidence proves otherwise (`DEFAULT_UPSTREAM_CAPABILITIES`).

| Capability | State | Basis |
| --- | --- | --- |
| Native tool definitions | `false` | Unverified. Unrelated tool/MCP endpoints do not establish native tool calling. |
| Native tool results | `false` | Unverified. |
| Request-scoped streaming | `false` | `/user/events` SSE thread+run correlation matched across all four runs, including the two **verified-repeatable** 2026-08-11 password runs. It stays `false` because the decisive open question — whether the stream is **account-wide vs connection-specific** — is still unknown; correlation matching alone does not establish request scoping. |
| Cancellation | `false` (adapter) | `/abort_run` exists but is cooperative and not adopted; a submitted generation may continue after client disconnect. |
| Token usage | `false` | `/thread_tokens` exists but is not adopted; `percent_usage` meaning is unknown. |

## Limits and retention (open)

- Maximum prompt size, account/model rate limits, and thread retention are
  **unknown** and must be answered by live discovery.
- CollectivIQ-side retention, training use, deletion, and regional controls are
  unknown; the gateway must not promise end-to-end zero retention.
- The gateway enforces its own bounds: per-operation header/body deadlines,
  incremental response-size caps, and strict UTF-8 (`DEFAULT_OPERATION_TIMEOUTS`).

## Fixture references

- Committed contract snapshot: `contract/collectiviq/openapi-filtered.json`.
- Synthetic runtime fixtures (invented, not live): `test/contract/fixtures/collectiviq/`.
- Hermetic contract tests (mock HTTP server): `test/contract/`.

No live **value** has ever been promoted into a committed fixture. Following the
two verified-repeatable 2026-08-11 password baselines, the confirmed core shapes
are encoded as **synthetic** fixtures — `processAccepted202` (the `202`
`process_message` shape) and `messagesCreateTime` (the `create_time` metadata
mapping) — whose values are invented, not captured. Field NAMES and types reflect
the observation; identifiers, timestamps, account/user fields, prompts, answers,
tokens, and account-specific model ids are never present. The ignored live
reports and recovery journal under `.agent/sessions/` are never committed.

## OpenAPI drift history

| Date (UTC) | SHA-256 (short) | Notes |
| --- | --- | --- |
| 2026-08-05 | `c66332fd` | Initial capture. 422 paths; all nine allowlisted operations present and consistent with the known facts. Confirmed: `create_thread` is urlencoded (not multipart); `process_message` includes `llms_explicitly_set`; `get_messages` documents `since_id`; all core `200` schemas empty; `thread_tokens.thread_id` is integer while other `thread_id`s are string. |
| 2026-08-07 | `c66332fd` | Snapshot refresh for the dual-mode auth work. Full document **unchanged** (same SHA, still 422 paths); no unrelated drift. The allowlist grew from **nine to ten** operations — `POST /login` and its transitive `Body_login_login_post` schema were added — to support the optional OAuth2 password mode. Security scheme `OAuth2PasswordBearer`; password-flow `tokenUrl` `/login`; login accepts `application/x-www-form-urlencoded` with required `username`/`password`, `grant_type=password`, `scope` defaulting to empty, and optional `client_id`/`client_secret`; the documented `200` response schema is empty. |

## Remaining live / provider questions

Tracked in spec section 35. Statuses now reflect the two **verified-repeatable**
2026-08-11 password baselines plus the earlier bearer runs. Several items below
are now resolved/verified; the rest remain open and are consolidated into the
later-release / provider-confirmation gap matrix in spec section 35 (they do not
block Phase 1 text entry). The highest-priority items:

1. Real success schemas and status codes for the four core endpoints —
   **verified-repeatable** (`create_thread` `200`, `process_message` `202`,
   `get_messages` `200`, plus `POST /login` `200`), encoded as synthetic
   fixtures. Response *fields* beyond the validated ones remain masked/provisional.
2. Whether `process_message` is idempotent and returns a job/message identifier —
   a run identifier (`combined_run_id`) **repeated** in the `202` across the two
   2026-08-11 password runs; idempotency remains **unresolved**.
3. How to distinguish accepted work from failed work beyond `detail` — a `status`
   field's presence **repeated** across the two password runs but its meaning is
   **unknown**.
4. Whether `get_messages` is chronological and paginates — **unresolved**.
5. The effect of `llms_explicitly_set` and valid `selected_llms` values —
   **unresolved**.
6. `/user/events` correlation fields and whether it is account-wide — thread+run
   correlation **matched in both 2026-08-11 password runs** (corroborating
   2026-08-06); account-wide-vs-connection scope remains **unknown**, so the
   streaming capability stays `false`.
7. Maximum prompt size, rate limits, and thread retention — **unresolved**.
8. Whether native tools / structured tool results exist — **unresolved**.
9. Whether API thread deletion is permitted/works — **credential/principal-dependent
   behavior observed (cause not established).** The password/member principal
   deleting its own newly created thread → `200` (repeated: both 2026-08-11 runs +
   a standalone probe); re-deleting that same just-deleted id → `403` (repeated);
   the API-key principal deleting its own newly created thread → `403` (observed
   2026-08-07); a cross-principal recovery attempt → `403` (observed during the
   approved recovery attempt). Consistent with a permission/scope check, but the
   provider's evaluation order is unconfirmed; recovery's exact-`404` convergence
   was not exercised by these cases.
10. `/available_llms` access — **credential/principal-dependent (cause not
    established).** The password/member principal got `200` (repeated); the API-key
    principal got `403` in the earlier bearer runs.
11. Whether the OAuth2 password login (`POST /login`) works and its real `200`
    response shape — **login verified-live** (two 2026-08-11 runs: `200`,
    normalizable `Bearer access_token`). **Still open:** response fields beyond
    `access_token`/`token_type` (masked), and token **lifetime/refresh**
    behaviour. `/auth/refresh` has empty schemas and is not implemented.
