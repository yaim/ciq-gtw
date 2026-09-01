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
- **Still process-local:** capacity, queueing, and rate limiting. Redis buys
  cross-replica idempotency only. Distributed rate limiting and shared capacity
  accounting remain outstanding Phase 4 work.

- Acquire a global/per-key permit before creating an upstream thread.
- Bound the queue and queue duration; reject overflow with documented OpenAI-shaped `429` and `Retry-After`.
- Always release permits during success, error, timeout, client abort, and shutdown.
- Redis-backed idempotency uses the client key, request-body hash, processing/final state, and short expiration.
- Same key/body may await or replay the existing result; same key/different body returns `409`.
- Cross-replica capacity/idempotency requires shared state; do not imply process-local coordination is global.

## Observability

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
- On `SIGTERM`, stop admission, mark readiness false, drain active requests for the configured period, cancel the remainder, close Redis/metrics resources, and exit.
- Test shutdown with active polling and streaming requests; avoid hanging timers or sockets.

## Deployment

Local native execution binds to loopback. Local Docker may bind the process to all container interfaces only when compose publishes `127.0.0.1:8787:8787` on the host.

Hosted deployments require the controls in specification section 31.2. Requests are stateless, so sticky sessions are unnecessary; Redis is required when idempotency and concurrency semantics must span replicas.

**Redis in Compose (Phase 4A, implemented).** `compose.yaml` carries an OPT-IN
`redis` profile using the pinned
`redis:8.8.2-alpine`, published only on `127.0.0.1:6379`, with persistence
disabled and no embedded password. The gateway deliberately has no `depends_on`
on it, so it starts and serves `/healthz` whether or not Redis is running.

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
Redis/key/prefix/gateway-key configuration on every replica. Redis persistence
and backups are not required for this ephemeral encrypted cache state.

## Operational Validation

Cover as relevant:

- invalid startup config and secret-redacted failure output;
- liveness/readiness success and dependency-degraded states;
- capacity acquisition, queue timeout, overload response, and permit cleanup;
- client disconnect during create/submit/poll and during SSE;
- total timeout and transient poll retries;
- bounded/log-safe metrics and tracing;
- `SIGTERM` admission stop, drain, forced cancellation, and resource close;
- native and Docker loopback exposure;
- recovery after an upstream outage without restart.
