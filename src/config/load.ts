import { readFileSync, statSync, type Stats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  validateBearerToken,
  validatePassword,
  validateUsername,
  type AuthMode,
} from "../collectiviq/auth.js";
import {
  ENV_DEFAULTS,
  EnvConfigSchema,
  MODEL_CONFIG_LIMITS,
  MODEL_PROPERTY_NAMES,
  ModelsFileShapeSchema,
  VirtualModelSchema,
  type AppConfig,
  type EnvConfig,
  type VirtualModel,
  type VirtualModelDefinition,
} from "./schema.js";

/** A single, value-free configuration problem. */
export interface ConfigIssue {
  readonly field: string;
  readonly reason: string;
}

/**
 * Raised when configuration is invalid. Carries a list of field/reason pairs.
 * Neither the message nor the issues ever contain submitted values, model-file
 * contents, model IDs, unknown property names, library error text, or resolved
 * filesystem paths — only stable allowlisted fields and reasons.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`configuration validation failed (${issues.length} issue(s))`);
    this.name = "ConfigError";
    this.issues = issues;
  }

  /** A multi-line, value-free summary suitable for stderr. */
  format(): string {
    return [this.message, ...this.issues.map((i) => `  - ${i.field}: ${i.reason}`)].join("\n");
  }
}

/** The environment variables the scaffold understands. */
const KNOWN_ENV_KEYS = [
  "ENVIRONMENT",
  "HOST",
  "PORT",
  "COLLECTIVIQ_BASE_URL",
  "COLLECTIVIQ_AUTH_MODE",
  "COLLECTIVIQ_API_KEY",
  "COLLECTIVIQ_USERNAME",
  "COLLECTIVIQ_PASSWORD",
  "COLLECTIVIQ_GATEWAY_KEYS",
  "MODEL_CONFIG_PATH",
  "LOG_LEVEL",
  "LOG_CONTENT",
  "MAX_REQUEST_BODY_BYTES",
] as const;

export interface LoadConfigOptions {
  /** Environment source; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Base directory for resolving a relative `MODEL_CONFIG_PATH`. */
  readonly cwd?: string;
}

type KnownEnvKey = (typeof KNOWN_ENV_KEYS)[number];

/** Extract only the keys we recognize; ignore everything else in the environment. */
function extractKnownEnv(source: NodeJS.ProcessEnv): Record<KnownEnvKey, string | undefined> {
  const out = {} as Record<KnownEnvKey, string | undefined>;
  for (const key of KNOWN_ENV_KEYS) {
    out[key] = source[key];
  }
  return out;
}

function present(raw: string | undefined): raw is string {
  return raw !== undefined && raw.trim() !== "";
}

function coerceInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function coerceBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Split, trim, drop empties, and de-duplicate a comma-separated key list. */
function parseGatewayKeys(raw: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      keys.push(trimmed);
    }
  }
  return keys;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A non-empty string with no leading/trailing whitespace (case preserved). */
function isCanonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** Map a JSON-Schema validation keyword to a stable, value-free reason. */
function reasonForKeyword(keyword: string): string {
  switch (keyword) {
    case "required":
      return "is required";
    case "type":
      return "has invalid type";
    case "enum":
    case "const":
    case "anyOf":
      return "has unsupported value";
    case "minLength":
    case "maxLength":
      return "length is outside allowed bounds";
    case "minItems":
    case "maxItems":
      return "item count is outside allowed bounds";
    case "uniqueItems":
      return "items must be unique";
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return "is outside allowed range";
    case "additionalProperties":
      return "contains an unknown field";
    default:
      return "is invalid";
  }
}

/** Top-level segment of a TypeBox instance path (e.g. `/a/b` -> `a`). */
function firstPathSegment(instancePath: string): string | undefined {
  const segment = instancePath.split("/")[1];
  return segment === undefined || segment === "" ? undefined : segment;
}

/** Collect stable env issues from a schema validation (env keys are static). */
function envSchemaIssues(schema: TSchema, value: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const error of Value.Errors(schema, value)) {
    const key = firstPathSegment(error.instancePath) ?? "(root)";
    issues.push({ field: key, reason: reasonForKeyword(error.keyword) });
  }
  return issues;
}

