# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**. Do not open a public
issue, pull request, or discussion for a suspected vulnerability, and do not
include exploit details or real secrets in any public channel.

Use the repository host's private reporting mechanism (for example, GitHub's
"Report a vulnerability" / private security advisory), or another private
maintainer channel if one is provided. Include a description, affected version
or commit, and reproduction steps. We will acknowledge the report and coordinate
a fix and disclosure timeline privately.

## Supported runtime

- Node.js 24 LTS (`engines: ">=24 <25"`). Other major versions are not
  supported.
- Dependencies are pinned via `package-lock.json`. Automated dependency updates
  must pass the full validation matrix before merge.

## Security posture of this scaffold

This repository is a **runnable foundation**, the Phase 1A authenticated public
model surface, the Phase 1B non-streamed chat-completions path wired through the
CollectivIQ adapter, and Phase 2 text-only synthetic SSE streaming
(`stream: true`). Tool calling, Redis, and metrics/tracing are not implemented.
The completion path calls CollectivIQ only
when a real request is served (never during import/construction/build smoke), and
the live OpenCode/CollectivIQ smoke test is **not run** (pending separate
approval). The controls that exist today are:

- **Gateway client authentication (implemented).** Every route under `/v1/*` —
  today `GET /v1/models` and `GET /v1/models/:model` — requires
  `Authorization: Bearer <gateway-key>` matched against `COLLECTIVIQ_GATEWAY_KEYS`;
  `/healthz` and `/readyz` stay unauthenticated. The scheme is case-insensitive
  and the token is compared **exactly** (never trimmed/normalized) using a
  fixed-length comparison: configured keys are reduced to SHA-256 digests once,
  the presented token is hashed once, and the digest is compared against every
  configured digest with `node:crypto` `timingSafeEqual` **without** an early
  return on a match. Missing, malformed, empty, oversized, and incorrect
  credentials all return the same fixed OpenAI `401` envelope. Configured keys
  are bounded (≤64 keys, ≤8192 UTF-8 bytes/key; the same byte cap bounds a
  presented token before hashing). Authentication is mandatory (no disable
  switch), the gateway key is never forwarded upstream, and the header/token is
  never logged or reflected. Unexpected `/v1` failures return a fixed OpenAI
  `500` whose thrown value is never inspected or serialized.
- **Credential separation.** The upstream credentials — `COLLECTIVIQ_API_KEY`
  (bearer mode) or `COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` (the OAuth2
  password mode — login **verified-live** by the two 2026-08-11 baselines, with
  token lifetime/refresh still unverified — selected by `COLLECTIVIQ_AUTH_MODE`) —
  and the client `COLLECTIVIQ_GATEWAY_KEYS` are distinct and never conflated or
  forwarded.
  All of them are redacted from logs (including any minted `access_token`). The
  inactive mode's credentials are ignored.
- **Content-free logging by default.** Prompts, answers, request bodies, tool
  arguments/results, source, and file paths are never logged. `LOG_CONTENT=true`
  is accepted only when `ENVIRONMENT=development`, and even then this scaffold
  logs no content.
- **Sanitized configuration errors.** Validation failures report stable,
  allowlisted field names and fixed reasons only — never model ids, unknown
  field names, submitted values, model-file contents, library error text, or
  resolved filesystem paths.
- **Sanitized startup diagnostics.** An unexpected startup failure prints a
  single fixed message (`gateway failed to start (internal error)`); arbitrary
  exception text, stacks, causes, and paths are never emitted. Configuration
  failures print only the sanitized issue list above.
- **Bounded model configuration.** The model file is size-checked before and
  after reading (1 MiB cap), must be a regular file, is decoded as strict UTF-8,
  and is parsed with YAML aliases and duplicate keys rejected. Model, source,
  string-length, timeout, polling, and prompt-byte counts are all bounded, and
  blank or whitespace-padded identifiers/sources are rejected. These are
  conservative initial limits; see `.agent/docs/tech-software-spec.md`
  section 24.
- **Recursive bounded log sanitization (defense in depth).** Every log record —
  nested fields, arrays, and child-logger bindings — is recursively sanitized
  with bounded depth, property count, array length, and string length. Errors
  are reduced to a fixed name/code (no message, stack, cause, or custom
  properties), accessors are never invoked, cycles cannot throw, and Pino's
  redact paths remain as an additional guard. Content is never logged to begin
  with.
- **Loopback default.** The service binds `127.0.0.1` by default. Binding to
  `0.0.0.0` requires explicit configuration; the provided Docker Compose file
  does so only inside the container while publishing to host loopback.
