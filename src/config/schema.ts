import { Type, type Static } from "typebox";

/**
 * Configuration schemas and typed shapes for the gateway scaffold.
 *
 * Only the settings consumed by the runnable foundation are modelled here.
 * Settings whose consumers do not exist yet are intentionally absent.
 */

export const ENVIRONMENTS = ["development", "staging", "production"] as const;
/** Upstream authentication modes; re-exported from the adapter's auth boundary. */
export { AUTH_MODES } from "../collectiviq/auth.js";
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export const TOOL_MODES = ["disabled", "emulated", "native"] as const;

/**
 * Prompt-serialization modes for a virtual model.
 *
 * - `protocol` (default): the normative, full-history `COLLECTIVIQ GATEWAY
 *   PROTOCOL` serializer — the fixed control-prompt header framing a versioned
 *   JSON envelope of the ENTIRE ordered conversation with declared roles
 *   (`src/prompts/conversation.ts`). This is the standard behaviour for every
 *   virtual model.
 * - `direct`: an account-specific, intentionally lossy compatibility profile
 *   that submits ONLY the latest normalized `user`-role message content,
 *   verbatim, with no protocol header, JSON envelope, role labels, markers,
 *   prefixes, suffixes, or other conversation messages (`src/prompts/direct.ts`).
 *   It deliberately omits system/developer instructions, assistant history, and
 *   every earlier user turn. It is NOT a role-preserving Chat Completions
 *   translation and MUST NOT be treated as prompt-injection prevention.
 */
