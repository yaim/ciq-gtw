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
CollectivIQ adapter, Phase 2 text-only synthetic SSE streaming
(`stream: true`), and Phase 3 **experimental, opt-in, non-default** emulated tool
calling (implemented offline; its section-30 release gates are NOT met — two
authorized live evaluator campaigns have been executed: a **partial 2026-08-24
campaign** that established no gate and a **completed 2026-08-26 campaign**
across two resumable execution segments that scored the full corpus but failed
tool-name accuracy at 254/260 (97.7%) vs the 98% minimum; a diagnostic-emitting
live rerun (report v3 / checkpoint v2) is approval-gated and unrun, and no
prompt/parser/selection/threshold change is authorized until it produces
evidence). Redis, metrics/tracing, true upstream streaming, and
native tool mode are not implemented. The completion path calls CollectivIQ only
when a real request is served (never during import/construction/build smoke). A
user-observed, sanitized live OpenCode/CollectivIQ foreground **transport** smoke
was reported on **2026-08-15** (protocol-mode `collectiviq-claude` response
returned, synthetic streaming completed, tool metadata accepted and discarded with
no tool call); the returned response objected to the gateway's serialized protocol
wrapper on that path. The `collectiviq-claude-direct` profile (`promptMode:
direct`, latest-user-only prompt) is the mitigation and the committed default, and
a sanitized 2026-08-18 smoke **observed it resolve that refusal for the tested
account** (a natural coding request returned a relevant answer, streaming
completed, and the hidden `collectiviq-fast` title request returned a valid title
on its first attempt). That is a sanitized single-account observation, **not**
production readiness or a repeatable upstream guarantee: a combined answer, a
long-running streaming duration, and general non-Claude routing remain unverified,
and any further live run is approval-gated. The controls that exist today are:

