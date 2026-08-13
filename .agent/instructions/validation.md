# Validation

## Current Command Status

`package.json` defines the canonical scripts (backed by the committed `package-lock.json`). Prefer them over ad hoc commands. Do not claim executable validation beyond what these run.

| Command | Category | Notes |
| --- | --- | --- |
| `npm run format:check` | Formatting | Prettier check (scoped away from `.agent/` and the spec) |
| `npm run format` | Formatting | Prettier write |
| `npm run lint` | Lint | ESLint flat config, typed rules |
| `npm run typecheck` | Types | `tsc -p tsconfig.test.json --noEmit` over sources and tests |
| `npm run test` | Unit + integration | Vitest (`test/unit`, `test/integration`) |
| `npm run test:unit` | Unit | Vitest `test/unit` only |
| `npm run test:integration` | Integration | Vitest `test/integration` only (in-process `inject`, no socket) |
| `npm run test:contract` | Upstream contract | Vitest `test/contract` only (hermetic mock HTTP server, no network) |
| `npm run test:coverage` | Coverage | Vitest with V8 coverage |
| `npm run build` | Build | `tsc -p tsconfig.json`, emits `dist/` |
| `npm run test:build` | Build smoke | Imports compiled `dist/*.js`; asserts no listening socket |
| `npm run validate` | Aggregate | format check → lint → typecheck → test → build → test:build |
| `npm run dev` / `npm start` | Run | Local watch run / run compiled `dist/index.js` |

`validate` is hermetic. The upstream contract suite (`test/contract`) is now
implemented and hermetic (a local mock HTTP server; no network, credentials, or
CollectivIQ calls); it runs as part of `npm run test` and therefore inside
`validate`, and `npm run test:contract` runs it in isolation. The network-only
`contract:openapi:refresh` and `contract:openapi:check` commands and the opt-in
`contract:discovery` and `contract:discovery:cleanup` (recovery-only) commands
must **never** be added to `validate` or CI.
OpenAI-compatibility, adversarial, load, live-upstream, end-to-end OpenCode, and
Docker/live checks are **not implemented yet** and must not be added to
`validate` until their suites and gates exist. Keep fast hermetic validation
separate from those.

## Validation Order

Run the narrowest meaningful check first, then broaden based on risk:

1. focused unit or contract test for the changed behavior;
2. related test directory/suite;
3. strict type check and lint/format check;
4. full hermetic test suite;
5. build/package and startup smoke check;
6. compatibility, adversarial, Docker, load, or live checks when the task needs them.

Do not replace focused assertions with snapshots that merely accept broad output. Never weaken a test to accommodate a regression without an explicit contract change.

## Test Categories

### Unit

Cover deterministic policies without sockets: public validation/normalization, serializer byte limits, model resolution, state transitions, error mapping, tool protocol parsing/schema validation/canonicalization/voting, SSE encoding, IDs, redaction, timeout math, and configuration.

**Implementation status (Phase 1B).** Chat-completion coverage exists across all three hermetic suites: unit (`chat-request`, `prompts`, `capacity`, `polling`, `chat-completion`, `chat-response`, plus capacity/shutdown config cases and the opaque gateway-key identity), integration (`test/integration/chat-completions.test.ts`: auth-before-parse, success, model-not-found, malformed body / unsupported media type, unsupported content, `413`, capacity `429` + `Retry-After`, upstream/timeout/`500`/`503` mappings), and adapter-backed contract (`test/contract/completion-flow.test.ts`: create→submit→poll→answer, partial/duplicate/retryable-poll paths, malformed/`detail`/auth/quota/timeout mappings, and cancellation) — all against the local mock server. No live upstream or OpenCode compatibility suite is run.

