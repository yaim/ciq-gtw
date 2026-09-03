# Security and Privacy

## Required Reading

Read `.agent/docs/tech-software-spec.md` sections 19, 21–23, 24, 31, 33, and 34 before security-sensitive changes. Prompt/tool work also requires the tool-calling guide; upstream work requires the upstream guide.

## Implemented Foundation Controls

These controls exist today and must be preserved:

- **Gateway client authentication** — `src/api/gateway-auth.ts` authenticates every `/v1/*` route (`src/api/v1-routes.ts` route group) via `Authorization: Bearer <gateway-key>` against `COLLECTIVIQ_GATEWAY_KEYS`; `/healthz` and `/readyz` stay unauthenticated. The scheme is case-insensitive, the token is compared **exactly** (no trim/normalize), and comparison is fixed-length: configured keys become SHA-256 digests once, the presented token is hashed once, and each digest is checked with `node:crypto` `timingSafeEqual` **without** an early return on a match. Bounds (`GATEWAY_KEY_LIMITS` in `src/config/schema.ts`): ≤64 keys, ≤8192 UTF-8 bytes/key, with the same byte cap bounding a presented token before hashing. Missing/malformed/empty/oversized/incorrect credentials all return one fixed OpenAI `401`; authentication is mandatory (no disable switch); the gateway key is never forwarded upstream, logged, or reflected. On a successful match the route records only **opaque** per-configured-key identities — never the raw key or its digest: `k<index>` for process-local per-key capacity, plus (when the corresponding optional feature is configured) the cross-replica idempotency scope and, since Phase 4B, a THIRD identity, the cross-replica rate-limit scope. All three are precomputed once at authenticator construction so the raw key is never re-read per request; the two cross-replica scopes are derived under separate HKDF domains, so a key's rate-limit scope is a different value from its idempotency scope; each is `null` when its feature is disabled; and none is ever logged, reflected, or returned. Public errors come only from the shared bounded OpenAI envelopes in `src/openai/errors.ts` (the full Phase 1B set: `400`/`401`/`404`/`413`/`429`/`500`/`502`/`503`/`504`); the fixed `500` and the completion route's fail-closed boundary (below) never inspect, serialize, log, or reflect the thrown value. Keep this separate from the upstream credential provider (`auth.ts`).
- **Bounded model configuration** — `MODEL_CONFIG_LIMITS` in `src/config/schema.ts` (spec section 24.1): file byte cap (checked before and after read), regular-file requirement, strict UTF-8 decode, YAML alias/duplicate-key rejection, and bounds on model/source counts, string lengths, timeouts, polling, and prompt bytes. Blank/whitespace-padded ids and sources are rejected.
- **Value-free diagnostics** — configuration errors are stable allowlisted field/reason pairs (no ids, unknown field names, submitted values, file contents, library text, or paths); an unexpected startup failure prints only `gateway failed to start (internal error)`.
- **Recursive bounded log sanitization** — `src/shared/redaction.ts` (`sanitizeLogValue`) plus the logger's `formatters` and `logMethod` hook sanitize every record, child binding, and Error argument, with Pino redact paths as additional defense. Never bypass the logger with a second Pino configuration; never emit `Error.message`/stack/cause.