- **Bounded request input.** `MAX_REQUEST_BODY_BYTES` bounds the accepted request
  body, and Fastify automatic request logging is disabled.
- **Non-root container.** The image runs as the unprivileged `node` user, is
  pinned to a base-image digest, and contains no secrets.
- **Upstream authentication (offline; dual-mode).** A shared credential provider
  (`src/collectiviq/auth.ts`) supplies a per-request lease bearer token used by
  the transport, SSE, deletion, and recovery paths, and never logs it. `bearer`
  mode uses the static `COLLECTIVIQ_API_KEY`; the `password` mode (login
  **verified-live** on 2026-08-11; token lifetime/refresh still unverified)
  performs a bounded **unauthenticated** `POST /login` (20 s deadlines,
  64 KiB cap, strict UTF-8, JSON, exactly HTTP `200`, `redirect: "error"`,
  no `Authorization` header) that mints a short-lived token held **in memory
  only**, with single-flight coalescing, generation-safe invalidation, and a hard
  two-login budget for discovery/recovery. A `401` invalidates the lease (no
  replay); a `403` does not. A refresh token, if returned, is ignored and never
  retained; `/auth/refresh` is not implemented. **Residual risk:** the username
  and password remain resident in process/config memory so a later login can run,
  and a JavaScript string's bytes cannot be deterministically erased.
- **Upstream adapter boundary (offline).** `src/collectiviq/` attaches the lease
  bearer token only in the transport and never logs it; it
  enforces per-operation header/body deadlines, incremental response-size caps
  (the body is bounded before it is parsed), strict UTF-8 decoding, and JSON
  content-type checks, composes client cancellation with deadlines, and never
  auto-retries `create_thread`/`process_message`. Failures use a closed,
  content-free error model (no bodies, headers, credentials, prompts, answers,
  or `HTTPValidationError` `input`/`msg`/`ctx`/`detail`); the log sanitizer
  reduces each to `{ name, code }`. Retryability is **method-aware**: only an
  idempotent `GET` network/transient failure is marked retryable, and every
  `POST`/`DELETE` failure is non-retryable. A `process_message` 2xx body with an
  own `detail` property of any value is treated as a failure. In Phase 1B the
  adapter is used by the completion route, but only when a real request is served
  — never during import, construction, or the build smoke test.
- **Chat-completions request path (implemented; Phase 1B).** `POST
/v1/chat/completions` sits inside the authenticated `/v1` scope, so the gateway
  key is checked **before** any body parsing or use-case work. The raw request is
  validated/normalized to a **deeply frozen** internal value and never flows into
  generation; the strict surface rejects, by **own-property presence**
  (`Object.hasOwn` — even empty/`null`/explicit `undefined`/`"auto"`/`"none"`/
  harmless values, never reading the value or an inherited property), `tools`,
  `tool_choice`, `response_format`, `logprobs`, `audio`, message `tool_calls`,
  tool-role messages, and image/binary content — all with stable, content-free
  `400`s. `stream` is normalized to a boolean: absent or exactly `false` selects
  the non-streamed JSON path, exactly `true` selects the synthetic-SSE path
  (below), and every other value is rejected with the same content-free `400`. Public errors come only from the shared owner
  (`src/openai/errors.ts`) and never contain a submitted value, prompt, answer, raw
  upstream body, exception detail, credential, or thread/request identifier. The
  route error boundary **fails closed** on trusted request **provenance**, not on
  the shape of the thrown value: a value is mapped to `400`/`413` only when it arose
  in Fastify's parser/body-limit phase, proven by trusted per-request markers
  (authentication completed **and** the handler not yet begun). An auth/hook failure,
  or any thrown value once the handler has begun — including one forging a
  Fastify-like `code`/`statusCode` or a hostile `Proxy` — becomes the fixed `500`
  with **no** property read and no `instanceof`/prototype trap (gateway completion
  errors are matched by identity via a `WeakSet`, normalized upstream errors by an
  `isUpstreamError` identity guard, and untrusted values are never inspected or
  re-thrown to the framework). The matched gateway key is exposed internally as an
  **opaque** index-based identity (`k<index>`), never the raw key, and is used only
  for per-key capacity accounting. **Process-local** capacity (global + per-key
  active limits, a bounded FIFO queue, and a bounded queue wait) is acquired
  **before** the upstream thread is created and released on every exit path
  (success, upstream failure, timeout, client disconnect, shutdown); overflow
  returns `429` + `Retry-After: 5`. Capacity does **not** span replicas. The total
  request deadline **and cancellation** are **authoritative** in the poller (both
  checked before every poll and **rechecked the instant the poll settles**, so
  cancellation seen in-flight always wins — no late poll, no late answer, and no
  rejection reinterpreted as a timeout or transport error); the deadline,
  client-disconnect detection (via the response socket `close`), and a shutdown
  signal share one abort path: the deadline maps to `504`, a client disconnect
  aborts polling/upstream work and sends no body, and a shutdown cancellation
  (client still connected) maps to `503`. The completion serializes
  the prompt with a
  content-free generic thread title (never derived from prompt/model/repo/file
  data), measures the final prompt in UTF-8 bytes against the model's
  `maximumPromptBytes` (`context_length_exceeded` when exceeded), and never logs or
  persists the prompt or answer. `usage` is reported as zeros meaning
  **unavailable** (not estimates, not billing). The runtime upstream-credential
  provider is built from already-validated config (`buildCredentialProviderFromConfig`)
  and never re-reads `process.env`; construction opens no socket and performs no
  login. **Retention:** each completion creates a **new** CollectivIQ thread, so
  prompts and answers cross into CollectivIQ-managed storage; the gateway retains
  no prompt/answer content after the request completes, but provider-side
  retention/training/deletion/regional behavior remains **unknown** (see below).
