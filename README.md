# CollectivIQ OpenAI-Compatible Gateway

A local or privately hosted HTTP service that will sit between OpenCode and
CollectivIQ, exposing a bounded OpenAI Chat Completions-compatible profile.

> **Status: runnable foundation, the Phase 1A public model surface, the
> Phase 1B non-streamed chat-completions path, and Phase 2 text-only synthetic
> SSE streaming — implemented offline.**
> This repository provides a secure, validated service skeleton, an
> OpenAPI-grounded CollectivIQ adapter with hermetic contract tests, the
> authenticated public model endpoints (`GET /v1/models`,
> `GET /v1/models/:model`), and an authenticated, text-only
> `POST /v1/chat/completions` wired through the adapter (one new CollectivIQ
> thread per request) that serves both the non-streamed JSON path and (Phase 2)
> buffered synthetic SSE for `stream: true`. The completion path calls
> CollectivIQ **only when a real request is served** — never during import,
> construction, or the build smoke test. A user-observed, sanitized live
> OpenCode/CollectivIQ smoke result was reported on **2026-08-15**: the foreground
> protocol-mode `collectiviq-claude` **transport** path worked (a response returned,
> synthetic streaming completed, and OpenCode's auto-attached tool metadata was
> accepted and discarded with no tool call emitted), but the returned response
> objected to the gateway's serialized protocol wrapper as embedded
> identity/instruction manipulation on that path. The prompt-serialization
> remediation — a `collectiviq-claude-direct` virtual model using `promptMode:
direct` (latest-user-only prompt, no protocol wrapper) — is the committed OpenCode
> default, and a sanitized, user-authorized **2026-08-18** smoke **observed it
> resolve that refusal for the tested account**: a natural coding request returned a
> relevant, correct answer, synthetic streaming completed with no protocol
> objection / tool alert / tool call, and the hidden `collectiviq-fast` title
> request returned a valid title on its first attempt. This meets the Phase 1
> semantic / OpenCode smoke criterion **for the tested account** — a sanitized
> single-account observation, **not** production readiness or a repeatable upstream
> guarantee. A clean CollectivIQ _combined_ answer, a long-running keep-alive
> streaming duration, and general non-Claude routing remain **not** verified.
> Streaming is
> **synthetic** (the answer is obtained by polling, then split into deltas), not
> true upstream streaming. It now also includes **experimental, opt-in emulated
> tool calling** (Phase 3), which is **non-default** and whose section-30 release
> gates are **not met** (the approval-gated live evaluator was run once — a partial
> 2026-08-24 run that established no gate — and its complete post-hardening run has
> not been run) — the gateway returns model-proposed tool calls but never executes
> a tool. It does **not** implement
> native CollectivIQ tools, Redis/idempotency, or metrics/tracing; those remain
> planned per
> [`.agent/docs/tech-software-spec.md`](.agent/docs/tech-software-spec.md). This
> is the bounded OpenCode Chat Completions profile, not full OpenAI API
> compatibility or production readiness. The grounded upstream contract is
> documented in
> [`.agent/docs/collectiviq-upstream-contract.md`](.agent/docs/collectiviq-upstream-contract.md).

## What works today

- Strict configuration loading and validation (environment + YAML model file).
- A Fastify server that can be constructed in-process without binding a socket.
- Liveness (`GET /healthz`) and readiness (`GET /readyz`) endpoints. Neither
  calls CollectivIQ or any dependency.
- Authenticated public model endpoints: `GET /v1/models` and
  `GET /v1/models/:model`. Every `/v1/*` route requires
  `Authorization: Bearer <gateway-key>` (case-insensitive scheme, exact-match
  token, fixed-length SHA-256 + `timingSafeEqual` comparison); `/healthz` and
  `/readyz` stay unauthenticated. Model objects expose only `id`, `object`,
  `created`, and `owned_by`, are listed in configuration order, and resolve
  case-sensitively. Missing/invalid credentials return a fixed OpenAI `401`;
  unknown/case-mismatched ids return a fixed OpenAI `404`; unexpected `/v1`
  failures return a fixed OpenAI `500`. These model metadata routes themselves do
  not call CollectivIQ.
- Credential-redacting Pino logging with content logging off by default.
- Graceful `SIGINT`/`SIGTERM` shutdown.
- Docker packaging and GitHub Actions CI.
- An OpenAPI-grounded CollectivIQ **adapter boundary** (`src/collectiviq/`) for
  the three core operations, with a bounded/cancellation-aware transport, a
  normalized content-free error model (with method-aware retry metadata),
  provisional response validation, an opt-in staged discovery session/CLI
  (preflight by default), a committed filtered OpenAPI snapshot
  (`contract/collectiviq/`), and hermetic mock-server contract tests
  (`test/contract/`).
- **Authenticated, text-only `POST /v1/chat/completions`** (Phase 1B +
  Phase 2), wired through the adapter. It validates/normalizes the OpenAI
  request (text roles and string/text-part content; `n` must be `1`; `stream`
  absent/`false`/`true`), rejects `response_format`, `logprobs`, audio, and
  image/binary content with stable content-free `400`s (tool-role messages and
  assistant `tool_calls` are rejected the same way for text-only `disabled` and
  `native` models, but PARSED for the experimental emulated model, which returns
  model-proposed calls it never executes — see below), tolerates the tool metadata OpenCode attaches
  automatically for text-only models (a bounded `tools` array plus an
  `auto`/`none` `tool_choice`) by discarding it while rejecting any tool use that
  requires or names a tool (Phase 2.1; see below),
  serializes a deterministic versioned prompt, enforces process-local global +
  per-key capacity with a bounded queue (`429` + `Retry-After: 5` when at
  capacity), creates one new CollectivIQ thread, submits once (no `create_thread`/
  `process_message` retries), and polls `get_messages` under a total deadline with
  GET-only retry and desired-source selection. The non-streamed path encodes a
  JSON response with zero (unavailable) usage. Client disconnect, the total
  deadline (`504`), and shutdown share one cancellation path. The foreground
  `collectiviq-claude` **transport** path was observed live on **2026-08-15**
  (response returned, streaming completed, tool metadata discarded, no tool call);
  the returned response objected to the gateway's serialized protocol wrapper, so a
  clean end-to-end answer is **not** yet established — see the status note above;
  further live runs remain approval-gated.
