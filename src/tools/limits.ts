/**
 * Denial-of-service bounds for the tool subsystem (specification section 21.6).
 *
 * These are the single source of truth for tool-related limits. The OpenAI
 * request boundary (`src/openai/chat-request.ts`) re-exports `MAX_TOOLS` and
 * `MAX_TOOL_SCHEMA_BYTES` from here so the Phase 2.1 disabled-mode accounting and
 * the Phase 3 emulated-mode normalizer stay in exact agreement. Every limit is a
 * conservative initial value; relaxing one is a security-contract change, not a
 * runtime override.
 */

/** Maximum number of `tools` entries in one request (`MAX_TOOL_COUNT`). */
export const MAX_TOOLS = 128;

/**
 * Aggregate byte budget for the ENTIRE `tools` JSON array (`MAX_TOOL_SCHEMA_BYTES
 * = 2 MiB`). Array/object framing, property names, and every nested JSON value
 * count toward the exact UTF-8 JSON representation.
 */
export const MAX_TOOL_SCHEMA_BYTES = 2_097_152;

/**
 * Maximum encoded byte size of a single tool-argument object
 * (`MAX_TOOL_ARGUMENT_BYTES = 1 MiB`). Applied to every prior tool-call argument
 * object in the request history and to every argument object parsed from an
 * upstream tool-call envelope.
 */
export const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

/**
 * Maximum number of tool calls in one assistant response (specification section
 * 12.5). A response proposing more calls is rejected; it is never truncated.
 */
export const MAX_TOOL_CALLS_PER_RESPONSE = 8;

/**
 * Conservative maximum JSON nesting depth for any tool-related structure (tool
 * schemas, argument objects, the parsed protocol envelope). Deeper structures
 * fail closed. Traversal is iterative and cannot overflow the call stack, so this
 * is a resource/anomaly bound, not a stack-safety crutch.
 */
export const MAX_TOOL_JSON_DEPTH = 512;