- **Synthetic SSE streaming path (implemented; Phase 2).** `stream: true` reuses
  the same authenticated, bounded orchestration; authentication, validation,
  model resolution, and prompt preparation all complete **before** any SSE header
  is committed, so a pre-header failure stays a normal content-free JSON error and
  never a half-open stream. A **successful** SSE stream intentionally exposes the
  requested answer text (as `delta.content` chunks) and the gateway-generated
  OpenAI completion metadata (the `chatcmpl_ciq_*` id, `created`, model, and
  choice index) to the **authenticated** client — that is the response. What must
  never appear in any frame is a submitted prompt outside its intended upstream
  request, a credential, a raw upstream body, an upstream thread/run id, a
  filesystem path, a stack, or an untrusted exception detail; and the answer
  content is never logged, persisted, or placed in an error, keep-alive, or other
  control record. The default no-content-logging posture is unchanged. A
  post-header failure is encoded as one **content-free** OpenAI
  error record (`data: {"error": …}`) then `data: [DONE]` — an unexpected failure
  uses the fixed internal `500` object (its thrown value is classified by identity
  only, never inspected). A shutdown emits the content-free `503`
  `service_unavailable` record + `[DONE]` **only while the SSE transport remains
  writable**; if the response is backpressured/undrainable or its terminal close
  fails, the gateway force-closes it (destroying the socket, including on a bounded
  fallback if `res.end()` never completes) to preserve the shutdown bound, so the
  stream may end **silently** — delivery of the `503` to the client is not
  guaranteed. Writes are serialized and honour Node
  backpressure; a write failure or socket close is treated as client cancellation,
  which aborts polling, releases the capacity permit, clears every keep-alive
  timer, and writes no body to a gone client. As with the non-streamed path,
  capacity is process-local, and a submitted CollectivIQ generation may continue
  upstream after a disconnect because no verified upstream cancellation endpoint
  exists.
- **Bounded OpenAPI retrieval.** `scripts/openapi/fetch-openapi.ts` contacts only
  the fixed public source URL (no caller-supplied URL/env), enforces an overall
  deadline with cancellation, requires a JSON content type, rejects an
  over-declared `Content-Length` before reading, reads incrementally and rejects
  past 16 MiB before buffering the whole body, cancels the reader/response on
  overflow/timeout/decode failure, and decodes strict UTF-8. No credentials are
  sent; the command stays out of `validate`/CI.
