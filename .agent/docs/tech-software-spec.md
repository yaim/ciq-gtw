# CollectivIQ OpenAI-Compatible Gateway

## Technical Software Specification

**Document status:** Draft v0.1
**Date:** August 5, 2026
**Working name:** `collectiviq-gateway`
**Primary client:** OpenCode
**Upstream provider:** CollectivIQ
**Compatibility target:** OpenAI Chat Completions API

---

## 1. Executive Summary

The CollectivIQ Gateway is a local or privately hosted HTTP service that allows OpenCode to use CollectivIQ as an AI provider.

OpenCode will communicate with the gateway using an OpenAI-compatible API:

```text
POST /v1/chat/completions
GET  /v1/models
```

The gateway will translate those requests into CollectivIQ’s custom workflow:

```text
POST /create_thread
POST /process_message
GET  /get_messages?thread_id=...
```

The gateway will then translate CollectivIQ responses back into OpenAI Chat Completions response objects.

OpenCode officially supports custom providers using `@ai-sdk/openai-compatible` for `/v1/chat/completions` endpoints. OpenCode also sends tool definitions to its language model so that the model can invoke coding tools such as file reading, editing, searching, and shell execution.

The gateway must therefore support two distinct operating capabilities:

1. **Text and consensus generation**
2. **OpenCode tool calling**

Text generation can be implemented directly from the supplied CollectivIQ sample.

Tool calling is not demonstrated by the supplied CollectivIQ API. The first gateway release will therefore implement an optional prompt-mediated tool-call protocol. This mechanism must be considered experimental until it meets the release-quality test thresholds defined in this specification. Those thresholds are now met, and the mechanism is **supported opt-in beta** — still non-default and still OpenCode permission-gated; section 30 owns the graduation decision.

The gateway must not attempt to execute OpenCode tools itself. It only translates tool definitions and model-generated tool requests. OpenCode remains responsible for authorizing and executing tools.

---

## 2. Background

### 2.1 CollectivIQ API behavior

The supplied API sample demonstrates the following workflow:

1. Authenticate with a bearer token — either a static `COLLECTIVIQ_API_KEY`
   (`bearer` mode) or a short-lived token obtained from `POST /login` with a
   username/password (`password` mode); see section 21.1.
2. Create a thread.
3. Submit one prompt to one or more selected models.
4. Optionally request a combined response.
5. Poll the thread until the requested answer appears.
6. Read individual and combined messages from the thread.
7. Optionally observe account-level events through Server-Sent Events.

The relevant upstream endpoints are:

```text
POST /create_thread
POST /process_message
GET  /get_messages
GET  /user/events
```

The supplied sample indicated that `create_thread` and `process_message` accept `multipart/form-data`. The published OpenAPI document (`3.1.0`, retrieved 2026-08-05) corrects this: `POST /create_thread` accepts **`application/x-www-form-urlencoded`**, while `POST /process_message` accepts `multipart/form-data`. See [`collectiviq-upstream-contract.md`](collectiviq-upstream-contract.md) for the full grounded contract, evidence states, and the committed filtered snapshot.

The sample also indicates that a returned message may contain:

```json
{
  "source": "combined",
  "content": "Response text",
  "percent_usage": 42
}
```

The exact schemas, status codes, completion states, event schemas, rate limits, and error contracts are undocumented in the supplied material.

CollectivIQ publicly describes its product as sending prompts to multiple leading models and synthesizing their outputs into a combined answer.

### 2.2 OpenCode provider behavior

OpenCode supports a custom OpenAI-compatible provider configuration using:

```json
{
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "baseURL": "https://example.com/v1"
  }
}
```

The package targets `/v1/chat/completions`. OpenCode documents `@ai-sdk/openai` separately for providers using `/v1/responses`.

This gateway will implement `/v1/chat/completions` because:

* it is the documented target of `@ai-sdk/openai-compatible`;
* it has a relatively bounded compatibility surface;
* it supports assistant tool calls and tool-result messages;
* it can represent streamed and non-streamed responses.

OpenAI’s Chat Completions schema represents tool calls using an assistant message containing `tool_calls`, while tool results are sent back as `role: "tool"` messages associated with `tool_call_id`.

---

## 3. Goals

### 3.1 Primary goals

The gateway shall:

1. Allow OpenCode to select CollectivIQ as a custom provider.
2. Accept OpenAI-compatible Chat Completions requests.
3. Translate full OpenCode conversations into CollectivIQ prompts.
4. Support configurable CollectivIQ model ensembles.
5. Return individual or combined CollectivIQ answers.
6. support `stream: false`;
7. support `stream: true` through an OpenAI-compatible SSE response;
8. represent model-requested OpenCode tools as OpenAI `tool_calls`;
9. support multiple model/tool/model interaction rounds;
10. isolate all CollectivIQ-specific logic behind a typed upstream adapter;
11. avoid storing source-code content by default;
12. expose health, readiness, metrics, and structured operational logs;
13. run locally through Docker or a native Node.js process;
14. fail predictably when CollectivIQ is unavailable or returns malformed data.

### 3.2 Secondary goals

The gateway should:

* allow different virtual models to select different CollectivIQ ensembles;
* support request idempotency;
* support local multi-user operation;
* provide diagnostic response headers;
* provide configurable fallback behavior;
* support future native CollectivIQ tool calling without changing the public gateway API;
* support true upstream streaming if CollectivIQ later exposes request-correlated events.

---

## 4. Non-Goals

The first production release will not:

* implement the OpenAI Responses API;
* implement embeddings, image generation, audio, files, batches, assistants, or fine-tuning;
* expose raw CollectivIQ credentials to OpenCode;
* execute OpenCode tools;
* provide a web-based administration interface;
* guarantee exact token accounting;
* guarantee that CollectivIQ’s combined answer preserves structured tool calls;
* use CollectivIQ’s web sidebar as authoritative conversation storage;
* support multimodal OpenCode requests;
* persist complete prompts or source files by default;
* recreate every optional OpenAI Chat Completions parameter.

---

## 5. Architectural Principles

### 5.1 The public API is stateless

Every `/v1/chat/completions` request contains the conversation history required for that generation.

The gateway must not depend on a prior gateway request being available.

By default the gateway creates a new CollectivIQ thread for every completion request. It submits a serialized version of the full OpenAI message history as one CollectivIQ prompt.

This design prevents synchronization errors between:

* OpenCode’s conversation state;
* gateway state;
* CollectivIQ thread state.

It also ensures that gateway restarts do not break active OpenCode sessions.

The costs are:

* additional CollectivIQ threads;
* repeated transmission of conversation history;
* increased upstream token use;
* additional entries in the CollectivIQ sidebar.

**One narrow, opt-in exception now exists.** Section 5.1.1 defines optional
OpenCode thread reuse: when it is explicitly enabled, sequential ELIGIBLE
messages from one OpenCode session reuse a single CollectivIQ thread instead of
creating one per completion. It is OFF by default, is restricted to
direct-prompt, tool-free text requests carrying a valid session header, and is
fail-closed. Every other request — and every request at all with the feature
disabled — keeps exactly the stateless behaviour described above. The upstream
prerequisites that historically blocked thread reuse (reliable message
identifiers, thread cleanup, and request correlation) are still NOT satisfied;
section 5.1.1 documents what the implementation does instead and what remains
unverified.

### 5.1.1 Optional OpenCode thread reuse (Phase 5A, pulled forward — optional, off by default)

Redis-backed, cross-replica OpenCode thread reuse for `POST /v1/chat/completions`
is implemented in `src/thread-reuse/` and is **optional**. With
`OPENCODE_THREAD_REUSE_ENABLED=false` (the default) no coordinator is built, no
reuse scope is derived, and not a single Redis reuse operation occurs: every
completion creates its own thread exactly as it did before Phase 5A.

This subsection is the NORMATIVE owner of the reuse contract, its state machine,
and its error surface. Other documents summarize it; none restates it.

**Why it exists.** For a `promptMode: "direct"` model the gateway submits only
the latest user message (section 8.4.1), so a one-thread-per-completion session
gives the provider no conversational context at all and fills the CollectivIQ
sidebar with one entry per turn (section 34.5). Keeping a session on one thread
restores continuity for exactly that profile without changing what the gateway
sends.

**It changes where the conversation lives, and that is the point.** This is a
deliberate semantic change to the `direct` profile, not a transparent
optimization. Today a direct-mode completion submits only the latest user message
into an EMPTY thread, so the provider sees no history at all and OpenCode's
client-side transcript is the only conversation state. With reuse enabled the
provider accumulates the session's turns on its side, and the model answers with
that provider-side history in view.

The two can DIVERGE. The gateway keeps sending only the latest user message, so
it never reconciles the two views: if the client edits, truncates, retries, or
reorders its own history, or inlines earlier turns into the latest user message,
the provider thread still holds whatever it was told before. Nothing detects or
repairs that. A deployment enabling reuse is choosing provider-thread-as-memory
for eligible sessions; a deployment that needs the client transcript to be the
single source of truth must leave reuse off. This does not affect `protocol`
models, which resubmit their full history every turn and stay stateless.

**Live evidence (sanitized, 2026-09-02).** A user-guided two-turn smoke
**observed end-to-end thread reuse work for the tested local/account
configuration**, on the committed direct/text OpenCode default with reuse enabled
against a disposable loopback Redis. It used a brand-new top-level OpenCode
session, two sequential synthetic prompts containing no repository or customer
content, and no tools, idempotency key, retries, or extra completions.

Observed: readiness `200` and a Redis mapping count of `0` beforehand; turn one
succeeded, propagated the OpenCode native title, produced **exactly one** new
CollectivIQ thread, and left the mapping count at `1`; turn two, in the same
session, succeeded, **recalled a synthetic value supplied only in turn one**, kept
the new-thread total at `1`, kept the propagated title in place, kept the mapping
count at `1`, and left readiness `200`. Cleanup was user-confirmed: the single
provider thread was deleted manually in the CollectivIQ UI, the gateway was
stopped, the disposable Redis service was removed with no Compose container left,
and the repository stayed clean.

What that supports, exactly: sequential direct-mode turns reused ONE upstream
thread; provider-held history supplied the earlier turn's value even though direct
mode sends only the latest user message (the memory relocation described above,
observed); run correlation returned the CURRENT turn's answer rather than an
earlier one; the plugin supplied session identity on BOTH turns (section 25); and
hidden title generation stayed absent while native-title propagation still worked.

**It is still not production ready, and one passing smoke does not change that.**
The outstanding Phase 4 controls (load testing, a security review, dependency
scanning, backup/release procedures, and runbooks) remain outstanding — optional
metrics and tracing are now implemented (Phase 4C, sections 23.2 and 23.3), and
optional shared cross-replica capacity accounting too (Phase 4D, section 19.2),
but all three are off by default and change nothing here — and the upstream
questions this
feature is most sensitive to — message ordering and pagination (section 35, items
7 and 8), thread cleanup (item 9), and retention (items 22–25) — remain
unanswered. The approval-gated real-Redis suite also passes (section 29.8), so the
nine Lua scripts are proven against a real Redis 8.8.2.

The smoke is a SINGLE sanitized observation of one local/account configuration. It
establishes no repeatability, no cross-account or cross-version behaviour, no
general upstream ordering or pagination guarantee, no retention or deletion
guarantee, no graceful-shutdown evidence (see `.agent/instructions/validation.md`
for why), and nothing at all about protocol-mode or tool-mode reuse, which stay
outside eligibility. The feature remains OFF by default, and every further live
run requires fresh approval.

#### Eligibility

A request is reuse ELIGIBLE only when ALL of the following hold:

1. `OPENCODE_THREAD_REUSE_ENABLED=true`;
2. the request carries a valid `X-CollectivIQ-OpenCode-Session-ID` header (the
   existing opaque 1–128 byte `[A-Za-z0-9_-]` header from section 9.5);
3. the resolved virtual model has `promptMode: "direct"`;
4. the resolved virtual model has `toolMode: "disabled"`.

Anything else — the feature disabled, no header, a `protocol` model, or a
tool-enabled model — is byte-for-byte the stateless behaviour of section 5.1.
Protocol models resubmit their whole history every turn and an emulated tool loop
creates a thread per round (section 12.6); making either stateful would change
its prompt semantics, which this phase deliberately does not do.

#### Public contract

| Condition | HTTP | Type | Code | `param` | `Retry-After` |
| --- | ---: | --- | --- | --- | --- |
| Reuse could apply and the session header is PRESENT but invalid | 400 | `invalid_request_error` | `invalid_opencode_session_id` | `X-CollectivIQ-OpenCode-Session-ID` | — |
| An eligible request also supplies `Idempotency-Key` | 400 | `invalid_request_error` | `unsupported_parameter` | `Idempotency-Key` | — |
| Another in-flight turn holds this session's thread | 409 | `invalid_request_error` | `thread_reuse_busy` | `null` | fixed `2` |
| Redis missing/unhealthy, corrupt or ambiguous state, or a failed transition | 503 | `server_error` | `thread_reuse_unavailable` | `null` | fixed `2` |

A malformed session header is an ERROR only when reuse could actually apply.
With the feature disabled, or for an ineligible model, the same header keeps its
long-standing best-effort behaviour of being ignored (section 9.5).

Idempotency and reuse cannot be combined in this initial implementation. The two
features have incompatible finalization semantics — idempotency caches and
replays one answer for a key, while reuse advances a session's thread on every
turn — and a coupled commit is deliberately not attempted. The combination is
refused outright rather than honoured partially, before either feature touches
Redis.

Public JSON and SSE schemas are unchanged and remain OpenAI compatible. No
response header or body exposes a session id, a mapping id, a storage key, or an
upstream thread id.

#### Mapping identity and storage

The boundary lives in `src/thread-reuse/` and mirrors the Phase 4A/4B separation:
limits, key derivation, record parsing, a narrow total store port, an atomic
Redis implementation, the coordinator, and runtime composition. It uses the ONE
shared Redis connection (`src/redis/`); no module outside `src/redis/client.ts`
imports node-redis.

The configured 32-byte `IDEMPOTENCY_ENCRYPTION_KEY` is expanded with HKDF-SHA-256
under a salt and info labels DISTINCT from every Phase 4A and Phase 4B domain,
into four subkeys: a gateway-key reuse scope HMAC key, a storage-key HMAC key, an
AES-256-GCM key for the thread id, and a namespace HMAC key for the value-free
fingerprints. No new secret is introduced, and no code is shared with
`src/idempotency/keyring.ts` or `src/rate-limit/keyring.ts`, so a change here can
never re-key existing records. A gateway key therefore has three unrelated
scopes; gateway authentication exposes all three as opaque request identities and
none is ever logged, reflected, or returned.

A mapping's identity binds, with length framing so no boundary shift can make two
identities collide:

* the stable per-gateway-key reuse scope (an HMAC of the raw key, independent of
  `COLLECTIVIQ_GATEWAY_KEYS` order);
* the OpenCode session id;
* a normalized model-policy fingerprint over model id, `selectedLlms` (order
  significant), `generateCombined`, `answerSource`, `promptMode`, and `toolMode`;
* the CollectivIQ origin (`COLLECTIVIQ_BASE_URL`);
* an upstream-principal fingerprint: the auth mode plus the CONFIGURED bearer
  token, or in password mode the configured username — never the transient
  access token, which rotates on every login.

A policy change, a model switch, an origin change, or a principal change
therefore produces a SEPARATE mapping rather than continuing a thread generated
under different routing or a different identity. Only HMAC outputs are stored;
raw principal material is never stored or logged.

The Redis key is `<REDIS_KEY_PREFIX>:reuse:<HMAC digest>` — a readable
operational prefix and the fixed `reuse` category, which keeps mapping keys from
colliding with the `idem` and `rate` keyspaces.

**Stored state.** One versioned, bounded (≤4096 byte) JSON record per mapping,
carrying only: the record version, the state, a random owner token, an absolute
lease deadline in epoch ms (`0` when unleased), and — when a thread is bound —
the AES-256-GCM sealed upstream thread id. Redis therefore never holds a raw
session id, gateway key, upstream credential, prompt, answer, tool schema,
argument, result, model-generated content, model id, origin, or plaintext thread
id. The seal uses a fresh 96-bit nonce per write, and its associated data binds
the record version, the storage key, and an INDEPENDENT mapping-identity digest
derived under the namespace subkey, so a ciphertext relocated to another
mapping's key fails authentication rather than decrypting into a thread another
session would submit to. Decoding is strict: an unsupported version, an unknown
key, a wrong type, an oversized document, or any state/field combination the
state machine cannot produce is corrupt and fails the request closed.

All reads and mutations are bounded server-side: the size is checked with
`STRLEN` before any internal `GET`, and there is no direct unbounded client
`GET` at all.

#### State machine

A single key, five states, and one atomic Lua script per mutation — never a
GET-then-SET. Two replicas racing one session are serialized by Redis, not by any
local lock.

| State | Meaning | Acquirable |
| --- | --- | :--- |
| `reserved` | A request holds the lease but has not submitted. A thread may already be bound. | Only after its lease expires |
| `processing` | `process_message` is about to run, is running, or may have run. A thread is always bound. | No — an expired lease becomes `ambiguous` |
| `committed` | The commit mutation landed, but `committed → active` was not confirmed. A thread is always bound. The stored state does not imply an answer was emitted: emission is authorized only once the coordinator ACKNOWLEDGED the commit, so a reply-lost commit leaves `committed` with nothing emitted. | **No** |
| `active` | Idle and reusable: a bound thread, no lease. The only state a later turn continues from. | Yes |
| `ambiguous` | A failure occurred once a submit may have happened. Blocked for its TTL. Never carries a thread. | No |

Timings: a 15 minute ambiguous TTL, the configured sliding idle mapping TTL
(`OPENCODE_THREAD_REUSE_TTL_MS`, 7 days by default), a 10 s renewal cadence, and
TWO different leases — for the same reason section 18.1 carries two.

| Leased state | Lease | Why |
| --- | --- | --- |
| `reserved` | fixed 30 s | Losing it is SAFE: the owner-guarded `reserved → processing` transition means a starved owner that wakes after a takeover reports `lost` and aborts rather than submitting. No path submits without that transition succeeding first, so a short lease frees an orphaned claim quickly. |
| `processing` | the model's `requestTimeoutMs` + 30 s, capped at 630 s | Losing it is NOT safe. The owner may legitimately be mid-completion for its whole deadline, and an expiry would tombstone the mapping underneath a healthy request — failing a completion that was about to succeed and blocking the session for the ambiguous TTL. Renewal alone cannot carry this, because the event-loop starvation that delays renewals is exactly when it matters. Deriving the lease from the request's own deadline means the owner's deadline always fires first, so the lease degenerates to a crash reaper. |

Because the two differ, the RENEWAL must choose between them from the
AUTHORITATIVE STORED STATE, atomically, and must never accept a duration the
caller selected. A renewal races the `reserved → processing` transition: Redis
can apply that transition while the transitioning caller is still awaiting its
reply, so a caller-selected duration could carry the stale `reserved` view and
shorten a live `processing` record's lease to 30 s — precisely the expiry the
derived lease exists to prevent. Both leases are therefore shipped on every
operation and the script picks one.

**The lease deadline lives inside the record and is stamped and compared inside
Lua against Redis's own `TIME`, never a Node clock.** Redis `PX` carries the
record's LIFETIME, not its lease. That separation is load bearing: a record must
SURVIVE its lease so an expired `processing` record can become `ambiguous`
instead of silently vanishing and letting the next turn start a fresh thread
while the previous submit may still be running upstream.

**Redis lifetime is therefore chosen per state, server-side, from the state being
written** — never by the caller, and never uniformly from the mapping TTL:

| State written | Redis `PX` |
| --- | --- |
| `active` | the configured sliding mapping TTL |
| `reserved` | `max(mappingTtl, reservedLease + ambiguousTtl)` |
| `processing` | `max(mappingTtl, processingLease + ambiguousTtl)` |
| `committed` | the bounded committed safety TTL (15 minutes) |
| `ambiguous` | the ambiguous TTL (15 minutes) |

The `max` matters because configuration genuinely permits a lease longer than the
mapping TTL: the minimum `OPENCODE_THREAD_REUSE_TTL_MS` is 5 minutes while a
processing lease can reach 10.5 minutes. Writing every record with the mapping
TTL alone would let a live `processing` key expire mid-completion, and the added
grace guarantees a competitor still has a full window in which to observe the
expired lease and tombstone it.

Transitions:

1. An absent mapping becomes `reserved` with no thread.
2. An `active` mapping becomes `reserved`, carrying the encrypted existing thread.
3. An UNEXPIRED `reserved`/`processing` lease held by another request is busy
   (`409`). The loser is told to retry; it is never queued and never given its
   own thread.
4. The first request acquires capacity, calls `create_thread`, and binds the
   returned thread id while still `reserved`.
5. Immediately before `process_message` the record moves to `processing`.
6. The owner renews its lease while waiting for capacity, submitting, and
   polling. The renewal takes the state from the AUTHORITATIVE stored record,
   never from the caller, so a renewal that races a transition can neither revive
   an `active`/`ambiguous` record, misapply a lease, nor shorten a live
   `processing` lease. A lost renewal aborts the request.
7. After a validated authoritative answer is ready the record is finalized
   through the ACKNOWLEDGEMENT-SAFE two-step transition below. Step one MUST be
   acknowledged BEFORE any JSON body and before any SSE content or terminal
   frame. (SSE headers and the assistant-role opener precede it by design,
   exactly as for idempotency, so a late failure there is an SSE error record
   rather than an HTTP status.)
8. A capacity rejection, a cancellation, or any failure BEFORE `process_message`
   restores the previous `active` mapping, or deletes a reservation that never
   bound a thread. A session loses nothing.
9. Once `process_message` may have been attempted, any failure, timeout,
   cancellation, lost transition, or crash leaves the mapping BLOCKED — normally
   `ambiguous`. The one exception is finalization uncertainty after an
   acknowledged commit: the mapping may remain bounded in `committed`, which is
   equally non-acquirable, rather than being tombstoned (see the
   acknowledgement-safe subsection below). Either way the session is blocked and
   then starts cleanly; neither state is ever handed to a later turn.
10. An expired PRE-SUBMIT reservation is recoverable: the next acquire takes it
    over, keeping any bound thread.
11. An expired `processing` lease becomes `ambiguous`, never `active`.
12. After the ambiguous TTL expires the next request may reserve and create a new
    thread.

If the Redis bind fails AFTER a successful `create_thread`, the request fails
closed WITHOUT calling `process_message`. The blank provider-side thread is an
acknowledged residual orphan; it is never guess-deleted, because deletion
semantics are credential/principal dependent and unproven (section 35, item 9).

#### Acknowledgement-safe finalization

A single-step `processing → active` transition is unsafe in one specific way: if
Redis APPLIES the mutation but its reply is lost, the caller concludes "failed"
and returns `503` while the mapping has silently become REUSABLE. A later turn
then continues a thread whose last answer was never delivered — and the
subsequent `abandon` cannot correct it, because the record is already `active`.

The terminal step is therefore split, with a non-acquirable state in between:

1. **`commit`** — atomic, owner-guarded `processing → committed`. It is
   IDEMPOTENT for the same owner, so a bounded retry after a lost reply
   acknowledges a mutation that already landed instead of misreporting failure.
   `activate` is never invoked until `commit` is positively acknowledged.
2. **`activate`** — atomic, owner-guarded `committed → active`. Also idempotent
   for the same owner.

Because `committed` is never acquirable, an unacknowledged commit can only ever
BLOCK the session; it can never hand another owner a mapping with an
unaccounted-for turn. That is what makes the intermediate state safe.

Outcomes:

- **Commit cannot be acknowledged** (both attempts undecided): the answer is NOT
  emitted, the request returns `503`, and settlement tombstones the mapping.
  `abandon` accepts `processing` AND `committed`, so it retires the record
  whichever of the two the unacknowledged write actually reached.
- **Commit acknowledged, activation undecided**: the answer IS emitted. An
  unreachable Redis must not turn a completed, authorized answer into a `503`.
  Settlement retries activation best-effort; if it still cannot be confirmed the
  record stays `committed`, non-acquirable and bounded by its safety TTL, so the
  session blocks and then starts cleanly.
- **Activation returns a DEFINITIVE bad answer**: the mapping is not what this
  request believes it is, so the request fails closed and performs no follow-up
  write. Two cases differ in what the SCRIPT does:
  - `missing` — the key genuinely vanished (eviction, operator delete, expiry).
    Reporting it alone would leave the key ABSENT, and the session's next acquire
    would see no mapping and silently create a REPLACEMENT thread, breaking
    conversation continuity invisibly. The activation script therefore writes an
    `ambiguous` tombstone for the current owner, under the ambiguous TTL, in the
    SAME atomic script — so no competing acquire can observe the gap — and still
    returns `missing`. The session is blocked, then starts cleanly.
  - `lost`, `state`, `corrupt` — the record exists but belongs to another owner,
    has advanced beyond `committed`, or is unreadable. It is reported UNTOUCHED:
    something else owns the truth, and a corrupt record must never be rewritten.
- **`acquire` encountering `committed`** returns the same fail-closed blocked
  class as `ambiguous`.

The public session API stays one `finalize()` call; the coordinator orchestrates
both steps. The record format version is unchanged: Phase 5A has not been
released, so `committed` is added to the existing version rather than migrated.

#### Strict record validation

Every mutating script validates the COMPLETE record before it changes anything,
so a corrupt record can never be sanitized and rewritten into a valid-looking
one. Validation rejects unknown top-level keys, an unsupported version, an
invalid owner, a non-integral/negative/non-finite lease, an unknown state, a
sealed payload with anything other than exactly `i`/`c`/`t` (each bounded
base64url), and every impossible state/field combination:

| State | Required |
| --- | --- |
| `reserved` | base fields, positive lease, optional valid sealed payload |
| `processing` | base fields, positive lease, required valid sealed payload |
| `committed` | base fields, zero lease, required valid sealed payload |
| `active` | base fields, zero lease, required valid sealed payload |
| `ambiguous` | base fields, zero lease, NO payload |

A rejected record is reported `corrupt` and left BYTE-FOR-BYTE untouched.

There is deliberately NO completed-turn cap and no rotation threshold. A mapping
serves an unbounded number of sequential turns until it idles out, is
invalidated by a policy/principal change, or is blocked as ambiguous.

Mapping expiry only forgets the mapping. It NEVER deletes the CollectivIQ thread,
which remains in the provider's sidebar under the provider's own retention
policy.

#### Run correlation: which message belongs to THIS submission

A completion must return the answer its own submission produced. On a fresh
thread that is nearly automatic; on a reused thread the thread already contains
every earlier turn, and the ordinary selection policy (section 8.6) would return
the PREVIOUS turn's answer the instant polling started.

The gateway therefore correlates by RUN, not by history. Both halves of the
correlation are verified-repeatable safe field names from the two authorized
2026-08-11 password baselines (section 35, items 2 and 5; see also the upstream
contract document):

- a successful `process_message` `202` carries `combined_run_id`;
- a `get_messages` entry carries `combined_run_id`.

The contract is:

1. `normalizeProcessMessage` REQUIRES a non-empty string `combined_run_id` on a
   successful submission. Absent, empty, or wrongly typed is an upstream protocol
   failure — the gateway will not proceed without knowing which run it started.
   This tightening is shared, not reuse-specific: the operator-only discovery
   tooling gates its submit stage on the same normalizer, so an account whose
   `process_message` omits a run id now fails discovery as well as completions.
2. Each message's `combined_run_id` normalizes to `string | null`: absent or
   `null` is `null`; a non-empty string is that string; anything else makes the
   entry malformed, which fails the whole response as an upstream protocol error.
3. The submission's run id is carried into polling as a REQUIRED parameter.
4. A desired-source or tool-consensus message is ELIGIBLE only when its
   normalized run id EXACTLY equals the current submission's. A message with a
   missing or different run id can never win.
5. Eligibility is applied while SELECTING, never to an already-ranked winner: an
   older message can outrank a newer one under the section 8.6 policy, so
   filtering afterwards would reject the winner and time out with the real answer
   sitting unselected. The deterministic timestamp → sortable-id →
   array-position ordering then applies among same-run candidates only.
6. If no correlated answer appears before the authoritative deadline, the
   existing `504 completion_timeout` fires. The gateway NEVER falls back to an
   older or uncorrelated answer.

**This rule applies to every completion**, reused thread or not, so there is
exactly one correctness rule rather than a stateless path and a special case.

There is deliberately NO pre-submit history snapshot, NO baseline exclusion set,
and therefore NO bound on retained message identities — and consequently no
implicit cap on how many turns a session may accumulate. Correlation is a
property of the submission, so it is unaffected by thread length, by message
ordering, and by whether `get_messages` paginates: a truncated page cannot make
an uncorrelated message eligible, it can only delay or time out the correct one.
That removes the two residual risks the earlier snapshot design carried.

The documented optional `since_id` query parameter (section 10.3) remains
unused: run correlation already establishes which message belongs to this
submission, and `since_id`'s semantics have never been exercised live. Existing
bounded response validation is unchanged.

#### Admission order

For `POST /v1/chat/completions`, on both transports:

```text
gateway authentication (the /v1 onRequest hook)
  -> request validation, model resolution, tool normalization
  -> Idempotency-Key header validation
  -> thread-reuse eligibility        -> 400 invalid_opencode_session_id
                                     -> 400 unsupported_parameter
  -> keyed request whose idempotency cannot be honoured -> 503
  -> prompt preparation
  -> cross-replica rate limit        -> 429 / 503 (section 19.1)
  -> OpenCode thread-reuse lease     -> 409 / 503
  -> idempotency claim, wait, replay  (unreachable for an eligible reuse request)
  -> local FIFO queue + capacity     -> 429 gateway_capacity_exceeded
     (optionally a shared permit)    -> 503 capacity_unavailable (section 19.2)
  -> create-and-bind, or reuse the leased thread
  -> mark processing
  -> process_message (exactly once)
  -> authoritative get_messages polling
  -> mark active
  -> encode JSON or synthetic SSE
```

Consequences that follow from that order:

* A busy or unavailable reuse attempt happens AFTER the rate-limit gate and
  therefore consumes one quota unit, consistent with every other
  otherwise-valid attempt (section 19.1). A request the limiter itself rejects
  never acquires a lease.
* Holding a session's lease while waiting for bounded capacity is intentional —
  the alternative is to create a thread the request may not be able to use — and
  the lease is renewed throughout the wait. That holds in both capacity modes;
  with `SHARED_CAPACITY_ENABLED=true` (section 19.2) the wait can additionally
  depend on other replicas' occupancy, which makes the second consequence below
  more likely rather than different in kind. Two consequences follow
  for operators: while one turn queues, another turn of the SAME session gets
  `409` even though no upstream work is happening; and because the queue wait can
  be configured as high as `MAX_QUEUE_WAIT_MS` (600 s) while a queued turn still
  holds only the short 30 s `reserved` lease, a sufficiently long stall can lose
  the lease and fail that turn with `503`. Both are fail-closed outcomes, but a
  deployment that raises `MAX_QUEUE_WAIT_MS` well above the reserved lease should
  expect them.
* A capacity failure releases the lease without any upstream work. That is true
  of the shared `503 capacity_unavailable` as well as the `429`: both are
  provably pre-submit, so the mapping is RESTORED and the session is not blocked.
* No `create_thread` or `process_message` retry was introduced (section 17.1).
* The adapter already accepts a thread id for `process_message`; no upstream
  endpoint was added and no OpenAPI snapshot was refetched.
* Native-title propagation (section 9.5) is registered ONLY for the turn that
  CREATED the thread. The provider generates its title once, so a later turn has
  nothing new to propagate. The correlation keeps its existing 60 s process-local
  TTL, so a session whose plugin polls later, or whose gateway restarts, loses
  propagation for the whole session rather than only for one turn — the same
  best-effort, non-fatal outcome as before, just with fewer chances to succeed.
* Reuse never changes how capacity is accounted. Queueing is process-local in
  both modes, and the ACTIVE limits span replicas only when
  `SHARED_CAPACITY_ENABLED=true` (section 19.2) — a decision this feature neither
  requires nor influences.

#### Residual limits

* **Not production ready.** See the Phase 4 gaps listed above.
* **Ordering, pagination, cleanup, and retention are unverified**, but run
  correlation does not depend on any of them. A truncated or reordered
  `get_messages` page cannot make an uncorrelated message eligible; it can only
  delay the correct one, and a thread that outgrows a single bounded read
  degrades to `504 completion_timeout` rather than to a wrong answer.
* **Correlation requires `combined_run_id`.** It is verified-repeatable in both
  the submission response and message entries, but it is not an upstream
  GUARANTEE. An account whose `process_message` omits it fails the submission as
  an upstream protocol error; one whose messages omit it times out. Both are
  fail-closed, and both are visible immediately rather than as a silent wrong
  answer.
* **Provider-side history becomes part of the answer** for eligible sessions and
  can diverge from the client transcript, as described above.
* **A reused thread concentrates a whole conversation in one provider thread.**
  That reduces sidebar entries (section 34.5) but increases how much of a session
  sits in one place under an unknown retention policy.
* **A post-create Redis failure can leave a blank orphan thread** in the
  provider's sidebar. It is never guess-deleted.
* **A hard replica kill mid-submit blocks that session for the ambiguous TTL**,
  which is deliberately preferred over risking a stale answer or a silent
  replacement thread.
* **All replicas must share** the same Redis endpoint, encryption key,
  `REDIS_KEY_PREFIX`, gateway-key set, upstream credentials, origin, and model
  configuration, or a session will not resolve to the same mapping everywhere.
* The `maxmemory-policy noeviction` requirement of section 18.1 applies here too:
  an evicted mapping silently starts a new thread.
* Enabling this feature trades availability for correctness on the completion
  path for eligible requests, exactly as rate limiting does.
* No dependency was added and the lockfile is unchanged.

### 5.2 OpenCode remains the agent runtime

The gateway must never execute:

* shell commands;
* file reads;
* file writes;
* patches;
* searches;
* MCP tools;
* custom OpenCode tools.

The gateway returns a structured tool request. OpenCode decides whether to authorize and execute it.

### 5.3 Upstream behavior is treated as untrusted

CollectivIQ responses may be:

* malformed;
* incomplete;
* duplicated;
* delayed;
* returned in an unexpected order;
* missing a combined answer;
* valid text but invalid structured JSON;
* inconsistent across participating models.

All upstream responses must be validated before use.

### 5.4 Compatibility is intentionally bounded

The gateway will implement the subset of Chat Completions required by OpenCode.

It will not claim full OpenAI API compatibility.

The product documentation shall describe the gateway as:

> OpenAI Chat Completions compatible for the OpenCode integration profile.

---

## 6. High-Level Architecture

```text
┌─────────────────────────────────────────────────────┐
│ OpenCode                                            │
│                                                     │
│ @ai-sdk/openai-compatible                           │
│ messages, tools, tool results, stream requests      │
└──────────────────────────┬──────────────────────────┘
                           │
                           │ HTTPS / OpenAI schema
                           ▼
┌─────────────────────────────────────────────────────┐
│ CollectivIQ Gateway                                 │
│                                                     │
│  API Router                                         │
│  Authentication                                     │
│  OpenAI Request Validator                           │
│  Conversation Serializer                           │
│  Tool Protocol Encoder                             │
│  Virtual Model Resolver                            │
│  Request State Machine                             │
│  CollectivIQ Adapter                               │
│  Polling Coordinator                               │
│  Response and Tool Parser                          │
│  OpenAI Response Encoder                           │
│  SSE Stream Encoder                                │
│  Metrics and Logging                               │
└──────────────────────────┬──────────────────────────┘
                           │
                           │ HTTPS / CollectivIQ schema
                           ▼
┌─────────────────────────────────────────────────────┐
│ CollectivIQ                                         │
│                                                     │
│ POST /create_thread                                 │
│ POST /process_message                               │
│ GET  /get_messages                                  │
│ GET  /user/events — future use only                 │
└─────────────────────────────────────────────────────┘
```

---

## 7. Recommended Technology Stack

The reference implementation should use:

| Component                  | Recommendation                                            |
| -------------------------- | --------------------------------------------------------- |
| Runtime                    | Node.js current supported LTS                             |
| Language                   | TypeScript with strict mode                               |
| HTTP framework             | Fastify                                                   |
| HTTP client                | Undici or native Node `fetch`                             |
| Validation                 | Zod or TypeBox                                            |
| Logging                    | Pino                                                      |
| Metrics                    | Prometheus-compatible client                              |
| Testing                    | Vitest                                                    |
| Contract tests             | Mock HTTP upstream server                                 |
| Packaging                  | Docker and npm                                            |
| Optional distributed state | Redis                                                     |
| Configuration              | Environment variables plus validated JSON/YAML model file |

TypeScript is recommended because OpenCode uses the AI SDK provider ecosystem, making it easier to compare request structures and reproduce client behavior. The gateway protocol itself must remain language-independent.

All dependencies must be pinned through a lockfile. Automated dependency updates must run the full compatibility test suite.

---

## 8. Component Design

### 8.1 API Router

Responsibilities:

* expose public endpoints;
* enforce body-size limits;
* attach request IDs;
* authenticate requests;
* validate content types;
* route requests to application services;
* translate internal failures into OpenAI-style errors.

Public endpoints:

```text
GET  /v1/models
GET  /v1/models/:model
POST /v1/chat/completions
GET  /v1/opencode/session-title   (CollectivIQ/OpenCode extension; NOT OpenAI)
GET  /healthz
GET  /readyz
GET  /metrics
```

`/metrics` should not be publicly exposed without network controls or separate authentication.

**Implementation status (Phase 4C, implemented).** `GET /metrics` exists only
when `METRICS_ENABLED=true`; otherwise the route is not registered and the
endpoint returns the framework `404`. It is registered on the ROOT instance,
outside the authenticated `/v1` group, and carries no application
authentication — operators must isolate it at the network layer (sections 23.2,
31.2). It never calls CollectivIQ or Redis.

`GET /v1/opencode/session-title` is an **authenticated gateway extension**, not
part of the bounded OpenAI compatibility profile; it supports the OpenCode
native-title propagation bridge (section 9.5).

### 8.2 OpenAI Request Validator

Responsibilities:

* validate the Chat Completions request;
* enforce text-only input;
* validate tool schemas;
* normalize system and developer messages;
* reject unsupported combinations;
* record ignored optional parameters.

The validator must return a normalized internal object rather than passing the raw request throughout the application.

### 8.3 Virtual Model Resolver

The gateway exposes virtual model IDs. A virtual model maps to a CollectivIQ execution policy.

Example:

```yaml
models:
  collectiviq-claude:
    displayName: CollectivIQ Claude
    selectedLlms:
      - claude
    generateCombined: false
    answerSource: claude
    toolMode: disabled
    requestTimeoutMs: 90000

  collectiviq-consensus:
    displayName: CollectivIQ Consensus
    selectedLlms:
      - gpt
      - grok
      - gemini
      - claude
      - specialty
      - llama4
      - nemotron
    generateCombined: true
    answerSource: combined
    toolMode: emulated
    requestTimeoutMs: 90000

  collectiviq-coder:
    displayName: CollectivIQ Coder
    selectedLlms:
      - gpt
      - claude
      - gemini
    generateCombined: true
    answerSource: combined
    toolMode: emulated
    requestTimeoutMs: 90000

  collectiviq-fast:
    displayName: CollectivIQ Fast
    selectedLlms:
      - gpt
    generateCombined: false
    answerSource: gpt
    toolMode: emulated
    requestTimeoutMs: 60000
```

The model identifiers must be configurable because the names in the sample may change.

A model definition must include:

```ts
interface VirtualModel {
  id: string;
  displayName: string;
  selectedLlms: string[];
  generateCombined: boolean;
  answerSource: string;
  toolMode: "disabled" | "emulated" | "native";
  promptMode: "protocol" | "direct";
  requestTimeoutMs: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  maximumPromptBytes: number;
}
```

`promptMode` selects prompt serialization (section 8.4) and is OPTIONAL in the
model-configuration file: an omitted field is normalized to `protocol` when the
model loads, so existing model files keep the full-history serializer unchanged.
The loaded internal `VirtualModel` always carries an explicit `promptMode`, and
prompt behaviour is driven from this validated field — never from a model-id
string comparison. `promptMode` is internal execution policy: it is never
exposed in the public `GET /v1/models` objects.

- `protocol` (default): the normative full-history serializer — the fixed
  `COLLECTIVIQ GATEWAY PROTOCOL` header framing a versioned JSON envelope of the
  ENTIRE ordered conversation with declared roles (section 8.4 / 11.1).
- `direct`: an account-specific, intentionally LOSSY compatibility profile that
  submits ONLY the latest normalized `user`-role message content, verbatim, with
  no protocol header, JSON envelope, role labels, markers, prefixes, suffixes, or
  other conversation messages. It deliberately omits system/developer
  instructions, assistant history, and every earlier user turn. It is NOT a
  role-preserving Chat Completions translation and MUST NOT be described as
  prompt-injection prevention (section 8.4). It exists to reduce the observed
  semantic-refusal trigger (section 32, Phase 1; section 34.7) for an account
  that rejected the protocol wrapper.

### 8.4 Conversation Serializer

The serializer converts OpenAI messages into a CollectivIQ prompt.

Supported roles:

* `system`
* `developer`
* `user`
* `assistant`
* `tool`

Supported assistant content:

* plain text;
* prior tool calls;
* plain text plus tool calls.

Supported tool content:

* string;
* text content parts.

Unsupported content:

* images;
* audio;
* files;
* arbitrary binary data.

The serialized prompt must preserve:

* message order;
* role;
* tool-call ID;
* tool name;
* tool arguments;
* tool result;
* system/developer instruction precedence.

The serializer should use a versioned JSON envelope rather than informal transcript text.

Example:

```json
{
  "protocol": "collectiviq-gateway-conversation",
  "version": "1.0",
  "messages": [
    {
      "role": "system",
      "content": "You are a coding assistant."
    },
    {
      "role": "user",
      "content": "Read src/index.ts."
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_01",
          "name": "read",
          "arguments": {
            "filePath": "src/index.ts"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_01",
      "content": "export function main() {}"
    }
  ]
}
```

The JSON must be inserted inside a versioned control prompt.

#### 8.4.1 Prompt-mode selection (protocol vs direct)

The serializer is selected per request from the resolved model's normalized
`promptMode` (section 8.3), never from a model-id string.

- **`protocol` (default) — normative full-history serialization.** All of the
  preservation requirements above (message order, role, tool-call ID/name/
  arguments/result, and system/developer instruction precedence) and the
  versioned JSON envelope apply to `protocol` mode. This is the standard behaviour
  for every virtual model and is byte-for-byte stable.
- **`direct` — narrowly scoped, intentionally lossy exception.** A
  `promptMode: "direct"` model submits ONLY the content of the last normalized
  `user`-role message, verbatim (the normalized content string), and adds
  nothing: no `COLLECTIVIQ GATEWAY PROTOCOL` header, no version/mode line, no JSON
  envelope, no `BEGIN_CONVERSATION_JSON`/`END_CONVERSATION_JSON` markers, no role
  label, and no surrounding whitespace/prefix/suffix. It OMITS all system,
  developer, and assistant messages and every earlier user turn. An empty latest
  user message yields an empty direct prompt. A direct-mode request with **no**
  user-role message is rejected at the model-aware request-validation boundary
  (section 9.4) with a fixed, content-free `400 invalid_request_error`
  (`param: "messages"`, `code: "invalid_request"`) **before** prompt construction,
  capacity acquisition, thread creation, submission, or any SSE header.

The `direct` profile deliberately discards system/developer instructions, prior
user turns, and assistant history, so it is NOT a role-preserving Chat Completions
translation and may produce context-poor or behaviorally different answers. It
removes the protocol wrapper and all non-latest-user content — which is what the
observed account objected to (section 32, Phase 1; section 34.7) — but this is
prompt-content minimization, NOT prompt-injection prevention: the collapsed
single-`prompt` trust boundary (section 34.2) is unchanged. Prompt-size
enforcement (section 11.2.1) applies to the final SELECTED prompt, so in direct
mode only the latest-user content counts toward `maximumPromptBytes`.

### 8.5 CollectivIQ Adapter

The upstream adapter is the only module permitted to know CollectivIQ endpoint paths or schemas.

Required interface:

```ts
interface CollectivIQAdapter {
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;

  processMessage(
    input: ProcessMessageInput
  ): Promise<ProcessMessageResult>;

  getMessages(
    threadId: string
  ): Promise<GetMessagesResult>;
}
```

Provisional request interfaces:

```ts
interface CreateThreadInput {
  title: string;
  signal?: AbortSignal;
}

interface CreateThreadResult {
  threadId: string;
  rawStatus: number;
}

interface ProcessMessageInput {
  threadId: string;
  prompt: string;
  selectedLlms: string[];
  generateCombined: boolean;
  signal?: AbortSignal;
}

interface ProcessMessageResult {
  accepted: boolean;
  rawStatus: number;
  upstreamRequestId?: string;
}

interface UpstreamMessage {
  source: string;
  content: string | null;
  percentUsage?: number | null;
  createdAt?: string | number;
  id?: string | number;
}

interface GetMessagesResult {
  messages: UpstreamMessage[];
  rawStatus: number;
}
```

The adapter must:

* send `Authorization: Bearer <token>`, where the token comes from the shared
  credential provider (`src/collectiviq/auth.ts`): the static `COLLECTIVIQ_API_KEY`
  in `bearer` mode, or a short-lived token minted at `POST /login` in `password`
  mode. A `401` invalidates the lease (no replay); a `403` does not;
* use `multipart/form-data` where required;
* validate all response bodies;
* impose connection and response timeouts;
* normalize CollectivIQ errors;
* never log authorization headers;
* retain raw responses only when explicitly enabled for development;
* cap raw response sizes;
* reject non-JSON message responses.

### 8.6 Polling Coordinator

The polling coordinator waits for a usable CollectivIQ message.

The coordinator receives the CURRENT submission's `combined_run_id` and considers
only messages whose own `combined_run_id` matches it exactly (section 5.1.1). The
policy below then ranks those same-run candidates. This applies to every
completion, not only to a reused thread: correlating by run rather than by thread
history means a thread that already contains earlier turns cannot yield one of
them, and no assumption about message ordering or pagination is required.

Default policy:

```text
Initial interval:       2 seconds
Maximum interval:       5 seconds
Total request timeout: 90 seconds
Jitter:                ±10%
```

A fixed two-second interval may be used for the first release to match the supplied sample.

Completion criteria:

For a model with:

```yaml
generateCombined: true
answerSource: combined
```

the request completes when a non-empty message with:

```json
{
  "source": "combined"
}
```

is available.

For a single-source model:

```yaml
generateCombined: false
answerSource: gpt
```

the request completes when a non-empty message with:

```json
{
  "source": "gpt"
}
```

is available.

Stale-message filtering is not a separate concern: every completion selects only messages whose `combined_run_id` matches its own submission (sections 5.1.1, 8.6). A thread that already holds earlier turns — the reuse case (section 5.1.1, off by default) — therefore cannot yield one of them, and no ordering or pagination assumption is involved.

The coordinator must distinguish:

* no messages yet;
* partial model responses;
* desired response available;
* upstream error;
* client cancellation;
* gateway timeout.

### 8.7 Response Parser

The parser receives:

* desired source message;
* all available individual messages;
* model configuration;
* original tool definitions;
* requested tool policy.

It produces one of:

```ts
type ParsedGeneration =
  | {
      kind: "text";
      content: string;
    }
  | {
      kind: "tool_calls";
      calls: ParsedToolCall[];
    };
```

Each parsed tool call must include:

```ts
interface ParsedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}
```

Tool arguments must remain a JSON string in the OpenAI response, but the gateway must parse and validate that JSON before returning it.

### 8.8 OpenAI Response Encoder

The encoder creates OpenAI-compatible objects.

Non-streamed text response:

```json
{
  "id": "chatcmpl_ciq_01J...",
  "object": "chat.completion",
  "created": 1785933840,
  "model": "collectiviq-consensus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The generated answer."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Non-streamed tool response:

```json
{
  "id": "chatcmpl_ciq_01J...",
  "object": "chat.completion",
  "created": 1785933840,
  "model": "collectiviq-consensus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_ciq_01J...",
            "type": "function",
            "function": {
              "name": "read",
              "arguments": "{\"filePath\":\"src/index.ts\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

OpenAI documents `tool_calls` and `finish_reason: "tool_calls"` as part of the Chat Completions response model.

If reliable token counts are unavailable, the gateway shall return zeros or omit `usage`, depending on the observed OpenCode client behavior.

The gateway must not present estimated tokens as exact upstream billing usage.

**Implementation status (Phase 1B, implemented).** The non-streamed text encoder
(`src/openai/chat-response.ts`) emits exactly `id` (`chatcmpl_ciq_*`),
`object: "chat.completion"`, Unix-seconds `created`, the requested virtual-model
`id`, one choice at index `0` with an assistant text `message` and
`finish_reason: "stop"`, and `usage` with `prompt_tokens`/`completion_tokens`/
`total_tokens` all `0`. The zeros denote **unavailable** counts — not estimates
and not exact billing usage. The completion id and clock are injectable seams for
deterministic tests. The tool response shape stays a Phase 3 concern. The
synthetic-SSE encoder (`src/openai/chat-stream.ts`; Phase 2) reuses the same
stable `id`/`created`/`model` and single choice index across every frame and
emits **no** `usage` at all (see section 14).

---

## 9. Public API Specification

## 9.1 Authentication

The gateway accepts:

```http
Authorization: Bearer <gateway-api-key>
```

The gateway API key is separate from the CollectivIQ API key.

For local single-user development, authentication may be disabled only when the service binds exclusively to:

```text
127.0.0.1
::1
```

Production deployments must require authentication.

**Implementation status (Phase 1A, implemented).** Every route under `/v1/*` is
authenticated; `/healthz` and `/readyz` remain unauthenticated. The scheme match
is case-insensitive and the presented token is compared **exactly** (never
trimmed or normalized). Comparison is fixed-length and timing-safe: each
configured key is reduced to a SHA-256 digest once at construction, the presented
token is hashed once, and the digest is compared against every configured digest
with `node:crypto` `timingSafeEqual` **without** an early return on a match.
Missing, malformed, empty, oversized, and incorrect credentials all return the
same fixed `401` (section 9.1.1). Gateway authentication is mandatory (there is
no disable switch), the gateway key is never forwarded to CollectivIQ, and the
header/token is never logged or reflected. Configured-key bounds are in
section 24; a presented token larger than the per-key byte cap is rejected before
hashing.

### 9.1.1 Authentication failures

Response:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "error": {
    "message": "Invalid gateway API key.",
    "type": "authentication_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

---

## 9.2 `GET /v1/models`

Returns configured virtual models.

Example:

```json
{
  "object": "list",
  "data": [
    {
      "id": "collectiviq-consensus",
      "object": "model",
      "created": 1785933840,
      "owned_by": "collectiviq-gateway"
    },
    {
      "id": "collectiviq-coder",
      "object": "model",
      "created": 1785933840,
      "owned_by": "collectiviq-gateway"
    }
  ]
}
```

The OpenAI Models API uses `GET /models` for listing available models.

**Implementation status (Phase 1A, implemented).** The catalog is immutable and
built from the validated `config.models`. Models are listed in configuration
(YAML) order, and each model object exposes only `id`, `object`, `created`, and
`owned_by` — never `displayName`, `selectedLlms`, `answerSource`, `toolMode`,
timeouts, credentials, or configuration paths. A single Unix-seconds `created`
timestamp is captured when the catalog is constructed and reused for every model
object served by that server instance; a restart may produce a new timestamp.

---

## 9.3 `GET /v1/models/:model`

Returns one virtual model or an OpenAI-compatible not-found error.

Example:

```json
{
  "id": "collectiviq-consensus",
  "object": "model",
  "created": 1785933840,
  "owned_by": "collectiviq-gateway"
}
```

Resolution is **exact-case**. An unknown id or a case mismatch returns HTTP
`404` with the fixed envelope (`type: "invalid_request_error"`,
`code: "model_not_found"`, `param: "model"`, message
`The requested model does not exist.`); the submitted identifier is never
reflected back.

---

## 9.4 `POST /v1/chat/completions`

### 9.4.1 Minimum supported request

```json
{
  "model": "collectiviq-consensus",
  "messages": [
    {
      "role": "user",
      "content": "Explain this function."
    }
  ]
}
```

### 9.4.2 Supported parameters

| Parameter               | Support                                              |
| ----------------------- | ---------------------------------------------------- |
| `model`                 | Required and enforced                                |
| `messages`              | Required and enforced                                |
| `stream`                | Supported                                            |
| `tools`                 | Tolerated + discarded for disabled models (Phase 2.1); normalized + retained (and proposed calls emitted) for `emulated` models (Phase 3, supported opt-in beta / non-default); rejected for `native` (unimplemented) |
| `tool_choice`           | `auto`/`none` tolerated + discarded for disabled models (Phase 2.1); `auto`/`none`/`required`/named honored for `emulated` models; `required`/named rejected for disabled/`native` |
| `parallel_tool_calls`   | Ignored (name only) for disabled models; consumed for `emulated` models (absent → `true`; non-boolean rejected) |
| `temperature`           | Accepted but ignored unless CollectivIQ adds support |
| `top_p`                 | Accepted but ignored                                 |
| `max_tokens`            | Accepted but not guaranteed                          |
| `max_completion_tokens` | Accepted but not guaranteed                          |
| `stop`                  | Accepted but ignored                                 |
| `seed`                  | Accepted but ignored                                 |
| `user`                  | Accepted for logging correlation after hashing       |
| `n`                     | Must equal 1                                         |
| `response_format`       | Unsupported initially                                |
| `logprobs`              | Unsupported                                          |
| audio parameters        | Unsupported                                          |
| image inputs            | Unsupported                                          |
| `store`                 | Accepted but ignored                                 |

The gateway must tolerate optional fields commonly sent by AI SDK clients. It should not reject a request merely because an optional sampling field cannot be passed to CollectivIQ.

The gateway may return:

```http
X-CollectivIQ-Ignored-Parameters: temperature,top_p
```

This header is diagnostic and not required for correct client operation.

### 9.4.3 `tool_choice`

Supported values:

```json
"auto"
```

```json
"none"
```

```json
"required"
```

```json
{
  "type": "function",
  "function": {
    "name": "read"
  }
}
```

Behavior:

| Value          | Gateway behavior                         |
| -------------- | ---------------------------------------- |
| `auto`         | Model may return text or tools           |
| `none`         | Tool protocol is disabled for this call  |
| `required`     | Model must return at least one tool call |
| Named function | Model must call the named function       |

If a required tool call cannot be parsed, the gateway must not silently return ordinary text. It must return a structured gateway failure.

**Implementation status.** Emulated tool calling (Phase 3) is implemented and is
**supported opt-in beta: non-default and OpenCode permission-gated**.
`collectiviq-claude-tools` is the single tool-enabled virtual model, exposed by
two functional, behaviorally identical OpenCode agent entries — the canonical
`collectiviq-tools-beta` and the deprecated `collectiviq-tools-experimental`
compatibility alias retained through Phase 4 — and no committed default selects
either. Its numerical section-30
release gates are **met**: the state-aware report-v5 / checkpoint-v4 evaluator
completed a full live campaign on **2026-09-01** in which all eight gates passed
and overall `passed: true`. The earlier 2026-08-31 report-v4 campaign (six of
eight gates passing) is historical evidence. Beta is not production readiness,
and default enablement remains a separate decision after the Phase 4 controls.
**See section 30** for the canonical graduation decision, the complete campaign
evidence, and the accounting. Every committed default virtual model
is `toolMode: "disabled"`, so the request boundary only
TOLERATES the tool metadata OpenCode sends automatically: it accepts a
`tool_choice` of exactly `"auto"` or `"none"` (discarded, name recorded) and
rejects `"required"` and named-function choices with a stable
`unsupported_parameter` `400` — a request that requires or names a tool is never
silently answered with text. An `emulated` model instead honors
`auto`/`none`/`required`/named and can emit model-proposed calls (see section
9.4.4 and section 12). `native` tool mode is not implemented.

### 9.4.4 Text-only constraints

String content is accepted:

```json
{
  "role": "user",
  "content": "Review this code."
}
```

Text content parts are accepted:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Review this code."
    }
  ]
}
```

An image content part produces:

```http
HTTP/1.1 400 Bad Request
```

```json
{
  "error": {
    "message": "CollectivIQ Gateway currently supports text input only.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "unsupported_content_type"
  }
}
```

**Implementation status (Phase 1B / Phase 2, implemented).** `POST
/v1/chat/completions` is authenticated and text-only, with a **strict** request
surface, and serves both the non-streamed JSON path and (Phase 2) the synthetic
SSE path. Accepted: a non-empty exact-case `model`, a non-empty ordered
`messages` array with `system`/`developer`/`user`/`assistant` roles, string
content or arrays of `{ "type": "text", "text" }` parts (text parts are joined
with `\n`), `n` absent or `1`, and `stream` **absent, exactly `false` (JSON), or
exactly `true` (synthetic SSE)** — every other `stream` value (including `null`,
an explicit `undefined`, `"true"`, `0`, `1`, or an object) is a stable `400`, and
the normalized boolean is carried on the frozen `NormalizedChatRequest`.
Documented optional
sampling/storage fields (`temperature`, `top_p`, `max_tokens`,
`max_completion_tokens`, `stop`, `seed`, `user`, `store`, `parallel_tool_calls`)
are accepted but ignored — only their **names** are recorded and echoed in the
optional `X-CollectivIQ-Ignored-Parameters` header (values are never read or
logged). `parallel_tool_calls` is an ignored compatibility option for `disabled`
models; for an `emulated` model it is instead CONSUMED (absent → `true`; a
non-boolean is rejected with `param: "parallel_tool_calls"`). Rejected with stable
content-free
`400`s — by **own-property presence alone**, including an empty value, `null`,
an explicit `undefined` supplied directly to the normalization boundary, or any
otherwise-harmless value: a non-boolean `stream`,
`response_format`, `logprobs`, and
audio parameters (model-independent); plus, for a text-only (`disabled`/`native`)
model, message `tool_calls` and tool-role messages (an `emulated` model PARSES
these into normalized prior tool calls / tool results); and
image/audio/file/binary content parts. Presence is decided with `Object.hasOwn`
(the field value is never read for a presence decision, so a value getter is
never invoked and an inherited/prototype property never counts as supplied);
the accepted-but-ignored names are recorded the same way.

**Tool-metadata compatibility bridge (Phase 2.1).** Request `tools` and
`tool_choice` are validated by a **model-policy-aware** bridge that runs AFTER
exact model resolution (`tools` first, then `tool_choice`), because OpenCode
attaches tool definitions to every request even when all tool permissions are
denied. For a `toolMode: "disabled"` (text-only) model the bridge TOLERATES that
metadata: a tool definition is never semantically interpreted, retained,
serialized into the prompt, forwarded upstream, logged, reflected, persisted, or
included in an error; it is traversed ONLY through data-property descriptors for
a bounded, iterative (cycle- and depth-guarded) JSON-shape and byte accounting,
and submitted accessors and executable hooks are never invoked. It records only
the parameter NAME for the ignored-parameter header.
It accepts an own `tools` value that is a JSON array of at most `MAX_TOOLS`
(`128`) entries whose entire JSON encoding is at most `MAX_TOOL_SCHEMA_BYTES`
(`2 MiB`, section 21.6 — array/object framing, keys, and every nested value all
count) and a `tool_choice` of exactly `"auto"` or `"none"`. Descriptor-safe
inspection (`Object.getOwnPropertyDescriptor`/`Reflect.ownKeys`, no `[[Get]]` —
the array length is read from its own DATA descriptor) means an accessor,
`toJSON`, or iterator hook is never invoked and a hostile descriptor/proxy read
fails closed. Actual tool calling
stays disabled: a `tool_choice` of `"required"` or a named function (which
requires or names a tool); a non-array, over-count (`> 128`), or over-budget
(`> 2 MiB`) `tools` value; an accessor, cycle, sparse/anomalous array, exotic
(non-plain) object, over-deep nesting, or unsupported value
(function/symbol/bigint/`undefined`/non-finite number) anywhere in the
collection; a descriptor/proxy failure; or ANY presence of `tools`/`tool_choice`
against a `native` model (not implemented) is rejected with the
stable content-free `unsupported_parameter` `400` (`param` = `tools` or
`tool_choice`). In this disabled-mode bridge no tool definition ever reaches the
prompt, upstream, logs, storage, or the response, and no tool call is emitted or
executed. (An `emulated` model — supported opt-in beta, non-default — instead
normalizes and retains the policy, serializes the validated schemas into the
upstream prompt, and can emit model-proposed calls; see section 12.)
Conservative initial collection bounds apply (`MAX_MESSAGES = 512`,
`MAX_TOOLS = 128`, `MAX_TOOL_SCHEMA_BYTES = 2 MiB`,
`MAX_TEXT_PARTS_PER_MESSAGE = 256`); the body-byte and final-prompt-byte limits
remain authoritative. The raw request is normalized to a **deeply immutable**
internal value (each message, the message array, the ignored-name collection, and
the outer request are frozen) and never flows into generation logic.

## 9.5 OpenCode session-title extension (`GET /v1/opencode/session-title`)

**Implemented; the native-title lookup contacts CollectivIQ only when the
endpoint is actually called.** This is a CollectivIQ/OpenCode **extension**,
explicitly **not** part of the bounded OpenAI Chat Completions profile. It exists
so the OpenCode plugin can propagate the CollectivIQ-generated native
thread title (section 10.1) to the OpenCode session title without OpenCode's hidden
LLM title agent creating a separate upstream thread (section 25). The plugin is
committed project-locally and may ALSO be installed globally via a supported manual
symlink for cross-project use; when both are discovered in one process, the plugin
de-duplicates itself into a single shared instance (section 25). **Historical
2026-08-21 sequence:** a sanitized smoke proved one foreground thread, no hidden
title-generation thread, and provider-native title generation, but the OpenCode
rename did not occur. The cause was that the plugin **entry module never loaded** —
its bare-function default caused OpenCode's legacy loader to scan the module's named
runtime exports and reject a non-function with `Plugin export is not a function`, so
no header/correlation/poll/rename behavior was exercised at all. The entry now uses
the V1 `{ id, server }` default module (section 25). A subsequent trace after the
loader fix showed the poller then progress through loader, singleton, lifecycle
parsing, provider matching, header attachment, `session.idle`, and base-URL
resolution, but stop before its first title lookup: the plugin resolved its gateway
key ONLY from `process.env.COLLECTIVIQ_GATEWAY_KEY`, which was absent, even though
the foreground completion had authenticated with the configured provider credential.
The plugin now reuses the resolved CollectivIQ provider credential
(`provider.collectiviq.options.apiKey`) with `COLLECTIVIQ_GATEWAY_KEY` read only as a
lazy injected fallback (section 25). **Live status:** a sanitized, user-authorized
2026-08-22 live smoke observed the complete propagation path succeed for the tested
local configuration (OpenCode 1.18.21) — exactly one new foreground thread, no hidden
title thread, a provider-native title generated for it, and the OpenCode top-level
session title changed from its default to that provider-native title (the foreground
response completed and was relevant, no alert/tool call). This is a single-local-
configuration observation, **not** production readiness, a cross-account/cross-version
guarantee, or a claim about which credential source was exercised; the
provider-config/environment precedence and lazy fallback are hermetically verified,
propagation stays best-effort (a failure leaves the OpenCode default/manual title),
and further live runs remain approval-gated. It is registered
inside the existing authenticated `/v1` scope, so it requires the same
`Authorization: Bearer <gateway-key>` and per-key identity as the other `/v1`
routes.

**Correlation header.** `POST /v1/chat/completions` accepts an optional
`X-CollectivIQ-OpenCode-Session-ID` request header (normalized to lowercase
internally): an opaque ASCII token, 1–128 bytes, characters `[A-Za-z0-9_-]` only.

* **Absent** → an ordinary completion; the bridge does nothing.
* **Malformed** → ignored; the completion proceeds normally.
* **Valid** → retained only long enough to register a **successful** first
  correlation (below).

The session id is never logged, hashed into logs, reflected in an error, or
exposed in any completion response body.

**Since Phase 5A this header has a second, independent role.** When optional
OpenCode thread reuse is enabled (section 5.1.1) and the resolved model is
eligible, the same header additionally identifies the session-to-thread mapping,
and a PRESENT-but-malformed value is then rejected with
`400 invalid_opencode_session_id` instead of being ignored — a caller that asked
for a session-scoped conversation and got the header wrong must not be silently
downgraded to one thread per turn. The three bullets above remain exactly the
behaviour for every request that is not reuse eligible, including every request at
all while the feature is disabled. Reuse also changes WHEN a correlation is
registered: only the turn that CREATED the thread registers one, because the
provider generates its native title once.

**Client behaviour (the committed OpenCode plugin).** The plugin attaches this
header to **every** matching completion, not only the first one, because reuse needs
the session identity on every turn (section 25 owns that contract). The rules above
are unchanged, but the population they apply to is not: per-request headers BROADEN
which successful created-thread completions may register a correlation, so sessions
the plugin will never poll for — child, manual, already-propagated — can now occupy
entries until they expire. The bounds above absorb that: first-registration-wins
means repeated turns of one session consume no additional entry while its entry is
live; a reused turn registers nothing because it created no thread; and a full
registry silently skips registration, which can suppress another session's
best-effort title propagation but never fails or alters a completion. Section 25
records this as an accepted residual tradeoff. The header stays OPTIONAL — any
client may omit it, and the plugin itself omits it for a request whose session id
the gateway would reject.

**Process-local correlation service** (`src/opencode/title-bridge.ts`). Keyed by
`gatewayKeyId + sessionId`, it stores **only** the two opaque ids plus the upstream
thread id created for that completion — **never** a title, prompt, or answer.
Registration happens **only after a confirmed success**: on the non-streamed path
after `run()` succeeds and before the encoded JSON is returned; on the streamed
path only after both the terminal chunk and `data: [DONE]` were delivered. A
failed, cancelled, disconnected, or incomplete stream registers nothing.
Registration is synchronous, bounded, and non-throwing (it can never alter the
completion result). **First registration wins** — a later completion for the same
session never replaces it, so only the first foreground title propagates.
Bounds: TTL **60 s** with lazy expiry (no per-entry timer), a global cap of **128**
entries and a per-key cap of **32** (when full, registration is silently skipped
and the completion still succeeds); at most **one in-flight upstream lookup per
correlation** (single-flight), a minimum **2 s** between actual upstream lookups,
and at most **6** actual lookups per correlation. Correlation is process-local — a
restart safely loses pending propagation.

**Lookup.** The endpoint resolves the correlation, then (subject to the bounds
above) issues the observed-only `get_threads` adapter lookup (section 10.4) for the
single correlated thread. Responses each carry `Cache-Control: no-store`:

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{ "status": "ready", "title": "…" }` | A validated native title is available |
| `202` | `{ "status": "pending" }` (with `Retry-After: 2`) | Not yet available; retry later |
| `400` | `{ "status": "unavailable" }` | Missing/malformed session header |
| `404` | `{ "status": "unavailable" }` | Unknown, expired, or exhausted correlation (intentionally conflated) |

The endpoint never returns an upstream thread id, raw upstream body, status text,
credential, or diagnostic message. Client disconnect and shutdown are composed into
the lookup abort signal. The native title is read **transiently** to build the
`200` body and is never logged, cached, or retained by the gateway (the correlation
store holds only opaque ids, never the title).

---

## 10. CollectivIQ Request Translation

### 10.1 Thread creation

For each completion, unless the request is continuing a thread an earlier turn of
the same OpenCode session already created (optional thread reuse, section 5.1.1;
off by default). A reusing turn issues no `create_thread` at all and submits into
the leased thread instead.

```http
POST {COLLECTIVIQ_BASE_URL}/create_thread
Authorization: Bearer {COLLECTIVIQ_API_KEY}
Content-Type: application/x-www-form-urlencoded
```

Form fields (per the published OpenAPI document):

```text
thread_title=New Thread
is_title_from_user=false
```

`project_id` (`integer | null`) is documented and optional; the gateway omits
it. This endpoint is `application/x-www-form-urlencoded`, not multipart.

The gateway sends the fixed, content-free placeholder `THREAD_TITLE` (exactly
`New Thread`). A sanitized 2026-08-18 observation found this exact temporary title
to be the minimal gateway-compatible trigger that causes CollectivIQ to natively
generate a server-side, prompt-related thread title after `process_message`; the
URL-encoded request is otherwise unchanged. That provider-generated title is
produced and persisted **asynchronously and entirely provider-side** — the gateway
never derives, logs, caches, or retains it, and it is **distinct** from any
OpenCode session title (see sections 21–22, 9.5, 10.4, and the upstream-contract
document). The one place the gateway reads it is the OpenCode session-title
extension (section 9.5): when the plugin polls `GET /v1/opencode/session-title`,
the gateway reads the single correlated thread's title **transiently** via the
observed-only `get_threads` lookup (section 10.4) purely to build that response,
and still never logs, caches, or retains it. Only the `New Thread` placeholder is
ever sent, and it must not contain:

* user prompts;
* source-code filenames;
* repository names;
* personal information.

Expected provisional response:

```json
{
  "thread_id": 123
}
```

Validation requirements:

* `thread_id` must exist;
* it may be accepted as a positive integer or non-empty string;
* it must be converted to an internal string;
* unexpected fields must be ignored;
* missing or invalid `thread_id` produces an upstream protocol error.

### 10.2 Message processing

```http
POST {COLLECTIVIQ_BASE_URL}/process_message
Authorization: Bearer {COLLECTIVIQ_API_KEY}
Content-Type: multipart/form-data
```

Form fields:

```text
prompt=<serialized prompt>
thread_id=<thread id>
selected_llms=<comma-separated model identifiers>
generate_combined=true|false
llms_explicitly_set=true
```

`llms_explicitly_set` (documented type `string | null`, default `"false"`) is
sent as `"true"` because the gateway configuration explicitly selects the
models. Its runtime effect is provisional until verified by live discovery. The
gateway does not send the documented `files`, `client_timezone`,
`client_location`, `clarification_origin_run_id`, `suppress_user_bubble`,
`response_format`, or `tier` fields.

An HTTP success status is not sufficient. The response body must be checked for error objects such as:

```json
{
  "detail": "..."
}
```

### 10.3 Message polling

```http
GET {COLLECTIVIQ_BASE_URL}/get_messages?thread_id=<encoded thread id>
Authorization: Bearer {COLLECTIVIQ_API_KEY}
```

The OpenAPI document marks `thread_id` as an optional query parameter, but the
gateway always requires and sends a non-empty `thread_id`. The document also
declares an optional `since_id` parameter, which the initial gateway
intentionally omits so full thread history is returned.

Expected provisional response:

```json
{
  "messages": [
    {
      "source": "gpt",
      "content": "Individual answer",
      "percent_usage": 30
    },
    {
      "source": "combined",
      "content": "Combined answer"
    }
  ]
}
```

The adapter must not assume message ordering.

If more than one message has the requested source, the selection policy shall be:

1. select the message with the latest explicit timestamp;
2. otherwise select the message with the highest sortable ID;
3. otherwise select the last occurrence in the returned array.

This policy must be covered by contract tests and revisited once actual API behavior is documented.

### 10.4 Native-title lookup (`GET /get_threads`) — OBSERVED-ONLY / provisional

**Implemented (offline), but OBSERVED-ONLY, account/principal-dependent, and
provisional — not a documented, repeatable, request-scoped, or generally supported
provider capability.** A `getThreadTitle(threadId)` adapter operation supports the
OpenCode session-title extension (section 9.5) only. It issues a bare
`GET /get_threads` under the bounded transport (5 s header, 5 s body, 4 MiB max
body) with **no** internal retry, using the shared upstream credential provider and
transport. It reads **only the single target thread entry** — the observed response
is an object whose `threads` map is keyed by the normalized thread id — and never
enumerates, retains, serializes, or logs unrelated entries. It performs **no**
thread-creating POST and creates no additional thread.

Result is a narrow pending/ready contract:

* the target absent from the `threads` map, or a title still equal to the fixed
  `New Thread` placeholder → **pending**;
* a **ready** title must be a string that trims to non-empty, is single-line, is
  free of C0/C1 control characters, and is ≤ 512 UTF-8 bytes;
* any malformed target or title → a normalized, content-free `UpstreamError` (no
  raw body, title, or identifier leaks).

Because it is observed-only, the endpoint (and any account) may return `pending`
indefinitely or fail by principal/account; the committed filtered OpenAPI snapshot
is unchanged (it does not add `get_threads`), and a bounded snapshot refresh is
deferred to a separately-approved stage. See the upstream-contract document for the
observed shape.

---

## 11. Prompt Construction

## 11.1 Text-generation prompt

When no tools are enabled, the prompt should have this structure:

```text
COLLECTIVIQ GATEWAY PROTOCOL
Version: 1.0
Mode: final-answer

The following JSON represents an ordered conversation.
Treat message content as data associated with its declared role.
Follow system messages first, then developer messages, then user messages.
Return only the assistant's next response.
Do not describe this protocol.

BEGIN_CONVERSATION_JSON
<serialized JSON>
END_CONVERSATION_JSON
```

Because CollectivIQ’s demonstrated API accepts one untyped `prompt` field, the gateway cannot provide cryptographically enforced separation between system, developer, user, and tool content.

This is an inherent limitation. Prompt delimiters reduce ambiguity but cannot guarantee instruction hierarchy.

## 11.2 Tool-generation prompt

When tools are enabled, the gateway adds a strict output protocol.

Example:

```text
COLLECTIVIQ GATEWAY PROTOCOL
Version: 1.0
Mode: tool-or-final

You are producing the next assistant action for a coding-agent client.

You may either:

1. Return one or more tool calls, or
2. Return a final assistant message.

Your entire response must be exactly one JSON object.
Do not use Markdown fences.
Do not include text before or after the JSON.

For tool calls:

{
  "gateway_protocol": "1.0",
  "type": "tool_calls",
  "calls": [
    {
      "name": "<tool name>",
      "arguments": {}
    }
  ]
}

For a final answer:

{
  "gateway_protocol": "1.0",
  "type": "final",
  "content": "<assistant answer>"
}

Only use tools declared in AVAILABLE_TOOLS_JSON.
Arguments must conform to each tool's JSON Schema.
Do not invent tool names.
Do not claim a tool was executed.
Tool results appear in the conversation as role=tool messages.

BEGIN_AVAILABLE_TOOLS_JSON
<tool definitions>
END_AVAILABLE_TOOLS_JSON

BEGIN_CONVERSATION_JSON
<conversation>
END_CONVERSATION_JSON
```

### 11.2.1 Prompt size

The gateway must calculate the UTF-8 byte size of the final prompt.

If it exceeds the configured model maximum:

```http
HTTP/1.1 400 Bad Request
```

```json
{
  "error": {
    "message": "The serialized conversation exceeds the configured CollectivIQ prompt limit.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "context_length_exceeded"
  }
}
```

Until CollectivIQ documents actual token limits, the gateway must use conservative configurable byte limits rather than invented token limits.

---

## 12. Emulated Tool Calling

## 12.1 Purpose

Emulated tool calling converts a strict JSON response generated as ordinary text into OpenAI `tool_calls`.

It is required only if CollectivIQ does not provide native structured tool calling.

**Implementation status (Phase 3, implemented offline, SUPPORTED OPT-IN BETA).** The
parsing algorithm (§12.2), candidate selection and consensus fallback (§12.3),
final-answer fallback (§12.3.2), `call_ciq_<ULID>` ids (§12.4), the parallel-call
policy (§12.5), and the tool-loop model (§12.6) are all implemented in `src/tools/`
and wired into the `toolMode: "emulated"` completion path. The gateway returns
model-PROPOSED calls only and never executes a tool. The numerical release gates
(§30) are **met** by the completed 2026-09-01 report-v5 campaign; the feature
nevertheless stays opt-in and non-default by explicit product decision. See the
Phase 3 status note in §32.

### 12.2 Parsing algorithm

For every candidate message:

1. Trim Unicode whitespace.
2. Remove one outer Markdown JSON fence only when present.
3. Parse the result as JSON.
4. Validate `gateway_protocol`.
5. Validate `type`.
6. Validate every tool name against the request’s tool set.
7. Validate arguments against the tool’s JSON Schema.
8. Reject unknown properties when the tool schema requires strict objects.
9. Enforce `tool_choice`.
10. Cap the number of calls.
11. Cap argument size.
12. Generate gateway-owned tool-call IDs.

No regular-expression-only parser is permitted.

### 12.3 Candidate selection

Candidate priority:

1. Valid response from the configured `answerSource`, normally `combined`.
2. Agreement among valid individual-model responses.
3. One valid individual-model response selected using deterministic tie-breaking.
4. Failure.

### 12.3.1 Consensus fallback

When the combined response is invalid but individual responses contain valid tool envelopes:

1. Canonicalize each tool-call set.
2. Group equivalent call sets.
3. Sum `percent_usage` where available.
4. Otherwise count agreeing sources.
5. Select the highest-scoring group.
6. Break ties using configured source priority.
7. Record `tool_parse_source="individual-consensus"`.

Canonicalization shall include:

* tool name;
* recursively key-sorted argument JSON;
* call order unless parallel calls are explicitly enabled.

### 12.3.2 Final-answer fallback

When `tool_choice` is `auto` and the desired response is not valid protocol JSON:

* treat the desired response as ordinary final text;
* do not interpret arbitrary prose as a tool call.

When `tool_choice` is `required` or a named function and no valid call is available:

```http
HTTP/1.1 502 Bad Gateway
```

```json
{
  "error": {
    "message": "CollectivIQ did not return a valid required tool call.",
    "type": "upstream_protocol_error",
    "param": "tool_choice",
    "code": "invalid_tool_response"
  }
}
```

### 12.4 Tool-call IDs

The gateway shall generate IDs:

```text
call_ciq_<ULID>
```

IDs must:

* be unique within a completion;
* remain stable across streaming chunks;
* be included in OpenCode’s subsequent tool-result message.

The upstream model does not need to generate the ID.

### 12.5 Parallel tool calls

Default maximum:

```text
8 calls per assistant response
```

When `parallel_tool_calls` is false, only one call may be returned.

If the model returns multiple calls while parallel calls are disabled, the gateway may either:

* select the first valid call; or
* reject the response.

The recommended default is to reject the response during development and select the first call only through an explicitly configured compatibility mode.

### 12.6 Tool-loop termination

The gateway does not manage an entire agent loop in one HTTP request.

The sequence is:

```text
OpenCode → gateway: conversation plus tools
gateway → OpenCode: tool_calls
OpenCode executes tools
OpenCode → gateway: conversation plus tool results
gateway → OpenCode: next tool_calls or final answer
```

OpenCode controls loop limits and permissions.

---

## 13. Future Native Tool Calling

The upstream adapter must expose a capability object:

```ts
interface UpstreamCapabilities {
  nativeToolDefinitions: boolean;
  nativeToolResults: boolean;
  requestScopedStreaming: boolean;
  cancellation: boolean;
  tokenUsage: boolean;
}
```

When CollectivIQ introduces native tool support:

```yaml
toolMode: native
```

shall bypass the emulated JSON protocol.

The public OpenAI-compatible API must remain unchanged.

Native tool mode may be enabled only after confirming that CollectivIQ supports:

* JSON Schema tool definitions;
* structured tool-call responses;
* tool-call identifiers;
* tool-result messages;
* repeated tool rounds;
* multiple tool calls;
* deterministic request correlation.

---

## 14. Streaming

**Implementation status (Phase 2, implemented offline).** `POST
/v1/chat/completions` now serves `stream: true` as **buffered synthetic SSE**,
text-only, alongside the existing non-streamed JSON path. The frame encoding and
the deterministic content split are pure (`src/openai/chat-stream.ts`); the SSE
transport — header commit, keep-alive timers, backpressure, and cancellation —
is owned by `src/api/chat-stream-response.ts`, driven from
`src/api/chat-completions-route.ts`. Request normalization (`chat-request.ts`)
maps `stream` to a boolean on the frozen `NormalizedChatRequest`
(`chat-types.ts`): absent or exactly `false` selects JSON, exactly `true`
selects SSE, and every other value (including `null`, an explicit `undefined`,
`"true"`, `0`, `1`, or an object) is a stable `400`. The synthetic stream does
NOT stream from CollectivIQ: the complete answer is obtained by authoritative
polling and only then split into deltas, so it cannot improve time-to-first
answer content. `usage` is never emitted for a stream, tool-call streaming stays
a Phase 3 concern. A basic live synthetic-streaming request completed end-to-end
from OpenCode on **2026-08-15**, but the long-running / keep-alive streaming smoke
test that closes the Phase 2 exit criterion is **not run** (pending separate
approval). The normative
requirements below are met by this implementation except where a subsection notes
a Phase 3 (tool-call) deferral.

## 14.1 Compatibility requirement

OpenAI Chat Completions streaming uses Server-Sent Events containing `chat.completion.chunk` objects.

The gateway must accept:

```json
{
  "stream": true
}
```

### 14.2 Initial streaming implementation

The initial release shall provide **buffered synthetic streaming**:

1. Accept the HTTP request.
2. Open an SSE response immediately.
3. Emit an initial assistant-role chunk.
4. Create the CollectivIQ thread.
5. Submit the message.
6. Poll for completion.
7. Emit SSE keep-alive comments while waiting.
8. Parse the complete answer.
9. Emit text or tool-call chunks.
10. Emit a final chunk with `finish_reason`.
11. Emit `[DONE]`.

Initial chunk:

```text
data: {"id":"chatcmpl_ciq_...","object":"chat.completion.chunk","created":1785933840,"model":"collectiviq-consensus","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}
```

Keep-alive:

```text
: collectiviq-gateway keep-alive
```

Final marker:

```text
data: [DONE]
```

Synthetic streaming does not reduce time-to-first-answer content. Its purposes are:

* compatibility with streaming clients;
* connection preservation;
* avoidance of client chunk timeouts;
* incremental delivery after the complete answer is available.

**Implemented wire contract (Phase 2).** Authentication, request validation,
model resolution, and prompt preparation all run **before** any SSE header is
committed, so a pre-header failure (e.g. an oversized prompt →
`context_length_exceeded`) stays a normal JSON error and never a half-open
stream. The route then hijacks the reply, responds `200` with
`Content-Type: text/event-stream`, and emits, all sharing one stable `id`, one
Unix `created`, the requested virtual-model `id`, and choice `index` `0`:

1. an assistant-role opener chunk (`object: "chat.completion.chunk"`,
   `delta: {"role":"assistant"}`, `finish_reason: null`) **before** capacity
   acquisition or any upstream request;
2. a `: collectiviq-gateway keep-alive` comment every 15 s while the
   authoritative poll waits;
3. content chunks (`delta: {"content":"…"}`, `finish_reason: null`) from the
   deterministic split of section 14.3 — concatenating every content delta
   reproduces the answer EXACTLY;
4. one terminal chunk (empty `delta`, `finish_reason: "stop"`);
5. `data: [DONE]`.

An empty answer emits the role chunk, the terminal chunk, and `[DONE]` with no
content frames. No `usage` field is ever emitted on the stream. A post-header
gateway/upstream failure is encoded as one safe `data: {"error": …}` record then
`data: [DONE]` (no terminal chunk); an unexpected post-header failure uses the
fixed content-free internal `500` error object. A shutdown cancellation emits the
content-free `503` (`service_unavailable`) error record followed by `[DONE]`
**only while the client is still connected AND the SSE transport remains
writable**; an undrainable or failed transport is instead force-closed, possibly
silently (see below).
Writes are serialized and honour Node backpressure (later frames wait for the
prior frame's flush); the combined client-disconnect + shutdown signal can
force-close a stuck (backpressured, non-draining) response so the shutdown drain
window stays authoritative and `app.close()` cannot hang, while a shutdown that
cancels `run()` on a still-writable transport keeps the safe `503` + `[DONE]`
path. Forced termination flushes any already-written terminal frames via
`res.end()` and then destroys the socket; it is hardened so a `res.end()` that
throws destroys immediately and a `res.end()` whose callback never fires destroys
on a bounded next-turn fallback (all serialized writes have already settled), so
shutdown can never hang and the response always ends destroyed exactly once. A
write failure or socket close is treated as client cancellation (polling
is aborted, capacity released, and no body is written to a gone client), the
writer never rejects after the reply is hijacked, and every keep-alive timer and
temporary listener is cleared on success, error, disconnect, cancellation, forced
close, and shutdown. A forced close of an undrainable or failed-terminal response
may therefore end **silently** — delivery of the `503` to the client cannot be
guaranteed.

A **successful** stream intentionally carries the requested answer text (the
`delta.content` chunks) and the gateway-generated OpenAI completion metadata (the
`chatcmpl_ciq_*` id, `created`, model, and choice index) to the **authenticated**
client — that content is the response, not a leak. What must never appear in any
frame is a submitted prompt outside its intended upstream request, a credential,
a raw upstream body, an upstream thread/run id, a filesystem path, a stack, or an
untrusted exception detail; and the answer content is never logged, persisted, or
placed in an error, keep-alive, or other control record.

### 14.3 Text chunking

After receiving the full response, text should be emitted in chunks of approximately:

```text
32–256 UTF-8 characters
```

Chunk boundaries should prefer:

1. paragraph boundaries;
2. sentence boundaries;
3. whitespace;
4. code-point-safe fixed lengths.

Chunking must never split a UTF-8 code point.

**Implemented (Phase 2).** `splitAnswerIntoChunks` operates on a Unicode
code-point array (surrogate-pair safe) with a target of 128 code points, a hard
maximum of 256, and a preferred minimum of 32 (only a shorter FINAL remainder,
or a whole answer below the minimum, is allowed). Within the `[MIN, MAX]` window
it prefers the strongest boundary — paragraph (a blank-line / double-newline
break), then sentence (terminal punctuation, optionally after a closing
quote/bracket, then whitespace), then any whitespace — closest to the target,
and falls back to a hard cut at the target when no natural boundary exists. The
split is deterministic, never splits a code point, and concatenates back to the
exact answer with no trimming or loss.

### 14.4 Tool-call streaming

Tool-call streaming is **implemented (Phase 3, SUPPORTED OPT-IN BETA)**: for a
`toolMode: "emulated"` model a streamed tool-call response emits one complete,
indexed tool-call delta (using the trusted `call_ciq_*` ids) rather than
character-by-character, then a terminal chunk with `finish_reason: "tool_calls"`,
then `data: [DONE]`, with no `usage` (`src/openai/chat-stream.ts`
`toolCallsChunk`/`terminalToolChunk`, `src/api/chat-stream-response.ts`). The
Phase 2 text stream is unchanged. Emulated tool mode is supported opt-in beta and
remains non-default (§30).

Example:

```json
{
  "id": "chatcmpl_ciq_...",
  "object": "chat.completion.chunk",
  "created": 1785933840,
  "model": "collectiviq-consensus",
  "choices": [
    {
      "index": 0,
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "id": "call_ciq_...",
            "type": "function",
            "function": {
              "name": "read",
              "arguments": "{\"filePath\":\"src/index.ts\"}"
            }
          }
        ]
      },
      "finish_reason": null
    }
  ]
}
```

Final chunk:

```json
{
  "id": "chatcmpl_ciq_...",
  "object": "chat.completion.chunk",
  "created": 1785933840,
  "model": "collectiviq-consensus",
  "choices": [
    {
      "index": 0,
      "delta": {},
      "finish_reason": "tool_calls"
    }
  ]
}
```

### 14.5 True upstream streaming

The supplied sample mentions:

```text
GET /user/events
```

This endpoint must not be used for production request streaming until the following are verified:

* every event contains a thread or request identifier;
* events can be filtered by thread;
* reconnect semantics are documented;
* event ordering is stable;
* multiple concurrent gateway requests cannot consume one another’s events;
* authorization is safe for multi-user gateway operation.

Until then, polling is authoritative.

---

## 15. Request State Machine

Each completion shall follow the sequence below. A completion that is CONTINUING
an OpenCode session's existing thread (optional thread reuse, section 5.1.1; off
by default) skips `THREAD_CREATING`/`THREAD_CREATED` and submits into the leased
thread; every other state is identical. That feature's own cross-replica mapping
states — `reserved`, `processing`, `committed`, `active`, `ambiguous` — are a
SEPARATE machine owned by section 5.1.1 and are not part of this per-request
sequence.

```text
RECEIVED
  ↓
AUTHENTICATED
  ↓
VALIDATED
  ↓
MODEL_RESOLVED
  ↓
PROMPT_SERIALIZED
  ↓
THREAD_CREATING
  ↓
THREAD_CREATED
  ↓
MESSAGE_SUBMITTING
  ↓
MESSAGE_ACCEPTED
  ↓
POLLING
  ↓
RESPONSE_AVAILABLE
  ↓
PARSING
  ↓
ENCODING
  ↓
COMPLETED
```

Terminal failure states:

```text
AUTH_FAILED
VALIDATION_FAILED
MODEL_NOT_FOUND
PROMPT_TOO_LARGE
UPSTREAM_AUTH_FAILED
UPSTREAM_QUOTA_FAILED
UPSTREAM_PROTOCOL_FAILED
UPSTREAM_TIMEOUT
CLIENT_CANCELLED
INTERNAL_FAILED
```

Each transition must produce:

* a trace span;
* a latency metric;
* a structured debug event without prompt content.

---

## 16. Cancellation and Client Disconnects

When the client disconnects:

1. abort pending gateway HTTP calls where possible;
2. stop polling;
3. close the SSE stream;
4. mark the request as cancelled;
5. release concurrency permits;
6. do not retry the request.

The supplied API does not demonstrate an upstream cancellation endpoint. Therefore, a submitted CollectivIQ generation may continue after the OpenCode client disconnects.

This must be documented as an upstream limitation.

**Implemented (Phase 1B / Phase 2).** Client-disconnect, the total deadline, and
shutdown share one abort path. On the streamed path a write failure or socket
close aborts the client controller, which stops polling, releases capacity,
clears the keep-alive timer, and writes no body to a gone client; the deadline
maps to `504`. On the non-streamed JSON path a shutdown cancellation with the
client still connected maps to `503`. On the streamed SSE path that `503`
(`service_unavailable`) record + `[DONE]` is emitted **only while the transport
remains writable**; a backpressured/undrainable response (or one whose terminal
`res.end()` throws or never completes) is force-closed instead — on a bounded
fallback if necessary — to keep the shutdown drain authoritative, so the stream
may end silently. A submitted CollectivIQ generation may still continue upstream
because no verified cancellation endpoint exists.

---

## 17. Timeouts and Retries

Recommended defaults:

| Operation               |     Timeout |
| ----------------------- | ----------: |
| Connect to CollectivIQ  |  10 seconds |
| Create thread           |  20 seconds |
| Submit message          |  20 seconds |
| Individual poll request |  15 seconds |
| Total completion        |  90 seconds |
| Gateway client request  | 100 seconds |

### 17.1 Safe retries

Safe to retry:

* `GET /get_messages`;
* connection failures before an HTTP request body is transmitted;
* selected `502`, `503`, and `504` responses from polling.

Not automatically safe to retry:

* `POST /create_thread`;
* `POST /process_message`.

Retrying `process_message` could generate duplicate model jobs.

POST retries must be disabled unless CollectivIQ introduces idempotency keys or a reliable duplicate-detection mechanism.

### 17.2 Poll backoff

Recommended:

```ts
nextInterval = min(
  maximumPollInterval,
  previousInterval * 1.25
) + jitter
```

For strict parity with the supplied sample, deployments may set:

```text
POLL_INTERVAL_MS=2000
POLL_MAX_INTERVAL_MS=2000
```

---

## 18. Idempotency

The gateway should support:

```http
Idempotency-Key: <client-generated-value>
```

When Redis is enabled, cache:

* request-body hash;
* current processing state;
* final response;
* expiration time.

Default retention:

```text
10 minutes
```

Rules:

* same key and same body: return or await the existing result;
* same key and different body: return `409 Conflict`;
* no key: process normally.

The gateway must not automatically derive a permanent idempotency key from the full prompt because doing so could reveal prompt hashes across trust boundaries.

### 18.1 Implementation status (Phase 4A, implemented — optional, off by default)

Redis-backed, cross-replica idempotency for `POST /v1/chat/completions` is
implemented in `src/idempotency/` and is **optional**. With a blank/absent
`REDIS_URL` the gateway behaves exactly as it did before Phase 4A for unkeyed
requests, and Redis is never contacted. This phase changed nothing about
admission: capacity kept its section 19 behaviour, and whether the ACTIVE limits
span replicas is decided independently by section 19.2's own flag.

**Public contract.** Exactly one optional request header is supported:

```http
Idempotency-Key: <opaque-client-value>
```

It must be a single occurrence of 1–255 bytes of visible ASCII (`0x21`–`0x7E`).
The value is preserved byte-for-byte and is never logged, reflected, or stored:
only a keyed HMAC of it reaches Redis. An array/duplicate header, an empty or
oversized value, and any space/control/non-ASCII character are rejected. Node
joins a duplicated header with `", "`, which the space rule already rejects; the
raw header list is additionally counted when available.

| Condition | HTTP | Type | Code | `param` |
| --- | ---: | --- | --- | --- |
| Invalid header, or a body that cannot be canonically fingerprinted | 400 | `invalid_request_error` | `invalid_idempotency_key` | `Idempotency-Key` |
| Same scoped key, different body | 409 | `invalid_request_error` | `idempotency_key_conflict` | `Idempotency-Key` |
| Redis disabled/unavailable, ambiguous/corrupt/tampered state, or lost claim | 503 | `server_error` | `idempotency_unavailable` | `null` |

The `503` always carries `Retry-After: 2`. A same-body waiter that reaches the
request deadline receives the existing `504 completion_timeout`; client
disconnect and shutdown keep their existing behaviour (no body, and `503
service_unavailable` respectively). A supplied key **requires** configured,
healthy Redis: otherwise the request fails closed **before** any completion work.

Since Phase 5A a supplied key on a request that is ALSO eligible for OpenCode
thread reuse (section 5.1.1) is rejected with `400 unsupported_parameter` before
either feature touches Redis. The two have incompatible finalization semantics —
this one caches and replays a single answer for a key, while reuse advances a
session's upstream thread on every turn — so the combination is refused rather
than honoured partially. Nothing in this section changes for any other request:
the derivation constants, record format, Lua scripts, and reply semantics are
byte-for-byte unchanged, and existing records stay readable.

**"Same body" is the canonical full parsed JSON.** JSON whitespace and object-key
order are insignificant; array order is significant; and EVERY submitted field
participates, including tool metadata the gateway tolerates and discards for a
text-only model (section 9.4). The fingerprint is computed after authentication
and successful normal request validation, while the original parsed body is
still available. The canonicalizer traverses only data-property descriptors
(never a getter, `toJSON`, iterator, or Proxy `get`), preserves every JSON key
including `__proto__`, sorts object keys recursively, is iterative and bounded in
depth/nodes/bytes, streams canonical tokens directly into an HMAC, and fails
closed without inspecting a thrown value.

String and object-key encoding MUST be LOSSLESS over the whole JavaScript string
domain, so the fingerprint is injective for every distinct parsed body. A raw
UTF-8 encoding is not: every unpaired UTF-16 surrogate — and a literal `U+FFFD` —
collapses onto the same replacement bytes, which would let one body replay
another's cached answer instead of returning `409`. Each string is therefore
emitted in a well-formed escaped form that encodes an unpaired surrogate
explicitly, length-framed so the token stream stays unambiguous.

**Key derivation (Node built-in cryptography).** One configured 32-byte master
key (`IDEMPOTENCY_ENCRYPTION_KEY`) is expanded with HKDF-SHA-256 into three
domain-separated subkeys: a Redis-key/scope HMAC key, a body-fingerprint HMAC
key, and an AES-256-GCM key. The Redis storage key is an HMAC over the configured
namespace, a stable gateway-key scope, and the client's idempotency key. That
scope is itself an HMAC of the raw gateway key, so it is identical on every
replica and independent of `COLLECTIVIQ_GATEWAY_KEYS` ordering — unlike the
process-local capacity identity `k<index>` (section 9.1). Gateway authentication
now exposes both identities; neither is ever logged or returned.

**Stored state.** Records are versioned, strictly validated, size-bounded JSON
with four states — `reserved`, `processing`, `final`, `ambiguous` — carrying only
a record version, the state, the keyed body fingerprint, a random owner token, an
informational expiry (Redis `PX` is authoritative), and, for `final`, the
encrypted payload. Redis never holds a prompt, request body, authorization value,
raw gateway key, raw idempotency key, thread title, Redis URL, or upstream thread
id. The cached payload is a versioned document holding only the original
completion id, the original creation time, the requested model, the result
discriminator, and either the assistant text or the validated tool calls. It is
encrypted with a fresh random 96-bit nonce per record, and the record version,
storage key, and body fingerprint are bound through the authenticated associated
data, so a relocated, rebound, or tampered ciphertext fails closed.

**Lifecycle.** Claim and every compare-and-transition are single atomic Lua
scripts (never a GET-then-SET sequence):

1. `reserved` is created atomically **before** capacity or upstream work. The same
   fingerprint may wait; a different fingerprint is `409`.
2. The owner enters the existing completion run.
3. After capacity succeeds, an asynchronous lifecycle hook atomically moves
   `reserved → processing`.
4. Only after that transition succeeds may `create_thread` be attempted.
5. A successful completion must atomically persist `processing → final` **before**
   any successful JSON body or SSE content/terminal frame is emitted.
6. Any failure at or after `processing` remains blocked as `ambiguous` for the
   TTL, because `create_thread`/`process_message` have no proven idempotency
   (section 17.1) and the upstream side effect may already have happened.
7. A proven failure **before** `processing` — capacity rejection, cancellation, or
   the transition itself failing — compare-and-deletes the owner's own `reserved`
   record, so a transient local failure does not block the key.
8. A Redis failure while marking `processing` releases capacity and performs no
   upstream call.
9. A Redis failure while persisting `final` never emits the answer: the request
   returns `idempotency_unavailable` and the record is best-effort tombstoned as
   `ambiguous`.
10. Active owners renew their lease periodically (30 s lease, 10 s cadence). A lost
    renewal aborts the request and never permits takeover.
11. A waiter never takes over a disappeared, expired, corrupt, or ownerless record
    during the same request; it fails `503`.
12. The `final` TTL starts when `final` is committed. Active and ambiguous records
    stay bounded by the lease/TTL policy.

Waiting is bounded, cancellation-aware polling with backoff (100 ms → ×1.25 →
1000 ms, jittered) under the model's own request deadline, plus an absolute
iteration ceiling as a stalled-clock backstop. Pub/Sub is deliberately not used
as a source of truth. Waiters take no capacity permit because they perform no
upstream work.

**Replay.** A successful replay reuses the original identity and result: the JSON
response repeats the original id, timestamp, model, content or tool calls, finish
reason, and zero/unavailable usage representation; the SSE response emits
deterministic frames built from the original metadata and result (timing and
keep-alive comments are not reproduced). The duplicate request's own `prepare`
still runs first — so a preparation failure creates no record — and its freshly
minted completion id is discarded and never returned. Native-title correlation
(section 9.5) is registered only for the original owner while its in-memory
result still carries the upstream thread id; waiters and replays never register
one, and Redis retention is not expanded to recover it.

**Lease policy.** The two active states carry DIFFERENT leases, because losing
them has different consequences. A `reserved` record (claimed, no upstream call
yet) uses a short 30 s lease: losing it is safe, since the original owner's
`reserved → processing` transition is owner-token guarded and reports `lost`
rather than proceeding. A `processing` record instead uses a lease derived from
the request's own total deadline (`requestTimeoutMs` + 30 s, capped at 630 s), so
a LIVE owner's record can never expire mid-completion — even under event-loop
starvation that delays renewal — because the owner's own deadline fires first.
The lease therefore acts as a crash reaper rather than a race window. A hard
replica kill during `processing` consequently blocks that key for up to the
derived lease, which is deliberately preferred over risking a duplicate billed
completion.

Because the two leases differ, the renewal operation MUST choose between them
from the AUTHORITATIVE STORED STATE, atomically, and must never accept a single
duration selected by the caller. A renewal races the `reserved → processing`
transition: Redis can apply that transition while the transitioning caller is
still awaiting its reply, so a caller-selected duration could carry the stale
`reserved` view and shorten a live `processing` record's TTL — which is precisely
the expiry the derived lease exists to prevent. The renewal reply reports which
state it observed.

**Required Redis server configuration.** The instance backing idempotency MUST
NOT evict keys: `maxmemory-policy` must be `noeviction` (or the instance must be
sized so eviction never occurs). Under `allkeys-*` or `volatile-*` an evicted
`processing` record silently permits a concurrent claim and therefore a duplicate
upstream completion, and an evicted `final` record silently re-runs a completed
request. The gateway cannot detect this, so it is a deployment requirement.
Similarly, a Redis endpoint with asynchronous replication and failover, or a
standalone instance that loses its state, can drop an acknowledged `final` record
and permit one duplicate completion.

**Residual limits.** Protection is bounded to the configured TTL. CollectivIQ's
own POST-idempotency semantics remain unknown, so the gateway's guarantee is
gateway-side only. Rotating the encryption key requires draining traffic and
waiting at least one maximum TTL. All replicas must share the same encryption
key, namespace, Redis endpoint, gateway-key set, AND model configuration:
`REDIS_KEY_PREFIX` and the key HMAC do not cover the resolved virtual-model
policy, so two replicas that resolve the same model id to different
`selectedLlms`/`promptMode`/`answerSource` would treat their answers as
interchangeable. Mixed encryption keys during a rolling deployment are
unsupported. The `stream` flag is part of the submitted body, so replaying the
same key with a different transport is a `409`, not a cross-transport replay. A
completion that fails at or after `processing` — including a `504` timeout —
blocks that key for the full TTL, which is stricter than an unkeyed retry would
be; that is the intended fail-closed trade. Record metadata (`s`, `f`, `o`, `e`)
is not individually authenticated: an actor with Redis WRITE access can cause a
targeted denial of service (a forced `409` or `503`) but cannot obtain another
caller's answer, because the payload's associated data binds the record version,
storage key, and body fingerprint. Waiters take no capacity permit, so a client
retrying one slow key many times produces proportional bounded polling. Since
Phase 4B a waiter DOES consume one cross-replica rate-limit unit when that
optional feature is enabled (section 19.1); with it disabled — the default — a
waiter is not metered at all.

**Transport note.** On the streamed path, response headers (HTTP `200`) and the
assistant-role opener are committed before `run()`, so a `reserved → processing`
or `processing → final` failure cannot be an HTTP `503`. It is emitted instead as
a single content-free `data: {"error": …}` SSE record carrying the
`idempotency_unavailable` envelope, followed by `data: [DONE]`, with no content
and no terminal chunk. Only pre-header failures (invalid header, conflict,
unavailable Redis, and a waiter's own conflict/timeout/unavailable outcome) use a
real HTTP status.

---

## 19. Concurrency and Backpressure

Configuration:

```text
MAX_CONCURRENT_REQUESTS=4
MAX_CONCURRENT_REQUESTS_PER_KEY=2
MAX_QUEUED_REQUESTS=20
```

When capacity is exhausted:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 5
```

```json
{
  "error": {
    "message": "The CollectivIQ Gateway is at capacity.",
    "type": "rate_limit_error",
    "param": null,
    "code": "gateway_capacity_exceeded"
  }
}
```

A semaphore must be acquired before creating a CollectivIQ thread.

Queued requests must have a maximum queue duration.

### 19.1 Cross-replica rate limiting (Phase 4B, implemented — optional, off by default)

Redis-backed, cross-replica, per-gateway-key rate limiting for
`POST /v1/chat/completions` is implemented in `src/rate-limit/` and is
**optional**. With `RATE_LIMIT_ENABLED=false` (the default) no limiter is built,
no scope is derived, and not a single Redis rate-limit operation occurs: the
route behaves exactly as it did before Phase 4B. This phase left the capacity
semaphore above completely unchanged; whether its ACTIVE limits span replicas is
decided independently by section 19.2's own flag, and the two controls remain
separate concerns either way.

The two concerns are deliberately distinct. Capacity answers "is this replica
busy right now"; the rate limit answers "has this API key consumed its
configured share", independently of how busy any replica is. They have separate
identities, separate errors, and separate exhaustion behaviour.

**Configuration.** Four validated environment variables (section 24). Present
values are validated even while the feature is disabled, so a deployment cannot
carry a silently broken setting that only fails the day it is switched on.
Enabling the feature **requires** a valid `REDIS_URL`, which by the existing
Phase 4A rule requires `IDEMPOTENCY_ENCRYPTION_KEY`; a shared quota cannot be
enforced from process-local state, so enabling it without an endpoint is a
value-free `ConfigError` rather than a silent downgrade to no limiting.

**GCRA.** The generic cell rate algorithm is used instead of a fixed window
because its entire state is one integer — the theoretical arrival time (TAT) of
the next conforming request — which makes the decision a single atomic
compare-and-set and keeps the stored value free of any counter history:

```text
intervalUs  = ceil(RATE_LIMIT_WINDOW_MS * 1000 / RATE_LIMIT_REQUESTS)
toleranceUs = (RATE_LIMIT_BURST - 1) * intervalUs
tat         = max(storedTat, now)            // an absent record means `now`
allowed    <=> now >= tat - toleranceUs
newTat      = tat + intervalUs               // written on allow only
delayUs     = tat - toleranceUs - now        // returned on reject only
```

The parameters are derived once from validated configuration. The interval is
additionally floored at 1 µs and the tolerance at 0 as fail-closed backstops;
within the configured bounds neither clamp ever changes a value (the smallest
reachable interval is 10 µs, and `RATE_LIMIT_BURST = 1` yields a tolerance of
exactly 0 — no immediate burst). With the defaults — 60 requests / 60 000 ms /
burst 8 — the interval is 1 000 000 µs, so a cold scope admits 8 requests
immediately and then one per second.

Exactly ONE atomic Lua script runs per request. There is no read-then-write
anywhere: the script reads the clock, reads the stored TAT, decides, and writes
only when it admits the request. Two replicas racing the same scope are
serialized by Redis, not by any local lock or counter.

**Time comes from Redis `TIME`, never a Node or process clock.** Replica clocks
drift and can jump; a process clock would make the shared quota inconsistent
between gateways and would let a skewed replica admit a burst another replica had
already spent. Redis is the single source of time exactly as it is the single
source of state.

On allow the new TAT is stored with `PX = max(1, ceil((newTat - now) / 1000))`
milliseconds — long enough for the bucket to replenish fully, so an expired key
is indistinguishable from a fully replenished one. On reject nothing is written
and the script returns `delayUs`; the caller converts it with `ceil` to whole
seconds, clamped to `[1, 3600]`. A non-finite or non-positive delay is treated as
the minimum rather than trusted, so a corrupt reply can never produce a
nonsensical header.

**Key derivation and privacy.** The rate-limit HMAC subkey is derived from the
same configured 32-byte master key (`IDEMPOTENCY_ENCRYPTION_KEY`) but expanded
under a DISTINCT HKDF-SHA-256 salt and `info` label, with its own domain tags
mixed into each HMAC input. It is therefore cryptographically independent of
every idempotency subkey, and a gateway key's rate-limit scope is a different
value from its idempotency scope. No code is shared with
`src/idempotency/keyring.ts` — the small length-framing helper is deliberately
duplicated — so a change here can never re-key already-stored idempotency
records. Derivation is deterministic, so every replica configured with the same
master key computes the same scope for the same gateway key (which is what makes
one quota span replicas) and it is independent of `COLLECTIVIQ_GATEWAY_KEYS`
ORDER, unlike the process-local capacity identity `k<index>` (section 9.1). The
scope is computed ONCE per configured key at authenticator construction, so the
raw key is never re-read per request. Gateway authentication now exposes three
opaque identities — `keyId`, the idempotency `scopeId`, and the rate-limit scope
— and none is ever logged, reflected, or returned.

The Redis key is `<REDIS_KEY_PREFIX>:rate:<HMAC digest>`: a readable operational
prefix, the fixed `rate` category that keeps quota keys from ever colliding with
the `idem` keyspace, and a keyed digest. Redis therefore never holds a raw
gateway key, the process-local `k<index>`, an authorization value, a prompt, a
request body, a model id, a thread id, or completion content.

**Stored state and its validation.** The value is ONLY a bounded decimal integer
of microseconds — no counter history, no identity, no content. Its size is
checked with `STRLEN` **before** the script's internal `GET`, so an oversized or
hostile value is classified corrupt without its bytes ever being read; there is
no direct Node/client `GET` at all. A value that is missing-but-present (empty
yet existing), non-integer, negative, oversized, or otherwise unparseable fails
**CLOSED** as unavailable. The script never resets the value, never repairs it,
and never silently admits the request.

Limiter operations are abort-aware and TOTAL: they return a closed
`allowed | limited | unavailable | cancelled` decision rather than throwing, so
the caller can always fail closed without inspecting a thrown value.

**Admission order.** For `POST /v1/chat/completions`, on both transports:

```text
gateway authentication (the /v1 onRequest hook)
  -> request validation, model resolution, tool normalization
  -> Idempotency-Key validation and canonical body fingerprinting (when supplied)
  -> thread-reuse eligibility (section 5.1.1)          -> 400 (invalid session id / key+reuse)
  -> keyed request whose idempotency cannot be honoured -> 503 idempotency_unavailable
  -> prompt preparation
  -> cross-replica rate limit                          -> 429 / 503
  -> OpenCode thread-reuse lease (section 5.1.1)       -> 409 / 503
  -> idempotency claim, wait, or replay                -> 409 / 503 / cached result
  -> local FIFO queue + capacity                       -> 429 gateway_capacity_exceeded
     (optionally a shared permit, section 19.2)        -> 503 capacity_unavailable
  -> upstream work
```

The idempotency header and fingerprint steps precede prompt preparation because
that is the pre-existing Phase 4A order (section 18.1), deliberately preserved so
no Phase 4A behaviour changed. What Phase 4B requires is that the rate-limit gate
sits after ALL input validation and preparation and before the claim, capacity,
any SSE header, and any upstream call. The Phase 5A reuse steps slot around it
without moving anything: eligibility is decided before either Redis feature
engages, and the lease is taken after the rate-limit decision. Reuse and
idempotency are mutually exclusive, so the claim step is unreachable for an
eligible reuse request.

**What consumes quota.** Exactly one unit per otherwise-valid attempt, and quota
is NEVER refunded — a later capacity rejection or completion failure keeps its
already-spent unit.

| Attempt | Consumes |
| --- | :--- |
| A normal completion | one unit |
| An idempotency owner, a waiter, a cached replay, and a different-body `409` conflict | one unit EACH |
| A thread-reuse attempt that is busy (`409`) or unavailable (`503`) | one unit EACH |
| Invalid authentication, an invalid request, or a preparation failure | nothing |
| An invalid `Idempotency-Key`, an unfingerprintable body, or a keyed request whose idempotency is unavailable | nothing |
| An invalid OpenCode session header, or an `Idempotency-Key` combined with reuse | nothing |
| A request the limiter itself rejects | nothing (the stored TAT is not mutated) |

A limited request creates no idempotency claim, acquires no thread-reuse lease,
takes no capacity permit, commits no SSE header, registers no native-title
correlation (section 9.5), and makes no upstream call. A **streamed** request rejected at this gate therefore receives an
ordinary JSON `429`/`503`, never an SSE error record. Only
`POST /v1/chat/completions` is metered: `/healthz`, `/readyz`,
`GET /v1/models`, `GET /v1/models/:model`, and `GET /v1/opencode/session-title`
are NOT rate limited, because model metadata and the session-title extension are
cheap, non-generative reads that must stay available while a key's completion
quota is exhausted.

**Public errors** (section 20). Both bodies are fixed and content-free: neither
reveals the configured limit, the remaining quota, the scope, or the key.

| Condition | HTTP | Type | Code | `param` | `Retry-After` |
| --- | ---: | --- | --- | --- | --- |
| Quota exhausted for the presented key | 429 | `rate_limit_error` | `gateway_rate_limit_exceeded` | `null` | DYNAMIC positive integer computed by the limiter |
| The decision could not be made | 503 | `server_error` | `rate_limit_unavailable` | `null` | fixed `2` |

The `429` message is
`The gateway rate limit for this API key has been exceeded.`; the `503` message
is `Gateway rate limiting is currently unavailable.` The route's `Retry-After`
handling was refactored so an envelope carrying its OWN value wins and every
other `429` keeps the long-standing fixed `Retry-After: 5` — so gateway capacity
and upstream quota `429`s are unchanged. No success or remaining-quota headers
were added in this phase.

**Fail-closed dependency behaviour.** A disconnected Redis, a command timeout, a
corrupt stored value, an unusable reply, a limiter wired without a derived scope,
and `RATE_LIMIT_ENABLED=true` with no limiter composed at all each produce
`503 rate_limit_unavailable`. Validated CONFIGURATION — not the presence of an
injected limiter — decides whether the gate runs, so an enabled-but-unwired
instance fails closed instead of silently serving unmetered traffic; only the
consistent disabled state (`RATE_LIMIT_ENABLED=false` and no limiter) skips the
gate entirely. The gateway never admits unmetered traffic when the limiter is
enabled but cannot decide. While the
decision is awaited, a client disconnect produces no response body and a shutdown
keeps the existing `503 service_unavailable`, matching every other cancellation
on this route.

**Shared connection.** Phase 4B introduces `src/redis/`, the shared internal
Redis substrate. `client.ts` is the ONLY module in the repository that imports
node-redis; it owns the client, the mandatory content-free `error` listener, the
disabled offline queue, the bounded connect/command deadlines, the capped
reconnect strategy, synchronous `isReady`, connect/close (bounded graceful close
with a force-destroy fallback), and a generic `evalScript` with an
`EVALSHA` → `EVAL` `NOSCRIPT` fallback that is TOTAL (every failure returns
`null`; it never throws). The four connection bounds moved from
`src/idempotency/limits.ts` to `src/redis/limits.ts` with their VALUES
unchanged. `src/redis/runtime.ts` is the Redis composition root: it creates
EXACTLY ONE client per process and composes every enabled Redis-backed service
over it, or returns nothing when `REDIS_URL` is blank/absent. It is deliberately
not re-exported from the substrate barrel, so the dependency direction stays
one-way (features → substrate).

`src/idempotency/redis-store.ts` now builds its store over that substrate instead
of owning a connection. Its five Lua scripts, every derivation constant, the
record and payload formats, and all reply semantics are BYTE-FOR-BYTE unchanged,
so existing Redis keys and records remain readable and no Phase 4A behaviour
changed. A second client would double the socket budget, split readiness, and
make "Redis is up" mean two different things.

**Readiness and shutdown** keep their section 28.2 and 31.3 semantics, now over
one shared connection and ONE probe covering every enabled Redis-backed feature.
A configured but disconnected or reconnecting Redis keeps `/readyz` at `503`
while `/healthz` stays `200`; recovery restores readiness without a restart;
shutdown stops admission, drains, and then closes the one Redis connection last,
exactly once. CollectivIQ readiness semantics are unchanged (still not a probe).

**Residual limits.**

- Enforcement is bounded to the configured window: the algorithm smooths a rate,
  it does not cap total spend over a longer horizon.
- Every replica must share the same Redis endpoint, encryption key,
  `REDIS_KEY_PREFIX`, gateway-key set, AND rate-limit settings. Divergent
  settings mean the quota is not the single shared quota it appears to be.
- A Redis outage fails closed, so enabling this feature deliberately trades
  availability for correctness on the completion path. That is the intended
  trade: unmetered traffic during an outage would defeat the control.
- The `maxmemory-policy noeviction` requirement of section 18.1 applies here too.
  An evicted quota key resets that key's allowance to a full burst; the gateway
  cannot detect this, so it remains a deployment requirement.
- No dependency was added: `redis` was already a pinned direct dependency, and
  the lockfile is unchanged.
- Capacity, queueing, and queue-wait were process-local when this phase landed.
  Cross-replica ACTIVE capacity is now available as an optional, off-by-default
  feature; section 19.2 owns it.

### 19.2 Cross-replica capacity (Phase 4D, implemented — optional, off by default)

Redis-backed, cross-replica enforcement of the gateway's global and
per-gateway-key ACTIVE limits is implemented in `src/shared-capacity/` and is
**optional**. With `SHARED_CAPACITY_ENABLED=false` (the default) no coordinator
is built, no capacity scope is derived, and not a single Redis capacity operation
occurs: admission is the process-local controller of section 19, byte for byte.

Only the two ACTIVE permits are shared. **Queueing stays process-local.** That
split is the whole design:

| Setting | Disabled (default) | Enabled |
| --- | --- | --- |
| `MAX_CONCURRENT_REQUESTS` | per replica | **cluster-wide** |
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | per replica | **cluster-wide** |
| `MAX_QUEUED_REQUESTS` | per replica | per replica |
| `MAX_QUEUE_WAIT_MS` | per replica | per replica |

Sharing the ACTIVE limits is what makes `MAX_CONCURRENT_REQUESTS` mean what an
operator reads it to mean: without it, four replicas configured for four
concurrent completions admit sixteen, and the upstream cost and thread volume
scale with the replica count rather than with the configured limit. Sharing the
QUEUE would be a different feature — a distributed work queue with its own
fairness, ordering, and starvation semantics — and is deliberately not attempted.

**Local FIFO order and per-key bypass are preserved. Cross-replica fairness is
NOT promised.** Each replica admits its own waiters in arrival order, and a
waiter blocked by its key's limit is skipped so a later waiter with a different
key can proceed — exactly as section 19 has always behaved. Across replicas,
however, the replicas simply compete for the shared budget: a busy replica's
queue does not yield to an idle one, and a long-queued waiter on one replica has
no priority over a fresh arrival on another. Anything stronger would require the
shared queue this phase declines to build.

**Configuration.** ONE validated environment variable (section 24),
`SHARED_CAPACITY_ENABLED`, strictly parsed as `"true"`/`"false"`. A
present-but-invalid value is a value-free `ConfigError` even while the feature
would be disabled, so a deployment cannot carry a silently broken setting that
only fails the day it is switched on. Enabling the feature **requires** a valid
`REDIS_URL`, which by the existing Phase 4A rule requires
`IDEMPOTENCY_ENCRYPTION_KEY`; a shared budget cannot be enforced from
process-local state, so enabling it without an endpoint is a value-free
`ConfigError` rather than a silent downgrade to per-replica limits — which would
multiply the configured limit by the replica count. The feature introduces **no
new secret, no new tuning variable, and no new dependency**.

**Key derivation and privacy.** The capacity HMAC subkey is derived from the same
configured 32-byte master key but expanded under a DISTINCT HKDF-SHA-256 salt and
`info` label, with its own domain tags mixed into each HMAC input. It is
therefore cryptographically independent of every idempotency, rate-limit, and
thread-reuse subkey, and a gateway key's capacity scope is a different value from
its other three scopes. No code is shared with the other three keyrings — the
small length-framing helper is deliberately duplicated — so a change here can
never re-key another feature's stored state.

Gateway authentication now exposes FIVE opaque identities: the process-local
`keyId` plus four cross-replica scopes (idempotency, rate limit, thread reuse,
capacity). The capacity scope is computed ONCE per configured key at
authenticator construction, is identical on every replica configured with the
same master key, and is independent of `COLLECTIVIQ_GATEWAY_KEYS` ORDER. **The
process-local `k<index>` of section 9.1 is never written to Redis**: it is
ordering dependent, so two replicas with differently ordered key lists would
disagree about which key a stored permit belongs to. None of the five identities
is ever logged, reflected, or returned.

**Stored state.** ONE namespace-level sorted set at
`<REDIS_KEY_PREFIX>:capacity:<HMAC digest>`. The fixed `capacity` category keeps
it from ever colliding with the `idem`, `rate`, or `reuse` keyspaces. There is
deliberately no per-scope key: the GLOBAL limit has to be counted across all
gateway keys, which per-scope keys could not do atomically.

Each member is a strict versioned encoding of exactly two opaque components:

```text
member: <version>|<owner token>|<capacity scope>
score:  <integer lease deadline, in Redis milliseconds>
```

Both components are **exact CANONICAL unpadded base64url encodings** — the owner
of exactly 16 bytes (22 characters), the scope of exactly one SHA-256 digest (43
characters) — and the delimiter is outside that alphabet, so a member splits
unambiguously and no component can forge an extra field. Canonicality is
enforced, not merely length and alphabet: unpadded base64url carries 6 bits per
character, so an encoding whose byte count is not a multiple of 3 has spare low
bits in its final character that a canonical encoder leaves ZERO. Accepting a
non-zero spelling would accept a SECOND name for the same bytes, and a member's
identity IS its byte string — two spellings of one owner token would be two
registry members for one permit. The server-side validator therefore restricts
the final character to the class that keeps those bits zero, and the TypeScript
validators re-encode and compare, because Node decodes a non-canonical trailing
character silently.

The owner token is 128 bits of CSPRNG output — unguessable, so no caller can
release a permit it does not hold. The registry holds **no request, thread,
session, model, tool, prompt, answer, credential, raw gateway key, or
process-local identity**, and the score is always stamped from Redis's own clock.

**Time comes from Redis `TIME`, never a Node or process clock**, for the same
reason as section 19.1: a skewed replica could otherwise mint a permit that
outlives every other replica's view of it, or treat a live permit as expired and
over-admit.

**Bounded validation before any mutation.** `STRLEN` is not applicable to a
sorted set, so the scripts bound differently and in this order: check `TYPE`
before any ZSET command (a wrong-type key would otherwise raise `WRONGTYPE` and
lose the closed `corrupt` classification), reject over-cardinality with `ZCARD`
BEFORE any member is materialized, then read at most the configured maximum with
one bounded `ZRANGE ... WITHSCORES`, then validate EVERY member and score
completely — version, delimiter structure, exact canonical component encodings,
byte bound, score, and owner-token uniqueness. Only after all of that may a
script prune or mutate. A wrong type, an over-cardinality registry, a malformed
member or score, a duplicated owner token, or an unexpected reply shape returns a
closed `corrupt` result and leaves the registry **byte for byte untouched** — the
gateway never sanitizes hostile state into valid state.

**A stored deadline is bounded RELATIVE TO Redis time**, not merely required to
be a non-negative integer: every score must satisfy
`0 <= deadline <= NOW_MS + MAX_CAPACITY_LEASE_MS`, checked inside that same
pre-mutation validation. Without the upper bound a forged far-future score would
be permanently unexpirable — it would never prune, and because the key is
re-expired at the latest active lease it would pin the whole registry's lifetime
and under-admit the entire cluster indefinitely. Exactly at the bound is valid,
one millisecond over is `corrupt` from BOTH scripts with the registry and its TTL
untouched, and a legitimately PAST deadline stays valid and is pruned after full
validation — "expired" and "invalid" are different conditions.

Every fixed numeric argument is likewise required to be integral and positive,
with `MAX_ACTIVE` no greater than the absolute configured ceiling,
`MAX_PER_SCOPE <= MAX_ACTIVE`, the candidate count within both the batch ceiling
and `MAX_ACTIVE`, and each lease within the fixed lease ceiling. A malformed
store input can therefore never widen a fixed bound.

Owner-token uniqueness is judged twice, at different scopes, because they answer
different questions: two STORED members sharing a token — expired or not — means
the registry was not written solely by honest gateways and is `corrupt`, while an
incoming CANDIDATE is checked only against LIVE members, since an expired
member's token is about to be pruned and is not in use.

Over-cardinality therefore prunes nothing. An honest gateway cannot reach that
bound, because it never grants beyond the configured global limit, so reaching it
requires an external writer — and recovery depends on that writer: a registry
whose expiry the gateway last set clears itself within one lease window, but a
key created externally WITHOUT a TTL stays over-cardinality until an operator
removes it, and shared capacity stays `503` for as long as it does. That is the
intended trade; the alternative is trusting state of unknown provenance.

**Exactly two atomic scripts.**

`claimBatch` obtains Redis `TIME`, validates the complete registry and every
candidate — including the batch's own size against BOTH the fixed ceiling and the
cluster-wide global limit, so a caller can neither widen the bound the registry
is willing to materialize nor submit a batch that could never be granted in full
— prunes expired leases, counts global and per-scope occupancy, then
iterates an ordered bounded candidate list in local FIFO order: a candidate whose
scope is already at the per-scope limit is SKIPPED so a later distinct scope can
still be granted, and granting stops the moment global occupancy reaches the
global limit. Granted members are added atomically and the reply names **the
exact granted owner tokens, not a count** — per-key bypass means the granted set
is not a prefix of the candidate list, so a count would be ambiguous about which
waiters may proceed. The key is then re-expired at the latest active lease.

`release` validates the complete registry, prunes expired leases, removes the
exact `version | owner | scope` member idempotently, and deletes the key when the
registry becomes empty or otherwise re-expires it at the latest remaining lease.

**A reply is validated against the request that produced it.** Redis is a
dependency, not a trusted authority, so naming an owner is not enough to be
granted one: a `claimed` reply is accepted only when every named owner is
canonical, appears in the SUBMITTED candidate list, appears at most once, and the
names appear in candidate order. It is an ordered SUBSET rather than a prefix,
because per-scope bypass legitimately skips candidates. An unknown, duplicated,
reordered, non-string, or non-canonical owner makes the whole reply
`unavailable` — never a partially trusted grant list, because a permit handed to
a waiter nobody claimed for is a permit nothing will ever release. An EMPTY
granted list stays valid: that is ordinary full-cluster backpressure. `corrupt`
is accepted only at exact arity one, and `release` accepts only exact `ok` or
`corrupt`; any extra field is `unavailable`. A malformed reply is treated exactly
like an unavailable one — never retried and never compensated — because the
mutation may already have applied. A submitted batch containing a duplicated
owner token is refused before any command is issued.

**There is no renewal script and no heartbeat.** The lease is a CRASH REAPER, not
a liveness mechanism, and is derived from the holder's own total deadline plus a
fixed 30-second margin, capped at 630 000 ms (the largest configurable model
deadline plus the margin). A live request's permit therefore cannot expire
mid-completion — the request's own deadline always fires first — while a
hard-killed replica's permits are still reclaimed within a bounded window.
Renewal would add the opposite failure: a starved replica could lose a permit it
is legitimately using.

**Local scheduler.** One process-local FIFO queue drives at most ONE Redis claim
per process at a time. Batching is what lets the server apply the per-key limit
across several waiters atomically, and single-flight keeps a burst of arrivals
from becoming a burst of round trips. Batches are built in FIFO order, contain no
more than the per-key limit from any one scope, and are capped at the configured
global limit (at most 1024).

A pending claim CANDIDATE is counted separately from a queued WAITER, so
`MAX_QUEUED_REQUESTS=0` still admits a request that can be granted immediately —
the shared analogue of the local controller's fast path, which cannot exist here
because occupancy is only knowable after a round trip. The honest cost of that
carve-out is that a replica's in-system bound becomes
`MAX_CONCURRENT_REQUESTS + batch + MAX_QUEUED_REQUESTS` rather than the local
controller's `MAX_CONCURRENT_REQUESTS + MAX_QUEUED_REQUESTS`. The extra term is
bounded by the batch size, lasts one Redis command deadline, and none of those
candidates holds a permit or makes an upstream call — but `MAX_QUEUED_REQUESTS`
is no longer the exact bound on requests waiting inside one replica.

**The queue bound is REAPPLIED after every settlement**, which is what keeps that
carve-out from becoming an unbounded exception. When a claim grants only part of
its batch (or nothing), the ungranted candidates are merged back AHEAD of
whatever arrived during the claim, exact FIFO order is preserved, and only the
earliest `MAX_QUEUED_REQUESTS` waiters are retained; every overflow waiter is
resolved exactly once with the ordinary capacity `429` and has its queue-wait
timer and abort listener detached. So pending candidates may exceed the bound
only for the duration of one in-flight Redis command, and the steady-state queue
never does. With `MAX_QUEUED_REQUESTS=0` the consequence is exact: one request is
still admitted to ask Redis, and if that claim grants nothing it receives the
`429` rather than being left to retry forever.

**An arrival never pre-empts the retry backoff.** A request arriving with no
claim and no retry pending starts a claim immediately; a request arriving while a
retry is scheduled joins the queue and neither cancels nor accelerates the timer.
Letting arrivals cancel the timer would make a busy replica issue claims at
arrival frequency rather than at the bounded retry cadence — defeating the
backoff exactly when the cluster is most contended. At most one timer and one
in-flight claim exist per process at any time.

Exactly THREE paths start a claim for a queue that is already waiting:

1. the **retry timer**;
2. a **release attempt for a permit this replica confirmed it held**, which may
   cancel the timer and claim at once. Be precise about what that knows: only the
   LOCAL side is confirmed — the replica held the permit and has decremented its
   own accounting — while the Redis release is best effort and is not awaited, so
   it may throw, reject, or go unacknowledged, leaving the member to its lease
   deadline with CLUSTER occupancy unchanged. It therefore provides ONE bounded
   immediate probe per locally released permit, and that probe may simply observe
   the permit still held; it does not assert that Redis acknowledged the deletion
   or that occupancy necessarily fell. It is worth taking because the common case
   is a successful release;
3. the **settlement of a fail-closed claim**, which immediately starts one fresh
   decision for the DISTINCT waiters that arrived while it was in flight and were
   therefore excluded from it. This is neither a retry nor a reconciliation of the
   batch that failed — those candidates are settled `unavailable` and are never
   reissued — and it is not an arrival pre-empting a scheduled retry, because a
   claim was in flight until that moment so none can have been armed. It is a
   FIRST decision for waiters that have had none, bounded by the same one-claim-
   in-flight rule and the same local queue limits as any other claim.

A retry armed for a queue that subsequently DRAINS — every waiter cancelled or
timed out — is released when the last waiter leaves. That is timer hygiene, not a
fourth path: it starts no claim, and it fires only for an empty queue, so it
can never let a departure hand the next arrival an immediate claim while other
waiters are still owed the backoff. Without it the timer would outlive its
purpose and the next arrival on an otherwise idle replica would decline to claim
and wait out its remainder — up to `CAPACITY_RETRY_MAX_MS` of pure added latency.

**Being at the cluster limit is backpressure, not a rejection.** A claim that
grants nothing leaves its waiters queued, keeping their places at the front of
the queue ahead of anything that arrived during the claim, and retries with a
bounded schedule: 100 ms initial, 1.25× backoff, a 1-second cap, and 25 %
symmetric jitter so replicas that became full at the same instant do not retry in
lockstep. Any grant resets the backoff to its floor, and a release attempt for a
locally held permit schedules a claim immediately rather than waiting out the
delay, on the terms set out in path 2 above. Only the queue-length and queue-wait
bounds produce a `429`.

**Fail-closed dependency behaviour.** An unavailable, corrupt, or ambiguous claim
reply is **never retried and never compensated**. Whether a member was added is
unknown, so a retry could double-count a permit this replica already holds and a
speculative release could remove one another replica now holds. Every live waiter
in that batch fails closed, and any member that WAS added is an orphan bounded by
its own lease and invisible to this replica's gauges. Validated CONFIGURATION —
not the presence of an injected coordinator — decides whether the shared path
runs, so `SHARED_CAPACITY_ENABLED=true` with no coordinator composed admits
nothing rather than reverting to per-replica limits.

**A confirmed grant is never dropped.** If a waiter times out, is cancelled, or
is rejected by admission close while the claim is in flight and Redis then
confirms its grant, the permit is released immediately and never delivered —
otherwise nothing would ever give it back. `Permit.release()` stays synchronous
and idempotent: it decrements local active state once, issues a bounded
owner-guarded release WITHOUT the request's abort signal (a released permit must
be returned even when its request was cancelled), and wakes the local scheduler.
A failed or unacknowledged release never changes an already successful response.

**Admission order is unchanged.** The capacity step keeps its existing position
and nothing else moves:

```text
gateway authentication (the /v1 onRequest hook)
  -> request validation, model resolution, tool normalization
  -> Idempotency-Key validation and canonical body fingerprinting (when supplied)
  -> thread-reuse eligibility (section 5.1.1)          -> 400
  -> keyed request whose idempotency cannot be honoured -> 503 idempotency_unavailable
  -> prompt preparation
  -> cross-replica rate limit (section 19.1)           -> 429 / 503
  -> OpenCode thread-reuse lease (section 5.1.1)       -> 409 / 503
  -> idempotency claim, wait, or replay                -> 409 / 503 / cached result
  -> process-local FIFO queue                          -> 429 gateway_capacity_exceeded
     + shared active permit                            -> 503 capacity_unavailable
  -> idempotency / reuse `processing` transition
  -> create or continue thread -> submit once -> poll -> release permit -> encode
```

Consequences that follow from that position:

- rate-limit quota is spent BEFORE capacity and is never refunded, so a capacity
  rejection keeps its already-spent unit;
- an idempotency WAITER and a cached REPLAY take no capacity permit at all;
- an idempotency claim stays `reserved` until a permit is confirmed, and the
  `reserved -> processing` transition still runs after capacity and before
  `create_thread`;
- a capacity `429` or `503` before `processing` releases the idempotency claim
  and RESTORES the thread-reuse mapping, because the failure is provably
  pre-submit and must cost the session nothing;
- on the SSE transport capacity is still reached AFTER the headers and the
  assistant-role opener, so a capacity failure there is a safe content-free
  `data: {"error": ...}` record followed by `data: [DONE]` — not a new HTTP
  status;
- **no `create_thread` or `process_message` retry was added.**

**Public errors** (section 20). Both bodies are fixed and content-free: neither
reveals a limit, current occupancy, a scope, or a key.

| Condition | HTTP | Type | Code | `param` | `Retry-After` |
| --- | ---: | --- | --- | --- | --- |
| Queue full, queue-wait timeout, or closed admission | 429 | `rate_limit_error` | `gateway_capacity_exceeded` | `null` | fixed `5` |
| The shared decision could not be made | 503 | `server_error` | `capacity_unavailable` | `null` | fixed `2` |

The `429` is UNCHANGED and is emitted in both capacity modes; with the feature
enabled it means the cluster's active limits were reached through this replica's
still-local queue. The `503` message is
`Shared gateway capacity accounting is currently unavailable.` The two are
deliberately distinct: the `429` says the cluster is busy and a retry may succeed
shortly, while the `503` says the gateway cannot tell how busy the cluster is and
admitting the request anyway would silently exceed the configured limit.

**Shared connection, readiness, and shutdown.** The coordinator composes over the
SAME single Redis client as idempotency, rate limiting, and thread reuse:
`src/redis/client.ts` remains the only module importing node-redis, and
`src/redis/runtime.ts` remains the only place a client is created — exactly one
per process, with ONE readiness probe covering every enabled Redis-backed feature
and ONE shutdown close. `buildServer` stays socket-free and therefore does not
build the coordinator; with the feature enabled, a server constructed without the
process root's wiring is deliberately enabled-but-unwired and fails closed.
Readiness keeps its section 28.2 semantics and shutdown keeps its section 31.3
order — close admission, drain, force-cancel, then close Redis and telemetry last
— with `closeAdmission()` applying to whichever controller is active.

**Observability.** No metric and no span name was added. The only change is the
closed error category `capacity_unavailable` in section 23.2's vocabulary, which
keeps a shared-capacity failure distinguishable from
`gateway_capacity_exceeded`, `rate_limit_unavailable`,
`idempotency_unavailable`, and `thread_reuse_unavailable` in `errors_total`.

The two capacity gauges remain **per instance**. `active_requests` counts
confirmed shared permits held by THIS replica and `queued_requests` counts THIS
replica's waiting requests; no replica can observe cluster occupancy directly.
Aggregating the gauges across replicas approximates live shared occupancy, but
the approximation cannot see an ambiguous claim's orphan lease, so the true
registry size can exceed the aggregate until that lease expires.

**Operational requirements.**

- **Enabling the feature, disabling it, or changing either capacity limit
  requires a coordinated drain and restart.** Mixed local/shared rolling
  operation is UNSUPPORTED: while some replicas enforce the limit locally and
  others share it, the effective limit is neither the configured value nor a
  predictable multiple of it.
- Every replica must share an IDENTICAL Redis endpoint,
  `IDEMPOTENCY_ENCRYPTION_KEY`, `REDIS_KEY_PREFIX`, `COLLECTIVIQ_GATEWAY_KEYS`
  set, `SHARED_CAPACITY_ENABLED` value, AND capacity limits. Divergent settings
  mean the budget is not the single shared budget it appears to be.
- `maxmemory-policy noeviction` remains **mandatory** (section 18.1). An evicted
  registry key forgets every live permit at once.
- Redis persistence and backups remain intentionally unnecessary: the registry is
  short-lived lease state whose loss is bounded by the residual risks below, and
  it holds nothing worth restoring.

**Residual limits.**

- A Redis restart, an eviction, or any other loss of the registry key forgets
  live permits, so the cluster can briefly OVER-admit up to the configured limit
  per replica until the affected requests finish. The gateway cannot detect this.
- A failed or unacknowledged release conservatively UNDER-admits that replica
  until the orphaned lease expires.
- An ambiguous claim reply can leave an orphan lease for up to one lease window.
  It is invisible to local gauges and is deliberately not reconciled.
- Enforcement is a limit on CONCURRENTLY ACTIVE completions, not on total spend;
  section 19.1 owns rate limiting and section 34.4 owns cost amplification.
- A Redis outage fails closed, so enabling this feature deliberately trades
  availability for correctness on the completion path — the same intended trade
  as section 19.1.
- No dependency was added: `redis` was already a pinned direct dependency, and
  the lockfile is unchanged.
- No live CollectivIQ, OpenCode, or OTLP call was made or required.
- Phase 4D closes ONLY the shared cross-replica capacity accounting item of
  Phase 4. Load testing, the broader security review, dependency scanning, and
  backup/release procedures and runbooks remain outstanding (section 32).

---

## 20. Error Mapping

| Condition                   | HTTP | Error type                | Code                             |
| --------------------------- | ---: | ------------------------- | -------------------------------- |
| Invalid gateway key         |  401 | `authentication_error`    | `invalid_api_key`                |
| Unknown model               |  404 | `invalid_request_error`   | `model_not_found`                |
| Invalid request             |  400 | `invalid_request_error`   | `invalid_request`                |
| Invalid `Idempotency-Key`   |  400 | `invalid_request_error`   | `invalid_idempotency_key`        |
| Idempotency-key body conflict | 409 | `invalid_request_error`  | `idempotency_key_conflict`       |
| Idempotency unavailable     |  503 | `server_error`            | `idempotency_unavailable`        |
| Unsupported content         |  400 | `invalid_request_error`   | `unsupported_content_type`       |
| Prompt too large            |  400 | `invalid_request_error`   | `context_length_exceeded`        |
| Gateway capacity            |  429 | `rate_limit_error`        | `gateway_capacity_exceeded`      |
| Shared capacity unavailable |  503 | `server_error`            | `capacity_unavailable`           |
| Gateway rate limit          |  429 | `rate_limit_error`        | `gateway_rate_limit_exceeded`    |
| Rate limiting unavailable   |  503 | `server_error`            | `rate_limit_unavailable`         |
| Invalid OpenCode session id |  400 | `invalid_request_error`   | `invalid_opencode_session_id`    |
| Idempotency-Key with reuse  |  400 | `invalid_request_error`   | `unsupported_parameter`          |
| Session thread already busy |  409 | `invalid_request_error`   | `thread_reuse_busy`              |
| Thread reuse unavailable    |  503 | `server_error`            | `thread_reuse_unavailable`       |
| CollectivIQ quota           |  429 | `rate_limit_error`        | `upstream_quota_exceeded`        |
| CollectivIQ authentication  |  502 | `upstream_error`          | `upstream_authentication_failed` |
| Malformed upstream response |  502 | `upstream_protocol_error` | `invalid_upstream_response`      |
| Invalid required tool call  |  502 | `upstream_protocol_error` | `invalid_tool_response`          |
| Completion timeout          |  504 | `upstream_timeout_error`  | `completion_timeout`             |
| Unexpected gateway failure  |  500 | `server_error`            | `internal_error`                 |

Standard envelope:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "upstream_protocol_error",
    "param": null,
    "code": "invalid_upstream_response"
  }
}
```

Raw CollectivIQ response bodies must not be returned to clients in production.

**Implementation status (Phase 1A, implemented).** The shared envelope factory
and three envelopes are implemented for the `/v1` surface that exists today:
invalid gateway key (`401`), unknown/case-mismatched model (`404`), and any
unexpected `/v1` failure (`500`, `type: "server_error"`, `code: "internal_error"`,
`param: null`, fixed message `The gateway encountered an internal error.`). The
`500` path never inspects or serializes the thrown value's message, stack, cause,
body, headers, or serialization.

**Implementation status (Phase 1B, implemented).** The remaining rows are now
reachable through `POST /v1/chat/completions` (`src/openai/errors.ts` is the
single public-error owner). Added envelopes: invalid request (`400`,
`invalid_request` / `unsupported_parameter` with a static `param` such as
`messages`/`model`/`n`/`stream`/`tools`), unsupported content (`400`,
`unsupported_content_type`, `param: "messages"`), prompt too large (`400`,
`context_length_exceeded`, `param: "messages"`), an oversized-body guard (`413`,
`request_too_large`), gateway capacity (`429`, `gateway_capacity_exceeded`, with
`Retry-After: 5`), and a shutdown guard (`503`, `service_unavailable`). Normalized
`UpstreamError`s map by closed category only (never by reading a body/status/
message): `quota → 429 upstream_quota_exceeded` (with `Retry-After: 5`);
`authentication → 502 upstream_authentication_failed`; `timeout → 504
completion_timeout`; `upstream_protocol`/`response_too_large → 502
invalid_upstream_response`; and `validation`/`transient_http`/`network`/
`unexpected_upstream → 502 upstream_request_failed` (a minimal, stable
transport-category mapping added by this phase). A total-deadline expiry maps to
`504 completion_timeout`; a client disconnect produces no body (there is no
public `499`); a shutdown cancellation with the client still connected maps to
`503`. The route error boundary **fails closed** on trusted request **provenance**, not
on the structure of the thrown value. A thrown value is classified to `400`/`413`
only when it originated in Fastify's parser/body-limit phase — proven by two
trusted per-request markers (gateway authentication completed **and** the handler
body has not begun), the exact window in which nothing but Fastify's own parser
runs. In every other case — an auth/hook failure, or any thrown value once the
handler has begun, **including one forging a Fastify-like `code`/`statusCode` or a
hostile Proxy** — the value becomes the fixed `500` **without being inspected,
serialized, logged, re-thrown, or `instanceof`-tested** (so no getter or
prototype trap runs). Gateway completion errors are recognized by object identity
via a `WeakSet`; normalized upstream errors are likewise recognized by an
identity guard (`isUpstreamError`) rather than `instanceof`, so an arbitrary
thrown value can never impersonate one. The total request deadline **and
cancellation** are **authoritative** in the poller: both are checked before every
`get_messages` and **rechecked the instant the poll settles** — before any answer
is selected or any thrown error is classified. Cancellation observed while a poll
is in flight always wins, so a late fulfilment never returns an answer and a late
rejection is never reinterpreted as a timeout or transport error; a poll or answer
arriving at/after the deadline (with no cancellation) becomes `504
completion_timeout`. No raw upstream body, exception detail, credential, prompt,
answer, or identifier appears in any envelope.

**Implementation status (Phase 4B, implemented — optional, off by default).** The
two rate-limiting rows above are reachable only when `RATE_LIMIT_ENABLED=true`.
`gateway_rate_limit_exceeded` reports the CROSS-REPLICA per-gateway-key quota and
is distinct from the process-local `gateway_capacity_exceeded`; its `Retry-After`
is computed per response by the limiter rather than fixed.
`rate_limit_unavailable` is the fail-closed outcome when the decision cannot be
made, always with `Retry-After: 2`. The route's `Retry-After` handling now lets an
envelope's OWN value win, so both idempotency's fixed `2` and the limiter's
computed delay are emitted verbatim while every other `429` keeps the
long-standing fixed `Retry-After: 5`. Section 19.1 owns the normative contract.

**Implementation status (Phase 4D, implemented — optional, off by default).** The
`capacity_unavailable` row above is reachable only when
`SHARED_CAPACITY_ENABLED=true`. It is the fail-closed outcome when the shared
active-capacity decision cannot be made — an unusable Redis, corrupt or ambiguous
registry state, or an enabled-but-unwired instance — always with
`Retry-After: 2`. It is deliberately DISTINCT from `gateway_capacity_exceeded`,
which is unchanged, still carries the fixed `Retry-After: 5`, and is emitted in
both capacity modes for a full local queue, a queue-wait timeout, or closed
admission. Section 19.2 owns the normative contract.

---

## 21. Security Requirements

### 21.1 Credential separation

Upstream authentication is dual-mode, selected by `COLLECTIVIQ_AUTH_MODE`
(`bearer` | `password`, default `bearer`). Required secrets by mode:

```text
COLLECTIVIQ_GATEWAY_KEYS                       # always (client auth)
COLLECTIVIQ_API_KEY                            # bearer mode
COLLECTIVIQ_USERNAME + COLLECTIVIQ_PASSWORD    # password mode
```

In `bearer` mode the static `COLLECTIVIQ_API_KEY` is the upstream bearer token.
In `password` mode `COLLECTIVIQ_USERNAME`/`COLLECTIVIQ_PASSWORD` are exchanged at
`POST /login` for a short-lived bearer token held in memory only. The login
exchange is **verified-live**: each of the two 2026-08-11 authorized password
baselines performed exactly one `POST /login` → HTTP `200` whose body normalized
to a `Bearer access_token`; response fields beyond `access_token`/`token_type`
were masked, and token lifetime/refresh remain unverified. The inactive mode's
credentials may be present but are ignored. Byte bounds: username trimmed ≤ 320 bytes; password preserved exactly
≤ 4096 bytes; bearer/`access_token` preserved exactly ≤ 16 KiB.

OpenCode receives only a gateway key.

The CollectivIQ upstream credentials (`COLLECTIVIQ_API_KEY`,
`COLLECTIVIQ_USERNAME`, `COLLECTIVIQ_PASSWORD`, and any minted `access_token`)
must:

* be loaded from a secret manager or environment variable;
* never appear in configuration committed to source control;
* never be sent to OpenCode;
* never be logged;
* never appear in exception messages.

Residual risk: the username/password remain resident in process/config memory so
a later login can run, and a JavaScript string's bytes cannot be deterministically
erased.

### 21.2 Network binding

Default:

```text
HOST=127.0.0.1
PORT=8787
```

Binding to `0.0.0.0` must require an explicit configuration change.

Remote deployment requires:

* TLS termination;
* authentication;
* firewall restrictions;
* rate limiting;
* log access controls.

### 21.3 Prompt confidentiality

Default logs must not contain:

* user message content;
* tool results;
* source code;
* file paths;
* serialized prompts;
* CollectivIQ answers;
* tool arguments.

Development content logging must require:

```text
LOG_CONTENT=true
ENVIRONMENT=development
```

It must print a prominent startup warning.

### 21.4 Prompt injection

The upstream single-prompt interface collapses message-role boundaries.

The gateway cannot guarantee that:

* repository content will not override the control protocol;
* an untrusted file cannot influence tool selection;
* combined synthesis will preserve the tool envelope.

Mitigations:

* strict JSON conversation serialization;
* randomized or high-entropy boundary markers;
* tool-schema validation;
* tool-name allowlisting;
* OpenCode permission controls;
* limits on high-impact tools;
* adversarial prompt-injection testing;
* no tool execution inside the gateway.

### 21.5 Tool argument validation

Every tool argument object must be validated against the exact schema supplied by OpenCode.

The gateway must reject:

* unknown tool names;
* malformed JSON;
* missing required fields;
* incompatible field types;
* oversized argument objects;
* more calls than configured;
* duplicate call IDs from untrusted upstream output.

Validation does not make tool execution safe. OpenCode permissions remain mandatory.

### 21.6 Denial-of-service controls

The gateway must enforce:

```text
MAX_REQUEST_BODY_BYTES
MAX_PROMPT_BYTES
MAX_TOOL_COUNT
MAX_TOOL_SCHEMA_BYTES
MAX_TOOL_ARGUMENT_BYTES
MAX_UPSTREAM_RESPONSE_BYTES
MAX_CONCURRENT_REQUESTS
MAX_REQUEST_DURATION
```

Suggested initial defaults:

```text
MAX_REQUEST_BODY_BYTES=8 MiB
MAX_PROMPT_BYTES=6 MiB
MAX_TOOL_COUNT=128
MAX_TOOL_SCHEMA_BYTES=2 MiB
MAX_TOOL_ARGUMENT_BYTES=1 MiB
MAX_UPSTREAM_RESPONSE_BYTES=8 MiB
```

These values must be reduced after observing real OpenCode traffic.

---

## 22. Data Retention

### 22.1 Default mode

The gateway stores no prompt or response content after the request completes.

Permitted temporary data:

* in-memory serialized prompt;
* upstream thread ID;
* parsed answer;
* generated OpenAI response;
* operational metadata.

Temporary data must become eligible for garbage collection immediately after response completion.

**OpenCode session-title correlation (section 9.5).** When a valid
`X-CollectivIQ-OpenCode-Session-ID` accompanies a successful completion, the
process-local correlation service retains **only** the two opaque ids (the gateway
key identity and the session id) and the upstream thread id, for a bounded TTL
(60 s) with per-key and global caps. It **never** retains a title, prompt, or
answer. The CollectivIQ-generated native title is read transiently (section 10.4)
to serve the extension endpoint and is never logged, cached, or retained. This
state is in-memory and process-local, so a restart safely discards it.

### 22.2 Optional Redis mode

Redis may store:

* idempotency state;
* request status;
* final response for a short period;
* concurrency counters.

Prompt content should not be stored unless explicitly required.

If final responses are cached, encryption at rest and short TTLs are required.

**Implementation status (Phase 4A, implemented — optional).** The only Redis
state the gateway writes is the idempotency record described in section 18.1. It
holds a record version, the state, a keyed body fingerprint, a random owner
token, an informational expiry, and — for `final` only — the AES-256-GCM
ciphertext of the cached completion. No prompt, request body, authorization
value, raw gateway key, raw idempotency key, thread title, Redis URL, or upstream
thread id is ever stored, and the Redis key itself is an HMAC rather than any
client-supplied value. Encryption is application layer, so Redis at-rest
encryption is not relied upon; every record is bounded by `IDEMPOTENCY_TTL_MS`
(active records by a shorter lease). This phase stored no concurrency state at
all; section 19.2's optional lease registry is the only such state the gateway
ever writes, and it is disabled by default. Redis cache persistence and backups
are not required for this ephemeral state — losing it costs at most in-flight
replay protection — and the supplied Compose profile disables RDB and AOF for
that reason.

**Implementation status (Phase 4B, implemented — optional).** When cross-replica
rate limiting is enabled (section 19.1), Redis additionally holds ONE bounded
decimal integer timestamp per gateway-key scope under a separate `:rate:` key
category. That value is a theoretical arrival time in microseconds and nothing
else: no content, no credential, no identity, no counter history, and no
client-supplied value — the key itself is an HMAC. Each quota key expires on its
own replenishment deadline, so the state is self-clearing. This does not change
the no-content-retention posture, does not require persistence or backups, and
stores no concurrency state — section 19.2 owns the only such state, and this
phase neither added nor required it.

**Implementation status (Phase 5A, implemented — optional).** When OpenCode
thread reuse is enabled (section 5.1.1), Redis additionally holds ONE bounded
(≤4096 byte) record per session mapping under a separate `:reuse:` key category.
It carries only a record version, a state, a random owner token, an integer lease
deadline, and — when a thread is bound — the AES-256-GCM sealed upstream thread
id. This is the FIRST upstream identifier the gateway persists, and it is
persisted encrypted: the seal uses a fresh nonce per write and its associated data
binds the record version, the storage key, and an independent mapping-identity
digest, so a relocated ciphertext fails authentication instead of decrypting. No
session id, gateway key, upstream credential, prompt, answer, tool schema,
argument, result, model-generated content, model id, or origin is stored, and the
key itself is an HMAC. Records are bounded by the sliding
`OPENCODE_THREAD_REUSE_TTL_MS` (7 days by default) or, for an `ambiguous`
tombstone, by a 15 minute TTL. The no-content-retention posture is unchanged, and
this phase stored no concurrency state.

**Implementation status (Phase 4D, implemented — optional).** When cross-replica
capacity is enabled (section 19.2), Redis additionally holds ONE namespace-level
sorted set under a separate `:capacity:` key category — the only concurrency
state the gateway ever persists. Each member carries a version, a random 128-bit
owner token, and an opaque per-gateway-key capacity scope; its score is an
integer lease deadline stamped from Redis's own clock. No request, thread,
session, model, tool, prompt, answer, credential, raw gateway key, or
process-local `k<index>` identity is stored, and the key itself is an HMAC.
Members are removed on release and are pruned once their lease deadline passes;
the registry key expires at the latest active lease and is deleted when empty, so
the state is self-clearing and bounded by one lease window. Because losing it
merely forgets live permits (section 19.2's residual limits), persistence and
backups remain unnecessary — but `maxmemory-policy noeviction` stays mandatory,
since an evicted registry forgets every permit at once. The
no-content-retention posture is unchanged.

### 22.3 CollectivIQ-side retention

The gateway cannot control CollectivIQ’s thread retention based on the supplied endpoints.

Before production use, CollectivIQ retention, deletion, training-use, and enterprise privacy behavior must be confirmed contractually or through official documentation.

---

## 23. Observability

## 23.1 Structured logs

Every log event should include:

```json
{
  "timestamp": "2026-08-05T12:44:00.000Z",
  "level": "info",
  "request_id": "req_01J...",
  "model": "collectiviq-consensus",
  "state": "POLLING",
  "elapsed_ms": 14000,
  "poll_count": 7
}
```

Permitted fields:

* request ID;
* hashed API-key identity;
* virtual model;
* selected source names;
* CollectivIQ thread ID in debug mode;
* state;
* status code;
* latency;
* poll count;
* response byte counts;
* tool names;
* number of tool calls;
* parser selection path;
* error category.

Forbidden by default:

* prompts;
* answers;
* tool arguments;
* tool results;
* authorization headers.

## 23.2 Metrics

Required metrics:

```text
collectiviq_gateway_requests_total
collectiviq_gateway_request_duration_seconds
collectiviq_gateway_active_requests
collectiviq_gateway_queued_requests
collectiviq_gateway_upstream_requests_total
collectiviq_gateway_upstream_request_duration_seconds
collectiviq_gateway_poll_count
collectiviq_gateway_poll_duration_seconds
collectiviq_gateway_timeouts_total
collectiviq_gateway_errors_total
collectiviq_gateway_tool_responses_total
collectiviq_gateway_tool_parse_failures_total
collectiviq_gateway_tool_schema_failures_total
collectiviq_gateway_stream_connections
collectiviq_gateway_client_cancellations_total
```

Labels must have bounded cardinality.

Acceptable labels:

* endpoint;
* HTTP status family;
* virtual model;
* error category;
* tool mode;
* parser source.

Do not use:

* thread ID;
* request ID;
* user ID;
* tool-call ID;
* arbitrary tool arguments.

**Implementation status (Phase 4C, implemented — OPTIONAL, off by default).**
The complete metric set above is implemented in `src/observability/metrics.ts`
over a PRIVATE `@prometheus-io/client` registry (the maintained successor to the
deprecated `prom-client`). `METRICS_ENABLED=false` (the default) means the port
is the no-op: no registry, no series, no route, no per-request telemetry
allocation, and `GET /metrics` returns the framework `404`.

**Disabled means structurally inert, not cheaply no-op.** Both ports expose an
`enabled` flag fixed at construction, and EVERY call site branches on it. A
disabled gateway therefore builds no span options or attribute objects,
constructs no observation samples or per-request closures, reads no telemetry
clock, does not bind the capacity source, does not decorate the upstream adapter,
does not install the root request hook, and never passes a request span into the
completion pipeline — it calls into neither port at all.

That holds at SHUTDOWN as well: the telemetry runtime's `close()` skips
`tracing.shutdown()` outright when the port is disabled, rather than delegating
to a no-op. A disabled port owns no provider, exporter, processor, or timer, so
there is nothing to flush; calling it anyway would be the one place the
"disabled means uncalled" invariant quietly stopped holding.

State the residual cost honestly: what remains is one FIXED BOOLEAN CHECK at each
call site (and one nullish check on the per-request handle). The claim is "no
telemetry objects, samples, closures, clock reads, or port calls", NOT "zero
instructions".

Three mechanisms make that structural rather than conventional, and none may be
replaced by a no-op object:

* the root request hook is not installed at all when both ports are off, so
  `request.telemetry` stays `null` and there is no per-request handle to call;
* `RequestTelemetry` is nullable everywhere — there is deliberately no shared
  no-op handle, because one would let authentication, model-miss, and
  error-envelope paths keep invoking methods on a path that must be inert;
* span helpers and the stream failure helper are `null` rather than no-op
  functions, and every call site uses optional invocation, which short-circuits
  WITHOUT evaluating its arguments — so the attribute objects are never built.

`test/integration/observability.test.ts` proves this by wiring ports that RECORD
every call and then throw, asserting the recorded list is empty. Recording is
essential: `streamClosed` runs in a `finally` after the response has already
ended, where a throw would change neither status nor body.

**The closed label vocabulary** lives in `src/observability/labels.ts` and is the
single mechanism bounding cardinality. Every emitted value is either a member of
a frozen list or a CONFIGURED virtual-model id, and both are re-checked at write
time; an unrecognized value collapses to a fixed fallback rather than creating a
series.

| Dimension | Closed values |
| --- | --- |
| `endpoint` | `/healthz`, `/readyz`, `/metrics`, `/v1/models`, `/v1/models/:model`, `/v1/chat/completions`, `/v1/opencode/session-title`, `other` — always the route TEMPLATE, never `request.url` |
| `status_family` | `2xx`, `4xx`, `5xx`, `other` |
| `model` | a configured virtual-model id, or `none` when no configured model applies |
| `transport` | `json`, `sse` |
| `error_category` | the public OpenAI error `code` of the envelope the gateway itself returned (24 values), or `other` |
| `operation` | `create_thread`, `process_message`, `get_messages`, `get_threads` |
| `outcome` (upstream) | `success`, `error`, `cancelled` |
| `outcome` (poll phase) | `answer`, `timeout`, `error`, `cancelled` |
| `tool_mode` | `disabled`, `emulated`, `native` |
| `parser_source` | `desired-source`, `individual-consensus`, `individual-single` |

Using the public error CODE as the error category is deliberate: it keeps
capacity, cross-replica rate-limit, idempotency, and thread-reuse failures
individually distinguishable without a second taxonomy that could drift from the
public contract. The category always comes from an envelope the gateway
constructed — never from inspecting a thrown value.

| Metric | Type | Labels |
| --- | --- | --- |
| `..._requests_total` | counter | `endpoint`, `status_family`, `model`, `transport` |
| `..._request_duration_seconds` | histogram | `endpoint`, `status_family`, `model`, `transport` |
| `..._active_requests` | gauge | — |
| `..._queued_requests` | gauge | — |
| `..._upstream_requests_total` | counter | `operation`, `outcome` |
| `..._upstream_request_duration_seconds` | histogram | `operation`, `outcome` |
| `..._poll_count` | counter | `model` |
| `..._poll_duration_seconds` | histogram | `model`, `outcome` |
| `..._timeouts_total` | counter | `model` |
| `..._errors_total` | counter | `endpoint`, `error_category` |
| `..._tool_responses_total` | counter | `model`, `tool_mode`, `parser_source` |
| `..._tool_parse_failures_total` | counter | `model` |
| `..._tool_schema_failures_total` | counter | `model` |
| `..._stream_connections` | gauge | — |
| `..._client_cancellations_total` | counter | `endpoint`, `transport` |

**Fixed buckets**, chosen so a completion at or beyond the ~90 s upstream
deadline lands in a real bucket rather than only in `+Inf`:

```text
request_duration_seconds   0.05 0.1 0.25 0.5 1 2.5 5 10 20 30 45 60 90 120 180
upstream_request_duration_seconds  0.01 0.05 0.1 0.25 0.5 1 2.5 5 10 20 30 60 90
poll_duration_seconds      0.5 1 2.5 5 10 20 30 45 60 90 120 180
```

**Exactly-one ownership.** Every metric has a single writer, which is what makes
"exactly once per request" structural rather than conventional:

| Signal | Owner |
| --- | --- |
| `requests_total`, `request_duration_seconds`, `errors_total`, `client_cancellations_total` | `src/api/request-telemetry.ts` (a root `onRequest` hook) |
| `active_requests`, `queued_requests` | pulled from the ACTIVE `CapacityController` snapshot at scrape time — the process-local controller, or the shared one of section 19.2 when enabled. Both are PER-INSTANCE views: aggregating replicas approximates cluster occupancy but cannot see an orphaned lease. |
| `upstream_requests_total`, `upstream_request_duration_seconds` | the adapter decorator `src/generation/adapter-telemetry.ts` |
| `poll_count`, `poll_duration_seconds`, `timeouts_total` | `src/generation/chat-completion.ts` |
| `tool_responses_total`, `tool_parse_failures_total` | `src/generation/chat-completion.ts` |
| `tool_schema_failures_total` | `src/api/chat-completions-route.ts` (a submitted toolset rejected at the request boundary) |
| `stream_connections` | `src/api/chat-stream-response.ts` |

Request settlement is driven from the raw Node response's `finish`/`close`
events behind a one-shot guard, NOT from Fastify's `onResponse`, because the
streamed path hijacks the reply and may be force-destroyed without ever being
"sent". A JSON reply, a fully delivered stream, a stream cut short by a
disconnect, and a force-closed socket therefore each settle exactly once. A
`close` with nothing ended is the client-cancellation condition, so a cancelled
request is counted at most once on either transport.

Consequences worth stating plainly:

* An idempotent REPLAY settles as a gateway request but increments no upstream
  counter, because it performs no upstream work.
* A post-header SSE failure keeps the committed `200` status line, so it counts
  as `status_family="2xx"` while still contributing its closed `error_category`.
* A client disconnect on the non-streamed path also keeps the default `200`
  status; `client_cancellations_total` is what makes it visible.
* `poll_count` counts the attempts of COMPLETED polling phases (a phase that
  threw carries no attempt count); `upstream_requests_total{operation="get_messages"}`
  counts every individual attempt, including those of a failed phase.
* A stream FORCE-CLOSED during shutdown because the client was backpressured and
  not draining is counted as a client cancellation. The transport cannot
  distinguish an undrainable client from a departed one, and the rest of the
  gateway already classifies that destroy as a disconnect (it aborts the same
  client-abort controller), so the metric deliberately agrees with the behaviour
  rather than inventing a separate judgement.
* `tool_schema_failures_total` currently always reports `model="none"`. The
  rejection happens at the request boundary and the resolved model is not carried
  on the error envelope. The label is retained for shape consistency with the
  other two tool metrics and so a later change can populate it without breaking
  existing dashboards.

**Privacy.** No prompt, answer, source code, file or repository path, URL, tool
name/argument/result, credential, gateway key or scope, idempotency key, session
id, thread id, request id, or exception text has any representation in this API,
and a value smuggled into a label field is discarded by the closed-set re-check.
The exposition does disclose traffic volumes, latencies, error categories, and
the configured virtual-model ids — which is precisely why `/metrics` needs the
network isolation required by sections 21.2 and 31.2.

## 23.3 Distributed tracing

Recommended spans:

```text
gateway.request
gateway.validate
gateway.serialize
collectiviq.create_thread
collectiviq.process_message
collectiviq.poll
gateway.parse
gateway.encode
gateway.stream
```

Trace propagation to CollectivIQ should occur only if custom correlation headers are officially supported.

**Implementation status (Phase 4C, implemented — OPTIONAL, off by default).**
All nine spans are implemented in `src/observability/tracing.ts` over the
OpenTelemetry Node trace SDK with an OTLP/HTTP exporter. `TRACING_ENABLED=false`
(the default) means the port is the no-op: no provider, no exporter, no
processor, no timer, no socket, and a shared frozen no-op span.

Normative properties:

* **Manual spans only.** No automatic instrumentation package is installed. Auto
  instrumentation would capture full URLs, headers, and query strings — gateway
  keys, idempotency keys, session ids — into attributes. The nine names above are
  the entire vocabulary; a name outside it produces no span.
* **No global registration.** `provider.register()` is never called, so no global
  context manager or propagator is installed. Parentage is EXPLICIT: a caller
  passes the parent span and everything else starts at `ROOT_CONTEXT`.
  `context.active()` is never consulted, so a span tree never depends on
  scheduling. `gateway.request` is the root; `gateway.validate`,
  `gateway.serialize`, `collectiviq.create_thread`,
  `collectiviq.process_message`, `collectiviq.poll`, `gateway.parse`,
  `gateway.encode`, and `gateway.stream` are its children, and the SSE
  `gateway.encode` is a child of `gateway.stream`.
* **Fixed service metadata.** Exactly `service.name = "collectiviq-gateway"` and
  `deployment.environment.name = ENVIRONMENT`. No resource detectors, no
  host/process/OS/container metadata, and no caller-supplied resource attributes.
* **No environment self-configuration at construction.** The SDK treats `OTEL_*`
  variables as a FALLBACK for anything the caller did not set, which would
  otherwise let an ambient `OTEL_EXPORTER_OTLP_HEADERS` attach a secret-bearing
  header to every export, let `OTEL_EXPORTER_OTLP_[TRACES_]CLIENT_KEY`/
  `_CERTIFICATE` read files from disk during construction, and let `OTEL_BSP_*`
  retune the batch processor. The gateway therefore builds the exporter, the span
  processor, and the provider with every `OTEL_*` variable temporarily removed
  from the environment and exactly restored afterwards. Construction is
  synchronous, so no other task observes the reduced environment, and this covers
  every environment read the installed SDK performs while building those objects
  rather than an enumeration of override options.

  The guarantee is scoped to CONSTRUCTION and must not be described more broadly.
  It cannot bind a future SDK version that reads the environment lazily at export
  time; the durable control against that is the deployment rule that the
  gateway's environment should not carry `OTEL_*` variables at all.
* **Closed attributes.** Only `collectiviq.endpoint`, `.status_family`,
  `.transport`, `.model`, `.prompt_mode`, `.tool_mode`, `.error_category`,
  `.upstream_operation`, `.upstream_outcome`, `.poll_outcome`, `.parser_source`,
  `.poll_count`, `.tool_call_count`, and `.thread_reused`. Each is re-validated
  against the same closed vocabularies as the metrics and DROPPED when
  unrecognized; counts are clamped to a bounded non-negative integer. Span limits
  additionally forbid events and links outright (`0`), so exception text and
  remote link context cannot be attached even by a later mistake.
* **No exception recording.** A failed span carries `SpanStatusCode.ERROR` with
  NO status message plus the closed `collectiviq.error_category`.
  `recordException` is never called.
* **Every failure exit marks its span failed.** This applies to every manual
  span, not only the root: an unexpected validation failure, a serializer failure
  or prompt-byte rejection, a failed `create_thread` or `process_message`, a poll
  that timed out / errored / was cancelled, a required-choice parse failure, a
  JSON or SSE encoding failure, and every SSE transport exit that did not deliver
  the terminal frame and `[DONE]`. The category always comes from trusted gateway
  state — the envelope the gateway itself will return, or its own `timedOut`
  flag — and never from inspecting a thrown value. Where the exact envelope is
  not yet decided at the point the span closes (an upstream call whose
  normalization happens later in the orchestrator's catch), the closed fallback
  `other` is recorded rather than a guess, and the root `gateway.request` span
  still carries the precise category.
* **Bounded sampling.** `ParentBasedSampler` over a `TraceIdRatioBasedSampler`
  with `TRACING_SAMPLE_RATIO`, clamped into `[0, 1]`.
* **Bounded shutdown.** `shutdown()` races the provider's own flush-and-shutdown
  against a fixed 2 s budget, is idempotent, resolves `void` either way, never
  rejects, and `unref`s its timer, so an unreachable collector can neither delay
  process exit nor surface dynamic exception text.
* **No upstream propagation.** No trace header is added to any CollectivIQ
  request; upstream correlation support remains unverified.
* **Telemetry never changes behaviour.** Every span method is total and swallows
  failures, admission order is untouched, and a disabled or unwired tracer
  degrades to no traces rather than failing a request — the deliberate difference
  from the rate limiter and thread-reuse coordinator, whose absence fails closed.

---

## 24. Configuration

Required environment variables (upstream credentials depend on the auth mode):

```text
COLLECTIVIQ_BASE_URL=https://api.prod.collectiviq.ai
COLLECTIVIQ_GATEWAY_KEYS=<comma-separated keys or secret reference>
COLLECTIVIQ_AUTH_MODE=bearer                 # bearer | password (default bearer)
COLLECTIVIQ_API_KEY=<token>                  # required in bearer mode
COLLECTIVIQ_USERNAME=<username>              # required in password mode
COLLECTIVIQ_PASSWORD=<password>              # required in password mode
```

Recommended configuration:

```text
HOST=127.0.0.1
PORT=8787
REQUEST_TIMEOUT_MS=100000
DEFAULT_UPSTREAM_TIMEOUT_MS=90000
POLL_INTERVAL_MS=2000
POLL_MAX_INTERVAL_MS=5000
MAX_CONCURRENT_REQUESTS=4
MAX_QUEUED_REQUESTS=20
MAX_REQUEST_BODY_BYTES=8388608
MAX_PROMPT_BYTES=6291456
LOG_LEVEL=info
LOG_CONTENT=false
METRICS_ENABLED=true
REDIS_URL=
MODEL_CONFIG_PATH=./config/models.yaml
```

`METRICS_ENABLED=true` above is a RECOMMENDATION for a hosted deployment that
has somewhere to scrape from and has isolated the endpoint, not the implemented
DEFAULT. The implemented default is `false` (section 23.2 and the Phase 4C table
below), and the same applies to `TRACING_ENABLED`. Where this section and the
implementation-status tables differ, the tables describe what the code does.

Configuration validation must occur before the HTTP server starts.

Invalid configuration must terminate the process with a non-zero exit code.

Secrets must be redacted from startup output.

**Implementation status (Phase 1B, implemented).** The process-local capacity,
queue, and shutdown-drain settings are validated environment integers with
conservative, non-overridable bounds (`CAPACITY_LIMITS` in
`src/config/schema.ts`):

| Variable | Default | Bounds |
| --- | ---: | :--- |
| `MAX_CONCURRENT_REQUESTS` | 4 | 1–1024 |
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | 2 | 1–1024, and ≤ `MAX_CONCURRENT_REQUESTS` |
| `MAX_QUEUED_REQUESTS` | 20 | 0–100000 (0 disables queueing) |
| `MAX_QUEUE_WAIT_MS` | 5000 | 1–600000 |
| `SHUTDOWN_DRAIN_MS` | 30000 | 0–600000 |

A non-integer or out-of-range value, or a per-key limit greater than the global
limit, is a value-free `ConfigError` (the field name and a fixed reason; never a
submitted value). These four settings were **process-local** in this phase — they
did not span replicas. The two ACTIVE limits become cluster-wide only when
`SHARED_CAPACITY_ENABLED=true` (Phase 4D, section 19.2); the queue length and
queue wait stay per replica in both modes, and the BOUNDS above are identical
either way.
`REQUEST_TIMEOUT_MS`/`DEFAULT_UPSTREAM_TIMEOUT_MS`/`POLL_INTERVAL_MS`/
`POLL_MAX_INTERVAL_MS` remain per-model settings (`requestTimeoutMs`,
`pollIntervalMs`, `maxPollIntervalMs`) rather than global env vars in this phase.

**Implementation status (Phase 4A, implemented).** The optional Redis-backed
idempotency layer (section 18.1) adds four validated environment variables. A
blank/absent `REDIS_URL` disables Redis entirely; every other field still carries
a validated value so the configuration shape is stable either way.

| Variable | Default | Rule |
| --- | --- | :--- |
| `REDIS_URL` | *(empty — disabled)* | Only a canonical `redis://` / `rediss://` URL: supported lowercase scheme, non-empty host, no query or fragment, and an exact round-trip through URL serialization. Secret-bearing (it may embed credentials) and redacted everywhere. |
| `IDEMPOTENCY_ENCRYPTION_KEY` | *(none)* | **Required** whenever `REDIS_URL` is set. Exactly 32 bytes encoded as canonical unpadded base64url (43 characters); a non-canonical trailing-bit encoding is rejected. Secret; redacted everywhere. |
| `IDEMPOTENCY_TTL_MS` | 600000 | Integer, 60000–3600000. Lifetime of a committed `final` record. When Redis is enabled it must additionally be **≥ the largest configured model `requestTimeoutMs`**, so a client retrying after its own attempt timed out still finds the cached result instead of silently paying for a duplicate completion. |
| `REDIS_KEY_PREFIX` | `collectiviq-gateway` | 1–64 characters matching `[A-Za-z0-9_-]+`. |

All four produce value-free `ConfigError` issues (a stable field/reason pair; the
submitted URL, key, or prefix is never echoed). Every replica must be configured
with the SAME encryption key, namespace, Redis endpoint, and gateway-key set.

**Implementation status (Phase 4B, implemented).** The optional Redis-backed
cross-replica rate limiter (section 19.1) adds four more validated environment
variables. The feature is OFF by default; a PRESENT value is validated even while
it is disabled, so a deployment cannot carry a silently broken setting that only
fails the day it is switched on. The bounds live in `RATE_LIMIT_LIMITS` in
`src/config/schema.ts`.

| Variable | Default | Rule |
| --- | --- | :--- |
| `RATE_LIMIT_ENABLED` | `false` | Strictly `"true"` or `"false"` (the same parser as `LOG_CONTENT`). Enabling it **requires** a valid `REDIS_URL`, which in turn already requires `IDEMPOTENCY_ENCRYPTION_KEY`. No new secret is introduced. |
| `RATE_LIMIT_REQUESTS` | 60 | Integer, 1–100000. Sustained requests admitted per window, per gateway key. |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Integer, 1000–3600000. The window the sustained rate is expressed over. |
| `RATE_LIMIT_BURST` | 8 | Integer, 1–10000, and must **not exceed** `RATE_LIMIT_REQUESTS`. Requests admitted immediately from an idle key. |

All four produce value-free `ConfigError` issues. Every replica must be
configured with the SAME Redis endpoint, encryption key, `REDIS_KEY_PREFIX`,
gateway-key set, AND rate-limit settings, or the quota is not the single shared
quota it appears to be.

**Implementation status (Phase 5A, implemented).** Optional OpenCode thread reuse
(section 5.1.1) adds two more validated environment variables. The feature is OFF
by default; a PRESENT TTL is validated even while it is disabled, for the same
reason as the rate-limit settings. The bounds live in `THREAD_REUSE_LIMITS` in
`src/config/schema.ts`.

| Variable | Default | Rule |
| --- | --- | :--- |
| `OPENCODE_THREAD_REUSE_ENABLED` | `false` | Strictly `"true"` or `"false"`. Enabling it **requires** a valid `REDIS_URL`, which already requires `IDEMPOTENCY_ENCRYPTION_KEY`. No new secret is introduced. |
| `OPENCODE_THREAD_REUSE_TTL_MS` | 604800000 (7 days) | Integer, 300000–2592000000. The SLIDING idle lifetime of a session-to-thread mapping; every completion that uses the mapping resets it. Expiry forgets the mapping only — it never deletes the CollectivIQ thread. |

Both produce value-free `ConfigError` issues. Every replica must additionally
share the same upstream credentials, origin, and model configuration, or one
OpenCode session will not resolve to the same mapping everywhere.

**Implementation status (Phase 4D, implemented).** Optional cross-replica
capacity (section 19.2) adds exactly ONE validated environment variable and no
numeric setting of its own: enabling it REINTERPRETS the existing
`MAX_CONCURRENT_REQUESTS` and `MAX_CONCURRENT_REQUESTS_PER_KEY` as cluster-wide
active limits, under the same `CAPACITY_LIMITS` bounds. Every bound the boundary
enforces internally is fixed in `src/shared-capacity/limits.ts`.

| Variable | Default | Rule |
| --- | --- | :--- |
| `SHARED_CAPACITY_ENABLED` | `false` | Strictly `"true"` or `"false"`. Enabling it **requires** a valid `REDIS_URL`, which already requires `IDEMPOTENCY_ENCRYPTION_KEY`. No new secret, no new tuning variable, and no new dependency is introduced. A PRESENT value is validated even while the feature would be disabled. |

It produces value-free `ConfigError` issues. Every replica must share the same
Redis endpoint, encryption key, `REDIS_KEY_PREFIX`, gateway-key set, flag value,
AND capacity limits, or the budget is not the single shared budget it appears to
be. **Enabling it, disabling it, or changing either capacity limit requires a
coordinated drain and restart**; mixed local/shared rolling operation is
unsupported (section 19.2).

**Implementation status (Phase 4C, implemented).** Optional observability
(sections 23.2 and 23.3) adds four validated environment variables. BOTH
features are OFF by default and are validated independently of each other:
metrics add a route, tracing adds an exporter, and neither implies the other or
requires Redis, a credential, or any other feature. The bounds live in
`TRACING_LIMITS` in `src/config/schema.ts`.

| Variable | Default | Rule |
| --- | --- | :--- |
| `METRICS_ENABLED` | `false` | Strictly `"true"` or `"false"`. When true, `GET /metrics` is registered outside `/v1` with NO application authentication; when false the route does not exist and returns `404`. |
| `TRACING_ENABLED` | `false` | Strictly `"true"` or `"false"`. Enabling it **requires** `TRACING_OTLP_ENDPOINT`. |
| `TRACING_OTLP_ENDPOINT` | *(empty — no exporter)* | Only a canonical absolute `http://`/`https://` URL, bounded to `TRACING_LIMITS.endpointBytes` (2048 UTF-8 bytes, measured on the RAW value BEFORE trimming and before any parse, so padding cannot smuggle an oversized value past the limit): supported lowercase scheme, non-empty host, no query or fragment, and an exact round-trip through URL serialization. "No query or fragment" is judged on the SUBMITTED string, so a bare trailing `?` or `#` is rejected even though the parser reports both as empty while preserving the character in `href` — otherwise `…/v1/traces?` would round-trip byte-for-byte and be accepted. Percent-encoded path bytes (`%3F`, `%23`) are ordinary path data and stay accepted. It must additionally **embed no userinfo** (`user:pass@`, literal or percent-encoded) and carry a **non-root path** — WHICH path is unconstrained, since an operator may front a collector on any route. Supply the full traces path, e.g. `http://127.0.0.1:4318/v1/traces`. A PRESENT value is validated even while tracing is disabled. |
| `TRACING_SAMPLE_RATIO` | `1` | A plain decimal in `[0, 1]`. An exponent, hexadecimal, `NaN`, `Infinity`, or a thousands separator is REJECTED rather than reinterpreted, so a mistyped probability fails at startup instead of silently disabling or saturating tracing. |

All four produce value-free `ConfigError` issues drawn from a closed set
(`length is outside allowed bounds`, `must not embed credentials`, `must be a
canonical absolute http(s) URL`, `must include a non-root path`); the submitted
endpoint — which may carry a host, path, or credential an operator considers
sensitive — is never echoed. Redaction is defence in depth and needs BOTH
mechanisms: `TRACING_OTLP_ENDPOINT` is in `REDACT_PATHS`, which reaches only the
root and one nesting level, and the recursive sanitizer additionally matches the
exact normalized key names `otlpendpoint` and `tracingotlpendpoint`, covering an
occurrence at any depth. The match is exact rather than an `endpoint` substring,
which would also hide operational fields such as `endpointCount`.

Rejecting userinfo is what makes the "no exporter authentication" guarantee of
section 23.3 complete: without it an operator could smuggle a credential into a
setting that is not handled as a secret, and the gateway would send it on every
export.

Telemetry packages do not read their own `OTEL_*` environment variables **during
construction**: every SDK object is built with those variables temporarily
removed from the environment (section 23.3), so the validated endpoint, the
fixed resource, the bounded sampler, and the span limits are the only inputs an
`OTEL_*` variable could otherwise have displaced. This is a construction-time
guarantee only — it does not, and cannot, promise anything about a future SDK
version that reads the environment lazily at export time.

Gateway client keys (`COLLECTIVIQ_GATEWAY_KEYS`) are bounded by conservative,
non-overridable initial limits: at most **64** configured keys, and at most
**8192 UTF-8 bytes** per key (byte length, not JavaScript string length). The
existing comma-separated parsing — outer trimming, empty-entry removal, and
de-duplication — is preserved, and the same 8192-byte cap is applied to a
presented token before it is hashed for comparison (section 9.1). Configuration
failures remain value-free (they never echo a key).

### 24.1 Model-configuration safety limits (initial implementation)

The runnable foundation enforces the following conservative, non-overridable
limits on the model configuration file. They are initial implementation limits
chosen for safety; relaxing or making any of them configurable requires a
documented configuration-contract and security review.

| Limit | Value |
| --- | ---: |
| Model file size (bytes) | 1,048,576 |
| Virtual models | 1–64 |
| Selected sources per model | 1–32 |
| Model id length (characters) | 1–128 |
| Display-name length (characters) | 1–256 |
| Source / answer-source length (characters) | 1–128 |
| `requestTimeoutMs` | 1,000–600,000 |
| `pollIntervalMs` | 100–60,000 |
| `maxPollIntervalMs` | 100–60,000 |
| `maximumPromptBytes` | 1,024–67,108,864 |

Additional enforced rules: the path must be a regular file; the file size is
checked before and after reading; contents are decoded as strict UTF-8; YAML
aliases and duplicate keys are rejected; the model map must be non-empty; model
ids, display names, and source names must be non-empty and free of
leading/trailing whitespace (case-sensitive); and
`pollIntervalMs ≤ maxPollIntervalMs ≤ requestTimeoutMs`. Validation errors must
remain value-free (stable field/reason pairs; no ids, unknown field names,
submitted values, file contents, library messages, or filesystem paths). The
authoritative constants live in `src/config/schema.ts` (`MODEL_CONFIG_LIMITS`).

---

## 25. OpenCode Configuration

Recommended OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "collectiviq": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CollectivIQ Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "{env:COLLECTIVIQ_GATEWAY_KEY}",
        "timeout": 110000,
        "chunkTimeout": 30000
      },
      "models": {
        "collectiviq-claude": {
          "name": "CollectivIQ Claude"
        },
        "collectiviq-claude-direct": {
          "name": "CollectivIQ Claude Direct"
        },
        "collectiviq-consensus": {
          "name": "CollectivIQ Consensus"
        },
        "collectiviq-coder": {
          "name": "CollectivIQ Coder"
        },
        "collectiviq-fast": {
          "name": "CollectivIQ Fast"
        }
      }
    }
  },
  "model": "collectiviq/collectiviq-claude-direct",
  "small_model": "collectiviq/collectiviq-claude-direct",
  "share": "disabled"
}
```

OpenCode documents provider-level timeout and streamed-chunk timeout settings, as well as custom models and separate `small_model` selection.

Because emulated tool calling is opt-in beta and non-default (Phase 3), the
committed `opencode.jsonc` ships a text-only default primary agent — a
`collectiviq-text` agent with a wildcard permission `deny`, selected as the
`default_agent`. Tool calling requires explicitly selecting one of the two
tool-enabled agent entries, which are functional and behaviorally identical
(wildcard permission `"ask"`): the canonical `collectiviq-tools-beta` and the
deprecated `collectiviq-tools-experimental` compatibility alias retained through
Phase 4. Denying permissions
stops OpenCode from EXECUTING tools but does not stop it from SENDING tool
definitions to the model, so the agent depends on the disabled-mode
tool-metadata compatibility bridge (section 9.4.4, Phase 2.1) to discard that
metadata rather than on OpenCode withholding it. The foreground agent `model`, the
top-level `model`, and `small_model` are all `collectiviq/collectiviq-claude-direct`
— a Claude source (the only source currently observed to answer for the discovery
account; non-Claude routing is blocked account-side, see section 34.7) using
`promptMode: "direct"` (section 8.3/8.4), which submits only the latest user
message content without the gateway protocol wrapper the account objected to
(section 32, Phase 1). This profile is intentionally lossy (no system/developer
instructions or conversation history); a sanitized 2026-08-18 smoke **observed it
resolve that refusal for the tested account** (a natural coding request returned a
relevant, correct answer with no protocol objection), though that is a
single-account observation, not a repeatable guarantee. The protocol-mode
`collectiviq-claude` model stays declared alongside it.

**Hidden LLM title agent disabled; native-title propagation via a plugin (project-local
by default, optionally installed globally; process-wide idempotent).** OpenCode ships a built-in hidden `title` agent that would generate a
short session title with its **own separate completion request** — and therefore a
**separate** upstream CollectivIQ thread. In the committed `opencode.jsonc` that
hidden agent is **disabled** (`"title": { "disable": true }`), so it creates **no**
separate title thread or completion. As a result a first foreground message now
creates **exactly one** CollectivIQ thread; there is no longer an extra
title-generation thread, and the earlier "two or more upstream threads per session"
behavior no longer applies to the committed configuration.

In its place, a dependency-free plugin
(`.opencode/plugins/collectiviq-native-title.ts`) propagates the CollectivIQ
**native** thread title (section 10.1) asynchronously, reusing the foreground
thread rather than creating a new one. The plugin is committed and discovered
project-locally; operators may ALSO install it globally for cross-project use via a
supported manual symlink under `~/.config/opencode/plugins/`. When the gateway
repository is the active project, OpenCode discovers **both** paths and initializes
the plugin twice in the same process; to keep that harmless the default plugin
wrapper shares **one** hooks instance — and therefore **one** state map, so both
loads see the same retained entries and neither can independently arm, poll, or
rename a session the other is already handling — across duplicate
initialization, keyed on a stable `Symbol.for(...)` slot on `globalThis`
(first-initialization-wins; process exit is the lifetime boundary). The isolated
`createNativeTitleHooks` factory is unchanged and still used per-call by tests.

**Entry-module load contract (historical 2026-08-21 root cause).** OpenCode's loader
(1.18.21) resolves a plugin by FIRST reading a V1 default plugin module shaped as
`{ id: string, server: <plugin fn> }` (`readV1Plugin`); only when the default is
not that object does it fall through to a LEGACY path that scans the module's
runtime exports and rejects the first non-function with `Plugin export is not a
function`. This module intentionally exports named runtime helpers/constants for its
tests (several are not functions), so the earlier **bare-function default** fell
through to the legacy scan and OpenCode rejected the module — the plugin never
loaded for either the global-symlink or project-local path (2026-08-21), so no
arming/header/poll/rename behavior ran. The entry therefore now default-exports the
V1 object `{ id: "collectiviq-native-title", server: <the plugin fn> }`, so OpenCode
invokes only `default.server` and never enters the legacy scan (it does not migrate
to the V2 `setup` API). With this fix and the connection-resolution fix below, a
sanitized 2026-08-22 live smoke observed the complete propagation path succeed for
the tested local configuration (see the **Live status** note below).

**Two independent responsibilities.** The plugin's `chat.headers` hook does two
separate things behind one shared gate, and they must not be re-coupled: it
supplies the SESSION IDENTITY on **every** matching request, and it arms
**one** NATIVE-TITLE workflow while the session's bounded state entry is retained.

The shared gate is: the resolved `agent` is exactly `collectiviq-text`, the request
is routed to the `collectiviq` provider, and `sessionID` is a value the gateway
would accept — the same opaque 1–128 byte `[A-Za-z0-9_-]` token this specification
defines in section 9.5, validated plugin-side so a value the gateway would reject is
never sent (every allowed character is single-byte, so the character bound is the
byte bound). Provider matching is **descriptor-safe and tolerant of both provider
shapes**: OpenCode's SDK type declaration exposes the provider id at the nested
`provider.info.id`, but the OpenCode runtime may pass a flat `provider.id`; the
plugin reads a flat own `id` (authoritative when present) and otherwise the nested
`info.id`, using own data-property descriptors only and never invoking a getter.
This dual-shape support is implemented and hermetically tested as offline hardening,
but it was **not** the proven cause of the 2026-08-21 live failure (the plugin never
loaded, so provider matching never ran) and must not be described as that live root
cause. A request failing any part of the gate — an invalid session id, another
agent, another provider — receives no header and does not consume the session's
pending arming opportunity.

**1. Session identity (every matching request).** Once the gate passes, the plugin
attaches `X-CollectivIQ-OpenCode-Session-ID` **synchronously and unconditionally**,
before it consults any title state. Optional thread reuse (section 5.1.1) keys a
session's CollectivIQ thread on that header, so a follow-up turn that omitted it
would silently fall back to a new thread and lose the conversation; attaching it
therefore must not depend on session metadata, on title state, or on anything that
can decline or time out.

**Accepted tradeoff: broader title-correlation occupancy.** Sending the header more
widely is not free, and this holds whether or not reuse is enabled — do not describe
the reuse-disabled path as completely unchanged. The gateway registers a
process-local title correlation (section 9.5) after ANY successful completion that
carried a valid session header AND created an upstream thread; it has no notion of
which sessions the plugin intends to poll for. Since title-INELIGIBLE sessions
(child, manual, already-propagated) now send the header too, they can occupy
correlation entries that will never be looked up, until those entries expire at the
60 s TTL. Three properties bound that cost: registration is
first-registration-wins, so repeated turns of one session consume no additional
entry while its entry is live (after expiry a later created-thread turn may register
a fresh one); a REUSED turn registers nothing at all, because it created no thread;
and the registry is capped at 32 entries per gateway key and 128 globally, silently
skipping registration when full. The residual risk is therefore that a saturated
registry suppresses ANOTHER session's best-effort title propagation, leaving that
session on OpenCode's default title. It can never fail, delay, or alter a
completion, and it stores nothing new — an entry still holds only the opaque ids and
upstream thread id that section 9.5 already defines. This is an ACCEPTED residual
tradeoff of per-request identity, deliberately not worked around with a separate
title-intent header or a change to the completion route.

**2. Native-title propagation (one workflow per retained session entry).**
Everything that follows decides only whether THIS session's title workflow starts;
none of it withdraws the header. The plugin arms only a parentless top-level session whose title is still
OpenCode's default `New session - <ISO>` form, and after `session.idle` polls the
authenticated `GET /v1/opencode/session-title` extension (section 9.5) on a
bounded, capped schedule (immediately, then 2/4/8/8/8 s — six attempts). Only if
the session title is still the exact captured default does it rename the session to
the validated provider title (Unicode-code-point-safe, ≤ 100 code points). It
**never** overwrites a manual or already-propagated title, and it is best-effort:
any failure leaves OpenCode's default/manual title and never raises an alert.
Arming resolves the session's parent/title from OpenCode `session.created`/
`session.updated` lifecycle events held in bounded in-memory state (no async
lookup in the normal case); only for a session not yet observed does `chat.headers`
fall back to a small, bounded, fail-open `session.get`. Arming therefore adds at
most a bounded delay to the foreground request, never an indefinite one. Native-title
polling adds only bounded `GET` requests to the gateway; it creates no additional
upstream thread.

The repeating header does not multiply title work. Repeated and concurrent requests
do not rearm the RETAINED entry, so: a manual, renamed, already-propagated, or child
session carries the identity but arms nothing; a failed, ineligible, or timed-out
metadata lookup leaves the already-attached header in place and simply arms nothing
(a released reservation lets a later eligible turn retry); concurrent first turns of
one session each get the header but issue **one** lookup and **one** arm; and
duplicate project-local + global discovery, sharing one hooks instance and therefore
one state map, repeats the header without arming, polling, or renaming twice.

**Scope of that guarantee: the retained entry, not the session's lifetime.** The
plugin's title state is a bounded 256-entry **insertion-order** map (`MAX_SESSIONS`)
— **not** an LRU. Eviction removes the oldest INSERTED entry, and access does not
refresh insertion order: `chat.headers` returns early on `sessions.has(...)` so it
never re-inserts. A frequently used old session can therefore be evicted after 256
newer insertions, and it is wrong to describe the map as holding "the 256 most
recent sessions". After eviction (which also cancels that entry's in-flight title
work) a later matching request is no longer recognized as armed, so it may arm and
poll AGAIN. This is pre-existing, bounded, and deliberately not fixed in code. Write
"one workflow while the entry is retained", never "at most once per session" or
"one poller per session, ever".

**What actually prevents a duplicate or clobbered rename.** Not the arming gate. A
re-arm reads the plugin's cached metadata, which can be STALE: if the cache still
reports the OpenCode default title while the real title has already changed, the
plugin may arm and run one more bounded poll. Stated precisely:

* **Updated non-default metadata blocks rearming.** When the plugin observed the
  rename (a `session.updated` lifecycle event) or falls back to a live `session.get`
  because the metadata was evicted, `eligibleTitle` sees a non-default title and
  refuses to arm.
* **Stale cached default metadata may permit a later bounded workflow** — one arm
  and one capped poll schedule, nothing more.
* **The rename-side current-title recheck prevents the overwrite.** Immediately
  before `session.update`, the plugin re-reads the LIVE session and applies the
  provider title only if the title still equals the exact value captured at arm
  time. A manual or already-propagated title fails that comparison and the write is
  skipped. This recheck, not the default-title arming gate, is the guarantee that a
  manual or already-propagated title is never overwritten. Do not claim that a
  changed title makes a later workflow restart impossible; claim that it cannot
  cause an overwrite.

Three bounded stores are involved here and none governs another. The gateway's
correlation registry (above, and section 9.5) lives in the GATEWAY process with a
60 s TTL and 32-per-key / 128-global caps. The plugin's `sessions` title state lives
in the OPENCODE process as a 256-entry insertion-order map with no time-based
expiry. The plugin's `metaCache` is a SEPARATE 256-entry insertion-order map, also
in the OpenCode process, with no time-based expiry (updating an existing key
replaces its value but keeps its original position). The correlation TTL must never
be described as controlling either plugin map.

Neither responsibility touches CollectivIQ's **provider-side** title generation. That
remains entirely provider-owned and asynchronous (section 10.1): the plugin only
reads a title the provider already produced, through the section 9.5 extension.
Repeating the session header does not request, re-trigger, or re-generate a provider
title, and none of this has been observed or tested live — the plugin behaviour above
is established by hermetic tests only, and the live evidence in this section predates
the change.

**Connection resolution (base URL + gateway key).** Before polling, the plugin
performs ONE bounded connection resolution — base URL and gateway key together —
inside the single existing timeout/cancellation boundary (`client.config.get()` is
called at most once, and a hung or cancelled resolution settles promptly, issuing no
fetch). Both values come from the resolved CollectivIQ provider config
(`provider.collectiviq.options.baseURL` / `options.apiKey`): OpenCode substitutes
file/env references (e.g. `apiKey: "{env:COLLECTIVIQ_GATEWAY_KEY}"`) before merging,
so **a separate terminal `COLLECTIVIQ_GATEWAY_KEY` export is not required** when
OpenCode has already resolved a working provider credential. Precedence is
deterministic: merged SDK config over embedded `input.config`, and a valid
provider-config `apiKey` over the `COLLECTIVIQ_GATEWAY_KEY` fallback. That fallback
is read **lazily, through an injected reader invoked at most once and only when a
usable base URL exists but no usable provider-config key does** (never on the
provider-config path and never when the base URL is missing), so the real credential
environment lookup is confined to the production plugin wrapper alone. A key is
accepted only as a non-empty string ≤ 8192 UTF-8 bytes with no unresolved
`{env:…}`/`{file:…}` placeholder, used EXACTLY (never trimmed). Config extraction is
descriptor-safe (own data properties only; accessors, inherited members, and
throwing proxies are treated as absent, never invoked), and the resolved key stays
**local to the poll operation** — it is never placed in the singleton registry,
session/metadata state, errors, or logs. Polling proceeds only when both a valid base
URL and a valid key resolve; otherwise the poller fails open and does nothing. (An
earlier post-loader-fix trace showed the poller reaching this step but stopping
because the earlier environment-only lookup found no `COLLECTIVIQ_GATEWAY_KEY`;
reusing the provider-config credential fixed that.)

**Live status.** A sanitized, user-authorized 2026-08-22 live smoke observed the
complete native-title propagation path succeed for the tested local configuration
(OpenCode 1.18.21): exactly one new foreground CollectivIQ thread, no hidden title
thread, a provider-native title generated for that thread, and the OpenCode top-level
session title changed from its default to that provider-native title (the foreground
response completed and was relevant, with no alert or tool call). This is a
single-local-configuration observation — **not** production readiness, a
cross-account/cross-version guarantee, or a claim about which credential source was
exercised. The provider-config/environment precedence and lazy fallback are
hermetically verified; propagation stays best-effort/bounded/non-fatal (a failure
leaves the OpenCode default or manual title), and further live runs remain
approval-gated.

This OpenCode session title is **distinct** from the CollectivIQ upstream thread
title. The gateway performs at most one `create_thread` per completion request
using the fixed, content-free placeholder `THREAD_TITLE` (exactly `New Thread`,
section 10.1), and **no** OpenCode-generated title is ever forwarded into
`create_thread`. With optional thread reuse enabled (section 5.1.1) a turn that
CONTINUES a session's thread performs none at all, and it deliberately registers
no correlation here: the provider generates its title once, for the turn that
created the thread, so a later turn has nothing new to propagate. CollectivIQ may **asynchronously** replace `New Thread` with
its own prompt-related, server-generated thread title (observed 2026-08-18); that
provider title is prompt-derived provider metadata, produced and persisted
provider-side (and, after propagation, stored by OpenCode as the session title).
The gateway reads it only transiently to serve the section 9.5 extension and never
logs, caches, or retains it.

```jsonc
{
  "agent": {
    "collectiviq-text": {
      "description": "Text-only CollectivIQ agent (Claude direct source; no tools; Phase 2 SSE).",
      "mode": "primary",
      "model": "collectiviq/collectiviq-claude-direct",
      "permission": { "*": "deny" }
    },
    // Hidden LLM title agent disabled → no separate title thread/completion.
    // The collectiviq-native-title plugin (project-local by default; optionally
    // installed globally, process-wide idempotent) propagates the native
    // CollectivIQ title via GET /v1/opencode/session-title instead.
    "title": { "disable": true }
  },
  "default_agent": "collectiviq-text",
  "model": "collectiviq/collectiviq-claude-direct",
  "small_model": "collectiviq/collectiviq-claude-direct"
}
```

The `collectiviq-consensus`/`collectiviq-coder`/`collectiviq-fast` provider models
stay declared for accounts whose CollectivIQ routing supports non-Claude sources;
`collectiviq-fast` is **no longer** the title agent's model but remains in the
catalog for manual/other-account use. The sanitized 2026-08-18 smoke that
**observed** a hidden `collectiviq-fast` title request return a valid title on its
first attempt is **historical** evidence from before the hidden agent was disabled;
it is not current behavior and does not prove general GPT/non-Claude foreground
routing (section 34.7), which remains unverified. This keeps the streamed and
non-streamed foreground text paths within the disabled-mode, tool-free contract
(tool DEFINITIONS tolerated and discarded, tool CALLS never emitted). Emulated tool
calling (Phase 3) is implemented and is supported opt-in beta, but it stays
non-default, so it is not part of the committed foreground default.

No context-window values should be declared until CollectivIQ’s effective limits are measured or documented.

---

## 26. Project Structure

Recommended repository structure:

```text
collectiviq-gateway/
├── src/
│   ├── index.ts
│   ├── server.ts
│   ├── config/
│   │   ├── schema.ts
│   │   └── load.ts
│   ├── api/
│   │   ├── auth.ts
│   │   ├── errors.ts
│   │   ├── models-route.ts
│   │   ├── chat-route.ts
│   │   ├── metrics-route.ts
│   │   ├── request-telemetry.ts
│   │   └── health-route.ts
│   ├── openai/
│   │   ├── request-schema.ts
│   │   ├── normalize-messages.ts
│   │   ├── response-encoder.ts
│   │   └── stream-encoder.ts
│   ├── collectiviq/
│   │   ├── adapter.ts
│   │   ├── schemas.ts
│   │   ├── http-client.ts
│   │   └── errors.ts
│   ├── generation/
│   │   ├── service.ts
│   │   ├── state-machine.ts
│   │   ├── polling.ts
│   │   ├── adapter-telemetry.ts
│   │   └── model-resolver.ts
│   ├── prompts/
│   │   ├── serializer.ts
│   │   ├── text-template.ts
│   │   └── tool-template.ts
│   ├── tools/
│   │   ├── protocol-schema.ts
│   │   ├── parser.ts
│   │   ├── validator.ts
│   │   ├── canonicalize.ts
│   │   └── candidate-selector.ts
│   ├── redis/
│   │   ├── client.ts
│   │   ├── limits.ts
│   │   └── runtime.ts
│   ├── idempotency/
│   │   ├── header.ts
│   │   ├── fingerprint.ts
│   │   ├── keyring.ts
│   │   ├── crypto.ts
│   │   ├── records.ts
│   │   ├── payload.ts
│   │   ├── store.ts
│   │   ├── redis-store.ts
│   │   └── coordinator.ts
│   ├── rate-limit/
│   │   ├── gcra.ts
│   │   ├── keyring.ts
│   │   ├── redis-limiter.ts
│   │   └── runtime.ts
│   ├── shared-capacity/
│   │   ├── keyring.ts
│   │   ├── members.ts
│   │   ├── store.ts
│   │   ├── redis-store.ts
│   │   ├── coordinator.ts
│   │   └── runtime.ts
│   ├── thread-reuse/
│   │   ├── keyring.ts
│   │   ├── crypto.ts
│   │   ├── records.ts
│   │   ├── store.ts
│   │   ├── redis-store.ts
│   │   ├── coordinator.ts
│   │   └── runtime.ts
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── labels.ts
│   │   ├── metrics.ts
│   │   ├── tracing.ts
│   │   └── telemetry.ts
│   └── shared/
│       ├── ids.ts
│       ├── timeout.ts
│       └── redaction.ts
├── config/
│   └── models.example.yaml
├── test/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── compatibility/
│   ├── redis/
│   └── fixtures/
├── Dockerfile
├── compose.yaml
├── package.json
├── tsconfig.json
├── README.md
└── SECURITY.md
```

---

## 27. Core Generation Pseudocode

```ts
async function createChatCompletion(
  request: ChatCompletionRequest,
  context: RequestContext
): Promise<ChatCompletionResult> {
  authenticate(context);

  const normalized = normalizeAndValidateRequest(request);
  const model = modelResolver.resolve(normalized.model);

  const prompt = promptSerializer.serialize({
    messages: normalized.messages,
    tools: normalized.tools,
    toolChoice: normalized.toolChoice,
    toolMode: model.toolMode,
  });

  enforcePromptLimit(prompt, model.maximumPromptBytes);

  const permit = await concurrency.acquire(context.signal);

  try {
    const thread = await collectiviq.createThread({
      title: `OpenCode request ${context.shortRequestId}`,
      signal: context.signal,
    });

    await collectiviq.processMessage({
      threadId: thread.threadId,
      prompt,
      selectedLlms: model.selectedLlms,
      generateCombined: model.generateCombined,
      signal: context.signal,
    });

    const messages = await polling.waitForAnswer({
      threadId: thread.threadId,
      answerSource: model.answerSource,
      timeoutMs: model.requestTimeoutMs,
      signal: context.signal,
    });

    const parsed = responseParser.parse({
      messages,
      desiredSource: model.answerSource,
      tools: normalized.tools,
      toolChoice: normalized.toolChoice,
      toolMode: model.toolMode,
    });

    return openAIEncoder.encode({
      requestId: context.requestId,
      model: normalized.model,
      parsed,
    });
  } finally {
    permit.release();
  }
}
```

---

## 28. Health and Readiness

### 28.1 Liveness

```text
GET /healthz
```

Returns `200` when the process event loop and router are operational.

It must not call CollectivIQ.

### 28.2 Readiness

```text
GET /readyz
```

Checks:

* configuration loaded;
* model configuration valid;
* required secrets available;
* Redis available when configured;
* concurrency subsystem initialized.

CollectivIQ connectivity should be reported in the response but should not necessarily make the service unready, because an upstream outage may be temporary.

Example:

```json
{
  "status": "ready",
  "checks": {
    "configuration": "ok",
    "models": "ok",
    "redis": "disabled",
    "collectiviq": "unknown"
  }
}
```

**Implementation status (Phase 4A, implemented).** Readiness is a bounded,
dependency-aware view. Configuration and models are validated before the listener
binds (an invalid configuration exits non-zero), so the remaining runtime
dependency is optional Redis:

* Redis **disabled** (blank/absent `REDIS_URL`): unchanged behaviour — readiness
  follows the listener flag alone.
* Redis **configured but disconnected or reconnecting**: not ready.
* Redis **ready**: readiness may become healthy.
* **Shutdown**: always forces not-ready, latched, so no later dependency recovery
  can flip it back.

A dependency probe must be synchronous, bounded, and non-throwing and may return
only already-known safe state; a probe that throws counts as not ready. Neither
`/healthz` nor `/readyz` calls CollectivIQ, and neither returns configuration
values or credentials. When Redis is configured but unavailable at startup the
process still starts the HTTP listener, `/healthz` stays `200`, `/readyz` stays
`503`, the client reconnects automatically with a bounded capped backoff, and
readiness becomes healthy once the connection is established. The response bodies
remain the existing fixed `{"status":"ready"}` / `{"status":"not_ready"}`; the
`checks` object above is still illustrative, not implemented.

**Implementation status (Phase 4B, implemented).** The semantics above are
unchanged. Because the Redis composition root creates exactly ONE client for the
process (section 19.1), readiness stays ONE probe over ONE shared connection
covering every enabled Redis-backed feature — idempotency, rate limiting, or
both. "Redis is ready" therefore means the same thing regardless of which
features are enabled, and enabling rate limiting adds no second probe, no second
connection, and no additional readiness state.

**Implementation status (Phase 5A, implemented).** Unchanged again. Optional
OpenCode thread reuse (section 5.1.1) composes over that same single client, so
it adds no probe, no connection, and no readiness state; a disconnected Redis
degrades reuse exactly as it degrades the other two. Shutdown ordering is also
unchanged: the application drains first, so an in-flight completion can still
finalize or settle its mapping, and the one connection closes last, exactly once.

**Implementation status (Phase 4D, implemented).** Unchanged once more. Optional
cross-replica capacity (section 19.2) composes over the SAME single client, so it
adds no probe, no connection, and no readiness state, and "concurrency subsystem
initialized" above is satisfied by whichever controller configuration selected. A
disconnected Redis does NOT make the instance unready for capacity reasons beyond
the existing Redis probe; it simply makes every shared acquisition fail closed
with `503 capacity_unavailable` while `/readyz` already reports `503` for the
connection itself. Shutdown ordering is likewise unchanged: `closeAdmission()`
runs first on the ACTIVE controller, the application drains, and the one
connection closes last, exactly once — so a permit released during the drain is
still returned to the registry.

---

## 29. Testing Strategy

## 29.1 Unit tests

Required areas:

* request validation;
* message normalization;
* transcript serialization;
* prompt-size enforcement;
* virtual-model resolution;
* error mapping;
* tool JSON parsing;
* JSON Schema validation;
* canonicalization;
* candidate voting;
* SSE chunk encoding;
* redaction;
* timeout behavior.

**Implementation status (Phase 2).** SSE coverage is hermetic and split across
unit tests (`test/unit/chat-stream.test.ts` — the frame encoders and the
deterministic code-point split; `test/unit/chat-stream-response.test.ts` — the
backpressure-aware writer, keep-alives, error records, and cancellation),
integration tests (`test/integration/chat-completions-stream.test.ts` — injected
frame sequences and SSE error records; `test/integration/chat-stream-loopback.test.ts`
— real-socket delivery, one-thread/one-submit, and streaming-disconnect capacity
release), and the separate `npm run test:compatibility` suite
(`test/compatibility/`) driving the pinned SDK. See
`.agent/instructions/validation.md`.

### 29.2 Upstream contract tests

Use a mock CollectivIQ server to test:

* successful thread creation;
* missing `thread_id`;
* numeric and string thread IDs;
* process-message status response;
* process-message `detail` error;
* empty message list;
* partial model responses;
* combined response arriving later;
* duplicated source messages;
* malformed JSON;
* oversized response;
* authentication failure;
* quota failure;
* slow polling;
* network reset.

All observed live CollectivIQ responses should be converted into sanitized fixtures.

### 29.3 OpenAI compatibility tests

Test with:

* direct `curl`;
* the OpenAI SDK configured with a custom base URL;
* `@ai-sdk/openai-compatible`;
* OpenCode.

Scenarios:

1. non-streamed text completion;
2. streamed text completion;
3. assistant tool call;
4. tool-result continuation;
5. three-round tool loop;
6. multiple tool calls;
7. named `tool_choice`;
8. `tool_choice: none`;
9. timeout;
10. upstream malformed output;
11. client cancellation;
12. model-not-found response.

### 29.4 Adversarial tests

The suite must include conversation content that attempts to:

* escape protocol boundaries;
* redefine the tool protocol;
* invent tools;
* call tools with invalid arguments;
* return Markdown instead of JSON;
* include JSON before and after prose;
* insert nested fake conversation markers;
* request shell commands through a read-only tool;
* produce huge argument objects;
* claim a tool has already run;
* return a tool result as an assistant message.

### 29.5 Load tests

Initial target:

```text
4 concurrent active completions
20 queued requests
100 sequential completions
No memory growth above an agreed steady-state threshold
```

The load test must model 90-second upstream latency.

### 29.6 Redis idempotency tests (Phase 4A, implemented)

Idempotency is covered at three layers. The first two are hermetic and run
inside `npm run validate`; the third requires a real Redis and is a SEPARATE
gate.

**Unit** (`test/unit/idempotency-header.test.ts`, `-fingerprint`, `-crypto`,
`-records`, `-coordinator`, `-redis-store`, plus `test/unit/readiness.test.ts`
and additions to
`config.test.ts` / `gateway-auth.test.ts`): header bounds, duplicate detection
and non-reflection; lossless string/key encoding, so distinct unpaired
surrogates — and a literal `U+FFFD` — never share a fingerprint; the renewal
race, in which the store has already applied `reserved → processing` while its
caller is still awaiting the reply and an overlapping renewal must still apply
the processing lease; the record-read command shape, proving the gateway issues
no direct unbounded `GET`; canonical equivalence for reordered keys and whitespace;
a different fingerprint for any changed submitted field including ignored tool
metadata; descriptor, accessor, `toJSON`, Proxy, cycle, sparse, exotic, depth,
and size failures; per-gateway-key scoping that is stable independent of
configured key ORDER; HKDF domain separation; AES-GCM round trip, fresh random
nonce, associated-data binding, tampering, wrong key, and size bounds; strict
parsing of every record state and version and of the cached payload; every state
transition with owner-token mismatch, TTL, renewal, corruption, and store
failures; and the absence of any secret or content in errors and stored bytes.

**Integration with an injected store**
(`test/integration/chat-completions-idempotency.test.ts`), covering both JSON and
SSE: no header preserves current behaviour with zero Redis interaction; a header
with disabled or unavailable Redis returns `503` and performs no completion work;
concurrent same-key/same-body requests execute the completion service exactly
once; the same key with a different body returns `409`; waiters and replays use
the ORIGINAL completion metadata; separate gateway keys do not collide; a
pre-`processing` failure releases the claim; a post-`processing` failure becomes
`ambiguous` and blocks a retry; cancellation, deadline, disconnect, and shutdown
never duplicate work; a final-persistence failure never emits the answer on
either transport; and only original owners register native-title correlation.

**Real Redis** (`npm run test:redis`, `test/redis/`, `vitest.redis.config.ts`):
runs against `REDIS_TEST_URL` with synthetic credentials and content only, a
randomized key prefix per run, and full key cleanup. It covers Lua claim/CAS
behaviour under concurrency; two independent application/coordinator instances
sharing one Redis executing the completion once; lease renewal and expiry;
`EVALSHA`→`EVAL` recovery after `SCRIPT FLUSH`; connect/close readiness
transitions and an unreachable endpoint that never throws; corrupt, tampered, and
relocated records failing closed; renewal selecting its lease from the stored
state rather than the caller's; an oversized value rejected with the server's own
command counters showing that no `GET` executed at all (paired with a
within-bound read that does register one, so the counter assertion cannot pass
vacuously); and a scan proving raw Redis values contain
none of the synthetic prompt, answer, tool-argument, gateway-key, or
idempotency-key sentinels. It is excluded from ordinary Vitest discovery and from
`npm run validate` (which stays hermetic and Redis-free) and runs in CI as an
additional required gate with the pinned `redis:8.8.2-alpine` service.

### 29.7 Redis rate-limiting tests (Phase 4B, implemented)

Cross-replica rate limiting (section 19.1) is covered at the same three layers.
The first two are hermetic and run inside `npm run validate`; the third requires a
real Redis and joins the SEPARATE `npm run test:redis` gate, which now covers two
suites.

**Unit** (`test/unit/rate-limit-gcra.test.ts`, `-keyring`, `-redis-limiter`,
`test/unit/redis-client.test.ts`, plus additions to `config.test.ts` and
`gateway-auth.test.ts`): the derived GCRA parameters and the bounded, clamped
`Retry-After` conversion, including a non-finite or non-positive delay; scope and
storage-key derivation that is deterministic, independent of configured key
ORDER, distinct from the idempotency scope for the same gateway key, and
length-framed so no two component tuples collide; the limiter's mapping of every
script reply and of a `null` substrate reply onto the closed decision union,
abort awareness, and the absence of any direct client `GET`; the shared client's
mandatory content-free `error` listener, disabled offline queue, bounded
command/connect deadlines, capped reconnect, `EVALSHA` → `EVAL` `NOSCRIPT`
fallback, total non-throwing `evalScript`, and bounded close with force-destroy;
the four new configuration variables including strict boolean parsing, each
range, the `RATE_LIMIT_BURST ≤ RATE_LIMIT_REQUESTS` cross-field rule, validation
of present values while the feature is disabled, and the `REDIS_URL` requirement
when it is enabled; and the third opaque authentication identity, which is `null`
when rate limiting is off and never equal to the idempotency scope when it is on.

**Integration with an injected fake limiter**
(`test/integration/chat-completions-rate-limit.test.ts` over
`test/support/fake-rate-limiter.ts`), covering both JSON and SSE: a disabled
limiter performs zero limiter and zero Redis operations; a `limited` decision
returns `429 gateway_rate_limit_exceeded` with the limiter's own `Retry-After`
while capacity, upstream work, the idempotency claim, any SSE header, and
native-title correlation are all untouched; an `unavailable` decision returns
`503 rate_limit_unavailable` + `Retry-After: 2`; a cancellation sends no body on
client disconnect and keeps `503 service_unavailable` on shutdown; a streamed
request rejected at the gate receives a JSON error, never an SSE error record;
idempotency owners, waiters, cached replays, and different-body conflicts each
consume exactly one unit while invalid authentication, invalid requests,
preparation failures, and invalid/unfingerprintable idempotency inputs consume
none; quota is not refunded by a later capacity rejection; separate gateway keys
do not share a scope; and the other `/v1` routes are never metered.

**Real Redis** (`npm run test:redis`, `test/redis/rate-limit-store.test.ts`,
`vitest.redis.config.ts`): runs against `REDIS_TEST_URL` with synthetic values
only, a randomized key prefix per run, and full key cleanup. It covers the atomic
Lua decision under concurrency, burst then steady-state admission against Redis's
own clock, the replenishment TTL, `EVALSHA` → `EVAL` recovery after
`SCRIPT FLUSH`, two independent limiter instances sharing one Redis enforcing one
quota, and every corrupt-state class (empty-but-present, non-integer, negative,
oversized) failing closed without the value being reset or the request admitted.
This suite is approval-gated. It **was run under explicit approval** in the
implementing change: both `test/redis/` suites executed together against a
disposable pinned `redis:8.8.2-alpine` and passed (40 tests), the randomized
namespace was verified empty afterwards, and the container was removed. That is a
standing result rather than a rerun, and it authorizes no future Docker or Redis
command — each run needs fresh approval. `npm run validate` stays hermetic and
Redis-free.

### 29.8 OpenCode thread-reuse tests (Phase 5A, implemented)

Coverage for optional thread reuse (section 5.1.1). Every hermetic suite runs
inside `npm run validate`; the real-Redis suite does not.

**Unit** (`test/unit/thread-reuse-keyring.test.ts`, `-crypto`, `-records`,
`-coordinator`, `-redis-store`, plus additions to `config.test.ts`,
`polling.test.ts`, `chat-completion.test.ts`, `gateway-auth.test.ts`, and
`redis-runtime.test.ts`): the four HKDF subkeys, each distinct from every Phase
4A and Phase 4B subkey and from each other; deterministic, order-independent
scopes and deterministic policy/principal fingerprints, including which model
fields are and are not part of the policy; collision-free length framing for both
the storage key and the associated data; an AEAD round trip with a fresh nonce per
write, full binding to the record version, storage key, and identity digest, and
rejection of a wrong key, a tampered envelope, a rebound ciphertext, and every
size violation; strict record parsing including every state/field combination the
machine cannot produce, including the `committed` state's zero-lease and
required-payload invariants; every state transition, owner mismatch, renewal from
authoritative state, lease expiry recovery, ambiguity, and non-throwing store
failure; the ACKNOWLEDGEMENT-SAFE terminal transition — an applied-but-lost
commit reply acknowledged by the idempotent retry, two undecided commits leaving
a non-acquirable tombstone and never an active mapping, an applied-but-lost
activation still succeeding, an undecided activation succeeding and being retried
at settlement, and a `committed` record refusing acquisition by any owner; the
state-specific Redis lifetime, proven at the minimum mapping TTL against the
maximum model deadline; the wire shape of all nine scripts, their reply
vocabulary, the `EVALSHA` → `EVAL` fallback, and the `STRLEN`-before-`GET`
ordering; the two configuration variables, their bounds, validation while
disabled, and the `REDIS_URL` requirement when enabled; run-correlated selection
including a differing run id, a `null` run id, and ranking restricted to same-run
candidates; and an assertion that no synthetic session, gateway-key, upstream
credential, thread, run, model, or origin sentinel appears in any Redis key or
record.

**Integration with an injected fake store**
(`test/integration/chat-completions-thread-reuse.test.ts` over
`test/support/fake-thread-reuse-store.ts`), covering both JSON and SSE: disabled
reuse, an absent header, a protocol model, and a tool model each perform ZERO
reuse operations; the first eligible turn creates and binds while the second
reuses and creates nothing; 25 sequential turns keep one thread, proving there is
no hidden turn cap; a different session, gateway key, or model policy gets its own
mapping; an invalid session header and an `Idempotency-Key` combination both fail
before rate limiting, capacity, and upstream work; a rate-limited request never
acquires a lease while a busy or unavailable reuse attempt still spends its unit;
busy, unavailable, corrupt, and ambiguous outcomes map to their documented
statuses; a capacity-style pre-submit failure restores the mapping; a post-submit
failure leaves it ambiguous; a failed finalization emits no answer on either
transport; native-title correlation registers once, on creation only; and no
mapping, session, or thread value reaches a response header or body.

**Real Redis** (`npm run test:redis`, `test/redis/thread-reuse-store.test.ts`):
runs against `REDIS_TEST_URL` with synthetic values only, a randomized key prefix
per run, and full key cleanup. It covers two independent coordinators serializing
on one session, a same-session concurrent acquire admitting exactly one winner,
reserved-versus-processing lease expiry, renewal from authoritative state, the
sliding TTL reset, ambiguous expiry, `EVALSHA` → `EVAL` recovery after
`SCRIPT FLUSH`, corrupt and oversized state failing closed without repair, and
the absence of every synthetic sentinel from stored keys and values. `npm run
validate` stays hermetic and Redis-free, and every execution of this suite is
separately approval-gated: a past run authorizes no future Docker or Redis
command.

**Execution evidence (2026-09-02, two approved runs).** This suite **has now been
run** and passes. It took two approved runs, and the difference between them was
entirely in the TESTS.

The first approved run executed all three real-Redis suites — 59 tests — against a
disposable pinned `redis:8.8.2-alpine` on host loopback. **57 passed and 2 failed,
both in this Phase 5A suite**; the Phase 4A and 4B suites passed. Diagnosis
established that **both failures were test defects, and neither indicated a
production or Lua defect**:

1. *Waiting on the wrong connections.* `serializes two INDEPENDENT coordinators on
   one session` built two fresh stores but awaited readiness on the unrelated
   module-level store. Either new connection could still be connecting, and a
   not-ready store correctly reports `unavailable` (the fail-closed behaviour of
   section 5.1.1), which masked the serialization the case exists to prove. The
   test now retains both stores and awaits readiness on both before either
   coordinator acquires.
2. *An assertion contradicting the fixed ambiguous TTL.* The ambiguous-tombstone
   case asserted the stored TTL was BELOW `mappingTtlMs`. Ambiguous records take
   the FIXED ambiguous lifetime, so Redis's observed ~899,999 ms against that
   fixture's 600,000 ms mapping TTL was correct and the assertion was wrong. It is
   now the fixture-aware bracket `> mappingTtlMs` and `<= ambiguousTtlMs`, which
   still fails if the sliding mapping lifetime were ever applied. The ambiguous TTL
   is a constant and is NOT universally shorter than the mapping TTL — under the
   seven-day production default it is far shorter and the inequality would reverse.

**No production code, Lua script, coordinator, runtime, configuration,
dependency, or lockfile entry changed** in response to those failures; the only
edit was to `test/redis/thread-reuse-store.test.ts`. After that correction, a
second separately approved run executed the complete gate — **3 files, 59 tests,
all passing**, including both formerly failing cases. Cleanup confirmed `DBSIZE`
**0** and only the Redis service was removed (no `docker compose down`, no
`FLUSHALL`, no volume or unrelated-container removal). Every value was synthetic
under a per-run randomized key namespace, the upstream and gateway credential
environment variables were unset, and **no live CollectivIQ request was made and
no real credential was used**.

This establishes that the nine Lua scripts execute correctly on a real Redis
8.8.2. It does NOT by itself establish live CollectivIQ correctness, production
readiness, or a cross-version guarantee: the outstanding Phase 4 controls and the
unanswered upstream ordering, pagination, cleanup, and retention questions of
section 5.1.1 are unaffected. The separate sanitized two-turn live smoke of
2026-09-02 (section 5.1.1) covers the end-to-end path for one local/account
configuration; every further live run requires fresh approval.

### 29.9 Observability tests (Phase 4C, implemented)

Coverage for optional metrics and tracing (sections 23.2 and 23.3). Every suite
is hermetic and runs inside `npm run validate`; none needs a collector, Redis,
OpenCode, a credential, or a live CollectivIQ call.

**Configuration** (the observability block in `test/unit/config.test.ts`): both
switches default to false with a stable configuration shape; strict
`"true"`/`"false"` parsing for each; `TRACING_OTLP_ENDPOINT` required when
tracing is enabled; canonical absolute http(s) acceptance with a non-canonical
scheme, a bare origin, a query, a fragment, a missing host, and a non-http scheme
all rejected; a bare TRAILING `?` or `#` rejected too, guarded by an assertion
that the value really does survive both the emptiness and the round-trip checks
so the case cannot quietly stop testing anything, while percent-encoded `%3F` and
`%23` path bytes stay accepted; userinfo reported ahead of a trailing delimiter
when a value carries both; a PRESENT endpoint validated while tracing is disabled; the sample
ratio bounded to a plain decimal in `[0, 1]` with an exponent, hexadecimal,
`NaN`, `Infinity`, a leading dot, and a comma separator rejected rather than
clamped; neither switch requiring Redis or a credential; and every failure
value-free, including the submitted endpoint, path, and query token.

**Metrics registry** (`test/unit/metrics.test.ts`): the exact name and Prometheus
TYPE of all fifteen metrics; the exact declared buckets, including the 90-second
boundary; exact label names and values; `errors_total` incremented only when an
error category is present; an unconfigured, `null`, or empty model collapsing to
`none`; two independently created instances not sharing state; the client library's
GLOBAL default registry left free of every `collectiviq_gateway_` series; the
capacity gauges re-read from the bound source on each scrape and reporting `0`
while unbound; `stream_connections` never going negative; `NaN`/negative/infinite
durations recorded as `0` with no `NaN` in the exposition; a zero, negative,
fractional, or non-finite poll count incrementing nothing; hostile secret,
path, id, prompt, and tool-argument sentinels passed through the model field and
absent from the exposition; and the no-op implementation accepting every call.

**Tracing** (`test/unit/tracing.test.ts`, over an `InMemorySpanExporter` and a
synchronous processor): all nine span names; explicit parentage and shared trace
ids, with a parentless span a root; every closed attribute emitted under its
exact `collectiviq.*` key while unrecognized enum values are DROPPED and counts
are clamped or dropped; `setError` setting the ERROR status with an empty message
plus the closed category; an idempotent `end()`; `sampleRatio: 0` exporting no
root spans while `1` does; a bounded, idempotent, non-rejecting shutdown even
when the injected exporter rejects; ZERO outbound requests for the no-op port and
for enabled-port CONSTRUCTION; and sentinel values forced through every field by
cast, absent from every serialized span name, attribute set, and status.

**Composition and lifecycle** (`test/unit/telemetry-runtime.test.ts`): a fully
inert default; each port built from its own switch with neither implying the
other; a no-op fallback if an enabled tracer somehow had no endpoint; tracing
staying a no-op on `buildServer`'s default path even when enabled, because only
the process root can discharge an exporter's shutdown obligation; a frozen shared
disabled instance; zero outbound requests while constructing, exercising, and
closing both an enabled and a disabled runtime; and an idempotent,
non-rejecting close. Close-time inertness is proven the same way the request
path's is — through a tracing port that RECORDS every call rather than a no-op
that cannot tell: closing a disabled runtime, and closing a metrics-only one,
must leave that record empty, while an enabled port records exactly one
`shutdown` per close and still resolves when that shutdown rejects. Those cases
drive the exported composition seam `composeTelemetryRuntime`, which
`createTelemetryRuntime` itself routes through, so the lifecycle is exercised
over supplied ports without a production-only test hook. It additionally proves the `OTEL_*` isolation
BEHAVIOURALLY: with `OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY` pointing at a sentinel
path, an `fs.readFileSync` spy never sees it while the real exporter is
constructed (and the same spy is shown to catch a deliberate read, so the
assertion cannot pass vacuously); the environment is exactly restored
afterwards; `OTEL_SERVICE_NAME` cannot displace the fixed service identity; and
constructing the real exporter under hostile `OTEL_*` values still opens no
connection. `test/unit/shutdown.test.ts` additionally asserts that
shared dependencies close LAST — after `close()` and the forced cancel — and that
a rejecting dependency close is routed to the content-free sink without
rejecting or skipping the sequence.

**Generation instrumentation** (`test/unit/generation-telemetry.test.ts`, driving
the REAL completion runtime, the real poller, and the real capacity controller
over a fake adapter): upstream counters per operation, including one increment
per individual `get_messages` poll; the polling phase recorded exactly once with
the true attempt count; the specification §23.3 spans emitted as children of a
supplied `gateway.request` span with closed attributes only; the pull-based
capacity gauges reflecting held permits and returning to zero; a completion
timeout counted exactly once with a `timeout` phase outcome; a failed submit
labelled `error` with its span still ended and no poll phase recorded; the
FAILED-SPAN contract on four representative exits — a failed `process_message`,
a poll timeout, an oversized prompt, and a required-choice parse failure — each
asserting `SpanStatusCode.ERROR`, an ABSENT status message, the expected closed
category, and — for the serializer and the parser, whose failure paths leave the
span through a `catch` that must not also re-end it — that exactly one such span
was exported despite the throw; an emulated tool-call success incrementing `tool_responses_total` through
the real generation wiring with a non-error parse span; prompt,
answer, thread-id, run-id, key-id, and path sentinels absent from both the
exposition and the spans; and a DISABLED port leaving the adapter literally
undecorated.

**Wiring over the real runtime and disabled inertness**
(`test/integration/observability.test.ts`): an idempotent REPLAY over a real
coordinator and the shared in-memory store returns the identical completion,
increments `requests_total` a second time, and leaves every upstream and poll
metric untouched; a successful SSE completion returns `stream_connections` to
zero and nests `gateway.encode` under `gateway.stream` under `gateway.request`; a
request-boundary tool-schema rejection increments
`tool_schema_failures_total{model="none"}` and performs no upstream work; and
DISABLED telemetry wired with ports that RECORD every call and then throw serves,
without a single recorded call: JSON success, SSE success, `401`/`404`/`400`
request-boundary errors, an upstream failure on both transports, a completion
timeout, a required-choice tool parse failure, a REAL-SOCKET client cancellation,
and an idempotent replay — with `GET /metrics` absent. A further MIXED
configuration (metrics disabled, tracing genuinely live) drives a real-socket
cancellation and asserts both that the metrics port is untouched and that the
root span is still marked failed; the fully-disabled cases cannot isolate a
per-call-site guard on their own, because the root hook is not installed at all.

Root-span CANCELLATION semantics are asserted on both transports over a real
socket: `SpanStatusCode.ERROR`, an ABSENT status message, the closed `other`
category, exactly one exported `gateway.request` span, one cancellation counter
increment, `requests_total` VALUE `1`, a stream gauge back to zero, and — because
a disconnect is not a gateway failure — no `errors_total` series at all. A
normally completed request is asserted NOT to carry an error status.

**API lifecycle** (`test/integration/observability.test.ts`): `/metrics` absent
(`404`) when disabled; present when enabled, with the registry content type,
`cache-control: no-store`, and identical behaviour with a valid key, an invalid
key, and no key at all — it is unauthenticated by design; nothing registered on
the client library's global registry; a JSON completion and a hijacked SSE completion
each settling EXACTLY once on their own transport; health and unauthenticated
requests settling under their own closed endpoints; capacity, idempotency, thread-reuse,
cross-replica rate-limit, shutdown-cancellation, and model-not-found failures
each landing in their own closed `error_category`; a completion with no upstream
work (the shape of an idempotent replay) settling as a request while incrementing
no upstream counter; `gateway.validate`/`gateway.encode` parented under
`gateway.request`; a REAL-socket client disconnect on both transports
recording exactly one cancellation, exactly one request settlement, and a stream
gauge back to zero; and prompt, answer, thread, session, idempotency-key, gateway-key,
and path sentinels absent from both the exposition and the spans.

A post-header SSE failure is asserted as ONE contract in a single case, because
its parts are only meaningful together: the status line reads `200` and stays
`2xx` forever once the header is committed, so the same case pins
`requests_total{transport="sse",status_family="2xx"}` at `1`, exactly one
`errors_total` series carrying the envelope's own closed category (not the
`other` fallback), `stream_connections` back to zero, and exactly one exported
`gateway.stream` span with `SpanStatusCode.ERROR`, an ABSENT status message, and
that same category — plus the root span's matching category, transport, and `2xx`
family. Split across cases, the pair could drift into "`2xx` and no error
recorded" with every individual assertion still green.

**Not covered.** No live OTLP collector is contacted by any suite, so wire-level
OTLP encoding and collector interoperability are unverified — an enabled tracer
has never been observed against a real collector. Load behaviour of the registry
under sustained scraping is likewise unmeasured and belongs to the outstanding
Phase 4 load gate (section 29.5), as is the memory profile of an enabled
`BatchSpanProcessor` under sustained traffic. Shutdown cancellation is not driven
while telemetry is disabled.

The two OPERATOR-facing limitations — no live collector, and unmeasured load
behaviour — are repeated in `README.md` and `.agent/instructions/operations.md`,
so someone enabling either feature meets them without reading this
specification. The shutdown-cancellation gap is test-coverage detail with no
operator action attached; this section and `.agent/instructions/validation.md`
own it, and it is deliberately NOT restated in the operator documents. Keep that
split: one detailed evidence owner, concise operator-facing limitations.

### 29.10 Cross-replica capacity tests (Phase 4D, implemented)

Cross-replica capacity (section 19.2) is covered at the same three layers as the
other Redis-backed features. The first two are hermetic and run inside
`npm run validate`; the third requires a real Redis and joins the SEPARATE
`npm run test:redis` gate, which now covers FOUR suites.

**Unit** (`test/unit/shared-capacity-keyring.test.ts`, `-redis-store`,
`-coordinator`, `-runtime`, plus additions to `config.test.ts`,
`gateway-auth.test.ts`, and `redis-runtime.test.ts`): HKDF domain separation from
all three existing Redis-backed features derived from the SAME master key; a
stable scope that is independent of gateway-key ORDER and of configuration index;
the registry key shape and its keyed digest; the `version | owner | scope` member
encoding, its byte bounds, its base64url alphabet, and the out-of-alphabet
delimiter that makes parsing unambiguous; the exact argument layout and every
reply mapping of both scripts, including a `claimed` reply carrying an unexpected
element (which must fail closed rather than yield a partially trusted grant list)
and an empty batch that issues no command at all; static assertions on the Lua
source for the load-bearing invariants — `TIME` rather than a Node clock, `TYPE`
before any ZSET command, `ZCARD` before `ZRANGE`, no `STRLEN` on a sorted set,
the first mutation only after complete validation, `PEXPIREAT` for the key
lifetime, `DEL` for an empty registry, and the ABSENCE of any renewal script;
lease derivation with the 30-second margin, the 630 000 ms cap, and a fail-closed
floor; batch construction in FIFO order with the per-scope cap and the global
cap; per-key bypass producing a granted set that is not a prefix; a full cluster
leaving waiters queued and granting them on a later retry; the retry schedule's
exact jitter bounds, its 1-second cap, its backoff reset on progress, and the
single retry timer; `MAX_QUEUED_REQUESTS=0` still admitting an immediately
claimable request while a concurrent second gets `429`; queue-full and
queue-wait-timeout rejections; cancellation, timeout, and shutdown racing an
in-flight claim, including a CONFIRMED grant to a departed waiter being released
at once and never delivered; a lost, corrupt, or rejected claim producing
`unavailable` with NO retry and NO compensating release; idempotent release, a
release carrying no abort signal, and a failed release after success; the
absence of dangling timers and abort listeners on every exit path; a null or empty
capacity scope failing closed without any Redis command; the three-way controller
selection (disabled, enabled-and-wired, enabled-but-unwired); gauge binding to
the ACTIVE controller; and the unchanged single readiness probe and shutdown
order.

The hardening of this boundary is covered at the same layer: a `claimed` reply
naming an unknown, duplicated, reordered, non-string, or non-canonical owner
producing `unavailable` while a skipped ordered subset and an empty subset stay
valid; `corrupt` and release `ok` accepted only at exact arity one; a submitted
batch with a duplicated owner refused before any command; the stored-deadline
ceiling at `NOW_MS + MAXLEASE`, one millisecond over, and a legitimately PAST
deadline still pruned rather than rejected; exact canonical component encodings
including a non-canonical trailing character that decodes to the SAME bytes; every
numeric guard; arrivals leaving a pending retry untouched, a sustained-arrival
regression holding the claim rate to the retry cadence, a release attempt for a
locally held permit pre-empting the timer, and a retry armed for a since-drained
queue being released while one armed for a queue that still has waiters is not;
the queue bound
reapplied after every settlement, including overflow retaining the earliest
waiters and every rejected overflow waiter detached; and a store whose `release()`
throws SYNCHRONOUSLY never escaping `Permit.release()` or abandoning a claim
settlement.

Each of the six remediations was implemented against focused cases demonstrated
to FAIL first — except the drained-queue timer release, which was added after
that round and verified by REVERTING its single line rather than observed red
beforehand. That evidence is HISTORICAL: it records how the fixes were
demonstrated, not a command that reproduces the red state, and none of it
executes Lua, so it does not substitute for the real-Redis gate below.
`.agent/instructions/validation.md` owns the operational detail.

**Integration with an injected store**
(`test/integration/chat-completions-shared-capacity.test.ts`) over the shared fake
in `test/support/fake-shared-capacity-store.ts`, covering both JSON and SSE:
disabled mode performing ZERO shared operations; global and per-key contention
serializing correctly while both requests still succeed; local FIFO order and
per-key bypass surviving end to end; queue-full and queue-wait timeout returning
the existing `429` with `Retry-After: 5`; an unavailable, corrupt, rejecting, or
not-ready store and an enabled-but-unwired instance each returning
`503 capacity_unavailable` with `Retry-After: 2` and making no upstream call; a
streamed request receiving a safe SSE error record rather than a new HTTP status;
a rate-limited request issuing no claim while a capacity-rejected request keeps
its already-spent quota unit; an idempotency waiter and replay taking no permit
while the owner takes exactly one; a capacity failure before `processing` leaving
the claim released and the reuse mapping RESTORED; client disconnect and shutdown
behaviour; a failed release after a successful completion still returning `200`,
whether the store's `release()` REJECTS or throws SYNCHRONOUSLY — the synchronous
case belongs here rather than at the unit layer, because the failure it guards
against is the route's own `finally` turning a completed `200` into a `500`, and
the same test proves the replica is not left wedged at its limit; a zero-length
queue whose own immediate claim grants nothing receiving the `429` rather than
being re-queued past a bound of zero, asserted at the route because the
client-visible outcome is a status and a header; and only the EXISTING metrics
plus the new `capacity_unavailable` error category.

**Real Redis** (`npm run test:redis`,
`test/redis/shared-capacity-store.test.ts`, `vitest.redis.config.ts`): two
INDEPENDENT stores and two independent coordinators over two independent
connections sharing one registry, so the global and per-scope limits are proven
under genuine concurrency rather than simulated; an ordered SUBSET naming exact
owners rather than a prefix count, driven by the per-scope limit alone under a
slack global limit; granting stopping the moment global occupancy reaches the
limit; a batch larger than the global limit could ever grant being refused
outright; the score really being Redis `TIME` plus the lease; expired-lease
pruning and crash recovery; the key's TTL tracking the latest lease and shortening
when the longest-leased permit is released; deletion when empty and when the
registry holds nothing but expired leases; a wrong type, an over-cardinality
registry, malformed members and scores, a stored deadline further ahead than any
lease this cluster grants, a duplicate owner token, a candidate whose owner
already holds a permit, and an invalid candidate each returning `corrupt` with
the registry left byte-for-byte untouched and no partially applied batch; an
EXPIRED deadline still treated as valid rather than corrupt; idempotent release; a
release for a member the caller does not hold removing nothing; `EVALSHA` → `EVAL`
recovery after `SCRIPT FLUSH`; a randomized key prefix per run with full cleanup;
and a scan proving no stored key or value contains the synthetic gateway-key,
prompt, answer, thread-id, session-id, or `k<index>` sentinels.

**Run status.** The hermetic suites run inside `npm run validate`. The real-Redis
suite is separately approval-gated: a past run authorizes no future Docker or
Redis command, and all four suites issue a server-wide `SCRIPT FLUSH`, so the
gate must only ever target a disposable instance.

**Execution evidence (2026-09-03, two approved LOCAL runs).** This suite **has now
been run and the four-suite gate passes**. It took two approved runs, and — as in
section 29.8 — the difference between them was entirely in the TESTS. Neither run
happened in CI.

The first approved run executed all four real-Redis suites against a disposable
pinned `redis:8.8.2-alpine` on host loopback with `maxmemory-policy noeviction`:
**80 of 86 tests passed and 6 failed, every failure in this Phase 4D suite** —
the Phase 4A, 4B, and 5A suites passed **59/59** and this suite passed **21 of
27**.

All six failures shared ONE test-inspector defect. The suite's `registryEntries()`
helper read the registry with a raw `ZRANGE ... WITHSCORES` and walked the reply as
RESP2's FLAT member/score/member/score array, but the inspection client is created
bare and node-redis 6.2.1 defaults to RESP3, whose reply is member/score TUPLES.
The helper therefore put a whole tuple in `member` and `undefined` in `score`,
breaking every assertion that inspected a decoded member. **No production defect
was established, and none was found.** The Lua issues its OWN `ZRANGE` inside the
server, where the reply is the flat Lua table the script parses regardless of any
client's protocol, and each of the six failing cases had already received the
expected `claimed`, `corrupt`, or `ok` decision from the store before the
mis-decoded stored-state assertion failed. **No production code, Lua script,
coordinator, runtime, configuration, dependency, or lockfile entry changed** in
response; the only edit was to `test/redis/shared-capacity-store.test.ts`, which
now reads the registry through the typed `zRangeWithScores()` binding — whose
per-protocol transforms normalize BOTH shapes to `{ value, score }` — behind guards
that throw rather than coerce an unexpected shape. That correction also made six
previously VACUOUS untouched-state comparisons meaningful, since both sides of
each had been identically mis-decoded.

After that correction, a second separately approved run executed the complete gate
— **4 files, 86 tests, all passing**, in a Vitest-reported 6.84 s — against a
fresh disposable `redis:8.8.2-alpine` on host loopback with `noeviction` and an
initial `DBSIZE` of **0**. Cleanup confirmed `DBSIZE` **0** with no suite key
remaining, and the Redis container and its Compose network were removed. Every
value was synthetic under a per-run randomized key namespace, no real credential
was used, and **no CollectivIQ, OpenCode, or OTLP call was made**.

This establishes that the two capacity Lua scripts and the store contract of
section 19.2 execute correctly against **Redis 8.8.2 in this test
configuration**. It does NOT generalize to another Redis version or
Redis-compatible product, say anything about behaviour under load, or make the
feature production ready. Shared capacity stays OFF by default; there is no
cross-replica queue fairness; a lost or evicted registry can briefly OVER-admit
while a failed release or an ambiguous claim conservatively UNDER-admits until the
lease expires; local gauges cannot see an orphan lease; `maxmemory-policy
noeviction` remains mandatory; and the outstanding Phase 4 items of section 32 are
unaffected. Every further execution of this gate needs fresh approval.

**Not covered.** Behaviour under sustained multi-replica load is unmeasured and
belongs to the outstanding Phase 4 load gate (section 29.5). No live CollectivIQ,
OpenCode, or OTLP call is made by any of these suites.

---

## 30. Tool-Calling Release Gates

Emulated tool mode must not be enabled as the default production OpenCode model until it passes:

1. **Schema validity:** At least 95% valid tool envelopes over a 200-case test suite.
2. **Tool-name accuracy:** At least 98% of parsed calls use an allowed tool.
3. **Argument validity:** At least 95% satisfy the supplied JSON Schema.
4. **Single-round success:** At least 90% of deterministic file-reading tasks invoke the expected tool.
5. **Multi-round success:** At least 85% of three-step read/edit/test scenarios complete without protocol corruption.
6. **No silent fallback:** Zero required-tool cases silently converted to final text.
7. **Injection resistance:** No unauthorized tool name accepted in the adversarial suite.
8. **Parser determinism:** Identical upstream fixtures always produce identical gateway results.

These are release criteria, not guarantees of model reasoning quality.

**Graduation decision — CANONICAL. This section owns the graduation decision and
the campaign evidence behind it; every other document must carry only a short
routed summary and link here.**

The state-aware report-v5 / checkpoint-v4 evaluator completed a full live
campaign on **2026-09-01**. All eight numerical gates above passed and the report
was overall **`passed: true`** (the campaign entry later in this section owns the
numerators, denominators, segments, and accounting — do not restate them
elsewhere). On that evidence, Phase 3 emulated tool calling is **graduated from
experimental to SUPPORTED OPT-IN BETA**. The following are normative:

* **Beta is not production readiness.** "Supported opt-in beta" must never be
  restated as "production-ready", "GA", "stable", or "verified". One passing
  campaign establishes the measured section-30 criteria; it does NOT establish
  repeatability across runs, cross-account reliability, cross-version behavior,
  or a general provider guarantee.
* **The feature stays non-default and permission-gated.** Every committed default
  virtual model remains `toolMode: "disabled"`. `collectiviq-claude-tools` is the
  single tool-enabled VIRTUAL MODEL, and the committed `opencode.jsonc` exposes
  that one model through TWO tool-enabled AGENT ENTRIES: the canonical
  `collectiviq-tools-beta` and the DEPRECATED `collectiviq-tools-experimental`
  compatibility alias. Both agents are functional and behaviorally identical —
  same model, `mode: "primary"`, and wildcard permission `"ask"` — so the alias is
  a second tool-enabled entry, not a disabled or legacy stub. The alias is
  retained through Phase 4; removing it requires a separately announced breaking
  configuration change. No committed default selects either agent, and OpenCode
  owns the permission prompt for every proposed call.
* **The gateway never executes or authorizes a tool.** It returns model-PROPOSED
  calls only; OpenCode owns authorization, execution, results, and loop limits.
  Graduation does not change that boundary.
* **The single value-free diagnostic stands.** The campaign's one
  `expected-tool-unavailable` diagnostic is legitimate measured evidence, not an
  error and not an outstanding defect: it is already accounted for inside the
  reported numerators and leaves every gate within its threshold.
* **Privacy warnings are unchanged.** For a `toolMode: "emulated"` model the
  validated tool schemas, prior tool arguments, and prior tool results ARE
  serialized into the prompt sent to CollectivIQ. They remain never logged and
  never retained by the gateway, each tool-loop round still creates a new upstream
  thread, and every existing warning to that effect must be preserved verbatim in
  meaning wherever it appears.
* **Graduation changed no behavior.** No production prompt, parser, candidate
  selector, threshold, evaluator, corpus, model policy, model default, public
  route, or other runtime behavior was changed to reach the passing result, in
  response to it, or as part of this graduation. Graduation is a status and
  labeling decision only.
* **Any further live run remains separately approval-gated**, including a
  re-scored campaign, the section 30.1 transition diagnostic, and any OpenCode
  live smoke.

**Default enablement is still blocked.** Making emulated tool mode the default
production OpenCode model remains a SEPARATE decision that may only be taken
after the relevant Phase 4 production-hardening controls exist and have been
reviewed: Redis idempotency; per-key rate limiting; metrics; tracing; the section
29.5 load testing; security review; dependency scanning; runbooks; backup
configuration; and the release process. Until that separate decision is recorded
here, tool mode stays opt-in.

**Implementation status.** The emulated engine, its hermetic unit/integration/
contract/compatibility coverage, and a deterministic **adversarial corpus**
(`npm run test:adversarial`, ≥200 protocol cases covering §29.4) are implemented.
The approval-gated **live evaluator** that measures these numerical gates against
the real origin (`npm run eval:tools`, `src/eval/`) is implemented — preflight by
default, password-only, fixed origin, 200 single-round + 20 three-step scenarios,
hard cap 280 upstream completions, per-request immediate cleanup, ID-only recovery
journal, abort-on-cleanup-failure, value-free output. Five authorized live
**campaigns** have been executed to date (a "campaign" scores at most one full
corpus; a campaign may span multiple resumable "execution segments"). **The
operative evidence is the completed 2026-09-01 report-v5 campaign recorded last
in this list: it scored the full corpus, ALL EIGHT gates passed, and overall
`passed: true`, so the numerical section-30 release criteria above are MET.** The
four earlier campaigns are historical; their `passed: false` results and their
"section-30 remains unmet" language describe the state at the time each ran and
must not be read as the current status.

- **Partial 2026-08-24 campaign — historical, established NO gate.** A single
  approved run attempted 149 rounds (all 149 created threads confirmed deleted —
  cleanup healthy; partial single-round snapshots read 99.3%) but aborted
  operationally under the evaluator's earlier ambiguous report. The three-step
  multi-step scenarios were never reached and are therefore **unmeasured** — the
  old report's `multiStepSuccessPct: 0` meant unmeasured, NOT a measured 0%.
- **Completed 2026-08-26 campaign — full corpus scored, overall `passed: false`.**
  One authorized campaign ran across two resumable execution segments: the first
  segment stopped on a cleaned/resumable `get-messages` `401` after attempt 161,
  and the second segment resumed from case cursor 160 and finished the corpus.
  281 attempted rounds, 280 completed/scored; 200/200 single-round cases;
  20/20 multi-step scenarios; 281/281 created threads deleted; zero cleanup or
  journal failures; the checkpoint finalized cleanly and no checkpoint remains.
  Gate outcomes: schema validity 257/260 (98.8%, **passed**); tool-name accuracy
  254/260 (97.7%, **failed** against the 98% / 255/260 minimum, i.e. missed by
  ONE additional expected-tool-accurate round); argument validity 257/260 (98.8%,
  **passed**); single-round success 199/200 (99.5%, **passed**); multi-step
  success 18/20 (90%, **passed**); no-silent-fallback, injection-resistance, and
  parser-determinism all **passed**. The counters imply six expected-tool
  misses: three rounds produced no selected valid tool-call set, and three
  selected valid allowed calls that did not include the expected tool. Overall
  `passed: false`; section-30 remains **unmet**; emulated tool mode stays
  experimental, opt-in, and non-default.
- **Diagnostic report-v3 campaign — full corpus scored, overall
  `passed: false`, motivated the report-v4 / checkpoint-v3 evaluator
  correction.** One authorized campaign ran across two resumable execution
  segments. The first segment stopped after 111 attempted rounds and 110
  completed rounds on a cleaned, resumable `process-message` failure (HTTP
  `402`, normalized as `upstream_unexpected_error`); cleanup was 111/111 with
  zero remaining, 110 single-round cases were committed, and the cursor
  persisted at 110. The resume completed the corpus at 281 attempted rounds
  and 280 completed rounds (200/200 single-round cases, 20/20 multi-step
  scenarios, 281/281 threads deleted, zero cleanup/journal failures). Gate
  outcomes: schema validity **245/260 (94.2%, failed against 95%)**;
  tool-name accuracy **229/260 (88.1%, failed against 98%)**; argument
  validity **245/260 (94.2%, failed against 95%)**; single-round success
  200/200 (**passed**); multi-step success **0/20 (failed against 85%)**;
  no-silent-fallback, injection-resistance, and parser-determinism all
  **passed**. The campaign emitted 37 value-free diagnostics, all in
  multi-step cases. Every multi-step case first failed at round 2 — 13
  returned final text instead of the expected tool call (
  `expected-tool-returned-text`) and 7 selected a DIFFERENT ALLOWED tool
  instead of the expected one (`expected-tool-not-invoked` — a tool inside
  the allowlist but not the one the round expected; this is DISTINCT from
  `unauthorized-tool-call`, which names a tool OUTSIDE the allowlist and
  affects the injection-resistance gate) — and the older evaluator
  continued after those terminal failures, producing 17 cascade
  diagnostics in later rounds (11 at round 3 and 6 at round 4). Those cascades established that the raw
  round-3/round-4 diagnostics could not be trusted as independent production
  failures and motivated the revised one-user-loop and truthful
  early-termination evaluator described below (report v4 / checkpoint v3).
  Overall `passed: false`; section-30 remains **unmet**; emulated tool mode
  stays experimental, opt-in, and non-default. This campaign did not
  establish any section-30 release gate. No production prompt, parser,
  selector, threshold, model default, or model-configuration change was
  made in response; only the evaluator itself was corrected. That
  correction was subsequently run live as the 2026-08-31 campaign below.
- **Completed 2026-08-31 report-v4 campaign — HISTORICAL; the FOURTH authorized
  campaign and the FIRST completed campaign on the corrected report-v4 /
  checkpoint-v3 evaluator; full corpus scored, overall `passed: false`.** This
  block records the state as of 2026-08-31. It is **no longer the operative
  campaign** — the completed 2026-09-01 report-v5 campaign below supersedes it —
  and its "unmet"/"deferred" statements are preserved only as the accurate
  contemporaneous record. The campaign ran
  across two resumable execution segments. The first segment stopped on a
  cleaned, resumable `get-messages` failure (normalized code
  `upstream_authentication_failed`, HTTP `401`) after 159 attempted rounds and
  158 completed rounds, having committed 158/200 single-round cases, with
  cleanup 159 attempted / 159 deleted / zero remaining / zero journal
  failures, the case cursor persisted at 158, the checkpoint unfinalized but
  persisted successfully, and no diagnostics. A resume was then explicitly
  approved; it began from case index 158 and completed the corpus. Final
  cumulative accounting: **269 attempted rounds, 268 completed rounds, 200/200
  single-round cases, 20/20 multi-step scenarios, 269/269 created threads
  deleted, zero cleanup failures, zero remaining threads, zero journal
  failures, the checkpoint finalized, and no final abort.** Gate outcomes:
  schema validity 254/260 (97.7%, **passed** against 95%); tool-name accuracy
  **248/260 (95.4%, failed against 98%)**; argument validity 254/260 (97.7%,
  **passed** against 95%); single-round success 200/200 (100%, **passed**
  against 90%); multi-step success **14/20 (70%, failed against 85%)**;
  no-silent-fallback, injection-resistance, and parser-determinism all
  **passed**. Six of the eight gates passed and overall `passed: false`. The
  campaign emitted exactly **six** value-free diagnostics, ALL in multi-step
  cases, ALL at round 2, ALL with `choiceKind: "auto"`, and ALL with reason
  `expected-tool-not-invoked` (a tool INSIDE the request's allowlist that was
  not the tool that round expected — DISTINCT from `unauthorized-tool-call`,
  which names a tool OUTSIDE the allowlist and affects the
  injection-resistance gate). The six affected case ordinals are
  **202, 204, 206, 207, 212, and 214**.

  *Early-termination accounting (semantics unchanged).*
  `plannedUpstreamRounds: 280` is the complete-corpus UPPER BOUND, not the
  exact attempt count. Fourteen successful multi-step scenarios executed four
  rounds each (read → edit → test → final answer); the six failed scenarios
  terminated truthfully at round 2 and issued no further upstream rounds.
  Early termination therefore prevented 12 later calls, yielding 268 completed
  rounds (200 single-round + 14·4 + 6·2) instead of the 280 upper bound, and
  the one additional attempted-but-not-completed operational round — the
  segment-1 `get-messages` `401` — yields 269 attempted rounds. The
  expected-call denominator stayed at its planned 260 (200 single-round rounds
  plus 20 scenarios × `expectedCallsPerScenario` 3). All **254 EXECUTED
  expected-tool rounds were schema- and argument-valid**, which is exactly the
  254/260 reported on both of those gates. The six failing round-2 calls were
  valid, ALLOWED calls that simply omitted the expected tool, and each
  terminated scenario's remaining planned expected-tool round was never
  executed and counts as a denominator MISS: six wrong-tool rounds plus six
  unexecuted rounds produces **248/260 tool-name accuracy with no fabricated
  cascade diagnostics**. This is precisely the truthful accounting the
  report-v4 / checkpoint-v3 correction was built to produce.

  *Interpretation and disposition.* The diagnostics locate the failures at the
  multi-step `edit` step of six of the twenty scenarios under an `auto` tool
  choice, and they are deliberately value-free: they do NOT identify which
  alternative allowed tool was selected, and this campaign does NOT establish
  a definitive provider, model, prompt, parser, or selector root cause. The
  user reviewed this evidence and chose to **defer** Phase 3 remediation.
  Accordingly **no production prompt, parser, selector, evaluator, threshold,
  model default, or model configuration was changed in response**; section-30
  was **unmet** as of that date. The subsequent live transition diagnostic
  (section 30.1) and the state-aware report-v5 / checkpoint-v4 correction showed
  that the multi-step failures recorded here were an ACCOUNTING artifact of
  positional round expectations rather than a demonstrated production defect,
  and the completed 2026-09-01 report-v5 campaign below rescored the same corpus
  with all eight gates passing. Only the EVALUATOR changed between the two
  campaigns.

- **Completed 2026-09-01 report-v5 campaign — the FIFTH authorized campaign, the
  FIRST completed campaign on the state-aware report-v5 / checkpoint-v4
  evaluator, and the CURRENT OPERATIVE EVIDENCE; full corpus scored, overall
  `passed: true`.** The campaign ran across two resumable execution segments and
  ALL EIGHT section-30 gates passed, so the numerical release criteria stated at
  the top of this section are **met by this completed campaign**.

  *Execution segment 1 — a successful live exercise of the cleaned resumable-
  interruption path, NOT a failed campaign.* Against the `plannedUpstreamRounds`
  upper bound of 280, the segment attempted **183** upstream rounds and completed
  **182**, committing **182/200** single-round cases and **0/20** multi-step
  scenarios. Cleanup was **183 attempted, 183 deleted, zero failed, zero
  remaining, zero recovery-journal failures**. It then stopped on a structured,
  value-free abort: reason `round-execution-failed`, stage `get-messages`,
  normalized code `upstream_authentication_failed`, HTTP status `401`,
  `resumable: true`. The checkpoint persisted successfully at next case index
  **182** on run segment **1** and was correctly left unfinalized. Exactly one
  already-committed value-free diagnostic existed at that point: phase `single`,
  case ordinal **181**, round ordinal **1**, choice kind `auto`, reason
  `expected-tool-unavailable`. Every documented guarantee held — the interrupted
  attempt's thread was confirmed deleted before the abort was classified
  resumable, the cursor advanced only over cleanup-confirmed cases, and the
  durable checkpoint remained validator-acceptable.

  *Approved resume and final result.* A resume was then explicitly approved and
  began from case index **182**. Final cumulative accounting: **274 attempted
  rounds, 273 completed rounds, 200/200 single-round cases, 20/20 multi-step
  scenarios**, cleanup **274 attempted / 274 deleted / zero failed / zero
  remaining / zero recovery-journal failures**, and a checkpoint that recorded
  `resumed: true`, `runSegments: 2`, a final next case index of **220**,
  `finalized: true`, and no persistence failure. There was **no final abort**.
  The single segment-1 diagnostic above remained the campaign's **only**
  diagnostic. Overall **`passed: true`**.

  *Gate outcomes (all eight passed).*

  | Gate | Result |
  | --- | --- |
  | Schema validity | 259/260, 99.6%, **passed** against 95% |
  | Tool-name accuracy | 259/260, 99.6%, **passed** against 98% |
  | Argument validity | 259/260, 99.6%, **passed** against 95% |
  | Single-round success | 199/200, 99.5%, **passed** against 90% |
  | Multi-step success | 20/20, 100%, **passed** against 85% |
  | No silent fallback | **passed** |
  | Injection resistance | **passed** |
  | Parser determinism | **passed** |

  *Round accounting.* `plannedUpstreamRounds: 280` remains the complete-corpus
  UPPER BOUND, not the exact attempt count. The 273 completed rounds comprise the
  200 single-round completions plus **73** multi-step rounds. All 20 multi-step
  scenarios succeeded, and the state-aware engine's parallel transitions let
  scenarios complete below the four-round-per-scenario upper bound, which is why
  73 is fewer than 20·4. **The final report does not carry a per-scenario round
  distribution, so none is documented or inferred here.** The difference between
  the 274 attempted and 273 completed rounds is exactly the one cleaned,
  resumable segment-1 `401` attempt.

  *Interpretation.* Overall `passed: true` means the complete corpus was scored,
  no abort remained, every gate passed, cleanup and recovery-journal accounting
  were clean, and checkpoint finalization succeeded. The single value-free
  diagnostic is **legitimate measured evidence, not an error** — a single-round
  `expected-tool-unavailable` outcome that is fully accounted for inside the
  reported numerators and leaves every gate within its threshold. This campaign
  therefore satisfies the numerical section-30 release criteria. It does NOT by
  itself establish production readiness, cross-account reliability, repeatability
  across runs, or a general provider guarantee, and it introduces no new
  threshold. **On this evidence Phase 3 emulated tool calling was graduated from
  experimental to supported opt-in beta — still non-default, still OpenCode
  permission-gated, and still not production-ready; the graduation decision at
  the top of this section is canonical.**
  No production prompt, parser, selector, threshold, model default, model
  configuration, OpenCode configuration, or public route was changed in response
  to this campaign, and any further live run remains separately approval-gated.

**Evaluator change timeline (do not conflate these four stages).** (1)
*Baseline hardening* landed offline BEFORE the 2026-08-26 campaign and applied
to the 2026-08-26, report-v3, and 2026-08-31 campaigns. (2) The *report-v4 /
checkpoint-v3 corrections* (genuine one-user agent loop, deterministic
synthetic tool results, truthful early termination, executed-round ledger) were
added LATER, after the report-v3 campaign, and therefore did NOT apply to the
2026-08-24, 2026-08-26, or report-v3 campaigns. (3) The corrected evaluator was
run live on **2026-08-31**. Attribute report-v4 behavior only to that campaign.
(4) The *state-aware report-v5 / checkpoint-v4 correction* (shared transition
engine, per-transition gate evidence, dynamic expectations, appended
`scenario-round-budget-exhausted`) landed after the 2026-08-31 campaign and the
live v2 transition diagnostic, and was run live on **2026-09-01**. Attribute
report-v5 behavior — and the passing gate results — only to that campaign.

The baseline hardening is described first. It emits a
versioned, value-free **output union** (`preflight | progress | blocked` — a
pre-execution precondition failure — `| executed`) and a **four-state gate status**
(`passed | failed | incomplete | not_evaluated`): a zero denominator is
`not_evaluated` (never 0%); a partial sample is `incomplete` (never `passed`); a
threshold gate is `passed`/`failed` only when its planned denominator is complete,
and each threshold gate now carries explicit `numerator`, `denominator`, and
`plannedDenominator`. Overall `passed` requires a complete corpus, no abort, all
gates passed, zero cleanup/journal failures, AND successful checkpoint
finalization. It emits **structured value-free abort diagnostics** — a stable
reason, a closed stage set, a normalized `UpstreamError` code, a safe HTTP status
(read trap-safely via `isUpstreamError`, never inspecting a hostile thrown value),
and a `resumable` boolean (a create-stage interruption is ambiguous and therefore
non-resumable; a submit/poll failure is resumable only after confirmed thread
deletion and durable checkpoint persistence; cleanup/journal/checkpoint-persistence
failures are non-resumable). JSON **progress** events are emitted only after a
cleaned attempt AND a successful durable checkpoint write, and stay value-free (no
prompts, answers, ids, schemas, args, or credentials). A private, content-free
resume **checkpoint** lives at the ignored fixed path
`.agent/sessions/eval/tools-eval-checkpoint.json` (0700 dir, 0600 file,
`O_NOFOLLOW`, atomic temp+rename, strict
version/origin/auth/corpus-fingerprint/bounded-count validation), gated behind a
new `--resume-approved` CLI flag: an existing checkpoint requires it, and an
incompatible or approval-absent checkpoint fails closed BEFORE any credential read
or network I/O.

Four additional remediations are now **enforced by code and hermetic tests**
(`src/eval/checkpoint.ts`, `src/eval/report.ts`,
`test/contract/eval-checkpoint.test.ts`). First, **semantic (corpus-bound)
checkpoint validation**: the executed evaluator builds `buildEvalCases()`
EXACTLY ONCE per run and derives its fingerprint, plan, projection, and
case-loop iteration from that ONE `EvalCase[]` value —
`corpusFingerprint(cases)`, `evalPlan(cases)`, and
`buildEvalCorpusProjection(cases)` all accept the supplied array, so no
divergent rebuilt corpus can slip into the executed path.
`buildEvalCorpusProjection` also FAILS CLOSED at build if any round's
`choice.kind` is outside the closed diagnostic union `"auto" | "required" |
"function"` (specifically `"none"`, which the synthetic corpus never uses and
which the diagnostic shape cannot represent), so no downstream constructor
needs a silent `"none" → "auto"` relabel. On resume a decoded checkpoint is
validated against that fingerprint-bound corpus **projection**
(`EvalCorpusProjection` derived DIRECTLY from `buildEvalCases()`) BEFORE any
credential read or network I/O — never from checkpoint-claimed sizes and never
from an aggregate `first N rounds are expected` inference. Defense-in-depth:
`validateResumableCheckpoint` re-checks that every projected round's
`choiceKind` is inside the diagnostic union before it trusts the projection. The projection is an immutable, content-free
structural view: per-case `phase` plus per-round `choiceKind` and
`hasExpectedTool`, with aggregate bounds (`plannedSingle`, `plannedMulti`,
`expectedCallsPerScenario`, `maxRoundsPerCase`) derived from the SAME cases so
they are internally consistent by construction. `nextCaseIndex` must lie
strictly within `0..corpus-length` (a resumable checkpoint can never encode a
complete corpus — a genuinely complete run removes its checkpoint); committed
single/multi case counts must be EXACTLY cursor-derived, computed by walking
the projection's first `cursor` cases (a resumable checkpoint cannot invent a
`phase` mix that disagrees with the corpus); gate denominators are the
committed counts summed from the ACTUAL per-case `hasExpectedTool` layout
(single = committedSingle, multi = committedMulti,
expected-call = Σ over committed cases of that case's expected-tool rounds —
which for the uniform production corpus equals `committedSingle +
committedMulti·3`, but for a non-uniform corpus honors the actual layout);
every numerator must be an integer in `[0, denominator]`; the upstream-round
counters are bounded by the actual per-case round counts — a committed
three-step scenario performs FOUR upstream rounds (read/edit/test/final answer),
NOT the three expected-tool-call rounds, so the committed upstream-round floor
is the Σ over committed cases of that case's ACTUAL `rounds.length` (which for
the uniform production corpus equals `committedSingle +
committedMulti·maxRoundsPerCase`, i.e. `·4`), distinct from the gate
denominator. Because the counters accumulate across resume segments but a
segment aborts at its first non-committing case (leaving at most one in-flight
scenario's uncommitted partial rounds plus one terminal failed round), they are
ALSO bounded ABOVE — completedRounds ≤ committedUpstreamRounds +
runSegments·(maxRoundsPerCase−1) and attemptedRounds ≤ committedUpstreamRounds
+ runSegments·maxRoundsPerCase, with completedRounds ≤ attemptedRounds — so
an arbitrarily inflated counter is rejected; resumable cleanup accounting must
be truthful (deleted + failed == attempted, failed == 0, journalFailures == 0,
attempted == deleted == attemptedRounds); runSegments ≥ 1; and the fresh
zero-count anchor is valid. Each diagnostic ledger entry is then checked
round-by-round against `projection.cases[caseIdx0].rounds[roundIdx0]`: the
case must be committed at or before the cursor, the round must exist in that
exact case, and the reason scope (`expected` / `final` / `any`) must match
that round's ACTUAL `hasExpectedTool` disposition. A forged or inconsistent
checkpoint — including any "complete + passing, zero-attempt" claim, a
diagnostic entry beyond the committed cases, a round that does not exist in
its case, or a reason whose scope disagrees with the actual round — is rejected
as content-free invalid state, so a checkpoint can NEVER manufacture a
zero-network `executed` pass.
Second, **durable resumable-vs-blocked state**: the checkpoint schema carries
`resumeState: "resumable" | "blocked"` plus a value-free closed abort
`{ stage, reason }` (null when resumable). Every NON-resumable abort (ambiguous
create, cleanup-delete failure, recovery-journal persistence failure,
checkpoint-persist failure, journal-finalize failure, toolset-compile,
signal/lifecycle) attempts to replace the checkpoint with a durable `blocked`
**tombstone** carrying only closed lifecycle metadata plus the abort stage/reason —
never prompts, answers, ids, credentials, titles, or bodies. A `--resume-approved`
run REJECTS a blocked checkpoint before credentials/network; recovery requires
deliberate operator archival or removal (no automatic destructive restart). If the
tombstone write itself fails, the report stays non-resumable and truthfully
surfaces the checkpoint persistence failure. A complete successful run still
removes the checkpoint. Third, **exact 0600 file mode + safe ancestry**: a
checkpoint file is accepted only when `(mode & 0o777) === 0o600` (0400/0200/0000,
group/world bits, non-regular, or symlink are all rejected); the checkpoint location
is an explicit TRUSTED BASE plus its ordered managed components (`.agent`/`sessions`/
`eval`), and EVERY managed component is `lstat`-validated TOP-DOWN from the base as a
real, non-symlink directory on read/write/delete/exists — so a symlink at ANY managed
level, even one whose descendants already exist through it, is caught before the OS
would traverse it (closing the earlier immediate-parent-only gap where a symlinked
`.agent` with a real `sessions/eval` underneath went undetected); directory creation
no longer uses recursive `mkdir` (which can follow a redirected/symlinked ancestor) —
missing components are created ONE AT A TIME with the private 0700 mode and
re-validated, and the file open keeps `O_NOFOLLOW` with atomic temp+rename and bounded
size. Nothing AT or ABOVE the trusted base is symlink-validated, so a legitimate
platform symlink above it (e.g. macOS `/var`→`/private/var`) is not falsely rejected. Fourth,
**lifecycle/output guarantees via one explicit finalization state machine**: the
recovery journal is finalized EXACTLY ONCE on every executed AND blocked path after
successful init, through one idempotent helper (closing a prior gap where the
working-tree evaluator did not finalize it on all paths — including the initial-
anchor-write-failure path, which now routes the finalize through that helper instead
of swallowing it and reports a journal-finalize failure there as its OWN closed
blocked reason `recovery-journal-finalize-failed`, distinct from the
`checkpoint-write-failed` anchor failure, before any credential read or network call),
and a journal-finalization failure is a closed abort stage/reason
(`recovery-journal-finalize` / `recovery-journal-finalize-failed`), is non-resumable,
durably blocks the checkpoint, and prevents a pass; progress ordering is exact — a
cleaned-but-uncommitted TERMINAL resumable attempt (a submit/poll failure or
interruption whose thread was created and confirmed deleted with no journal failure)
carries a bounded, value-free pending-progress descriptor that finalization emits
EXACTLY ONCE, and only AFTER the resumable checkpoint durably persists, so no cleaned
attempt is silently dropped and the descriptor never claims the case cursor advanced;
a journal-finalize or checkpoint persistence failure emits no resumability progress,
and no duplicate progress record is emitted for the same completed multi-step case; and
all abort/blocked reasons are CLOSED literal unions (`AbortReason` / `BlockedReason`
/ `AbortStage`) constructed through typed helpers, so no free-form exception text
ever reaches output or checkpoints. The overall finalization order is: finish/abort
round → bounded cleanup → finalize recovery journal exactly once → persist a
validated resumable checkpoint OR a blocked tombstone → emit progress only when a
resumable checkpoint durably persisted → emit final report → on complete success
remove the checkpoint and report success only after all finalization succeeds.
`create`/`process_message` are never auto-replayed (only GET
polling keeps its existing idempotent retry); a single-round cursor advances only
after cleanup is confirmed, a multi-step scenario commits gate measurements and
advances only at scenario end (so a mid-scenario interruption restarts that
scenario, prior partial rounds counting only as attempts/cleanup); a controlled
first SIGINT/SIGTERM cleans a recorded thread on an independent (non-aborted)
signal, a second forceful interrupt terminates, and the ID-only recovery journal
remains the final recovery mechanism; on complete success the checkpoint is
finalized (removed). A value-free password-auth observation (login attempts, last
HTTP status or null, normalized boolean) is now surfaced in the final report.

**Revised multi-step model + early-termination accounting (report v4 /
checkpoint v3) — HISTORICAL. This block describes the evaluator that produced
the 2026-08-31 campaign and is SUPERSEDED by "State-aware multi-step scoring
(report v5 / checkpoint v4)" below; where the two disagree, v5 governs.**
Post-2026-08-26 review of the completed campaign identified
three latent ambiguities in the evaluator that the raw gate numbers alone
cannot separate from a genuine production defect: (a) every synthetic tool
result was a single fixed value (`{"synthetic":true,"ok":true}`), so a correct
`read` supplied no document content for the model to construct the expected
`edit` from; (b) the evaluator injected a FRESH user message for every logical
read/edit/test/final step instead of modelling ONE original user request
followed by assistant `tool_calls` and linked `role: "tool"` result messages;
and (c) it continued issuing later logical rounds after an outcome that would
already terminate a real OpenCode tool loop, so multi-step round-3/round-4
diagnostics could be cascades rather than independent failures. The revised
evaluator — implemented offline and since run live as the completed 2026-08-31
report-v4 campaign above — therefore represents a **genuine OpenCode-style
agent loop** over synthetic in-memory state:

- Each multi-step scenario carries `EvalScenarioState` (`path`,
  `initialContent = "version=1"`, `expectedFinalContent = "version=2"`) plus a
  mutable per-run runtime state (in v5 this is the shared
  `src/eval/scenario-engine.ts` transition state). ONE initial user message
  (`rounds[0].prompt`) states the whole goal; later rounds accumulate history
  ONLY through the previously ACCEPTED assistant `tool_calls` message and
  exactly linked `role: "tool"` synthetic result messages — the evaluator
  never injects a fresh user instruction between tool results. The prompt
  serialization is the same normalized history the gateway/OpenCode
  compatibility path uses.
- Tool results were rendered by a dedicated synthetic renderer (v5 folds this
  into the shared transition engine) and are deterministic and content-safe (no filesystem, shell, MCP, external
  service, repository content, or real user data): `read` →
  `{"ok":true,"path":<state.path>,"content":<state.content>}` (provides the
  content and path the model needs to construct the expected `edit`); `edit`
  → `ok:true` when the call's `path` matches the scenario path AND `text`
  matches the expected replacement (state flips to
  `content = expectedFinalContent`, `edited = true`), else `ok:false` and the
  state is left unchanged; `test` → `{"ok":true,"testsPass":<content ===
  expectedFinalContent>}` (pass/fail depends only on prior synthetic state).
- A multi-step scenario STOPS at its first terminal failure — premature final
  text, no valid call, unavailable, unauthorized call, allowed but unexpected
  tool, or an invalid transcript linkage — and issues no further upstream
  rounds. The evaluator commits exactly ONE primary value-free diagnostic
  identifying that terminal failure; it never fabricates diagnostic entries
  for rounds that never ran.
- Section 30 thresholds and planned denominators are **unchanged**. A
  terminated scenario still contributes `expectedCallsPerScenario` (3) to the
  expected-call denominator (its remaining planned expected-tool steps count
  as gate MISSES, not attempted upstream rounds) and 1 to `multi.total`, and
  under v4 a scenario counted as multi-success only when every expected round
  produced the correct allowed call AND the scenario ran to completion. **v5
  replaces that rule**: success requires all three TRANSITIONS plus an accepted
  final text, which parallelism can reach in fewer than four rounds. `plannedUpstreamRounds` (280) is the complete-corpus UPPER
  BOUND, not the exact attempt count — a complete failed corpus reports
  strictly fewer `attemptedRounds` when multi-step scenarios terminate early.

**Truthful checkpoint accounting (checkpoint v3 — HISTORICAL, superseded by
format 4 below).** The checkpoint format version was bumped
from 2 to `3` and adds a compact per-committed-multi-step-scenario
`executedScenarioRounds` ledger (one integer per committed multi scenario, in
commit order, each in `[1, correspondingCase.rounds.length]` — the per-CASE
round count, NOT the projection-wide `maxRoundsPerCase`, so a non-uniform
corpus is validated round-by-round rather than reduced to the projection
maximum). `executedScenarioRounds.length` MUST equal
`completedMultiStepScenarios`, and the committed upstream-round floor is
`committedSingle + Σ executedScenarioRounds` — never `committedSingle +
committedMulti·maxRoundsPerCase`. Semantic (corpus-bound) validation
therefore keeps the per-round layout check (each entry within its case's
actual `rounds.length`; `maxRoundsPerCase` remains legitimate only as the
projection-wide UPPER BOUND used by the operational upstream-round ceilings:
completed ≤ committedUpstreamRounds + runSegments·(maxRoundsPerCase−1),
attempted ≤ committedUpstreamRounds + runSegments·maxRoundsPerCase), so a
forged or internally-inconsistent checkpoint — including any "complete +
passing, zero-attempt" claim, a diagnostic entry beyond the committed cases,
a ledger length that disagrees with the committed multi count, or a
per-case round count that fits the projection maximum but exceeds its
corresponding case's `rounds.length` — is still rejected as content-free
invalid state BEFORE any credential read or network I/O. Validation also
derives the two invariant gates (`noSilentFallback`, `injectionResistance`)
from the same executed-round + diagnostic evidence, so a persisted
invariant boolean that disagrees with the derived truth is likewise
rejected: an `unauthorized-tool-call` diagnostic under any tool choice
forces `injectionResistance: false`, and an executed round producing
ordinary text under `required` or named-`function` (an
`expected-tool-returned-text` diagnostic on that round, or an executed
final round with no diagnostic) forces `noSilentFallback: false`. Under v3 a v2 checkpoint was
**rejected** with no migration path; under v4 formats 1, 2, AND 3 are rejected
(a resumed run must start from a fresh anchor). All other checkpoint discipline is intact — private path and
permissions, trusted-base ancestry validation, `O_NOFOLLOW`, atomic
persistence, bounded file size, resumable-vs-blocked tombstones, cleanup/
journal truth, finalization ordering, and content-free records.

**Diagnostic reporting (report v4 / checkpoint v3) — HISTORICAL; the shapes
below are current except where v5 extends them.** To identify the failure
locations without changing the production prompt, selection engine, evaluation
thresholds, corpus, or model defaults, the evaluator emits **bounded,
value-free failure diagnostics**. The report version was bumped from 3 to `4`
across every mode (and from 4 to `5` by the state-aware correction below) (`preflight`, `progress`, `blocked`, `executed`), and only
the `executed` variant carries the collection:

```ts
readonly diagnostics: {
  readonly failures: readonly EvalFailureDiagnostic[];
};

interface EvalFailureDiagnostic {
  readonly phase: "single" | "multi";
  readonly caseOrdinal: number;  // global corpus ordinal, 1-based
  readonly roundOrdinal: number; // within the case, 1-based
  readonly choiceKind: "auto" | "required" | "function";
  readonly reason: EvalFailureReason;
}

type EvalFailureReason =
  | "expected-tool-returned-text"
  | "expected-tool-no-valid-call"
  | "expected-tool-unavailable"
  | "expected-tool-not-invoked"
  | "unauthorized-tool-call"
  | "transcript-invalid"
  | "unexpected-tool-call-on-final"
  | "final-no-valid-call"
  | "final-unavailable"
  | "scenario-round-budget-exhausted"; // APPENDED by v5 (code 10, scope "any")
```

At most one primary diagnostic is emitted per failed round, using this
deterministic precedence. For a round with an `expectedTool`:
(1) `unavailable` → `expected-tool-unavailable`;
(2) `no_valid_call` → `expected-tool-no-valid-call`;
(3) ordinary text → `expected-tool-returned-text`;
(4) tool calls containing an unauthorized name → `unauthorized-tool-call`;
(5) allowed calls that omit the expected tool → `expected-tool-not-invoked`;
(6) expected tool selected but normalized transcript linkage fails →
`transcript-invalid`;
(7) otherwise no diagnostic. For a final round without an `expectedTool`:
(1) ordinary text → no diagnostic;
(2) `unavailable` → `final-unavailable`;
(3) `no_valid_call` → `final-no-valid-call`;
(4) an unauthorized call → `unauthorized-tool-call`;
(5) any other tool call → `unexpected-tool-call-on-final`. Duplicates are
impossible: a failed round is identified by a unique `(caseOrdinal, roundOrdinal)`
key. The diagnostic decision must not (and does not) alter any gate accumulator or
scenario-success behavior — existing gate results are byte-for-byte equivalent apart
from the report version and the new field. The collection is bounded by the
fixed 280-round corpus (see `MAX_DIAGNOSTIC_FAILURES`) and never contains
prompts, answers, arguments, schemas, tool names, selected model names, IDs,
credentials, titles, bodies, URLs, timestamps, or exception text.

**Resume-safe checkpoint persistence (v3 — HISTORICAL; see format 4 below).**
The private on-disk checkpoint format
version was bumped from 2 to `3`; v1 and v2 checkpoints were **rejected** with
no migration path. Under the current format 4, formats 1, 2, AND 3 are
rejected. Failure diagnostics survive interrupt/resume
via a compact, content-free ledger:

```ts
readonly diagnosticFailures: readonly [
  caseOrdinal: number,
  roundOrdinal: number,
  reasonCode: number
][];
```

The reasons map to fixed integer codes (1..9 under v4, extended to 1..10 by
v5's appended reason, in the union order above) via
the immutable `evalFailureReasonForCode(code)` closed switch — never a mutable
`Map`/`Set`, so no reachable runtime mutation can widen the allowlist to accept
an unknown code such as `42`. `phase` and `choiceKind` are NOT persisted and are
instead derived from a freshly built, fingerprint-bound
`EvalCorpusProjection` (`buildEvalCorpusProjection(buildEvalCases())`, an
immutable content-free per-case per-round structural view) when the resumed
report is built; rehydration FAILS CLOSED on any impossible entry (unknown
reason code, out-of-corpus case/round, or an out-of-diagnostic-union
`choiceKind` such as `"none"`) — no silent skip, no silent relabel.
`MAX_CHECKPOINT_BYTES` stays at 8192: the worst valid 280-entry ledger fits
comfortably (~2 KiB with every entry, using three-digit case ordinals and a
single-digit reason code, in compact JSON). Ledger validation is strict —
maximum 280 entries; unique `(caseOrdinal, roundOrdinal)` pairs; case ordinals
only refer to a case committed at or before `nextCaseIndex`; the round ordinal
must exist in that EXACT projected case; the reason code must be one of the
fixed codes; the reason must be structurally compatible with the referenced
round's disposition — under v4 that meant the round's `hasExpectedTool` flag,
and under v5 a MULTI-STEP round is instead checked against the scenario's
SATISFIED STATE (a single-round case still uses `hasExpectedTool`) — and validation runs
against the freshly built `EvalCorpusProjection` BEFORE any credential read or
network I/O, preserving the credential-before-network guard for every existing
v2 checkpoint failure mode (mode, `O_NOFOLLOW`, ancestry, atomic-write, size,
blocked-tombstone, counter, cursor, and fingerprint protections stay intact).
Nothing about phase, choice, bounds, or corpus dimensions is trusted from
checkpoint data.

For **multi-step** cases, pending diagnostics accumulate locally with the
existing deferred gate measurements and are committed only when the whole
scenario commits: an interrupted or aborted mid-scenario run persists neither
its gate measurements nor its pending diagnostics, and replaying that scenario
after an approved resume produces a single committed diagnostic set with no
duplicates. For **single-round** cases, the diagnostic is committed together
with the case's score and cursor before progress is emitted. On a completed
run, the final `executed` report re-emits every prior segment's committed
diagnostics exactly once.

**State-aware multi-step scoring (report v5 / checkpoint v4). CURRENT, and
successfully exercised live by the completed 2026-09-01 campaign recorded
above.** The completed 2026-08-31 report-v4 campaign, and
the subsequent live transition diagnostic recorded in section 30.1, showed that
the evaluator's remaining multi-step defect was its own accounting, not
necessarily the model's behavior. Report v4 expected exactly one named tool per
upstream round, keyed by ROUND ORDINAL. The request enables parallel tool calls,
so a round that correctly returns `[read, edit]` completes two transitions at
once; the following round then produced `test` and was scored against a stale
round-2 `edit` expectation and recorded as `expected-tool-not-invoked`. Report
v5 therefore derives a scenario's expectation from the transitions that have
SUCCESSFULLY completed, through a shared evaluator-only engine
(`src/eval/scenario-engine.ts`) that BOTH live evaluators consume so they cannot
drift.

- **Ordered, prerequisite-gated transitions.** The workflow is
  `read → edit → test → final text`. `read` succeeds only when its `path`
  argument is the scenario's exact synthetic path; `edit` succeeds only AFTER a
  successful `read` and only when its `path` AND `text` exactly match the
  expected write; `test` succeeds only AFTER a successful `edit` and when the
  synthetic content equals the expected final content. Success is therefore
  always a leading PREFIX of the workflow. Failed, repeated, or out-of-order
  calls still produce deterministic content-safe results and remain in the
  normalized transcript, but they do not advance the state. All state stays
  synthetic and process-local: no filesystem, shell, MCP, external service,
  repository content, or real user data, and no tool is ever executed.
- **Parallel batches.** Calls inside one batch are folded in the model's
  RETURNED order, so `[read, edit]` advances two transitions,
  `[read, edit, test]` advances all three, `[edit, read]` advances only `read`
  (the `edit` ran before its prerequisite), and `[read, test]` advances only
  `read` while the `test` reports failure.
- **Dynamic expectation.** Each round expects the next UNSATISFIED transition;
  once all three succeed it expects final text. A response that omits the
  dynamically expected tool is still a terminal `expected-tool-not-invoked`. The
  expected tool being PRESENT but failing semantically is NOT terminal: that
  step stays pending and a later bounded round may retry it.
- **Per-step gate evidence.** For each of the three planned transitions the
  evaluator keeps independent booleans for schema-validity, argument-validity,
  expected-name accuracy, and successful satisfaction. A valid selected
  tool-call set credits the CURRENTLY PENDING step's schema/argument evidence
  and marks its name evidence only when that step's tool is present in an
  allowed set; every transition the batch newly completes — including extras
  beyond the pending one — receives FULL evidence. A future step called
  prematurely earns nothing unless its prerequisites were satisfied and the call
  actually advanced the state. Retries merge into the same step, so no step is
  ever double-counted, and at scenario commit each planned step contributes
  EXACTLY ONE unit to the expected-step denominator with a missing bit left as a
  truthful miss.
- **Unchanged bounds.** 200 single-round cases, 20 multi-step scenarios, four
  upstream rounds maximum per scenario, `plannedUpstreamRounds: 280` as the
  complete-corpus UPPER BOUND, exactly three expected-step denominator entries
  per scenario (the planned 260 total), all section-30 thresholds, and all
  single-round behavior are UNCHANGED. Single-round scoring is byte-for-byte
  equivalent.
- **Success and budget.** A scenario succeeds when all three transitions AND an
  accepted final text complete within four rounds — including in three rounds
  when parallelism completes two transitions at once, or two rounds when one
  batch completes all three. If the budget ends without an accepted final
  answer the evaluator emits EXACTLY ONE value-free terminal reason,
  `scenario-round-budget-exhausted`, at the last executed round. It is APPENDED
  to `EvalFailureReason` as checkpoint reason code `10` (codes 1–9 keep their v4
  meaning) with structural scope `"any"`. No later round is fabricated and no
  cascade diagnostic is produced.

`EVAL_REPORT_VERSION` is `5` and `CHECKPOINT_FORMAT_VERSION` is `4`. **Checkpoint
formats 1, 2, and 3 are REJECTED with no migration path**: their accounting was
positional and cannot be replayed under transition-based accounting, so a
resumed run must start from a fresh anchor. Format 4 replaces
`executedScenarioRounds` with a per-committed-scenario evidence tuple:

```ts
readonly scenarioEvidence: readonly [
  executedRounds: number,
  satisfiedSteps: number,
  schemaMask: number,
  nameMask: number,
  argMask: number,
][];
```

Bit 0/1/2 of each mask is the first/second/third planned transition. Because
success is prerequisite-gated, the satisfied steps are always the leading prefix
and a COUNT fully describes them. No tool name is persisted; the ledger carries
only counts and bitmasks.

Semantic validation still runs against the freshly built, fingerprint-bound
`EvalCorpusProjection` BEFORE any credential read or network I/O, and now also
fails closed when: the ledger length disagrees with the committed multi-step
count; an executed-round element falls outside its CORRESPONDING case's
`[1, rounds.length]`; `satisfiedSteps` falls outside `0..plannedSteps`; a mask
carries a bit outside that case's planned step count; a mask omits a bit of the
satisfied prefix (a successful transition necessarily proves schema, name, and
argument evidence for its step); a checkpoint's aggregate numerator disagrees
with the mask popcounts (single-round contributions stay derived from the
diagnostic reason table, multi-step contributions are the popcounts); a terminal
diagnostic's expected/final SCOPE disagrees with the satisfied state; a
diagnostic references a round beyond the scenario's executed count; a
diagnostic-free scenario lacks every transition, lacks full masks, or could not
have reached a final-answer round; a failed scenario is represented as
successful; or cleanup, cursor, counter, or resume ceilings disagree. A
diagnostic-free SUCCESSFUL scenario is explicitly allowed to use fewer than four
rounds when parallel calls completed multiple transitions. A
`scenario-round-budget-exhausted` diagnostic is rejected outright on a
single-round case. Every other checkpoint protection is unchanged: the private
fixed path, trusted-base ancestry validation, exact `0700`/`0600` modes,
`O_NOFOLLOW`, atomic temp/write/fsync/rename, blocked tombstones, value-free
records, and the existing `MAX_CHECKPOINT_BYTES` of 8192 (the worst valid
diagnostic ledger plus the 20-entry evidence ledger still fits, and the cap was
NOT raised).

**Corpus/engine preflight guard (normative).** The engine evaluates a FIXED
ordered workflow while checkpoint validation derives each case's planned step
count from its own rounds, so a corpus that disagreed with the engine could let
a truthful run persist evidence its own validator rejects. Both live evaluators
therefore call one shared guard ONCE per run, BEFORE any credential read or
network I/O. The guard validates the EXACT ORDERED WORKFLOW, not merely the
count: every multi-step case's ordered sequence of declared expected tools must
equal the engine's `read → edit → test` exactly — same length, same tool at
every position, with no substituted, duplicated, or reordered transition.
Counting alone would accept a corpus declaring `read → test → edit` and let the
fingerprinted planned workflow diverge silently from executed semantics.
Single-round cases are unaffected. The failure is value-free: it names no tool,
prompt, argument, path, or supplied value. The guard deliberately does NOT live
inside `buildEvalCorpusProjection`, because that builder is also used standalone
by hermetic tests that must keep exercising non-uniform structural corpora.

**Terminal checkpoint ordering (normative, and now identical to §30.1).** A
resumable release checkpoint may NEVER encode a complete-corpus cursor. The
resumable validator rejects `nextCaseIndex === corpus length` by design — a
genuinely complete run REMOVES its checkpoint rather than resuming one — so
writing one would leave a file the next `--resume-approved` invocation refuses
as inconsistent. Therefore:

- a NON-final case commit persists the advanced resumable checkpoint and then
  emits its progress record as usual;
- the FINAL case's commit is kept in memory. The runner writes no checkpoint and
  emits no progress record claiming a durable write for it, and enters the
  finalization state machine directly. Successful finalization still reports the
  in-memory COMPLETE cursor and removes the previous durable checkpoint.

The guard is enforced in ONE shared commit path used by BOTH the single-round
and multi-step branches, so the invariant cannot drift between them whichever
kind of case a corpus ends with (the production corpus ends with a multi-step
scenario). The last durable checkpoint therefore always remains
validator-accepted and points at the final, still-uncommitted case; if the
process stops before finalization succeeds, an approved resume safely replays
exactly that one case, adds no duplicate committed diagnostic or evidence, and
keeps cleanup accounting truthful.

Report v5 and checkpoint v4 are covered by the hermetic suites AND have now been
**successfully exercised live**: the completed **2026-09-01 campaign** recorded
above is the first campaign scored under them, and it exercised both the cleaned
resumable-interruption path (a checkpointed segment-1 abort) and successful
checkpoint finalization. No production prompt, parser, selector, threshold,
corpus size, model default, or model configuration changed in order to reach that
result — only the evaluator's accounting did. Section 30's numerical release
gates are therefore **met** by that campaign, the last scored campaign is the
2026-09-01 report-v5 campaign, and emulated tool mode is on that evidence
**supported opt-in beta: still non-default, still OpenCode permission-gated, and
still not production-ready** (see the graduation decision at the top of this
section). Any further live run is a separate, approval-gated decision.

### 30.1 Multi-step transition diagnostic (`npm run eval:tools:diagnose`)

The completed 2026-08-31 report-v4 campaign localized every multi-step failure
to one shape: a multi-step scenario, at round 2 (the `edit` step that follows a
successful `read`), under `tool_choice: auto`, producing a VALID, ALLOWED tool
call that omitted the expected tool — reason `expected-tool-not-invoked`. The
release report is value-free by construction, so it **cannot** distinguish
whether the model repeated an already-completed tool, skipped ahead to a later
tool, returned a mixture of both, selected some other allowed tool, or produced
multiple calls. This section defines a SEPARATE, approval-gated, multi-step-only
diagnostic that collects exactly that missing evidence.

**It establishes NO release gate.** Its output carries no threshold, no gate
collection, and no `passed` field. It does not alter any section-30 threshold,
denominator, corpus, or gate accounting, and no production prompt, tool parser,
candidate selector, request normalization, model default, model configuration,
OpenCode configuration, or public HTTP route may be changed by adding it. A
diagnostic result is evidence for a later, separately approved decision — never
a release claim. Every live invocation is separately approval-gated.

**Completed live diagnostic run (report v2 — HISTORICAL).** One authorized live
run completed cleanly under the v2 (invocation-history) classifier, in sanitized
value-free form:

- **20/20 scenarios observed**; **54 upstream rounds attempted and 54
  completed**; **54/54 created threads deleted**, zero remaining.
- **Zero cleanup failures and zero recovery-journal failures**; the journal was
  finalized once; the diagnostic checkpoint was finalized (removed); **no
  operational abort**.
- **7 scenarios followed the static schedule** and produced no transition
  diagnostic.
- **13 scenarios failed at round 2**, every one of them with reason
  `expected-tool-not-invoked`, relation `expected-already-invoked`,
  `selectionSource: desired-source`, and `callMultiplicity: single`.

**What it established, and what it did not.** The uniform
`expected-already-invoked` classification is direct evidence that the static
round-2 `edit` expectation was **stale**: an accepted earlier PARALLEL batch had
already invoked `edit` and the model had correctly moved on, so the release
evaluator was recording an accounting artifact rather than a model failure. That
is what motivated the state-aware engine in section 30 above.

It did **not**, however, prove that all 13 of those `edit` executions
**succeeded**. The v2 relation is INVOCATION-aware: it records that a name was
called in an accepted round, not that the call's arguments satisfied the
transition. A call can be accepted (correctly named, allowed, schema-valid,
transcript-linkable) and still fail semantically — a wrong `path` or `text`
leaves the document unchanged. That gap is exactly why the v3 classifier and the
release evaluator both moved to SUCCESSFUL transitions rather than names alone.
This run establishes no section-30 gate, identifies no definitive provider,
model, prompt, parser, or selector root cause, and remains a single sanitized
observation.

**Diagnostic report v3 / checkpoint v3 (implemented offline; the v3 live path
has NOT been run).** The diagnostic now consumes the SAME shared state-aware
transition engine as the release evaluator (`src/eval/scenario-engine.ts`), so
the two cannot drift:

- A scenario's expectation is the next UNSATISFIED transition. The observed
  pattern — an accepted `[read, edit]` batch followed by `test` — now continues
  successfully instead of reporting `expected-tool-not-invoked`.
- Prior/future classification uses SUCCESSFULLY COMPLETED transitions, not
  invoked names. A tool that ran but whose transition failed does not read as
  finished work.
- `expected-already-invoked` is **REMOVED** from the v3 `AllowedCallRelation`
  union and from the accepted ledger code map (code `7` is no longer decoded).
  A state-aware expectation can never name an already-satisfied transition, so
  the member is unreachable by construction. It is preserved here ONLY as the
  historical v2 live evidence recorded above. Codes 1–6 keep their v1/v2
  meaning, and the remaining relation categories and their deterministic
  precedence are unchanged.
- The diagnostic checkpoint persists a per-committed-scenario
  `scenarioEvidence` tuple `[executedRounds, satisfiedSteps]` — enough
  content-free evidence to validate `successfulScenarios`, an early (fewer than
  four round) success, terminal diagnostics, cursor state, and the round
  counters. A terminal diagnostic's scope must agree with the SATISFIED STATE
  rather than the round's positional disposition, and a diagnostic-free
  scenario must have every transition satisfied plus room for a final-answer
  round.
- `DIAGNOSTIC_REPORT_VERSION` is `3` and
  `DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION` is `3`. **Diagnostic checkpoint formats
  1 AND 2 are rejected** with no migration path, before any credential access or
  network I/O. Diagnostic versions still move INDEPENDENTLY of the release
  evaluator's report v5 / checkpoint v4.
- The command remains **non-gating**: no thresholds, no gate collection, no
  `passed` field, only `completed`, and complete separation from the release
  checkpoint is preserved.

**Scope and bounds (normative).**

- Runs ONLY the multi-step scenarios, at their GLOBAL corpus ordinals **201–220**
  (20 scenarios). The 200 single-round cases are never executed.
- MAXIMUM **80** upstream completions (20 × 4) per segment. This is an UPPER
  BOUND: truthful early termination at the first terminal failure means an actual
  run attempts strictly fewer.
- Fixed origin `https://api.prod.collectiviq.ai` (a module constant, never
  injectable) and **password auth only**.
- Preserves the report-v4 agent-loop semantics exactly: ONE initial user message,
  history accumulated only through the accepted assistant `tool_calls` message
  and exactly linked `role: "tool"` synthetic result messages, deterministic
  content-safe synthetic results, and termination at the first terminal failure
  with no fabricated cascade diagnostics.
- Creates at most ONE thread per attempted round and deletes it immediately,
  reusing the ID-only recovery journal and the shared create → journal → submit →
  poll → delete lifecycle (`src/eval/live-round.ts`) that the release evaluator
  also uses, so the two cannot drift.
- Reuses the release evaluator's own failure classifier, so terminal-failure
  precedence is identical to the behavior being explained.

**Approvals.** The DEFAULT invocation is a credential-free, network-free
preflight that reads no credential, initializes no journal, inspects or creates
no checkpoint, and opens no socket. Live execution requires ALL of
`--execute-approved`, `--cost-approved`, `--cleanup-approved`, and
`--recovery-journal-approved`; an existing diagnostic checkpoint additionally
requires `--resume-approved`. Every unknown argument is rejected. The command is
network-only and must **never** be added to `validate` or CI.

**Classification contract.** Each terminal failure emits the release report's
safe structural identity (`caseOrdinal` — the GLOBAL 201–220 ordinal —
`roundOrdinal`, `choiceKind`, and the closed `EvalFailureReason`) plus three
CLOSED, value-free dimensions:

```ts
type AllowedCallRelation =        // v3: `expected-already-invoked` REMOVED
  | "prior-only"        // every selected call's transition already SUCCEEDED
  | "future-only"       // every selected call is a LATER unsatisfied transition
  | "prior-and-future"  // both, with no unrelated allowed tool
  | "other-allowed"     // only allowed tools outside completed and remaining steps
  | "mixed-other"       // an unrelated allowed tool plus a prior/future one
  | "not-applicable";

type DiagnosticSelectionSource =
  | "desired-source" | "individual-single" | "individual-consensus" | "not-applicable";

type DiagnosticCallMultiplicity = "single" | "multiple" | "not-applicable";
```

**`allowedCallRelation` is TRANSITION-aware, not position-aware and not merely
invocation-aware.** The round request enables parallel tool calls, so ONE
accepted round can invoke several tools: a round 1 that returns `[read, edit]`
executes both. Judging the relation by planned round position would report a
model that correctly proceeds to `test` as `future-only` — a fabricated
skip-ahead in the one command whose purpose is diagnostic accuracy. Judging it by
invoked NAMES (the v2 rule) fixes that but over-credits, because a call can be
accepted and still fail semantically. The v3 relation is therefore derived from
the transitions that SUCCESSFULLY completed, read from the shared engine's
scenario-local state (tool names never emitted, logged, or persisted).

Required precedence:

1. Reason applicability: a reason that cannot carry a relation is
   `not-applicable`, as is a missing/empty call set or a set containing a name
   outside the allowlist.
2. Per-name bucketing: the CURRENT expected tool (the head of the pending
   transitions) being present ⇒ `not-applicable`; a tool whose transition
   already SUCCEEDED ⇒ `prior`; a tool whose transition has not succeeded and
   comes AFTER the pending one ⇒ `future`; anything else allowed ⇒ `other`.
3. Combine as the member list above describes.

There is no stale-expectation step, because a state-aware expectation is always
the next UNSATISFIED transition and can never name a completed one. The
transition state is scenario-local and discarded when the scenario ends, and it
affects ONLY diagnostic classification: it changes no release-evaluator scoring,
no tool execution, and no upstream behavior.

A scenario view that does not describe the whole workflow exactly once — a wrong
total, a duplicate, or an overlap between the completed and pending sets — fails
closed rather than returning a confident wrong answer. A diagnostic whose reason
is `expected-tool-not-invoked` MUST carry a
non-`not-applicable` relation; an expected-tool-present failure such as
`transcript-invalid`, and an `unauthorized-tool-call`, MUST use
`not-applicable`. `selectionSource` is carried from the trusted selector result
and never names an upstream model or answer source. `callMultiplicity` buckets the
selected call count; exact counts beyond the bucket are never emitted. The reason
⇄ dimension contract is enforced on both construction and persistence, so an
inconsistent diagnostic can neither be emitted nor stored.

**Output contract.** An INDEPENDENT version-`3` union (`preflight | progress |
blocked | executed`), unrelated to `EVAL_REPORT_VERSION` — a diagnostic bump must
never imply a release bump. Version 3 adopts the shared state-aware transition
engine and REMOVES the v2 relation member `expected-already-invoked` (ledger code
`7` is no longer decoded; codes 1–6 keep their v1/v2 meaning). Every record
carries `version: 3`, `profile: "multi-step-transition"`, the fixed origin, and
`authMode: "password"`. Preflight reports the planned scenarios, the global
ordinal range, the upstream-round upper bound, the required and supplied
approvals, and the resume-approved state. Progress is emitted ONLY after a
durable diagnostic-checkpoint write and carries only bounded counters, global
case/round ordinals, cleanup totals, the run segment, and
`checkpointPersisted: true`. The `executed` report carries the planned scenarios
and upper-bound rounds, attempted/completed rounds, completed/successful scenario
counts, the bounded failure diagnostics, cleanup totals, the value-free
password-auth observation, the separate diagnostic checkpoint state, closed abort
metadata, and `completed: boolean`.

`completed` is true ONLY when all 20 scenarios were observed, no operational
abort remains, every created thread was confirmed deleted, no recovery-journal
failure remains, journal finalization succeeded, and the diagnostic checkpoint
was removed successfully. **Exit zero when `completed` is true, even when model
transition failures were observed** — those failures are the evidence the command
exists to gather. Exit non-zero for blocking conditions, operational aborts,
cleanup/journal failures, and checkpoint persistence/finalization failures.

**Separate checkpoint.** Resume uses a DISTINCT format-version-`3` checkpoint at
the ignored `.agent/sessions/eval/tools-multi-step-diagnostic-checkpoint.json`,
owned by a self-contained module that hard-codes its own filename and references
nothing from the release checkpoint, so the command structurally CANNOT read,
overwrite, finalize, or remove the release evaluator's checkpoint. There is no
migration path, and **format-1 AND format-2 checkpoints are REJECTED** before any
credential access or network I/O: their persisted relation codes and round counts
were derived under position-based (v1) or invocation-history (v2) rules, so
replaying them under v3's transition-aware accounting would mix incompatible
classifications. A resumed run must start from a fresh anchor. It is bound to the
fixed origin, auth mode, and profile plus the fingerprint of the corpus, which is
built EXACTLY ONCE per run — the multi-step slice, its fingerprint, its
projection, and the execution loop all derive from that one value. It stores only
bounded counters, cleanup truth, closed abort state, a per-committed-scenario
`scenarioEvidence` tuple `[executedRounds, satisfiedSteps]`, and diagnostics
persisted as a fixed integer tuple `[caseOrdinal, roundOrdinal, reasonCode,
relationCode, sourceCode, multiplicityCode]`. Every code and tuple is validated
against the actual fingerprint-bound scenario and round BEFORE any credential
access or network I/O; a corrupt, incompatible, blocked, out-of-range,
semantically impossible, or wrong-profile checkpoint is rejected there. A
committed scenario may carry at most ONE terminal diagnostic, at exactly its
executed-round count, and its reason SCOPE must agree with the scenario's
satisfied state; a diagnostic-free scenario must have every transition satisfied
and room for a final-answer round, which a parallel batch may reach in fewer
than four rounds. A mid-scenario interruption restarts that scenario on resume
and already committed scenarios are never replayed. The recovery journal is finalized exactly once, and
the durable ordering is preserved: round completion → cleanup → journal
finalization where terminal → checkpoint persistence/finalization → progress →
final report. A safe complete execution deletes ONLY the diagnostic checkpoint; a
non-resumable failure persists a diagnostic `blocked` tombstone.

**Terminal checkpoint ordering (normative).** A resumable diagnostic checkpoint
may NEVER encode a complete-corpus cursor. The resumable validator rejects that
cursor by design — a genuinely complete run REMOVES its checkpoint rather than
resuming it — so writing one would leave a file the next `--resume-approved`
invocation refuses as inconsistent. Therefore:

- a NON-final scenario commit persists the advanced resumable checkpoint and then
  emits its progress record as usual;
- the FINAL scenario's commit is kept in memory. The runner does not write
  `nextScenarioIndex === scenarios.length`, emits no progress record claiming a
  resumable checkpoint was persisted for it, and enters the finalization state
  machine directly. The guard is enforced in code, not merely by call-site
  discipline: an attempt to persist a resumable complete-corpus cursor fails
  closed.

The last durable checkpoint therefore always remains validator-accepted and
points at the final, still-uncommitted scenario. If the process stops before
finalization succeeds, an approved resume safely replays exactly that one
scenario, adds no duplicate committed diagnostic, and keeps cleanup accounting
truthful (every counted attempt was confirmed deleted). Successful finalization
still finalizes the journal exactly once, removes only the diagnostic checkpoint,
emits the final executed report, and exits according to `completed`; a
finalization failure may still persist the deliberate non-resumable `blocked`
tombstone, which is not subject to the resumable-cursor rule.

**Privacy.** The command, its output, its logs, its checkpoint, its tests, and
its documentation must never contain prompt or answer text, tool names, tool
arguments or schemas, model/source identifiers, thread/run/message/session ids,
credentials, titles, request/response bodies, URLs other than the fixed public
origin in the report, timestamps, or arbitrary exception text. Synthetic scenario
definitions stay in source and are never emitted or persisted. The relation
classifier reads tool names in-process and returns only a closed enum.

**Current release status (owned by section 30, restated here only as the
section's closing status).** The numerical section-30 gates are **MET** by the
completed **2026-09-01 report-v5 campaign** — the fifth authorized campaign and
the first scored under the state-aware report-v5 / checkpoint-v4 evaluator — which
scored the full corpus across two resumable execution segments with all eight
gates passing and overall `passed: true`. Section 30 above owns the complete
accounting; do not re-derive it here. The earlier **2026-08-31 report-v4
campaign** (six of eight gates passing, `passed: false`, six
`expected-tool-not-invoked` diagnostics at multi-step round 2 under an `auto`
choice) is **historical evidence** and is no longer the operative campaign: the
live v2 transition diagnostic recorded in this section, and the state-aware
correction it motivated, showed those round-2 failures were scored against stale
positional expectations. Only the EVALUATOR's accounting changed between the two
campaigns — no production prompt, parser, selector, threshold, model default, or
model configuration was altered to reach the passing result. Do not mark any gate
passed without reproducible evidence from the required live suites, and do not
present a single passing campaign as repeatability, production readiness, or a
cross-account guarantee.

The diagnostic's own **report v3 / checkpoint v3** path, described above, is
implemented offline, passes its hermetic coverage, and **has NOT been run live**;
only the historical v2 run recorded in this section exists. It establishes **no**
release gate either way.

**Phase 3 is supported opt-in beta: still non-default and still OpenCode
permission-gated.** Section 30 owns that graduation decision. Beta is not
production readiness, and enabling tool mode by default remains a separate,
approved decision taken only after the Phase 4 controls.

If the thresholds are not met, the gateway may still expose:

```text
collectiviq-consensus
```

as a text-only planning and review model, but it must not claim full OpenCode agent functionality.

---

## 31. Deployment

## 31.1 Local Docker deployment

```yaml
services:
  collectiviq-gateway:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      HOST: "0.0.0.0"
      PORT: "8787"
      COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai"
      COLLECTIVIQ_API_KEY: "${COLLECTIVIQ_API_KEY}"
      COLLECTIVIQ_GATEWAY_KEYS: "${COLLECTIVIQ_GATEWAY_KEY}"
      MODEL_CONFIG_PATH: "/app/config/models.yaml"
      LOG_CONTENT: "false"
    volumes:
      - "./config/models.yaml:/app/config/models.yaml:ro"
```

The container may listen on `0.0.0.0` internally because Docker publishes it only to host loopback.

The committed `compose.yaml` additionally passes `OPENCODE_THREAD_REUSE_ENABLED`
(default `false`) and `OPENCODE_THREAD_REUSE_TTL_MS` (default 7 days) for optional
thread reuse (section 5.1.1). Enabling reuse requires the same `redis` profile and
`REDIS_URL`/`IDEMPOTENCY_ENCRYPTION_KEY` as the other Redis-backed features, and
reuses that one connection under a `:reuse:` key category.

**Implementation status (Phase 4A, implemented).** The committed `compose.yaml`
adds an **opt-in** `redis` profile running
the pinned image `redis:8.8.2-alpine`, published only on `127.0.0.1:6379`, with
persistence disabled (`--save "" --appendonly no`) because idempotency records
are short-lived encrypted cache state. The gateway service has **no**
`depends_on` on it: the gateway must start and serve `/healthz` whether or not
Redis is running. No password is embedded in the committed file.

`REDIS_URL` is resolved by the gateway PROCESS, so the two local setups use
different hosts: with the gateway running natively, start only the Redis service
(`docker compose --profile redis up -d redis`) and use
`redis://127.0.0.1:6379`; with both services in Compose, use the Redis service
hostname (`REDIS_URL=redis://redis:6379 docker compose --profile redis up
--build`), because inside the gateway container `127.0.0.1` is that container.
Local Compose does NOT satisfy production requirements; see section 31.2.

### 31.2 Hosted deployment

Required controls:

* HTTPS;
* managed secret storage;
* private network access where possible;
* authentication;
* per-user rate limits;
* centralized logs with content redaction;
* Prometheus metrics;
* health checks;
* at least two replicas if availability is required;
* Redis for cross-replica idempotency and concurrency accounting.

Sticky sessions are not required. Requests are stateless by default, and the one
exception — optional OpenCode thread reuse (section 5.1.1) — keeps its
session-to-thread mapping in the SHARED Redis rather than in a replica, which is
exactly why enabling it requires a Redis endpoint. Any replica can therefore serve
any turn of a session, provided every replica shares the same Redis endpoint,
encryption key, `REDIS_KEY_PREFIX`, gateway-key set, upstream credentials, origin,
and model configuration.

**Redis requirements when idempotency is enabled (Phase 4A).** Beyond the
application-layer `IDEMPOTENCY_ENCRYPTION_KEY`, a hosted Redis must have:

* network isolation — a private subnet/VPC or equivalent, never a public endpoint;
* Redis ACL/authentication with a managed secret, never a committed password;
* TLS (`rediss://`) wherever the endpoint is not on a trusted private link;
* `maxmemory-policy noeviction` (or headroom such that eviction never occurs) —
  see section 18.1; an evicted active or final record silently breaks the
  guarantee;
* the SAME `IDEMPOTENCY_ENCRYPTION_KEY`, `REDIS_KEY_PREFIX`, Redis endpoint,
  `COLLECTIVIQ_GATEWAY_KEYS`, and MODEL CONFIGURATION on EVERY replica. Mixed
  encryption keys during a rolling deployment are unsupported: a replica with a
  different key computes different storage keys and cannot read the other
  replicas' records. Divergent model configuration is worse — the storage key
  does not cover the resolved model policy, so replicas would treat answers
  produced under different policies as interchangeable. Rotating the key
  requires draining traffic and waiting at least one maximum
  `IDEMPOTENCY_TTL_MS`.

Persistence and backups are not required for this state (section 22.2).

**Redis requirements when rate limiting is enabled (Phase 4B).** The same
controls apply, plus: `RATE_LIMIT_ENABLED=true` requires `REDIS_URL` (and
therefore the encryption key, from which a separate rate-limit subkey is
derived), and every replica must additionally share IDENTICAL `RATE_LIMIT_*`
settings. `noeviction` matters here too — an evicted quota key resets that key's
allowance to a full burst. A Redis outage fails the completion path closed with
`503 rate_limit_unavailable`, so enabling this feature trades availability for
correctness; size and monitor the endpoint accordingly. One Redis backs both
features and the gateway opens ONE connection for them (section 19.1).

**Redis requirements when shared capacity is enabled (Phase 4D).** The same
controls apply, plus: `SHARED_CAPACITY_ENABLED=true` requires `REDIS_URL` (and
therefore the encryption key, from which a separate capacity subkey is derived),
and every replica must additionally share an IDENTICAL flag value AND identical
`MAX_CONCURRENT_REQUESTS` / `MAX_CONCURRENT_REQUESTS_PER_KEY`. **Enabling it,
disabling it, or changing either limit requires a coordinated drain and restart**;
mixed local/shared rolling operation is unsupported, because while some replicas
enforce the limit locally and others share it the effective limit is neither the
configured value nor a predictable multiple of it. `noeviction` matters most
here: an evicted registry key forgets every live permit at once, so the cluster
can briefly over-admit up to the configured limit per replica. A Redis outage
fails the completion path closed with `503 capacity_unavailable`, the same
availability-for-correctness trade as rate limiting. The registry holds only
lease state, so persistence and backups stay unnecessary (section 22.2). One
Redis still backs every enabled feature over ONE connection (section 19.2).

Redis now gives cross-replica **idempotency** (Phase 4A), cross-replica **rate
limiting** (Phase 4B), optional cross-replica **active-capacity accounting**
(Phase 4D, section 19.2), and optional **OpenCode thread reuse** (Phase 5A,
section 5.1.1) — all over ONE connection, each off by default.

**Metrics exposure when `METRICS_ENABLED=true` (Phase 4C).** `GET /metrics` is
registered outside `/v1` and carries NO application authentication. That is a
deliberate decision (section 23.2): a scrape credential would be a second secret
to distribute and rotate, and the process cannot verify whether the interface it
is bound to is private. Operators MUST therefore isolate the endpoint
themselves — bind to loopback and scrape locally, expose it only on a private
network or subnet, or firewall it to the scraper — and MUST NOT publish it on a
public listener. The exposition carries no prompt, answer, path, tool,
credential, or identifier, but it does disclose traffic volumes, latencies,
error categories, and the configured virtual-model ids. With
`METRICS_ENABLED=false` (the default) the route does not exist at all.

**Tracing egress when `TRACING_ENABLED=true` (Phase 4C).** The gateway becomes an
OTLP/HTTP client of `TRACING_OTLP_ENDPOINT` and will send spans to it
continuously. Treat that endpoint as a trust boundary: prefer a collector on a
private network, use `https://` wherever the link is not private, and remember
that the gateway sends no exporter authentication header (none is configurable
in this slice), so the collector must be reachable only from the gateway's own
network. With `TRACING_ENABLED=false` (the default) no exporter exists and no
connection is ever attempted.

### 31.3 Graceful shutdown

On `SIGTERM`:

1. stop accepting new requests;
2. mark readiness false;
3. allow active requests a configurable drain period;
4. cancel remaining polling operations;
5. close Redis and metrics resources;
6. exit.

Default drain period:

```text
30 seconds
```

**Implementation status (Phase 4A, implemented).** The sequence is: latch
readiness not-ready → close admission → allow `SHUTDOWN_DRAIN_MS`, then abort the
shared in-flight signal → `app.close()` → and only THEN close Redis. Redis stays
available for the whole drain so an in-flight completion can still commit or
settle (`ambiguous`) its idempotency record. The Redis close is a bounded
graceful close with a force-destroy fallback, so shutdown can never hang on a
half-open socket. Default `buildServer`, the test suites, and the compiled-import
smoke test remain socket-free: the Redis client is created without connecting and
only the process composition root calls `connect()`.

**Implementation status (Phase 4B, implemented).** The sequence is unchanged.
Because the Redis composition root owns exactly one client, the shutdown closes
ONE connection, last and exactly once, whichever Redis-backed features are
enabled. `buildServer` still builds only the pure, socket-free scope derivers and
never creates a client.

**Implementation status (Phase 4C, implemented).** Telemetry joins Redis in the
SAME final bounded dependency-close step, after the application has drained, so
an in-flight completion can still export its final spans while requests wind
down. Redis closes first, then — only when tracing is actually ENABLED — the
tracing provider flushes and shuts down under its own fixed 2 s budget. A
disabled port is skipped outright rather than delegated to a no-op `shutdown()`,
so "disabled means uncalled" holds at shutdown exactly as it does on the request
path. That close is non-rejecting by contract and its timer
is `unref`'d, so an unreachable collector can neither hang shutdown nor surface
dynamic exception text; a failure is routed to the same content-free error sink
as a `close()` failure. `buildServer` may build the (pure, socket-free)
Prometheus registry, but only the process composition root constructs and closes
the OTLP exporter.

**Implementation status (Phase 4D, implemented).** The sequence is unchanged
again, and the order matters more with shared capacity enabled: step 1's
`closeAdmission()` runs on whichever controller is ACTIVE, so queued and pending
waiters resolve to the existing `429` and any grant Redis confirms after that
point is handed straight back. Because Redis still closes LAST, a permit released
during the drain reaches the registry rather than waiting out its lease. Nothing
about shared capacity can delay shutdown: there is no heartbeat to stop, no
renewal timer beyond an `unref`'d retry timer, and a release issued while Redis is
already closing simply fails and lets the lease expire. `buildServer` still
creates no client, so a server built without the process root's wiring holds no
shared permits to return.

---

## 32. Delivery Phases

### Phase 0 — CollectivIQ contract discovery

Deliverables:

* capture actual endpoint status codes;
* capture sanitized response fixtures;
* determine error schemas;
* determine prompt-size limits;
* determine rate limits;
* verify whether threads can be deleted;
* verify SSE correlation fields;
* verify whether native tools exist;
* verify whether selected models vary by account.

Exit criterion:

* upstream adapter contract tests reflect real responses.

Current status (four authorized live baselines ran — two 2026-08-06/07 bearer
runs failed strict completeness and two 2026-08-11 `password` runs both passed;
the core create/submit/messages contract and password `POST /login` are now
verified-repeatable, while the deliverables listed above remain partly open, so
Phase 0 is not declared complete): the OpenAPI-grounded adapter boundary
(`src/collectiviq/`), the shared dual-mode credential provider (`auth.ts`: static
`bearer` plus the OAuth2 `password`/`POST /login` mode, whose login is now
**verified-live**), the shared
request builders (`requests.ts`) reused by production and discovery, the filtered
contract snapshot of **ten** allowlisted operations
(`contract/collectiviq/openapi-filtered.json`), the hermetic
mock-server contract tests (`test/contract/`), and the opt-in discovery
session/CLI exist and pass `validate`. The staged discovery session captures
evidence from the **raw** upstream body (any status) via a discovery-only
observation path — so run ids and error shapes survive as value-free sanitized
structure (`evidenceFormatVersion` 2) — retains correlation ids only in private
memory (emitted solely as a `matched`/`not-matched`/`not-observed` comparison; no
capability flag is auto-flipped), keeps a truthful cleanup ledger, gates every
destructive delete on explicit approval, and exits on strict session
completeness. None of it is wired into any public completion path.

On 2026-08-06 an explicitly approved authenticated `baseline` run was executed
once and **exited non-zero** (failed strict completeness). Its value-free
observed-once (not verified) facts: `create_thread` → `200` (numeric
`thread_id`); `process_message` → `202` with `thread_id`/`combined_run_id`/
`status`/`has_rag_files` and no `detail` (a run identifier is present; the
`status` meaning and accepted-vs-failed semantics are unknown; idempotency
unresolved); `get_messages` → `200` (`messages` array accepted, but observed
`create_time`/`updated_at` diverged from the then-provisional `created_at`
mapping — later driving the reconciliation of `createdAt` to `create_time`);
empty-bearer auth probe `401` and
no-`thread_id` validation probe `400` (expected failures); authenticated
`/available_llms` → `403` (reason unknown, no causal claim); SSE `/user/events`
`200`/`text/event-stream` with thread+run correlation matched once (scope and
repeatability unknown); and cleanup where all three DELETEs failed leaving two
threads that the user then manually deleted (the old report did not capture delete
status, so no `403` claim and no claim that deletion works). A remediation has
since landed: value-free per-attempt cleanup diagnostics, a content-free recovery
journal, a recovery-only `contract:discovery:cleanup` command, and an
`available_llms` completeness policy that accepts a `403` as an observed
inventory-access restriction.

A **second** explicitly approved authenticated `baseline` run reached production
on 2026-08-07 and again **exited non-zero** (failed strict completeness),
distinct from the 2026-08-06 run. The core statuses/shapes and SSE thread+run
correlation repeated (corroboration, not verification). This time the remediated
cleanup diagnostics **observed `DELETE` returning HTTP `403`**, leaving two
recovery-journal-owned threads unresolved (identifiers never exposed; no causal
claim, and API thread deletion is still not confirmed to work). Dual-mode
password authentication was implemented offline but remained unverified for this
run (no live `POST /login` was performed).

On **2026-08-11** two explicitly approved authenticated `baseline` runs were
executed in **`password` mode** and **both exited zero** (each passed strict
completeness), with sanitized captures **identical across every safe contract
fact**. This makes the core contract **verified-repeatable**: password
`POST /login` works (`200`, normalizable `Bearer` token); `create_thread` `200`,
`process_message` `202` (with `combined_run_id`), `get_messages` `200` (metadata
field `create_time`, not the provisional `created_at`). Deletion and inventory
access were **credential/principal-dependent** (cause not established): the
password/member principal read `/available_llms` → `200` (the API-key principal
had returned `403`), deleted its own newly created thread → `200`, and re-deleting
that same just-deleted id → `403`. SSE thread+run correlation matched (scope still
unknown).
The verified-repeatable shapes were promoted into **synthetic** fixtures
(`processAccepted202`, `messagesCreateTime`) with contract tests, and the
`createdAt` mapping was reconciled to `create_time`. **No live value was
promoted**; the ignored live reports and recovery journal are not committed, and
capability flags remain `false`.

**Phase 0 text-readiness gate — satisfied.** The verified-repeatable
login/create/submit/messages contract is **sufficient to enter Phase 1
conservative text development**. This is a scoped entry gate, not a declaration
that every upstream question is resolved or that the gateway is production-ready.
The remaining open questions are **non-blocking** under the conservative
Phase 1 safeguards:

* `create_thread` and `process_message` are never automatically retried, so
  unresolved POST idempotency cannot silently duplicate upstream work.
* Each public completion uses a **fresh** upstream thread, so correct operation
  does not rely on unverified thread reuse, and Phase 1 request execution
  requires no thread-deletion call. (Phase 5A later added OPTIONAL, off-by-default
  reuse for eligible direct-prompt requests — section 5.1.1 — which still requires
  no deletion call and still does not rely on the unresolved ordering/pagination
  questions.) This does **not** reduce provider-side data
  exposure: prompts and answers still cross into CollectivIQ-managed threads, and
  provider retention, training, deletion guarantees, and regional controls remain
  **unknown** — they are production/provider-confirmation gates, not request-path
  safeguards.
* The gateway assumes **no** message ordering; duplicate desired-source messages
  use the documented deterministic timestamp → sortable-id → array-position
  fallback (section 8.6/8.7).
* Pagination is not required while each request uses a new thread and retrieves
  full history. This safeguard covers the DEFAULT stateless path only: the
  optional reuse path of section 5.1.1 reads a thread that grows with the
  session, so pagination becomes material there and is called out as that
  feature's weakest residual risk.
* Prompt-size limits remain a conservative **gateway** configuration bound
  (`maximumPromptBytes`), not a claimed upstream maximum.
* Password-token `401` invalidation plus next-request re-login allow correct
  operation without an implemented refresh endpoint.

Still **not** declared fully complete: idempotency and `process_message`
`status` semantics still prohibit retries and stronger status interpretation;
message ordering/pagination still gate any UNCONDITIONAL reliance on thread reuse
or on pagination (the optional Phase 5A reuse in section 5.1.1 ships without those
answers only because it refuses to depend on them, and degrades to a `504`
instead); rate/quota limits, retention/training/regional controls, and token
lifetime/refresh remain **production-hardening / provider-confirmation** gates;
native tools and structured tool results remain **Phase 3/5 capability** gates;
and SSE scope remains a **future true-streaming** gate. See the section 35 gap
matrix and [`collectiviq-upstream-contract.md`](collectiviq-upstream-contract.md).
No new live evidence is asserted by this classification.

### Phase 1 — Text gateway

Phase 1 is split into an offline **Phase 1A** (implemented) and **Phase 1B**,
whose offline implementation is also complete. A user-observed, sanitized live
OpenCode/CollectivIQ smoke result was reported on **2026-08-15**: the foreground
`collectiviq-claude` **transport** path worked (a response was returned, synthetic
streaming completed, OpenCode's attached tool metadata was accepted and discarded,
and no tool call was emitted or executed). However, the returned model response
**objected to the gateway's serialized protocol wrapper as embedded
identity/instruction manipulation** on that protocol-mode `collectiviq-claude`
path, so end-to-end **semantic** compatibility was **not** established there. The
prompt-serialization remediation — the `collectiviq-claude-direct` profile
(`promptMode: "direct"`, section 8.3/8.4; latest-user-only prompt with no protocol
wrapper) — is the committed OpenCode foreground/`small_model` default (section 25),
and a sanitized, user-authorized **2026-08-18** smoke **observed it succeed for the
tested account**: direct mode submitted only the latest user text, a natural
TypeScript coding request returned a relevant, correct answer, the foreground
OpenCode interaction produced no protocol objection / tool alert / tool call, and
the hidden `collectiviq-fast` title request returned a valid title on its first
attempt. The Phase 1 valid-answer / semantic exit criterion is therefore **met for
the tested account**. This is an observed single-account result, **not** a
repeatable upstream guarantee or production readiness: production hardening
(idempotency, retention/training/deletion confirmation, metrics/tracing,
rate/quota limits), combined answers, long-duration streaming, and generic
non-Claude foreground routing all **remain open**, so Phase 1 is not complete or
production-ready.

**Phase 1A — implemented (offline, no live CollectivIQ call):**

* `GET /v1/models` and `GET /v1/models/:model` (authenticated);
* gateway client authentication (`Authorization: Bearer <gateway-key>`,
  SHA-256 + `timingSafeEqual`, fixed `401` envelope);
* an immutable virtual-model catalog/resolver (exact-case, config-order,
  one captured `created` timestamp per server instance);
* shared bounded OpenAI error envelopes (`401`/`404`/`500`);
* Docker packaging (already present).

**Phase 1B — implemented (offline; the completion path calls CollectivIQ only
when a real request is served, never during import/construction):**

* the non-streamed JSON `POST /v1/chat/completions` path (authenticated),
  text-only, for `stream` absent/`false` (the `stream: true` synthetic-SSE path
  was added in Phase 2, below); deferred features (tools, `tool_choice`,
  `response_format`, `logprobs`, audio, images) rejected with stable content-free
  `400` envelopes;
* the CollectivIQ adapter wired into the request path — one **new** thread per
  completion, one `process_message`, then bounded polling of `get_messages`;
* deterministic versioned prompt serialization (`src/prompts/conversation.ts`),
  internal virtual-model policy resolution (`ModelCatalog.resolveModel`),
  process-local global + per-key capacity with a bounded queue/queue-wait
  (`src/generation/capacity.ts`), a total request deadline, client-disconnect +
  shutdown cancellation, safe GET-only poll retry with capped 1.25 backoff +
  jitter, desired-source message selection, the non-streamed OpenAI response
  encoder (zero/unavailable usage), and the graceful-shutdown drain
  (`SHUTDOWN_DRAIN_MS`);
* runtime upstream-credential composition from validated config (no env re-read;
  password logins are lazy and bounded per attempt, unbounded across the process
  lifetime);
* hermetic unit/integration/adapter-backed contract tests.

**Phase 1B — live observation (2026-08-15, foreground transport path):** the
foreground `collectiviq-claude` request was driven live from OpenCode and returned
a response; synthetic streaming completed; OpenCode's auto-attached tool metadata
did not trigger a "tools is not supported yet" alert and no tool call was emitted
(Phase 2 / 2.1 observations, below). This confirms the **transport, streaming, and
tool-bridge** objectives. On that date it did **not** confirm semantic
compatibility for the protocol-mode path: the returned model response objected to
the gateway's serialized protocol wrapper as embedded identity/instruction
manipulation. That refusal was subsequently **resolved for the tested account** by
the committed-default direct profile — see the **2026-08-18 live observation**
below. This is a user-observed, sanitized result; no prompt, answer, identifier,
credential, header, or account value is recorded. On 2026-08-15 a separate hidden
OpenCode title-generation request was also observed — at the time OpenCode invoked
it conditionally (a parentless/top-level session whose title was still the default,
around its first real user message) and it produced no title. That hidden LLM title
agent is now **disabled** in the committed `opencode.jsonc`; the
`collectiviq-native-title` plugin propagates the CollectivIQ native title via
`GET /v1/opencode/session-title` instead (sections 9.5 and 25) — a path found
non-functional in the 2026-08-21 smoke because the plugin entry module never loaded
(its bare-function default tripped OpenCode's legacy export scan with `Plugin export
is not a function`) and, after that loader fix, an environment-only key lookup; both
were fixed (V1 `{ id, server }` default module and provider-config credential reuse),
and a sanitized 2026-08-22 live smoke observed the complete path succeed for the
tested local configuration (a single-local-configuration observation, not a
production/cross-account/cross-version guarantee). This historical observation is
distinct from the foreground release gate.

**Phase 1B — live observation (2026-08-18, direct-mode foreground path):** a
sanitized, user-authorized smoke drove the committed-default
`collectiviq-claude-direct` (`promptMode: "direct"`) foreground path from OpenCode.
Direct mode submitted only the latest user text (no protocol wrapper in the
CollectivIQ UI); a natural TypeScript coding request returned a relevant, correct
answer; synthetic streaming completed with **no** protocol objection, tool alert,
or tool call; and the hidden `collectiviq-fast` title request returned a valid
title on its **first** attempt and updated the OpenCode session title. (That
title behavior is the now-**disabled** hidden-agent path and predates the
`collectiviq-native-title` plugin; it is not evidence that the current plugin
propagation path worked. That path was found non-functional on 2026-08-21 because
the plugin entry module never loaded (bare-function default rejected by OpenCode's
legacy export scan); both the loader and subsequent environment-only credential
issue were fixed, and a sanitized 2026-08-22 live smoke observed the complete
propagation path succeed for the tested local configuration (section 25).)
This meets
the Phase 1 valid-answer / semantic exit criterion **for the tested account** and
supersedes the 2026-08-15 protocol-wrapper refusal for this path. It is an observed
single-account result — **not** production readiness, a repeatable upstream
guarantee, combined-answer support, long-duration streaming, or general non-Claude
routing. Any further live run still requires separate explicit approval before live
CollectivIQ traffic. `stream:true` synthetic SSE is
implemented (Phase 2, below); tools stay in Phase 3; optional Redis-backed
idempotency is Phase 4A (section 18.1); optional metrics/tracing are Phase 4C
(sections 23.2 and 23.3) and are off by default, so they change nothing here
unless explicitly enabled;
upstream deletion is not performed, and Phase 1 itself performs no thread reuse
(the optional, off-by-default Phase 5A reuse in section 5.1.1 came later and
changes nothing here unless it is explicitly enabled).

Deliverables:

* `/v1/models`;
* non-streamed `/v1/chat/completions`;
* one thread per request (Phase 1 creates one unconditionally; the optional Phase 5A reuse of section 5.1.1 came later and may continue a session's thread instead);
* virtual-model configuration;
* polling;
* OpenAI error envelopes;
* authentication;
* Docker packaging;
* OpenCode text-mode smoke test.

Exit criterion (capability-aware):

* OpenCode can ask a question and receive a valid answer from a configured
  virtual model that is **supported by the active CollectivIQ account**.
  **Met for the tested account (2026-08-18):** the protocol-mode
  `collectiviq-claude` path had objected to the gateway's serialized protocol
  wrapper on 2026-08-15, but the committed-default `collectiviq-claude-direct`
  profile (`promptMode: "direct"`) was observed live on 2026-08-18 to return a
  relevant, correct answer to a natural coding request, complete synthetic
  streaming, and emit no protocol objection, tool alert, or tool call (the hidden
  `collectiviq-fast` title request also returned a valid title on its first
  attempt). This is a sanitized single-account observation, **not** a repeatable
  upstream guarantee or production readiness. A CollectivIQ *combined* answer
  additionally remains **conditional on account capability** and is **not
  verified** for this account (non-Claude routing is blocked account-side; see
  section 34.7), so a combined answer is not required to close this criterion, and
  long-duration streaming and generic non-Claude routing remain open.

### Phase 2 — Streaming compatibility

**Implemented (offline).** Text-only buffered synthetic SSE for
`POST /v1/chat/completions` with `stream: true` (see section 14):

* SSE `200`/`text/event-stream` response committed only after preparation
  succeeds (`src/api/chat-stream-response.ts`);
* an early assistant-role chunk emitted before any upstream work;
* `: collectiviq-gateway keep-alive` comments every 15 s while polling waits;
* deterministic, code-point-safe buffered text chunks
  (`src/openai/chat-stream.ts`) that concatenate back to the exact answer;
* one terminal chunk (`finish_reason: "stop"`) then `data: [DONE]`;
* backpressure-aware serialized writes, keep-alive timer cleanup, safe SSE error
  records (`data: {"error": …}` then `[DONE]`), a `503` record on shutdown while
  the client is connected **and the transport is writable** (an
  undrainable/failed-terminal transport is force-closed instead and may end
  silently), and client-disconnect cancellation that stops polling and releases
  capacity;
* hermetic streaming unit/integration/loopback tests, plus a separate hermetic
  `npm run test:compatibility` suite driving the pinned `ai` /
  `@ai-sdk/openai-compatible` SDK against an ephemeral loopback gateway with a
  fake completion (never CollectivIQ, no real credential, out of `validate`/CI).

Exit criterion:

* OpenCode completes long-running CollectivIQ requests without stream timeout.
  **Partially observed (2026-08-15):** a basic live synthetic-streaming request
  completed end-to-end from OpenCode. This does **not** close the criterion: the
  reported evidence does not establish a long-running duration exercising the 15 s
  keep-alive path, so the long-running / keep-alive timeout gate remains open and
  a dedicated long-duration streaming smoke test is still pending separate
  approval.

### Phase 2.1 — OpenCode text-compatibility bridge

**Implemented (offline).** A text-only compatibility bridge (NOT Phase 3 tool
calling) so text-only virtual models tolerate the tool metadata OpenCode attaches
automatically even when all tool permissions are denied:

* `tools`/`tool_choice` are validated by a model-policy-aware bridge after exact
  model resolution (`tools` first, then `tool_choice`); see section 9.4.4.
* For a `toolMode: "disabled"` model the bridge accepts a bounded `tools` array
  (≤ `MAX_TOOLS` = 128 entries AND ≤ `MAX_TOOL_SCHEMA_BYTES` = 2 MiB aggregate
  JSON, section 21.6) and a `tool_choice` of exactly `"auto"`/`"none"`, discards
  them (recording only the NAME in `X-CollectivIQ-Ignored-Parameters`), and never
  serializes, forwards, logs, reflects, persists, or executes them.
* A definition is traversed ONLY through data-property descriptors for a bounded,
  iterative (cycle- and depth-guarded) JSON-shape and byte accounting; accessors
  and executable hooks (getters, `toJSON`, iterators) are never invoked and
  descriptor/proxy failures fail closed.
* For a disabled model, tool CALLING stays off: `required`/named `tool_choice`; a
  non-array, over-count, or over-budget `tools`; an accessor, cycle,
  sparse/exotic/over-deep structure, or unsupported value anywhere; and any tool
  metadata against a `native` model (not implemented) are rejected with the stable
  `unsupported_parameter` `400`. An `emulated` model (supported opt-in beta,
  non-default) instead normalizes and retains the policy — see section 12.
* `collectiviq-claude-direct` (a Claude source with `promptMode: "direct"`, section
  8.3/8.4) is the committed OpenCode foreground/`small_model` default because
  non-Claude routing is blocked account-side (section 34.7) and the account
  objected to the protocol wrapper (Phase 1, above); the hidden LLM `title` agent
  is disabled (native-title propagation via the section 9.5 extension replaces it,
  see section 25). The tool-bridge behaviour is unchanged by prompt mode.
* Hermetic unit/integration/contract coverage plus the pinned-SDK compatibility
  suite (a real function tool + `toolChoice: "auto"` through streamed and
  non-streamed paths, asserting ordinary text, `finish_reason: "stop"`, and no
  tool call).

Exit criterion:

* OpenCode drives the gateway with its default tool-sending agent without a
  request being rejected for tool-field presence and without any tool call being
  emitted. **Met (2026-08-15):** in the live smoke result, OpenCode's
  auto-attached tool metadata was accepted and discarded, no "tools is not
  supported yet" alert occurred, and no tool call was emitted. Non-Claude
  execution remains blocked upstream (section 34.7), not by the gateway.

### Phase 3 — Emulated tool calling

Deliverables:

* tool prompt protocol;
* strict JSON parser;
* schema validation;
* individual-model fallback voting;
* tool-call streaming;
* multi-round OpenCode tests.

Exit criterion:

* tool-calling release thresholds are met or the feature remains explicitly
  experimental. **Met (2026-09-01):** the completed report-v5 campaign passed all
  eight section-30 gates with overall `passed: true`, and on that evidence the
  feature graduated from experimental to **supported opt-in beta** — non-default
  and OpenCode permission-gated. Beta is not production readiness; default
  enablement remains a separate decision after the Phase 4 controls. Section 30
  owns the canonical graduation decision.

**Implemented (offline; SUPPORTED OPT-IN BETA; live upstream only at request
time).** The emulated engine lives in `src/tools/` (`copy.ts` descriptor-safe bounded JSON
copy; `schema.ts` per-request Ajv compile that selects the meta-schema dialect
from each tool schema's ROOT `$schema` — **draft-07** is the default when
`$schema` is absent (or a boolean root), and **draft-07** and **draft 2020-12**
are each recognized by an exact URI allowlist (`http`/`https`, with and without a
trailing `#`); OpenCode 1.18.21 stamps its built-in tool schemas with draft
2020-12, so this compiles them offline, while a non-string or any other `$schema`
value fails closed — with no coercion/defaults/property-removal, no remote `$ref`,
and no cross-request retention; `protocol.ts` the strict §12.2 parser;
`select.ts` the §12.3 desired-source → individual-consensus voting with
percent-usage/agreement scoring and configured-order tie-breaks; `ids.ts`
`call_ciq_<ULID>`; `request.ts` normalization + prior tool-history linkage/schema
validation; `limits.ts` the §21.6 bounds). Pinned deps `ajv` 8.20.0,
`ajv-formats` 3.0.1, `ulid` 2.4.0. The request boundary retains and validates the
tool policy for a `toolMode: "emulated"` model (which REQUIRES
`promptMode: "protocol"`, enforced at config load); `conversation.ts` adds the
`tool-or-final` protocol + `AVAILABLE_TOOLS_JSON` block when tools are active (the
text-only prompt is byte-for-byte unchanged); polling returns the validated
message snapshot; the completion layer returns a discriminated text-or-tool-calls
result; and the JSON and synthetic-SSE encoders emit `tool_calls` with
`finish_reason: "tool_calls"` and no `usage`. The gateway returns model-PROPOSED
calls and NEVER executes, authorizes, or simulates a tool; OpenCode owns
permissions and execution. Each tool-loop round creates a new upstream thread. The
opt-in `collectiviq-claude-tools` model is the single tool-enabled virtual model,
and `opencode.jsonc` exposes it through two functional, behaviorally identical
tool-enabled agent entries (wildcard `"ask"`): the canonical
`collectiviq-tools-beta` and the deprecated `collectiviq-tools-experimental`
compatibility alias retained through Phase 4. Every committed default stays
`toolMode: "disabled"` and selects neither agent. Hermetic unit/integration/contract/
compatibility/adversarial suites pass (see §29–30 status notes). The
approval-gated live evaluator (`npm run eval:tools`, implemented under
`src/eval/`) has been run in five authorized campaigns. The state-aware report-v5
/ checkpoint-v4 evaluator completed a full live campaign on **2026-09-01**: **all
eight gates passed** and overall `passed: true`, so the numerical section-30
release gates are **met** and the feature graduated to **supported opt-in beta**
— still non-default, still permission-gated, and still not production-ready.
Default enablement remains a separate decision after the Phase 4 controls, and
any further live run is a separate approval-gated decision. The earlier
2026-08-31 report-v4 campaign (six of eight gates passing, `passed: false`) is
historical evidence.
The approval-gated `npm run eval:tools:diagnose` transition diagnostic has
completed ONE live run under its historical v2 classifier; its current **v3**
path is **offline only and has NOT been run live**, and it establishes no
release gate. Both are recorded in sections 30 and 30.1. **See section 30** for
the complete five-campaign
record, gate evidence, and accounting. The draft-2020-12 dialect support closes the
confirmed OpenCode 1.18.21 schema-compilation gap both **offline** (hermetic
suites, including a pinned-SDK `read` tool declaring draft 2020-12) and in one
**sanitized, user-authorized live smoke on 2026-08-24** (the then-experimental
`collectiviq-tools-experimental` agent — now the deprecated alias of
`collectiviq-tools-beta`, same model/mode/permission — + `collectiviq-claude-tools`
model):
OpenCode's built-in `read` tool schema (draft-2020-12 root `$schema`) passed
request validation with no `tools is not supported for this request.` warning;
OpenCode presented a permission prompt, the user granted one-time approval, and
`read` executed only after that approval; no other tool was requested or executed;
and the post-tool completion returned a relevant final answer. Exactly two new
CollectivIQ threads were observed — the tool-proposal completion and the
post-tool-result final-answer completion — which are the expected stateless
one-new-thread-per-completion-round tool-loop rounds (spec §5, §11.2), **not** a
hidden title request, and no hidden title-generation thread was created. This
confirms the live OpenCode permission/execution boundary behaved correctly for the
tested local/account configuration; the gateway only PROPOSED the call while
OpenCode owned authorization and execution. It is **one sanitized observation** —
not production readiness, repeatability, a cross-account/cross-version guarantee,
or proof of general provider routing — and the smoke threads are not claimed
deleted (no cleanup result was supplied). This tool-schema smoke is a separate
event from the same-date partial 2026-08-24 `eval:tools` evaluator campaign
(section 30) and proves nothing about the section-30 gates; do not conflate
them. `native` tool
mode and true upstream streaming remain unimplemented; optional Redis-backed
idempotency is implemented as Phase 4A (section 18.1).

### Phase 4 — Production hardening

Deliverables:

* Redis idempotency;
* per-key rate limiting;
* metrics;
* tracing;
* load testing;
* security review;
* dependency scanning;
* runbooks;
* backup configuration;
* release process.

**Phase 4A — Redis idempotency: implemented (optional, off by default).** The
first Phase 4 deliverable is complete and documented in sections 18.1, 22.2, 24,
28.2, 29.6, 31.1, 31.2, and 31.3. It is OPTIONAL: with a blank/absent `REDIS_URL`
the gateway is byte-for-byte unchanged for unkeyed requests. Evidence is
hermetic (`test/unit/idempotency-*.test.ts`, `test/unit/readiness.test.ts`,
`test/integration/chat-completions-idempotency.test.ts`) plus a real-Redis
contract suite (`npm run test:redis`, `test/redis/`) run against the pinned
`redis:8.8.2-alpine`. No live CollectivIQ call was made or required.

**Phase 4B — per-key rate limiting: implemented (optional, off by default).** The
second Phase 4 deliverable is complete and documented in sections 19.1, 20, 22.2,
24, 28.2, 29.7, 31.2, and 31.3. It is OPTIONAL: with `RATE_LIMIT_ENABLED=false`
the gateway performs no limiter or Redis rate-limit operation at all. Evidence is
hermetic (`test/unit/rate-limit-*.test.ts`, `test/unit/redis-client.test.ts`,
`test/unit/redis-runtime.test.ts`,
`test/integration/chat-completions-rate-limit.test.ts`) plus a real-Redis
contract suite (`test/redis/rate-limit-store.test.ts`) that joins
`npm run test:redis` and **was run under explicit approval in the implementing
change** against the pinned `redis:8.8.2-alpine` Compose profile: both
`test/redis/` suites passed together (40 tests), the randomized key namespace was
left empty, and the container was stopped afterwards. No live CollectivIQ call
was made or required, and no dependency or lockfile entry changed. This phase
left capacity exactly as section 19 defined it.

**Phase 4C — metrics and tracing: implemented (optional, off by default).** The
third Phase 4 deliverable is complete and documented in sections 8.1, 23.2, 23.3,
24, 26, 29.9, 31.2, and 31.3. BOTH switches default to false, and "off" means
genuinely inert: no Prometheus registry, no `/metrics` route (the endpoint
returns `404`), no tracer provider, no exporter, no timer, no socket, no
per-request telemetry allocation, and no call into either port — leaving one
fixed boolean check per call site (section 23.2). Five exactly-pinned
dependencies were added —
`@prometheus-io/client`, `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`,
`@opentelemetry/exporter-trace-otlp-http`, and `@opentelemetry/resources` — and
no automatic-instrumentation package, because auto instrumentation would capture
URLs, headers, and uncontrolled attributes. Evidence is hermetic
(`test/unit/metrics.test.ts`, `test/unit/tracing.test.ts`,
`test/unit/telemetry-runtime.test.ts`, `test/unit/generation-telemetry.test.ts`,
`test/integration/observability.test.ts`, plus the observability block in
`test/unit/config.test.ts` and the dependency-close cases in
`test/unit/shutdown.test.ts`); no collector, Redis, OpenCode, or live CollectivIQ
call was made or required. Admission order, SSE framing, cancellation,
idempotency, thread reuse, and shutdown semantics are unchanged, and this phase
left capacity exactly as section 19 defined it.

**Phase 4D — shared cross-replica capacity: implemented (optional, off by
default).** The fourth Phase 4 deliverable is complete and documented in sections
19.2, 20, 22.2, 24, 26, 28.2, 29.10, 31.2, and 31.3. It is OPTIONAL: with
`SHARED_CAPACITY_ENABLED=false` no coordinator is built, no capacity scope is
derived, and no Redis capacity operation occurs — admission is the process-local
controller of section 19, byte for byte. Enabled, it makes only the two ACTIVE
limits cluster-wide; `MAX_QUEUED_REQUESTS` and `MAX_QUEUE_WAIT_MS` stay per
replica, local FIFO order and per-key bypass are preserved, and no cross-replica
queue fairness is promised. It adds ONE flag, no secret, no tuning variable, and
no dependency, and it composes over the SAME single Redis client with one
readiness probe and one shutdown close. It is fail-closed: an unavailable,
corrupt, or ambiguous claim returns `503 capacity_unavailable` and is never
retried or compensated, and the pre-existing `429 gateway_capacity_exceeded` is
unchanged. No `create_thread`/`process_message` retry was added, and no feature
default changed.

Evidence is hermetic (`test/unit/shared-capacity-*.test.ts`,
`test/integration/chat-completions-shared-capacity.test.ts`, plus additions to
`test/unit/config.test.ts`, `test/unit/gateway-auth.test.ts`, and
`test/unit/redis-runtime.test.ts`). The real-Redis suite
`test/redis/shared-capacity-store.test.ts` joined `npm run test:redis` and **has
now been run and passes**: the complete four-suite gate passed **86/86** on an
approved local disposable Redis 8.8.2, and section 29.10 owns the detailed
execution evidence and its limits. That recorded evidence comes from approved
local runs; CI is separately configured to execute the same four-suite gate.
Every further execution needs fresh approval. No live CollectivIQ, OpenCode, or
OTLP call was made or required.

**Explicitly still outstanding in Phase 4:**

* load testing and a security review of the idempotency, rate-limiting,
  shared-capacity, thread-reuse, metrics, and tracing layers;
* dependency scanning;
* backup and release procedures, and runbooks.

Shared capacity being implemented does NOT close Phase 4 and does not make any
feature production ready.

Native tool mode (section 13) and true upstream streaming (section 14.5) remain
Phase 5 work and are unaffected. Phase 5A (thread reuse) has been pulled forward
ahead of these controls and is therefore explicitly NOT production ready; see
below.

### Phase 5 — Native CollectivIQ capabilities

Possible work:

* true request-scoped streaming;
* native structured tool calls;
* token accounting;
* thread deletion;
* model metadata discovery.

**Phase 5A — OpenCode thread reuse: implemented, PULLED FORWARD (optional, off by
default).** One item from this phase was delivered ahead of the remaining Phase 4
controls and is documented in sections 5.1, 5.1.1, 8.6, 10.1, 18.1, 19.1, 20,
22.2, 24, 26, 28.2, 29.8, 31.1, and 34.5. Section 5.1.1 owns the normative
contract.

It is OPTIONAL: with `OPENCODE_THREAD_REUSE_ENABLED=false` the gateway performs no
reuse or Redis reuse operation at all, and every completion creates its own
thread. When enabled it applies ONLY to direct-prompt, tool-free requests carrying
a valid OpenCode session header; protocol-mode models and emulated tool loops keep
today's stateless one-thread-per-completion behaviour.

Evidence is hermetic (`test/unit/thread-reuse-*.test.ts`,
`test/integration/chat-completions-thread-reuse.test.ts`, plus additions to the
config, polling, orchestration, authentication, and Redis-runtime suites) with a
real-Redis contract suite (`test/redis/thread-reuse-store.test.ts`) that **has now
been run and passes**: the complete gate passed 59/59 across all three Redis
suites, and section 29.8 owns the detailed execution evidence. Executing it again
needs fresh approval. No dependency or lockfile entry changed, and this phase left
capacity exactly as section 19 defined it (that 59/59 gate covered three Redis
suites at the time; section 19.2 later added a fourth, which has since been run
and passes as part of the 86/86 four-suite gate of section 29.10).
A sanitized two-turn live smoke on 2026-09-02 additionally observed
the END-TO-END path work for the tested local/account configuration — one upstream
thread served both turns, title propagation kept working, the Redis mapping count
stayed at one, and provider-thread cleanup was user-confirmed. Section 5.1.1 owns
that evidence and its limits.

**Pulling it forward does not make it production ready.** The Phase 4 items listed
above are still outstanding, and the upstream questions this feature is most
sensitive to — message ordering and pagination (section 35, items 7 and 8), thread
cleanup (item 9), and retention (items 22–25) — remain unanswered. One sanitized
single-configuration smoke establishes neither repeatability nor cross-account or
cross-version behaviour. Enabling it by default is a separate decision that
requires those controls and broader live evidence; every further live run requires
fresh approval.

Still Phase 5 work and unaffected: native tools, true streaming, token accounting,
thread deletion, and model metadata discovery.

---

## 33. Acceptance Criteria

The initial gateway release is accepted when:

1. OpenCode lists all configured CollectivIQ virtual models.
2. OpenCode can select the committed default `collectiviq/collectiviq-claude-direct` (a Claude source using `promptMode: "direct"`; Claude is the only source currently observed to answer for the discovery account, and the direct profile drops the protocol wrapper the account objected to — see sections 8.4 and 34.7).
3. A plain user prompt produces the configured CollectivIQ answer.
4. The gateway creates exactly one upstream thread per request. (With optional OpenCode thread reuse enabled — section 5.1.1, off by default — an eligible request that CONTINUES a session's existing thread creates none; it still submits exactly once, and every ineligible request keeps creating exactly one.)
5. The gateway sends the correct `selected_llms` value.
6. The gateway waits for the configured answer source.
7. `stream: false` returns a valid Chat Completions object.
8. `stream: true` returns valid SSE and terminates with `[DONE]`.
9. No CollectivIQ API key appears in logs, responses, or traces.
10. Prompt content is absent from default logs.
11. Client disconnect stops gateway polling.
12. Upstream timeout returns `504`.
13. Invalid upstream JSON returns `502`.
14. Unknown virtual models return `404`.
15. Unsupported multimodal input returns `400`.
16. Health and readiness endpoints work.
17. Docker binds only to host loopback in the provided configuration.
18. The OpenCode configuration in this specification passes an end-to-end smoke test. **Met for the tested account (2026-08-18):** the protocol-mode `collectiviq-claude` path had objected to the gateway's serialized protocol wrapper on 2026-08-15, but the committed-default `collectiviq-claude-direct` (`promptMode: "direct"`) profile was observed live on 2026-08-18 to return a relevant, correct answer to a natural coding request, complete synthetic streaming with no protocol objection / tool alert / tool call, and drive a valid `collectiviq-fast` title on its first attempt. This is a sanitized single-account observation, **not** production readiness or a repeatable upstream guarantee. Capability-aware and still not verified for the discovery account: a combined answer, long-duration streaming, and general non-Claude routing.
19. The service recovers from a CollectivIQ outage without restart.
20. Tool support is labeled experimental until its separate release gates are met. **Met (completed 2026-09-01 report-v5 campaign, §30):** all eight numerical gates passed with overall `passed: true`, and tool support is now labeled **supported opt-in beta** — still non-default and still OpenCode permission-gated. Beta is not production readiness, and enabling tool mode by default remains a separate decision after the Phase 4 controls. Section 30 owns the canonical graduation decision.

---

## 34. Known Risks

### 34.1 Tool-call reliability

The primary risk is that CollectivIQ’s synthesis layer may rewrite structured JSON.

Mitigation:

* strict output prompt;
* combined-response parsing;
* individual-response fallback;
* schema validation;
* separate virtual models;
* explicit production release gates.

### 34.2 Collapsed role hierarchy

A single upstream prompt cannot reliably preserve system, developer, user, assistant, and tool trust boundaries.

Mitigation:

* structured serialization;
* explicit precedence instructions;
* OpenCode permission prompts;
* adversarial testing;
* eventual native role support.

These mitigations apply to `promptMode: "protocol"`. The `promptMode: "direct"`
profile (sections 8.3/8.4) is an even STRONGER collapse: it discards the
structured serialization and precedence instructions entirely and submits only
the latest user message, so system/developer instructions, assistant history, and
prior user turns are lost. That is an accepted, account-specific trade-off to get
a usable answer where the protocol wrapper is rejected (section 34.7) — it is
prompt-content minimization, NOT a restored trust boundary and NOT prompt-injection
prevention.

### 34.3 High latency

Multi-model synthesis may take 10–30 seconds or longer.

Mitigation:

* SSE connection establishment;
* keep-alive messages;
* configurable fast model;
* request timeout;
* clear latency metrics.

### 34.4 Cost amplification

Every OpenCode tool round may call several models and the synthesis model.

Mitigation:

* separate fast and consensus models;
* use consensus for planning and difficult work;
* measure request counts and latency;
* introduce caching only where semantically safe;
* per-gateway-key rate limiting (section 19.1) and, when replicas are scaled out,
  optional cross-replica capacity (section 19.2) — both off by default. Note what
  each does NOT do: capacity bounds CONCURRENTLY ACTIVE completions, not total
  spend, so without it four replicas each configured for four concurrent
  completions admit sixteen and amplify cost by the replica count; the rate limit
  smooths a rate over a window rather than capping spend over a longer horizon.
  Neither is a budget.

### 34.5 Thread proliferation

One thread per completion may generate many CollectivIQ sidebar entries.

Mitigation:

* generic thread names;
* request-level statelessness;
* investigate thread deletion;
* **optional OpenCode thread reuse (section 5.1.1), off by default.** For
  eligible direct-prompt, tool-free sessions it collapses a whole conversation
  onto one thread, which is the largest available reduction in sidebar entries.
  It was pulled forward ahead of the API guarantees this risk originally waited
  for, so it is fail-closed rather than optimistic: message ordering, pagination,
  cleanup, and retention remain unverified, a post-create Redis failure can leave
  one blank orphan thread, and mapping expiry deletes nothing provider-side.
  It therefore only PARTLY addresses this risk, and trades one shape of exposure
  for another: fewer threads, but each holding a whole conversation for as long
  as the provider retains it. Thread deletion (section 35, item 9) remains the
  missing piece, and this feature does not supply it.

### 34.6 Unknown upstream limits

The sample does not specify prompt limits, rate limits, quotas, or retention.

Mitigation:

* conservative local limits;
* explicit configuration;
* contract discovery phase;
* no invented context-window claims.

### 34.7 Account-specific source routing

For the CollectivIQ account used during discovery, generic gateway prompts were
classified account-side as Atlassian queries, and non-Claude sources were skipped
as unsupported for that query category. The submit fields `selected_llms`,
`generate_combined`, and `llms_explicitly_set=true` did not provide a verified
routing override, and the filtered OpenAPI snapshot exposes no documented
generic/non-Atlassian routing field. Consequently only `collectiviq-claude` is
currently observed to answer for this account, and the gateway cannot claim
verified GPT/Gemini/Grok execution for it. This is a value-free, account-specific
observation (no live response text, prompt, Jira identifier, thread id, or model
answer is recorded) and does **not** generalize to every account.

Mitigation:

* `collectiviq-claude-direct` (a Claude source with `promptMode: "direct"`) is the
  committed OpenCode default for the foreground agent `model`, top-level `model`,
  and `small_model` — it keeps the account-supported Claude routing while dropping
  the protocol wrapper the account objected to (Phase 1); it is intentionally lossy
  (no system/developer instructions or conversation history) and was **observed to
  resolve that refusal for the tested account** on 2026-08-18 (a single-account
  observation, not a repeatable guarantee). The protocol-mode `collectiviq-claude`
  model stays declared;
* OpenCode's hidden LLM `title` agent is **disabled** in the committed
  configuration (section 25), so it creates no separate title thread; the session
  title is instead propagated from CollectivIQ's native thread title by the
  `collectiviq-native-title` plugin via `GET /v1/opencode/session-title` (section 9.5),
  best-effort and non-fatal (a failure leaves OpenCode's default/manual title). That
  plugin propagation path was found non-functional in the 2026-08-21 smoke because
  the plugin entry module never loaded (its bare-function default was rejected by
  OpenCode's legacy export scan with `Plugin export is not a function`) and, after
  that loader fix, an environment-only key lookup; both were fixed (V1 `{ id, server }`
  default module and provider-config credential reuse, section 25), and a sanitized
  2026-08-22 live smoke observed the complete path succeed for the tested local
  configuration (a single-local-configuration observation, not a production/cross-
  account/cross-version guarantee; further live runs stay approval-gated). The
  historical 2026-08-18 smoke that observed a `collectiviq-fast` title request
  succeed on its first attempt predates that disable and does **not** prove general
  GPT/non-Claude routing (which remains blocked account-side for the discovery
  account). Per project decision the gateway adds no title-specific fallback or
  alternate-model probing;
* the consensus/coder/fast virtual models remain available for accounts whose
  routing supports non-Claude sources;
* confirm a supported generic-routing mechanism with CollectivIQ before
  advertising multi-source execution (see the upstream-contract document and
  section 35, item 27 — the dedicated generic/non-Atlassian routing question).

---

## 35. Open Questions Requiring CollectivIQ Confirmation

Before declaring production readiness, obtain answers to the following. The two
**2026-08-11 password baselines** are **verified-repeatable** (identical safe
facts across two approved runs, encoded into synthetic fixtures) and resolve
several items below (marked **RESOLVED/VERIFIED**); the 2026-08-06/07 bearer runs
supplied observed-once corroboration. The still-open items form the
**later-release / provider-confirmation gap matrix**. They do **not** block
conservative Phase 1 text entry — the Phase 0 text-readiness gate is satisfied
(section 32) — but they gate later phases and production readiness. Each maps to
a later gate already classified in section 32:

- prompt-size limit (#10) — **open** → production/provider gate;
- rate/quota limits (#11) — **open** (quota `429` never observed) →
  production/provider gate;
- `process_message` idempotency and `status` semantics (#4, #6) — **open** →
  retry and stronger status-semantics gate;
- message ordering/pagination (#7, #8) — **open** → thread reuse/pagination gate.
  Phase 5A shipped optional thread reuse (section 5.1.1) WITHOUT these answers by
  refusing to depend on them: a reused thread's poll accepts only a message whose
  run id matches its own submission's `combined_run_id`, and times out rather
  than returning older content. Correlation is a property of the submission, so
  neither ordering nor pagination can produce a wrong answer — a long thread
  whose `get_messages` paginates merely degrades to a `504`;
- native tools / structured tool results (#14, #15) — **open** → Phase 3/5
  capability gate;
- retention/training/zero-retention/regional (#22–#25) — **open** →
  production/provider gate;
- SSE account-wide-vs-connection scope (#13) — **open** → future true-streaming
  gate;
- token lifetime/refresh for password login (#26) — **open** →
  production/provider gate;
- generic/non-Atlassian source routing with explicit `selected_llms` (#27) —
  **open** → account/provider routing gate (blocks any multi-source/non-Claude
  execution claim; see section 34.7).

1. Is there official API documentation?
2. What are the precise schemas for all four demonstrated endpoints?
   (**Verified-repeatable safe shapes:** `create_thread` `200`,
   `process_message` `202`, `get_messages` `200`, and `POST /login` `200`
   repeated identically across the two 2026-08-11 password baselines and are
   encoded as synthetic fixtures. Response fields beyond the validated safe names
   remain masked/provisional, so the precise full schemas are still unconfirmed.)
3. What HTTP status codes represent authentication, quota, and validation
   failures? (**Repeated across the two 2026-08-11 password runs:** `401`
   empty-bearer auth and `400` missing-parameter validation. A `403` from
   authenticated `/available_llms` was also observed but is
   credential/principal-dependent (password/member `200` vs API-key `403`), cause
   not established. Quota `429` never observed.)
4. Is `process_message` idempotent? (**Unresolved.**)
5. Is there a job or message identifier in its response? (**Presence repeated:** a
   run identifier `combined_run_id` appears in the `202` across the two password
   runs, and the same safe field name appears on `get_messages` entries. Phase 5A
   uses that pairing as the authoritative run correlation (section 5.1.1): a
   message is eligible only when its run id equals the current submission's. The
   gateway relies only on the PRESENCE and EQUALITY of the two values; the
   field's wider semantics remain unknown, and an account that omits it fails
   closed rather than degrading silently.)
6. How can the gateway distinguish accepted work from failed work? (**Presence
   repeated:** a `status` field appears in the `202` across the two password runs,
   but its meaning and any accepted-versus-failed semantics remain **unknown**.)
7. Does `get_messages` return messages in chronological order? (**Unresolved**,
   and no longer load bearing: run correlation (section 5.1.1) selects by
   `combined_run_id`, so ordering cannot produce a wrong answer.)
8. Can it paginate? (**Unresolved.** Likewise not load bearing for correctness — a
   truncated page can only delay or time out the correct answer, never surface an
   uncorrelated one.)
9. Can a thread be deleted? (**Credential/principal-dependent behavior
   observed**, cause not established. Value-free outcomes: the password/member
   principal deleting its own newly created thread → `200` (repeated: both
   2026-08-11 runs + a standalone probe); re-deleting that same just-deleted id →
   `403` (repeated); the API-key principal deleting its own newly created thread →
   `403` (observed in the 2026-08-07 run); a cross-principal recovery attempt
   (password principal deleting stale threads created by another principal) →
   `403` (observed during the approved recovery attempt). This is consistent with
   a permission/scope check, but the provider's evaluation order is unconfirmed
   and the cause — membership, role, token scope, auth mode, or endpoint policy —
   is not established. The recovery command's exact-`404` convergence was not
   exercised by these cases; its handling is retained unchanged.)
10. What is the maximum prompt size?
11. What are account and model rate limits?
12. Does `/user/events` include `thread_id`? (**Repeated:** thread correlation
    matched in both 2026-08-11 password runs, corroborating 2026-08-06. Whether
    the stream is account-wide vs connection-specific is still unknown — see #13.)
13. Is `/user/events` account-wide or connection-specific? (**Unknown.**)
14. Does CollectivIQ support native tools or function calling?
15. Can tool results be sent back as structured messages?
16. Can the API receive system and developer messages separately?
17. Can the API return token usage?
18. What does `percent_usage` mean? (**Repeated as null** across the two
    2026-08-11 password runs; meaning still **unknown**.)
19. Which values are currently valid for `selected_llms`?
20. Does `generate_combined=false` guarantee exactly one selected-model response?
21. What completion signal exists if a selected model fails?
22. How long are threads retained?
23. Are prompts or source code used for model training?
24. Is enterprise zero-retention available?
25. Are there regional data-processing controls?
26. Does the OAuth2 password login (`POST /login`) work, and what is its real
    `200` response shape and token lifetime? (**Login RESOLVED/VERIFIED:** the two
    2026-08-11 runs each performed one `POST /login` → `200` with a normalizable
    `Bearer access_token`. **Still open:** response fields beyond
    `access_token`/`token_type` (masked in the sanitized evidence) and token
    **lifetime/refresh**. `/auth/refresh` has empty schemas and is not
    implemented.)
27. Is there a supported request field or account setting that forces
    generic/non-Atlassian routing while preserving explicit `selected_llms`
    selection? (**Open.** For the discovery account, generic prompts were
    classified account-side as Atlassian queries and non-Claude sources were
    skipped; `selected_llms`, `generate_combined`, and `llms_explicitly_set=true`
    gave no verified override, and the filtered OpenAPI snapshot exposes no such
    field — see section 34.7. This gates any claim of multi-source/non-Claude
    execution.)

---

## 36. Final Design Decision

The gateway shall use this initial production architecture:

```text
OpenCode
  → @ai-sdk/openai-compatible
  → CollectivIQ Gateway /v1/chat/completions
  → new CollectivIQ thread for each request
      (unless optional OpenCode thread reuse is enabled for an eligible
       direct-prompt, tool-free session — section 5.1.1, off by default)
  → prompt selected from the resolved model's validated promptMode
      (protocol → full ordered conversation in the versioned gateway envelope;
       direct → latest normalized user-message content only, no wrapper)
  → upstream execution per the configured source policy
      (single-source, or combined/multi-source)
  → polling for desired answer source
  → strict response/tool parsing
  → OpenAI-compatible response
```

Prompt construction is selected from the resolved virtual model's validated
`promptMode` (section 8.3/8.4), never from its model ID. `protocol` serializes the
full ordered conversation in the existing versioned gateway envelope; `direct`
serializes only the latest normalized user-message content, intentionally omitting
the protocol wrapper and every other conversation message. `direct` is
intentionally lossy (it drops system/developer instructions and conversation
history) and is prompt-content minimization, NOT prompt-injection prevention
(sections 8.4.1, 34.2). Upstream execution follows the configured source policy and
may be single-source or combined/multi-source.

For the currently configured discovery account, the committed OpenCode
foreground/top-level/`small_model` default virtual model is:

```text
collectiviq-claude-direct
```

`collectiviq-claude-direct` is a Claude source using `promptMode: "direct"`: Claude
is the only source currently observed to answer for this account (section 34.7),
and the direct profile drops the protocol wrapper that account objected to (section
32, Phase 1). A sanitized 2026-08-18 smoke **observed it resolve that refusal for
the tested account**, meeting Phase 1's valid-answer / semantic exit criterion for
that account; this is a single-account observation, not production readiness or a
repeatable upstream guarantee (combined answers, long-duration streaming, and
generic non-Claude routing remain unverified). `collectiviq-claude` remains
available as the protocol-mode Claude profile. For
accounts whose routing supports non-Claude sources, `collectiviq-consensus` remains
available as the multi-source option, `collectiviq-coder` as the coding-oriented
option, and `collectiviq-fast` as the lower-latency option. The hidden OpenCode LLM
title agent is disabled in the committed configuration; native-title propagation
via the section 9.5 extension replaces it (section 25; the plugin propagation path
was found non-functional on 2026-08-21 because the plugin entry module never loaded
and, after that loader fix, an environment-only key lookup — both fixed, and the
complete path observed to succeed for the tested local configuration in a sanitized
2026-08-22 live smoke, a single-local-configuration observation, not a production/
cross-account/cross-version guarantee). None of these is the
committed foreground default for this account.

Tool calling shall be implemented behind:

```yaml
toolMode: emulated
```

and remain explicitly experimental until it satisfies the defined release gates.
Those numerical gates are now **met** (§30), so the feature is **supported opt-in
beta** — still non-default and still OpenCode permission-gated. Beta is not
production readiness; default enablement remains a separate decision after the
Phase 4 controls.

This architecture meets the central requirement that all model generation passes through CollectivIQ while minimizing changes to OpenCode and preserving a path toward native CollectivIQ capabilities.
