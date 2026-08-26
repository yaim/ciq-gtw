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
| `npm run test:compatibility` | SDK compatibility | Standalone hermetic suite (`test/compatibility`, own `vitest.compatibility.config.ts`); pinned `ai`/`@ai-sdk/openai-compatible` SDK vs an ephemeral loopback gateway with a **fake** completion — no network/credentials/CollectivIQ. **Excluded from `validate`/CI** |
| `npm run test:adversarial` | Tool release gate | Standalone hermetic suite (`test/adversarial`, own `vitest.adversarial.config.ts`); ≥200 deterministic tool-protocol cases against the pure engine — no network/credentials/CollectivIQ. **Excluded from `validate`/CI** |
| `npm run eval:tools` | Live tool gate | Approval-gated LIVE evaluator (`src/eval/`). Default is a credential-free/network-free preflight; the fully-approved path probes the fixed CollectivIQ origin. Network-only; **must NEVER be added to `validate`/CI**. Two authorized campaigns executed: a **partial 2026-08-24 campaign** that established no gate and a **completed 2026-08-26 campaign** across two resumable execution segments that scored the full corpus but **failed tool-name accuracy** at 254/260 (97.7%) vs the 98% minimum, so section-30 remains unmet. A diagnostic-emitting live rerun (report v3 / checkpoint v2) is approval-gated and unrun. |
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
must **never** be added to `validate` or CI. `test:compatibility` is hermetic but
is likewise kept **out** of `validate`/CI and run only on its own. The
**adversarial tool-protocol release-gate suite** `test:adversarial`
(`vitest.adversarial.config.ts`) is now implemented and is likewise hermetic but
kept **out** of `validate`/CI. The network-only `eval:tools` live evaluator and
the `contract:*` commands must **never** be added to `validate` or CI. Load,
live-upstream, end-to-end OpenCode, and Docker/live checks remain **not
implemented** and must not be added to `validate`. Keep fast hermetic validation
separate from those.

