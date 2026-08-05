# Security and Privacy

## Required Reading

Read `.agent/docs/tech-software-spec.md` sections 19, 21–23, 24, 31, 33, and 34 before security-sensitive changes. Prompt/tool work also requires the tool-calling guide; upstream work requires the upstream guide.

## Implemented Foundation Controls

These controls exist today and must be preserved:

- **Bounded model configuration** — `MODEL_CONFIG_LIMITS` in `src/config/schema.ts` (spec section 24.1): file byte cap (checked before and after read), regular-file requirement, strict UTF-8 decode, YAML alias/duplicate-key rejection, and bounds on model/source counts, string lengths, timeouts, polling, and prompt bytes. Blank/whitespace-padded ids and sources are rejected.
- **Value-free diagnostics** — configuration errors are stable allowlisted field/reason pairs (no ids, unknown field names, submitted values, file contents, library text, or paths); an unexpected startup failure prints only `gateway failed to start (internal error)`.
- **Recursive bounded log sanitization** — `src/shared/redaction.ts` (`sanitizeLogValue`) plus the logger's `formatters` and `logMethod` hook sanitize every record, child binding, and Error argument, with Pino redact paths as additional defense. Never bypass the logger with a second Pino configuration; never emit `Error.message`/stack/cause.

When changing any of the above, update spec section 24.1, `README.md`, and `SECURITY.md` together.

## Secrets and Authentication

- `COLLECTIVIQ_API_KEY` authenticates upstream; gateway keys authenticate clients. Never conflate or forward them.
- Load secrets from environment or an approved secret manager and redact them from startup output, logs, traces, metrics, errors, tests, snapshots, commands, and fixtures.
- Production requires gateway authentication. Authentication may be disabled only for an explicitly local single-user service bound exclusively to loopback.
- Compare keys using a timing-safe strategy where practical, hash only the correlation identity needed for bounded operational metadata, and never log the presented key.
- Metrics need network isolation or independent authentication; health output must not disclose configuration values.

## Content Confidentiality

Forbidden in default logs and telemetry:

- messages, serialized prompts, answers, or source code;
- file/repository paths;
- tool arguments or results;
- authorization headers and credentials;
- raw upstream response bodies.

Content logging requires both `ENVIRONMENT=development` and `LOG_CONTENT=true`, an unmistakable startup warning, bounded/redacted output, and explicit task justification. It must never be activated against production/customer data.

Thread titles and request metadata must be generic. Do not derive them from prompts, repository names, filenames, or personal data.

## Input and Upstream Trust

- Validate raw client, config-file, tool-schema, tool-argument, Redis, and upstream data at their boundaries.
- Enforce byte limits before retaining or parsing large bodies where possible.
- Treat prompt boundaries as ambiguity mitigation, not an authorization boundary.
- Allowlist tool names and validate exact schemas; OpenCode permission checks remain mandatory.
- Use OpenAI-style sanitized errors externally and structured bounded categories internally.
- Avoid dangerous dynamic behavior: no evaluation of generated code, no shell execution, no arbitrary module loading, and no gateway-side tools.

## Resource and Abuse Controls

Preserve configurable bounds for:

- HTTP request bodies and final prompts;
- tool count, total schema size, argument size, and calls per response;
- upstream response size;
- global/per-key active requests, queue length, and queue duration;
- connect/operation/total deadlines;
- polling intervals and retry count implied by the total deadline.

Acquire capacity before upstream thread creation. Return the documented `429` plus `Retry-After` when capacity is unavailable. Metrics labels must remain bounded; never label with request, thread, user, or tool-call IDs.

## Retention and Redis

- Default mode retains no content after request completion.
- Keep only transient in-memory values needed for the active request and release references promptly.
- Redis is optional and initially limited to short-lived idempotency/status/final-response state and counters.
- Do not persist prompt content by default. Cached final responses require an explicit TTL, encryption-at-rest expectations, access controls, and documentation.
- Same idempotency key with a different body returns `409`; do not use a permanent prompt hash as an implicit key across trust boundaries.
- CollectivIQ-side retention/training/deletion/regional behavior is unknown until verified; do not promise zero retention end to end.

## Network and Deployment

- Native local default is `127.0.0.1:8787`.
- Binding to `0.0.0.0` requires explicit configuration. In the supplied Docker example it is acceptable only inside the container while host publishing stays on loopback.
- Hosted use requires TLS termination, authentication, firewall/private-network controls, rate limits, protected logs/metrics, and managed secrets.
- Run containers as non-root where feasible, minimize the image, pin dependencies/images, and keep build credentials out of layers.

## Dependencies and External Actions

- Prefer established, maintained packages with narrow purpose and compatible licenses.
- Verify current guidance from primary sources for security-sensitive dependencies.
- Lock every dependency and run the full compatibility suite for automated updates.
- Major upgrades, new external services/telemetry, broad lockfile regeneration, secret operations, live content-bearing probes, publishing, or deployment require explicit approval.

## Security Review Checklist

- Are secrets separated and redacted on every success/error path?
- Can any prompt, response, path, argument, or tool result reach logs/traces/metrics?
- Are network exposure and authentication defaults still safe?
- Are all untrusted boundaries schema-validated and size-bounded?
- Can cancellation/timeout release capacity and memory promptly?
- Could a retry duplicate an upstream side effect?
- Does any cache change content retention or cross-user visibility?
- Are error messages useful without exposing upstream bodies?
- Are test fixtures synthetic or demonstrably sanitized?
- Does the documentation state residual risks honestly?