- **Text-only synthetic SSE streaming (`stream: true`)** (Phase 2). The same
  route serves a buffered synthetic `text/event-stream`: it authenticates,
  validates, resolves the model, and prepares the prompt **before** committing
  any SSE header (a preparation failure stays a normal JSON error), then emits an
  assistant-role opener chunk before any upstream work, `: collectiviq-gateway
keep-alive` comments every 15 s while polling waits, deterministic
  code-point-safe content deltas whose concatenation reproduces the answer
  exactly, a terminal `finish_reason: "stop"` chunk, and `data: [DONE]`. No
  `usage` is emitted on a stream. Post-header failures are encoded as one safe
  `data: {"error": …}` record then `[DONE]`; a shutdown emits the content-free
  `503 service_unavailable` record + `[DONE]` **only while the SSE transport
  remains writable** — if the response is backpressured/undrainable or its
  terminal close fails, the gateway force-closes it to preserve the shutdown
  bound and the stream may end silently (delivery of `503` is not guaranteed). A
  client disconnect stops polling, releases capacity, and sends no body.
  Streaming is **synthetic** — it keeps the connection alive but cannot improve
  time-to-first-answer content, and it is **not** true upstream streaming.
- **Experimental, opt-in emulated tool calling** (Phase 3; **non-default**). A
  `toolMode: "emulated"` model asks CollectivIQ to emit a strict versioned
  `tool-or-final` JSON envelope that the gateway parses (in `src/tools/`, using a
  descriptor-safe bounded copy and a per-request Ajv validator whose dialect is
  chosen from each tool schema's root `$schema` — draft-07 by default, and
  draft-07 or draft 2020-12 by an exact URI allowlist, so OpenCode 1.18.21's
  draft-2020-12 built-in tool schemas compile; a non-string or unknown `$schema`
  fails closed) into OpenAI `tool_calls` — for both the JSON path (`content: null`,
  `finish_reason: "tool_calls"`) and the synthetic-SSE path (one complete indexed
  tool-call delta, then a `tool_calls` terminal, then `[DONE]`, no `usage`). It
  validates tool schemas, `tool_choice` (`auto`/`none`/`required`/named),
  `parallel_tool_calls`, and prior tool-call/result history; a required/named
  choice with no valid upstream call maps to `502 invalid_tool_response`. The
  gateway returns model-**proposed** calls only — it never executes, authorizes,
  or simulates a tool; OpenCode still owns permission prompts and execution, and
  each tool-loop round creates a new upstream thread. In emulated mode the
  validated tool schemas, prior arguments, and tool results are serialized into
  the prompt sent to CollectivIQ (never logged or retained). This mode is
  **experimental**: the section-30 release gates are **not met**. The approval-gated
  live evaluator (`npm run eval:tools`) has been run once — a single approved
  2026-08-24 run attempted 149 rounds (all 149 threads confirmed deleted;
  single-round snapshots at 99.3%; the multi-step scenarios never reached and so
  unmeasured, not a measured 0%) but aborted operationally and established no gate.
  It has since been hardened (offline), and its complete post-hardening run has not
  been run. This evaluator run is a separate event from the tool-schema live smoke
  described next. The draft-2020-12
  dialect support closes the confirmed OpenCode 1.18.21 schema-compilation gap both
  **offline** (hermetic suites) and in one **sanitized, user-authorized live smoke
  on 2026-08-24**: OpenCode's built-in `read` schema (draft-2020-12) passed
  validation with no `tools is not supported for this request.` warning, OpenCode
  prompted for permission, the user approved once, `read` executed only after
  approval, and the post-tool completion returned a relevant answer over the two
  expected tool-loop upstream threads (a proposal round and a final-answer round —
  not a hidden title request). That is one observation for the tested
  local/account configuration — not production readiness, repeatability, or a
  cross-account/cross-version guarantee; the gateway only proposes calls while
  OpenCode owns permission and execution. To enable it,
  copy the `collectiviq-claude-tools` model into your ignored `config/models.yaml`
  (see the example file) and use the `collectiviq-tools-experimental` OpenCode
  agent; every existing default stays tool-disabled.

## What is not implemented yet

`GET /metrics`, native CollectivIQ tool calling, and Redis/idempotency.
(Experimental emulated tool calling is implemented but non-default; its section-30
release gates are not met — the live evaluator was run once (a partial 2026-08-24
run that established no gate) and its complete post-hardening run has not been run —
see "What works today".) (Gateway
authentication, the model endpoints, the non-streamed `POST /v1/chat/completions`
path, and text-only synthetic SSE streaming are implemented — see "What works
today". A basic live OpenCode/CollectivIQ foreground **transport** smoke was
observed on 2026-08-15 with a protocol-wrapper refusal on the protocol-mode path;
a sanitized 2026-08-18 smoke then **observed** the committed-default
`collectiviq-claude-direct` profile return a valid answer for the tested account
with a valid `collectiviq-fast` title on its first attempt — a single-account
observation, not production readiness. A long-running keep-alive streaming smoke, a
combined answer, and general non-Claude routing remain not yet verified.) Four authorized authenticated discovery baselines ran: two bearer-mode
runs (2026-08-06/07) **failed strict completeness (exited non-zero)**, and two
`password`-mode runs (2026-08-11) **both passed (exited zero)** with identical
sanitized safe facts. The core create/submit/messages contract and password
`POST /login` are therefore **verified-repeatable** (encoded into synthetic
fixtures; no live value promoted), while masked field names and all field
semantics stay provisional. Thread-deletion outcomes were observed to be
credential/principal-dependent (cause not established). Phase 0 has advanced
substantially but is **not complete** — several provider questions remain open
(see below).

