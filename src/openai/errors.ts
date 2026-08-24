/**
 * Shared OpenAI-style error envelope for the public API.
 *
 * Every public error the gateway returns uses the OpenAI error shape
 * (`{ error: { message, type, param, code } }`, specification section 20). This
 * module is the single source of the implemented envelopes and their bound
 * HTTP status codes so routes cannot drift from the contract.
 *
 * All messages are fixed, content-free strings. No envelope ever contains a
 * submitted value, a credential, a raw upstream body, or an internal error's
 * message, stack, or cause.
 */
import { Type, type Static } from "typebox";
import type { UpstreamError } from "../collectiviq/errors.js";

/** Fixed owner string for the OpenAI error `type` union used so far. */
export const OpenAIErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        message: Type.String(),
        type: Type.String(),
        param: Type.Union([Type.String(), Type.Null()]),
        code: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type OpenAIErrorBody = Static<typeof OpenAIErrorSchema>;

/** A public API error: a fixed HTTP status paired with its OpenAI envelope. */
export interface OpenAIApiError {
  readonly status: number;
  readonly body: OpenAIErrorBody;
}

function apiError(
  status: number,
  message: string,
  type: string,
  code: string,
  param: string | null,
): OpenAIApiError {
  return { status, body: { error: { message, type, param, code } } };
}

/**
 * `401` — the presented gateway credential was missing, malformed, or wrong.
 * The response is identical for every failure mode so it reveals nothing about
 * which check failed.
 */
export const INVALID_API_KEY_ERROR: OpenAIApiError = apiError(
  401,
  "Invalid gateway API key.",
  "authentication_error",
  "invalid_api_key",
  null,
);

/**
 * `404` — the requested virtual model does not exist (unknown id or case
 * mismatch). The submitted identifier is never reflected back.
 */
export const MODEL_NOT_FOUND_ERROR: OpenAIApiError = apiError(
  404,
  "The requested model does not exist.",
  "invalid_request_error",
  "model_not_found",
  "model",
);

/**
 * `500` — an unexpected internal failure. The message is fixed and content-free;
 * the thrown value is never inspected or serialized.
 */
export const INTERNAL_ERROR: OpenAIApiError = apiError(
  500,
  "The gateway encountered an internal error.",
  "server_error",
  "internal_error",
  null,
);

// --- Phase 1B: chat-completions envelopes (specification section 20) ---------

/**
 * Build a `400 invalid_request_error` with a fixed, content-free message and a
 * static `param`/`code`. The message and param never contain a submitted value;
 * `param` is only a static field NAME (e.g. `"messages"`, `"model"`, `"n"`).
 */
export function invalidRequest(
  message: string,
  param: string | null,
  code = "invalid_request",
): OpenAIApiError {
  return apiError(400, message, "invalid_request_error", code, param);
}

/**
 * `400` — a request field is missing, malformed, or an unsupported value/shape
 * that is not covered by a more specific envelope below. The generic message is
 * content-free.
 */
export const INVALID_REQUEST_ERROR: OpenAIApiError = invalidRequest(
  "The request is not a valid chat completion request.",
  null,
);

/**
 * `400` — a message carried non-text content (image/audio/file/binary or an
 * unknown content-part type). Mirrors specification section 9.4.4.
 */
export const UNSUPPORTED_CONTENT_TYPE_ERROR: OpenAIApiError = apiError(
  400,
  "CollectivIQ Gateway currently supports text input only.",
  "invalid_request_error",
  "unsupported_content_type",
  "messages",
);

/**
 * `400` — the serialized conversation exceeds the model's configured
 * `maximumPromptBytes` (specification section 11.2.1).
 */
export const CONTEXT_LENGTH_EXCEEDED_ERROR: OpenAIApiError = apiError(
  400,
  "The serialized conversation exceeds the configured CollectivIQ prompt limit.",
  "invalid_request_error",
  "context_length_exceeded",
  "messages",
);

/**
 * `413` — the raw request body exceeded `MAX_REQUEST_BODY_BYTES` before parsing.
 * The message is content-free and never echoes the size.
 */
export const REQUEST_BODY_TOO_LARGE_ERROR: OpenAIApiError = apiError(
  413,
  "The request body is too large.",
  "invalid_request_error",
  "request_too_large",
  null,
);