**Phase 3 emulated-tool evidence (offline).** Tool calling is covered end to end
by hermetic suites and only these claims are asserted: unit
(`test/unit/tools-{copy,schema,protocol,select,request,encoding}.test.ts` — the
descriptor-safe copy's fail-closed anomalies + byte fidelity, per-request Ajv
compile with root-`$schema` dialect selection (draft-07 default; draft-07 + draft
2020-12 by exact URI allowlist so OpenCode 1.18.21's draft-2020-12 schemas
compile; unknown/non-string `$schema` fails closed) with no coercion and no remote
`$ref`, the strict §12.2 parser
over fenced/unfenced/prose/multi-object/unknown-field/schema-invalid/oversized/
too-many/choice/parallel cases, deterministic consensus voting with
percent-usage/agreement/configured-order tie-breaks, and stable call ids across
JSON and SSE; the copy/canonicalize regression that a JSON key named `__proto__`
(and `constructor`/`prototype`) round-trips as an ordinary OWN data property with
truthful byte accounting and no prototype mutation; the parser rejecting a call
with an OMITTED `arguments` property — no repair to `{}`; and the request
normalizer rejecting a non-boolean `parallel_tool_calls` with
`param: "parallel_tool_calls"`, defaulting an absent one to `true`, and
deep-freezing the retained tool schemas), the model-aware emulated-acceptance
cases in `chat-request.test.ts` (including the accessor-backed / non-boolean
`parallel_tool_calls` rejection), and the `toolMode: emulated ⇒ promptMode:
protocol` invariant in `config.test.ts`; integration
(`test/integration/chat-completions-tools.test.ts` — JSON `tool_calls`, synthetic-
SSE tool deltas, the pre-header `400` for required/named with no tools, the
consumed-not-ignored header, and native-title correlation after a tool-call
success); contract (`test/contract/completion-flow-tools.test.ts` — the real
runtime against the mock server: one `create_thread` + one `process_message`, a
tool-schema sentinel serialized into the prompt by design yet absent from both the
public response and a capturing Pino logger, the `502 invalid_tool_response` for a
required choice with no valid call, and the `auto` text fallback); the pinned-SDK
`test/compatibility/ai-sdk-tools.test.ts` (real `generateText`/`streamText` tool
call plus an in-memory three-step read/edit/test loop with synthetic tools); the
adversarial corpus `test/adversarial/tool-protocol-corpus.test.ts` (≥200 cases);
and the evaluator's own hermetic test `test/contract/tools-eval-cli.test.ts`
(preflight reads no credential / touches no journal, execution needs every
approval, a fully-approved run over injected fakes is bounded to 280 completions
and cleans up every thread, journal-init precedes any credential read, a cleanup
DELETE failure aborts; plus the remediation coverage — EXACTLY ONE delete per
created thread across recordCreated/submit/poll failure stages, a truthful
`journal-persistence-failed` abort when a journal write fails even though the HTTP
delete succeeded, genuine multi-step transcript continuity (prior assistant
`tool_calls` + linked synthetic tool results carried into later rounds), and the
gate-metric fix that invalid/missing output earns ZERO schema/name/argument credit
(no false 100%); no credential value is emitted). The production
`defaultToolsEvalDeps` deleter is a real bounded single-attempt DELETE
(`observeThreadDeletion`, 2xx-only success) — not a rejection stub — and the
gate report's `parserDeterminism` is a locally MEASURED result, never a hardcoded
`true`. No live upstream, OpenCode, or network call occurs in any of these. The
approval-gated live evaluator (`npm run eval:tools`) has been run in two
authorized campaigns. The **partial 2026-08-24 campaign** attempted 149 rounds
(all 149 created threads confirmed deleted; partial single-round snapshots read
99.3%) but aborted operationally under the evaluator's earlier ambiguous report,
with the three-step multi-step scenarios never reached and therefore unmeasured
(NOT a measured 0%), so it established no section-30 gate. The **completed
2026-08-26 campaign** ran across two resumable execution segments (the first
segment stopped on a cleaned/resumable `get-messages` `401` after attempt 161;
the second resumed from case cursor 160 and finished): 281 attempted rounds,
280 completed; 200/200 single-round cases, 20/20 multi-step scenarios, 281/281
created threads deleted, zero cleanup or journal failures, checkpoint
finalized. Gate outcomes: schema validity 257/260 (98.8%, passed), tool-name
accuracy **254/260 (97.7%, failed against the 98% / 255/260 minimum — missed
by ONE additional expected-tool-accurate round)**, argument validity 257/260
(98.8%, passed), single-round success 199/200 (99.5%, passed), multi-step
success 18/20 (90%, passed), no-silent-fallback + injection-resistance +
parser-determinism all passed. Overall `passed: false`; section-30 remains
**unmet**; a **diagnostic-emitting live rerun** to identify the six failure
locations is approval-gated and unrun. No prompt/parser/selection/threshold
change is authorized until it produces evidence.

