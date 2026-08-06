/**
 * Staged discovery session for the APPROVED supporting CollectivIQ operations.
 *
 * This surface is deliberately NOT part of the production {@link
 * CollectivIQAdapter}. It exists so an operator can, with explicit staged
 * approval, capture sanitized structural evidence for a single bounded
 * `baseline` session: model listing, safe auth/validation error shapes, a
 * single-model workflow, a combined workflow, bounded SSE framing, and message
 * completion structure. Cleanup and not-found observation are separate opt-ins.
 *
 * Evidence fidelity vs. safety:
 * - Requests are encoded through the SAME builders the production adapter uses
 *   (`requests.ts`), over the SAME bounded HTTP core (`http.ts`), so methods,
 *   paths, query, and bodies are identical.
 * - Evidence is captured from the RAW upstream JSON (via the discovery-only
 *   {@link observeUpstreamJson} path, which may parse any HTTP status) BEFORE
 *   any production normalization, so run ids and error bodies are not discarded.
 *   The raw JSON is immediately reduced to a value-free structural capture; it
 *   never enters a report, error, log, or persisted file.
 * - Correlation identifiers (`thread_id`, `run_id`, `combined_run_id`) are
 *   extracted into PRIVATE in-memory state and never printed, persisted, logged,
 *   hashed, or returned. Only a value-free matched/not-matched/not-observed
 *   comparison against the SSE stream is emitted.
 *
 * Safety rules enforced here:
 * - importing this module performs no I/O and reads no credentials;
 * - the destination origin is fixed; there is no path/host/id/run injection;
 * - the session can NEVER reach token-inspection or abort endpoints;
 * - thread IDs created during the session are held only in memory and are never
 *   returned or logged; cleanup and not-found observation act only on those IDs;
 * - every returned observation is a sanitized structural capture plus a safe
 *   status/error code — never raw bodies, headers, IDs, prompts, or answers.
 */
import {
  classifyCorrelation,
  extractCorrelationCandidates,
  type CorrelationCandidates,
  type CorrelationReport,
} from "./correlation.js";
import { deleteThreadPath, ENDPOINTS } from "./endpoints.js";
import { upstreamErrorForStatus, type UpstreamErrorCode, UpstreamError } from "./errors.js";
import { observeUpstreamJson } from "./http.js";
import {
  buildCreateThreadRequest,
  buildGetMessagesRequest,
  buildProcessMessageRequest,
} from "./requests.js";
import {
  normalizeCreateThread,
  normalizeGetMessages,
  normalizeProcessMessage,
} from "./validation.js";
import {
  captureStructure,
  DEFAULT_CAPTURE_LIMITS,
  STRUCTURAL_CAPTURE_FORMAT,
  type CaptureLimits,
} from "./structural-capture.js";
import {
  DEFAULT_OPERATION_TIMEOUTS,
  type CollectivIQTransportConfig,
  type FetchLike,
  type OperationTimeouts,
} from "./types.js";

/** The only supported discovery session name. */
export const DISCOVERY_SESSION = "baseline" as const;
export type DiscoverySession = typeof DISCOVERY_SESSION;

/**
 * The fixed production destination origin. The discovery CLI hardcodes this; no
 * environment variable or flag may override it.
 */
export const DISCOVERY_ORIGIN = "https://api.prod.collectiviq.ai" as const;

/** The isolated, content-free probe prompt. */
export const DISCOVERY_PROBE_PROMPT = "Respond with exactly: CIQ_PROBE_OK.";
/** The isolated, content-free probe thread title. */
export const DISCOVERY_PROBE_TITLE = "gateway discovery probe";

/** Upper bound on the combined model list. */
export const MAX_COMBINED_LLMS = 32;

/** The bounded set of sanitized stages a baseline session can report. */
export const DISCOVERY_STAGES = [
  "available_llms",
  "auth_error",
  "validation_error",
  "single_thread_create",
  "single_submit",
  "combined_thread_create",
  "combined_submit",
  "sse_structure",
  "messages_state",
  "not_found",
] as const;

export type DiscoveryStage = (typeof DISCOVERY_STAGES)[number];

/** A single sanitized discovery observation. Contains no content or identifiers. */
export interface DiscoveryObservation {
  readonly stage: DiscoveryStage;
  readonly ok: boolean;
  readonly status: number | null;
  readonly errorCode: UpstreamErrorCode | null;
  readonly structure: unknown;
}

/** Validated, deterministic model selection for the two workflow stages. */
export interface DiscoveryModelSelection {
  /** Exactly one model id for the single-model stage. */
  readonly single: string;
  /** 1..MAX_COMBINED_LLMS unique model ids for the combined stage. */
  readonly combined: readonly string[];
}

/** Bounded projected operation counts derived from a validated selection. */
export interface DiscoveryProjectedCounts {
  readonly maxThreads: number;
  readonly maxMessageSubmissions: number;
  readonly singleStageSelectedJobs: number;
  readonly combinedStageSelectedJobs: number;
  readonly maxSynthesisJobs: number;
}

