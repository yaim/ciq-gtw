/**
 * Public types for the CollectivIQ adapter boundary.
 *
 * These are the ONLY shapes other layers may depend on. Endpoint paths, form
 * and query field names, wire encodings, and upstream status handling stay
 * inside this package (`adapter.ts`, `http.ts`). Every result here is already
 * validated and normalized; every failure is a normalized `UpstreamError`.
 *
 * Response shapes are a MIXED-EVIDENCE contract: the source OpenAPI document
 * declares empty (`{}`) success schemas, so the success validation below is the
 * gateway's own minimal contract, not an upstream-guaranteed one, and stays lax
 * (ignore unknown fields). Some safe field names/statuses are now
 * verified-repeatable (repeated identically across the two 2026-08-11 authorized
 * password baselines and encoded as synthetic fixtures); others — masked field
 * names and any field semantics — remain provisional. See per-field notes and
 * `.agent/docs/collectiviq-upstream-contract.md`.
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
  /**
   * Transport bounds for the OBSERVED-ONLY `get_threads` title lookup. Defaults to
   * {@link GET_THREADS_TIMEOUTS} (5 s/5 s/4 MiB). Injectable only so tests can
   * exercise the bounded read cheaply; production always uses the default.
   */
  readonly getThreadsTimeouts?: OperationTimeouts;
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
  /**
   * True only after the gateway's minimal success rule passed (a top-level
   * object with no own `detail`). This is a gateway-owned rule; it does not
   * assert the meaning of the observed upstream `status` field or whether the
   * `202` implies accepted-versus-failed work.
   */
  readonly accepted: boolean;
  readonly rawStatus: number;
}

/** A validated, normalized upstream message. Optional fields normalize to null. */
export interface UpstreamMessage {
  readonly source: string;
  readonly content: string | null;
  readonly percentUsage: number | null;
  /**
   * Creation timestamp. Mapped from the verified-repeatable upstream key
   * `create_time` (observed in both 2026-08-11 password baselines), with the
   * earlier `created_at` retained as a gateway-owned compatibility fallback.
   * The value's selection semantics are not yet verified.
   */
  readonly createdAt: string | number | null;
  /** Safe field name `id` observed repeatably; its selection semantics are unverified. */
  readonly id: string | number | null;
}

export interface GetMessagesResult {
  readonly messages: readonly UpstreamMessage[];
  readonly rawStatus: number;
}

/**
 * The normalized result of the OBSERVED-ONLY native-title lookup (`get_threads`).
 *
 * `pending` means the target thread has no server-generated title yet (it is
 * absent from the caller's threads, or its title is still the fixed `New Thread`
 * placeholder). `ready` carries the validated, content-bounded provider title.
 * A malformed structure is never represented here — the adapter throws a
 * normalized {@link UpstreamError} instead, so no raw upstream value escapes.
 *
 * This is best-effort, account/principal-dependent, provisional evidence — not a
 * documented, repeatable, or request-scoped upstream guarantee.
 */
export type GetThreadTitleResult =
  { readonly kind: "pending" } | { readonly kind: "ready"; readonly title: string };

/** The narrow production adapter contract (spec section 8.5). */
export interface CollectivIQAdapter {
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;
  processMessage(input: ProcessMessageInput): Promise<ProcessMessageResult>;
  getMessages(threadId: string, signal?: AbortSignal): Promise<GetMessagesResult>;
  /**
   * OBSERVED-ONLY native-title lookup: read the target thread's server-generated
   * title via `get_threads`. Best-effort and account/principal-dependent; it
   * creates no thread and is never part of the completion flow. Returns a narrow
   * pending/ready result, or throws a normalized {@link UpstreamError}.
   */
  getThreadTitle(threadId: string, signal?: AbortSignal): Promise<GetThreadTitleResult>;
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

/**
 * Transport bounds for the OBSERVED-ONLY `get_threads` title lookup. Kept
 * separate from {@link DEFAULT_OPERATION_TIMEOUTS} (the three core operations) so
 * the provisional bridge stays clearly outside the completion contract. 5 s
 * header + 5 s body deadlines, 4 MiB max body; no internal retry.
 */
export const GET_THREADS_TIMEOUTS: OperationTimeouts = {
  headerTimeoutMs: 5_000,
  bodyTimeoutMs: 5_000,
  maxResponseBytes: 4_194_304,
};

/** Maximum accepted UTF-8 byte length of a ready native title (before display truncation). */
export const MAX_NATIVE_TITLE_BYTES = 512;