The evaluator was hardened offline before the 2026-08-26 campaign: a versioned
value-free output union (`preflight | progress | blocked | executed`), a
four-state gate status (`passed | failed | incomplete | not_evaluated`; a zero
denominator is `not_evaluated`, never 0%; a partial sample is `incomplete`,
never `passed`), structured value-free abort diagnostics with a `resumable`
flag, and a content-free durable resume checkpoint at the ignored path
`.agent/sessions/eval/tools-eval-checkpoint.json` gated behind
`--resume-approved` (hermetic coverage lives in
`test/contract/tools-eval-cli.test.ts`). Four further remediations are now
enforced and hermetically covered by `src/eval/checkpoint.ts`,
`src/eval/report.ts`, and `test/contract/eval-checkpoint.test.ts`: semantic
(corpus-bound) checkpoint validation against a fingerprint-bound
`EvalCorpusProjection` (per-case `phase` + per-round `choiceKind`/
`hasExpectedTool`, derived directly from `buildEvalCases()`, never inferred
from aggregate counts) before any credential/network I/O — the executed
evaluator builds `buildEvalCases()` exactly once per run and passes THE SAME
array to `corpusFingerprint(cases)`, `evalPlan(cases)`, and
`buildEvalCorpusProjection(cases)`; `buildEvalCorpusProjection` fails closed
at build on any `choice.kind` outside the closed diagnostic union
`"auto" | "required" | "function"` (specifically `"none"`, which the
synthetic corpus never uses), so no downstream constructor ever needs a
silent `"none" → "auto"` relabel. A forged "complete + passing,
zero-attempt" checkpoint, a diagnostic ledger entry referencing an
uncommitted case / non-existent round / scope-incompatible reason, or a
supplied projection carrying an unsupported `choiceKind`, can never grant a
zero-network `executed` pass; a durable
`resumeState: "resumable" | "blocked"` tombstone that a `--resume-approved`
run rejects before credentials/network; exact `0o600` file-mode +
non-recursive-`mkdir` safe-ancestry acceptance; and a recovery-journal
finalized exactly once with a `recovery-journal-finalize` closed abort stage
that durably blocks the checkpoint and prevents a pass.

**Report v3 / checkpoint v2 (2026-08-26).** `EVAL_REPORT_VERSION` was bumped
from 2 to 3 across every mode (`preflight | progress | blocked | executed`);
only the `executed` variant carries the new bounded, value-free
`diagnostics.failures` collection (`EvalFailureDiagnostic { phase: "single" |
"multi"; caseOrdinal; roundOrdinal; choiceKind: "auto" | "required" |
"function"; reason }` with a closed nine-member `EvalFailureReason` union).
Classification is deterministic and emits at most one primary reason per
failed round; the classifier does not (and must not) alter any gate
accumulator or `scenarioOk`. `CHECKPOINT_FORMAT_VERSION` was bumped from 1
to 2; v1 checkpoints are **rejected** with no migration path. Diagnostics
persist via a compact ledger `readonly [caseOrdinal, roundOrdinal,
reasonCode][]` mapped to fixed integer codes 1..9;
`MAX_CHECKPOINT_BYTES` stays at 8192 (the worst valid 280-entry ledger fits
comfortably in compact JSON). Ledger validation is strict — max 280 entries,
unique `(caseOrdinal, roundOrdinal)` pairs, case ordinals only refer to a
case committed at or before `nextCaseIndex`, the round ordinal must exist in
that corpus case, the reason code must be one of the fixed codes, and the
reason must be structurally compatible with whether the referenced round
expects a tool or final text — and validation runs against the freshly built
corpus BEFORE any credential read or network I/O. Multi-step diagnostics
accumulate locally and commit only on whole-scenario commit; a resumed final
report re-emits every prior segment's committed diagnostics exactly once. New
hermetic coverage lives in `test/contract/eval-checkpoint.test.ts` (v2
enforcement, round-trip and shape validation, semantic corpus-bound
validation, worst-case 280-entry ledger size, and rehydration to report
shape) and `test/contract/tools-eval-cli.test.ts` (report v3 across every
mode, deterministic classifier precedence, six-miss arithmetic and
diagnostic classification, multi-step transcript/final-round diagnostics,
resume-persists-diagnostics-exactly-once, credential-before-network guard on
invalid v2 checkpoints, and no-live-content scans of the serialized report
and checkpoint).

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

