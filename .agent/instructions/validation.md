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
`contract:discovery` command must **never** be added to `validate` or CI.
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

### Upstream contract

Use a mock HTTP CollectivIQ server. Exercise multipart/query/header behavior, schema/status validation, auth/quota/protocol mapping, empty/partial/duplicate responses, selection ordering, oversize bodies, timeouts, resets, retry limits, and cancellation. The implemented `test/contract` suite also covers **method-aware retryability** (idempotent-`GET`-only retryable; `POST`/`DELETE` never), **`detail`-any-value failure** for `process_message`, the **bounded OpenAPI fetch** (fixed origin, content-type/`Content-Length` guards, incremental cap, deadline/cancellation, strict UTF-8 — via injected transport), the **shared request builders** and the **discovery-only any-status observation path** (`observeUpstreamJson` parses non-2xx JSON while production `requestUpstreamJson` still discards non-2xx bodies), and the **discovery boundaries**: preflight makes no network call and reads no credential; deterministic model modes/projected counts and **duplicate-rejection**; runner-level **canonical** selection re-validation before any request (trim single/combined, reject comma-in-element and post-trim duplicates, no caller-array mutation); **raw evidence capture** (process_message run id, auth/validation/not-found error shapes) reduced to value-free structure with `evidenceFormatVersion`, while **required 2xx stages must still pass the production normalizer** (`normalizeCreateThread`/`normalizeProcessMessage`/`normalizeGetMessages`) to be marked successful — a malformed 2xx create/submit/messages body is a failed observation (raw structure retained, safe `UpstreamError` code only) and drives a non-zero exit; **private, value-free correlation targeting the combined-stage request pair** (normalized combined thread id + validated combined submission run candidates only; run resets on a new combined thread; the run dimension matches when **any** requested run candidate — `run_id` or `combined_run_id`, deduped — appears in the observed set; `matched`/`not-matched`/`not-observed`); structural-capture no-value/no-length/safe-name guarantees and descriptor-safe array length (proxy `get` never invoked); **hardened SSE evidence** (non-2xx rejected, content-type gate, LF/CRLF split, strict UTF-8 finalized at EOF, unterminated-record bound, `completed`/`eof`/`timeout`/`event-limit`/`body-limit`/`malformed-utf8`/`invalid-content-type`/`cancelled`/`stream-error` terminations); a **truthful cleanup ledger** and not-found first-delete-failure behavior; **strict exit completeness**; cleanup/not-found approvals; and token/abort unreachability.

Live observations are not tests until converted to sanitized deterministic fixtures. Live tests must be opt-in and never use repository/customer content.

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