**Phase 1B remediation evidence (added by the review-remediation change).** The following are proven by new hermetic tests, and only these claims are asserted: **deadline authority** (`test/unit/polling.test.ts`) — an already-expired deadline issues zero polls; a poll that advances the clock past the deadline yields a timeout, never a late answer; a retryable error observed at/after the deadline becomes a timeout (not a leaked transport error); a pre-aborted signal throws a cancellation distinct from timeout; and a jittered sleep never exceeds `maxPollIntervalMs`. **Fail-closed route boundary** (`test/integration/chat-completions.test.ts`) — a service rejection with a forged `FST_ERR_CTP_*` code returns the fixed `500`; a hostile `Proxy` error triggers zero getter/`has`/`getPrototypeOf` traps and returns `500`; genuine malformed JSON still returns `400` and an oversized body `413`; auth/validation responses are unchanged. **Strict surface + immutability** (`test/unit/chat-request.test.ts`) — presence-based rejection of `stream≠false`/`tools`/`tool_choice`/`response_format`/`logprobs`/`audio`/message `tool_calls` including empty/`null`/`"auto"`/`"none"`; `parallel_tool_calls` stays ignored; and `Object.isFrozen`/mutation-throws over the whole normalized structure. **Shutdown lifecycle** (`test/unit/shutdown.test.ts`) — the extracted `runGracefulShutdown` used by `main()` flips readiness, closes admission, honours the drain window, force-cancels on timeout, cleans up the timer, routes a close() failure to a content-free sink, and never calls `process.exit`. **Runtime authentication** (`test/unit/runtime-auth.test.ts`) — `buildCredentialProviderFromConfig` builds the correct provider per mode using only the active mode's credentials with no construction-time network/login, re-logs in beyond the two-login CLI budget after generation-safe `401` invalidations while the CLI budget stays two, reuses a non-invalidated lease (as on a `403`), and leaks no synthetic credential sentinel. **Real client disconnect** (`test/integration/client-disconnect.test.ts`) — a bounded loopback regression on an ephemeral port destroys the client socket mid-completion and asserts the request signal aborts, polling stops, and the capacity permit is released (deterministic; cannot hang). No live upstream, OpenCode, or network call occurs in any of these.

**Phase 1B second-remediation evidence (added by the follow-up review-remediation change).** Four independently reproduced defects are now covered by hermetic regressions, and only these claims are asserted: **poll-in-flight cancellation** (`test/unit/polling.test.ts`) — when the signal aborts WHILE a `get_messages` is in flight, a subsequent fulfilment returning a usable answer still yields a cancellation (never a late answer) and no extra poll/sleep occurs; and when the same poll rejects as the clock also reaches the deadline, cancellation takes precedence over the timeout so the orchestrator can apply the correct source mapping. **Trap-safe upstream identity** (`test/unit/chat-completion.test.ts`) — a hostile `Proxy` thrown from `createThread`, from `processMessage`, or from the poller read path is re-thrown by identity for the route's fixed `500` with the capacity permit released and **zero** `get`/`has`/`getPrototypeOf` traps invoked; a genuine `UpstreamError` still maps to its public envelope, and a retryable `GET` error still retries (existing tests). **Pre-handler provenance** (`test/integration/chat-completions.test.ts`) — when the gateway auth hook itself throws, an `Error` forged with a real `FST_ERR_CTP_INVALID_JSON` code/`400` status and a hostile `Proxy` both fail closed to the fixed `500` (the Proxy with zero traps), while a normal `{ ok: false }` auth result still returns the fixed `401` and genuine malformed JSON / unsupported media type / oversized body still map to `400`/`400`/`413`; a narrow test-only `authenticator` seam on `buildServer` drives the throwing hook. **Own-property presence** (`test/unit/chat-request.test.ts`) — explicit `undefined` supplied directly to the normalization boundary is rejected for `stream`, `tools`, `tool_choice`, `response_format`, `audio`, `logprobs`, message `tool_calls`, and `n`; an inherited/prototype `tool_calls` or ignored-name is NOT treated as supplied; and an ignored name is recorded from a value getter without invoking it. An `rg 'instanceof UpstreamError' src` audit returns no matches.

### Upstream contract