function dedupeIssues(issues: ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.field}::${issue.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

function loadEnvConfig(source: NodeJS.ProcessEnv): EnvConfig {
  const raw = extractKnownEnv(source);
  const issues: ConfigIssue[] = [];

  const environment = present(raw.ENVIRONMENT) ? raw.ENVIRONMENT.trim() : ENV_DEFAULTS.ENVIRONMENT;
  const host = present(raw.HOST) ? raw.HOST.trim() : ENV_DEFAULTS.HOST;
  const baseUrl = present(raw.COLLECTIVIQ_BASE_URL)
    ? raw.COLLECTIVIQ_BASE_URL.trim()
    : ENV_DEFAULTS.COLLECTIVIQ_BASE_URL;
  const modelConfigPath = present(raw.MODEL_CONFIG_PATH)
    ? raw.MODEL_CONFIG_PATH.trim()
    : ENV_DEFAULTS.MODEL_CONFIG_PATH;
  const logLevel = present(raw.LOG_LEVEL) ? raw.LOG_LEVEL.trim() : ENV_DEFAULTS.LOG_LEVEL;

  let port: number = ENV_DEFAULTS.PORT;
  if (present(raw.PORT)) {
    const parsed = coerceInteger(raw.PORT);
    if (parsed === undefined) issues.push({ field: "PORT", reason: "must be an integer" });
    else port = parsed;
  }

  let maxBody: number = ENV_DEFAULTS.MAX_REQUEST_BODY_BYTES;
  if (present(raw.MAX_REQUEST_BODY_BYTES)) {
    const parsed = coerceInteger(raw.MAX_REQUEST_BODY_BYTES);
    if (parsed === undefined) {
      issues.push({ field: "MAX_REQUEST_BODY_BYTES", reason: "must be an integer" });
    } else {
      maxBody = parsed;
    }
  }

  let logContent: boolean = ENV_DEFAULTS.LOG_CONTENT;
  if (present(raw.LOG_CONTENT)) {
    const parsed = coerceBoolean(raw.LOG_CONTENT);
    if (parsed === undefined) {
      issues.push({ field: "LOG_CONTENT", reason: 'must be "true" or "false"' });
    } else {
      logContent = parsed;
    }
  }

  // Auth mode selects which upstream credential is required and validated. The
  // inactive mode's credentials may be present but are ignored (not read into
  // the validated config). All credential errors are value-free.
  let mode: AuthMode | null;
  const rawMode = present(raw.COLLECTIVIQ_AUTH_MODE)
    ? raw.COLLECTIVIQ_AUTH_MODE.trim().toLowerCase()
    : ENV_DEFAULTS.COLLECTIVIQ_AUTH_MODE;
  if (rawMode === "bearer" || rawMode === "password") {
    mode = rawMode;
  } else {
    mode = null;
    issues.push({ field: "COLLECTIVIQ_AUTH_MODE", reason: "has unsupported value" });
  }

  let apiKey: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  if (mode === "bearer") {
    // Bearer token is preserved EXACTLY (no trimming), bounded to 16 KiB.
    const token = validateBearerToken(raw.COLLECTIVIQ_API_KEY);
    if (!token.ok) issues.push({ field: "COLLECTIVIQ_API_KEY", reason: token.reason });
    else apiKey = token.value;
  } else if (mode === "password") {
    const user = validateUsername(raw.COLLECTIVIQ_USERNAME);
    if (!user.ok) issues.push({ field: "COLLECTIVIQ_USERNAME", reason: user.reason });
    else username = user.value;
    // Password is preserved EXACTLY, including leading/trailing whitespace.
    const pass = validatePassword(raw.COLLECTIVIQ_PASSWORD);
    if (!pass.ok) issues.push({ field: "COLLECTIVIQ_PASSWORD", reason: pass.reason });
    else password = pass.value;
  }

  let gatewayKeys: string[] = [];
  if (!present(raw.COLLECTIVIQ_GATEWAY_KEYS)) {
    issues.push({ field: "COLLECTIVIQ_GATEWAY_KEYS", reason: "is required" });
  } else {
    gatewayKeys = parseGatewayKeys(raw.COLLECTIVIQ_GATEWAY_KEYS);
    if (gatewayKeys.length === 0) {
      issues.push({
        field: "COLLECTIVIQ_GATEWAY_KEYS",
        reason: "must contain at least one non-empty key",
      });
    }
  }

  if (!isHttpUrl(baseUrl)) {
    issues.push({
      field: "COLLECTIVIQ_BASE_URL",
      reason: "must be a valid absolute http(s) URL",
    });
  }

  const candidate = {
    ENVIRONMENT: environment,
    HOST: host,
    PORT: port,
    COLLECTIVIQ_BASE_URL: baseUrl,
    // When the mode itself was invalid an issue is already recorded; a placeholder
    // keeps structural validation from double-reporting and is never emitted.
    COLLECTIVIQ_AUTH_MODE: mode ?? ENV_DEFAULTS.COLLECTIVIQ_AUTH_MODE,
    // Only the active mode's validated credentials are populated (preserved
    // exactly). A required-but-missing/invalid credential is reported above; its
    // field is then simply absent here (the schema field is optional), so
    // structural validation never double-reports it.
    ...(apiKey !== undefined ? { COLLECTIVIQ_API_KEY: apiKey } : {}),
    ...(username !== undefined ? { COLLECTIVIQ_USERNAME: username } : {}),
    ...(password !== undefined ? { COLLECTIVIQ_PASSWORD: password } : {}),
    COLLECTIVIQ_GATEWAY_KEYS: gatewayKeys.length > 0 ? gatewayKeys : ["unset"],
    MODEL_CONFIG_PATH: modelConfigPath,
    LOG_LEVEL: logLevel,
    LOG_CONTENT: logContent,
    MAX_REQUEST_BODY_BYTES: maxBody,
  };

  // Structural/enum/bounds validation. Reasons are generic; env keys are static.
  issues.push(...envSchemaIssues(EnvConfigSchema, candidate));

  // Cross-field policy: content logging is only acceptable in development, and
  // even then this scaffold never logs content (only the startup warning).
  if (logContent && environment !== "development") {
    issues.push({
      field: "LOG_CONTENT",
      reason: "may only be true when ENVIRONMENT=development",
    });
  }

  if (issues.length > 0) throw new ConfigError(dedupeIssues(issues));
  return candidate as EnvConfig;
}

/** A fixed, path-free MODEL_CONFIG_PATH failure. */
function modelPathError(reason: string): never {
  throw new ConfigError([{ field: "MODEL_CONFIG_PATH", reason }]);
}

/** Read the model file with a byte bound and safe UTF-8 decoding. */
function readModelFile(path: string): string {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    // Do not echo the resolved path or the OS error.
    modelPathError("model configuration file could not be read");
  }
  if (!stats.isFile()) {
    modelPathError("must reference a regular file");
  }
  // Check size before reading to avoid loading an oversized file.
  if (stats.size > MODEL_CONFIG_LIMITS.fileBytes) {
    modelPathError("exceeds the maximum allowed size");
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    modelPathError("model configuration file could not be read");
  }
  // Recheck byte length after reading in case the file changed between stat/read.
  if (buffer.length > MODEL_CONFIG_LIMITS.fileBytes) {
    modelPathError("exceeds the maximum allowed size");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    modelPathError("is not valid UTF-8");
  }
}