- **Upstream authentication** — a shared credential provider (`auth.ts`) supplies a per-request **lease** bearer token used by the transport, SSE, deletion, and recovery paths, selected by `COLLECTIVIQ_AUTH_MODE`: `bearer` (default) uses the static `COLLECTIVIQ_API_KEY`; the `password` mode (login **verified-live** by the two 2026-08-11 password baselines) mints a short-lived token (held in memory only) via a bounded **unauthenticated** `POST /login` (20 s deadlines, 64 KiB cap, strict UTF-8, JSON, exactly HTTP `200`, `redirect: "error"`, no `Authorization` header), with single-flight coalescing, generation-safe invalidation, and a hard two-login budget for discovery/recovery. Token lifetime/refresh remains unverified. A `401` invalidates the lease (the request is never replayed); a `403` does not. A returned refresh token is ignored; `/auth/refresh` is not implemented. Residual risk: username/password stay resident in process/config memory (JS strings cannot be securely erased).
- **Upstream boundary safety** — `src/collectiviq/` attaches the lease bearer token only in the JSON transport (`http.ts`; the SSE path shares the same provider) and never logs it; enforces per-operation header/body deadlines, incremental response-size caps (never `response.json()` before the cap), strict UTF-8, and JSON content-type checks; and never auto-retries `create_thread`/`process_message`. Failures are the closed, content-free `UpstreamError` model (`errors.ts`) — no bodies, headers, credentials, prompts, answers, or `HTTPValidationError` `input`/`msg`/`ctx`/`detail`; retryability is **method-aware** (only idempotent-`GET` network/transient failures are retryable). The log sanitizer reduces any such error to `{ name, code }`. `process_message` treats any own `detail` property as failure.
- **Completion request boundary (Phase 1B)** — `POST /v1/chat/completions` (`src/api/chat-completions-route.ts`) sits inside the authenticated `/v1` scope, so the gateway key is checked **before** any body parsing. The request is validated/normalized to a **deeply frozen** value (`src/openai/chat-request.ts`, `messages.ts`) and never flows raw into generation; the strict surface rejects, by **own-property presence** (`Object.hasOwn`; even an empty array/`null`/explicit `undefined`, and never reading the value, invoking a getter, or counting an inherited property), the model-independent deferred features (`response_format`, `logprobs`, `audio`, image/binary parts). Message `tool_calls` and tool-role messages are rejected the same way for `toolMode: "disabled"`/`native` models, but are PARSED and normalized for a `toolMode: "emulated"` model (Phase 3, supported opt-in beta / non-default; see below). Request `tools`/`tool_choice` are instead handled by a **model-policy-aware compatibility bridge (Phase 2.1)** after model resolution: for a `toolMode: "disabled"` model it TOLERATES the tool metadata OpenCode attaches automatically (a bounded `tools` array of ≤128 entries whose entire JSON encoding is ≤2 MiB — `MAX_TOOL_SCHEMA_BYTES`, spec §21.6 — and a `tool_choice` of exactly `"auto"`/`"none"`), recording only the NAME. A definition is never semantically interpreted, retained, serialized into the prompt, forwarded, logged, reflected, persisted, or included in an error; it is traversed ONLY through data-property descriptors for a bounded, iterative (cycle-/depth-guarded) JSON-shape and byte accounting (`getOwnPropertyDescriptor`/`Reflect.ownKeys`, no `[[Get]]`), so submitted accessors and executable hooks (getters, `toJSON`, iterators) are never invoked and a descriptor/proxy failure fails closed. For a disabled model it rejects (stable `unsupported_parameter` `400`) `required`/named `tool_choice`; a non-array, over-count, or over-budget `tools`; an accessor, cycle, sparse/exotic/over-deep structure, or unsupported value anywhere; and any tool metadata against a `native` model (not implemented) — in this disabled-mode bridge no tool definition reaches the prompt/upstream/logs/storage/response and no tool call is emitted. An `emulated` model (Phase 3, supported opt-in beta / non-default) instead normalizes and retains the tool policy, serializes the validated schemas into the upstream prompt (never logged/retained), consumes `parallel_tool_calls` (non-boolean rejected), and can emit model-proposed calls — which the gateway never executes; `native` mode stays unimplemented. `stream` is normalized to a boolean (absent/`false` → JSON, exactly `true` → synthetic SSE, every other value → the same content-free `400`). The route error boundary **fails closed** on trusted request **provenance**, not on the shape of the thrown value: a value is classified to `400`/`413` only when it arose in Fastify's parser/body-limit phase, proven by two trusted per-request markers (gateway authentication completed **and** the handler has not begun — the window in which only Fastify's parser runs). An auth/hook failure, or any thrown value once the handler has begun — **including a forged Fastify-like `code`/`statusCode` or a hostile `Proxy`** — becomes the fixed `500` with **no** property read and **no** `instanceof`/prototype trap; gateway completion errors are matched by identity (`WeakSet`), normalized upstream errors by an `isUpstreamError` identity guard (never `instanceof`), and untrusted values are never inspected or re-thrown to the framework. Capacity (`src/generation/capacity.ts`) is **process-local** (global + per-key active limits, bounded queue/queue-wait), acquired **before** the upstream thread and released on every exit path; overflow → `429` + `Retry-After: 5`. The total deadline **and cancellation** are **authoritative** in the poller (both checked before every `get_messages` and **rechecked the instant the poll settles**, so cancellation observed in-flight always wins — no late poll, no late answer, no rejection reinterpreted as a timeout) and a deadline maps to `504`; a client disconnect (detected via the response socket `close`) aborts in-flight polling, releases capacity, and sends no body; a shutdown cancellation with the client still connected maps to `503`. The fixed content-free thread-title placeholder (`New Thread`) is never derived from prompt/model/repo/file data; CollectivIQ may asynchronously derive and persist its own prompt-related thread title server-side (observed 2026-08-18), which the gateway never logs, caches, or retains — it reads it only transiently, via the OBSERVED-ONLY `getThreadTitle`/`GET /get_threads` lookup, to serve the authenticated `GET /v1/opencode/session-title` extension (a non-OpenAI extension route; the process-local correlation store keyed by `gatewayKeyId + sessionId` from the optional never-logged `X-CollectivIQ-OpenCode-Session-ID` header holds only opaque ids + the upstream thread id, never a title/prompt/answer, TTL 60 s, caps 128/32; native-title propagation adds only bounded GETs and no extra thread — OpenCode's hidden LLM title agent is disabled in the committed config; the historical 2026-08-21 sequence was that the plugin entry module never loaded (its bare-function default was rejected by OpenCode's legacy export scan with `Plugin export is not a function`, so no header/correlation/poll/rename ran) and, after that loader fix, the poller resolved its key only from an absent `COLLECTIVIQ_GATEWAY_KEY`; both are fixed — the plugin default-exports the OpenCode V1 `{ id, server }` module (the descriptor-safe flat/nested provider match is offline hardening, not the proven live cause) and reuses the resolved CollectivIQ provider `options.apiKey` (descriptor-safe; ≤8192 UTF-8 bytes; unresolved `{env:…}`/`{file:…}` rejected; used exactly; kept local to the poll and never logged/cached/stored), with `COLLECTIVIQ_GATEWAY_KEY` read only as a lazy injected fallback confined to the production wrapper; a sanitized, user-authorized 2026-08-22 live smoke observed the complete propagation path succeed for the tested local configuration (OpenCode 1.18.21) — a single-local-configuration observation, not a production/cross-account/cross-version guarantee and not a claim about which credential source was used — and no security claim here depends on propagation succeeding; the serialized prompt and answer are never logged or persisted; `usage` zeros mean unavailable, not billing. The runtime upstream-credential provider is built from **already-validated config** (`buildCredentialProviderFromConfig`; no `process.env` re-read), and construction opens no socket and performs no login. In `password` mode the runtime may re-login across the process lifetime (each attempt still bounded: single flight, single-flight coalescing, bounded transport, no internal retry, generation-safe `401` invalidation with no request replay, `403` non-invalidation); the discovery/recovery CLIs keep their hard two-login budget (`CLI_MAX_LOGINS`).
- **Bounded OpenAPI retrieval** — `scripts/openapi/fetch-openapi.ts` contacts only the fixed source URL (no caller/env URL), enforces an overall deadline with cancellation, requires a JSON content type, rejects an over-declared `Content-Length` before reading, reads incrementally and rejects past 16 MiB before buffering the whole body, and decodes strict UTF-8. Network-only; excluded from `validate`/CI.
- **Discovery tooling safety** — the opt-in staged session (`DiscoverySessionRunner` in `discovery.ts`, thin `discovery-cli.ts`) runs one bounded `baseline` session against a fixed origin (no origin/path/thread-id/run-id injection). Default is **preflight only** (validates selection, reports bounded projections/approvals, reads no credential, makes no network call); it opens no socket and reads no credentials on import. Authenticated execution needs `--execute-approved` **and** `--recovery-journal-approved`; selection/approval invariants (single non-empty/comma-free; combined 1–32 unique, **duplicates rejected**; not-found requires cleanup) are re-checked **inside the runner** before any request. Evidence is captured from the **raw** upstream body for any status via a discovery-only `observeUpstreamJson` (never exported from `index.ts`; the production adapter still discards non-2xx bodies), then immediately reduced to sanitized structure. Correlation ids (`thread_id`/`run_id`/`combined_run_id`) are extracted descriptor-only (no accessor/Proxy `get`) into **private in-memory** state and emitted only as a value-free `matched`/`not-matched`/`not-observed` comparison — capability flags are never auto-flipped. Cleanup needs `--cleanup-approved` (never automatic) and reports a truthful cumulative ledger whose `attempted`/`succeeded`/`failed`/`remaining` counts describe **HTTP DELETE outcomes only**, plus bounded value-free per-attempt summaries (`phase`/`ok`/status or null/safe `errorCode` or null/`journalPersisted` — no id/path/body/message; shared `observeThreadDeletion` in `cleanup.ts`) so a cleanup `403` is distinguishable from a timeout/network failure; each attempt carries `journalPersisted: true | false | null`, and a separate `journalPersistenceFailed` counts confirmed HTTP deletes whose journal removal failed and independently forces a non-zero baseline exit. A confirmed HTTP delete drops the thread from the in-memory ownership ledger **even when its journal removal fails** (the stale journal converges via the recovery command's exact-`404` handling). The not-found probe needs both approvals, counts its first delete as cleanup, re-deletes the **same** session-owned id (never guessed) as the observation (not counted), and on a first-delete failure retains ownership, skips the second delete, and keeps the recorded failure. Exit code follows **strict session completeness** (required stages, expected auth/validation failures, an `available_llms` observation that accepts a **structurally valid** `2xx` (top-level object with an own `llms` object holding at least one object entry; no model value inspected) **or** exactly a `403` normalized to the authentication/authorization category as an observed inventory-access restriction — still failing on `401`/`429`/`5xx`/transport/timeout/missing/malformed, a malformed `2xx` being a failed `invalid_upstream_response` observation — not-found evidence, SSE usefulness, and zero cleanup failures/remaining/`journalPersistenceFailed`). Run ids stay in memory; thread ids stay in memory except that, under `--recovery-journal-approved`, at most two are written content-free to the recovery journal for recovery. Evidence is sanitized structural capture (`structural-capture.ts`, format v2 stamped as `evidenceFormatVersion` on reports/persisted files: constant type markers only — no values, value lengths, unsafe field names, or identifiers; array length read via own data descriptor, never a `get` trap), persisted only with `--write` under the ignored `.agent/sessions/`. SSE evidence (`readSseEvidence`) rejects non-2xx before parsing, finalizes the fatal UTF-8 decoder at EOF, bounds an unterminated pending record, and distinguishes `cancelled`/`timeout`/`stream-error`. The **recovery journal** (`recovery-journal.ts`) is a private on-disk file at a fixed path under the ignored `.agent/sessions/discovery/` holding **only** a format version (1), the fixed origin, and at most two normalized thread ids (no credentials, run ids, content, statuses, or timestamps); it is written atomically (mode `0600`, `O_NOFOLLOW`, temp-then-rename) and rejects symlinks, non-regular files, wrong origin, malformed/oversized/unsupported/duplicate/over-count/empty/oversized-id input; each created id is recorded immediately and dropped after a confirmed deletion. The recovery-only `npm run contract:discovery:cleanup` command (`discovery-recovery-cli.ts`) is network-only, **excluded from `validate`/CI**, targets the fixed origin, reads ids **only** from the validated journal (no id/path/URL argument, no model variables), requires `--execute-approved`/`--cleanup-approved`/`--recovery-journal-approved`, resolves an id on an HTTP `2xx` (`resolution: "deleted"`) **or** an exact `404` (`resolution: "already_absent"`, still recorded HTTP-truthfully as `ok: false`, `status: 404`) so recovery converges across a crash between a successful delete and the journal update — every other status, transport failure, and timeout stays unresolved — drops a resolved id from the journal only after that resolved state persists durably (a persistence failure keeps the id pending), reports `{ attempted, resolved, unresolved, remaining, attempts }`, and exits non-zero when `unresolved > 0 || remaining > 0`. A single shared safe-directory helper (`ensureSafeDiscoveryDir`, used by both the sanitized report writer and the journal) creates-or-tightens the shared discovery directory to a real, private `0700`, non-symlink directory before journal initialization (tightening an existing real `0755` directory and refusing a symlink/non-directory). Four authorized baselines ran: two on 2026-08-06/07 (bearer, both failed strict completeness) and two on **2026-08-11 (`password` mode) that BOTH exited zero** with identical safe contract facts — so password `POST /login` and the core create/submit/messages shapes are now **verified-repeatable** and encoded into synthetic fixtures (no live value committed). Thread-deletion outcomes were **credential/principal-dependent** (cause not established): the password/member principal deleted its own newly created thread (`200`, repeated) while re-deleting that same just-deleted id returned `403`; the API-key principal's own-thread delete returned `403` (2026-08-07); a cross-principal recovery attempt also returned `403`. Consistent with a permission/scope check, but the provider's evaluation order is unconfirmed, so recovery's exact-`404` convergence was not exercised. Must not be run without explicit approval.

When changing any of the above, update spec section 24.1, the [upstream contract owner doc](../docs/collectiviq-upstream-contract.md), `README.md`, and `SECURITY.md` together.

## Secrets and Authentication

- The upstream credential authenticates the gateway to CollectivIQ — `COLLECTIVIQ_API_KEY` in `bearer` mode, or `COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` (exchanged at `POST /login`) in `password` mode; gateway keys authenticate clients. Never conflate or forward them, and redact all of them (plus any minted `access_token`) everywhere. Config/CLI credential errors stay value-free.
- Load secrets from environment or an approved secret manager and redact them from startup output, logs, traces, metrics, errors, tests, snapshots, commands, and fixtures.
- Production requires gateway authentication. Authentication may be disabled only for an explicitly local single-user service bound exclusively to loopback.
- Compare keys using a timing-safe strategy where practical, hash only the correlation identity needed for bounded operational metadata, and never log the presented key.
- Metrics need network isolation or independent authentication; health output must not disclose configuration values. `GET /metrics` is IMPLEMENTED, off by default, and deliberately unauthenticated when enabled (see the Phase 4C entry below) — the isolation obligation is the operator's.

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
- Treat prompt boundaries as ambiguity mitigation, not an authorization boundary. The `promptMode: "direct"` profile (spec §8.4.1) removes the protocol wrapper and all non-latest-user content — this is prompt-content minimization for an account-specific compatibility need, NOT prompt-injection prevention; the collapsed single-`prompt` trust boundary is unchanged. It is intentionally lossy (drops system/developer instructions and conversation history). Like protocol mode, the direct serialized prompt is never logged or persisted; keep content confidentiality and default no-retention identical for both modes.
- Allowlist tool names and validate exact schemas; OpenCode permission checks remain mandatory. For a `toolMode: "emulated"` model (Phase 3, supported opt-in beta — non-default and permission-gated; beta is NOT production readiness) the tool engine (`src/tools/`) descriptor-safe-copies submitted `tools` into trusted plain JSON (`safeJsonCopy` — never invokes a getter/`[[Get]]`/`toJSON`/iterator; fails closed on accessors/cycles/sparse/exotic/over-deep/non-finite/symbol/function/bigint and on the `MAX_TOOLS`/`MAX_TOOL_SCHEMA_BYTES`/`MAX_TOOL_JSON_DEPTH` bounds), compiles each JSON Schema once with a per-request Ajv instance whose dialect is selected from the schema's root `$schema` — draft-07 by default (absent `$schema`), and draft-07 or draft 2020-12 by an exact URI allowlist so OpenCode 1.18.21's draft-2020-12 built-in schemas compile while a non-string or unknown `$schema` fails closed (no coercion/defaults/property-removal, no remote `$ref`, no cross-request retention), validates arguments against the exact schema, bounds each argument by `MAX_TOOL_ARGUMENT_BYTES`, caps calls at `MAX_TOOL_CALLS_PER_RESPONSE`, and never trusts an upstream tool-call id (it always mints `call_ciq_<ULID>`). Schema validation does not make execution safe; the gateway never executes, authorizes, or simulates a tool.
- Correction to "tools are never forwarded": that holds only for a `toolMode: "disabled"` model, where tool metadata is tolerated and DISCARDED. In `toolMode: "emulated"` (opt-in beta) the validated tool schemas, prior tool arguments, and prior tool results ARE serialized into the prompt sent to CollectivIQ. Graduation to beta did NOT relax this — the warning stands unchanged. They are still never logged or retained by the gateway, content confidentiality and default no-retention are identical to text mode, and each tool-loop round creates a new upstream thread.
- Use OpenAI-style sanitized errors externally and structured bounded categories internally.
- Avoid dangerous dynamic behavior: no evaluation of generated code, no shell execution, no arbitrary module loading, and no gateway-side tools.

## Resource and Abuse Controls

Preserve configurable bounds for:

- HTTP request bodies and final prompts;
- tool count, total schema size, argument size, and calls per response;
- upstream response size;
- global/per-key active requests, queue length, and queue duration;
- the optional cross-replica per-gateway-key quota (`RATE_LIMIT_*`) and its bounded stored state and `Retry-After`;
- connect/operation/total deadlines;
- polling intervals and retry count implied by the total deadline.

Acquire capacity before upstream thread creation. Return the documented `429` plus `Retry-After` when capacity is unavailable. Metrics labels must remain bounded; never label with request, thread, user, or tool-call IDs.

## Retention and Redis

- Default mode retains no content after request completion.
- Keep only transient in-memory values needed for the active request and release references promptly.
- Redis is optional and limited to short-lived idempotency/status/final-response state, one bounded per-scope rate-limit timestamp when Phase 4B is enabled, and one bounded encrypted session-to-thread mapping when Phase 5A thread reuse is enabled. It holds no concurrency counters: capacity is process-local.
- Do not persist prompt content by default. Cached final responses require an explicit TTL, encryption-at-rest expectations, access controls, and documentation.
- Same idempotency key with a different body returns `409`; do not use a permanent prompt hash as an implicit key across trust boundaries.
- CollectivIQ-side retention/training/deletion/regional behavior is unknown until verified; do not promise zero retention end to end.

**Implementation status (Phase 4A, implemented — OPTIONAL, off by default).**
`src/idempotency/` owns every idempotency record written to Redis (since Phase 4B
it is one of exactly three features permitted to store state there, and it writes
nothing outside its own `:idem:` keyspace). Specification section
18.1 owns the normative contract; the security-relevant guarantees are:

- **Off unless configured.** A blank/absent `REDIS_URL` disables Redis entirely
  and nothing is written or read. A supplied `Idempotency-Key` without configured,
  healthy Redis fails CLOSED (`503 idempotency_unavailable` + `Retry-After: 2`)
  before any completion work — it is never silently ignored.
- **Two new secret-bearing settings.** `REDIS_URL` may embed credentials and
  `IDEMPOTENCY_ENCRYPTION_KEY` derives every idempotency subkey; both are in
  `REDACT_PATHS` and matched by `isSecretKey`, and configuration errors never
  echo either value.
- **Key derivation.** One 32-byte master key is expanded with HKDF-SHA-256 into
  three domain-separated subkeys (Redis-key/scope HMAC, body-fingerprint HMAC,
  AES-256-GCM). The Redis key is an HMAC of namespace + gateway-key scope + client
  key, so the client's raw idempotency key never reaches Redis. The gateway-key
  scope is an HMAC of the raw key, computed ONCE at authenticator construction —
  stable across replicas, independent of key ORDER, never logged or returned, and
  kept separate from the process-local capacity identity `k<index>`.
- **Cross-tenant isolation.** A cached answer is reachable only through the exact
  `(namespace, gateway-key scope, client key)` triple, and the ciphertext's
  associated data binds the record version, the storage key, and the body
  fingerprint — so a relocated, rebound, or tampered record fails authentication
  and returns `503` instead of another caller's answer.
- **What Redis holds.** Only a record version, the state
  (`reserved`/`processing`/`final`/`ambiguous`), a keyed body fingerprint, a
  random owner token, an informational expiry, and — for `final` — AES-256-GCM
  ciphertext with a fresh random 96-bit nonce. Never a prompt, request body,
  authorization value, raw gateway key, raw idempotency key, thread title, Redis
  URL, or upstream thread id. Records are strictly validated and size bounded;
  anything unparseable is treated as corrupt and fails closed.
- **Untrusted-input safety.** The body fingerprinter traverses only data-property
  descriptors — never a getter, `toJSON`, iterator, or Proxy `get` — is iterative
  and bounded in depth/nodes/bytes, and fails closed without inspecting a thrown
  value. The `Idempotency-Key` header is bounded to 1–255 bytes of visible ASCII
  and is never logged or reflected.
- **No new upstream side effect.** No `create_thread`/`process_message` retry was
  added. Any failure at or after `processing` stays `ambiguous` for the TTL rather
  than risking a duplicate completion.
- **Bounded client.** Mandatory content-free `error` listener (so Redis error text,
  which can contain the endpoint or credentials, is never logged), offline queue
  disabled, bounded connect/command deadlines, capped reconnect, and a bounded
  graceful close with force-destroy on shutdown.
- **Residual risks to state honestly.** Protection is bounded to the configured
  TTL; CollectivIQ's own POST-idempotency semantics remain unknown; a hard replica
  kill during `processing` can permit one duplicate completion once the lease
  expires; rotating the encryption key requires draining traffic and waiting at
  least one maximum TTL; and all replicas must share the same key, namespace,
  endpoint, and gateway-key set (mixed keys during a rolling deployment are
  unsupported).

**Implementation status (Phase 4B, implemented — OPTIONAL, off by default).**
`src/rate-limit/` is the second of the three features allowed to know its
state lives in Redis, and `src/redis/client.ts` is the only module that imports
node-redis. Specification section 19.1 owns the normative contract; the
security-relevant guarantees are:

- **Off unless explicitly enabled, and fail-closed when on.** With
  `RATE_LIMIT_ENABLED=false` (the default) no limiter is built, no scope is
  derived, and no Redis rate-limit operation runs. When enabled, a disconnected
  Redis, a command timeout, corrupt stored state, an unusable reply, or a limiter
  wired without a derived scope all return `503 rate_limit_unavailable` +
  `Retry-After: 2`. The gateway NEVER admits unmetered traffic to cover a
  dependency failure.
- **No new secret.** Enabling it requires `REDIS_URL` (already secret-bearing and
  redacted) and reuses the existing `IDEMPOTENCY_ENCRYPTION_KEY`; the three
  numeric settings are non-secret bounds. Configuration errors stay value-free.
- **Separate key domain.** The rate-limit HMAC subkey is expanded from the same
  master key under a DISTINCT HKDF salt and `info` label with its own domain
  tags, so it is cryptographically independent of every idempotency subkey and a
  key's two scopes are unrelated values. No code is shared with
  `src/idempotency/keyring.ts` — the length-framing helper is deliberately
  duplicated — so a change here can never re-key stored idempotency records.
  Derivation is deterministic across replicas and independent of
  `COLLECTIVIQ_GATEWAY_KEYS` ORDER.
- **What Redis holds.** One bounded decimal integer of microseconds (a
  theoretical arrival time) per scope, under `<REDIS_KEY_PREFIX>:rate:<HMAC>` —
  domain-separated from the `:idem:` keyspace. Never a raw gateway key, the
  process-local `k<index>`, an authorization value, a prompt, a request body, a
  model id, a thread id, or completion content. Neither the scope nor the storage
  key is ever logged or reflected.
- **Untrusted-state safety.** `STRLEN` is checked BEFORE the script's internal
  `GET`, so an oversized or hostile value is classified corrupt without its bytes
  ever being read; there is no direct client `GET`. Empty-but-present,
  non-integer, negative, oversized, and unparseable state all fail CLOSED — never
  reset, never silently allowed. The decision is one atomic Lua script against
  Redis's own `TIME`, never a Node clock, and limiter operations are total
  (a closed decision union, never a thrown value).
- **Content-free public errors.** The `429` and `503` bodies are fixed and never
  reveal the configured limit, the remaining quota, the scope, or the key. A
  limited request creates no idempotency claim, takes no capacity, commits no SSE
  header, registers no title correlation, and makes no upstream call.
- **Residual risks to state honestly.** Enforcement is bounded to the configured
  window; a Redis outage deliberately trades availability for correctness on the
  completion path; an evicted quota key (a `noeviction` violation) resets that
  key's allowance to a full burst undetectably; capacity accounting is still
  process-local; and all replicas must share the endpoint, key, prefix,
  gateway-key set, and `RATE_LIMIT_*` settings.

**Implementation status (Phase 5A, implemented — OPTIONAL, off by default).**
`src/thread-reuse/` owns the session-to-thread mapping, the third and last
feature permitted to write Redis state, and it writes nothing outside its own
`:reuse:` keyspace. Specification section 5.1.1 owns the normative contract; the
security-relevant guarantees are:

- **Off unless configured.** `OPENCODE_THREAD_REUSE_ENABLED=false` (the default)
  means no scope is derived and no reuse operation ever runs. Enabling it requires
  `REDIS_URL` and adds NO new secret: the four subkeys are HKDF-expanded from the
  existing `IDEMPOTENCY_ENCRYPTION_KEY` under a salt and info labels distinct from
  every Phase 4A and Phase 4B domain, with no shared code, so a change here can
  never re-key existing records.
- **This is the first upstream identifier the gateway persists, and it is
  encrypted.** The record holds only a version, a state, a random owner token, an
  integer lease deadline, and the AES-256-GCM sealed upstream thread id (fresh
  nonce per write; associated data binds the record version, the storage key, and
  an independent mapping-identity digest, so a relocated ciphertext fails
  authentication). No session id, gateway key, upstream credential, prompt,
  answer, tool schema, argument, result, model-generated content, model id, or
  origin is stored, and the key itself is an HMAC.
- **Identity binding is a privacy control, not just correctness.** The mapping
  binds the gateway-key reuse scope, the session id, the model-policy
  fingerprint, the origin, and an upstream-principal fingerprint — all
  length-framed so no boundary shift can make two identities collide. A different
  gateway key, session, policy, origin, or upstream principal can never reach
  another mapping's thread.
- **The principal fingerprint uses CONFIGURED credential material** (the bearer
  token, or the username in password mode), never the transient access token, and
  only its HMAC is ever stored or compared.
- **Fail closed, never fail open.** An unusable Redis, corrupt or ambiguous
  state, an unauthenticatable ciphertext, or a failed transition returns
  `503 thread_reuse_unavailable`; a live competing turn returns `409`. Corrupt
  state is never repaired or deleted, because deleting it would silently start a
  replacement thread. No answer is emitted before the mapping is durably recorded.
- **Residual risks to state honestly.** It is NOT production ready (the Phase 4
  controls are outstanding); upstream ordering, pagination, cleanup, and retention
  are unverified; a post-`create_thread` Redis failure can leave one blank orphan
  thread that is deliberately never guess-deleted; a hard replica kill mid-submit
  blocks that session for the 15-minute ambiguous TTL; mapping expiry never
  deletes a provider thread; an evicted mapping (a `noeviction` violation)
  silently starts a new one; and all replicas must share the endpoint, key,
  prefix, gateway-key set, upstream credentials, origin, and model configuration.

**Implementation status (Phase 4C, implemented — OPTIONAL, both OFF by
default).** `src/observability/metrics.ts`, `tracing.ts`, and the shared closed
vocabulary in `labels.ts` are the only modules that emit telemetry.
Specification sections 23.2 and 23.3 own the normative contract; the
security-relevant guarantees are:

- **Off unless explicitly enabled.** `METRICS_ENABLED=false` and
  `TRACING_ENABLED=false` (both defaults) mean no registry, no `/metrics` route
  (the endpoint returns `404`), no tracer, no exporter, no timer, no socket, and
  no per-request telemetry allocation and no call into either port (one fixed
  boolean check per call site remains). No new secret is introduced by either
  feature.
- **Cardinality IS the privacy boundary.** Every emitted label and span attribute
  is a member of a frozen vocabulary or a CONFIGURED virtual-model id, re-checked
  at write time; an unrecognized value collapses to a fixed fallback (metrics) or
  is dropped (spans). Prompts, answers, source code, file/repository paths, URLs,
  tool names/arguments/results, credentials, gateway keys and scopes, idempotency
  keys, session ids, thread ids, request ids, tool-call ids, and exception text
  have no representation in the API at all, and a value smuggled into a label
  field cannot escape the re-check. The endpoint label is always a route
  TEMPLATE, never `request.url`.
- **No exception text, ever.** A failed span carries `SpanStatusCode.ERROR` with
  NO status message plus a closed error category taken from the envelope the
  gateway itself built; `recordException` is never called and span limits forbid
  events and links outright. Error categories likewise never come from inspecting
  a thrown value.
- **No automatic instrumentation.** No auto-instrumentation package is installed,
  because it would capture full URLs, headers, and query strings — gateway keys,
  idempotency keys, session ids — into span attributes. Do not add one.
- **`/metrics` is unauthenticated when enabled.** That is a documented decision:
  a scrape credential would be a second secret to distribute and rotate, and the
  process cannot verify that its bound interface is private. Operators MUST
  isolate it (loopback, private network, or firewall). The exposition still
  discloses traffic volumes, latencies, error categories, and the configured
  virtual-model ids.
- **Tracing is outbound egress to a trust boundary.** An enabled gateway POSTs
  spans continuously to `TRACING_OTLP_ENDPOINT` and sends no exporter
  authentication header (none is configurable in this slice). Treat the collector
  as reachable only from the gateway's own network, and prefer `https://` off a
  private link. No trace header is ever propagated to CollectivIQ.
- **Credential-free, bounded OTLP endpoint.** `TRACING_OTLP_ENDPOINT` must be a
  canonical absolute lowercase http(s) URL of at most 2048 UTF-8 bytes, with a
  non-empty host, no query/fragment, an exact round-trip, a NON-ROOT path, and NO
  userinfo. The userinfo rule is what makes the no-exporter-authentication
  guarantee complete — do not relax it. Errors are a closed reason set that never
  echoes the value.
  - The bound is measured on the RAW environment value, BEFORE trimming and
    before any parse. Trimming first was a real defect: whitespace padding plus a
    short URL slipped past the limit entirely. `validateOtlpEndpoint` owns the
    whole contract and returns the canonical value, so a caller cannot
    reintroduce it by pre-trimming.
  - Redaction needs BOTH mechanisms. `REDACT_PATHS` covers only the root and one
    nesting level; arbitrary depth is covered because `isSecretKey` matches the
    exact normalized names `otlpendpoint` and `tracingotlpendpoint`. Keep that
    match EXACT — an `endpoint` substring marker would also hide operational
    fields such as `endpointCount`, `endpointLabel`, and `endpoints`.
- **No environment self-configuration AT CONSTRUCTION.** The SDK treats `OTEL_*`
  variables as a fallback for anything the caller did not set — enough to attach
  a secret-bearing exporter header, read a client-certificate file from disk at
  construction, or retune the batch processor. Every SDK object is therefore
  built with those variables temporarily removed from the environment and
  exactly restored afterwards, so an ambient `OTEL_*` value is inert. Do not
  replace that with an enumeration of override options. Equally, do NOT widen the
  claim: it covers construction-time reads by the installed SDK only, and says
  nothing about a future SDK that reads the environment lazily at export time.
- **Residual risks to state honestly.** Enabling metrics or tracing widens the
  observable surface of a deployment; a collector compromise reveals request
  timing, volumes, error categories, and model usage per environment; no
  wire-level OTLP interoperability has been verified against a live collector;
  and the observability layer has not yet been through the outstanding Phase 4
  security review or load gate.

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
