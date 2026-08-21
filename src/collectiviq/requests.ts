/**
 * Pure request builders for the three core CollectivIQ operations.
 *
 * These encode the fixed HTTP method, fixed endpoint path, query construction,
 * and urlencoded/multipart body EXACTLY as the production adapter requires, with
 * no transport, deadline, credential, or normalization concern. The production
 * adapter and the opt-in discovery session share these builders so both emit an
 * identical wire request; the encodings here are the single source of truth for
 * field names and content types.
 *
 * Field/encoding contract (unchanged from the historical adapter):
 * - create_thread:  urlencoded `thread_title`, `is_title_from_user=false`,
 *   content type `application/x-www-form-urlencoded`.
 * - process_message: multipart `FormData` with `prompt`, `thread_id`,
 *   `selected_llms` (comma-joined), `generate_combined` ("true"/"false"),
 *   `llms_explicitly_set="true"`, and NO explicit content type (native
 *   multipart boundary).
 * - get_messages: GET with query `thread_id` only (no `since_id`), no body.
 */
import { ENDPOINTS } from "./endpoints.js";
import type { UpstreamHttpMethod } from "./errors.js";

const URLENCODED = "application/x-www-form-urlencoded";

/**
 * A fully encoded upstream request, independent of transport. Optional keys are
 * present only when they apply (never set to `undefined`) so callers can spread
 * the spec under `exactOptionalPropertyTypes`.
 */
export interface UpstreamRequestSpec {
  readonly method: UpstreamHttpMethod;
  /** Fixed path beginning with `/`. Never derived from external input. */
  readonly path: string;
  readonly query?: URLSearchParams;
  /** Request body (`URLSearchParams` or `FormData`); omitted for GET. */
  readonly body?: URLSearchParams | FormData;
  /** Explicit content type for urlencoded bodies; omitted for `FormData`. */
  readonly bodyContentType?: string;
}

/** Encode a `create_thread` request from a content-free generic title. */
export function buildCreateThreadRequest(input: { readonly title: string }): UpstreamRequestSpec {
  const body = new URLSearchParams();
  // Content-free, generic title only. Never derived from prompt/repo/file data.
  body.set("thread_title", input.title);
  body.set("is_title_from_user", "false");

  return {
    method: "POST",
    path: ENDPOINTS.createThread,
    body,
    bodyContentType: URLENCODED,
  };
}

/** Encode a `process_message` request as native multipart form data. */
export function buildProcessMessageRequest(input: {
  readonly threadId: string;
  readonly prompt: string;
  readonly selectedLlms: readonly string[];
  readonly generateCombined: boolean;
}): UpstreamRequestSpec {
  // Native FormData sets the multipart boundary itself; we never set it, so no
  // explicit content type is attached to the spec.
  const form = new FormData();
  form.set("prompt", input.prompt);
  form.set("thread_id", input.threadId);
  form.set("selected_llms", input.selectedLlms.join(","));
  form.set("generate_combined", input.generateCombined ? "true" : "false");
  // The gateway configuration explicitly selects the models, so this is always
  // "true". Treated as provisional until live discovery verifies its effect.
  form.set("llms_explicitly_set", "true");

  return {
    method: "POST",
    path: ENDPOINTS.processMessage,
    body: form,
  };
}

/**
 * Encode a `get_threads` request: a bare `GET` with no query and no body. The
 * upstream returns the caller-visible threads keyed by id; the gateway reads only
 * the single target entry's title (see `normalizeGetThreadTitle`). OBSERVED-ONLY /
 * provisional: this is a best-effort, account/principal-dependent lookup, never a
 * completion operation, and it creates no thread.
 */
export function buildGetThreadsRequest(): UpstreamRequestSpec {
  return {
    method: "GET",
    path: ENDPOINTS.getThreads,
  };
}

/** Encode a `get_messages` request; `since_id` is intentionally omitted. */
export function buildGetMessagesRequest(input: { readonly threadId: string }): UpstreamRequestSpec {
  // Standard query construction percent-encodes the thread id on the wire.
  const query = new URLSearchParams();
  query.set("thread_id", input.threadId);

  return {
    method: "GET",
    path: ENDPOINTS.getMessages,
    query,
  };
}
