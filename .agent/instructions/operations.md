# Operations and Local Runtime

## Scope

Read `.agent/docs/tech-software-spec.md` sections 15–19, 23–25, 28, and 31 before changing runtime configuration, capacity, health, observability, Docker, or shutdown behavior.

## Configuration

- Parse and validate environment variables plus the JSON/YAML virtual-model file before the server listens.
- Exit non-zero for invalid required configuration and redact secrets from every diagnostic.
- Preserve loopback binding, content logging off, conservative limits, and polling as safe defaults.
- Validate each virtual model completely: unique ID, non-empty selected models, coherent combined/source policy, tool mode, timeouts, polling bounds, and prompt byte limit.
- Environment-wide defaults may be overridden only through explicit validated model/runtime configuration.
- Do not invent context windows, token counts, valid upstream models, or rate limits.

When adding or renaming configuration, update schema, loader, example environment/model files, container wiring, tests, setup docs, and security implications together.

## Health and Readiness

**Implementation status (Phase 4A, implemented).** `createReadinessState` in
`src/api/health-route.ts` now takes bounded, synchronous, non-throwing dependency
probes and a `markShuttingDown()` latch. Readiness is the local listener flag AND
every probe; a probe that throws or returns a non-boolean counts as not ready,
and shutdown latches not-ready permanently. Optional Redis is the only probe
today: disabled Redis registers none (unchanged behaviour), a configured but
disconnected/reconnecting client keeps `/readyz` at `503`, and readiness recovers
automatically when the client connects. CollectivIQ is deliberately not a probe.
The response bodies are unchanged (`{"status":"ready"}` / `{"status":"not_ready"}`).
Since Phase 4B that stays ONE probe over the ONE shared Redis connection,
covering idempotency, rate limiting, or both — enabling a second Redis-backed
feature adds no second probe.

- `/healthz` proves the process/router event loop is alive and never calls CollectivIQ.
- `/readyz` checks loaded config/models/secrets, optional Redis, and initialized capacity state.
- Temporary CollectivIQ unavailability may be reported without necessarily making the instance unready.
- Health responses must be fast, bounded, content-free, and credential-free.

## Concurrency and Idempotency

**Implementation status (Phase 1B, implemented).** Process-local admission
control lives in `src/generation/capacity.ts` (`createCapacityController`):
global + per-key active limits, a bounded FIFO queue, a bounded queue wait, a
grant pass that scans past per-key-blocked heads, idempotent permit release, and
`closeAdmission()` for shutdown. It is driven by validated config
(`MAX_CONCURRENT_REQUESTS`, `MAX_CONCURRENT_REQUESTS_PER_KEY`,
`MAX_QUEUED_REQUESTS`, `MAX_QUEUE_WAIT_MS`; see spec section 24). Capacity is
acquired **before** `createThread` and released on every exit path; overflow/
closed-admission returns `429` + `Retry-After: 5`. Graceful shutdown
(`src/index.ts`) marks readiness false, calls `closeAdmission()`, allows
`SHUTDOWN_DRAIN_MS`, then aborts the shared shutdown signal to cancel in-flight
polling and release permits. Capacity is process-local (not cross-replica).

**Implementation status (Phase 4A, implemented — OPTIONAL, off by default).**
Cross-replica idempotency for `POST /v1/chat/completions` lives in
`src/idempotency/` and is enabled only by a non-blank `REDIS_URL`. Specification
section 18.1 owns the normative contract — do not restate it here. Operationally:

- **Optional and fail-closed.** Without `REDIS_URL` nothing changes for unkeyed
  requests and Redis is never contacted; a supplied `Idempotency-Key` then
  returns `503 idempotency_unavailable` + `Retry-After: 2`. The same `503`
  applies while a configured Redis is disconnected, when the stored state is
  ambiguous/corrupt/tampered, and when a request loses its claim.
- **Four validated variables** (spec §24): `REDIS_URL` (canonical
  `redis://`/`rediss://` only; secret-bearing), `IDEMPOTENCY_ENCRYPTION_KEY`
  (required with Redis; 32 bytes canonical unpadded base64url; secret),
  `IDEMPOTENCY_TTL_MS` (60000–3600000, default 600000), `REDIS_KEY_PREFIX`
  (1–64 chars, `[A-Za-z0-9_-]+`). Errors stay value-free.
