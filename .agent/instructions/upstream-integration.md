# CollectivIQ Upstream Integration

## Scope

Read `.agent/docs/tech-software-spec.md` sections 2.1, 8.5–8.7, 10, 13, 16–17, 20, 29.2, 32 phase 0, and 35 before modifying CollectivIQ behavior.

The supplied upstream contract is provisional. Observed facts belong in sanitized contract fixtures and the specification or a later dedicated upstream contract document, not as undocumented assumptions in code.

## Grounded Contract and Tooling

The upstream contract is now grounded in the published OpenAPI document. Read
[`.agent/docs/collectiviq-upstream-contract.md`](../docs/collectiviq-upstream-contract.md)
first; it is the owner document for source metadata, evidence states, request
contracts, the capability matrix, and open questions.

- The filtered, deterministic snapshot lives at
  `contract/collectiviq/openapi-filtered.json` (ten allowlisted operations —
  including `POST /login` for the OAuth2 password mode — plus transitively
  referenced schemas; the full 422-path document is never committed).
- `npm run contract:openapi:refresh` writes a review candidate under
  `.agent/sessions/`; `npm run contract:openapi:check` reports drift against the
  committed snapshot. Both need network access and are excluded from `validate`.
- The production adapter is `src/collectiviq/` (`adapter.ts`, `http.ts`,
  `validation.ts`, `errors.ts`, `endpoints.ts`, `types.ts`). The three core
  request encodings are factored into shared pure builders (`requests.ts`) used by
  both the production adapter and discovery, so methods/paths/query/bodies match.
  The opt-in **staged discovery session** (`DiscoverySessionRunner` in
  `discovery.ts`, thin `discovery-cli.ts`, `structural-capture.ts`,
  `correlation.ts`, `readSseEvidence`) runs a single bounded `baseline` session
  against a fixed origin, is preflight-only by default, and is never part of the
  production adapter interface. It captures evidence from the **raw** upstream
  body for any status via a discovery-only observation path
  (`observeUpstreamJson`, not exported from `index.ts`) — so run ids and error
  shapes survive as sanitized structure — while the production adapter still
  discards non-2xx bodies. Raw capture does **not** replace validation: a required
  2xx create/submit/messages stage succeeds only after the same production
  normalizer accepts it (a malformed 2xx body is a failed observation with the raw
  structure retained and only a safe error code), and only the normalized
  top-level thread id advances the workflow, takes ownership, or is deleted. SSE
  correlation targets the combined-model request immediately preceding the stream
  (normalized combined thread id + the validated combined submission's run
  candidates only; single-stage ids are never mixed in). The run dimension
  compares observed SSE run values against the **set of all usable run candidates**
  (`run_id` and `combined_run_id`, deduped) and is `matched` when **any** appears.
  Correlation ids
  (`thread_id`/`run_id`/`combined_run_id`) are held privately in memory and emitted
  only as a value-free `matched`/`not-matched`/`not-observed` comparison. Runner
  selection is canonicalized (trimmed, comma-in-element and post-trim duplicates
  rejected) before any fetch, without mutating the caller's array. Cleanup is a
  truthful ledger
  (`attempted`/`succeeded`/`failed`/`remaining`, HTTP DELETE outcomes only) plus
  `journalPersistenceFailed` and bounded value-free per-attempt summaries
  (`phase`/`ok`/status/`errorCode`/`journalPersisted` — `true`/`false`/`null`;
  shared `observeThreadDeletion` in `cleanup.ts`) so a cleanup `403` is
  distinguishable from a timeout/network failure. A confirmed HTTP DELETE drops
  the thread from the in-memory ledger even if its journal removal fails (stale
  journal converges via recovery's exact-`404`); `journalPersistenceFailed > 0` is
  a non-zero-exit condition. The not-found probe re-deletes
  the same session-owned id and, on a first-delete failure, retains ownership and
  records the failure. Exit code follows strict session completeness, which now
  requires an `available_llms` observation and accepts either a **structurally
  valid** `2xx` (top level a non-null, non-array object with an own `llms` object
  holding at least one object entry; no model value inspected; extra properties
  allowed) or exactly a `403` (observed inventory-access restriction), still
  failing on `401`/`429`/`5xx`/transport/timeout/missing/malformed — a malformed
  `2xx` body is a **failed** observation (`invalid_upstream_response`) that drives
  a non-zero exit. If a created thread's id cannot be durably persisted to the
  recovery journal, the run **aborts immediately** (no further upstream request),
  still attempts cleanup for the already-owned thread, and exits non-zero with a
  content-free `aborted: "journal-persistence-failed"` result. Authenticated
  execution additionally requires `--recovery-journal-approved`, which enables a
  content-free recovery journal (`recovery-journal.ts`, ignored
  `.agent/sessions/discovery/`: version + fixed origin + at most two thread ids
  only) that survives a leak and is maintained **independently of `--write`**
  (durable-first sink transitions); the recovery-only
  `npm run contract:discovery:cleanup` command (`discovery-recovery-cli.ts`,
  network-only, **never in `validate`/CI**) deletes only journal-listed ids under
  all three approvals, resolves an id on a `2xx` (`deleted`) **or** an exact `404`
  (`already_absent`) so recovery converges after a crash between a successful
  delete and the journal update (other statuses/transport/timeout stay
  unresolved), and reports
  `{ attempted, resolved, unresolved, remaining, attempts }` (no longer
  `succeeded`/`failed`), exiting non-zero when `unresolved > 0 || remaining > 0`.
  Token-inspection and abort discovery are disabled. Four authorized baselines
  ran: two on 2026-08-06/07 in **bearer** mode (both failed strict completeness),
  and two on **2026-08-11 in `password` mode that BOTH exited zero** with
  **identical safe contract facts** — so the core create/submit/messages contract
  and password `POST /login` are now **verified-repeatable** and encoded into
  synthetic fixtures (`processAccepted202`, `messagesCreateTime`). Thread-deletion
  outcomes were **credential/principal-dependent** (cause not established): the
  password/member principal deleted its own newly created thread (`200`, repeated)
  while re-deleting that same just-deleted id returned `403` (repeated); the
  API-key principal's own-thread delete returned `403` (2026-08-07); and a
  cross-principal recovery attempt also returned `403`. This is consistent with a
  permission/scope check, but the provider's evaluation order is unconfirmed, so
  recovery's exact-`404` convergence was not exercised. None of it is wired into a
  public completion path yet.
- Error retryability is **method-aware**: only an idempotent `GET` network or
  selected-transient (502/503/504) failure is retryable; every `POST`/`DELETE`
  failure is non-retryable. The method is carried through the error factory. A
  `process_message` 2xx body with an own `detail` property (any value) is a
  failure.
- Confirmed encoding facts: `POST /create_thread` is
  `application/x-www-form-urlencoded` (fields `thread_title`,
  `is_title_from_user=false`); `POST /process_message` is `multipart/form-data`
  and includes `llms_explicitly_set=true`; `GET /get_messages` documents an
  optional `since_id` that the gateway omits and an optional `thread_id` that the
  gateway always requires. Every declared `200` success schema is empty, so
  response shapes were provisional until the two **verified-repeatable** 2026-08-11
  password baselines confirmed the core create/submit/messages shapes. The
  `get_messages` metadata mapping was **reconciled**: `validation.ts` now maps
  `createdAt` from the observed **`create_time`** (keeping `created_at` as a
  fallback; `updated_at` is not mapped). Mappings whose observed field NAME stays
  masked by structural capture (notably message `content`) remain provisional.

## Adapter Boundary

Only the CollectivIQ adapter may know:

- endpoint paths and query/form field names;
- dual-mode credential-provider mechanics (`auth.ts`): the static-bearer and
  OAuth2 password-exchange (`POST /login`) providers, the per-request lease, and
  its `401`-invalidation / no-replay / `403`-non-invalidation behaviour;
- multipart request encoding;
- raw status and error bodies;
- provisional response JSON shapes;
- upstream response-size and operation-timeout enforcement.

All response bodies are untrusted. Validate them at runtime, ignore unexpected fields, and return normalized typed results or normalized error categories.

Never expose or log the authorization header, the upstream credentials (API key, username, password), any minted `access_token`/refresh token, the serialized prompt, raw production body, answer content, or other content-bearing diagnostic data.

## Per-Completion Workflow

1. Create a thread with a generic request title containing no prompt, filename, repository, or personal data.
2. Validate and normalize a positive integer or non-empty string `thread_id` to an internal string.
3. Submit the complete serialized prompt and configured model/source policy once.
4. Treat an HTTP success as insufficient: inspect the body for documented/provisional error objects.
5. Poll by encoded thread ID until the configured source has non-empty content or a terminal timeout/cancellation/error occurs.
6. When duplicate source messages exist, select by latest explicit timestamp, then highest sortable ID, then last array occurrence.

Do not assume upstream message ordering, a completion state not evidenced by the contract, or exact meaning for `percent_usage`.

## Timeouts, Retry, and Cancellation

- Apply separate connect, create, submit, poll-request, total-upstream, and client-request deadlines.
- Compose deadline and client-disconnect cancellation through `AbortSignal`-compatible APIs.
- Retry safe polling reads only under the documented transient conditions and within the original deadline.
- Do not automatically retry `POST /create_thread` or `POST /process_message`; duplicate threads/model jobs are worse than a surfaced ambiguous failure.
- Stop polling and release capacity on cancellation. A submitted upstream generation may continue because no cancellation endpoint is currently known.
- Use capped backoff and jitter without allowing the next sleep/request to pass the total deadline.

## Contract Discovery and Fixtures

Phase 0 exists to replace assumptions with evidence. When a live probe is explicitly authorized:

- use synthetic, non-sensitive prompts;
- minimize model count, cost, and thread creation;
- capture status, content type, bounded response shape, and timing without credentials;
- sanitize thread IDs, request IDs, user/account identifiers, prompts, answers, headers, and timestamps where identifying;
- convert observations into deterministic mock-server fixtures and contract tests;
- record unresolved ambiguity instead of coding a guess.

Every adapter path should be tested for successful and malformed shapes, status/body disagreement, auth/quota mapping, empty/partial/duplicate messages, oversize bodies, slow responses, resets, timeout, and cancellation.

## Future Capabilities

Represent native tools, request-scoped streaming, cancellation, and token usage through an explicit capability object. A capability defaults to false until supported by official documentation or sanitized, repeatable contract evidence.

Do not use account-wide `/user/events`, persistent thread reuse, thread deletion, native tools, or POST retry/idempotency merely because a field or endpoint appears to exist.

## Review Checklist

- Is upstream knowledge still confined to the adapter?
- Are request and response bodies bounded and validated?
- Are content and credentials absent from logs/errors/traces?
- Are retry and timeout semantics safe for the HTTP method?
- Are duplicate/partial messages handled deterministically?
- Does cancellation stop local work and release permits?
- Are new observations sanitized, tested, and documented?
- Has any provisional assumption been presented as guaranteed behavior?
