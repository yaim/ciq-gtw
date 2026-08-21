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

Tool calling is not demonstrated by the supplied CollectivIQ API. The first gateway release will therefore implement an optional prompt-mediated tool-call protocol. This mechanism must be considered experimental until it meets the release-quality test thresholds defined in this specification.

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

For the initial implementation, the gateway shall create a new CollectivIQ thread for every completion request. It will submit a serialized version of the full OpenAI message history as one CollectivIQ prompt.

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

Persistent thread reuse may be introduced later only if CollectivIQ exposes reliable message identifiers, thread cleanup, and request correlation.

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

Because each gateway request creates a new CollectivIQ thread, stale-message filtering is not required in the initial implementation.

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
| `tools`                 | Tolerated + discarded for disabled models (Phase 2.1); executed only through native/emulated mode (Phase 3, unimplemented) |
| `tool_choice`           | `auto`/`none` tolerated + discarded for disabled models (Phase 2.1); `required`/named rejected until tool mode ships |
| `parallel_tool_calls`   | Accepted; best-effort                                |
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

**Implementation status (Phase 2.1).** The behaviors above describe the eventual
tool-calling target (Phase 3). Today, tool calling is unimplemented and every
virtual model is `toolMode: "disabled"`, so the request boundary only TOLERATES
the tool metadata OpenCode sends automatically: it accepts a `tool_choice` of
exactly `"auto"` or `"none"` (discarded, name recorded) and rejects `"required"`
and named-function choices with a stable `unsupported_parameter` `400` — a
request that requires or names a tool is never silently answered with text. See
the Phase 2.1 note in section 9.4.4.

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
logged). `parallel_tool_calls` remains an ignored compatibility option regardless of tool
mode. Rejected with stable content-free
`400`s — by **own-property presence alone**, including an empty value, `null`,
an explicit `undefined` supplied directly to the normalization boundary, or any
otherwise-harmless value: a non-boolean `stream`,
`response_format`, `logprobs`,
audio parameters, message `tool_calls`, tool-role messages, and
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
against an `emulated`/`native` model (neither implemented) is rejected with the
stable content-free `unsupported_parameter` `400` (`param` = `tools` or
`tool_choice`). No tool definition ever reaches the prompt, upstream, logs,
storage, or the response, and no tool call can be emitted or executed.
Conservative initial collection bounds apply (`MAX_MESSAGES = 512`,
`MAX_TOOLS = 128`, `MAX_TOOL_SCHEMA_BYTES = 2 MiB`,
`MAX_TEXT_PARTS_PER_MESSAGE = 256`); the body-byte and final-prompt-byte limits
remain authoritative. The raw request is normalized to a **deeply immutable**
internal value (each message, the message array, the ignored-name collection, and
the outer request are frozen) and never flows into generation logic.

## 9.5 OpenCode session-title extension (`GET /v1/opencode/session-title`)

**Implemented (offline; the native-title lookup contacts CollectivIQ only when the
endpoint is actually called).** This is a CollectivIQ/OpenCode **extension**,
explicitly **not** part of the bounded OpenAI Chat Completions profile. It exists
so the project-local OpenCode plugin can propagate the CollectivIQ-generated native
thread title (section 10.1) to the OpenCode session title without OpenCode's hidden
LLM title agent creating a separate upstream thread (section 25). It is registered
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

For each completion:

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

Tool-call streaming remains a **Phase 3** concern and is not implemented; the
Phase 2 stream is text-only. Tool calls may be emitted in one complete delta
rather than character-by-character.

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

Each completion shall follow:

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

---

## 20. Error Mapping

| Condition                   | HTTP | Error type                | Code                             |
| --------------------------- | ---: | ------------------------- | -------------------------------- |
| Invalid gateway key         |  401 | `authentication_error`    | `invalid_api_key`                |
| Unknown model               |  404 | `invalid_request_error`   | `model_not_found`                |
| Invalid request             |  400 | `invalid_request_error`   | `invalid_request`                |
| Unsupported content         |  400 | `invalid_request_error`   | `unsupported_content_type`       |
| Prompt too large            |  400 | `invalid_request_error`   | `context_length_exceeded`        |
| Gateway capacity            |  429 | `rate_limit_error`        | `gateway_capacity_exceeded`      |
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
submitted value). Capacity is **process-local** — it does not span replicas.
`REQUEST_TIMEOUT_MS`/`DEFAULT_UPSTREAM_TIMEOUT_MS`/`POLL_INTERVAL_MS`/
`POLL_MAX_INTERVAL_MS` remain per-model settings (`requestTimeoutMs`,
`pollIntervalMs`, `maxPollIntervalMs`) rather than global env vars in this phase.

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