## Prerequisites

- Node.js 24 (`.nvmrc` pins major 24; `engines` requires `>=24 <25`).
- npm (the repository pins `packageManager` and commits `package-lock.json`).

```bash
nvm use
```

## Setup

```bash
cp .env.example .env
cp config/models.example.yaml config/models.yaml
npm ci
```

Both `.env` and `config/models.yaml` are git-ignored. All example credentials
are unmistakably fake placeholders — replace them with your own and never commit
real secrets. The model IDs and source names in the example
(`collectiviq-claude`, `collectiviq-claude-direct`, `collectiviq-consensus`,
`collectiviq-coder`, `collectiviq-fast`, the experimental
`collectiviq-claude-tools`, and the `selectedLlms` entries) are
configurable examples only; they are not verified against any CollectivIQ account
and carry no context-window or token-limit claims. `collectiviq-claude` is the
single-source text policy (`selectedLlms: [claude]`, `generateCombined: false`,
`answerSource: claude`); select it explicitly when a combined response is not
desired.

Each model may set an optional `promptMode`: `protocol` (default when omitted)
serializes the full ordered conversation inside the versioned `COLLECTIVIQ GATEWAY
PROTOCOL` envelope, while `direct` submits **only** the latest user message content
verbatim — no protocol header, no JSON envelope, no role labels, and none of the
system/developer/assistant/earlier-user messages. `direct` is intentionally lossy
(it discards system/developer instructions and conversation history) and exists as
an account-specific compatibility profile for `collectiviq-claude-direct`; it is
**not** a role-preserving translation and **not** prompt-injection prevention.

Because the committed `opencode.jsonc` now defaults the foreground and `small_model`
selections to `collectiviq/collectiviq-claude-direct`, **you must add the
`collectiviq-claude-direct` model to your local `config/models.yaml` manually**
(copy the block from `config/models.example.yaml`) before that default resolves —
the local model file is git-ignored and is not updated by this change.

## Local development

```bash
npm run dev      # watch mode via tsx (loads .env if present)
npm run build    # compile TypeScript into dist/
npm start        # run dist/index.js with externally supplied environment
```

The service binds to `127.0.0.1:8787` by default (loopback only).

```bash
curl http://127.0.0.1:8787/healthz   # {"status":"ok"}
curl http://127.0.0.1:8787/readyz    # {"status":"ready"} once listening
```

The `/v1/*` endpoints require a gateway key from `COLLECTIVIQ_GATEWAY_KEYS`
(replace the fake placeholder below with one of your configured keys):

```bash
# List configured virtual models
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer gw-fake-key-change-me"

# Retrieve one model by id
curl http://127.0.0.1:8787/v1/models/collectiviq-consensus \
  -H "Authorization: Bearer gw-fake-key-change-me"

# Missing/invalid credentials return a fixed OpenAI 401 envelope
curl -i http://127.0.0.1:8787/v1/models
```

### Chat completions (text only; non-streamed JSON or synthetic SSE)

`POST /v1/chat/completions` accepts the bounded OpenCode Chat Completions
profile: text-only `system`/`developer`/`user`/`assistant` messages with string
or `{ "type": "text", "text": … }` content, `n` absent or `1`, and `stream`
absent, exactly `false` (non-streamed JSON), or exactly `true` (synthetic SSE).
Each request creates one new CollectivIQ thread, so a live request needs a real
`COLLECTIVIQ_*` upstream credential.

```bash
# Non-streamed JSON (stream absent or false)
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer gw-fake-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "collectiviq-consensus",
    "messages": [{ "role": "user", "content": "Explain this function." }]
  }'
```

Setting `"stream": true` returns a `text/event-stream` instead: an assistant-role
opener chunk, `: collectiviq-gateway keep-alive` comments while the answer is
polled, buffered `chat.completion.chunk` content deltas whose concatenation
reproduces the answer exactly, a terminal `finish_reason: "stop"` chunk, and a
final `data: [DONE]` line. Streaming carries no `usage` field. It is **synthetic**
(the complete answer is polled, then split into deltas) — it keeps the connection
alive but does not deliver upstream tokens as they are produced.

```bash
# Synthetic SSE stream
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer gw-fake-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "collectiviq-consensus",
    "stream": true,
    "messages": [{ "role": "user", "content": "Explain this function." }]
  }'
```

The request surface is strict: a non-boolean `stream`, and the
mere **own-property presence** of `response_format`, `logprobs`, or `audio` — even
when empty, `null`, an explicit `undefined`, or otherwise harmless — is rejected
with a stable `400`, as is any image/binary content. Message `tool_calls` and
tool-role messages are likewise presence-rejected for text-only
(`toolMode: disabled`) models, but an `emulated` model PARSES them into normalized
prior tool calls / tool results (see below). (Presence is decided without reading
the field's value, so a value getter is never invoked and an inherited property
never counts.)

