/**
 * OpenAI non-streamed Chat Completion response encoder (specification section
 * 8.8). Produces exactly the supported fields for a text completion.
 *
 * `usage` values are always zero: the gateway has no reliable upstream token
 * counts. Zeros mean "unavailable" — they are NOT estimates and NOT exact
 * billing usage (specification section 8.8).
 */
import { Type, type Static } from "typebox";

/** The supported non-streamed chat-completion response shape. */
export const ChatCompletionSchema = Type.Object(
  {
    id: Type.String(),
    object: Type.Literal("chat.completion"),
    created: Type.Integer(),
    model: Type.String(),
    choices: Type.Array(
      Type.Object(
        {
          index: Type.Integer(),
          message: Type.Object(
            {
              role: Type.Literal("assistant"),
              content: Type.String(),
            },
            { additionalProperties: false },
          ),
          finish_reason: Type.Literal("stop"),
        },
        { additionalProperties: false },
      ),
    ),
    usage: Type.Object(
      {
        prompt_tokens: Type.Literal(0),
        completion_tokens: Type.Literal(0),
        total_tokens: Type.Literal(0),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ChatCompletionResponse = Static<typeof ChatCompletionSchema>;

/** Inputs for encoding one successful text completion. */
export interface EncodeChatCompletionInput {
  /** Unique `chatcmpl_ciq_*` id. */
  readonly id: string;
  /** Unix-seconds creation time. */
  readonly created: number;
  /** The requested virtual-model id, echoed verbatim. */
  readonly model: string;
  /** The parsed assistant text answer. */
  readonly content: string;
}

/** Encode a non-streamed text completion with zero (unavailable) usage. */
export function encodeChatCompletion(input: EncodeChatCompletionInput): ChatCompletionResponse {
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
