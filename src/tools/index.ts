/**
 * Public surface of the emulated tool-calling engine (specification sections 12,
 * 21.5, 21.6). The gateway parses model-PROPOSED tool calls; it never executes,
 * authorizes, or simulates a tool.
 */
export {
  MAX_TOOLS,
  MAX_TOOL_SCHEMA_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_CALLS_PER_RESPONSE,
  MAX_TOOL_JSON_DEPTH,
} from "./limits.js";
export type {
  JsonValue,
  NormalizedTool,
  NormalizedToolChoice,
  NormalizedPriorToolCall,
  ParsedToolCall,
  ParsedGeneration,
  ToolParseSource,
  ToolHistoryMessage,
} from "./types.js";
export { safeJsonCopy, type CopyLimits, type CopyResult } from "./copy.js";
export { createToolCallIdGenerator, TOOL_CALL_ID_PREFIX, type ToolCallIdGenerator } from "./ids.js";
export { compileToolset, type CompiledToolset, type CompileResult } from "./schema.js";
export { normalizeToolDefinitions, normalizeToolChoice } from "./normalize.js";
export {
  parseToolEnvelope,
  GATEWAY_PROTOCOL_VERSION,
  type ParsedEnvelope,
  type EnvelopeToolCall,
  type ParseOptions,
} from "./protocol.js";
export { canonicalCall, canonicalCallSet, canonicalJson } from "./canonicalize.js";
export {
  selectGeneration,
  type SelectionInput,
  type SelectionResult,
  type SourceCandidate,
} from "./select.js";
export {
  normalizeToolRequest,
  type NormalizeToolRequestInput,
  type NormalizeToolRequestResult,
  type NormalizedToolRequest,
  type ProbedField,
  type ToolParam,
} from "./request.js";
