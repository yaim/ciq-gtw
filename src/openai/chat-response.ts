/**
 * OpenAI non-streamed Chat Completion response encoder (specification section
 * 8.8). Produces exactly the supported fields for a text OR tool-call completion.
 *
 * A text completion uses assistant `content` and `finish_reason: "stop"`. A
 * tool-call completion (opt-in beta emulated mode) uses `content: null`, an
 * OpenAI `tool_calls` array, and `finish_reason: "tool_calls"`; each call's
 * `arguments` is the already-validated JSON string.
 *
 * `usage` values are always zero: the gateway has no reliable upstream token
 * counts. Zeros mean "unavailable" — they are NOT estimates and NOT exact
 * billing usage (specification section 8.8).
 */
import { Type, type Static } from "typebox";
import type { ParsedToolCall } from "../tools/index.js";

/** One OpenAI function tool call in a non-streamed response. */
const ToolCallSchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Literal("function"),
    function: Type.Object(
      { name: Type.String(), arguments: Type.String() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

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
              // Text answer, or `null` on a tool-call turn.
              content: Type.Union([Type.String(), Type.Null()]),
              // Present only on a tool-call turn.
              tool_calls: Type.Optional(Type.Array(ToolCallSchema)),
            },
            { additionalProperties: false },
          ),
          finish_reason: Type.Union([Type.Literal("stop"), Type.Literal("tool_calls")]),
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

/** Fixed identity fields shared by both response variants. */
interface EncodeCommon {
  /** Unique `chatcmpl_ciq_*` id. */
  readonly id: string;
  /** Unix-seconds creation time. */
  readonly created: number;
  /** The requested virtual-model id, echoed verbatim. */
  readonly model: string;
}

/** Inputs for encoding one successful completion (text or tool calls). */
export type EncodeChatCompletionInput = EncodeCommon &
  (
    | { readonly kind?: "text"; readonly content: string }
    | { readonly kind: "tool_calls"; readonly toolCalls: readonly ParsedToolCall[] }
  );

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } as const;

/** Encode a non-streamed completion with zero (unavailable) usage. */
export function encodeChatCompletion(input: EncodeChatCompletionInput): ChatCompletionResponse {
  const common = {
    id: input.id,
    object: "chat.completion" as const,
    created: input.created,
    model: input.model,
  };
  if ("toolCalls" in input) {
    return {
      ...common,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: input.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: ZERO_USAGE,
    };
  }
  return {
    ...common,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: "stop",
      },
    ],
    usage: ZERO_USAGE,
  };
}
