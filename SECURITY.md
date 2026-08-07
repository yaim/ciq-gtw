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

This repository is a **runnable foundation** plus an offline CollectivIQ adapter
boundary. The completion, gateway-authentication, tool, streaming, and Redis
features are not implemented, and the upstream adapter is not wired into any
request path, so those runtime controls are not yet active. The controls that
exist today are:

- **Credential separation.** `COLLECTIVIQ_API_KEY` (upstream) and
  `COLLECTIVIQ_GATEWAY_KEYS` (clients) are distinct and never conflated or
  forwarded. Both are redacted from logs.
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
- **Upstream adapter boundary (offline).** `src/collectiviq/` attaches the
  `COLLECTIVIQ_API_KEY` bearer only in the transport and never logs it; it
  enforces per-operation header/body deadlines, incremental response-size caps
  (the body is bounded before it is parsed), strict UTF-8 decoding, and JSON
  content-type checks, composes client cancellation with deadlines, and never
  auto-retries `create_thread`/`process_message`. Failures use a closed,
  content-free error model (no bodies, headers, credentials, prompts, answers,
  or `HTTPValidationError` `input`/`msg`/`ctx`/`detail`); the log sanitizer
  reduces each to `{ name, code }`. Retryability is **method-aware**: only an
  idempotent `GET` network/transient failure is marked retryable, and every
  `POST`/`DELETE` failure is non-retryable. A `process_message` 2xx body with an
  own `detail` property of any value is treated as a failure. The adapter is not
  connected to any route.
- **Bounded OpenAPI retrieval.** `scripts/openapi/fetch-openapi.ts` contacts only
  the fixed public source URL (no caller-supplied URL/env), enforces an overall
  deadline with cancellation, requires a JSON content type, rejects an
  over-declared `Content-Length` before reading, reads incrementally and rejects
  past 16 MiB before buffering the whole body, cancels the reader/response on
  overflow/timeout/decode failure, and decodes strict UTF-8. No credentials are
  sent; the command stays out of `validate`/CI.
- **Discovery tooling (opt-in; one authorized baseline run on 2026-08-06).** One
  explicitly approved authenticated `baseline` run was executed on 2026-08-06; it
  failed strict completeness (exited non-zero), its evidence is observed-once and
  sanitized (not verified), and no live capture was promoted. The staged
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
  oversized files. Authenticated execution requires `--recovery-journal-approved`
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

- No gateway authentication is enforced yet, because no authenticated endpoints
  exist. Do not expose this scaffold beyond loopback until authentication is
  implemented.
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