/** The preflight report: bounded projections only, no ids/credentials. */
export interface DiscoveryPreflightReport {
  readonly session: DiscoverySession;
  readonly destinationOrigin: string;
  readonly projectedCounts: DiscoveryProjectedCounts;
  readonly cleanupApproved: boolean;
  readonly notFoundObservationApproved: boolean;
}

/**
 * Sanitized cleanup outcome: bounded counts only, never ids or bodies.
 * `attempted`/`succeeded`/`failed` are cumulative across every session-owned
 * DELETE that counts as cleanup work (including the not-found probe's first
 * deletion, but never its second already-deleted observation). `remaining` is
 * the number of session-owned threads still undeleted when the session ended.
 */
export interface DiscoveryCleanupReport {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly remaining: number;
}

/** The bounded termination reasons for the SSE evidence probe. */
export type SseTermination =
  // Useful, bounded completions:
  | "completed"
  | "eof"
  | "timeout"
  | "event-limit"
  // Incomplete / rejected:
  | "body-limit"
  | "malformed-utf8"
  | "invalid-content-type"
  | "cancelled"
  | "stream-error";

/** Terminations that count as useful, bounded SSE evidence. */
export const USEFUL_SSE_TERMINATIONS: ReadonlySet<SseTermination> = new Set([
  "completed",
  "eof",
  "timeout",
  "event-limit",
]);

/** One sanitized SSE event: a safe/bounded name plus sanitized data structure. */
export interface SseEventSummary {
  /** A safe identifier-like name, the unsupported marker, or null when absent. */
  readonly eventName: string | null;
  /** Sanitized JSON structure, or a constant marker for empty/non-JSON data. */
  readonly data: unknown;
}

/** The sanitized SSE observation payload. */
export interface SseObservation {
  readonly termination: SseTermination;
  readonly events: readonly SseEventSummary[];
  /** Value-free correlation of the SSE stream with privately-held request ids. */
  readonly correlation: CorrelationReport;
}

export interface DiscoverySseLimits {
  readonly headerTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly maxEvents: number;
  readonly maxEventBytes: number;
  readonly maxBytes: number;
}

export const DEFAULT_SSE_LIMITS: DiscoverySseLimits = {
  headerTimeoutMs: 10_000,
  bodyTimeoutMs: 10_000,
  maxEvents: 5,
  maxEventBytes: 8_192,
  maxBytes: 65_536,
};

/** The correlation report emitted when nothing could be correlated. */
const NO_CORRELATION: CorrelationReport = { thread: "not-observed", run: "not-observed" };
const NO_REQUEST: CorrelationCandidates = { threadId: null, runId: null, combinedRunId: null };

/** Marker for an event whose data payload was empty. */
const SSE_EMPTY_DATA = "<empty>";
/** Marker for an event whose data payload was not valid JSON. */
const SSE_NON_JSON_DATA = "<non-json>";
/** Marker for an event whose declared name was not a safe identifier. */
const SSE_UNSUPPORTED_NAME = "<unsupported-event-name>";
/** Event names that signal a clean, complete stream. */
const SSE_TERMINAL_NAMES = new Set(["done", "complete", "end"]);
const SSE_SAFE_EVENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// --- Pure model-selection helpers (unit-tested; no I/O) ----------------------

/** Parse the single-model input: exactly one non-empty, comma-free id. */
export function parseSingleLlm(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") throw new Error("single model id is required");
  if (value.includes(",")) throw new Error("single model id must not contain a comma");
  return value;
}

/**
 * Parse the combined-model input: 1..MAX non-empty ids. Duplicates are REJECTED
 * (never silently deduplicated) so the operator's declared intent is explicit.
 */
export function parseCombinedLlms(raw: string | undefined): string[] {
  const parts = (raw ?? "").split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    throw new Error("combined model ids must all be non-empty");
  }
  if (new Set(parts).size !== parts.length) {
    throw new Error("combined model ids must be unique (duplicates are rejected)");
  }
  if (parts.length < 1 || parts.length > MAX_COMBINED_LLMS) {
    throw new Error("combined model list must contain 1..32 unique ids");
  }
  return parts;
}

/** Build and validate the full model selection from the environment. */
export function buildModelSelection(env: NodeJS.ProcessEnv): DiscoveryModelSelection {
  const single = parseSingleLlm(env["CIQ_DISCOVERY_SINGLE_LLM"]);
  const combined = parseCombinedLlms(env["CIQ_DISCOVERY_COMBINED_LLMS"]);
  return { single, combined };
}

/**
 * Canonicalize and validate a direct-caller selection inside the runner, with
 * the SAME invariants the CLI environment parser enforces (defense in depth,
 * independent of that parser). Returns a NEW canonical selection — trimmed
 * single/combined ids with no empties, no embedded commas, and no post-trim
 * duplicates — used for every projection and outbound request. The caller's
 * array is never mutated. Throws before any request is issued on invalid input.
 */
