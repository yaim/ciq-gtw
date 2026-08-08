/**
 * Public types for the CollectivIQ adapter boundary.
 *
 * These are the ONLY shapes other layers may depend on. Endpoint paths, form
 * and query field names, wire encodings, and upstream status handling stay
 * inside this package (`adapter.ts`, `http.ts`). Every result here is already
 * validated and normalized; every failure is a normalized `UpstreamError`.
 *
 * Response shapes are PROVISIONAL: the source OpenAPI document declares empty
 * (`{}`) success schemas, so the success validation below is the gateway's own
 * minimal contract, not an upstream-guaranteed one. It is intentionally lax
 * (ignore unknown fields) and clearly labeled until live discovery verifies it.
 */

/** A minimal fetch surface, injected so the transport is fully testable. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * An opaque credential lease handed to the transport for a single request.
 *
 * `generation` identifies the token instance a provider minted; it lets a
 * provider apply generation-safe invalidation (a late `401` from a request that
 * used an old token must never clear a newer token). `token` is the bearer value
 * the transport/SSE internals attach; it is never serialized, logged, or exposed
 * outside the transport boundary.
 */
export interface CredentialLease {
  readonly generation: number;
  readonly token: string;
}

/**
 * The shared upstream-credential boundary used by the production adapter,
 * discovery, SSE, deletion, and recovery tooling. Implementations live in
 * `auth.ts` (a static bearer provider and an OAuth password-exchange provider);
 * this interface is the only shape the transport depends on.
 *
 * `acquire` returns a lease (optionally honouring caller cancellation, e.g. by
 * detaching from an in-flight login). `invalidate` marks a specific lease's
 * token unusable so the next distinct request obtains a fresh one; it must be
 * generation-safe. Neither method exposes the credential through serialization
 * or logging.
 */
export interface CollectivIQCredentialProvider {
  acquire(signal?: AbortSignal): Promise<CredentialLease>;
  invalidate(lease: CredentialLease): void;
}

/**
 * The origin/transport-only fields shared by authenticated and unauthenticated
 * request paths. The login path uses this WITHOUT a credential provider so it
 * can never recursively ask for credentials.
 */
export interface TransportBase {
  /** Validated absolute base URL (e.g. `https://api.prod.collectiviq.ai`). */
  readonly baseUrl: string;
  /** Injected fetch implementation (defaults to global `fetch`). */
  readonly fetch?: FetchLike;
}

/** Per-operation transport bounds. */
export interface OperationTimeouts {
  /** Deadline to receive response headers (includes connect), in ms. */
  readonly headerTimeoutMs: number;
  /** Deadline to finish reading the response body after headers, in ms. */
  readonly bodyTimeoutMs: number;
  /** Maximum accepted response body size, in bytes. */
  readonly maxResponseBytes: number;
}

/** Transport configuration for the adapter/discovery client. */
export interface CollectivIQTransportConfig extends TransportBase {
  /**
   * The shared credential provider. The transport acquires a lease per request
   * and attaches its bearer token; the raw credential is never stored on the
   * config, logged, or serialized.
   */
  readonly credentials: CollectivIQCredentialProvider;
  /** Per-operation timeouts; sensible defaults are applied when omitted. */
  readonly timeouts?: Partial<Record<CoreOperation, OperationTimeouts>>;
}

/** The three core operations the production adapter performs. */
export type CoreOperation = "createThread" | "processMessage" | "getMessages";

// --- Adapter inputs / results (see spec section 8.5) --------------------------

export interface CreateThreadInput {
  /** A generic, content-free thread title. Never derived from prompt content. */
  readonly title: string;
  readonly signal?: AbortSignal;
}

export interface CreateThreadResult {
  /** Normalized to a string regardless of upstream integer/string form. */
  readonly threadId: string;
  readonly rawStatus: number;
}

export interface ProcessMessageInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly selectedLlms: readonly string[];
  readonly generateCombined: boolean;
  readonly signal?: AbortSignal;
}

export interface ProcessMessageResult {
  /** True only after minimal provisional success validation passed. */
  readonly accepted: boolean;
  readonly rawStatus: number;
}

/** A validated, normalized upstream message. Optional fields normalize to null. */
export interface UpstreamMessage {
  readonly source: string;
  readonly content: string | null;
  readonly percentUsage: number | null;
  /** Provisional field (upstream key/name unverified). */
  readonly createdAt: string | number | null;
  /** Provisional field (upstream key/name unverified). */
  readonly id: string | number | null;
}

export interface GetMessagesResult {
  readonly messages: readonly UpstreamMessage[];
  readonly rawStatus: number;
}

/** The narrow production adapter contract (spec section 8.5). */
export interface CollectivIQAdapter {
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;
  processMessage(input: ProcessMessageInput): Promise<ProcessMessageResult>;
  getMessages(threadId: string, signal?: AbortSignal): Promise<GetMessagesResult>;
}

/**
 * Upstream capability flags (spec section 13). Every capability defaults to
 * false until official documentation or repeatable sanitized contract evidence
 * proves otherwise. The presence of unrelated endpoints does not flip a flag.
 */
export interface UpstreamCapabilities {
  readonly nativeToolDefinitions: boolean;
  readonly nativeToolResults: boolean;
  readonly requestScopedStreaming: boolean;
  readonly cancellation: boolean;
  readonly tokenUsage: boolean;
}

/** The conservative default capability set. */
export const DEFAULT_UPSTREAM_CAPABILITIES: UpstreamCapabilities = {
  nativeToolDefinitions: false,
  nativeToolResults: false,
  requestScopedStreaming: false,
  cancellation: false,
  tokenUsage: false,
};

/** Default per-operation transport bounds (spec section 17). */
export const DEFAULT_OPERATION_TIMEOUTS: Record<CoreOperation, OperationTimeouts> = {
  createThread: { headerTimeoutMs: 20_000, bodyTimeoutMs: 20_000, maxResponseBytes: 1_048_576 },
  processMessage: { headerTimeoutMs: 20_000, bodyTimeoutMs: 20_000, maxResponseBytes: 1_048_576 },
  getMessages: { headerTimeoutMs: 15_000, bodyTimeoutMs: 15_000, maxResponseBytes: 4_194_304 },
};