Because tool calling is not implemented (Phase 3), the committed `opencode.jsonc`
ships a text-only default primary agent — a `collectiviq-text` agent with a
wildcard permission `deny`, selected as the `default_agent`. Denying permissions
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

**Hidden LLM title agent disabled; native-title propagation via a project-local
plugin.** OpenCode ships a built-in hidden `title` agent that would generate a
short session title with its **own separate completion request** — and therefore a
**separate** upstream CollectivIQ thread. In the committed `opencode.jsonc` that
hidden agent is **disabled** (`"title": { "disable": true }`), so it creates **no**
separate title thread or completion. As a result a first foreground message now
creates **exactly one** CollectivIQ thread; there is no longer an extra
title-generation thread, and the earlier "two or more upstream threads per session"
behavior no longer applies to the committed configuration.

In its place, a dependency-free project-local plugin
(`.opencode/plugins/collectiviq-native-title.ts`) propagates the CollectivIQ
**native** thread title (section 10.1) asynchronously, reusing the foreground
thread rather than creating a new one. It arms only a parentless top-level session
whose title is still OpenCode's default `New session - <ISO>` form and whose
request is routed to the `collectiviq` provider, attaches the
`X-CollectivIQ-OpenCode-Session-ID` header once, and after `session.idle` polls the
authenticated `GET /v1/opencode/session-title` extension (section 9.5) on a
bounded, capped schedule (immediately, then 2/4/8/8/8 s — six attempts). Only if
the session title is still the exact captured default does it rename the session to
the validated provider title (Unicode-code-point-safe, ≤ 100 code points). It
**never** overwrites a manual or already-propagated title, and it is best-effort:
any failure leaves OpenCode's default/manual title and never raises an alert.
Arming resolves the session's parent/title from OpenCode `session.created`/
`session.updated` lifecycle events held in bounded in-memory state (no async
lookup in the normal case); only for a session not yet observed does `chat.headers`
fall back to a small, bounded, fail-open `session.get` (attaching no header on
timeout). Arming therefore adds at most a bounded delay to the foreground request,
never an indefinite one. Native-title polling adds only bounded `GET` requests
to the gateway; it creates no additional upstream thread.

This OpenCode session title is **distinct** from the CollectivIQ upstream thread
title. The gateway still performs exactly one `create_thread` per completion
request using the fixed, content-free placeholder `THREAD_TITLE` (exactly
`New Thread`, section 10.1), and **no** OpenCode-generated title is ever forwarded
into `create_thread`. CollectivIQ may **asynchronously** replace `New Thread` with
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
    // The project-local collectiviq-native-title plugin propagates the native
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
non-streamed foreground text paths within the implemented, tool-free contract (tool
DEFINITIONS tolerated and discarded, tool CALLS never emitted) until Phase 3
lands.

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
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── metrics.ts
│   │   └── tracing.ts
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

Sticky sessions are not required because requests are stateless.

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
  requires no thread-deletion call. This does **not** reduce provider-side data
  exposure: prompts and answers still cross into CollectivIQ-managed threads, and
  provider retention, training, deletion guarantees, and regional controls remain
  **unknown** — they are production/provider-confirmation gates, not request-path
  safeguards.
* The gateway assumes **no** message ordering; duplicate desired-source messages
  use the documented deterministic timestamp → sortable-id → array-position
  fallback (section 8.6/8.7).
* Pagination is not required while each request uses a new thread and retrieves
  full history.
* Prompt-size limits remain a conservative **gateway** configuration bound
  (`maximumPromptBytes`), not a claimed upstream maximum.
* Password-token `401` invalidation plus next-request re-login allow correct
  operation without an implemented refresh endpoint.

