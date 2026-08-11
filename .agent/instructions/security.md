# Security and Privacy

## Required Reading

Read `.agent/docs/tech-software-spec.md` sections 19, 21–23, 24, 31, 33, and 34 before security-sensitive changes. Prompt/tool work also requires the tool-calling guide; upstream work requires the upstream guide.

## Implemented Foundation Controls

These controls exist today and must be preserved:

- **Gateway client authentication** — `src/api/gateway-auth.ts` authenticates every `/v1/*` route (`src/api/v1-routes.ts` route group) via `Authorization: Bearer <gateway-key>` against `COLLECTIVIQ_GATEWAY_KEYS`; `/healthz` and `/readyz` stay unauthenticated. The scheme is case-insensitive, the token is compared **exactly** (no trim/normalize), and comparison is fixed-length: configured keys become SHA-256 digests once, the presented token is hashed once, and each digest is checked with `node:crypto` `timingSafeEqual` **without** an early return on a match. Bounds (`GATEWAY_KEY_LIMITS` in `src/config/schema.ts`): ≤64 keys, ≤8192 UTF-8 bytes/key, with the same byte cap bounding a presented token before hashing. Missing/malformed/empty/oversized/incorrect credentials all return one fixed OpenAI `401`; authentication is mandatory (no disable switch); the gateway key is never forwarded upstream, logged, or reflected. Public errors use the shared bounded OpenAI envelopes in `src/openai/errors.ts` (`401`/`404`/`500`), and the `500` path never inspects the thrown value. Keep this separate from the upstream credential provider (`auth.ts`).
- **Bounded model configuration** — `MODEL_CONFIG_LIMITS` in `src/config/schema.ts` (spec section 24.1): file byte cap (checked before and after read), regular-file requirement, strict UTF-8 decode, YAML alias/duplicate-key rejection, and bounds on model/source counts, string lengths, timeouts, polling, and prompt bytes. Blank/whitespace-padded ids and sources are rejected.
- **Value-free diagnostics** — configuration errors are stable allowlisted field/reason pairs (no ids, unknown field names, submitted values, file contents, library text, or paths); an unexpected startup failure prints only `gateway failed to start (internal error)`.
- **Recursive bounded log sanitization** — `src/shared/redaction.ts` (`sanitizeLogValue`) plus the logger's `formatters` and `logMethod` hook sanitize every record, child binding, and Error argument, with Pino redact paths as additional defense. Never bypass the logger with a second Pino configuration; never emit `Error.message`/stack/cause.

