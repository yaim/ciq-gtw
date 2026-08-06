/**
 * Network helper for the opt-in OpenAPI tooling. Isolated here so the pure
 * filter (`filter.ts`) and its tests never import anything that performs I/O.
 *
 * Hardening: the retrieval targets ONLY the fixed public source URL (callers
 * cannot supply an arbitrary URL), enforces an overall deadline with
 * cancellation, requires a JSON-compatible content type, rejects an
 * over-declared `Content-Length` before reading, reads the body incrementally
 * and rejects as soon as the accumulated bytes exceed the cap (before the whole
 * body is buffered), cancels the reader/response on overflow/timeout/decode
 * failure, decodes strict UTF-8, and parses JSON only after the bounded read
 * completes. No credentials are ever sent. No dependencies are used.
 *
 * A `fetchImpl` may be injected for tests; the URL it is called with is always
 * the fixed source URL, so tests cannot enable an arbitrary production
 * destination.
 */
import { createHash } from "node:crypto";

/** The single authorized public source for the machine-readable contract. */
export const OPENAPI_SOURCE_URL = "https://api.prod.collectiviq.ai/openapi.json";

/** Maximum bytes accepted for the OpenAPI document (guards a hostile source). */
export const MAX_OPENAPI_BYTES = 16_777_216; // 16 MiB

/** Default overall deadline for the whole fetch+read, in milliseconds. */
export const DEFAULT_OPENAPI_TIMEOUT_MS = 30_000;

/** A minimal fetch surface, injected so retrieval is testable without a socket. */
export type OpenApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

export interface FetchedOpenApi {
  readonly doc: unknown;
  readonly sha256: string;
  readonly pathCount: number;
  readonly byteLength: number;
}

export interface FetchOpenApiOptions {
  /** Injected fetch (tests). Always invoked with the fixed source URL. */
  readonly fetchImpl?: OpenApiFetch;
  /** Overall deadline in ms (default {@link DEFAULT_OPENAPI_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Byte cap (default {@link MAX_OPENAPI_BYTES}); overridable for fast tests. */
  readonly maxBytes?: number;
  /** Optional caller cancellation, composed with the deadline. */
  readonly signal?: AbortSignal;
}

/** Raised for any retrieval/validation failure. Carries a stable, safe reason. */
export class OpenApiFetchError extends Error {
  constructor(reason: string) {
    super(`OpenAPI retrieval failed: ${reason}`);
    this.name = "OpenApiFetchError";
  }
}

/** UTC date (YYYY-MM-DD) for stamping a snapshot. Uses the real clock. */
export function utcDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Parse a `Content-Length` header into a non-negative integer, or null. */
function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read a response body incrementally into a single buffer under a byte cap.
 * Aborts and throws before the whole body is buffered once the cap is exceeded.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  abort: () => void,
): Promise<Uint8Array> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        abort();
        throw new OpenApiFetchError("body exceeds the maximum accepted size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch and parse the fixed public OpenAPI document under strict bounds.
 * Throws {@link OpenApiFetchError} on any failure. No credentials are sent.
 */
export async function fetchOpenApiDocument(
  options: FetchOpenApiOptions = {},
): Promise<FetchedOpenApi> {
  const fetchImpl: OpenApiFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAPI_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_OPENAPI_BYTES;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const abort = (): void => controller.abort();
  const cleanup = (): void => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  let response: Response;
  try {
    // The URL is always the fixed source; callers cannot substitute one.
    response = await fetchImpl(OPENAPI_SOURCE_URL, {
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    cleanup();
    throw new OpenApiFetchError(timedOut ? "timed out" : "network error");
  }

  try {
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenApiFetchError(`unexpected status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      await response.body?.cancel();
      throw new OpenApiFetchError("unexpected content type");
    }

    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new OpenApiFetchError("declared content length exceeds the maximum accepted size");
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, maxBytes, abort);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      if (error instanceof OpenApiFetchError) throw error;
      throw new OpenApiFetchError(timedOut ? "timed out" : "network error");
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OpenApiFetchError("body is not valid UTF-8");
    }

    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new OpenApiFetchError("body is not valid JSON");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pathCount =
      typeof doc === "object" && doc !== null && "paths" in doc && typeof doc.paths === "object"
        ? Object.keys(doc.paths as Record<string, unknown>).length
        : 0;
    return { doc, sha256, pathCount, byteLength: bytes.byteLength };
  } finally {
    cleanup();
  }
}