For **`toolMode: disabled`** models (every committed default), `tools` and
`tool_choice` are handled by a **model-policy-aware compatibility bridge (Phase
2.1)**, because OpenCode attaches tool definitions to every request even when all
tool permissions are denied. In this disabled-mode bridge a tool definition is
never semantically interpreted, retained, serialized into the prompt, forwarded
upstream, logged, reflected, persisted, or executed; it is traversed only through
data-property descriptors for bounded JSON-shape and byte accounting, and
submitted accessors and executable hooks (getters, `toJSON`, iterators) are never
invoked. The gateway TOLERATES the metadata: it accepts an own `tools` array of at
most **128** entries whose **entire JSON encoding is at most 2 MiB**
(`MAX_TOOL_SCHEMA_BYTES`, spec §21.6), and a `tool_choice` of exactly `"auto"` or
`"none"`, records only the parameter NAMES in the ignored-parameter header, and
never emits a tool call. Actual tool calling stays disabled here: a `tool_choice`
of `"required"` or a named function; a non-array, over-count, or over-budget
`tools` value; an accessor, cycle, sparse/exotic/over-deep structure, or
unsupported value anywhere in the collection; or any tool metadata sent to a
`native` model (not implemented) is rejected with a stable content-free `400`
(`unsupported_parameter`). `tools` is validated before `tool_choice`.

For an **`emulated`** model (experimental, opt-in, non-default) the tool policy is
instead NORMALIZED and RETAINED: the toolset is compiled once, prior tool history
is validated, the validated schemas/arguments/results **ARE** serialized into the
upstream prompt (never logged or retained), `parallel_tool_calls` is CONSUMED (a
non-boolean is rejected with `param: "parallel_tool_calls"`), and the gateway can
return model-**proposed** tool calls — which it never executes. Accepted-but-ignored optional fields (`temperature`,
`top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `user`, `store`,
and — for `disabled` models only — `parallel_tool_calls`) are surfaced by NAME
only in an optional `X-CollectivIQ-Ignored-Parameters` response header (on the
streamed path this header is set before the SSE body is committed); their values
are never read or logged. (In `emulated` mode `parallel_tool_calls` is consumed,
not ignored, so it is not reported in that header.) Non-streamed responses report `usage` zeros, which denote **unavailable**
token counts — not estimates and not exact billing usage; streamed responses omit
`usage` entirely.

For OpenCode, point `@ai-sdk/openai-compatible` at `http://127.0.0.1:8787/v1`
with a gateway key as `apiKey` (see specification section 25 for a full example).
The committed `opencode.jsonc` ships a text-only default `collectiviq-text`
primary agent with a wildcard permission `deny`. Denying permissions stops
OpenCode from executing tools but does **not** stop it from sending tool
definitions to the model, so the agent relies on the disabled-mode compatibility
bridge above to discard that metadata. Its foreground `model`, the top-level
`model`, and `small_model` are all set to `collectiviq/collectiviq-claude-direct`
— a Claude source (the only source currently observed to answer for this account;
non-Claude routing is blocked upstream, see the note below) using
`promptMode: direct`, which submits only the latest user message without the
gateway protocol wrapper the account objected to. This profile is intentionally
lossy (no system/developer instructions or conversation history). A sanitized,
user-authorized **2026-08-18** smoke **observed it resolve that refusal for the
tested account** — a sanitized single-account observation, not production
readiness or a repeatable upstream guarantee. The protocol-mode `collectiviq-claude` and the
`collectiviq-consensus`/`collectiviq-coder`/`collectiviq-fast` models remain
declared. **Add `collectiviq-claude-direct` to your local `config/models.yaml`
manually** (git-ignored) before this default resolves.

OpenCode's built-in **hidden LLM `title` agent is disabled** in the committed
`opencode.jsonc` (`"title": { "disable": true }`), so it creates **no** separate
title thread or completion. As a result a first foreground message creates
**exactly one** CollectivIQ thread — the earlier "two or more upstream threads per
session" behavior no longer applies. In its place, a dependency-free plugin
(`.opencode/plugins/collectiviq-native-title.ts`) propagates the
CollectivIQ-generated **native** thread title to the OpenCode session
asynchronously: it arms only a parentless top-level session still on OpenCode's
default title, attaches an `X-CollectivIQ-OpenCode-Session-ID` header once, and
after `session.idle` polls the authenticated `GET /v1/opencode/session-title`
extension on a bounded, capped schedule (immediately, then 2/4/8/8/8 s), renaming
the session only if its title is still the exact captured default. Arming reads
session metadata from OpenCode lifecycle events (no async lookup in the normal
case) and only for a not-yet-observed session falls back to a small, bounded,
fail-open `session.get`, so it adds at most a bounded delay to the foreground
request — never an indefinite one. It never overwrites a manual or
already-propagated title and is best-effort — any failure leaves OpenCode's
default/manual title. Native-title polling adds only bounded `GET` requests and creates no additional
upstream thread. `collectiviq-fast` is no longer the title agent's model but
remains declared for manual/other-account use.

To authenticate that lookup, the plugin **reuses the resolved CollectivIQ provider
credential** — `provider.collectiviq.options.apiKey` from OpenCode's merged config
(OpenCode substitutes `{env:…}`/`{file:…}` references before the plugin reads it).
**You do not need a separate terminal `COLLECTIVIQ_GATEWAY_KEY` export** once your
OpenCode provider is configured with a working `apiKey`; `COLLECTIVIQ_GATEWAY_KEY`
remains only a compatibility fallback. Base URL and key are resolved together in one
bounded, descriptor-safe step (a valid provider key wins over the env fallback; the
key is used exactly, capped at 8192 UTF-8 bytes, and unresolved `{env:…}`/`{file:…}`
placeholders are rejected). The resolved key is transient — used only for the
in-flight lookup and never logged, reflected, cached, or stored in session state. (An
earlier post-loader-fix trace reached provider matching, header attachment, and idle
handling but stopped before the first lookup because the earlier environment-only key
source was absent; reusing the provider-config credential fixed that.)

The plugin is committed and discovered **project-locally** by default. Its entry
module **default-exports the OpenCode V1 `{ id, server }` plugin object** — not a
bare function — so OpenCode 1.18.21's loader invokes only `default.server` and
never scans the module's named runtime exports. (A sanitized, user-authorized
**2026-08-21** smoke ran with hidden title generation disabled and a single
foreground thread; CollectivIQ generated a provider-native title, but the OpenCode
session rename did not occur because the plugin **entry module never loaded**: the
earlier bare-**function** default fell through to OpenCode's legacy export scan,
which rejects the first non-function runtime export (e.g. `UPDATE_TIMEOUT_MS`) with
`Plugin export is not a function` — for both the global-symlink and project-local
paths — so the provider matching, header attachment, polling, and rename logic
never ran. Changing the default export to the V1 `{ id, server }` object, together
with reusing the provider-config credential, fixed the propagation path. A sanitized,
user-authorized **2026-08-22** live smoke then observed the **complete path succeed
for the tested local configuration** on OpenCode 1.18.21: exactly one new foreground
CollectivIQ thread, no hidden title thread, a provider-native title generated for
that thread, and the OpenCode session title changed from its default to that title
(the foreground response completed and was relevant, with no alert or tool call).
This is a single-local-configuration observation — **not** production readiness, a
cross-account/cross-version guarantee, or a claim about which credential source was
exercised; propagation stays best-effort and a failure leaves the OpenCode default or
manual title. No live prompts, titles, answers, ids, credentials, or account values
are recorded, and further live runs remain approval-gated.)