/** Map a per-model schema error to a stable ordinal-located issue. */
function modelSchemaIssue(
  index: number,
  keyword: string,
  instancePath: string,
  missing?: unknown,
): ConfigIssue {
  let prop: string | undefined;
  const allowed = MODEL_PROPERTY_NAMES as readonly string[];
  if (keyword === "required" && typeof missing === "string" && allowed.includes(missing)) {
    prop = missing;
  } else {
    const segment = firstPathSegment(instancePath);
    if (segment !== undefined && allowed.includes(segment)) prop = segment;
  }
  const field = prop ? `models[${index}].${prop}` : `models[${index}]`;
  return { field, reason: reasonForKeyword(keyword) };
}

/** Validate one model definition; returns issues (ordinal-located, value-free). */
function validateModel(
  index: number,
  def: unknown,
): { issues: ConfigIssue[]; model?: VirtualModel } {
  const issues: ConfigIssue[] = [];
  for (const error of Value.Errors(VirtualModelSchema, def)) {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    issues.push(modelSchemaIssue(index, error.keyword, error.instancePath, missing));
  }
  if (issues.length > 0) return { issues: dedupeIssues(issues) };

  // Structurally valid: safe to read fields and apply canonical/cross-field rules.
  const model = def as VirtualModelDefinition;

  if (!isCanonicalString(model.displayName)) {
    issues.push({ field: `models[${index}].displayName`, reason: "is invalid" });
  }
  if (!isCanonicalString(model.answerSource)) {
    issues.push({ field: `models[${index}].answerSource`, reason: "is invalid" });
  }
  if (!model.selectedLlms.every((source) => isCanonicalString(source))) {
    issues.push({ field: `models[${index}].selectedLlms`, reason: "is invalid" });
  }

  if (model.answerSource === "combined" && !model.generateCombined) {
    issues.push({ field: `models[${index}].answerSource`, reason: "has unsupported value" });
  }
  if (model.answerSource !== "combined" && !model.selectedLlms.includes(model.answerSource)) {
    issues.push({ field: `models[${index}].answerSource`, reason: "has unsupported value" });
  }
  if (model.pollIntervalMs > model.maxPollIntervalMs) {
    issues.push({ field: `models[${index}].pollIntervalMs`, reason: "is outside allowed range" });
  }
  if (model.maxPollIntervalMs > model.requestTimeoutMs) {
    issues.push({
      field: `models[${index}].maxPollIntervalMs`,
      reason: "is outside allowed range",
    });
  }

  if (issues.length > 0) return { issues };
  return { issues, model: { id: "", ...model } };
}