**Implementation status (Phase 2 — synthetic SSE streaming).** Streaming coverage
is hermetic and layered: unit (`test/unit/chat-stream.test.ts` — the frame
encoders and the deterministic code-point split; `test/unit/chat-stream-response.test.ts`
— the backpressure-aware writer, keep-alives, error records, and cancellation),
integration (`test/integration/chat-completions-stream.test.ts` — injected frame
sequences and SSE error records; `test/integration/chat-stream-loopback.test.ts`
— real-socket delivery, one-thread/one-submit, and streaming-disconnect capacity
release), plus updates to the existing chat-completion/chat-request/prompts/
completion-flow tests for the `prepare`/`run` split and `stream` normalization.
Separately, `npm run test:compatibility` (`test/compatibility/`) drives the pinned
`ai` + `@ai-sdk/openai-compatible` SDK via `streamText`/`generateText` against an
ephemeral loopback gateway with a **fake** completion — no CollectivIQ, no real
credential, no network — and is excluded from `validate`/CI. These automated
suites run no live upstream or OpenCode smoke. (Separate user-observed live
foreground smokes were reported on 2026-08-15 for the protocol-mode foreground
transport and on 2026-08-18 for the direct-mode foreground plus hidden-title
paths; live runs are never part of `validate`/CI and stay approval-gated.) A
sanitized 2026-08-21 smoke observed the OpenCode **native-title plugin** path: with
hidden title generation disabled and a single foreground thread, CollectivIQ
generated a provider-native title, but the OpenCode session rename did **not**
occur. The **confirmed cause** was that the plugin **entry module never loaded** —
its earlier bare-function default fell through to OpenCode's legacy export scan,
which rejected a non-function runtime export with `Plugin export is not a
function`, so no header/correlation/poll/rename behavior ran. It was remediated
**offline** by default-exporting the OpenCode V1 `{ id, server }` plugin module
(covered by new loader-contract regressions in
`test/unit/opencode-title-plugin.test.ts` that inspect the real module namespace and
model OpenCode's `readV1Plugin`-before-legacy-scan order). The descriptor-safe
flat/nested provider matching is separate offline hardening, **not** the proven live
root cause. A subsequent trace (after the loader fix) then showed the poller
progress through loader/singleton/lifecycle/provider-match/header/idle/base-URL but
stop before its first title lookup because it resolved its gateway key ONLY from
`process.env.COLLECTIVIQ_GATEWAY_KEY` (absent). The plugin now performs one bounded,
descriptor-safe connection resolution that reuses the resolved CollectivIQ provider
`options.apiKey` (merged-over-embedded); the `COLLECTIVIQ_GATEWAY_KEY` fallback is
read **lazily through an injected reader** — invoked at most once, and only when a
usable base URL exists but no usable provider-config key does (never on the
provider-config path and never when the base URL is missing) — so the real
credential environment lookup is confined to the production plugin wrapper alone.
This is covered by new hermetic connection-resolution tests
(`test/unit/opencode-title-plugin.test.ts`, all injecting **synthetic** readers that
record their invocation count so no test touches the real environment):
provider/env precedence, embedded fallback, zero fallback reads on the
provider-config and missing-base-URL paths, exactly-one fallback read on the
no-provider-key path, single `client.config.get()`,
empty/non-string/over-8192-byte/placeholder rejection, multibyte byte-accounting,
accessor/inherited/throwing-proxy safety, throwing/unusable-fallback fail-open,
bounded/cancelled resolution, no-fetch on missing connection, and a source scan
asserting the credential `process.env` lookup appears in exactly one place (the
wrapper) and in no test. A sanitized, user-authorized **2026-08-22 live smoke then
observed the complete propagation path succeed for the tested local configuration**
(OpenCode 1.18.21): one new foreground CollectivIQ thread, no hidden title thread, a
provider-native title generated, and the OpenCode session title changed from its
default to that title (the foreground response completed and was relevant, no
alert/tool call). This is a single-local-configuration observation — not production
readiness, a cross-account/cross-version guarantee, or a claim about which credential
source was exercised. The provider-config/environment precedence and the lazy env
fallback stay **hermetically verified**; live runs remain approval-gated and are
never part of `validate`/CI.

**Phase 2 transport-remediation evidence (added by the streaming-review
remediation).** New hermetic regressions in `test/unit/chat-stream-response.test.ts`
(a Node-faithful fake `ServerResponse` whose backpressured write callback settles
only on drain) assert, and only assert: a **synchronous `write()` throw** on the
role frame makes `streamChatCompletion` FULFIL (never reject), never starts
`run()`, cancels the client, ends/destroys the response, and writes no `[DONE]`;
an **async callback error** on a nominally successful role write likewise starts
no `run()`, produces no unhandled rejection, and cancels + cleans up; a
**backpressured role write + shutdown before drain** settles promptly, never
starts `run()`, force-closes the response, and leaves no listener attached; a
**backpressured write during `run()` + shutdown** unblocks the pending write,
propagates cancellation to the active work, clears the keep-alive timer, and
settles without rejection; a **response `error` + `close` race** settles exactly
once with a single cancellation/end and every `drain`/`close`/`error` listener
removed; and a **writable shutdown** still emits role + safe `503` + `[DONE]`
with no `finish_reason:"stop"` terminal. A **second remediation** adds two more
regressions covering hardened forced termination: a forced-close whose
`res.end()` **throws** still FULFILS, writes the safe `503` + `[DONE]` first, and
destroys the response immediately with no listener/timer left; and a forced-close
whose `res.end()` returns but **never invokes its callback** settles without
hanging and destroys the response on the writer's **bounded next-turn fallback**
(with the temporary `close` listener removed). The real-socket lifecycle
regression in `test/integration/chat-stream-loopback.test.ts` drives the shared
shutdown signal against the real runtime and proves polling stops, capacity
returns to zero, the reading client receives the safe `503` + `[DONE]`, and
`app.close()` completes within a bounded deadline (no hang). The pre-existing
real-client-disconnect regression is unchanged and green.

**Phase 1B remediation evidence (added by the review-remediation change).** The following are proven by new hermetic tests, and only these claims are asserted: **deadline authority** (`test/unit/polling.test.ts`) — an already-expired deadline issues zero polls; a poll that advances the clock past the deadline yields a timeout, never a late answer; a retryable error observed at/after the deadline becomes a timeout (not a leaked transport error); a pre-aborted signal throws a cancellation distinct from timeout; and a jittered sleep never exceeds `maxPollIntervalMs`. **Fail-closed route boundary** (`test/integration/chat-completions.test.ts`) — a service rejection with a forged `FST_ERR_CTP_*` code returns the fixed `500`; a hostile `Proxy` error triggers zero getter/`has`/`getPrototypeOf` traps and returns `500`; genuine malformed JSON still returns `400` and an oversized body `413`; auth/validation responses are unchanged. **Strict surface + immutability** (`test/unit/chat-request.test.ts`) — presence-based rejection of `response_format`/`logprobs`/`audio`/message `tool_calls` including empty/`null`/explicit `undefined` (`tools`/`tool_choice` are no longer presence-rejected; they are covered by the Phase 2.1 bridge evidence below); `stream` is now normalized to a boolean (absent/`false`/`true` accepted, every non-boolean value rejected — a Phase 2 change from the original `stream≠false` rejection); `parallel_tool_calls` stays ignored for text-only models (it is consumed in emulated mode — see the Phase 3 evidence below); and `Object.isFrozen`/mutation-throws over the whole normalized structure. **Shutdown lifecycle** (`test/unit/shutdown.test.ts`) — the extracted `runGracefulShutdown` used by `main()` flips readiness, closes admission, honours the drain window, force-cancels on timeout, cleans up the timer, routes a close() failure to a content-free sink, and never calls `process.exit`. **Runtime authentication** (`test/unit/runtime-auth.test.ts`) — `buildCredentialProviderFromConfig` builds the correct provider per mode using only the active mode's credentials with no construction-time network/login, re-logs in beyond the two-login CLI budget after generation-safe `401` invalidations while the CLI budget stays two, reuses a non-invalidated lease (as on a `403`), and leaks no synthetic credential sentinel. **Real client disconnect** (`test/integration/client-disconnect.test.ts`) — a bounded loopback regression on an ephemeral port destroys the client socket mid-completion and asserts the request signal aborts, polling stops, and the capacity permit is released (deterministic; cannot hang). No live upstream, OpenCode, or network call occurs in any of these.

**Phase 1B second-remediation evidence (added by the follow-up review-remediation change).** Four independently reproduced defects are now covered by hermetic regressions, and only these claims are asserted: **poll-in-flight cancellation** (`test/unit/polling.test.ts`) — when the signal aborts WHILE a `get_messages` is in flight, a subsequent fulfilment returning a usable answer still yields a cancellation (never a late answer) and no extra poll/sleep occurs; and when the same poll rejects as the clock also reaches the deadline, cancellation takes precedence over the timeout so the orchestrator can apply the correct source mapping. **Trap-safe upstream identity** (`test/unit/chat-completion.test.ts`) — a hostile `Proxy` thrown from `createThread`, from `processMessage`, or from the poller read path is re-thrown by identity for the route's fixed `500` with the capacity permit released and **zero** `get`/`has`/`getPrototypeOf` traps invoked; a genuine `UpstreamError` still maps to its public envelope, and a retryable `GET` error still retries (existing tests). **Pre-handler provenance** (`test/integration/chat-completions.test.ts`) — when the gateway auth hook itself throws, an `Error` forged with a real `FST_ERR_CTP_INVALID_JSON` code/`400` status and a hostile `Proxy` both fail closed to the fixed `500` (the Proxy with zero traps), while a normal `{ ok: false }` auth result still returns the fixed `401` and genuine malformed JSON / unsupported media type / oversized body still map to `400`/`400`/`413`; a narrow test-only `authenticator` seam on `buildServer` drives the throwing hook. **Own-property presence** (`test/unit/chat-request.test.ts`) — explicit `undefined` supplied directly to the normalization boundary is rejected for `stream`, `response_format`, `audio`, `logprobs`, message `tool_calls`, and `n` (explicit `undefined` for `tools`/`tool_choice` is likewise rejected, now via the Phase 2.1 bridge below); an inherited/prototype `tool_calls` or ignored-name is NOT treated as supplied; and an ignored name is recorded from a value getter without invoking it. An `rg 'instanceof UpstreamError' src` audit returns no matches.

**Phase 2.1 tool-metadata compatibility bridge evidence.** The model-policy-aware `tools`/`tool_choice` bridge is covered end to end, and only these claims are asserted. **Unit** (`test/unit/chat-request.test.ts`) — for a `toolMode: "disabled"` model a non-empty OpenCode-shaped `tools` array, an empty array, and an exactly-`128`-entry array are accepted and record only the name `tools` (the definitions are absent from the frozen normalized request); a `129`-entry array, a non-array/`null`/explicit-`undefined` `tools`, an accessor-backed `tools` getter (never invoked), and a descriptor/proxy read failure all fail closed with a `400 unsupported_parameter param:tools` whose body never contains the thrown value; `tool_choice` `"auto"`/`"none"` are accepted (name recorded) while `"required"`, a named-function object, other objects, `null`, explicit `undefined`, and non-strings are rejected `param:tool_choice`; `tools` is validated before `tool_choice`; accepted names merge into a sorted, frozen, value-free ignored collection; and any `tools`/`tool_choice` presence against a `native` model fails closed (an `emulated` model instead normalizes and retains the policy — see the Phase 3 evidence below). **Byte-budget + descriptor-only accounting** (`test/unit/chat-request.test.ts`) — a realistic multi-tool collection under `MAX_TOOL_SCHEMA_BYTES` (2 MiB, spec §21.6) is accepted while a collection exactly at the budget is accepted and one byte over is rejected (`param:tools`), UTF-8 multibyte and escaped-string bytes are counted by exact encoded size, and multiple tools count toward one aggregate budget; a proxied `tools` array records **zero** ordinary `get`-trap calls during validation, an index descriptor that throws fails closed without leaking the thrown value, an accessor-bearing tool entry is rejected with its getters never invoked, a `toJSON` function/getter is never invoked, and sparse arrays, cycles, exotic objects, symbol keys, unsupported/non-finite primitive values, and an over-`MAX_TOOL_JSON_DEPTH` nested structure all fail closed without throwing or overflowing the stack. **Integration** (`test/integration/chat-completions.test.ts`, `chat-completions-stream.test.ts`) — a disabled model accepts realistic tool metadata and returns ordinary JSON text and synthetic-SSE text, reporting the correct ignored-parameter header (`parallel_tool_calls,tool_choice,tools`); a `required`/named `tool_choice` is a `400` before any SSE header is committed (content-type stays `application/json`), never a silent text fallback; and a route-level regression with a capturing Pino logger (automatic request logging stays disabled) proves a tool-schema sentinel embedded in the tool name/description/schema is absent from every captured log line while the request succeeds as ordinary text. **Contract** (`test/contract/completion-flow.test.ts`) — a unique tool-schema sentinel embedded in the definition never reaches the serialized conversation prompt, the `/process_message` multipart body, any captured upstream request, or the public response, while the flow stays exactly one `create_thread` + one `process_message` + polling. **Pinned-SDK compatibility** (`test/compatibility/ai-sdk-stream.test.ts`, out of `validate`/CI) — a real `ai` function tool with `toolChoice: "auto"` driven through both `streamText` and `generateText` reconstructs the ordinary text, reports `finishReason: "stop"`, returns no tool call, and no longer fails with “tools is not supported yet.” No live upstream, OpenCode, or network call occurs in any of these.

**Direct prompt-mode evidence (`promptMode`).** Hermetic coverage proves both the
positive behavior and the omitted-content guarantees, and only these claims are
asserted. **Config** (`test/unit/config.test.ts`) — an omitted `promptMode` loads
as `protocol`; explicit `protocol`/`direct` load; an unsupported value fails with a
value-free ordinal issue (`models[<i>].promptMode`, submitted value never echoed);
unknown fields stay rejected; the example catalog now has five models and
`collectiviq-claude-direct` carries the exact intended policy (`promptMode:
"direct"`, single Claude source). **Catalog** (`test/unit/model-catalog.test.ts`) —
`resolveModel` returns the internal `promptMode`; public model objects expose only
`id`/`object`/`created`/`owned_by` (never `promptMode`). **Serializer**
(`test/unit/prompts.test.ts`) — the direct serializer returns the latest user
content byte-identically, selects the LAST user message, omits
system/developer/assistant/earlier-user sentinels, adds no header/marker/JSON/role
label/whitespace, preserves an empty latest-user message as an empty prompt, is
deterministic, and the protocol serializer is byte-for-byte unchanged; the selector
dispatches by `promptMode` and fails closed on an impossible mode. **Prepare**
(`test/unit/chat-completion.test.ts`) — dispatch is driven by model policy, the
UTF-8 byte limit applies to only the selected direct prompt (exact limit succeeds,
one byte over fails before capacity/upstream), and preparation still mints one
stable identity with no I/O. **Request** (`test/unit/chat-request.test.ts`) — a
direct request with no user message returns the fixed `400` (`param: messages`,
`code: invalid_request`) without reflecting content, while protocol accepts the same
role sequence. **Integration/contract** (`test/integration/chat-completions*.test.ts`,
`test/contract/completion-flow.test.ts`) — a direct-mode submission carries only the
latest user content (no protocol header/markers, none of the
system/developer/assistant/earlier-user sentinels), uses `selected_llms: claude` /
`generate_combined: false`, polls source `claude`, keeps exactly one thread + one
submit, preserves ordinary JSON and synthetic-SSE responses, and the no-user
direct request returns a JSON `400` before any SSE header or upstream call. No live
upstream, OpenCode, or network call occurs in any of these.

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