- **Every replica must share** the same encryption key, namespace, Redis
  endpoint, gateway-key set, AND model configuration. Mixed encryption keys
  during a rolling deployment are unsupported; rotating the key means draining
  traffic and waiting at least one maximum TTL. The storage key does not cover
  the resolved model policy, so divergent `config/models.yaml` across replicas
  would make answers produced under different policies interchangeable.
- **Redis must not evict keys** (`maxmemory-policy noeviction`). An evicted
  active record silently permits a duplicate upstream completion; an evicted
  cached record silently re-runs a completed request. Neither is detectable by
  the gateway, so it is a deployment requirement, not a runtime check.
- **Lease policy is state dependent.** A `reserved` record uses a short 30 s
  lease (losing it is safe — the owner-guarded transition reports `lost` and
  aborts); a `processing` record uses a lease derived from the request's own
  deadline, so a live owner's record cannot expire mid-completion. Do not
  collapse them back into one constant.
- **`IDEMPOTENCY_TTL_MS` must be ≥ the largest model `requestTimeoutMs`**,
  enforced at startup when Redis is enabled.
- **Claim before capacity, commit before emit.** The claim is created atomically
  before capacity or upstream work; `reserved → processing` runs after capacity
  and before `create_thread`; `processing → final` must commit before the
  non-streamed response body and before any SSE content or terminal frame. The
  SSE status line and assistant-role opener are committed earlier by design, so a
  late failure on that path is a content-free SSE error record, not an HTTP
  status. A failure at or after `processing` leaves `ambiguous`, which blocks
  repeats for the TTL because `create_thread`/`process_message` still have no
  proven idempotency. No POST retry was added.
- **Lifecycle.** The client is created without connecting (construction stays
  socket-free); the process root connects in the background without blocking
  startup, and closes Redis LAST during shutdown — after draining — with a
  bounded graceful close and a force-destroy fallback.
- **Bounded client behaviour.** Mandatory content-free `error` listener, offline
  command queue disabled, bounded connect/command deadlines, capped automatic
  reconnect, explicit `isReady`-based availability, and no dynamic error text in
  logs.
- **Still process-local:** capacity and queueing. Rate limiting is process-local
  only while Phase 4B is disabled; when `RATE_LIMIT_ENABLED=true` the per-key
  quota spans replicas (below). Shared cross-replica capacity accounting remains
  outstanding Phase 4 work.

**Implementation status (Phase 4B, implemented — OPTIONAL, off by default).**
Cross-replica per-gateway-key rate limiting for `POST /v1/chat/completions` lives
in `src/rate-limit/` over the shared substrate in `src/redis/`, and is enabled
only by `RATE_LIMIT_ENABLED=true`. Specification section 19.1 owns the normative
contract — do not restate it here. Operationally:

- **Optional and fail-closed.** With the feature disabled no limiter is built, no
  scope is derived, and no Redis rate-limit operation runs; the route behaves
  exactly as it did before Phase 4B. When enabled, a disconnected Redis, a
  command timeout, or corrupt stored state returns `503 rate_limit_unavailable` +
  `Retry-After: 2` rather than admitting unmetered traffic. Enabling it therefore
  trades availability for correctness on the completion path.
- **Four validated variables** (spec §24): `RATE_LIMIT_ENABLED` (strict
  `"true"`/`"false"`, default `false`; enabling it REQUIRES `REDIS_URL`, which
  already requires `IDEMPOTENCY_ENCRYPTION_KEY` — no new secret),
  `RATE_LIMIT_REQUESTS` (1–100000, default 60), `RATE_LIMIT_WINDOW_MS`
  (1000–3600000, default 60000), `RATE_LIMIT_BURST` (1–10000 and ≤
  `RATE_LIMIT_REQUESTS`, default 8). Present values are validated even while the
  feature is disabled, so a deployment cannot carry a silently broken setting.
  Errors stay value-free.