function canonicalizeSelection(selection: DiscoveryModelSelection): DiscoveryModelSelection {
  // Reuses the single-id parser so trimming/empty/comma rules stay identical,
  // and keeps its normalized (trimmed) return value.
  const single = parseSingleLlm(selection.single);

  const combinedInput: unknown = selection.combined;
  if (!Array.isArray(combinedInput)) {
    throw new Error("combined selection must be an array of model ids");
  }
  if (combinedInput.length < 1 || combinedInput.length > MAX_COMBINED_LLMS) {
    throw new Error("combined selection must contain 1..32 ids");
  }
  const combined: string[] = [];
  for (const raw of combinedInput) {
    if (typeof raw !== "string") throw new Error("combined selection ids must be strings");
    const id = raw.trim();
    if (id === "") throw new Error("combined selection ids must all be non-empty");
    // Never reinterpret one array element as multiple comma-separated models.
    if (id.includes(",")) throw new Error("combined selection ids must not contain a comma");
    combined.push(id);
  }
  if (new Set(combined).size !== combined.length) {
    throw new Error("combined selection ids must be unique after trimming");
  }
  return { single, combined };
}

/** Derive bounded projected operation counts from a validated selection. */
export function projectCounts(selection: DiscoveryModelSelection): DiscoveryProjectedCounts {
  return {
    maxThreads: 2,
    maxMessageSubmissions: 2,
    singleStageSelectedJobs: 1,
    combinedStageSelectedJobs: selection.combined.length,
    maxSynthesisJobs: 1,
  };
}

// --- Observation builders ----------------------------------------------------

/** Build a sanitized observation from a raw (any-status) JSON observation. */
function observationFromRaw(
  stage: DiscoveryStage,
  raw: { status: number; ok: boolean; json: unknown },
  limits: CaptureLimits,
): DiscoveryObservation {
  return {
    stage,
    ok: raw.ok,
    status: raw.status,
    errorCode: raw.ok ? null : upstreamErrorForStatus(raw.status).code,
    structure: captureStructure(raw.json, limits),
  };
}

function errorObservation(stage: DiscoveryStage, error: unknown): DiscoveryObservation {
  if (error instanceof UpstreamError) {
    return {
      stage,
      ok: false,
      status: error.rawStatus ?? null,
      errorCode: error.code,
      structure: null,
    };
  }
  return { stage, ok: false, status: null, errorCode: null, structure: null };
}

/** A failed stage that could not run at all (e.g. a missing prerequisite id). */
function unavailableObservation(stage: DiscoveryStage): DiscoveryObservation {
  return { stage, ok: false, status: null, errorCode: null, structure: null };
}

/**
 * Build the preflight report. Pure: validates the model selection (failing
 * closed on an invalid one) and reports bounded projections plus approvals. It
 * reads only the model-selection environment variables and never the upstream
 * credential, and it performs no network request.
 */
export function buildPreflightReport(
  env: NodeJS.ProcessEnv,
  approvals: { cleanupApproved: boolean; notFoundObservationApproved: boolean },
): DiscoveryPreflightReport {
  const selection = buildModelSelection(env);
  return {
    session: DISCOVERY_SESSION,
    destinationOrigin: DISCOVERY_ORIGIN,
    projectedCounts: projectCounts(selection),
    cleanupApproved: approvals.cleanupApproved,
    notFoundObservationApproved: approvals.notFoundObservationApproved,
  };
}

/** The sanitized result of a full authenticated baseline session. */
export interface DiscoveryBaselineReport {
  readonly session: DiscoverySession;
  readonly destinationOrigin: string;
  /** Explicit evidence-format version stamped onto every authenticated report. */
  readonly evidenceFormatVersion: typeof STRUCTURAL_CAPTURE_FORMAT;
  readonly observations: readonly DiscoveryObservation[];
  readonly notFound: DiscoveryObservation | null;
  /** Whether not-found observation was requested (drives strict completeness). */
  readonly notFoundRequested: boolean;
  readonly cleanup: DiscoveryCleanupReport | null;
  /** Value-free thread/run correlation of the SSE stream with request ids. */
  readonly correlation: CorrelationReport;
}

export interface ExecuteBaselineOptions {
  readonly selection: DiscoveryModelSelection;
  readonly cleanupApproved: boolean;
  readonly observeNotFoundApproved: boolean;
  readonly signal?: AbortSignal;
}

/**
 * The bounded, injectable discovery session core. Reuses the production request
 * encoders and bounded transport; the CLI is a thin wrapper. There is
 * deliberately NO method that can reach the token-inspection or abort endpoints.
 */