- **Discovery tooling (opt-in; four authorized baseline runs).** Two bearer-mode
  runs on 2026-08-06 and 2026-08-07 failed strict completeness (exited non-zero);
  two **`password`-mode** runs on **2026-08-11 both passed strict completeness
  (exited zero)** with **identical** sanitized results, making password login and
  the core create/submit/messages contract **verified-repeatable** (encoded into
  synthetic fixtures — no live value committed). Thread-deletion outcomes were
  **credential/principal-dependent** (cause not established): the password/member
  principal deleted its own newly created thread (`200`, repeated) while
  re-deleting that same just-deleted id returned `403`; the API-key principal's
  own-thread delete returned `403` (2026-08-07); a cross-principal recovery
  attempt also returned `403`. This is consistent with a permission/scope check,
  but the provider's evaluation order is unconfirmed. Thread identifiers are
  never exposed in reports/logs. The staged
  live-discovery session/CLI
  runs one bounded `baseline` session against a **fixed** destination origin
  (no origin/path/thread-id/run-id injection). Its **default is preflight only**:
  it validates the model selection and reports bounded projected counts and
  approval flags **without reading the credential or making any network
  request**; it opens no socket and reads no credentials on import. Authenticated
  execution requires `--execute-approved` **and** `--recovery-journal-approved`;
  selection and approval invariants
  (single non-empty/comma-free; combined 1–32 unique, duplicates rejected;
  not-found requires cleanup) are re-checked inside the runner before any request.
  Evidence is captured from the **raw** upstream body for any status via a
  discovery-only observation path (never exported from `index.ts`; the production
  adapter still discards non-2xx bodies), then reduced to sanitized structure, so
  run ids and error shapes survive without their values. Correlation ids
  (`thread_id`/`run_id`/`combined_run_id`) are extracted descriptor-only into
  private in-memory state and emitted only as a value-free
  `matched`/`not-matched`/`not-observed` comparison; capability flags are never
  auto-flipped. Deleting session-owned threads requires `--cleanup-approved`
  (never automatic); cleanup reports a truthful cumulative
  `attempted`/`succeeded`/`failed`/`remaining` ledger (HTTP DELETE outcomes only)
  plus `journalPersistenceFailed` and a bounded list of value-free per-attempt
  summaries (`phase`, `ok`, HTTP status or null, safe `errorCode` or null, and
  `journalPersisted` — `true`/`false`/`null` — no id, path, body, or message;
  shared `observeThreadDeletion` in `cleanup.ts`) so a cleanup `403` is
  distinguishable from a timeout/network failure. A thread is dropped from the
  in-memory ownership ledger on a confirmed HTTP DELETE even if its journal
  removal then fails (`journalPersisted: false`), so a fault cannot resurrect it;
  the stale journal converges through recovery's exact-`404` handling, and any
  such failure (`journalPersistenceFailed > 0`) is a non-zero-exit condition. The
  exit code follows strict session completeness. Strict completeness requires an `available_llms` observation and
  accepts either a **structurally valid** `2xx` success (top level a non-null,
  non-array object with an own `llms` object holding at least one object entry; no
  model value inspected or retained; extra properties allowed) or exactly a `403`
  normalized to the authentication/authorization category (an observed
  inventory-access restriction), still failing on `401`/`429`/`5xx`/transport/
  timeout/missing/malformed; a malformed `2xx` body is a **failed** observation
  (`invalid_upstream_response`), never a silent success. The not-found probe
  requires
  `--observe-not-found-approved` **and** `--cleanup-approved`, counts its first
  delete as cleanup, re-deletes the **same** already-deleted session-owned id
  (never a guessed id) as the uncounted observation, and on a first-delete failure
  retains ownership, skips the second delete, and keeps the recorded failure.
  Token-inspection and abort discovery are disabled. Run identifiers stay in
  memory and are never printed or persisted; thread identifiers stay in memory
  except that, when `--recovery-journal-approved` is set, at most two are written
  content-free to the recovery journal (below) purely for recovery. Observations
  are sanitized
  structural captures (constant type markers only — no values, value lengths,
  unsafe field names, or identifiers; array length read via an own data
  descriptor, never a `get` trap) stamped with an `evidenceFormatVersion`;
  SSE evidence rejects non-2xx before parsing, finalizes the fatal UTF-8 decoder
  at EOF, bounds unterminated records, and distinguishes cancellation/timeout/
  stream-error. `--write` controls ONLY whether the sanitized baseline evidence
  report is persisted (under the untracked `.agent/sessions/`); an approved
  authenticated run maintains the separate ID-only recovery journal (below)
  independently of `--write`, and preflight performs no journal I/O. It must not
  be run without explicit approval.