- **Every replica must share** the same Redis endpoint, encryption key,
  `REDIS_KEY_PREFIX`, gateway-key set, AND rate-limit settings. Divergent
  settings mean the quota is not the single shared quota it appears to be.
- **Redis's own clock decides.** The GCRA decision runs in one atomic Lua script
  against Redis `TIME`, never a Node or process clock — a replica's clock drift
  would otherwise corrupt a shared quota. Do not introduce a local clock, a local
  counter, or a read-then-write here.
- **`noeviction` applies here too.** An evicted quota key resets that key's
  allowance to a full burst. The gateway cannot detect it, so it stays a
  deployment requirement.
- **Metering position.** The gate sits after all input validation and prompt
  preparation and before the idempotency claim, capacity, any SSE header, and any
  upstream call. Every otherwise-valid attempt spends exactly one unit —
  including an idempotency owner, waiter, cached replay, and different-body
  conflict — and quota is never refunded. Rejected requests spend nothing. Only
  the completion route is metered; `/healthz`, `/readyz`, the model endpoints,
  and the session-title extension are not.
- **Public responses.** `429 gateway_rate_limit_exceeded` with a DYNAMIC
  `Retry-After` computed by the limiter, or `503 rate_limit_unavailable` with a
  fixed `Retry-After: 2`. Every other `429` (capacity, upstream quota) keeps the
  long-standing fixed `Retry-After: 5`. A streamed request rejected at this gate
  gets a normal JSON error, never an SSE error record. No success or
  remaining-quota headers exist.
- **One connection.** `src/redis/client.ts` is the ONLY module importing
  node-redis, and `src/redis/runtime.ts` creates exactly one client per process
  shared by idempotency, rate limiting, and thread reuse. Readiness is one probe
  over that one connection, and shutdown closes it last, exactly once. Do not add
  a second client.

**Implementation status (Phase 5A, implemented — OPTIONAL, off by default).**
Cross-replica OpenCode thread reuse for `POST /v1/chat/completions` lives in
`src/thread-reuse/` and is enabled only by `OPENCODE_THREAD_REUSE_ENABLED=true`,
which requires `REDIS_URL`. Specification section 5.1.1 owns the normative
contract and the state machine — do not restate them here. Operationally:

- **Optional and fail-closed.** Disabled, nothing changes and Redis is never
  contacted for reuse. Enabled, only direct-prompt (`promptMode: "direct"`),
  tool-free (`toolMode: "disabled"`) requests carrying a valid
  `X-CollectivIQ-OpenCode-Session-ID` are eligible; everything else stays
  stateless. A live competing turn is `409 thread_reuse_busy` + `Retry-After: 2`;
  an unusable Redis, corrupt/ambiguous state, or a failed transition is
  `503 thread_reuse_unavailable` + `Retry-After: 2`. Never downgrade a failure to
  a silently created replacement thread.
- **Not production ready.** It was pulled forward ahead of the remaining Phase 4
  controls (shared capacity accounting, load and security
  review, dependency scanning, backup/release procedures, runbooks), and upstream
  ordering, pagination, cleanup, and retention remain unverified. Do not describe
  it as production ready or make it a default.
- **Mapping lifetime and leases.** `OPENCODE_THREAD_REUSE_TTL_MS` (7 days by
  default) is a SLIDING idle TTL reset by every turn; there is deliberately no
  turn cap. Expiry forgets the mapping only — it never deletes the provider
  thread. A `reserved` mapping carries a short fixed lease; a `processing` one
  carries a lease derived from the model's own deadline so a live completion
  cannot be tombstoned underneath it. Both the lease AND each record's Redis
  lifetime are chosen server-side from the state being written, never by the
  caller, and a leased record always outlives its own lease — which matters
  because the minimum mapping TTL is shorter than the maximum processing lease.
- **Interaction with the admission queue.** A queued turn holds its session lease
  while it waits, so another turn of the same session gets `409` meanwhile, and a
  `MAX_QUEUE_WAIT_MS` well above the reserved lease can lose the lease and fail
  that turn with `503`. Both are fail-closed; size the two settings together.
- **Pre-enablement check.** Every completion matches answers by the
  `combined_run_id` its submission returned. Verify the account's
  `process_message` returns one and that `get_messages` entries carry it, or
  submissions fail as upstream protocol errors and turns time out.
