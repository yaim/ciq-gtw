# Tool Calling

## Status and Trust Boundary

Emulated tool calling is **implemented offline and EXPERIMENTAL** (Phase 3). It
converts an upstream text response containing a strict protocol JSON object into
OpenAI `tool_calls`. It does not make the response trusted and must not be enabled
as the default production OpenCode model until every release gate in
`.agent/docs/tech-software-spec.md` section 30 passes. Those gates are **not met**.

Two authorized live evaluator campaigns have been executed (a "campaign" scores
at most one full corpus; a campaign may span multiple resumable "execution
segments"):

- **Partial 2026-08-24 campaign — historical, established NO section-30 gate.**
  Attempted 149 rounds, all 149 created threads confirmed deleted, partial
  single-round snapshots read 99.3%, three-step multi-step scenarios never
  reached and therefore unmeasured, aborted operationally under the earlier
  ambiguous report.
- **Completed 2026-08-26 campaign — overall `passed: false`.** One authorized
  campaign ran across two resumable execution segments (the first stopped on a
  cleaned/resumable `get-messages` `401` after attempt 161; the second resumed
  from case cursor 160 and finished). 281 attempted rounds, 280 completed;
  200/200 single-round cases; 20/20 multi-step scenarios; 281/281 created
  threads deleted; zero cleanup or journal failures; checkpoint finalized.
  Gate outcomes: schema validity 257/260 (98.8%, passed); **tool-name
  accuracy 254/260 (97.7%, failed against the 98% / 255/260 minimum, i.e.
  missed by ONE additional expected-tool-accurate round);** argument validity
  257/260 (98.8%, passed); single-round success 199/200 (99.5%, passed);
  multi-step success 18/20 (90%, passed); no-silent-fallback,
  injection-resistance, and parser-determinism all passed. The counters imply
  six expected-tool misses: three rounds produced no selected valid tool-call
  set, and three selected valid allowed calls that did not include the
  expected tool.

Section-30 remains **unmet** and emulated tool mode stays experimental,
opt-in, and non-default. **No prompt, selection, threshold, corpus, or model
default change is being made** until a diagnostic run identifies the six
failure locations. The evaluator's **diagnostic-emitting live rerun** is
approval-gated and unrun.

The evaluator has been hardened offline: it emits a versioned value-free
output union (`preflight | progress | blocked | executed`); a four-state gate
status (`passed | failed | incomplete | not_evaluated`) with explicit
numerators/denominators/planned denominators; structured value-free abort
diagnostics; JSON progress events emitted only after a cleaned attempt AND a
successful durable checkpoint write; and a private content-free resume
checkpoint (`.agent/sessions/eval/tools-eval-checkpoint.json`, 0700 dir / 0600
file, `O_NOFOLLOW`, atomic temp+rename, corpus-bound semantic validation
before any credential read or network I/O) gated behind an explicit
`--resume-approved` flag.

**Report format v3 / checkpoint format v2 (2026-08-26).** To identify the six
2026-08-26 misses without changing production behavior, the evaluator now
emits bounded, value-free failure diagnostics. Every mode emits report
version `3`; only the `executed` variant carries the collection, bounded by
the fixed 280-round corpus:

- `EvalFailureDiagnostic = { phase: "single"|"multi"; caseOrdinal: number;
  roundOrdinal: number; choiceKind: "auto"|"required"|"function"; reason:
  EvalFailureReason }`.
- `EvalFailureReason` is a closed nine-member union:
  `expected-tool-returned-text | expected-tool-no-valid-call |
   expected-tool-unavailable | expected-tool-not-invoked |
   unauthorized-tool-call | transcript-invalid |
   unexpected-tool-call-on-final | final-no-valid-call | final-unavailable`.
- Classification is deterministic and emits **at most one** primary reason
  per failed round (see spec §30 for the precedence for expected-tool vs
  final rounds). Duplicates are impossible: a failed round is identified by
  a unique `(caseOrdinal, roundOrdinal)` key. The classifier does not (and
  must not) alter any gate accumulator or `scenarioOk`.
- The collection never contains prompts, answers, arguments, schemas, tool
  names, selected model names, IDs, credentials, titles, bodies, URLs,
  timestamps, or exception text.

Checkpoint format version was bumped from 1 to `2`; a v1 checkpoint is
**rejected** with no migration path. Failure diagnostics persist via a
compact ledger `readonly [caseOrdinal, roundOrdinal, reasonCode][]` mapped
to fixed integer codes 1..9 (union order above) via the immutable
`evalFailureReasonForCode(code)` closed switch (never a mutable `Map`/`Set` —
the trust source is the function identity, so an unknown code such as `42`
can never be widened into the allowlist at runtime); `phase` and `choiceKind`
are NOT persisted and are instead derived from the fingerprint-bound
`EvalCorpusProjection` (`buildEvalCorpusProjection(buildEvalCases())`, an
immutable content-free per-case per-round structural view) when the resumed
report is built. Rehydration FAILS CLOSED on any impossible entry (unknown
reason code, out-of-corpus case/round, or an out-of-diagnostic-union
`choiceKind` such as `"none"`) — no silent skip, no silent relabel.
`MAX_CHECKPOINT_BYTES` stays at 8192 (the worst valid 280-entry ledger fits
comfortably in compact JSON). Ledger validation is strict — max 280 entries;
unique `(caseOrdinal, roundOrdinal)` pairs; case ordinals only refer to a
case committed at or before `nextCaseIndex`; the round ordinal must exist in
that corpus case; the reason code must be one of the fixed codes; the reason
must be structurally compatible with whether the referenced round expects a
tool or final text — and validation runs against the freshly built corpus
BEFORE any credential read or network I/O, preserving every existing v2
checkpoint protection (mode/`O_NOFOLLOW`/ancestry/atomic-write/size/
blocked-tombstone/counter/cursor/fingerprint). For multi-step cases,
diagnostics accumulate locally and commit only when the whole scenario
commits (mid-scenario interruptions discard pending diagnostics); for
single-round cases the diagnostic commits together with the case's score and
cursor before progress is emitted. A resumed final report re-emits every
prior segment's committed diagnostics exactly once.

Read specification sections 5.2–5.3, 8.7, 11.2, 12–13, 14.4, 21.4–21.5, 29.4, 30, and 34.1–34.2 before changing this area.

The gateway never executes, authorizes, simulates, or claims execution of a tool.
It returns model-PROPOSED calls only; OpenCode owns permissions, execution,
results, and loop limits.

**Implemented engine (offline, `src/tools/`).** The emulated engine lives under
`src/tools/`: `limits.ts` (the single source of truth for `MAX_TOOLS`=128,
`MAX_TOOL_SCHEMA_BYTES`=2 MiB, `MAX_TOOL_ARGUMENT_BYTES`=1 MiB,
`MAX_TOOL_CALLS_PER_RESPONSE`=8, `MAX_TOOL_JSON_DEPTH`=512), `copy.ts`
(`safeJsonCopy` — a descriptor-safe bounded deep copy to trusted plain JSON that
never triggers a getter/`[[Get]]`/`toJSON`/iterator and fails closed on
accessors/cycles/sparse/exotic/over-deep/non-finite/symbol/function/bigint),
`ids.ts` (`call_ciq_<ULID>` seam, `ulid` dependency), `schema.ts` (`compileToolset`
— a per-request Ajv compile that picks the meta-schema dialect from each schema's
root `$schema`: draft-07 by default when `$schema` is absent, and draft-07 or
draft 2020-12 by an exact URI allowlist (OpenCode 1.18.21's draft-2020-12 built-in
schemas compile; a non-string or unknown `$schema` fails closed); at most one
fresh instance per dialect per call, no coercion/defaults/property-removal, no
remote `$ref`, no cross-request retention), `normalize.ts`, `protocol.ts`
(`parseToolEnvelope`),
`canonicalize.ts`, `select.ts` (`selectGeneration`), and `request.ts`
(`normalizeToolRequest` + prior tool-history validation). Pinned deps: `ajv`
8.20.0, `ajv-formats` 3.0.1, `ulid` 2.4.0.

Only a `toolMode: "emulated"` model activates the engine; that mode REQUIRES
`promptMode: "protocol"` (enforced at config load). The opt-in
`collectiviq-claude-tools` model and the `collectiviq-tools-experimental` OpenCode
agent (wildcard permission `"ask"`) are the only tool-enabled surfaces; every
existing default stays `toolMode: "disabled"`. `toolMode: "native"` remains
unimplemented and is rejected at request time.

**Phase 2.1 text-compatibility bridge (unchanged for disabled models).** Because
OpenCode attaches `tools`/`tool_choice` to every request even when all tool
permissions are denied, the request boundary runs a model-policy-aware bridge
(`src/openai/chat-request.ts`, after model resolution) that, for a
`toolMode: "disabled"` model, TOLERATES that metadata: it accepts a bounded
`tools` array (≤`MAX_TOOLS` entries AND ≤`MAX_TOOL_SCHEMA_BYTES` aggregate JSON)
and a `tool_choice` of exactly `"auto"`/`"none"`, records only the NAME for the
diagnostic header, and DISCARDS the definitions. For a disabled model a tool
definition is never semantically interpreted, retained, serialized into the
prompt, forwarded upstream, logged, reflected, persisted, or executed; it is
traversed ONLY through data-property descriptors (`getOwnPropertyDescriptor`/
`Reflect.ownKeys`, no `[[Get]]`), so submitted accessors and executable hooks are
never invoked. For a disabled model, `required`/named `tool_choice`; a non-array,
over-count, or over-budget `tools`; an accessor, cycle, sparse/exotic/over-deep
structure, unsupported value, or descriptor/proxy failure; and any tool metadata
against a `native` model fail closed with a stable `unsupported_parameter` `400`.

**Emulated mode (the one exception to "tools are discarded").** For a
`toolMode: "emulated"` model the boundary instead NORMALIZES and RETAINS the tool
policy: it descriptor-safe-copies the definitions into trusted plain data,
compiles the JSON Schemas once, validates prior assistant `tool_calls` + linked
tool results (unique ids, declared names, schema-valid arguments, exactly-one
correctly-linked result — orphan/duplicate/unresolved/mismatched relationships are
rejected before upstream work), and carries the compiled toolset through
`prepare`/`run`. In emulated mode the validated tool schemas, prior arguments, and
tool results ARE serialized into the prompt sent to CollectivIQ — they are still
never logged or retained by the gateway. A `required`/named `tool_choice` with no
declared tools is a stable `400 unsupported_parameter` before capacity/headers/
upstream. Each tool-loop round creates a NEW upstream thread.

## Prompt Protocol

- Use the versioned `tool-or-final` control prompt and one versioned conversation envelope.
- Include only the tool definitions supplied and validated for the current request.
- Require exactly one complete JSON object with either `type: "tool_calls"` or `type: "final"`.
- Keep conversation and tool boundary markers explicit and high entropy where implemented.
- Preserve tool-result messages and IDs so the next model action has the actual execution history.
- Do not claim delimiters restore a cryptographic role boundary; prompt injection remains possible.

## Parsing and Validation

Apply the full ordered algorithm from specification section 12.2:

1. trim Unicode whitespace;
2. remove at most one outer JSON Markdown fence when present;
3. parse JSON with a real parser;
4. validate protocol version and action type;
5. allow only names declared in the request;
6. validate each argument object against the exact supplied JSON Schema;
7. honor strict-object/unknown-property behavior;
8. enforce `tool_choice`, call-count, parallel-call, and argument-byte limits;
9. generate gateway-owned `call_ciq_<ULID>` identifiers.

Never extract a tool call from prose with regular expressions, repair arbitrary malformed JSON silently, trust upstream call IDs, or accept a schema near-match.

## Tool Choice

- `none`: do not include or parse the tool protocol for the request.
- `auto`: accept a valid tool envelope or final envelope; invalid desired-source protocol may fall back to ordinary final text exactly as specified.
- `required`: require at least one valid call; never silently return text.
- named function: require valid call(s) to that function according to the supported policy.

Required or named choice with no valid call maps to the specified `502 invalid_tool_response` error.

## Candidate Selection

Use deterministic priority:

1. valid configured answer-source response;
2. agreement among valid individual responses;
3. one deterministic valid individual response;
4. failure.

For consensus fallback, canonicalize tool name, recursively key-sorted argument JSON, and call ordering unless parallel behavior explicitly makes ordering irrelevant. Score with available `percent_usage`, otherwise agreement count, and break ties through configured source priority.

Canonicalization must be pure, stable, and covered by fixtures. Parser output should identify the selection path as bounded metadata without recording arguments.

## Parallel Calls and Streaming

- Enforce the configured maximum, with the specification's initial default of eight calls (`MAX_TOOL_CALLS_PER_RESPONSE`).
- When `parallel_tool_calls` is false, reject multiple calls (implemented — there is NO silent "select the first call" fallback).
- Generate all IDs before SSE encoding and keep them stable in every related chunk.
- A complete tool-call delta is acceptable; character-level argument streaming is not required. Tool-call streaming is **implemented** (`src/openai/chat-stream.ts` `toolCallsChunk`/`terminalToolChunk`, driven by `src/api/chat-stream-response.ts`): one complete indexed delta using the trusted `call_ciq_*` ids, then a terminal chunk with `finish_reason: "tool_calls"`, then `data: [DONE]`, with no `usage`.

## Validation and Release Evidence

Changes require unit and adversarial fixtures for valid, malformed, fenced, injected, unknown-name, schema-invalid, oversized, too-many, choice-mismatched, parallel, and deterministic-consensus cases.

**Implemented hermetic coverage (offline).** Unit: `test/unit/tools-{copy,schema,protocol,select,request,encoding}.test.ts` plus emulated-acceptance cases in `chat-request.test.ts` and the config invariant in `config.test.ts`. Integration: `test/integration/chat-completions-tools.test.ts` (JSON tool_calls, SSE tool deltas, pre-header `400`, ignored-header, native-title-after-tool-call). Contract: `test/contract/completion-flow-tools.test.ts` (real runtime + mock upstream — full flow with one create + one submit, `502` for required-with-no-call, `auto` text fallback, and a no-leak logger/response assertion while the schema is serialized into the prompt by design). Pinned-SDK compatibility (out of `validate`/CI): `test/compatibility/ai-sdk-tools.test.ts` (`generateText`/`streamText` real tool call + an in-memory three-step read/edit/test loop with synthetic tools only — no shell/fs/MCP/network). The **adversarial release-gate suite** `test/adversarial/tool-protocol-corpus.test.ts` (≥200 protocol cases; own `vitest.adversarial.config.ts`; `npm run test:adversarial`; excluded from `validate`/CI).

Multi-round compatibility tests must include actual assistant tool calls followed by linked tool results and further tool/final responses. The numerical gates in specification section 30 are product release criteria; do not weaken, reinterpret, or mark them passed without reproducible evidence over the required suites. The approval-gated `npm run eval:tools` live evaluator that would measure those gates has been run in two authorized campaigns: the **partial 2026-08-24 campaign** (149 rounds attempted, all 149 created threads confirmed deleted, partial single-round snapshots 99.3%, multi-step scenarios never reached/unmeasured, aborted operationally under the earlier ambiguous report — establishing **no** section-30 gate) and the **completed 2026-08-26 campaign** across two resumable execution segments (200/200 single-round cases, 20/20 multi-step scenarios, 281/281 created threads deleted, zero cleanup or journal failures, checkpoint finalized: schema 98.8% passed, tool-name accuracy **97.7% failed** vs 98% (254/260 vs 255/260), argument validity 98.8% passed, single-round 99.5% passed, multi-step 90% passed, no-silent-fallback + injection-resistance + parser-determinism all passed — overall `passed: false`, tool-name accuracy missed by one additional expected-tool-accurate round). Section-30 remains **unmet**; no prompt/selection/threshold change is being made until a diagnostic-emitting live rerun (also approval-gated) identifies the six failure locations. The evaluator was hardened offline before the 2026-08-26 campaign (versioned value-free output union; four-state gate status with explicit numerators/denominators/planned denominators; structured value-free abort diagnostics with a closed stage set and trap-safe upstream code/status; JSON progress events emitted only after a durable checkpoint write; a private, content-free resume checkpoint under `.agent/sessions/eval/` gated by `--resume-approved`; controlled first-SIGINT/SIGTERM interruption that cleans a recorded thread on an independent signal). Report format v3 / checkpoint format v2 (2026-08-26) add bounded value-free failure diagnostics (`diagnostics.failures` on `executed` reports only; `EvalFailureDiagnostic { phase, caseOrdinal, roundOrdinal, choiceKind, reason }` with a closed nine-member reason union; deterministic classification; at most one diagnostic per failed round; corpus-bound compact ledger persistence with a fixed integer code map and v1 rejection; multi-step accumulation commits only on whole-scenario commit; a resumed final report re-emits every prior segment's diagnostics exactly once). Both the initial and diagnostic-emitting live evaluator runs are network-only and must never appear in `validate`/CI.

The hardened evaluator's runtime contracts:
- **Explicit denominators.** Each threshold gate reports `numerator`, `denominator`, `plannedDenominator`, and a four-state `status` (`passed`/`failed`/`incomplete`/`not_evaluated`). A zero denominator is `not_evaluated` (never `0%`); a partially-sampled threshold is `incomplete` (never `passed`); a threshold gate is `passed`/`failed` only once its planned denominator is complete. Overall `passed` requires the complete corpus, no abort, all gates passed, zero cleanup/journal failures, and successful checkpoint finalization.
- **Structured aborts.** Aborts carry only a stable reason, a closed stage, a normalized `UpstreamError.code`/safe status when trap-safely available (via `isUpstreamError` before any property read — never inspecting a hostile thrown value), and `resumable`. A create-stage interruption is ambiguous → non-resumable; submit/poll failure is resumable only after confirmed deletion + durable checkpoint; cleanup/journal/checkpoint persistence failures are non-resumable.
- **Resume.** An existing checkpoint requires `--resume-approved` and a matching version/origin/auth/corpus-fingerprint, all validated **before** any credential read or network I/O. A single-round case advances the cursor only after its round completed and the created thread was confirmed deleted; a multi-step scenario advances (and commits its gate measurements) only when the whole scenario finishes, so a mid-scenario interruption restarts that scenario and prior partial rounds count only as attempts/cleanup, never gate measurements. Create/`process_message` are never automatically replayed; GET polling keeps only its existing idempotent-retry behavior.
- **Semantic (corpus-bound) checkpoint validation** (enforced by `src/eval/checkpoint.ts` + `test/contract/eval-checkpoint.test.ts`). The executed evaluator builds `buildEvalCases()` EXACTLY ONCE per run and derives its fingerprint, plan, projection, and case-loop iteration from that ONE `EvalCase[]` value (finding 1) — `corpusFingerprint(cases)`, `evalPlan(cases)`, and `buildEvalCorpusProjection(cases)` all accept the supplied array, so no divergent rebuilt corpus can slip into the executed path. `buildEvalCorpusProjection` also FAILS CLOSED at build if any round's `choice.kind` is outside the diagnostic union `"auto" | "required" | "function"` (finding 2, specifically `"none"`), so no downstream diagnostic ever needs a silent `"none" → "auto"` relabel and a corpus containing `"none"` refuses to enter the pipeline before any credential read or network I/O. On resume a decoded checkpoint is validated against that fingerprint-bound corpus **projection** (`EvalCorpusProjection` derived DIRECTLY from `buildEvalCases()`) before any credential read or network I/O — never from checkpoint-claimed sizes and never from an aggregate `first N rounds are expected` inference. Defense-in-depth: `validateResumableCheckpoint` re-checks that every projected round's `choiceKind` is inside the diagnostic union before it trusts the projection. The projection is immutable and content-free: per-case `phase` plus per-round `choiceKind` and `hasExpectedTool`, with aggregate bounds (`plannedSingle`, `plannedMulti`, `expectedCallsPerScenario`, `maxRoundsPerCase`) derived from the SAME cases so they are internally consistent by construction. `nextCaseIndex` must lie strictly within `0..corpus-length` (a resumable checkpoint can never encode a complete corpus — a genuinely complete run removes its checkpoint); committed single/multi counts are EXACTLY cursor-derived by walking the projection's first `cursor` cases; gate denominators are those committed counts summed from the ACTUAL per-case `hasExpectedTool` layout (single = committedSingle, multi = committedMulti, expected-call = Σ over committed cases of that case's expected-tool rounds — which for the uniform production corpus equals `committedSingle + committedMulti·3`, but for a non-uniform corpus honors the actual layout); every numerator is an integer in `[0, denominator]`; the upstream-round counters are bounded by the ACTUAL per-case round counts: a committed scenario performs FOUR upstream rounds (read/edit/test/final answer), not the three expected-tool-call rounds, so the committed upstream floor is Σ over committed cases of that case's `rounds.length` (uniform corpus: `committedSingle + committedMulti·maxRoundsPerCase`, i.e. `·4`); because a segment aborts at its first non-committing case the counters are also bounded ABOVE (completedRounds ≤ committedUpstreamRounds + runSegments·(maxRoundsPerCase−1); attemptedRounds ≤ committedUpstreamRounds + runSegments·maxRoundsPerCase; completedRounds ≤ attemptedRounds) so an inflated counter is rejected; resumable cleanup accounting truthful (deleted + failed == attempted, failed == 0, journalFailures == 0, attempted == deleted == attemptedRounds); runSegments ≥ 1; and the fresh zero-count anchor valid. Every diagnostic ledger entry is then checked round-by-round against `projection.cases[caseIdx0].rounds[roundIdx0]` (case must be committed, round must exist, reason scope must match that round's ACTUAL `hasExpectedTool` disposition). A forged/inconsistent checkpoint — including any "complete + passing, zero-attempt" claim, or a diagnostic that references an uncommitted case, a non-existent round, or a scope-incompatible reason — is rejected as content-free invalid state, so a checkpoint can never manufacture a zero-network `executed` pass.
- **Durable resumable-vs-blocked state + blocked tombstone.** The checkpoint carries `resumeState: "resumable" | "blocked"` plus a value-free closed abort `{ stage, reason }` (null when resumable). Every non-resumable abort (ambiguous create, cleanup-delete failure, recovery-journal persistence failure, checkpoint-persist failure, journal-finalize failure, toolset-compile, signal/lifecycle) attempts to replace the checkpoint with a durable `blocked` tombstone carrying only closed lifecycle metadata + the abort stage/reason (never prompts/answers/ids/credentials/titles/bodies). A `--resume-approved` run rejects a blocked checkpoint before credentials/network — recovery requires deliberate operator archival/removal, never an automatic destructive restart; a failed tombstone write leaves the report non-resumable and truthfully surfaces the checkpoint persistence failure. A complete successful run still removes the checkpoint.
- **Exact 0600 mode + safe managed-component ancestry.** A checkpoint file is accepted only when `(mode & 0o777) === 0o600` (0400/0200/0000, group/world bits, non-regular, and symlink are all rejected). The checkpoint location is an explicit trusted base plus its ordered managed components (`.agent`/`sessions`/`eval`); EVERY managed component is `lstat`-validated top-down from the base as a non-symlink directory on read/write/delete/exists, so a symlink at any managed level whose descendants already exist through it is caught before the OS would traverse it (closing the earlier immediate-parent-only gap). Directory creation no longer uses recursive `mkdir`; missing components are created one at a time with the private 0700 mode and re-validated, and the open keeps `O_NOFOLLOW` + atomic temp+rename + bounded size. Nothing at or above the trusted base is symlink-validated, so a legitimate platform symlink above it is not falsely rejected.
- **One explicit finalization state machine.** The recovery journal is finalized exactly once on every executed AND blocked path after successful init, through one idempotent helper (closing a prior gap where the working-tree evaluator did not finalize it on all paths — including the initial-anchor-write-failure path, which now routes the finalize through that helper instead of swallowing it and reports a journal-finalize failure there as its OWN closed blocked reason `recovery-journal-finalize-failed`, distinct from `checkpoint-write-failed`, before any credential/network); a journal-finalization failure is a closed abort stage/reason (`recovery-journal-finalize` / `recovery-journal-finalize-failed`), is non-resumable, durably blocks the checkpoint, and prevents a pass. Progress ordering is exact: a cleaned-but-uncommitted TERMINAL resumable attempt (submit/poll failure or interruption whose thread was created and confirmed deleted with no journal failure) carries a bounded value-free pending-progress descriptor that finalization emits exactly once, only after the resumable checkpoint durably persists (so no cleaned attempt is dropped and the descriptor never claims the cursor advanced); a journal-finalize or checkpoint persistence failure emits no resumability progress; no duplicate progress record is emitted for the same completed multi-step case. All abort/blocked reasons are closed literal unions (`AbortReason` / `BlockedReason` / `AbortStage`) built through typed helpers — no free-form exception text ever reaches output or checkpoints. Order: finish/abort round → bounded cleanup → finalize recovery journal exactly once → persist a validated resumable checkpoint OR a blocked tombstone → emit progress only when a resumable checkpoint durably persisted → emit final report → on complete success remove the checkpoint and report success only after all finalization succeeds.

If gates fail, keep text-only models available and label tool mode experimental. A parser implementation and passing offline suites alone are not evidence that OpenCode agent workflows are production-ready. The current account may still reject the protocol wrapper; do not change the default or weaken parsing to work around that.