- **Recovery journal (`recovery-journal.ts`).** A private on-disk journal at a
  fixed path under the ignored `.agent/sessions/discovery/`
  (`recovery-journal.json`), separate from the sanitized `baseline.json`, records
  **only** a format version (1), the fixed destination origin, and at most two
  normalized thread ids — never credentials, model ids, run ids, prompts, titles,
  answers, bodies, statuses, timestamps, or account/user data. It is written
  atomically (private temp file, mode `0600`, `O_NOFOLLOW`, then rename) and
  rejects symlinks, non-regular files, wrong origin, malformed JSON, unsupported
  version, duplicate ids, more than two ids, empty ids, oversized ids, and
  oversized files. A single shared safe-directory helper
  (`ensureSafeDiscoveryDir`), used by both the sanitized report writer and the
  journal, creates-or-tightens the shared directory to a real, private `0700`,
  non-symlink directory before journal initialization — tightening an existing
  real `0755` directory to `0700` and refusing a symlink or non-directory — so an
  approved run recovers cleanly from a directory left loose by a prior report
  while read/delete paths still require `0700`. Authenticated execution requires `--recovery-journal-approved`
  (re-checked in the runner) and verifies writability before the first request;
  each created thread id is recorded immediately and dropped only after a
  confirmed deletion; the journal is removed when empty and retains ids if cleanup
  fails. Preflight does no journal I/O. The journal is maintained **independently
  of `--write`** — `--write` governs only the sanitized baseline evidence report,
  while an authenticated approved run always maintains the id-only journal — and
  its sink transitions are **durable-first** (on-disk state persisted before the
  in-memory ledger changes). If a created thread's id cannot be durably persisted
  (`recordCreated` fails), the run **aborts immediately** with no further upstream
  request; the created thread is placed in the ownership ledger **before** the
  journal write so cleanup is still attempted, the result is a content-free
  `aborted: "journal-persistence-failed"`, and the exit is non-zero. A journal
  **initialization** failure (before any create) makes zero network calls. No
  filesystem path, id, or raw error is ever serialized.
- **Recovery-only cleanup command (`discovery-recovery-cli.ts`).**
  `npm run contract:discovery:cleanup` is network-only, opt-in, and **excluded
  from `validate`/CI**. It targets the fixed origin only, reads thread ids **only**
  from the validated recovery journal (at most two), takes no id/path/URL argument,
  reads no model-selection variables, and requires `--execute-approved`,
  `--cleanup-approved`, and `--recovery-journal-approved`. It refuses a
  missing/empty/invalid journal, deletes through the same percent-encoded fixed
  delete path and bounded transport, and resolves a journal-owned id on a `2xx`
  (`deleted`) **or** an exact `404` (`already_absent`) so recovery converges
  across a crash between a successful delete and the journal update; every other
  status (e.g. `403`, `410`), transport failure, or timeout stays unresolved for a
  later run. A `404` is still recorded in per-attempt diagnostics as a non-`2xx`
  response (`ok: false`, `status: 404`), never relabeled as HTTP success; the
  recovery classification is separate (`resolved` with `resolution`
  `"deleted" | "already_absent"`). An id is removed from the journal only after
  the resolved state is durably persisted; if that write fails the id stays
  pending and the run exits non-zero. The value-free recovery report is
  `{ attempted, resolved, unresolved, remaining, attempts: [{ ok, status,
errorCode, resolved, resolution, persisted }] }` (no longer `succeeded`/
  `failed`), and it exits non-zero when `unresolved > 0 || remaining > 0`. It must
  not be run without explicit approval.

## Current limitations

- `POST /v1/chat/completions` is implemented but the end-to-end live
  OpenCode/CollectivIQ smoke test is **not run** (pending separate approval). No
  live CollectivIQ request is made from this repository except when a real
  completion request is served against a configured upstream credential.
- Tool calling and Redis/idempotency are not implemented; those requests are
  rejected or unavailable rather than silently degraded. Streaming
  (`stream: true`/SSE) is implemented as text-only buffered synthetic SSE, not
  true upstream streaming, and the live streaming smoke test is not run.
- Capacity/backpressure is **process-local** — it does not coordinate across
  replicas. Cross-replica limits require shared state that does not yet exist.
- No metrics endpoint is exposed.
- Readiness reports a simple ready/not-ready state; it does not yet probe
  dependencies.

## Remote deployment

Hosted or non-loopback deployment additionally requires: TLS termination,
enforced authentication, private-network or firewall controls, per-client rate
limits, protected logs and metrics, and managed secret storage. See
`.agent/docs/tech-software-spec.md` section 31.2.

## CollectivIQ retention

CollectivIQ-side data retention, training, deletion, and regional behavior are
**unverified**. This project does not claim end-to-end zero retention. Do not
assume upstream content is discarded.

## Secrets

Never commit real secrets. All example values in `.env.example`,
`config/models.example.yaml`, tests, and documentation are unmistakably fake
placeholders.