- **Terminal transition.** Finalization is the acknowledgement-safe pair
  `processing → committed → active`. `committed` is never acquirable, so an
  unacknowledged commit blocks the session rather than exposing a reusable
  mapping; an undecided ACTIVATION is not a client-visible failure and is retried
  at settlement.
- **Never combined with idempotency.** An eligible request supplying
  `Idempotency-Key` is rejected with `400 unsupported_parameter` before either
  feature touches Redis.
- **Operator note.** The `maxmemory-policy noeviction` requirement applies: an
  evicted mapping silently starts a new thread. Every replica must share the same
  Redis endpoint, encryption key, `REDIS_KEY_PREFIX`, gateway-key set, upstream
  credentials, origin, and model configuration.

- Acquire a global/per-key permit before creating an upstream thread.
- Bound the queue and queue duration; reject overflow with documented OpenAI-shaped `429` and `Retry-After`.
- Always release permits during success, error, timeout, client abort, and shutdown.
- Redis-backed idempotency uses the client key, request-body hash, processing/final state, and short expiration.
- Same key/body may await or replay the existing result; same key/different body returns `409`.
- Cross-replica capacity/idempotency requires shared state; do not imply process-local coordination is global.
- Optional thread reuse takes its session lease after the rate-limit decision and before capacity; renew the lease while waiting for capacity, and release it on every exit path.

## Observability

**Implementation status (Phase 4C, implemented — OPTIONAL, both OFF by
default).** Bounded Prometheus metrics live in `src/observability/metrics.ts`,
manual OpenTelemetry tracing in `src/observability/tracing.ts`, the shared closed
label vocabulary in `src/observability/labels.ts`, and composition in
`src/observability/telemetry.ts`. Specification sections 23.2 and 23.3 own the
normative contract — the metric list, label vocabulary, buckets, ownership table,
and span rules — do not restate them here. Operationally:

- **Off means STRUCTURALLY inert.** With `METRICS_ENABLED=false` and
  `TRACING_ENABLED=false` there is no registry, no `/metrics` route (the endpoint
  returns `404`), no tracer provider, no exporter, no timer, and no socket. Both
  ports expose an `enabled` flag fixed at construction and every call site
  branches on it, so a disabled gateway also builds no span options, no
  observation samples, and no per-request closures, reads no telemetry clock,
  binds no capacity source, does not decorate the adapter, does not install the
  root request hook, and calls neither port. The honest residual cost is one
  fixed boolean check per call site — the claim is "no telemetry objects,
  samples, closures, clock reads, or port calls", not "zero instructions".
  That extends to SHUTDOWN: the telemetry close step skips `tracing.shutdown()`
  when the port is disabled rather than delegating to a no-op, because a disabled
  port owns nothing to flush.
- **Nullability is the mechanism; do not reintroduce a no-op handle.**
  `request.telemetry` is `null` when disabled, span helpers are `null` rather
  than no-op functions, and call sites use optional access/invocation (which
  short-circuits without evaluating arguments). A shared no-op object would make
  every authentication failure, model miss, and error envelope call a method on a
  path that must be inert. The no-op port implementations stay total as defence
  in depth only — never rely on them instead of the branch.
- **Four validated variables** (spec §24): `METRICS_ENABLED` and
  `TRACING_ENABLED` (strict `"true"`/`"false"`, default `false`),
  `TRACING_OTLP_ENDPOINT` (canonical absolute http(s) URL, ≤2048 UTF-8 bytes,
  with NO embedded `user:pass@` credentials, no query or fragment delimiter —
  a bare trailing `?` or `#` counts — and a NON-ROOT path; supply the full
  traces path, e.g. `http://127.0.0.1:4318/v1/traces`; REQUIRED when tracing is
  enabled and validated whenever present), and `TRACING_SAMPLE_RATIO` (a plain
  decimal in `[0, 1]`, default `1`). Errors stay value-free and never echo the
  endpoint, which is also redacted from logs. Neither feature requires Redis, a
  credential, or any other feature.
