import { Type, type Static } from "typebox";

/**
 * Configuration schemas and typed shapes for the gateway scaffold.
 *
 * Only the settings consumed by the runnable foundation are modelled here.
 * Completion, upstream, tool, and Redis settings are intentionally absent
 * until the components that consume them exist.
 */

export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export const TOOL_MODES = ["disabled", "emulated", "native"] as const;

/** Byte bounds for the accepted HTTP request body size. */
export const MAX_REQUEST_BODY_BYTES_MIN = 1024;
export const MAX_REQUEST_BODY_BYTES_MAX = 67_108_864; // 64 MiB

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
  MODEL_CONFIG_PATH: "./config/models.yaml",
  LOG_LEVEL: "info",
  LOG_CONTENT: false,
  MAX_REQUEST_BODY_BYTES: 8_388_608, // 8 MiB
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
    COLLECTIVIQ_API_KEY: Type.String({ minLength: 1 }),
    COLLECTIVIQ_GATEWAY_KEYS: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
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

/** A resolved virtual model, with its id promoted from the map key. */
export interface VirtualModel extends VirtualModelDefinition {
  readonly id: string;
}

/** Immutable application configuration returned by the loader. */
export interface AppConfig extends EnvConfig {
  readonly models: readonly VirtualModel[];
}