export class DiscoverySessionRunner {
  readonly #config: CollectivIQTransportConfig;
  readonly #timeouts: OperationTimeouts;
  readonly #captureLimits: CaptureLimits;
  readonly #sseLimits: DiscoverySseLimits;
  /** Threads created by this session, held only in memory and never exposed. */
  readonly #createdThreadIds = new Set<string>();
  /**
   * The SSE correlation target: the normalized combined-stage thread id plus the
   * run candidates from the successfully validated combined submission ONLY.
   * Single-stage identifiers are never mixed in. Values never leave the runner
   * (only a value-free `matched`/`not-matched`/`not-observed` comparison does).
   */
  #correlationTarget: CorrelationCandidates = {
    threadId: null,
    runId: null,
    combinedRunId: null,
  };
  /** Cumulative cleanup ledger (includes the not-found first deletion). */
  #cleanupAttempted = 0;
  #cleanupSucceeded = 0;
  #cleanupFailed = 0;

  constructor(
    config: CollectivIQTransportConfig,
    options: { captureLimits?: CaptureLimits; sseLimits?: DiscoverySseLimits } = {},
  ) {
    this.#config = config;
    this.#timeouts = config.timeouts?.getMessages ?? DEFAULT_OPERATION_TIMEOUTS.getMessages;
    this.#captureLimits = options.captureLimits ?? DEFAULT_CAPTURE_LIMITS;
    this.#sseLimits = options.sseLimits ?? DEFAULT_SSE_LIMITS;
  }

  /** Number of session-owned threads awaiting cleanup (count only, never IDs). */
  pendingThreadCount(): number {
    return this.#createdThreadIds.size;
  }

  /**
   * Run the full bounded baseline sequence. Validation and approval invariants
   * are re-checked here (before any request). Thread and run identifiers never
   * leave the in-memory session.
   */
  async executeBaseline(options: ExecuteBaselineOptions): Promise<DiscoveryBaselineReport> {
    // Approval + selection invariants, enforced before ANY network request. The
    // canonical (trimmed, validated) selection is used for every outbound request.
    const selection = canonicalizeSelection(options.selection);
    if (options.observeNotFoundApproved && !options.cleanupApproved) {
      throw new Error("not-found observation requires cleanup approval");
    }

    const observations: DiscoveryObservation[] = [];

    // 1. Model listing structure.
    observations.push(await this.#availableLlms(options.signal));
    // 2. Safe auth + validation error shapes (raw error bodies captured).
    observations.push(await this.#authError(options.signal));
    observations.push(await this.#validationError(options.signal));
    // 3-4. Single-model stage. Its identifiers are intentionally NOT used for SSE
    // correlation — that target is established atomically by the combined stage.
    const singleThreadId = await this.#createStageThread(
      "single_thread_create",
      observations,
      options.signal,
    );
    const singleSubmit = await this.#submit(
      "single_submit",
      singleThreadId,
      [selection.single],
      false,
      options.signal,
    );
    observations.push(singleSubmit.observation);
    // 5-6. Combined stage. Establish the SSE correlation target the moment the
    // combined thread exists (resetting run candidates), then fill run candidates
    // only from a successfully validated combined submission.
    const combinedThreadId = await this.#createStageThread(
      "combined_thread_create",
      observations,
      options.signal,
    );
    this.#correlationTarget = { threadId: combinedThreadId, runId: null, combinedRunId: null };
    const combinedSubmit = await this.#submit(
      "combined_submit",
      combinedThreadId,
      selection.combined,
      true,
      options.signal,
    );
    observations.push(combinedSubmit.observation);
    if (combinedSubmit.candidates !== null) {
      this.#correlationTarget = {
        threadId: combinedThreadId,
        runId: combinedSubmit.candidates.runId,
        combinedRunId: combinedSubmit.candidates.combinedRunId,
      };
    }
    // 7. Bounded SSE framing structure + value-free correlation.
    const sse = await this.#observeSse(options.signal);
    observations.push(sse.observation);
    // 8. Message completion structure (values sanitized to markers).
    observations.push(await this.#messagesState(combinedThreadId, options.signal));

    // 9. Optional not-found observation, then optional cleanup.
    let notFound: DiscoveryObservation | null = null;
    if (options.observeNotFoundApproved) {
      notFound = await this.#observeNotFound(options.signal);
    }
    let cleanup: DiscoveryCleanupReport | null = null;
    if (options.cleanupApproved) {
      cleanup = await this.cleanup(options.signal);
    }

    return {
      session: DISCOVERY_SESSION,
      destinationOrigin: this.#config.baseUrl,
      evidenceFormatVersion: STRUCTURAL_CAPTURE_FORMAT,
      observations,
      notFound,
      notFoundRequested: options.observeNotFoundApproved,
      cleanup,
      correlation: sse.correlation,
    };
  }

  /** Issue a bounded any-status JSON observation for a fixed request. */
  async #observe(
    method: "GET" | "POST" | "DELETE",
    path: string,
    extras: {
      query?: URLSearchParams;
      body?: URLSearchParams | FormData;
      bodyContentType?: string;
      config?: CollectivIQTransportConfig;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ status: number; ok: boolean; json: unknown }> {
    return observeUpstreamJson(extras.config ?? this.#config, {
      method,
      path,
      timeouts: this.#timeouts,
      ...(extras.query ? { query: extras.query } : {}),
      ...(extras.body ? { body: extras.body } : {}),
      ...(extras.bodyContentType ? { bodyContentType: extras.bodyContentType } : {}),
      ...(extras.signal ? { signal: extras.signal } : {}),
    });
  }

  async #availableLlms(signal?: AbortSignal): Promise<DiscoveryObservation> {
    try {
      const raw = await this.#observe("GET", ENDPOINTS.availableLlms, {
        ...(signal ? { signal } : {}),
      });
      return observationFromRaw("available_llms", raw, this.#captureLimits);
    } catch (error) {
      return errorObservation("available_llms", error);
    }
  }

  /** Observe the auth-failure shape via a deliberately empty bearer. */
  async #authError(signal?: AbortSignal): Promise<DiscoveryObservation> {
    try {
      const badConfig: CollectivIQTransportConfig = { ...this.#config, apiKey: "" };
      const raw = await this.#observe("GET", ENDPOINTS.availableLlms, {
        config: badConfig,
        ...(signal ? { signal } : {}),
      });
      return observationFromRaw("auth_error", raw, this.#captureLimits);
    } catch (error) {
      return errorObservation("auth_error", error);
    }
  }

  /**
   * Observe the validation-failure shape via a safe, read-only request that is
   * intentionally invalid (a `get_messages` read with no `thread_id`). It
   * creates nothing and invents no identifier.
   */
  async #validationError(signal?: AbortSignal): Promise<DiscoveryObservation> {
    try {
      const raw = await this.#observe("GET", ENDPOINTS.getMessages, {
        ...(signal ? { signal } : {}),
      });
      return observationFromRaw("validation_error", raw, this.#captureLimits);
    } catch (error) {
      return errorObservation("validation_error", error);
    }
  }

  /**
   * Create a session-owned thread for a stage. The raw structure is captured
   * first (value-free) and retained regardless of outcome. A 2xx response must
   * then pass the SAME production normalizer the adapter uses
   * (`normalizeCreateThread`); the stage succeeds only when normalization yields
   * a valid top-level thread id. Only that normalized id is used for advancement,
   * ownership, deletion, and thread correlation — never a nested or unvalidated
   * value. A non-2xx response keeps its raw error-structure observation.
   */
  async #createStageThread(
    stage: "single_thread_create" | "combined_thread_create",
    observations: DiscoveryObservation[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const spec = buildCreateThreadRequest({ title: DISCOVERY_PROBE_TITLE });
      const raw = await this.#observe(spec.method, spec.path, {
        ...(spec.body ? { body: spec.body } : {}),
        ...(spec.bodyContentType ? { bodyContentType: spec.bodyContentType } : {}),
        ...(signal ? { signal } : {}),
      });
      const structure = captureStructure(raw.json, this.#captureLimits);
      if (!raw.ok) {
        observations.push({
          stage,
          ok: false,
          status: raw.status,
          errorCode: upstreamErrorForStatus(raw.status).code,
          structure,
        });
        return null;
      }
      let threadId: string;
      try {
        threadId = normalizeCreateThread(raw.json, raw.status).threadId;
      } catch (error) {
        // Normalization failed: keep the sanitized raw structure + safe code, and
        // do NOT take ownership of any unvalidated id.
        observations.push({
          stage,
          ok: false,
          status: raw.status,
          errorCode: error instanceof UpstreamError ? error.code : null,
          structure,
        });
        return null;
      }
      this.#createdThreadIds.add(threadId);
      observations.push({ stage, ok: true, status: raw.status, errorCode: null, structure });
      return threadId;
    } catch (error) {
      observations.push(errorObservation(stage, error));
      return null;
    }
  }

  /**
   * Submit one message for a stage in a deterministic mode. The raw structure is
   * captured first (value-free) and retained regardless of outcome. A 2xx
   * response must pass `normalizeProcessMessage` (a body with an own `detail`
   * property is a failure); the stage succeeds only then. Run correlation
   * candidates are extracted ONLY after that normalization succeeds. Returns the
   * observation plus, on success, the run candidates for the caller to use as an
   * atomic combined-stage correlation target.
   */
  async #submit(
    stage: "single_submit" | "combined_submit",
    threadId: string | null,
    selectedLlms: readonly string[],
    generateCombined: boolean,
    signal?: AbortSignal,
  ): Promise<{ observation: DiscoveryObservation; candidates: CorrelationCandidates | null }> {
    if (threadId === null) return { observation: unavailableObservation(stage), candidates: null };
    try {
      const spec = buildProcessMessageRequest({
        threadId,
        prompt: DISCOVERY_PROBE_PROMPT,
        selectedLlms,
        generateCombined,
      });
      const raw = await this.#observe(spec.method, spec.path, {
        ...(spec.body ? { body: spec.body } : {}),
        ...(spec.bodyContentType ? { bodyContentType: spec.bodyContentType } : {}),
        ...(signal ? { signal } : {}),
      });
      const structure = captureStructure(raw.json, this.#captureLimits);
      if (!raw.ok) {
        return {
          observation: {
            stage,
            ok: false,
            status: raw.status,
            errorCode: upstreamErrorForStatus(raw.status).code,
            structure,
          },
          candidates: null,
        };
      }
      try {
        normalizeProcessMessage(raw.json, raw.status);
      } catch (error) {
        return {
          observation: {
            stage,
            ok: false,
            status: raw.status,
            errorCode: error instanceof UpstreamError ? error.code : null,
            structure,
          },
          candidates: null,
        };
      }
      // Only after a validated success may run candidates be extracted (value-free
      // to the runner; never emitted).
      const candidates = extractCorrelationCandidates(raw.json, this.#captureLimits);
      return {
        observation: { stage, ok: true, status: raw.status, errorCode: null, structure },
        candidates,
      };
    } catch (error) {
      return { observation: errorObservation(stage, error), candidates: null };
    }
  }

  /**
   * Read message completion structure; values are sanitized to markers. The raw
   * structure is captured first and retained regardless of outcome. A 2xx
   * response must pass `normalizeGetMessages` (a valid `messages` array of
   * well-formed entries); the stage succeeds only then. A non-2xx response keeps
   * its raw error-structure observation.
   */
  async #messagesState(
    threadId: string | null,
    signal?: AbortSignal,
  ): Promise<DiscoveryObservation> {
    if (threadId === null) return unavailableObservation("messages_state");
    try {
      const spec = buildGetMessagesRequest({ threadId });
      const raw = await this.#observe(spec.method, spec.path, {
        ...(spec.query ? { query: spec.query } : {}),
        ...(signal ? { signal } : {}),
      });
      const structure = captureStructure(raw.json, this.#captureLimits);
      if (!raw.ok) {
        return {
          stage: "messages_state",
          ok: false,
          status: raw.status,
          errorCode: upstreamErrorForStatus(raw.status).code,
          structure,
        };
      }
      try {
        normalizeGetMessages(raw.json, raw.status);
      } catch (error) {
        return {
          stage: "messages_state",
          ok: false,
          status: raw.status,
          errorCode: error instanceof UpstreamError ? error.code : null,
          structure,
        };
      }
      return { stage: "messages_state", ok: true, status: raw.status, errorCode: null, structure };
    } catch (error) {
      return errorObservation("messages_state", error);
    }
  }

  /**
   * Delete a session-owned thread as CLEANUP work. Counts every attempt, marks
   * success only on a 2xx response, removes ownership ONLY after a confirmed
   * success, and retains ownership on any failure so final cleanup can retry.
   */
  async #deleteOwnedThread(threadId: string, signal?: AbortSignal): Promise<boolean> {
    this.#cleanupAttempted += 1;
    let ok: boolean;
    try {
      const raw = await this.#observe("DELETE", deleteThreadPath(threadId), {
        ...(signal ? { signal } : {}),
      });
      ok = raw.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      this.#cleanupSucceeded += 1;
      this.#createdThreadIds.delete(threadId);
    } else {
      this.#cleanupFailed += 1;
    }
    return ok;
  }

  /**
   * Observe not-found handling by deleting a session-owned thread and then
   * re-deleting that SAME id. The first deletion is cleanup work (counted); the
   * second (already-deleted) response is the observation and is NOT counted. If
   * the first deletion fails, ownership is retained, the second DELETE is
   * skipped, and the requested evidence is left incomplete for final cleanup to
   * retry. Never invents or guesses an id.
   */
  async #observeNotFound(signal?: AbortSignal): Promise<DiscoveryObservation> {
    const [threadId] = [...this.#createdThreadIds];
    if (threadId === undefined) return unavailableObservation("not_found");

    const firstOk = await this.#deleteOwnedThread(threadId, signal);
    if (!firstOk) {
      // First deletion failed: ownership retained, skip the second DELETE, and
      // report the stage as incomplete (status null) so exit policy fails.
      return unavailableObservation("not_found");
    }

    // Second deletion of the SAME id: capture the safe not-found shape only.
    try {
      const raw = await this.#observe("DELETE", deleteThreadPath(threadId), {
        ...(signal ? { signal } : {}),
      });
      return observationFromRaw("not_found", raw, this.#captureLimits);
    } catch (error) {
      return errorObservation("not_found", error);
    }
  }

  /**
   * Delete every remaining session-owned thread. Builds on the shared cleanup
   * ledger (so a not-found first-delete failure remains a recorded failure even
   * if a retry here later succeeds). Reports cumulative bounded counts plus the
   * number still remaining; a non-zero `failed` or `remaining` signals failure.
   */
  async cleanup(signal?: AbortSignal): Promise<DiscoveryCleanupReport> {
    for (const threadId of [...this.#createdThreadIds]) {
      await this.#deleteOwnedThread(threadId, signal);
    }
    return {
      attempted: this.#cleanupAttempted,
      succeeded: this.#cleanupSucceeded,
      failed: this.#cleanupFailed,
      remaining: this.#createdThreadIds.size,
    };
  }

  /**
   * Bounded SSE evidence probe against `GET /user/events`. Enforces the header
   * deadline around the fetch; body decoding, separator handling, caps,
   * sanitization, and value-free correlation live in {@link readSseEvidence}. A
   * non-2xx response is rejected before parsing and normalized to a failed
   * observation (never reported as ok). No raw values, ids, prompts, or model
   * output survive.
   */
  async #observeSse(
    signal?: AbortSignal,
  ): Promise<{ observation: DiscoveryObservation; correlation: CorrelationReport }> {
    const fetchImpl: FetchLike = this.#config.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    let headerTimedOut = false;
    let externallyCancelled = false;

    const onExternalAbort = (): void => {
      externallyCancelled = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const headerTimer = setTimeout(() => {
      headerTimedOut = true;
      controller.abort();
    }, this.#sseLimits.headerTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(
        `${this.#config.baseUrl.replace(/\/+$/, "")}${ENDPOINTS.userEvents}`,
        {
          method: "GET",
          headers: {
            // Redaction depends on the header name being `authorization`.
            authorization: `Bearer ${this.#config.apiKey}`,
            accept: "text/event-stream",
          },
          signal: controller.signal,
          redirect: "error",
        },
      );
    } catch (error) {
      clearTimeout(headerTimer);
      signal?.removeEventListener("abort", onExternalAbort);
      if (headerTimedOut) {
        // A header-wait timeout is useful, bounded evidence.
        return {
          observation: {
            stage: "sse_structure",
            ok: true,
            status: null,
            errorCode: null,
            structure: {
              termination: "timeout",
              events: [],
              correlation: NO_CORRELATION,
            } satisfies SseObservation,
          },
          correlation: NO_CORRELATION,
        };
      }
      if (externallyCancelled) {
        return {
          observation: errorObservation("sse_structure", new UpstreamError("cancellation")),
          correlation: NO_CORRELATION,
        };
      }
      return { observation: errorObservation("sse_structure", error), correlation: NO_CORRELATION };
    }
    clearTimeout(headerTimer);

    // Reject and normalize any non-2xx response before event parsing.
    if (!response.ok) {
      signal?.removeEventListener("abort", onExternalAbort);
      try {
        await response.body?.cancel();
      } catch {
        // The socket is being torn down; nothing safe to surface.
      }
      return {
        observation: {
          stage: "sse_structure",
          ok: false,
          status: response.status,
          errorCode: upstreamErrorForStatus(response.status).code,
          structure: null,
        },
        correlation: NO_CORRELATION,
      };
    }

    try {
      const observation = await readSseEvidence(
        response,
        this.#sseLimits,
        signal,
        this.#captureLimits,
        this.#correlationTarget,
      );
      return {
        observation: {
          stage: "sse_structure",
          ok: true,
          status: response.status,
          errorCode: null,
          structure: observation,
        },
        correlation: observation.correlation,
      };
    } catch (error) {
      return { observation: errorObservation("sse_structure", error), correlation: NO_CORRELATION };
    } finally {
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * The process exit code for a completed baseline run under STRICT session
 * completeness. Returns non-zero when any required positive stage failed, the
 * auth/validation probes did not yield their expected failures, requested
 * not-found evidence was not obtained, the SSE evidence is invalid/incomplete,
 * or cleanup left any failure or remaining owned thread. Expected
 * authentication/validation errors are NOT themselves session failures.
 */
export function exitCodeForBaseline(report: DiscoveryBaselineReport): number {
  const byStage = new Map<DiscoveryStage, DiscoveryObservation>(
    report.observations.map((o) => [o.stage, o]),
  );

  const requiredOk: DiscoveryStage[] = [
    "available_llms",
    "single_thread_create",
    "single_submit",
    "combined_thread_create",
    "combined_submit",
    "messages_state",
  ];
  for (const stage of requiredOk) {
    const observation = byStage.get(stage);
    if (observation === undefined || !observation.ok) return 1;
  }

  const auth = byStage.get("auth_error");
  if (auth === undefined || auth.errorCode !== "upstream_authentication_failed") return 1;
  const validation = byStage.get("validation_error");
  if (validation === undefined || validation.errorCode !== "upstream_validation_failed") return 1;

  const sse = byStage.get("sse_structure");
  if (sse === undefined || !sse.ok) return 1;
  const termination = (sse.structure as SseObservation | null)?.termination;
  if (termination === undefined || !USEFUL_SSE_TERMINATIONS.has(termination)) return 1;

  if (report.notFoundRequested) {
    // Evidence is obtained only when the re-delete produced an HTTP response.
    if (report.notFound === null || report.notFound.status === null) return 1;
  }

  if (report.cleanup !== null && (report.cleanup.failed > 0 || report.cleanup.remaining > 0)) {
    return 1;
  }

  return 0;
}

// --- SSE reading -------------------------------------------------------------

/** Find the earliest LF (`\n\n`) or CRLF (`\r\n\r\n`) record boundary. */
function nextRecordBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf === -1) return { index: lf, length: 2 };
  if (lf === -1) return { index: crlf, length: 4 };
  // Both present: choose whichever starts first. On a tie the CRLF sequence
  // begins earlier (its `\r` precedes the `\n\n`).
  if (crlf <= lf) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * Summarize one SSE record: a safe event name + sanitized data structure. When
 * the data parses as JSON, correlation candidates are extracted from the RAW
 * parsed value into the provided observed-value sets (which never leave the
 * reader); the raw value itself is never returned.
 */
function summarizeSseEvent(
  rawEvent: string,
  captureLimits: CaptureLimits,
  observedThreads: Set<string>,
  observedRuns: Set<string>,
): SseEventSummary {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of rawEvent.split(/\r\n|\n/)) {
    if (rawLine.startsWith(":")) continue; // SSE comment
    if (rawLine.startsWith("event:")) {
      const candidate = rawLine.slice("event:".length).trim();
      eventName = SSE_SAFE_EVENT_NAME_RE.test(candidate) ? candidate : SSE_UNSUPPORTED_NAME;
    } else if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).replace(/^ /, ""));
    }
    // `id:` and other fields are intentionally ignored (never retained).
  }
  const dataText = dataLines.join("\n");
  let data: unknown = SSE_EMPTY_DATA;
  if (dataText !== "") {
    try {
      const parsed: unknown = JSON.parse(dataText);
      data = captureStructure(parsed, captureLimits);
      const candidates = extractCorrelationCandidates(parsed, captureLimits);
      if (candidates.threadId !== null) observedThreads.add(candidates.threadId);
      if (candidates.runId !== null) observedRuns.add(candidates.runId);
      if (candidates.combinedRunId !== null) observedRuns.add(candidates.combinedRunId);
    } catch {
      data = SSE_NON_JSON_DATA;
    }
  }
  return { eventName, data };
}

