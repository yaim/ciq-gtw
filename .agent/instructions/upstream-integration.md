# CollectivIQ Upstream Integration

## Scope

Read `.agent/docs/tech-software-spec.md` sections 2.1, 8.5–8.7, 10, 13, 16–17, 20, 29.2, 32 phase 0, and 35 before modifying CollectivIQ behavior.

The supplied upstream contract is provisional. Observed facts belong in sanitized contract fixtures and the specification or a later dedicated upstream contract document, not as undocumented assumptions in code.

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