function loadModels(env: EnvConfig, cwd: string): VirtualModel[] {
  const path = isAbsolute(env.MODEL_CONFIG_PATH)
    ? env.MODEL_CONFIG_PATH
    : resolve(cwd, env.MODEL_CONFIG_PATH);

  const text = readModelFile(path);

  let parsed: unknown;
  try {
    // Aliases disabled (maxAliasCount: 0) and duplicate keys rejected.
    parsed = parseYaml(text, { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    // Do not echo YAML error text, which can contain model-file contents.
    modelPathError("is not valid YAML, or contains duplicate keys or aliases");
  }

  // Validate the top-level shape only, then each model separately by ordinal.
  const shapeIssues: ConfigIssue[] = [];
  for (const error of Value.Errors(ModelsFileShapeSchema, parsed)) {
    const key = firstPathSegment(error.instancePath) ?? "(root)";
    shapeIssues.push({ field: key, reason: reasonForKeyword(error.keyword) });
  }
  if (shapeIssues.length > 0) throw new ConfigError(dedupeIssues(shapeIssues));

  const entries = Object.entries((parsed as { models: Record<string, unknown> }).models);
  const issues: ConfigIssue[] = [];

  if (
    entries.length < MODEL_CONFIG_LIMITS.models.min ||
    entries.length > MODEL_CONFIG_LIMITS.models.max
  ) {
    issues.push({ field: "models", reason: "item count is outside allowed bounds" });
  }

  const models: VirtualModel[] = [];
  entries.forEach(([id, def], index) => {
    // The map key is the model id; validate it without reproducing it in errors.
    if (
      !isCanonicalString(id) ||
      id.length < MODEL_CONFIG_LIMITS.modelIdLength.min ||
      id.length > MODEL_CONFIG_LIMITS.modelIdLength.max
    ) {
      issues.push({ field: `models[${index}].id`, reason: "is invalid" });
    }

    const result = validateModel(index, def);
    issues.push(...result.issues);
    if (result.model) models.push({ ...result.model, id });
  });

  if (issues.length > 0) throw new ConfigError(dedupeIssues(issues));
  return models;
}

/** Recursively freeze an object so the returned configuration is immutable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Load, coerce, and validate the environment and model configuration.
 * Throws {@link ConfigError} with value-free issues on any problem. Must be
 * called before the HTTP server is constructed or bound.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = loadEnvConfig(options.env ?? process.env);
  const models = loadModels(env, options.cwd ?? process.cwd());
  return deepFreeze({ ...env, models });
}