/**
 * `429` — the gateway's process-local capacity (active/queue) is exhausted, or
 * admission is closed during shutdown. Paired with a `Retry-After: 5` header by
 * the route (specification section 19).
 */
export const GATEWAY_CAPACITY_EXCEEDED_ERROR: OpenAIApiError = apiError(
  429,
  "The CollectivIQ Gateway is at capacity.",
  "rate_limit_error",
  "gateway_capacity_exceeded",
  null,
);

/** `429` — CollectivIQ signalled a quota/rate limit (upstream `429`). */
export const UPSTREAM_QUOTA_EXCEEDED_ERROR: OpenAIApiError = apiError(
  429,
  "The upstream CollectivIQ service is rate limiting requests.",
  "rate_limit_error",
  "upstream_quota_exceeded",
  null,
);

/** `502` — CollectivIQ rejected the gateway's own upstream credential. */
export const UPSTREAM_AUTHENTICATION_ERROR: OpenAIApiError = apiError(
  502,
  "The gateway could not authenticate to the upstream CollectivIQ service.",
  "upstream_error",
  "upstream_authentication_failed",
  null,
);

/**
 * `502` — the upstream response was missing, malformed, oversized, or otherwise
 * failed the adapter's minimal contract.
 */
export const INVALID_UPSTREAM_RESPONSE_ERROR: OpenAIApiError = apiError(
  502,
  "The upstream CollectivIQ service returned an invalid response.",
  "upstream_protocol_error",
  "invalid_upstream_response",
  null,
);

/**
 * `502` — a transport/transient/validation/unexpected upstream failure that is
 * not one of the more specific categories above. The message never contains an
 * upstream body, status, or exception detail.
 */
export const UPSTREAM_REQUEST_FAILED_ERROR: OpenAIApiError = apiError(
  502,
  "The upstream CollectivIQ service could not complete the request.",
  "upstream_error",
  "upstream_request_failed",
  null,
);

/**
 * `502` — emulated tool mode required a tool call (`tool_choice: "required"` or a
 * named function) but the upstream produced no valid permitted tool call
 * (specification section 12.3.2). Never a silent text fallback. Content-free.
 */
export const INVALID_TOOL_RESPONSE_ERROR: OpenAIApiError = apiError(
  502,
  "CollectivIQ did not return a valid required tool call.",
  "upstream_protocol_error",
  "invalid_tool_response",
  "tool_choice",
);

/** `504` — the completion exceeded the model's total request deadline. */
export const COMPLETION_TIMEOUT_ERROR: OpenAIApiError = apiError(
  504,
  "The request timed out waiting for a CollectivIQ response.",
  "upstream_timeout_error",
  "completion_timeout",
  null,
);

/**
 * `503` — the gateway is shutting down and cancelled an in-flight completion.
 * Used only when the client socket is still open (a disconnected client
 * receives no body at all).
 */
export const SERVICE_UNAVAILABLE_ERROR: OpenAIApiError = apiError(
  503,
  "The gateway is shutting down.",
  "server_error",
  "service_unavailable",
  null,
);

/**
 * Map a normalized {@link UpstreamError} to its public OpenAI envelope
 * (specification section 20). Only the closed `category` drives the mapping;
 * the error's message, raw status, body, headers, and cause are never read.
 *
 * `cancellation` is intentionally NOT mapped here: the orchestration layer
 * decides whether a cancellation is a deadline (→ `504`) or a client/shutdown
 * abort (no body / `503`) before any mapping. A `cancellation` reaching this
 * function is treated defensively as an unexpected upstream failure.
 */
export function openAIErrorForUpstream(error: UpstreamError): OpenAIApiError {
  switch (error.category) {
    case "quota":
      return UPSTREAM_QUOTA_EXCEEDED_ERROR;
    case "authentication":
      return UPSTREAM_AUTHENTICATION_ERROR;
    case "timeout":
      return COMPLETION_TIMEOUT_ERROR;
    case "response_too_large":
    case "upstream_protocol":
      return INVALID_UPSTREAM_RESPONSE_ERROR;
    case "validation":
    case "transient_http":
    case "network":
    case "unexpected_upstream":
    case "cancellation":
      return UPSTREAM_REQUEST_FAILED_ERROR;
    default:
      return UPSTREAM_REQUEST_FAILED_ERROR;
  }
}