- **Upstream authentication** — a shared credential provider (`auth.ts`) supplies a per-request **lease** bearer token used by the transport, SSE, deletion, and recovery paths, selected by `COLLECTIVIQ_AUTH_MODE`: `bearer` (default) uses the static `COLLECTIVIQ_API_KEY`; the `password` mode (login **verified-live** by the two 2026-08-11 password baselines) mints a short-lived token (held in memory only) via a bounded **unauthenticated** `POST /login` (20 s deadlines, 64 KiB cap, strict UTF-8, JSON, exactly HTTP `200`, `redirect: "error"`, no `Authorization` header), with single-flight coalescing, generation-safe invalidation, and a hard two-login budget for discovery/recovery. Token lifetime/refresh remains unverified. A `401` invalidates the lease (the request is never replayed); a `403` does not. A returned refresh token is ignored; `/auth/refresh` is not implemented. Residual risk: username/password stay resident in process/config memory (JS strings cannot be securely erased).
- **Upstream boundary safety** — `src/collectiviq/` attaches the lease bearer token only in the JSON transport (`http.ts`; the SSE path shares the same provider) and never logs it; enforces per-operation header/body deadlines, incremental response-size caps (never `response.json()` before the cap), strict UTF-8, and JSON content-type checks; and never auto-retries `create_thread`/`process_message`. Failures are the closed, content-free `UpstreamError` model (`errors.ts`) — no bodies, headers, credentials, prompts, answers, or `HTTPValidationError` `input`/`msg`/`ctx`/`detail`; retryability is **method-aware** (only idempotent-`GET` network/transient failures are retryable). The log sanitizer reduces any such error to `{ name, code }`. `process_message` treats any own `detail` property as failure.
- **Bounded OpenAPI retrieval** — `scripts/openapi/fetch-openapi.ts` contacts only the fixed source URL (no caller/env URL), enforces an overall deadline with cancellation, requires a JSON content type, rejects an over-declared `Content-Length` before reading, reads incrementally and rejects past 16 MiB before buffering the whole body, and decodes strict UTF-8. Network-only; excluded from `validate`/CI.
- **Discovery tooling safety** — the opt-in staged session (`DiscoverySessionRunner` in `discovery.ts`, thin `discovery-cli.ts`) runs one bounded `baseline` session against a fixed origin (no origin/path/thread-id/run-id injection). Default is **preflight only** (validates selection, reports bounded projections/approvals, reads no credential, makes no network call); it opens no socket and reads no credentials on import. Authenticated execution needs `--execute-approved` **and** `--recovery-journal-approved`; selection/approval invariants (single non-empty/comma-free; combined 1–32 unique, **duplicates rejected**; not-found requires cleanup) are re-checked **inside the runner** before any request. Evidence is captured from the **raw** upstream body for any status via a discovery-only `observeUpstreamJson` (never exported from `index.ts`; the production adapter still discards non-2xx bodies), then immediately reduced to sanitized structure. Correlation ids (`thread_id`/`run_id`/`combined_run_id`) are extracted descriptor-only (no accessor/Proxy `get`) into **private in-memory** state and emitted only as a value-free `matched`/`not-matched`/`not-observed` comparison — capability flags are never auto-flipped. Cleanup needs `--cleanup-approved` (never automatic) and reports a truthful cumulative ledger whose `attempted`/`succeeded`/`failed`/`remaining` counts describe **HTTP DELETE outcomes only**, plus bounded value-free per-attempt summaries (`phase`/`ok`/status or null/safe `errorCode` or null/`journalPersisted` — no id/path/body/message; shared `observeThreadDeletion` in `cleanup.ts`) so a cleanup `403` is distinguishable from a timeout/network failure; each attempt carries `journalPersisted: true | false | null`, and a separate `journalPersistenceFailed` counts confirmed HTTP deletes whose journal removal failed and independently forces a non-zero baseline exit. A confirmed HTTP delete drops the thread from the in-memory ownership ledger **even when its journal removal fails** (the stale journal converges via the recovery command's exact-`404` handling). The not-found probe needs both approvals, counts its first delete as cleanup, re-deletes the **same** session-owned id (never guessed) as the observation (not counted), and on a first-delete failure retains ownership, skips the second delete, and keeps the recorded failure. Exit code follows **strict session completeness** (required stages, expected auth/validation failures, an `available_llms` observation that accepts a **structurally valid** `2xx` (top-level object with an own `llms` object holding at least one object entry; no model value inspected) **or** exactly a `403` normalized to the authentication/authorization category as an observed inventory-access restriction — still failing on `401`/`429`/`5xx`/transport/timeout/missing/malformed, a malformed `2xx` being a failed `invalid_upstream_response` observation — not-found evidence, SSE usefulness, and zero cleanup failures/remaining/`journalPersistenceFailed`). Run ids stay in memory; thread ids stay in memory except that, under `--recovery-journal-approved`, at most two are written content-free to the recovery journal for recovery. Evidence is sanitized structural capture (`structural-capture.ts`, format v2 stamped as `evidenceFormatVersion` on reports/persisted files: constant type markers only — no values, value lengths, unsafe field names, or identifiers; array length read via own data descriptor, never a `get` trap), persisted only with `--write` under the ignored `.agent/sessions/`. SSE evidence (`readSseEvidence`) rejects non-2xx before parsing, finalizes the fatal UTF-8 decoder at EOF, bounds an unterminated pending record, and distinguishes `cancelled`/`timeout`/`stream-error`. The **recovery journal** (`recovery-journal.ts`) is a private on-disk file at a fixed path under the ignored `.agent/sessions/discovery/` holding **only** a format version (1), the fixed origin, and at most two normalized thread ids (no credentials, run ids, content, statuses, or timestamps); it is written atomically (mode `0600`, `O_NOFOLLOW`, temp-then-rename) and rejects symlinks, non-regular files, wrong origin, malformed/oversized/unsupported/duplicate/over-count/empty/oversized-id input; each created id is recorded immediately and dropped after a confirmed deletion. The recovery-only `npm run contract:discovery:cleanup` command (`discovery-recovery-cli.ts`) is network-only, **excluded from `validate`/CI**, targets the fixed origin, reads ids **only** from the validated journal (no id/path/URL argument, no model variables), requires `--execute-approved`/`--cleanup-approved`/`--recovery-journal-approved`, resolves an id on an HTTP `2xx` (`resolution: "deleted"`) **or** an exact `404` (`resolution: "already_absent"`, still recorded HTTP-truthfully as `ok: false`, `status: 404`) so recovery converges across a crash between a successful delete and the journal update — every other status, transport failure, and timeout stays unresolved — drops a resolved id from the journal only after that resolved state persists durably (a persistence failure keeps the id pending), reports `{ attempted, resolved, unresolved, remaining, attempts }`, and exits non-zero when `unresolved > 0 || remaining > 0`. A single shared safe-directory helper (`ensureSafeDiscoveryDir`, used by both the sanitized report writer and the journal) creates-or-tightens the shared discovery directory to a real, private `0700`, non-symlink directory before journal initialization (tightening an existing real `0755` directory and refusing a symlink/non-directory). Four authorized baselines ran: two on 2026-08-06/07 (bearer, both failed strict completeness) and two on **2026-08-11 (`password` mode) that BOTH exited zero** with identical safe contract facts — so password `POST /login` and the core create/submit/messages shapes are now **verified-repeatable** and encoded into synthetic fixtures (no live value committed). Thread-deletion outcomes were **credential/principal-dependent** (cause not established): the password/member principal deleted its own newly created thread (`200`, repeated) while re-deleting that same just-deleted id returned `403`; the API-key principal's own-thread delete returned `403` (2026-08-07); a cross-principal recovery attempt also returned `403`. Consistent with a permission/scope check, but the provider's evaluation order is unconfirmed, so recovery's exact-`404` convergence was not exercised. Must not be run without explicit approval.

When changing any of the above, update spec section 24.1, the [upstream contract owner doc](../docs/collectiviq-upstream-contract.md), `README.md`, and `SECURITY.md` together.

## Secrets and Authentication

- The upstream credential authenticates the gateway to CollectivIQ — `COLLECTIVIQ_API_KEY` in `bearer` mode, or `COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` (exchanged at `POST /login`) in `password` mode; gateway keys authenticate clients. Never conflate or forward them, and redact all of them (plus any minted `access_token`) everywhere. Config/CLI credential errors stay value-free.
- Load secrets from environment or an approved secret manager and redact them from startup output, logs, traces, metrics, errors, tests, snapshots, commands, and fixtures.
- Production requires gateway authentication. Authentication may be disabled only for an explicitly local single-user service bound exclusively to loopback.
- Compare keys using a timing-safe strategy where practical, hash only the correlation identity needed for bounded operational metadata, and never log the presented key.
- Metrics need network isolation or independent authentication; health output must not disclose configuration values.

## Content Confidentiality

Forbidden in default logs and telemetry:

- messages, serialized prompts, answers, or source code;
- file/repository paths;
- tool arguments or results;
- authorization headers and credentials;
- raw upstream response bodies.

Content logging requires both `ENVIRONMENT=development` and `LOG_CONTENT=true`, an unmistakable startup warning, bounded/redacted output, and explicit task justification. It must never be activated against production/customer data.

Thread titles and request metadata must be generic. Do not derive them from prompts, repository names, filenames, or personal data.

## Input and Upstream Trust

- Validate raw client, config-file, tool-schema, tool-argument, Redis, and upstream data at their boundaries.
- Enforce byte limits before retaining or parsing large bodies where possible.
- Treat prompt boundaries as ambiguity mitigation, not an authorization boundary.
- Allowlist tool names and validate exact schemas; OpenCode permission checks remain mandatory.
- Use OpenAI-style sanitized errors externally and structured bounded categories internally.
- Avoid dangerous dynamic behavior: no evaluation of generated code, no shell execution, no arbitrary module loading, and no gateway-side tools.

## Resource and Abuse Controls

Preserve configurable bounds for:

- HTTP request bodies and final prompts;
- tool count, total schema size, argument size, and calls per response;
- upstream response size;
- global/per-key active requests, queue length, and queue duration;
- connect/operation/total deadlines;
- polling intervals and retry count implied by the total deadline.

Acquire capacity before upstream thread creation. Return the documented `429` plus `Retry-After` when capacity is unavailable. Metrics labels must remain bounded; never label with request, thread, user, or tool-call IDs.

## Retention and Redis

- Default mode retains no content after request completion.
- Keep only transient in-memory values needed for the active request and release references promptly.
- Redis is optional and initially limited to short-lived idempotency/status/final-response state and counters.
- Do not persist prompt content by default. Cached final responses require an explicit TTL, encryption-at-rest expectations, access controls, and documentation.
- Same idempotency key with a different body returns `409`; do not use a permanent prompt hash as an implicit key across trust boundaries.
- CollectivIQ-side retention/training/deletion/regional behavior is unknown until verified; do not promise zero retention end to end.

## Network and Deployment

- Native local default is `127.0.0.1:8787`.
- Binding to `0.0.0.0` requires explicit configuration. In the supplied Docker example it is acceptable only inside the container while host publishing stays on loopback.
- Hosted use requires TLS termination, authentication, firewall/private-network controls, rate limits, protected logs/metrics, and managed secrets.
- Run containers as non-root where feasible, minimize the image, pin dependencies/images, and keep build credentials out of layers.

## Dependencies and External Actions

- Prefer established, maintained packages with narrow purpose and compatible licenses.
- Verify current guidance from primary sources for security-sensitive dependencies.
- Lock every dependency and run the full compatibility suite for automated updates.
- Major upgrades, new external services/telemetry, broad lockfile regeneration, secret operations, live content-bearing probes, publishing, or deployment require explicit approval.

## Security Review Checklist

- Are secrets separated and redacted on every success/error path?
- Can any prompt, response, path, argument, or tool result reach logs/traces/metrics?
- Are network exposure and authentication defaults still safe?
- Are all untrusted boundaries schema-validated and size-bounded?
- Can cancellation/timeout release capacity and memory promptly?
- Could a retry duplicate an upstream side effect?
- Does any cache change content retention or cross-user visibility?
- Are error messages useful without exposing upstream bodies?
- Are test fixtures synthetic or demonstrably sanitized?
- Does the documentation state residual risks honestly?