Use a mock HTTP CollectivIQ server. Exercise multipart/query/header behavior, schema/status validation, auth/quota/protocol mapping, empty/partial/duplicate responses, selection ordering, oversize bodies, timeouts, resets, retry limits, and cancellation. The implemented `test/contract` suite also covers **method-aware retryability** (idempotent-`GET`-only retryable; `POST`/`DELETE` never), **`detail`-any-value failure** for `process_message`, the **bounded OpenAPI fetch** (fixed origin, content-type/`Content-Length` guards, incremental cap, deadline/cancellation, strict UTF-8 — via injected transport), the **shared request builders** and the **discovery-only any-status observation path** (`observeUpstreamJson` parses non-2xx JSON while production `requestUpstreamJson` still discards non-2xx bodies), and the **discovery boundaries**: preflight makes no network call and reads no credential; deterministic model modes/projected counts and **duplicate-rejection**; runner-level **canonical** selection re-validation before any request (trim single/combined, reject comma-in-element and post-trim duplicates, no caller-array mutation); **raw evidence capture** (process_message run id, auth/validation/not-found error shapes) reduced to value-free structure with `evidenceFormatVersion`, while **required 2xx stages must still pass the production normalizer** (`normalizeCreateThread`/`normalizeProcessMessage`/`normalizeGetMessages`) to be marked successful — a malformed 2xx create/submit/messages body is a failed observation (raw structure retained, safe `UpstreamError` code only) and drives a non-zero exit; the **fatal journal-abort** regression (a `recordCreated` failure aborts the run before any further upstream request, still attempts cleanup for the already-owned thread, and returns a content-free `aborted: "journal-persistence-failed"` non-zero result — and STILL returns that structured report, never a rejection, when the cleanup DELETE's own journal removal also fails, recording `journalPersisted: false`, counting `journalPersistenceFailed`, and dropping the thread from the in-memory ledger on the confirmed HTTP delete; a normal cleanup with a journal-removal failure likewise stays structured and non-zero); **private, value-free correlation targeting the combined-stage request pair** (normalized combined thread id + validated combined submission run candidates only; run resets on a new combined thread; the run dimension matches when **any** requested run candidate — `run_id` or `combined_run_id`, deduped — appears in the observed set; `matched`/`not-matched`/`not-observed`); structural-capture no-value/no-length/safe-name guarantees and descriptor-safe array length (proxy `get` never invoked); **hardened SSE evidence** (non-2xx rejected, content-type gate, LF/CRLF split, strict UTF-8 finalized at EOF, unterminated-record bound, `completed`/`eof`/`timeout`/`event-limit`/`body-limit`/`malformed-utf8`/`invalid-content-type`/`cancelled`/`stream-error` terminations); a **truthful cleanup ledger** with **value-free per-attempt cleanup diagnostics** (`phase`/`ok`/status/`errorCode`/`journalPersisted`, plus a `journalPersistenceFailed` count that fails the exit on its own) and not-found first-delete-failure behavior; **strict exit completeness** including the **`available_llms` structural-gate policy** (accepts a structurally valid `2xx` — top-level object with an own `llms` object — a prototype-inherited `llms` is rejected — holding at least one object entry, extra properties allowed — or exactly a `403`; a malformed `2xx` body is a failed observation mapped to `invalid_upstream_response`; fails on `401`/`429`/`5xx`/transport/timeout/missing/malformed); the **content-free recovery journal** (atomic `0600`/`O_NOFOLLOW` write, origin/version/count/duplicate/symlink/regular-file/unexpected-field/non-private-file/bounds validation, read+delete **directory** validation refusing a redirected/symlinked, non-directory, or non-`0700` journal directory while an absent directory means no journal, a **progress-safe** write loop that fails closed on a zero-progress `writeSync`, record-immediately/drop-after-confirmed-delete, `--recovery-journal-approved` gate) — with the write/read faults injected deterministically through a module-internal filesystem seam (`__setRecoveryJournalFsForTests`: temp-name `EEXIST` collision, rename failure, positive partial writes, and descriptor growth past the 4 KiB cap after the initial `fstat`; temp cleanup and prior-journal preservation on every pre-rename failure), all running under both root and non-root with no permission-gated skips; the **recovery-only `contract:discovery:cleanup` command** (journal-only ids, three approvals, network-only and never in `validate`/CI; the recovery report classification `{ attempted, resolved, unresolved, remaining, attempts: [{ ok, status, errorCode, resolved, resolution, persisted }] }` — no longer `succeeded`/`failed` — where an id resolves on a `2xx` (`resolution: "deleted"`) **or** an exact `404` (`resolution: "already_absent"`, still recorded `ok:false status:404`) so recovery converges across the crash window, other statuses/transport/timeout stay unresolved, the id is dropped only after the resolved state persists, and the exit is non-zero when `unresolved > 0 || remaining > 0`); cleanup/not-found approvals; and token/abort unreachability. It also covers the **dual-mode authentication** surface: the credential validators/bounds (bearer/username/password, exact-preservation vs trimming), exact `POST /login` form encoding with no `Authorization` header, the full range of login outcomes (valid, missing/blank/oversized/wrong-type `access_token`, missing/wrong `token_type`, extra fields ignored, 2xx-not-200, non-JSON, malformed JSON, redirect, the fixed 20 s **header and body login deadlines** — driven with fake timers and an injected `fetch`, each producing `upstream_timeout` from exactly one attempt with no internal retry — kept distinct from a separate **caller-cancellation** test, 4xx/429/5xx), static-token compatibility, password-token caching and **single-flight** coalescing, per-waiter and last-waiter-leaves cancellation, **generation-safe** invalidation, the **two-login budget**, transport `401`-invalidation-without-replay / next-request re-login / `403`-non-invalidation across all three lease-attaching paths — the JSON path, the discovery observation path, and the **bespoke SSE `/user/events` path** (a spy provider with an ordered event ledger proves a `401` invalidates the exact SSE lease with the stream issued once and never replayed, that the invalidation is causally followed by a fresh acquisition for the subsequent request, a `403` leaves the lease intact, and no bearer value leaks into the sanitized report); the value-free auth observation; the discovery/recovery **approval-before-secret and journal-before-secret** ordering — exercised through an injectable CLI orchestration seam (not re-exported from `index.ts`; the fixed destination origin is non-injectable) using guarded/recording `Proxy` envs and event ledgers that prove journal init/precondition validation precedes any credential read, that a journal-init or precondition failure reads no credential and makes no network call, that only the active mode's credential fields are read (inactive-mode variables are never touched), and that no credential sentinel appears in emitted or persisted output — plus parse gating and credential-free preflight reporting only the selected `authMode`; the config **auth-mode matrix** (per-mode presence/bounds, inactive-mode creds ignored, value-free errors), real-Pino **redaction** of the new credential shapes (username/email/password/access_token/refresh_token/login objects), the **ten-operation** OpenAPI filter/snapshot, and the **`0755`→`0700`** directory create-or-tighten migration (plus symlink/non-directory rejection). These discovery and auth tests run inside the hermetic `test:contract` suite (no network); no login or external call occurs during server import/start or the build smoke test.

Live observations are not tests until converted to sanitized deterministic fixtures. Live tests must be opt-in and never use repository/customer content. The two **verified-repeatable** 2026-08-11 password baselines were promoted this way: the confirmed `202` `process_message` shape and the `create_time` `get_messages` metadata mapping are encoded as the **synthetic** fixtures `processAccepted202` and `messagesCreateTime` (invented values only) with matching cases in `adapter-process-message.test.ts`/`adapter-get-messages.test.ts`, and `validation.ts` maps `createdAt` from `create_time` (with `created_at` as a backward-compatible fallback that keeps existing fixtures green). No live value entered a committed fixture.

### OpenAI compatibility

Exercise direct HTTP, the OpenAI SDK with custom base URL, `@ai-sdk/openai-compatible`, and OpenCode where available. Include non-streamed/streamed text, tool calls/results and multiple rounds, multiple/named/none tool choice, timeout, malformed upstream output, cancellation, and model-not-found.

### Adversarial

Include boundary escape, protocol redefinition, invented tools, invalid/oversize arguments, fenced/prose-wrapped JSON, nested fake markers, cross-tool argument attacks, claimed execution, wrong-role results, and deterministic repeat runs.

### Load and lifecycle

Model the configured four active/twenty queued baseline and long upstream latency. Check queue behavior, memory steady state, cancellations, timer/socket cleanup, graceful shutdown, and recovery after upstream outage.

## Change-to-Test Map

| Change | Minimum evidence |
| --- | --- |
| Public request schema or error | Focused validation test plus compatibility response assertion |
| Message normalization or prompt template | Unit fixtures for every affected role/content form and UTF-8 byte limits |
| CollectivIQ adapter or schema | Mock-server contract tests for success, malformed, status/error, timeout, and redaction paths |
| Polling/retry/selection | Fake-time deterministic tests plus duplicate/partial/timeout/cancel cases |
| Response or SSE encoder | Exact object/frame sequence tests, Unicode chunk safety, finish reason, and `[DONE]` |
| Tool parser/schema/candidate logic | Unit and adversarial corpus, determinism, required-choice failure, and release-gate regression run |
| Auth, secrets, or logging | Positive/negative auth tests and assertions that secrets/content never appear |
| Limits, capacity, or Redis | Boundary, queue/permit cleanup, conflict/TTL, and cross-request isolation tests |
| Health, shutdown, or Docker | Lifecycle/integration test and safe-binding inspection |
| Dependency update | Clean locked install, type/lint/test/build, compatibility suite, and security review proportional to change |
| Documentation only | Link/path/terminology scan and direct comparison with owning spec sections |

## Test Design Rules

- Keep tests hermetic by default; no real CollectivIQ calls, credentials, wall-clock sleeps, or uncontrolled network.
- Inject clocks, ID generators, transport, timers, and abort signals where determinism requires it.
- Assert public status, error `type`/`code`/`param`, headers, and body shape—not just messages.
- Assert absence of secrets and content in logs/errors for both success and failure.
- Use Unicode, large-but-bounded inputs, malformed content types, and abort races.
- Keep fixtures small, synthetic, sanitized, and attributable to the contract case they represent.
- Keep release-gate corpora versioned; report sample size and computed rates rather than a pass label alone.

## Before Finalizing

- Run applicable checks and record the exact commands/results.
- State skipped suites and why (missing scaffold, credentials, Docker, OpenCode, or explicit approval).
- Inspect the diff for test-only production hooks, focused-test markers, snapshots with secrets/content, generated output, and unrelated lockfile changes.
- Do not call tool mode production-ready without the numerical evidence required by specification section 30.
