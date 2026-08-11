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