- **`GET /metrics` is unauthenticated by design and must be isolated by the
  operator.** It sits outside `/v1`, has no gateway-key check, and the process
  cannot verify whether the interface it is bound to is private. Bind to loopback
  and scrape locally, or expose it only on a private network or behind a
  firewall. Never publish it on a public listener. The exposition contains no
  prompt, answer, path, tool, credential, or identifier, but it does disclose
  traffic volumes, latencies, error categories, and the configured
  virtual-model ids.
- **Tracing is outbound egress.** An enabled gateway continuously POSTs spans to
  `TRACING_OTLP_ENDPOINT` with no exporter authentication header (none is
  configurable in this slice), so the collector must be reachable only from the
  gateway's network. Prefer `https://` off a private link. Setting an `OTEL_*`
  variable will NOT change this: they are removed from the environment while the
  SDK objects are constructed, so an ambient endpoint, header, client
  certificate, or batch-processor setting is inert. That isolation is
  construction-time only — the deployment rule is still to set no `OTEL_*`
  variable at all.
- **Telemetry is best-effort, never a correctness control.** Every observation is
  total and non-throwing, admission order is untouched, and an enabled-but-unwired
  tracer degrades to no traces rather than failing requests. That is the
  deliberate opposite of the rate limiter and thread-reuse coordinator, whose
  absence must fail closed — do not "fix" telemetry to match them.
- **Ownership is one writer per signal** (spec §23.2 owns the table). Request
  count/duration/errors/cancellations belong to the root hook in
  `src/api/request-telemetry.ts`, upstream counters to the decorator in
  `src/generation/adapter-telemetry.ts`, poll/timeout/tool signals to
  `src/generation/chat-completion.ts`, and the stream gauge to
  `src/api/chat-stream-response.ts`. Adding a second writer for an existing
  metric is a duplicate-counting bug, not extra coverage.
- **Request settlement reads the raw response, not `onResponse`.** A hijacked SSE
  reply may be force-destroyed without Fastify ever "sending" it, so settlement
  listens for `finish`/`close` behind a one-shot guard. Preserve that if you
  touch the SSE transport. A client disconnect additionally marks the root
  `gateway.request` span failed with the closed `other` category — the status
  line may still read `200` — while deliberately NOT adding an `errors_total`
  sample, because the disconnect is already counted as a cancellation.
- **Unmeasured before enabling either feature.** No live OTLP collector has been
  exercised, so wire-level encoding and collector interoperability are
  unverified; registry behaviour under sustained scraping and the batch
  processor's memory profile under sustained traffic belong to the outstanding
  Phase 4 load gate; and this layer has not been through the Phase 4 security
  review. Advise a conservative scrape interval and a `TRACING_SAMPLE_RATIO`
  below `1` on a busy deployment, and validate a collector outside production
  first.

- Emit structured metadata for request state, latency, poll counts, sizes, bounded model/source/tool-mode categories, parser path, and errors.
- Keep prompt/response/tool content and identifying IDs out of default signals.
- Metrics and labels must match specification section 23 and remain bounded in cardinality.
- Trace state transitions and upstream calls without injecting unsupported correlation headers.
- Avoid duplicate counting between route, application, and adapter layers by assigning metric ownership.

## Cancellation, Streaming, and Shutdown

