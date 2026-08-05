/**
 * Redaction and bounded sanitization helpers shared by the logger.
 *
 * `sanitizeLogValue` is the workhorse: it produces a bounded, credential-free,
 * side-effect-free copy of an arbitrary value suitable for structured logging.
 * It never invokes getters, never follows cycles, caps depth/width/length, and
 * strips credential-named fields and error internals. These helpers keep
 * credentials out of logs; they do not make it safe to log prompt, answer,
 * tool, or repository content — that content must never be logged at all.
 */

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/** Fixed markers substituted for values that cannot be safely reproduced. */
export const SANITIZE_MARKERS = {
  circular: "[circular]",
  truncated: "[truncated]",
  unsupported: "[unsupported]",
  depthExceeded: "[depth-exceeded]",
  error: "[unserializable]",
} as const;

/** Non-overridable bounds applied while sanitizing a value for logging. */
export const SANITIZE_LIMITS = {
  maxDepth: 8,
  maxProperties: 100,
  maxArrayItems: 100,
  maxStringLength: 1024,
} as const;

/**
 * Pino redaction paths for common credential shapes, retained as defense in
 * depth alongside `sanitizeLogValue`.
 */
export const REDACT_PATHS: readonly string[] = [
  "authorization",
  "*.authorization",
  "headers.authorization",
  "req.headers.authorization",
  "request.headers.authorization",
  "apiKey",
  "*.apiKey",
  "collectiviqApiKey",
  "*.collectiviqApiKey",
  "COLLECTIVIQ_API_KEY",
  "*.COLLECTIVIQ_API_KEY",
  "gatewayKey",
  "*.gatewayKey",
  "gatewayKeys",
  "*.gatewayKeys",
  "COLLECTIVIQ_GATEWAY_KEYS",
  "*.COLLECTIVIQ_GATEWAY_KEYS",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "password",
  "*.password",
];

/** Substrings that unambiguously mark a credential-bearing key. */
const SECRET_KEY_MARKERS = [
  "authorization",
  "apikey",
  "gatewaykey",
  "password",
  "secret",
  "credential",
];

/** Exact normalized key names that are always credentials. */
const SECRET_KEY_EXACT = new Set(["key", "token", "bearer"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether a property name denotes a credential whose value must be redacted. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  // Keys ending exactly in `token` (authToken, access_token, refreshToken, …)
  // are credentials; plural `tokens`/`tokenCount` usage metadata is not.
  if (normalized.endsWith("token")) return true;
  return SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Reduce an Error to fixed, allowlisted metadata. Never exposes message,
 * stack, cause, or arbitrary properties, and never reads `value.constructor`
 * (which could be a hostile accessor). The name is always the fixed literal
 * `"Error"`; `code` is included only when it is an own data property with a
 * short, safe value (an accessor `code` is never invoked).
 */
function safeError(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = { name: "Error" };

  const codeDescriptor = Object.getOwnPropertyDescriptor(value, "code");
  if (codeDescriptor && "value" in codeDescriptor) {
    const code: unknown = codeDescriptor.value;
    if (typeof code === "string" && SAFE_ERROR_CODE.test(code)) {
      out["code"] = code;
    } else if (typeof code === "number" && Number.isFinite(code)) {
      out["code"] = code;
    }
  }

  return out;
}

function truncateString(value: string): string {
  if (value.length <= SANITIZE_LIMITS.maxStringLength) return value;
  return value.slice(0, SANITIZE_LIMITS.maxStringLength) + SANITIZE_MARKERS.truncated;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;

  const type = typeof value;
  if (type === "string") return truncateString(value as string);
  if (type === "number") return Number.isFinite(value) ? value : SANITIZE_MARKERS.unsupported;
  if (type === "boolean") return value;
  if (type === "bigint") return truncateString(`${(value as bigint).toString()}n`);
  if (type === "symbol" || type === "function") return SANITIZE_MARKERS.unsupported;

  // Objects and arrays.
  if (depth >= SANITIZE_LIMITS.maxDepth) return SANITIZE_MARKERS.depthExceeded;

  const obj = value;
  if (seen.has(obj)) return SANITIZE_MARKERS.circular;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Read length and each element via descriptors so no index/length
      // accessor is ever invoked. Missing/sparse indices and accessor
      // descriptors become the unsupported marker. If descriptor inspection
      // itself throws (e.g. a hostile proxy), the outer catch fails closed.
      const lengthDescriptor = Object.getOwnPropertyDescriptor(obj, "length");
      const rawLength: unknown =
        lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : 0;
      const length =
        typeof rawLength === "number" && Number.isInteger(rawLength) && rawLength >= 0
          ? rawLength
          : 0;
      const out: unknown[] = [];
      const limit = Math.min(length, SANITIZE_LIMITS.maxArrayItems);
      for (let i = 0; i < limit; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, String(i));
        if (!descriptor || !("value" in descriptor)) {
          out.push(SANITIZE_MARKERS.unsupported);
          continue;
        }
        out.push(sanitizeInner(descriptor.value, depth + 1, seen));
      }
      if (length > SANITIZE_LIMITS.maxArrayItems) out.push(SANITIZE_MARKERS.truncated);
      return out;
    }

    if (obj instanceof Error) return safeError(obj);

    if (!isPlainObject(obj)) return SANITIZE_MARKERS.unsupported;

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (count >= SANITIZE_LIMITS.maxProperties) {
        out["__truncated__"] = SANITIZE_MARKERS.truncated;
        break;
      }
      count += 1;
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      if (!descriptor) continue;
      // Never invoke accessors.
      if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
        out[key] = SANITIZE_MARKERS.unsupported;
        continue;
      }
      out[key] = isSecretKey(key)
        ? REDACTION_PLACEHOLDER
        : sanitizeInner(descriptor.value, depth + 1, seen);
    }
    return out;
  } finally {
    // Allow shared (acyclic) references across siblings; only ancestors count as cycles.
    seen.delete(obj);
  }
}

/**
 * Produce a bounded, credential-free, side-effect-free copy of `input`.
 * On any internal failure returns a fixed marker rather than throwing, so
 * logging can never be broken by a hostile value.
 */
export function sanitizeLogValue(input: unknown): unknown {
  try {
    return sanitizeInner(input, 0, new WeakSet());
  } catch {
    return SANITIZE_MARKERS.error;
  }
}

/**
 * Sanitize a log record (the object shape Pino formatters must return).
 * Always returns an object; a non-object sanitizer result is wrapped.
 */
export function sanitizeLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeLogValue(record);
  if (sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { log: SANITIZE_MARKERS.error };
}