Separately, the plugin matches the provider OpenCode passes to its `chat.headers`
hook using a descriptor-safe reader that tolerates **both** provider shapes —
OpenCode's SDK declaration exposes the provider id at `provider.info.id`, while the
runtime may pass a flat `provider.id`. This dual-shape support is implemented and
hermetically tested as offline hardening; it was **not** the proven cause of the
2026-08-21 live failure (the plugin never loaded, so provider matching never ran).
The plugin also shares one hooks/state instance process-wide across global +
project-local loads (`Symbol.for(...)` singleton, first-initialization-wins).

#### Optional: global install for cross-project use

To use native-title propagation from **any** project (not only this repository),
symlink the committed plugin into your global OpenCode plugins directory:

```bash
mkdir -p "$HOME/.config/opencode/plugins"
ln -s /absolute/path/to/ciq-gateway/.opencode/plugins/collectiviq-native-title.ts \
  "$HOME/.config/opencode/plugins/collectiviq-native-title.ts"
```

Operational notes:

- Do **not** overwrite the target if another file or link already exists there.
- Moving the `ciq-gateway` repository breaks the symlink; recreate it afterward.
- Fully **restart** OpenCode after installing the link or updating the plugin
  source — plugin loading happens at startup.
- The link points at repository source, so ordinary edits to the plugin are
  reflected automatically after the restart above.
