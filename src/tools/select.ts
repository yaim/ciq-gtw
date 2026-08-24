/**
 * Deterministic candidate selection and consensus voting (specification sections
 * 12.3, 12.3.1, 12.3.2). Produces one {@link ParsedGeneration} or a
 * required/named failure. The policy is pure and stable: identical inputs always
 * yield an identical result (parser determinism, section 30 gate 8).
 *
 * Priority:
 *  1. A valid tool/final envelope from the desired answer source.
 *  2. Consensus among valid individual-source tool envelopes (grouped by
 *     canonical call set; scored by summed `percent_usage` when every valid
 *     individual has one, else by agreement count; ties broken by configured
 *     `selectedLlms` order).
 *  3. For `auto`, fall back to the desired source's raw text; for
 *     `required`/named, fail with `invalid_tool_response`.
 */
import { canonicalCallSet } from "./canonicalize.js";
import type { ToolCallIdGenerator } from "./ids.js";
import { parseToolEnvelope, type EnvelopeToolCall } from "./protocol.js";
import type { CompiledToolset } from "./schema.js";
import type {
  NormalizedToolChoice,
  ParsedGeneration,
  ParsedToolCall,
  ToolParseSource,
} from "./types.js";

/** One individual-source candidate from the polled message snapshot. */
export interface SourceCandidate {
  readonly source: string;
  readonly content: string;
  readonly percentUsage: number | null;
}

export interface SelectionInput {
  /** The desired answer-source candidate content (normally `combined`), if present. */
  readonly desired: { readonly content: string } | null;
  /** The individual-source candidates (the `selectedLlms` sources). */
  readonly individuals: readonly SourceCandidate[];
  readonly toolset: CompiledToolset;
  readonly choice: NormalizedToolChoice;
  readonly parallelToolCalls: boolean;
  /** Configured source order for deterministic tie-breaking. */
  readonly selectedLlms: readonly string[];
  readonly idGen: ToolCallIdGenerator;
}

export type SelectionResult =
  | { readonly ok: true; readonly generation: ParsedGeneration }
  | { readonly ok: false; readonly reason: "invalid_tool_response" };

/** Assign gateway-owned ids to a chosen call set (upstream ids never trusted). */
function toToolCalls(
  calls: readonly EnvelopeToolCall[],
  source: ToolParseSource,
  idGen: ToolCallIdGenerator,
): ParsedGeneration {
  const withIds: ParsedToolCall[] = calls.map((call) => ({
    id: idGen.toolCallId(),
    name: call.name,
    argumentsJson: call.argumentsJson,
  }));
  return { kind: "tool_calls", calls: withIds, source };
}

function sourceOrder(selectedLlms: readonly string[], source: string): number {
  const index = selectedLlms.indexOf(source);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function selectGeneration(input: SelectionInput): SelectionResult {
  const { desired, individuals, toolset, choice, parallelToolCalls, selectedLlms, idGen } = input;

  // `none`: the tool protocol was never added to the prompt, so the response is
  // ordinary text.
  if (choice.kind === "none") {
    return { ok: true, generation: { kind: "text", content: desired?.content ?? "" } };
  }

  const parseOptions = { toolset, choice, parallelToolCalls };

  // 1. Desired answer source.
  if (desired !== null) {
    const parsed = parseToolEnvelope(desired.content, parseOptions);
    if (parsed.kind === "tool_calls") {
      return { ok: true, generation: toToolCalls(parsed.calls, "desired-source", idGen) };
    }
    if (parsed.kind === "final" && choice.kind === "auto") {
      // A valid desired-source final answer under `auto` is ordinary text.
      return { ok: true, generation: { kind: "text", content: parsed.content } };
    }
    // A desired-source `final` under required/named, or an invalid desired
    // envelope, falls through to individual-source consensus.
  }

  // 2/3. Consensus among valid individual-source tool envelopes.
  const valid = individuals
    .map((candidate) => ({
      source: candidate.source,
      percentUsage: candidate.percentUsage,
      parsed: parseToolEnvelope(candidate.content, parseOptions),
    }))
    .filter(
      (
        entry,
      ): entry is {
        source: string;
        percentUsage: number | null;
        parsed: { kind: "tool_calls"; calls: readonly EnvelopeToolCall[] };
      } => entry.parsed.kind === "tool_calls",
    );

  if (valid.length > 0) {
    const scoreByUsage = valid.every(
      (entry) => typeof entry.percentUsage === "number" && Number.isFinite(entry.percentUsage),
    );
    interface Group {
      readonly calls: readonly EnvelopeToolCall[];
      score: number;
      count: number;
      bestOrder: number;
    }
    const groups = new Map<string, Group>();
    for (const entry of valid) {
      const key = canonicalCallSet(entry.parsed.calls, parallelToolCalls);
      const order = sourceOrder(selectedLlms, entry.source);
      const contribution = scoreByUsage ? (entry.percentUsage as number) : 1;
      const existing = groups.get(key);
      if (existing) {
        existing.score += contribution;
        existing.count += 1;
        existing.bestOrder = Math.min(existing.bestOrder, order);
      } else {
        groups.set(key, {
          calls: entry.parsed.calls,
          score: contribution,
          count: 1,
          bestOrder: order,
        });
      }
    }
    let winner: Group | null = null;
    for (const group of groups.values()) {
      if (
        winner === null ||
        group.score > winner.score ||
        (group.score === winner.score && group.bestOrder < winner.bestOrder)
      ) {
        winner = group;
      }
    }
    if (winner !== null) {
      const source: ToolParseSource =
        winner.count > 1 ? "individual-consensus" : "individual-single";
      return { ok: true, generation: toToolCalls(winner.calls, source, idGen) };
    }
  }

  // 4. No valid tool candidate.
  if (choice.kind === "auto") {
    // Final-answer fallback: the desired response is treated as ordinary text.
    return { ok: true, generation: { kind: "text", content: desired?.content ?? "" } };
  }
  return { ok: false, reason: "invalid_tool_response" };
}