- **Gateway client authentication (implemented).** Every route under `/v1/*` —
  today `GET /v1/models`, `GET /v1/models/:model`, the implemented
  `POST /v1/chat/completions` (non-streamed JSON and synthetic SSE), and the
  `GET /v1/opencode/session-title` extension (an authenticated CollectivIQ/OpenCode
  extension, **not** part of the OpenAI compatibility profile; spec section 9.5) —
  requires
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
  (`Object.hasOwn` — even empty/`null`/explicit `undefined`/harmless values,
  never reading the value or an inherited property), `response_format`,
  `logprobs`, `audio`, and image/binary content — all with stable, content-free
  `400`s that are model-independent. Message `tool_calls` and tool-role messages
  are rejected the same way for `disabled`/`native` models, but are PARSED and
  normalized into validated prior tool-call history for a `toolMode: "emulated"`
  model (see below). Request `tools`/`tool_choice` are handled by a **model-policy-aware
  compatibility bridge (Phase 2.1)** that accepts bounded metadata ONLY for a
  `toolMode: "disabled"` model: an own `tools` JSON array of at most **128**
  entries whose entire JSON encoding is at most the **2 MiB**
  `MAX_TOOL_SCHEMA_BYTES` aggregate (spec §21.6), and a `tool_choice` of exactly
  `"auto"` or `"none"` — recording only the parameter NAME. Structural and byte
  accounting is done through data-property descriptors only
  (`getOwnPropertyDescriptor`/`Reflect.ownKeys`, never `[[Get]]`), so submitted
  accessors, `toJSON`, iterators, and other executable hooks are never invoked;
  accessors, cycles, sparse/exotic/over-deep structures, unsupported values, an
  over-count/over-budget collection, `required`/named `tool_choice`, and any tool
  metadata against a `native` model all fail closed with the stable
  content-free `unsupported_parameter` `400`. For a `disabled` model a tool
  definition never reaches the prompt, upstream, logs, persistence, errors, or a
  tool-call response, and no tool call is emitted or executed. **EXPERIMENTAL
  emulated tool mode (Phase 3, opt-in, non-default):** a `toolMode: "emulated"`
  model instead NORMALIZES and RETAINS the tool policy — a descriptor-safe bounded
  deep copy of the definitions into trusted plain JSON (never invoking a getter/
  `[[Get]]`/`toJSON`/iterator; failing closed on accessors/cycles/sparse/exotic/
  over-deep/non-finite/symbol/function/bigint and the byte/depth bounds), a
  per-request Ajv validator whose dialect is chosen from the schema's root
  `$schema` (draft-07 by default; draft-07 or draft 2020-12 by an exact URI
  allowlist so OpenCode 1.18.21's draft-2020-12 built-in schemas validate, while a
  non-string or unknown `$schema` fails closed; no coercion/defaults/property-
  removal, no remote `$ref`, no cross-request retention), argument/count/depth
  bounds, and
  gateway-minted `call_ciq_<ULID>` ids (upstream ids are never trusted). In this
  mode the validated tool schemas, prior tool arguments, and tool results **ARE**
  serialized into the prompt sent to CollectivIQ (they are still never logged or
  retained); each tool-loop round creates a new upstream thread; and the gateway
  returns model-**proposed** calls but never executes, authorizes, or simulates a
  tool (OpenCode owns permissions and execution). Emulated mode is experimental:
  its section-30 release gates are **not met**. The approval-gated live evaluator
  (`npm run eval:tools`) has been run in two authorized campaigns. The **partial
  2026-08-24 campaign** attempted 149 rounds (all 149 created threads confirmed
  deleted; single-round snapshots at 99.3%; the multi-step scenarios never
  reached and so unmeasured, not a measured 0%) but aborted operationally and
  established no gate. The **completed 2026-08-26 campaign** ran across two
  resumable execution segments and scored the full corpus (200/200 single-round
  cases, 20/20 multi-step scenarios, 281/281 created threads deleted, zero
  cleanup or journal failures, checkpoint finalized): **tool-name accuracy
  failed** at 254/260 (97.7%) vs the 98% / 255/260 minimum; seven other gates
  passed; overall `passed: false`. The evaluator was hardened offline before the
  2026-08-26 campaign (content-free resume checkpoint gated behind
  `--resume-approved`, versioned value-free output union, four-state gate
  status), and the on-disk report and checkpoint payloads are now bounded and
  value-free by construction: **report v3** adds a `diagnostics.failures`
  collection (only on `executed` reports) whose entries carry only ordinals, a
  closed `choiceKind` union, and a closed nine-member `EvalFailureReason` union
  — never prompts, answers, arguments, schemas, tool names, model names, IDs,
  credentials, titles, bodies, URLs, timestamps, or exception text; **checkpoint
  v2** persists diagnostics as a compact `[caseOrdinal, roundOrdinal,
reasonCode]` ledger with fixed integer reason codes and rejects v1 checkpoints
  with no migration path. `MAX_CHECKPOINT_BYTES` stays at 8192; the worst valid
  280-entry ledger fits comfortably in compact JSON. The resume checkpoint is
  semantically validated against the real evaluation plan before any credential
  read or network I/O — including every diagnostic entry (case ordinal within
  `nextCaseIndex`, round ordinal within that corpus case, reason code in the
  fixed set, reason structurally compatible with whether the referenced round
  expects a tool or final text) — so a forged or inconsistent checkpoint —
  including any "complete + passing, zero-attempt" claim — cannot grant a
  zero-network pass; a non-resumable abort writes a durable value-free `blocked`
  tombstone that a resume run rejects until an operator deliberately archives or
  removes it (no automatic destructive restart), and checkpoint files are
  accepted only at an exact `0600` mode with symlink-safe ancestry. A
  **diagnostic-emitting live rerun** is approval-gated and unrun; no
  prompt/parser/selection/threshold change is authorized until it produces
  evidence. `native` tool mode remains unimplemented.
  `stream` is normalized to a boolean: absent or exactly `false` selects
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
  content-free fixed thread-title placeholder (`New Thread`, never derived
  from prompt/model/repo/file/user/response data — and distinct from any OpenCode
  session title, which is never forwarded into `create_thread`), measures the
  final SELECTED prompt in UTF-8 bytes against the model's
  `maximumPromptBytes` (`context_length_exceeded` when exceeded), and never logs or
  persists the prompt or answer. Prompt serialization is chosen from the resolved
  model's normalized `promptMode` (never a model-id string): `protocol` (default)
  serializes the full ordered conversation in the versioned envelope, while `direct`
  submits ONLY the latest user message content — dropping the protocol wrapper,
  system/developer instructions, and conversation history. Direct mode is
  prompt-content minimization for an account-specific compatibility need, **not**
  prompt-injection prevention (the collapsed single-`prompt` trust boundary is
  unchanged), and it enforces the byte limit against only that selected content; a
  `direct` request with no user message is rejected with a fixed content-free `400`
  before any upstream call. Both modes keep the same no-content-logging /
  no-retention posture. `usage` is reported as zeros meaning
  **unavailable** (not estimates, not billing). The runtime upstream-credential
  provider is built from already-validated config (`buildCredentialProviderFromConfig`)
  and never re-reads `process.env`; construction opens no socket and performs no
  login. **Retention:** each completion creates a **new** CollectivIQ thread, so
  prompts and answers cross into CollectivIQ-managed storage; the gateway retains
  no prompt/answer content after the request completes, but provider-side
  retention/training/deletion/regional behavior remains **unknown** (see below).
  A sanitized 2026-08-18 observation additionally found that CollectivIQ may
  **asynchronously derive and persist a prompt-related thread title** server-side
  after `process_message` (triggered by the fixed `New Thread` placeholder). That
  provider-generated native title is prompt-derived provider metadata —
  **additional provider-side metadata/retention exposure** beyond the prompt/answer,
  outside the gateway's control. The gateway never derives, logs, caches, or retains
  it; it reads it only **transiently** — via the observed-only `get_threads` lookup
  — to serve the OpenCode session-title extension (`GET /v1/opencode/session-title`,
  spec section 9.5), and production consumes **no** account-wide `/user/events`.
  **Correlation retention:** when a valid `X-CollectivIQ-OpenCode-Session-ID`
  accompanies a successful completion, a process-local correlation store retains
  **only** the two opaque ids (gateway-key identity + session id) and the upstream
  thread id for a bounded TTL (60 s) under per-key (32) and global (128) caps —
  **never** a title, prompt, or answer — and a restart safely discards it. The
  session id is never logged, hashed into logs, or reflected in an error.
  The gateway performs exactly **one** `create_thread` per completion request. The
  OpenCode hidden LLM `title` agent is **disabled** in the committed
  configuration, so it creates **no** separate title thread; a first foreground
  message therefore creates exactly one upstream thread and native-title
  propagation (via the plugin polling the extension endpoint) adds only bounded
  `GET` requests, no additional thread. (The earlier "two or more upstream threads
  per session" behavior no longer applies to the committed configuration.) No
  security posture claim depends on native-title propagation succeeding: a
  sanitized 2026-08-21 smoke found the plugin propagation path non-functional
  because the plugin **entry module never loaded** — its bare-function default fell
  through to OpenCode's legacy export scan, which rejected a non-function runtime
  export with `Plugin export is not a function`, so no header/correlation/poll/
  rename behavior ran (the smoke did prove one foreground thread, no hidden title
  thread, and provider-native title generation). It was remediated by
  default-exporting the OpenCode V1 `{ id, server }` plugin module; a sanitized,
  user-authorized 2026-08-22 live smoke then observed the complete propagation path
  succeed for the tested local configuration (OpenCode 1.18.21) — a single-local-
  configuration observation, not a production/cross-account/cross-version guarantee
  and not a claim about which credential source was exercised. The descriptor-safe
  flat/nested provider matching is offline hardening, not the proven live cause. The
  bounded-`GET`, one-thread, and correlation-store bounds above hold regardless.
  **Plugin credential handling:** the plugin authenticates its lookup by reusing the
  resolved CollectivIQ provider credential (`provider.collectiviq.options.apiKey`
  from OpenCode's merged config), with `COLLECTIVIQ_GATEWAY_KEY` read only as a lazy
  injected fallback confined to the production wrapper; the key is resolved
  descriptor-safely (own data properties only — no getter invoked), accepted only as a
  non-empty string ≤ 8192 UTF-8 bytes with no unresolved `{env:…}`/`{file:…}`
  placeholder, used exactly (never trimmed), and kept transient — local to the
  in-flight lookup and **never** logged, reflected, cached, or stored in
  singleton/session/correlation state. An earlier post-loader-fix trace showed the
  poller reaching this step but stopping because the earlier environment-only key
  source was absent; reusing the provider-config credential fixed that, and the
  provider-config/environment precedence and lazy fallback are hermetically verified.
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

- `POST /v1/chat/completions` is implemented; a basic live foreground
  **transport** smoke was observed on **2026-08-15** (protocol-mode
  `collectiviq-claude` response returned, streaming completed, tool metadata
  discarded, no tool call), on which the returned response objected to the
  gateway's serialized protocol wrapper. A sanitized 2026-08-18 smoke **observed**
  the committed-default `collectiviq-claude-direct` profile resolve that refusal for
  the tested account (a natural coding request returned a relevant, correct answer;
  streaming completed; the hidden `collectiviq-fast` title request returned a valid
  title on its first attempt). This is a single-account observation, **not**
  production readiness or a repeatable guarantee: a combined answer, a long-running
  streaming duration, and general non-Claude routing remain **not** verified, and
  any further live run is approval-gated. No live CollectivIQ request is made from
  this repository except when a real completion request is served against a
  configured upstream credential.
- Emulated tool calling is implemented but **experimental, opt-in, and
  non-default** (only the `collectiviq-claude-tools` model / `collectiviq-tools-experimental`
  agent enable it; every committed default stays `toolMode: "disabled"` and
  discards tool metadata). `native` tool mode and Redis/idempotency are not
  implemented; those requests are rejected or unavailable rather than silently
  degraded. Streaming
  (`stream: true`/SSE) is implemented as text-only buffered synthetic SSE, not
  true upstream streaming; a basic live stream completed on 2026-08-15, but the
  long-running / keep-alive streaming smoke test is not run.
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
