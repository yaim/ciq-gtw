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

As of this writing every runtime response shape is **provisional**. Nothing has
been **observed** or **verified**: no authenticated CollectivIQ request has been
made. Phase 0 is not complete until approved live discovery replaces provisional
shapes with sanitized fixtures.

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

The full 422-path document is intentionally **not** committed. Only the nine
allowlisted operations, their transitively referenced schemas, and source
metadata are retained. Refresh with `npm run contract:openapi:refresh` (writes a
review candidate under `.agent/sessions/`) and compare the live document with
`npm run contract:openapi:check`. Both require network access and are excluded
from `validate` and CI.

## Authentication (documented)

- Security scheme `OAuth2PasswordBearer` (`type: oauth2`, `tokenUrl: /login`);
  all core and supporting operations except `/user/events` declare it.
- The gateway sends `Authorization: Bearer <COLLECTIVIQ_API_KEY>` on every
  request. The credential is never logged and never appears in errors.
- `GET /user/events` declares **no** OAuth2 requirement but documents an optional
  `Authorization` header parameter; it uses header-based bearer auth, not query
  authentication.

## Core operations

### `POST /create_thread` (documented request; provisional response)

- Content type **`application/x-www-form-urlencoded`** (documented). This
  corrects earlier text that described it as multipart.
- Fields: `thread_title` (required, string); `is_title_from_user` (default
  `false`); `project_id` (`integer | null`, optional).
- The gateway sends `thread_title=<generic title>` and
  `is_title_from_user=false`, and omits `project_id`. The title is content-free
  and never derived from prompts, repositories, filenames, or personal data.
- **Provisional** success shape: a top-level object with a `thread_id` that is a
  positive integer or a non-empty string, normalized to a string. Declared `200`
  schema is empty (`{}`).

### `POST /process_message` (documented request; provisional response)

- Content type **`multipart/form-data`** (documented).
- Fields sent by the gateway: `prompt`, `thread_id` (documented type: string),
  `selected_llms` (comma-separated), `generate_combined` (`"true"`/`"false"`,
  documented type: string, default `"true"`), and `llms_explicitly_set="true"`.
- `llms_explicitly_set` is `string | null`, default `"false"`; the gateway sets
  it to `"true"` because its configuration explicitly selects the models. **Its
  runtime effect is provisional** until live discovery confirms it.
- Documented but out-of-scope fields the gateway never sends: `files`,
  `client_timezone`, `client_location`, `clarification_origin_run_id`,
  `suppress_user_bubble`, `response_format`, `tier`.
- **Provisional** success rule: a top-level JSON object; a present `detail`
  field is a failure even on HTTP 2xx. Declared `200` schema is empty.

### `GET /get_messages` (documented request; provisional response)

- Query parameters (documented): `thread_id` (string, declared **optional**) and
  `since_id` (`string | null`, optional).
- The gateway always **requires and sends a non-empty `thread_id`** despite the
  OpenAPI document marking it optional, and **intentionally omits `since_id`** in
  this phase so full thread history is returned.
- **Provisional** success shape: a top-level object with a `messages` array.
  Each message is normalized to `{ source, content, percentUsage, createdAt, id }`.
  `source` (string) and `content` (`string | null`) map from documented sample
  fields; `percentUsage` maps from `percent_usage`. `createdAt`/`id` map from
  `created_at`/`id` and are **provisional** — the upstream key names are
  unverified and used only for the future selection policy.

## Empty / incomplete success schemas

The declared `200` response schema for **every** allowlisted operation is empty
(`{}`). The OpenAPI document therefore establishes **no** runtime response
contract. All success validation in `src/collectiviq/validation.ts` is the
gateway's own minimal, provisional contract and is labeled as such in code.

## Supporting operations (documented endpoints; NOT gateway capabilities)

These are documented in the OpenAPI snapshot but are **not** part of the
production `CollectivIQAdapter` and are used by no completion path.

| Operation | Method | Notes |
| --- | --- | --- |
| `/available_llms` | GET | Model metadata. Only a `200` is declared (no `422`). |
| `/user/events` | GET | SSE; header-based auth; optional `last_event_id`. Correlation fields unverified. |
| `/abort_run` | POST | urlencoded, required `combined_run_id`. **Cooperative**: already-running provider calls may finish, be saved, and be billed while later combination work is skipped. |
| `/thread_tokens` | GET | Required `thread_id` (**integer** here — an inconsistency with the string `thread_id` used elsewhere), plus `limit`/`offset`/`rollup`/`include`. |
| `/thread_tokens/{combined_run_id}` | GET | Path `combined_run_id` (string) + optional `include`. |
| `/delete_thread/{thread_id}` | DELETE | Path `thread_id` (string). |

Documented existence does not make any of these a gateway feature. Thread
deletion, account-wide `/user/events`, cooperative abort, and token reporting
remain out of scope until verified and deliberately adopted. **Token-inspection
(`/thread_tokens*`) and abort (`/abort_run`) discovery are currently disabled**:
they are not reachable from the discovery session or CLI, and remain so until
request-scoped correlation is safely established. Their endpoint constants are
retained only for contract completeness (`src/collectiviq/endpoints.ts`).

## Discovery session (opt-in, not run)

Live evidence is captured only through the staged discovery session
(`DiscoverySessionRunner` in `src/collectiviq/discovery.ts`) and its thin CLI
(`src/collectiviq/discovery-cli.ts`). Key properties:

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
- **Strict completeness exit code** (`exitCodeForBaseline`): non-zero when any
  required positive stage failed, the auth/validation probes did not yield their
  expected failures, requested not-found evidence was not obtained, the SSE
  evidence is invalid/incomplete, or cleanup left any `failed` or `remaining`
  owned thread. Expected auth/validation errors are not themselves failures.
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
| Request-scoped streaming | `false` | Only account-level `/user/events` is documented; correlation unverified. |
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

No live capture has been promoted into a committed fixture. When live discovery
is approved, sanitized captures replace or confirm the synthetic fixtures and the
evidence state of the affected rows moves from provisional to observed/verified.

## OpenAPI drift history

| Date (UTC) | SHA-256 (short) | Notes |
| --- | --- | --- |
| 2026-08-05 | `c66332fd` | Initial capture. 422 paths; all nine allowlisted operations present and consistent with the known facts. Confirmed: `create_thread` is urlencoded (not multipart); `process_message` includes `llms_explicitly_set`; `get_messages` documents `since_id`; all core `200` schemas empty; `thread_tokens.thread_id` is integer while other `thread_id`s are string. |

## Remaining live / provider questions

Tracked in spec section 35. The highest-priority items blocking Phase 0 exit:

1. Real success schemas and status codes for the four core endpoints.
2. Whether `process_message` is idempotent and returns a job/message identifier.
3. How to distinguish accepted work from failed work beyond `detail`.
4. Whether `get_messages` is chronological and paginates.
5. The effect of `llms_explicitly_set` and valid `selected_llms` values.
6. `/user/events` correlation fields and whether it is account-wide.
7. Maximum prompt size, rate limits, and thread retention.
8. Whether native tools / structured tool results exist.
