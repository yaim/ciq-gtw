/**
 * Direct prompt serializer (the `collectiviq-*-direct` account-specific profile,
 * specification sections 8.3, 8.4, 11.1).
 *
 * Unlike the normative protocol serializer (`conversation.ts`), the direct
 * serializer sends ONLY the content of the last normalized `user`-role message,
 * verbatim. It adds NOTHING — no `COLLECTIVIQ GATEWAY PROTOCOL` header, no
 * version/mode line, no JSON envelope, no `BEGIN_CONVERSATION_JSON` /
 * `END_CONVERSATION_JSON` markers, no role label, and no added whitespace,
 * prefix, or suffix — and it OMITS everything else: all system messages, all
 * developer messages, all assistant messages, and every earlier user turn.
 *
 * This profile is intentionally LOSSY and stateless: it discards
 * system/developer instructions, prior user turns, and assistant history, so it
 * is NOT a role-preserving Chat Completions translation and MUST NOT be treated
 * as prompt-injection prevention. It exists to reduce the observed
 * semantic-refusal trigger by removing the gateway protocol wrapper and all
 * non-latest-user content for an account that objected to it.
 *
 * Serialization is PURE and deterministic: the same request always yields the
 * byte-identical latest-user content. It never mutates the request and never
 * inspects raw request data — only the already-normalized message array.
 *
 * "Verbatim" means the normalized content string (existing text-part
 * normalization in `messages.ts` remains authoritative): an empty normalized
 * user message yields an empty direct prompt. A request with NO user-role
 * message is rejected earlier at the model-aware validation boundary
 * (`chat-request.ts`) with a fixed `400`, before this serializer runs; the
 * defensive empty-string fallback here is never reached on the public path.
 */
import type { NormalizedChatRequest } from "../openai/chat-types.js";

/** Return the last normalized `user`-role message content, verbatim. */
export function serializeDirectPrompt(request: NormalizedChatRequest): string {
  const messages = request.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") return message.content;
  }
  // Unreachable on the public request path: a direct-mode request with no
  // user-role message is rejected before prepare(). Return an empty prompt
  // defensively (identical to the empty-latest-user-message case) rather than
  // fabricating any content.
  return "";
}