/**
 * Read a bounded, sanitized SSE evidence observation from an already-fetched,
 * 2xx {@link Response}. Requires a `text/event-stream` content type (parameters
 * allowed), decodes with strict/fatal UTF-8 (finalized at end of stream so a
 * truncated terminal multibyte sequence becomes `malformed-utf8`), supports LF
 * and CRLF record separators split across chunk boundaries, and enforces
 * body-duration, total-size, per-event-size (including against an
 * unterminated pending record), and event-count caps. External cancellation and
 * a body-read timeout are tracked separately (`cancelled` vs `timeout`), and a
 * mid-stream reset is `stream-error`. Only safe event names and sanitized JSON
 * `data` structure are retained; correlation is emitted value-free. The reader
 * is cancelled and its lock released on every exit path.
 */
export async function readSseEvidence(
  response: Response,
  limits: DiscoverySseLimits,
  signal?: AbortSignal,
  captureLimits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
  requested: CorrelationCandidates = NO_REQUEST,
): Promise<SseObservation> {
  const observedThreads = new Set<string>();
  const observedRuns = new Set<string>();
  const correlationOf = (): CorrelationReport =>
    classifyCorrelation(requested, observedThreads, observedRuns);

  const contentType = response.headers.get("content-type") ?? "";
  // Allow parameters/charset (e.g. `text/event-stream; charset=utf-8`).
  if (!/^text\/event-stream\b/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return { termination: "invalid-content-type", events: [], correlation: NO_CORRELATION };
  }

  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return { termination: "eof", events: [], correlation: correlationOf() };

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: SseEventSummary[] = [];
  let externallyCancelled = false;
  let timedOut = false;

  const onAbort = (): void => {
    externallyCancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const bodyTimer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, limits.bodyTimeoutMs);

  const readLoop = async (): Promise<SseTermination> => {
    let buffer = "";
    let total = 0;
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        // A rejected read: cancellation wins, then timeout, else a stream reset.
        return externallyCancelled ? "cancelled" : timedOut ? "timeout" : "stream-error";
      }
      if (chunk.done) {
        if (externallyCancelled) return "cancelled";
        if (timedOut) return "timeout";
        // Finalize the fatal decoder: a truncated terminal multibyte is invalid.
        try {
          buffer += decoder.decode();
        } catch {
          return "malformed-utf8";
        }
        // A too-large unterminated final record is a body-limit violation.
        if (Buffer.byteLength(buffer, "utf8") > limits.maxEventBytes) return "body-limit";
        return "eof";
      }
      const value = chunk.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > limits.maxBytes) return "body-limit";
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        return "malformed-utf8";
      }
      // Extract every complete record (LF or CRLF separated) in the buffer.
      for (;;) {
        const boundary = nextRecordBoundary(buffer);
        if (boundary === null) break;
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (Buffer.byteLength(rawEvent, "utf8") > limits.maxEventBytes) return "body-limit";
        const summary = summarizeSseEvent(rawEvent, captureLimits, observedThreads, observedRuns);
        events.push(summary);
        if (summary.eventName !== null && SSE_TERMINAL_NAMES.has(summary.eventName)) {
          return "completed";
        }
        if (events.length >= limits.maxEvents) return "event-limit";
      }
      // Enforce the per-event bound against the remaining pending (unterminated)
      // record so an oversized event without a delimiter cannot slip through.
      if (Buffer.byteLength(buffer, "utf8") > limits.maxEventBytes) return "body-limit";
    }
  };

  try {
    const termination = await readLoop();
    return { termination, events, correlation: correlationOf() };
  } finally {
    clearTimeout(bodyTimer);
    signal?.removeEventListener("abort", onAbort);
    // Cancel the reader (releasing its lock) on every exit path.
    try {
      await reader.cancel();
    } catch {
      // The stream is already torn down; nothing safe to surface.
    }
  }
}
