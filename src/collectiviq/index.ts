/**
 * CollectivIQ upstream boundary.
 *
 * Public surface for the rest of the gateway: the production adapter, its
 * normalized types, the closed error model, and the conservative capability
 * defaults. The discovery client and CLI are intentionally NOT part of the
 * production adapter surface and are imported directly from their modules when
 * an operator runs the opt-in discovery command.
 */
export { CollectivIQHttpAdapter } from "./adapter.js";
export {
  UpstreamError,
  classifyTransportFailure,
  upstreamErrorForStatus,
  type UpstreamErrorCategory,
  type UpstreamErrorCode,
} from "./errors.js";
export {
  DEFAULT_OPERATION_TIMEOUTS,
  DEFAULT_UPSTREAM_CAPABILITIES,
  type CollectivIQAdapter,
  type CollectivIQTransportConfig,
  type CoreOperation,
  type CreateThreadInput,
  type CreateThreadResult,
  type FetchLike,
  type GetMessagesResult,
  type OperationTimeouts,
  type ProcessMessageInput,
  type ProcessMessageResult,
  type UpstreamCapabilities,
  type UpstreamMessage,
} from "./types.js";