- Your **global** OpenCode config must also declare the CollectivIQ provider and
  the `collectiviq-text` agent and disable the hidden `title` agent (mirroring this
  repository's `opencode.jsonc`), using environment references for the gateway key
  rather than embedded credentials.
- When you open the `ciq-gateway` repository itself, OpenCode discovers **both**
  the global link and the project-local copy; the plugin de-duplicates itself into
  one shared instance per process, so duplicate loading is harmless (one header,
  one poller, one rename per session).
- The globally loaded plugin still gates on the exact `collectiviq-text` agent and
  `collectiviq` provider; it does nothing for any other agent or provider request.

The OpenCode session title is **distinct** from the CollectivIQ upstream thread
title: the gateway still performs exactly one `create_thread` per completion using
the fixed, content-free placeholder `New Thread`, and never forwards any
prompt-derived or OpenCode-generated title upstream. A sanitized 2026-08-18
observation found that CollectivIQ may **asynchronously** replace `New Thread` with
its own prompt-related, server-generated thread title after `process_message`; that
native title is prompt-derived provider metadata, produced and persisted
provider-side (and, after propagation, stored by OpenCode as the session title).
The gateway reads it only transiently to serve the session-title extension and
never logs, caches, or retains it. The extension endpoint, its
`X-CollectivIQ-OpenCode-Session-ID` header, the process-local correlation bounds,
and the observed-only `get_threads` lookup are documented in
[`.agent/docs/tech-software-spec.md`](.agent/docs/tech-software-spec.md)
sections 9.5, 10.4, and 25.

A basic live foreground OpenCode/CollectivIQ **transport** smoke was observed on
**2026-08-15** (protocol-mode `collectiviq-claude` response returned, synthetic
streaming completed, tool metadata accepted and discarded with no tool call), on
which the returned response objected to the gateway's serialized protocol wrapper
as embedded identity/instruction manipulation. The remediation — the
`collectiviq-claude-direct` profile (`promptMode: direct`), the committed OpenCode
default — was **observed to resolve that refusal for the tested account** in a
sanitized 2026-08-18 smoke: a natural coding request returned a relevant, correct
answer, synthetic streaming completed with no protocol objection / tool alert /
tool call, and (at that time, before the hidden LLM title agent was disabled) the
hidden `collectiviq-fast` title request returned a valid title on its **first**
attempt. That is a single-account observation of the foreground path (and the
historical title path), **not** production readiness or a repeatable guarantee, and
it does **not** prove general non-Claude routing (which stays blocked account-side,
see the note below); a long-running streaming smoke and a combined answer are
likewise unverified. Any further live run requires separate approval before live
CollectivIQ traffic and may incur provider cost.

**Account-specific upstream routing limitation.** For the CollectivIQ account
used during discovery, generic gateway prompts were classified by the account as
Atlassian queries, and non-Claude sources were skipped as unsupported for that
query category. The `selected_llms`, `generate_combined`, and
`llms_explicitly_set=true` submit fields did not provide a verified override, and
the filtered OpenAPI snapshot exposes no documented generic/non-Atlassian routing
field. The gateway therefore cannot currently claim verified GPT/Gemini/Grok
execution for this account; this is an account-side routing observation and does
not generalize to every CollectivIQ account.

## Validation

```bash
npm run validate        # format check, lint, typecheck, tests, build, build smoke
```

Individual checks:

| Command                    | Purpose                                       |
| -------------------------- | --------------------------------------------- |
| `npm run format:check`     | Prettier formatting check                     |
| `npm run lint`             | ESLint (typed rules)                          |
| `npm run typecheck`        | Strict `tsc --noEmit` over sources and tests  |
| `npm test`                 | Vitest unit + integration + contract suites   |
| `npm run test:unit`        | Unit tests only                               |
| `npm run test:integration` | Server integration tests only                 |
| `npm run test:contract`    | Hermetic upstream contract tests (mock HTTP)  |
| `npm run test:coverage`    | Tests with V8 coverage                        |
| `npm run build`            | Compile to `dist/`                            |
| `npm run test:build`       | Import compiled output; assert no open socket |

`validate` is hermetic: it makes no network, live-upstream, Docker, or load
checks. The contract suite runs against a local mock HTTP server.

`npm run test:compatibility` is a **separate** hermetic suite
(`test/compatibility/`, its own `vitest.compatibility.config.ts`) that drives the
pinned `ai` + `@ai-sdk/openai-compatible` SDK (matching the OpenCode client) via
`streamText`/`generateText` against an ephemeral loopback gateway with a **fake**
completion — no CollectivIQ, no real credential, no network. It includes the
experimental tool-calling checks (a real tool call and an in-memory three-step
read/edit/test loop). It is intentionally excluded from `validate`/CI and is run
on its own. `ai` and `@ai-sdk/openai-compatible` are pinned **dev** dependencies
used only by this suite.

`npm run test:adversarial` is another **separate** hermetic suite
(`test/adversarial/`, its own `vitest.adversarial.config.ts`): the tool-protocol
release-gate corpus (≥200 deterministic cases — malformed envelopes, fence edge
cases, injection-shaped prose, schema edge cases, choice/parallel enforcement,
candidate disagreement, hostile object structures, determinism) run against the
pure engine. No network, credentials, or CollectivIQ. Excluded from `validate`/CI.

`npm run eval:tools` is the **approval-gated LIVE tool evaluator** that measures the
section-30 release gates against the real CollectivIQ origin. Its default invocation
is a credential-free, network-free **preflight**; the fully-approved live path
(`--execute-approved --cost-approved --cleanup-approved --recovery-journal-approved`,
password auth only, 200 single-round + 20 three-step scenarios, hard cap 280
completions, per-request thread cleanup, ID-only recovery journal) is network-only
and must **never** be added to `validate`/CI. It has been run exactly once: a single
approved run on **2026-08-24** attempted 149 rounds (all 149 created threads
confirmed deleted; partial single-round snapshots read 99.3%) but aborted
operationally under the evaluator's earlier ambiguous report, with the three-step
multi-step scenarios never reached and therefore unmeasured (NOT a measured 0%), so
it established no gate. The evaluator has since been hardened (offline): a versioned
value-free output union (`preflight | progress | blocked | executed`), a four-state
gate status (`passed | failed | incomplete | not_evaluated`; a zero denominator is
`not_evaluated`, never 0%; a partial sample is `incomplete`, never `passed`),
structured value-free abort diagnostics, and a content-free resume checkpoint at the
ignored `.agent/sessions/eval/tools-eval-checkpoint.json` gated behind a new
`--resume-approved` flag. Four further remediations are now enforced (code +
hermetic tests): the checkpoint is semantically validated against the real
evaluation plan before any credential or network I/O — so a forged
"complete + passing, zero-attempt" checkpoint can never grant a zero-network pass;
a non-resumable abort writes a durable `blocked` tombstone that a resume run rejects
until an operator archives or removes it; checkpoint files require an exact `0600`
mode with symlink-safe ancestry; and the recovery journal is finalized exactly once
through one explicit finalization state machine. Its complete post-hardening run has
**not been run**, so the gates remain not met and emulated tool mode stays
experimental.

## CollectivIQ contract tooling

The upstream contract is grounded in the published OpenAPI document and captured
as a deterministic, filtered snapshot at
[`contract/collectiviq/openapi-filtered.json`](contract/collectiviq/openapi-filtered.json)
(ten allowlisted operations only, including `POST /login` for the OAuth2 password
mode; the full 422-path document is never committed). See
[`.agent/docs/collectiviq-upstream-contract.md`](.agent/docs/collectiviq-upstream-contract.md).

These commands need network access and are **excluded from `validate` and CI**:

| Command                              | Purpose                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `npm run contract:openapi:check`     | Fetch the public OpenAPI doc and report drift vs the committed snapshot                                            |
| `npm run contract:openapi:refresh`   | Fetch and write a review candidate under `.agent/sessions/` (untracked)                                            |
| `npm run contract:discovery`         | Opt-in live discovery (requires credentials + explicit approval)                                                   |
| `npm run contract:discovery:cleanup` | Recovery-only: delete leaked session threads listed in the recovery journal (requires credentials + all approvals) |

Four authorized `contract:discovery` baselines were run: two on 2026-08-06 and
2026-08-07 in **bearer** mode (both failed strict completeness), and two on
**2026-08-11 in `password` mode that BOTH passed strict completeness (exited
zero)** with **identical** sanitized results. The core create/submit/messages
contract and password `POST /login` are therefore **verified-repeatable** and
encoded into synthetic fixtures (no live value committed). Thread-deletion
outcomes were **credential/principal-dependent** (cause not established): the
password/member principal deleted its own newly created thread (`200`, repeated)
while re-deleting that same just-deleted id returned `403`; the API-key
principal's own-thread delete returned `403` (2026-08-07); a cross-principal
recovery attempt also returned `403` — consistent with a permission/scope check,
but the provider's evaluation order is unconfirmed, so recovery's exact-`404`
convergence was not exercised. Phase 0 has advanced substantially but is not
auto-declared complete — open provider questions remain (idempotency,
ordering/pagination, prompt/rate limits, retention, native tools, SSE scope,
token lifetime). It runs a single
bounded `baseline` session against a **fixed** destination origin
(`https://api.prod.collectiviq.ai`) — no origin, path, thread-id, or run-id may
be supplied. The **default invocation is preflight only**: it validates the
model selection (`CIQ_DISCOVERY_SINGLE_LLM`, `CIQ_DISCOVERY_COMBINED_LLMS`) and
reports bounded projected operation counts and which approvals are set, **without
reading the credential or making any network request**. Authenticated execution
requires `--execute-approved` **and** `--recovery-journal-approved`; deleting
session-owned threads requires `--cleanup-approved` (never automatic); the
not-found probe requires `--observe-not-found-approved` **and**
`--cleanup-approved` (these invariants are also re-checked inside the runner
before any request). `--recovery-journal-approved` enables a private, content-free
recovery journal under the ignored `.agent/sessions/discovery/` that records at
most two created thread ids (format version + fixed origin + ids only — no
credentials, run ids, content, or timestamps) so a leaked thread can be recovered;
each id is recorded immediately and dropped after a confirmed deletion. If a run
leaves threads behind, `npm run contract:discovery:cleanup` (network-only, opt-in,
excluded from `validate`/CI; requires `--execute-approved`, `--cleanup-approved`,
and `--recovery-journal-approved`) deletes only the ids in that journal.
Token-inspection and abort discovery are disabled until request correlation is
safely established. Evidence
is captured from the **raw** upstream body for any status (so run ids and error
shapes survive) and immediately reduced to sanitized structure; correlation ids
stay private and are reported only as a value-free
`matched`/`not-matched`/`not-observed` comparison. Cleanup reports a truthful
`attempted`/`succeeded`/`failed`/`remaining` ledger (HTTP DELETE outcomes only)
plus `journalPersistenceFailed` and a bounded list of value-free per-attempt
summaries (phase, `ok`, HTTP status or null, safe error code or null, and
`journalPersisted` — `true`/`false`/`null` — no ids, paths, or bodies) so a
cleanup `403` is distinguishable from a timeout/network failure. A thread is
dropped from the in-memory ledger on a confirmed HTTP DELETE even when its
journal removal fails (the stale journal converges through recovery's exact-`404`
handling); any such `journalPersistenceFailed > 0` is a non-zero-exit condition.
The exit code follows strict session completeness. Strict completeness also requires an `available_llms` observation
and accepts either a **structurally valid** `2xx` success (top level a non-null,
non-array object with an own `llms` object holding at least one object entry;
extra properties allowed and no model value inspected) or exactly a `403` (an
observed inventory-access restriction) for that endpoint; a malformed `2xx` body
is a **failed** observation (`invalid_upstream_response`) that drives a non-zero
exit. If a thread is created upstream but its id cannot be durably persisted to
the recovery journal, the run **aborts immediately** — no further upstream
request — attempts cleanup for the already-owned thread, and exits non-zero with a
content-free `aborted: "journal-persistence-failed"` result. The recovery-only
`contract:discovery:cleanup` command resolves a journal-owned id on a `2xx`
(`deleted`) **or** an exact `404` (`already_absent`) so recovery converges after a
crash between a successful delete and the journal update, and reports
`{ attempted, resolved, unresolved, remaining, attempts }` (exit non-zero when
`unresolved > 0 || remaining > 0`). Output is limited to sanitized structural
captures (constant type markers only — no credentials, content, value lengths,
identifiers, headers, or raw bodies) stamped with an `evidenceFormatVersion`;
`--write` governs only whether a sanitized baseline evidence report is persisted
under `.agent/sessions/`. Run identifiers stay in memory and are never printed or
persisted; thread identifiers stay in memory except that, when
`--recovery-journal-approved` is set, at most two are written content-free to the
recovery journal (independently of `--write`, durable-first) purely for recovery
and removed after confirmed deletion.

## Docker

The image is multi-stage, pinned to a Node 24 bookworm-slim digest, and runs as
the non-root `node` user. It contains no secrets.

```bash
docker build -t collectiviq-gateway:local .
```

With Compose (publishes only to host loopback):

```bash
cp config/models.example.yaml config/models.yaml
# bearer mode (default):
export COLLECTIVIQ_API_KEY=sk-fake-upstream-key-change-me
# or password mode instead:
#   export COLLECTIVIQ_AUTH_MODE=password
#   export COLLECTIVIQ_USERNAME=fake-user@example.com
#   export COLLECTIVIQ_PASSWORD=fake-password-change-me
export COLLECTIVIQ_GATEWAY_KEYS=gw-fake-key-change-me
docker compose up --build
```

The container binds `HOST=0.0.0.0` internally, but Compose publishes the port
only on `127.0.0.1:8787`. Credentials are supplied via environment
interpolation; none are stored in `compose.yaml`. Compose forwards
`COLLECTIVIQ_AUTH_MODE` and both credential sets softly and no longer
hard-requires `COLLECTIVIQ_API_KEY` — `password` mode runs without it — while the
gateway validates the mode-appropriate credential at startup. Only
`COLLECTIVIQ_GATEWAY_KEYS` keeps a fail-fast guard.

## Configuration reference

| Variable                          | Required | Default                           | Notes                                                                                                     |
| --------------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`                     | no       | `production`                      | `development` \| `staging` \| `production`                                                                |
| `HOST`                            | no       | `127.0.0.1`                       | Loopback by default                                                                                       |
| `PORT`                            | no       | `8787`                            | 1–65535                                                                                                   |
| `COLLECTIVIQ_BASE_URL`            | no       | `https://api.prod.collectiviq.ai` | Must be an absolute http(s) URL                                                                           |
| `COLLECTIVIQ_AUTH_MODE`           | no       | `bearer`                          | `bearer` \| `password`; selects the upstream credential                                                   |
| `COLLECTIVIQ_API_KEY`             | bearer   | —                                 | Bearer-mode upstream token (≤16 KiB, preserved exactly); required when `COLLECTIVIQ_AUTH_MODE=bearer`     |
| `COLLECTIVIQ_USERNAME`            | password | —                                 | Password-mode username (trimmed, ≤320 bytes); required when `COLLECTIVIQ_AUTH_MODE=password`              |
| `COLLECTIVIQ_PASSWORD`            | password | —                                 | Password-mode password (preserved exactly, ≤4096 bytes); required when `COLLECTIVIQ_AUTH_MODE=password`   |
| `COLLECTIVIQ_GATEWAY_KEYS`        | **yes**  | —                                 | Comma-separated client keys; trimmed, de-duplicated, ≤64 keys, ≤8192 UTF-8 bytes/key; enforced on `/v1/*` |
| `MODEL_CONFIG_PATH`               | no       | `./config/models.yaml`            | Path to the YAML model file                                                                               |
| `LOG_LEVEL`                       | no       | `info`                            | Pino level                                                                                                |
| `LOG_CONTENT`                     | no       | `false`                           | May be `true` only when `ENVIRONMENT=development`                                                         |
| `MAX_REQUEST_BODY_BYTES`          | no       | `8388608`                         | 1024 – 67108864                                                                                           |
| `MAX_CONCURRENT_REQUESTS`         | no       | `4`                               | Global active completions (process-local); 1–1024                                                         |
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | no       | `2`                               | Per-gateway-key active completions; 1–1024 and ≤ `MAX_CONCURRENT_REQUESTS`                                |
| `MAX_QUEUED_REQUESTS`             | no       | `20`                              | Bounded admission queue length; 0–100000 (0 disables queueing)                                            |
| `MAX_QUEUE_WAIT_MS`               | no       | `5000`                            | Max time in the admission queue before a `429`; 1–600000                                                  |
| `SHUTDOWN_DRAIN_MS`               | no       | `30000`                           | Graceful-shutdown drain before in-flight polling is cancelled; 0–600000                                   |

The upstream credential authenticates the gateway to CollectivIQ: in `bearer`
mode `COLLECTIVIQ_API_KEY` is sent as a static bearer token; in `password` mode
`COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` are exchanged at `POST /login` for a
short-lived bearer token held in memory (login **verified-live** on 2026-08-11;
token lifetime/refresh still unverified). The inactive mode's credentials may be
set but are ignored.
`COLLECTIVIQ_GATEWAY_KEYS` authenticate clients (OpenCode) to the gateway.
Gateway authentication is **implemented and mandatory** on every `/v1/*` route
(`/healthz` and `/readyz` stay open): a client presents
`Authorization: Bearer <gateway-key>`, the scheme is matched case-insensitively,
and the token is compared **exactly** against the configured keys with a
fixed-length SHA-256 + `timingSafeEqual` comparison. There is no
authentication-disable switch. The upstream and gateway credentials are never
conflated or forwarded, and both are redacted from logs. Even in development,
this scaffold does not log request or model content; enabling `LOG_CONTENT=true`
(development only) emits a single fixed warning line and nothing else.

## Model configuration limits

The model file is bounded by fixed, non-overridable foundation limits. Relaxing
any of them is a configuration-contract/security change, not a runtime override.

| Limit                         |                   Value |
| ----------------------------- | ----------------------: |
| Model file size               | 1,048,576 bytes (1 MiB) |
| Virtual models                |                    1–64 |
| Selected sources per model    |                    1–32 |
| Model id length               |             1–128 chars |
| Display-name length           |             1–256 chars |
| Source / answer-source length |             1–128 chars |
| Request timeout               |        1,000–600,000 ms |
| Poll interval                 |           100–60,000 ms |
| Maximum poll interval         |           100–60,000 ms |
| Maximum prompt bytes          |        1,024–67,108,864 |

Additional rules: the path must be a regular file; YAML aliases and duplicate
keys are rejected; the model map must be non-empty; model ids, display names, and
source names must be non-empty and free of leading/trailing whitespace
(case-sensitive); and `pollIntervalMs ≤ maxPollIntervalMs ≤ requestTimeoutMs`.
Invalid configuration is reported as stable, value-free field/reason pairs that
never include model ids, unknown field names, submitted values, file contents,
or filesystem paths.

## Diagnostics and logging

- **Startup failures** print either a sanitized configuration issue list (field
  names and fixed reasons only) or the single fixed line
  `gateway failed to start (internal error)`. Arbitrary exception messages,
  stacks, causes, and paths are never emitted.
- **Log sanitization**: the logger recursively sanitizes every record — nested
  fields, arrays, and child-logger bindings — with bounded depth, width, and
  string length, redacts credential-shaped keys, and reduces error objects to a
  fixed name/code. This is defense in depth; request and model content are never
  logged in the first place.
- **Content warning**: when `LOG_CONTENT=true` (development only), a single fixed
  warning line is written to stderr regardless of `LOG_LEVEL` — including
  `silent`.

## Security

See [SECURITY.md](SECURITY.md). Health and readiness responses are fixed,
bounded JSON and make no live CollectivIQ call.
