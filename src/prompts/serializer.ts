/**
 * Model-policy-aware prompt-serializer selector (specification sections 8.3,
 * 8.4, 11.1).
 *
 * The generation layer resolves a virtual-model policy per request and hands its
 * NORMALIZED `promptMode` here; the selector dispatches to the matching pure
 * serializer. Behaviour is driven from the validated `promptMode` field ONLY —
 * never from a model-id string comparison — so a renamed or re-keyed model never
 * changes prompt construction.
 *
 *  - `protocol` → the normative full-history `COLLECTIVIQ GATEWAY PROTOCOL`
 *    serializer (`conversation.ts`), byte-for-byte unchanged.
 *  - `direct`   → the latest-user-only serializer (`direct.ts`).
 *
 * Dispatch is exhaustive and FAILS CLOSED: an impossible internal mode throws
 * rather than silently choosing the lossy `direct` behaviour (which would drop
 * system/developer instructions and conversation history). The thrown error
 * carries no request content; the route maps it to the fixed `500`.
 */
import type { PromptMode } from "../config/schema.js";
import type { NormalizedChatRequest } from "../openai/chat-types.js";
import type { PromptSerializer } from "../generation/types.js";
import { serializeConversationPrompt } from "./conversation.js";
import { serializeDirectPrompt } from "./direct.js";

/** Serialize the final prompt for a request under the resolved `promptMode`. */
export function serializePrompt(request: NormalizedChatRequest, promptMode: PromptMode): string {
  switch (promptMode) {
    case "protocol":
      return serializeConversationPrompt(request);
    case "direct":
      return serializeDirectPrompt(request);
    default: {
      // Exhaustiveness guard: `PromptMode` is a closed union, so this is
      // unreachable for validated config. Fail closed on an impossible value
      // rather than defaulting to a lossy serializer.
      const exhaustive: never = promptMode;
      throw new Error(`unsupported prompt mode: ${String(exhaustive)}`);
    }
  }
}

/** Build the model-aware {@link PromptSerializer} port implementation. */
export function createPromptSerializer(): PromptSerializer {
  return { serialize: serializePrompt };
}
