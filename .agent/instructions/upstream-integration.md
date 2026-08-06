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
  `contract/collectiviq/openapi-filtered.json` (nine allowlisted operations plus
  transitively referenced schemas; the full 422-path document is never
  committed).
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
  (`attempted`/`succeeded`/`failed`/`remaining`); the not-found probe re-deletes
  the same session-owned id and, on a first-delete failure, retains ownership and
  records the failure. Exit code follows strict session completeness.
  Token-inspection and abort discovery are disabled. None of it is wired into a
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
  gateway always requires. Every declared `200` success schema is empty, so all
  response shapes remain provisional until live discovery.

## Adapter Boundary

Only the CollectivIQ adapter may know:

- endpoint paths and query/form field names;
- bearer authentication mechanics;
- multipart request encoding;
- raw status and error bodies;
- provisional response JSON shapes;
- upstream response-size and operation-timeout enforcement.

All response bodies are untrusted. Validate them at runtime, ignore unexpected fields, and return normalized typed results or normalized error categories.

Never expose or log the authorization header, API key, serialized prompt, raw production body, answer content, or other content-bearing diagnostic data.

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