**Implementation status (Phase 1B / Phase 2, implemented).** Client-disconnect
(response-socket `close`), the total request deadline, and shutdown share one
abort path. On the streamed path (`src/api/chat-stream-response.ts`) writes are
serialized and honour Node backpressure (a later frame waits for `drain`);
`: collectiviq-gateway keep-alive` comments are emitted every 15 s while polling
waits and every keep-alive timer is cleared before any terminal/error output and
on success, error, disconnect, cancellation, and shutdown (the interval is
`unref`'d so it never keeps the process alive). A write failure or socket close is
treated as client cancellation — polling is aborted, the capacity permit is
released, and no body is written to a gone client. After the reply is hijacked
the writer NEVER rejects: every frame write resolves to an explicit
written/closed outcome, a synchronous `write` throw or callback error is caught,
and every temporary `drain`/`close`/`error`/abort listener is cleaned up. The
combined signal also unblocks an actively **backpressured** write: rather than
wait for a `drain` a connected non-reading client may never send, the writer
force-closes the stuck response so the shutdown drain window
(`SHUTDOWN_DRAIN_MS`) stays authoritative and `app.close()` cannot hang; a forced
close may end silently (a `503` cannot be guaranteed to flush). Forced
termination flushes any written terminal frames via `res.end()` then destroys the
socket, and is hardened so a `res.end()` that throws destroys immediately and a
`res.end()` whose callback never fires destroys on a bounded next-turn fallback —
the response always ends destroyed exactly once, so shutdown never hangs. A
shutdown that cancels `run()` while the transport is still writable keeps the safe
`503` record. A deadline maps to `504`; a shutdown while the client is still
connected **and the transport is writable** maps to `503` (otherwise the response
is force-closed and may end silently); a client disconnect sends no body. Polling
remains authoritative; `/user/events` is not used.

- Connect client disconnects to a shared abort signal.
- Abort pending upstream HTTP calls when possible, stop polling/keep-alives, close SSE, and release capacity.
- Do not retry cancelled work.
- On `SIGTERM`, stop admission, mark readiness false, drain active requests for the configured period, cancel the remainder, close Redis and telemetry resources in the one bounded dependency-close step (Redis first, then — only when tracing is actually enabled — the tracing provider under its fixed 2 s budget), and exit. That close is non-rejecting and its timer is `unref`'d, so an unreachable collector can neither hang shutdown nor surface dynamic exception text.
- Test shutdown with active polling and streaming requests; avoid hanging timers or sockets.

## Deployment

Local native execution binds to loopback. Local Docker may bind the process to all container interfaces only when compose publishes `127.0.0.1:8787:8787` on the host.

Hosted deployments require the controls in specification section 31.2. Sticky sessions are unnecessary: requests are stateless by default, and the one exception — optional OpenCode thread reuse — keeps its mapping in the shared Redis rather than in a replica, so any replica can serve any turn. Redis is required when idempotency, rate-limit, or thread-reuse semantics must span replicas.

**Redis in Compose (Phase 4A/4B, implemented).** `compose.yaml` carries an OPT-IN
`redis` profile using the pinned
`redis:8.8.2-alpine`, published only on `127.0.0.1:6379`, with persistence
disabled and no embedded password. The gateway deliberately has no `depends_on`
on it, so it starts and serves `/healthz` whether or not Redis is running. That
ONE Redis backs BOTH optional features — idempotency (`:idem:` keys) and rate
limiting (`:rate:` keys) — and the gateway opens exactly ONE connection for them,
so the same profile serves either feature or both.

`REDIS_URL` must resolve from wherever the GATEWAY PROCESS runs, so the two local
setups differ and must not be mixed:

- Redis only, gateway native (also the `npm run test:redis` setup) —
  `docker compose --profile redis up -d redis`, then
  `REDIS_URL=redis://127.0.0.1:6379`. Naming the service keeps the gateway
  container out of it.
- Both in Compose — `REDIS_URL=redis://redis:6379 docker compose --profile redis
  up --build`. Inside the gateway container `127.0.0.1` is that container, not
  the Redis service.

This local profile does NOT meet production requirements: a hosted Redis additionally
needs network isolation, ACL/authentication from a managed secret, TLS where the
link is not private, the application-layer encryption key, and identical
Redis/key/prefix/gateway-key **and `RATE_LIMIT_*`** configuration on every
replica. Redis persistence and backups are not required for this ephemeral
encrypted cache state, nor for the self-expiring rate-limit timestamps.

## Operational Validation

Cover as relevant:

- invalid startup config and secret-redacted failure output;
- liveness/readiness success and dependency-degraded states;
- capacity acquisition, queue timeout, overload response, and permit cleanup;
- rate-limit admission, exhaustion (`429` + computed `Retry-After`), fail-closed
  `503` on an unavailable Redis, and zero limiter activity while disabled;
- client disconnect during create/submit/poll and during SSE;
- total timeout and transient poll retries;
- bounded/log-safe metrics and tracing;
- `SIGTERM` admission stop, drain, forced cancellation, and resource close;
- native and Docker loopback exposure;
- recovery after an upstream outage without restart.
