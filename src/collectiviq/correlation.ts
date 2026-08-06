/**
 * Private, value-free correlation for discovery.
 *
 * The discovery session needs to know WHETHER an upstream SSE stream echoes the
 * same thread/run identifiers it privately created — never the identifiers
 * themselves. This module extracts a closed set of correlation candidates from
 * untrusted JSON using bounded, descriptor-only traversal (it never invokes an
 * accessor or a Proxy `get` trap), and classifies an observed-vs-requested
 * comparison down to a three-value enum.
 *
 * Guarantees:
 * - Only OWN DATA properties named exactly `thread_id`, `run_id`, or
 *   `combined_run_id` are considered.
 * - A candidate is accepted only when it is a non-empty string or a positive
 *   integer (normalized to its decimal string); everything else is ignored.
 * - Traversal is bounded by the same depth/width limits as structural capture
 *   and is cycle-safe.
 * - The extracted values are for the caller's PRIVATE in-memory state only. This
 *   module never logs, persists, hashes, or returns them beyond the caller, and
 *   {@link classifyCorrelation} emits only the enum — never a value.
 */
import {
  DEFAULT_CAPTURE_LIMITS,
  readOwnArrayLength,
  type CaptureLimits,
} from "./structural-capture.js";

/** The closed set of correlation field names, checked as exact own-key matches. */
const CORRELATION_KEYS = ["thread_id", "run_id", "combined_run_id"] as const;

/** Candidate identifiers extracted from a single upstream JSON value. */
export interface CorrelationCandidates {
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly combinedRunId: string | null;
}

/** The value-free outcome of comparing a requested candidate to observed ones. */
export type CorrelationMatch = "matched" | "not-matched" | "not-observed";

/** Separate thread and run correlation outcomes for a discovery report. */
export interface CorrelationReport {
  readonly thread: CorrelationMatch;
  readonly run: CorrelationMatch;
}

/** Accept a non-empty string or a positive integer, normalized to a string. */
function normalizeCandidate(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  return null;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read an own DATA property value without ever invoking an accessor. */
function readOwnDataValue(obj: object, key: string): { present: boolean; value: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return { present: false, value: undefined };
  }
  if (descriptor === undefined) return { present: false, value: undefined };
  if ("get" in descriptor || "set" in descriptor) return { present: false, value: undefined };
  return { present: true, value: descriptor.value };
}

/**
 * Extract correlation candidates from an untrusted JSON value. First occurrence
 * (by sorted-key, depth-first traversal) of each key wins. Bounded and cycle-safe;
 * never invokes an accessor or Proxy `get` trap. Returns nulls on any hostile
 * structure rather than throwing.
 */
export function extractCorrelationCandidates(
  value: unknown,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CorrelationCandidates {
  const found: Record<(typeof CORRELATION_KEYS)[number], string | null> = {
    thread_id: null,
    run_id: null,
    combined_run_id: null,
  };
  const seen = new WeakSet<object>();

  const consider = (key: (typeof CORRELATION_KEYS)[number], raw: unknown): void => {
    if (found[key] !== null) return;
    const normalized = normalizeCandidate(raw);
    if (normalized !== null) found[key] = normalized;
  };

  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object") return;
    if (depth >= limits.maxDepth) return;
    if (seen.has(node)) return;
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        const length = readOwnArrayLength(node);
        if (length === null) return;
        const limit = Math.min(length, limits.maxArrayItems);
        for (let i = 0; i < limit; i += 1) {
          const { present, value: item } = readOwnDataValue(node, String(i));
          if (present) visit(item, depth + 1);
        }
        return;
      }
      if (!isPlainObject(node)) return;
      let keys: string[];
      try {
        keys = Object.keys(node);
      } catch {
        return;
      }
      keys.sort();
      const limit = Math.min(keys.length, limits.maxObjectKeys);
      for (let i = 0; i < limit; i += 1) {
        const key = keys[i] as string;
        const { present, value: child } = readOwnDataValue(node, key);
        if (!present) continue;
        if ((CORRELATION_KEYS as readonly string[]).includes(key)) {
          consider(key as (typeof CORRELATION_KEYS)[number], child);
        }
        visit(child, depth + 1);
      }
    } catch {
      // A hostile descriptor/trap collapses this node to "nothing found".
    } finally {
      seen.delete(node);
    }
  };

  visit(value, 0);
  return {
    threadId: found.thread_id,
    runId: found.run_id,
    combinedRunId: found.combined_run_id,
  };
}

/**
 * Classify one requested value against the set of values observed for its kind.
 * `matched` when the exact requested value appeared; `not-matched` when a
 * candidate of that kind was observed but none equalled the requested value;
 * `not-observed` when nothing was requested or no candidate of that kind was
 * observed. Never returns a value.
 */
function classifyOne(requested: string | null, observed: ReadonlySet<string>): CorrelationMatch {
  if (requested === null) return "not-observed";
  if (observed.has(requested)) return "matched";
  if (observed.size > 0) return "not-matched";
  return "not-observed";
}

/**
 * Classify a SET of requested candidates against the set of observed values for
 * its kind. `matched` when ANY requested candidate appears in the observed set;
 * `not-matched` when at least one candidate was requested, at least one value was
 * observed, and the sets are disjoint; `not-observed` when nothing was requested
 * or nothing was observed. Never returns a value.
 */
function classifyAny(
  requested: ReadonlySet<string>,
  observed: ReadonlySet<string>,
): CorrelationMatch {
  if (requested.size === 0) return "not-observed";
  for (const candidate of requested) {
    if (observed.has(candidate)) return "matched";
  }
  if (observed.size > 0) return "not-matched";
  return "not-observed";
}

/**
 * Produce the value-free thread/run correlation report. The run dimension treats
 * ALL non-null run identifiers from the validated combined submission (`runId`
 * and `combined_run_id`) as eligible candidates and reports `matched` when any of
 * them appears in the observed run set; equal `runId`/`combinedRunId` values
 * dedupe naturally through the candidate set. Thread correlation is unchanged.
 */
export function classifyCorrelation(
  requested: CorrelationCandidates,
  observedThreads: ReadonlySet<string>,
  observedRuns: ReadonlySet<string>,
): CorrelationReport {
  const requestedRuns = new Set<string>();
  if (requested.runId !== null) requestedRuns.add(requested.runId);
  if (requested.combinedRunId !== null) requestedRuns.add(requested.combinedRunId);
  return {
    thread: classifyOne(requested.threadId, observedThreads),
    run: classifyAny(requestedRuns, observedRuns),
  };
}