export const PROMPT_MODES = ["protocol", "direct"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

/** Byte bounds for the accepted HTTP request body size. */
export const MAX_REQUEST_BODY_BYTES_MIN = 1024;
export const MAX_REQUEST_BODY_BYTES_MAX = 67_108_864; // 64 MiB

/**
 * Conservative, non-overridable bounds for the capacity and shutdown settings
 * (specification sections 19, 19.2, 31.3). These are initial implementation
 * safety limits; relaxing them is a configuration-contract change, not a runtime
 * override.
 *
 * The two ACTIVE limits are per replica while `SHARED_CAPACITY_ENABLED=false`
 * (the default) and CLUSTER-WIDE when it is `true` (Phase 4D, section 19.2). The
 * queue length and queue wait are always per replica, and the bounds themselves
 * are identical in both modes.
 */
export const CAPACITY_LIMITS = {
  /** Global active-request limit (per replica when local, cluster-wide when shared). */
  maxConcurrent: { min: 1, max: 1024 },
  /** Per-gateway-key active-request limit (must not exceed the global limit). */
  maxConcurrentPerKey: { min: 1, max: 1024 },
  /** Bounded FIFO queue length, always PER REPLICA (may be zero — no queueing). */
  maxQueued: { min: 0, max: 100_000 },
  /** Maximum time a request may wait in the admission queue, in ms. Always PER REPLICA. */
  maxQueueWaitMs: { min: 1, max: 600_000 },
  /** Graceful-shutdown drain period before in-flight work is cancelled, in ms. */
  shutdownDrainMs: { min: 0, max: 600_000 },
} as const;

/**
 * Conservative, non-overridable bounds for the configured client gateway keys.
 * These are initial implementation limits chosen for safety; relaxing them is a
 * configuration-contract/security change, not a runtime override. Byte length is
 * measured in UTF-8 bytes, not JavaScript string length. The same per-key byte
 * cap is applied to a presented token before it is hashed for comparison.
 */
export const GATEWAY_KEY_LIMITS = {
  /** Maximum number of configured gateway keys. */
  maxKeys: 64,
  /** Maximum size of a single gateway key, in UTF-8 bytes (8 KiB). */
  maxKeyBytes: 8192,
} as const;

/**
 * Conservative, non-overridable bounds for the OPTIONAL Redis-backed
 * idempotency layer (Phase 4A; specification sections 18, 22.2, 24). Redis is
 * disabled entirely when `REDIS_URL` is blank/absent. Relaxing any bound is a
 * configuration-contract/security change, not a runtime override.
 */
export const IDEMPOTENCY_LIMITS = {
  /**
   * Lifetime of a committed `final` record, in ms. Bounds the window in which a
   * repeated key replays a cached answer; protection is bounded to this TTL.
   */
  ttlMs: { min: 60_000, max: 3_600_000 },
  /** Allowed Redis key-namespace length, in characters. */
  keyPrefixLength: { min: 1, max: 64 },
  /** Exact master-key size, in bytes (AES-256 / HKDF input keying material). */
  encryptionKeyBytes: 32,
} as const;

/**
 * Conservative, non-overridable bounds for the OPTIONAL Redis-backed
 * cross-replica rate limiter (Phase 4B; specification sections 19.1, 24). The
 * feature is disabled entirely unless `RATE_LIMIT_ENABLED=true`, which
 * additionally requires a valid `REDIS_URL`. Relaxing any bound is a
 * configuration-contract/security change, not a runtime override.
 */
export const RATE_LIMIT_LIMITS = {
  /** Sustained requests admitted per window, per gateway key. */
  requests: { min: 1, max: 100_000 },
  /** The window the sustained rate is expressed over, in ms. */
  windowMs: { min: 1_000, max: 3_600_000 },
  /**
   * Requests admitted immediately from a cold scope. Must not exceed
   * `RATE_LIMIT_REQUESTS`: a burst larger than the window's own budget would let
   * one instant of traffic exceed the sustained limit it is meant to smooth.
   */
  burst: { min: 1, max: 10_000 },
} as const;

/**
 * Conservative, non-overridable bounds for the OPTIONAL Redis-backed OpenCode
 * thread reuse layer (Phase 5A; specification sections 5.1.1, 24). The feature
 * is disabled entirely unless `OPENCODE_THREAD_REUSE_ENABLED=true`, which
 * additionally requires a valid `REDIS_URL`. Relaxing any bound is a
 * configuration-contract/security change, not a runtime override.
 */
export const THREAD_REUSE_LIMITS = {
  /**
   * Sliding idle lifetime of an `active` mapping, in ms. Every completion that
   * uses the mapping resets it. The lower bound keeps a mapping alive across at
   * least one long completion plus a user pause; the upper bound (30 days)
   * caps how long a session may keep addressing one upstream thread.
   */
  ttlMs: { min: 300_000, max: 2_592_000_000 },
} as const;

// The OPTIONAL Redis-backed cross-replica capacity layer (Phase 4D;
// specification section 19.2) deliberately has NO bounds object of its own, so
// there is nothing to declare here. It introduces exactly ONE flag,
// `SHARED_CAPACITY_ENABLED`, and no numeric setting: enabling it REINTERPRETS
// `MAX_CONCURRENT_REQUESTS` and `MAX_CONCURRENT_REQUESTS_PER_KEY` as
// cluster-wide active limits under the same `CAPACITY_LIMITS` bounds above. It
// adds no secret and no dependency, and it requires a valid `REDIS_URL` (and
// therefore `IDEMPOTENCY_ENCRYPTION_KEY`). Every bound that boundary enforces
// internally is fixed in `src/shared-capacity/limits.ts`.

/**
 * Conservative, non-overridable bounds for the OPTIONAL observability layer
 * (specification sections 23.2, 23.3, 24). Both metrics and tracing are
 * disabled by default; enabling tracing additionally requires a canonical OTLP
 * traces endpoint. Relaxing any bound is a configuration-contract/security
 * change, not a runtime override.
 */
export const TRACING_LIMITS = {
  /**
   * Root-span sampling probability. `0` records nothing, `1` records every
   * root span. Bounded so a mistyped value can never be interpreted as a
   * percentage or a multiplier.
   */
  sampleRatio: { min: 0, max: 1 },
  /**
   * Maximum size of `TRACING_OTLP_ENDPOINT`, in UTF-8 bytes (not string
   * length). An operator-authored collector endpoint is an origin plus a short
   * traces path, so this is generous by orders of magnitude; it exists so an
   * oversized environment value is rejected outright instead of being handed to
   * the URL parser.
   */
  endpointBytes: 2048,
} as const;

/** Allowed characters for `REDIS_KEY_PREFIX` (a value-free operational namespace). */
export const REDIS_KEY_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Canonical, unpadded base64url encoding of exactly
 * {@link IDEMPOTENCY_LIMITS.encryptionKeyBytes} bytes (43 characters). The
 * loader additionally re-encodes the decoded bytes and requires an exact
 * round-trip, so a non-canonical trailing-bit encoding is rejected.
 */
export const IDEMPOTENCY_ENCRYPTION_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Conservative, non-overridable foundation limits for the model configuration
 * file. Relaxing any of these is a configuration-contract/security change, not
 * a runtime override. See `.agent/docs/tech-software-spec.md` section 24.
 */
export const MODEL_CONFIG_LIMITS = {
  /** Maximum size of the model YAML file, in bytes (1 MiB). */
  fileBytes: 1_048_576,
  /** Allowed number of virtual models. */
  models: { min: 1, max: 64 },
  /** Allowed number of selected sources per model. */
  selectedLlms: { min: 1, max: 32 },
  /** Allowed model-id length, in characters. */
  modelIdLength: { min: 1, max: 128 },
  /** Allowed display-name length, in characters. */
  displayNameLength: { min: 1, max: 256 },
  /** Allowed source / answer-source length, in characters. */
  sourceLength: { min: 1, max: 128 },
  /** Allowed request timeout, in milliseconds. */
  requestTimeoutMs: { min: 1_000, max: 600_000 },
  /** Allowed base poll interval, in milliseconds. */
  pollIntervalMs: { min: 100, max: 60_000 },
  /** Allowed maximum poll interval, in milliseconds. */
  maxPollIntervalMs: { min: 100, max: 60_000 },
  /** Allowed maximum prompt size, in bytes. */
  maximumPromptBytes: { min: 1_024, max: 67_108_864 },
} as const;

/** Defaults applied when an optional environment variable is absent. */
export const ENV_DEFAULTS = {
  ENVIRONMENT: "production",
  HOST: "127.0.0.1",
  PORT: 8787,
  COLLECTIVIQ_BASE_URL: "https://api.prod.collectiviq.ai",
  COLLECTIVIQ_AUTH_MODE: "bearer",
  MODEL_CONFIG_PATH: "./config/models.yaml",
  LOG_LEVEL: "info",
  LOG_CONTENT: false,
  MAX_REQUEST_BODY_BYTES: 8_388_608, // 8 MiB
  MAX_CONCURRENT_REQUESTS: 4,
  MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
  MAX_QUEUED_REQUESTS: 20,
  MAX_QUEUE_WAIT_MS: 5_000,
  // Optional Redis-backed cross-replica capacity (Phase 4D, specification
  // section 19.2). OFF by default, in which case the two active limits above are
  // per replica exactly as before and no capacity Redis operation ever runs.
  SHARED_CAPACITY_ENABLED: false,
  SHUTDOWN_DRAIN_MS: 30_000,
  IDEMPOTENCY_TTL_MS: 600_000, // 10 minutes (specification section 18)
  REDIS_KEY_PREFIX: "collectiviq-gateway",
  // Optional cross-replica rate limiting (Phase 4B, specification section 19.1).
  // OFF by default; the remaining values are validated regardless so the
  // configuration shape is stable whether or not the feature is enabled.
  RATE_LIMIT_ENABLED: false,
  RATE_LIMIT_REQUESTS: 60,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_BURST: 8,
  // Optional Redis-backed OpenCode thread reuse (Phase 5A, specification
  // section 5.1.1). OFF by default; the TTL is validated regardless so the
  // configuration shape is stable whether or not the feature is enabled.
  OPENCODE_THREAD_REUSE_ENABLED: false,
  OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000, // 7 days
  // Optional observability (specification sections 23.2, 23.3). BOTH are OFF by
  // default: no `/metrics` route is registered and no tracer, exporter, or
  // sampler is constructed. The sample ratio is validated regardless so the
  // configuration shape is stable whether or not tracing is enabled.
  METRICS_ENABLED: false,
  TRACING_ENABLED: false,
  TRACING_SAMPLE_RATIO: 1,
} as const;

/**
 * The coerced, validated environment configuration. Environment variables
 * arrive as strings and are coerced to these typed values before validation.
 */
export const EnvConfigSchema = Type.Object(
  {
    ENVIRONMENT: Type.Union([
      Type.Literal("development"),
      Type.Literal("staging"),
      Type.Literal("production"),
    ]),
    HOST: Type.String({ minLength: 1 }),
    PORT: Type.Integer({ minimum: 1, maximum: 65_535 }),
    COLLECTIVIQ_BASE_URL: Type.String({ minLength: 1 }),
    COLLECTIVIQ_AUTH_MODE: Type.Union([Type.Literal("bearer"), Type.Literal("password")]),
    // Credentials are conditionally present by mode; the loader enforces presence
    // and byte bounds per the active mode and preserves values exactly. Only the
    // active-mode fields are populated on the validated candidate.
    COLLECTIVIQ_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
    COLLECTIVIQ_USERNAME: Type.Optional(Type.String({ minLength: 1 })),
    COLLECTIVIQ_PASSWORD: Type.Optional(Type.String({ minLength: 1 })),
    COLLECTIVIQ_GATEWAY_KEYS: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: GATEWAY_KEY_LIMITS.maxKeys,
      uniqueItems: true,
    }),
    MODEL_CONFIG_PATH: Type.String({ minLength: 1 }),
    LOG_LEVEL: Type.Union([
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
      Type.Literal("fatal"),
      Type.Literal("silent"),
    ]),
    LOG_CONTENT: Type.Boolean(),
    MAX_REQUEST_BODY_BYTES: Type.Integer({
      minimum: MAX_REQUEST_BODY_BYTES_MIN,
      maximum: MAX_REQUEST_BODY_BYTES_MAX,
    }),
    MAX_CONCURRENT_REQUESTS: Type.Integer({
      minimum: CAPACITY_LIMITS.maxConcurrent.min,
      maximum: CAPACITY_LIMITS.maxConcurrent.max,
    }),
    MAX_CONCURRENT_REQUESTS_PER_KEY: Type.Integer({
      minimum: CAPACITY_LIMITS.maxConcurrentPerKey.min,
      maximum: CAPACITY_LIMITS.maxConcurrentPerKey.max,
    }),
    MAX_QUEUED_REQUESTS: Type.Integer({
      minimum: CAPACITY_LIMITS.maxQueued.min,
      maximum: CAPACITY_LIMITS.maxQueued.max,
    }),
    MAX_QUEUE_WAIT_MS: Type.Integer({
      minimum: CAPACITY_LIMITS.maxQueueWaitMs.min,
      maximum: CAPACITY_LIMITS.maxQueueWaitMs.max,
    }),
    // Optional Redis-backed cross-replica capacity (Phase 4D). Disabled by
    // default; enabling it requires a valid REDIS_URL (enforced by the loader)
    // and adds no numeric setting of its own.
    SHARED_CAPACITY_ENABLED: Type.Boolean(),
    SHUTDOWN_DRAIN_MS: Type.Integer({
      minimum: CAPACITY_LIMITS.shutdownDrainMs.min,
      maximum: CAPACITY_LIMITS.shutdownDrainMs.max,
    }),
    // Optional Redis-backed idempotency (Phase 4A). A blank/absent REDIS_URL
    // disables Redis entirely and BOTH optional fields stay absent; when Redis
    // is enabled the loader requires the encryption key and populates both. The
    // TTL and namespace always carry their validated defaults so the shape is
    // stable whether or not Redis is enabled.
    REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
    IDEMPOTENCY_ENCRYPTION_KEY: Type.Optional(Type.String({ minLength: 1 })),
    IDEMPOTENCY_TTL_MS: Type.Integer({
      minimum: IDEMPOTENCY_LIMITS.ttlMs.min,
      maximum: IDEMPOTENCY_LIMITS.ttlMs.max,
    }),
    REDIS_KEY_PREFIX: Type.String({
      minLength: IDEMPOTENCY_LIMITS.keyPrefixLength.min,
      maxLength: IDEMPOTENCY_LIMITS.keyPrefixLength.max,
    }),
    // Optional Redis-backed cross-replica rate limiting (Phase 4B). Disabled by
    // default; enabling it requires a valid REDIS_URL (enforced by the loader).
    // The three numeric fields always carry validated values so the shape is
    // stable whether or not the feature is enabled.
    RATE_LIMIT_ENABLED: Type.Boolean(),
    RATE_LIMIT_REQUESTS: Type.Integer({
      minimum: RATE_LIMIT_LIMITS.requests.min,
      maximum: RATE_LIMIT_LIMITS.requests.max,
    }),
    RATE_LIMIT_WINDOW_MS: Type.Integer({
      minimum: RATE_LIMIT_LIMITS.windowMs.min,
      maximum: RATE_LIMIT_LIMITS.windowMs.max,
    }),
    RATE_LIMIT_BURST: Type.Integer({
      minimum: RATE_LIMIT_LIMITS.burst.min,
      maximum: RATE_LIMIT_LIMITS.burst.max,
    }),
    // Optional Redis-backed OpenCode thread reuse (Phase 5A). Disabled by
    // default; enabling it requires a valid REDIS_URL (enforced by the loader).
    // The TTL always carries a validated value so the shape is stable whether
    // or not the feature is enabled.
    OPENCODE_THREAD_REUSE_ENABLED: Type.Boolean(),
    OPENCODE_THREAD_REUSE_TTL_MS: Type.Integer({
      minimum: THREAD_REUSE_LIMITS.ttlMs.min,
      maximum: THREAD_REUSE_LIMITS.ttlMs.max,
    }),
    // Optional observability (specification sections 23.2, 23.3). Both flags
    // default to false. The OTLP endpoint stays absent unless it validated, and
    // the loader requires it whenever tracing is enabled; the sample ratio
    // always carries a validated value so the shape is stable either way.
    METRICS_ENABLED: Type.Boolean(),
    TRACING_ENABLED: Type.Boolean(),
    TRACING_OTLP_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
    TRACING_SAMPLE_RATIO: Type.Number({
      minimum: TRACING_LIMITS.sampleRatio.min,
      maximum: TRACING_LIMITS.sampleRatio.max,
    }),
  },
  { additionalProperties: false },
);