Still **not** declared fully complete: idempotency and `process_message`
`status` semantics still prohibit retries and stronger status interpretation;
message ordering/pagination still gate any thread reuse or pagination
optimization; rate/quota limits, retention/training/regional controls, and token
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
agent is now **disabled** in the committed `opencode.jsonc`; a project-local plugin
propagates the CollectivIQ native title via `GET /v1/opencode/session-title`
instead (sections 9.5 and 25). This historical observation is distinct from the
foreground release gate.

**Phase 1B — live observation (2026-08-18, direct-mode foreground path):** a
sanitized, user-authorized smoke drove the committed-default
`collectiviq-claude-direct` (`promptMode: "direct"`) foreground path from OpenCode.
Direct mode submitted only the latest user text (no protocol wrapper in the
CollectivIQ UI); a natural TypeScript coding request returned a relevant, correct
answer; synthetic streaming completed with **no** protocol objection, tool alert,
or tool call; and the hidden `collectiviq-fast` title request returned a valid
title on its **first** attempt and updated the OpenCode session title. This meets
the Phase 1 valid-answer / semantic exit criterion **for the tested account** and
supersedes the 2026-08-15 protocol-wrapper refusal for this path. It is an observed
single-account result — **not** production readiness, a repeatable upstream
guarantee, combined-answer support, long-duration streaming, or general non-Claude
routing. Any further live run still requires separate explicit approval before live
CollectivIQ traffic. `stream:true` synthetic SSE is
implemented (Phase 2, below); tools stay in Phase 3; Redis/idempotency and
metrics/tracing remain unimplemented; thread reuse and upstream deletion are not
performed.

Deliverables:

* `/v1/models`;
* non-streamed `/v1/chat/completions`;
* one thread per request;
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
* Tool CALLING stays disabled: `required`/named `tool_choice`; a non-array,
  over-count, or over-budget `tools`; an accessor, cycle, sparse/exotic/over-deep
  structure, or unsupported value anywhere; and any tool metadata against an
  `emulated`/`native` model are rejected with the stable `unsupported_parameter`
  `400`.
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

* tool-calling release thresholds are met or the feature remains explicitly experimental.

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

### Phase 5 — Native CollectivIQ capabilities

Possible work:

* true request-scoped streaming;
* native structured tool calls;
* token accounting;
* persistent thread reuse;
* thread deletion;
* model metadata discovery.

---

## 33. Acceptance Criteria

The initial gateway release is accepted when:

1. OpenCode lists all configured CollectivIQ virtual models.
2. OpenCode can select the committed default `collectiviq/collectiviq-claude-direct` (a Claude source using `promptMode: "direct"`; Claude is the only source currently observed to answer for the discovery account, and the direct profile drops the protocol wrapper the account objected to — see sections 8.4 and 34.7).
3. A plain user prompt produces the configured CollectivIQ answer.
4. The gateway creates exactly one upstream thread per request.
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
20. Tool support is labeled experimental until its separate release gates are met.

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
* introduce caching only where semantically safe.

### 34.5 Thread proliferation

One thread per completion may generate many CollectivIQ sidebar entries.

Mitigation:

* generic thread names;
* request-level statelessness;
* investigate thread deletion;
* investigate persistent mapping only after API guarantees are available.

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
  title is instead propagated from CollectivIQ's native thread title by a
  project-local plugin via `GET /v1/opencode/session-title` (section 9.5),
  best-effort and non-fatal (a failure leaves OpenCode's default/manual title). The
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
- message ordering/pagination (#7, #8) — **open** → thread reuse/pagination gate;
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
   runs; its semantics remain unknown.)
6. How can the gateway distinguish accepted work from failed work? (**Presence
   repeated:** a `status` field appears in the `202` across the two password runs,
   but its meaning and any accepted-versus-failed semantics remain **unknown**.)
7. Does `get_messages` return messages in chronological order? (**Unresolved.**)
8. Can it paginate? (**Unresolved.**)
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
via the section 9.5 extension replaces it (section 25). None of these is the
committed foreground default for this account.

Tool calling shall be implemented behind:

```yaml
toolMode: emulated
```

and remain explicitly experimental until it satisfies the defined release gates.

This architecture meets the central requirement that all model generation passes through CollectivIQ while minimizing changes to OpenCode and preserving a path toward native CollectivIQ capabilities.