export type EnvConfig = Static<typeof EnvConfigSchema>;

/** Allowlisted virtual-model property names (used to build sanitized errors). */
export const MODEL_PROPERTY_NAMES = [
  "displayName",
  "selectedLlms",
  "generateCombined",
  "answerSource",
  "toolMode",
  "promptMode",
  "requestTimeoutMs",
  "pollIntervalMs",
  "maxPollIntervalMs",
  "maximumPromptBytes",
] as const;

/**
 * A virtual model definition as written in the model configuration file.
 * The map key in the file supplies the model `id`; it is not repeated here.
 * String canonicalization (rejecting blank/padded values) is enforced in the
 * loader, since JSON Schema length bounds do not detect surrounding whitespace.
 */
export const VirtualModelSchema = Type.Object(
  {
    displayName: Type.String({
      minLength: MODEL_CONFIG_LIMITS.displayNameLength.min,
      maxLength: MODEL_CONFIG_LIMITS.displayNameLength.max,
    }),
    selectedLlms: Type.Array(
      Type.String({
        minLength: MODEL_CONFIG_LIMITS.sourceLength.min,
        maxLength: MODEL_CONFIG_LIMITS.sourceLength.max,
      }),
      {
        minItems: MODEL_CONFIG_LIMITS.selectedLlms.min,
        maxItems: MODEL_CONFIG_LIMITS.selectedLlms.max,
        uniqueItems: true,
      },
    ),
    generateCombined: Type.Boolean(),
    answerSource: Type.String({
      minLength: MODEL_CONFIG_LIMITS.sourceLength.min,
      maxLength: MODEL_CONFIG_LIMITS.sourceLength.max,
    }),
    toolMode: Type.Union([
      Type.Literal("disabled"),
      Type.Literal("emulated"),
      Type.Literal("native"),
    ]),
    // Optional in the file for backward compatibility: an omitted `promptMode`
    // is normalized to `protocol` in the loader, so existing ignored/local model
    // files keep the full-history protocol serializer unchanged. Only the two
    // supported values are accepted; any other value is a value-free rejection.
    promptMode: Type.Optional(Type.Union([Type.Literal("protocol"), Type.Literal("direct")])),
    requestTimeoutMs: Type.Integer({
      minimum: MODEL_CONFIG_LIMITS.requestTimeoutMs.min,
      maximum: MODEL_CONFIG_LIMITS.requestTimeoutMs.max,
    }),
    pollIntervalMs: Type.Integer({
      minimum: MODEL_CONFIG_LIMITS.pollIntervalMs.min,
      maximum: MODEL_CONFIG_LIMITS.pollIntervalMs.max,
    }),
    maxPollIntervalMs: Type.Integer({
      minimum: MODEL_CONFIG_LIMITS.maxPollIntervalMs.min,
      maximum: MODEL_CONFIG_LIMITS.maxPollIntervalMs.max,
    }),
    maximumPromptBytes: Type.Integer({
      minimum: MODEL_CONFIG_LIMITS.maximumPromptBytes.min,
      maximum: MODEL_CONFIG_LIMITS.maximumPromptBytes.max,
    }),
  },
  { additionalProperties: false },
);

export type VirtualModelDefinition = Static<typeof VirtualModelSchema>;

/**
 * Top-level model-file shape only: exactly a `models` object of unvalidated
 * entries. Each entry is validated separately so sanitized errors can use
 * ordinal locations instead of reproducing model-id map keys.
 */
export const ModelsFileShapeSchema = Type.Object(
  {
    models: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

/**
 * A resolved virtual model, with its id promoted from the map key and its
 * `promptMode` NORMALIZED to an explicit value. The loader always populates
 * `promptMode` (defaulting an omitted file field to `protocol`), so the internal
 * policy never carries `undefined` and prompt behaviour is driven from this
 * validated field — never from a model-id string comparison.
 */
export interface VirtualModel extends VirtualModelDefinition {
  readonly id: string;
  readonly promptMode: PromptMode;
}

/** Immutable application configuration returned by the loader. */
export interface AppConfig extends EnvConfig {
  readonly models: readonly VirtualModel[];
}
