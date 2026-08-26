/**
 * Synthetic evaluation corpus for the live tool-calling evaluator (specification
 * section 30). Every tool schema, prompt, and expected-tool value here is
 * INVENTED — there is no repository content, no real file path, and no customer
 * data. The corpus is deterministic so a run is reproducible.
 */
import { createHash } from "node:crypto";
import type { NormalizedTool, NormalizedToolChoice } from "../tools/index.js";

/** Exactly 200 single-round cases (one upstream completion each). */
export const SINGLE_ROUND_CASES = 200;
/** Exactly 20 three-step scenarios (read → edit → test → final = 4 rounds each). */
export const MULTI_STEP_SCENARIOS = 20;
/** Rounds per three-step scenario (three tool steps plus one final answer). */
export const MULTI_STEP_ROUNDS = 4;
/** Hard cap on upstream completions: 200 + 20 × 4 = 280. */
export const MAX_UPSTREAM_COMPLETIONS =
  SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS * MULTI_STEP_ROUNDS;

/** One upstream round within a scenario. */
export interface EvalRound {
  readonly choice: NormalizedToolChoice;
  readonly prompt: string;
  /** The tool the model is expected to call this round (omitted → final text). */
  readonly expectedTool?: string;
}

/** One evaluation case (a single-round case has exactly one round). */
export interface EvalCase {
  readonly tools: readonly NormalizedTool[];
  readonly selectedLlms: readonly string[];
  readonly rounds: readonly EvalRound[];
}

/** The fixed synthetic tool set (invented schemas only). */
const SYNTHETIC_TOOLS: readonly NormalizedTool[] = Object.freeze([
  {
    name: "read",
    description: "Read a synthetic in-memory document.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description: "Overwrite a synthetic in-memory document.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, text: { type: "string" } },
      required: ["path", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "test",
    description: "Run the synthetic in-memory test suite.",
    parameters: { type: "object", additionalProperties: false },
  },
]);

const SELECTED_LLMS = Object.freeze(["claude"]);

/**
 * Build the full corpus: 200 single-round cases cycling deterministically
 * through auto / required / named-read tool choices, plus 20 three-step
 * read → edit → test → final scenarios. All content is synthetic.
 */
export function buildEvalCases(): EvalCase[] {
  const cases: EvalCase[] = [];

  for (let i = 0; i < SINGLE_ROUND_CASES; i += 1) {
    const mode = i % 3;
    const choice: NormalizedToolChoice =
      mode === 0
        ? { kind: "auto" }
        : mode === 1
          ? { kind: "required" }
          : { kind: "function", name: "read" };
    cases.push({
      tools: SYNTHETIC_TOOLS,
      selectedLlms: SELECTED_LLMS,
      rounds: [
        {
          choice,
          prompt: `Synthetic single-round task #${i}: read the document at synthetic/doc-${i}.txt using the read tool.`,
          expectedTool: "read",
        },
      ],
    });
  }

  for (let j = 0; j < MULTI_STEP_SCENARIOS; j += 1) {
    const doc = `synthetic/module-${j}.txt`;
    cases.push({
      tools: SYNTHETIC_TOOLS,
      selectedLlms: SELECTED_LLMS,
      rounds: [
        { choice: { kind: "auto" }, prompt: `Read ${doc}.`, expectedTool: "read" },
        {
          choice: { kind: "auto" },
          prompt: `Edit ${doc} to bump its synthetic version.`,
          expectedTool: "edit",
        },
        { choice: { kind: "auto" }, prompt: `Run the synthetic test suite.`, expectedTool: "test" },
        { choice: { kind: "auto" }, prompt: `Summarize what changed for ${doc}.` },
      ],
    });
  }

  return cases;
}

/**
 * The planned scoring denominators for a COMPLETE corpus run, computed from the
 * deterministic corpus itself (never hardcoded), so the report can distinguish a
 * partially-sampled metric from a complete one. `expectedCall` is every round
 * expected to produce a tool call (single-round cases plus multi-step tool
 * steps); `single` is the single-round case count; `multi` is the whole-scenario
 * count.
 */
export interface EvalPlan {
  /** Total upstream rounds a complete run performs (the hard cap). */
  readonly plannedUpstreamRounds: number;
  /** Rounds expected to yield a tool call (schema/name/argument denominators). */
  readonly expectedCall: number;
  /** Single-round cases (single-round-success denominator). */
  readonly single: number;
  /** Three-step scenarios (multi-round-success denominator). */
  readonly multi: number;
  /**
   * Expected-tool-call rounds per multi-step scenario — the rounds carrying an
   * `expectedTool` (read/edit/test = 3 for this corpus). This is the GATE
   * denominator contribution per committed scenario, and is DISTINCT from the
   * number of upstream rounds a scenario performs.
   */
  readonly expectedCallsPerScenario: number;
  /**
   * Maximum upstream rounds any single case contains (a three-step scenario has
   * four: read → edit → test → final answer). This is the UPSTREAM-ROUND
   * contribution per committed scenario, used to bound checkpoint round counters,
   * and is DISTINCT from {@link expectedCallsPerScenario}.
   */
  readonly maxRoundsPerCase: number;
}

/**
 * The closed diagnostic tool-choice union. Diagnostics only ever describe
 * `"auto"`, `"required"`, or `"function"` — never `"none"`. This is enforced
 * by {@link buildEvalCorpusProjection} at build time (finding 2) so no
 * downstream constructor (validator, rehydrator, or fresh diagnostic
 * construction) ever has to fall back or silently relabel.
 */
export type DiagnosticChoiceKind = "auto" | "required" | "function";

/**
 * A round in the immutable, content-free structural projection of the eval
 * corpus. It carries ONLY structural facts the checkpoint validator and the
 * diagnostic rehydrator need: the round's `tool_choice` kind (narrowed to the
 * diagnostic union) and whether the round has an `expectedTool`. It never
 * carries a prompt, tool name, schema, argument, model name, id, credential,
 * timestamp, or thrown value.
 */
export interface EvalCorpusRound {
  readonly choiceKind: DiagnosticChoiceKind;
  readonly hasExpectedTool: boolean;
}

/**
 * A case in the immutable, content-free structural projection. `phase` names
 * whether the case is a single-round or multi-step scenario. `rounds` mirrors
 * the actual per-round layout of that case — never inferred from aggregate
 * counts.
 */
export interface EvalCorpusCase {
  readonly phase: "single" | "multi";
  readonly rounds: readonly EvalCorpusRound[];
}

/**
 * The full immutable, content-free structural projection of the corpus, plus
 * pre-computed aggregate bounds derived directly from the same cases (never
 * from external claims). It is the SOLE trust source for corpus-bound checkpoint
 * validation and diagnostic rehydration:
 *
 * - `cases` gives the ACTUAL per-round layout (round count, `choiceKind`, and
 *   `hasExpectedTool` for every round), so a non-uniform corpus is honored
 *   round-by-round rather than reduced to `first N rounds are expected`.
 * - The aggregate bounds (`plannedSingle`, `plannedMulti`,
 *   `expectedCallsPerScenario`, `maxRoundsPerCase`) are derived from those
 *   cases in {@link buildEvalCorpusProjection} and are therefore internally
 *   consistent by construction.
 *
 * Every projected round's `choiceKind` is narrowed at build time to the closed
 * diagnostic union `"auto" | "required" | "function"`. A source round whose
 * `choice.kind` is anything else — notably `"none"`, which the synthetic
 * corpus never uses and which the diagnostic shape cannot represent — is
 * rejected in {@link buildEvalCorpusProjection} (fail-closed at build), so no
 * downstream path (validator, rehydrator, or fresh diagnostic construction)
 * needs a fallback or silent conversion.
 *
 * The projection contains no prompt, tool name, schema, argument, model name,
 * id, credential, timestamp, or thrown value.
 */
export interface EvalCorpusProjection {
  readonly cases: readonly EvalCorpusCase[];
  readonly plannedSingle: number;
  readonly plannedMulti: number;
  readonly expectedCallsPerScenario: number;
  readonly maxRoundsPerCase: number;
}

/**
 * The closed set of `tool_choice.kind` values the diagnostic shape accepts.
 * Any other value (currently only `"none"`, which the synthetic corpus never
 * uses) is rejected at projection build time.
 */
const DIAGNOSTIC_CHOICE_KINDS: ReadonlySet<NormalizedToolChoice["kind"]> = new Set<
  NormalizedToolChoice["kind"]
>(["auto", "required", "function"]);

function isDiagnosticChoiceKind(kind: NormalizedToolChoice["kind"]): kind is DiagnosticChoiceKind {
  return DIAGNOSTIC_CHOICE_KINDS.has(kind);
}

/**
 * Build the immutable, content-free structural projection from a corpus of
 * evaluation cases (typically the fingerprint-bound {@link buildEvalCases}
 * output). Every case, round-count, `choiceKind`, and `hasExpectedTool` value
 * is copied from the SOURCE cases — never inferred — so a non-uniform corpus
 * (a case with more/fewer rounds than its peers, or an expected/final round in
 * an unusual position) is projected accurately. Multi-step scenarios must have
 * a uniform `expectedCallsPerScenario` (the current corpus does), otherwise
 * this throws; the field is used only for the pre-computed aggregate bound.
 *
 * Fails CLOSED at build time on any round whose `choice.kind` is outside the
 * diagnostic union `"auto" | "required" | "function"` (specifically `"none"`,
 * which the synthetic corpus never uses and the diagnostic shape cannot
 * represent). A caller that attempts to run the evaluator against a corpus
 * containing `"none"` throws here — before any credential read or network
 * I/O — rather than being silently relabeled to `"auto"` at diagnostic
 * construction time (finding 2).
 */
export function buildEvalCorpusProjection(cases: readonly EvalCase[]): EvalCorpusProjection {
  const projectedCases: EvalCorpusCase[] = [];
  let plannedSingle = 0;
  let plannedMulti = 0;
  let maxRoundsPerCase = 0;
  let expectedCallsPerScenario = 0;
  let expectedCallsSet = false;
  for (const evalCase of cases) {
    const phase: "single" | "multi" = evalCase.rounds.length > 1 ? "multi" : "single";
    if (phase === "single") plannedSingle += 1;
    else plannedMulti += 1;
    if (evalCase.rounds.length > maxRoundsPerCase) maxRoundsPerCase = evalCase.rounds.length;
    let caseExpected = 0;
    const projectedRounds: EvalCorpusRound[] = [];
    for (const round of evalCase.rounds) {
      if (!isDiagnosticChoiceKind(round.choice.kind)) {
        // Fail closed at build (finding 2): a corpus containing an unsupported
        // choice kind (currently only `"none"`) cannot be represented as a
        // diagnostic and must not enter the pipeline. The evaluator refuses
        // to start rather than silently relabel it.
        throw new Error(
          "eval corpus projection rejects unsupported tool choice kind (only auto/required/function are diagnostic-representable)",
        );
      }
      const hasExpectedTool = round.expectedTool !== undefined;
      if (hasExpectedTool) caseExpected += 1;
      projectedRounds.push(
        Object.freeze({
          choiceKind: round.choice.kind,
          hasExpectedTool,
        }),
      );
    }
    if (phase === "multi") {
      if (!expectedCallsSet) {
        expectedCallsPerScenario = caseExpected;
        expectedCallsSet = true;
      } else if (caseExpected !== expectedCallsPerScenario) {
        // The projection's aggregate bound cannot represent a non-uniform
        // multi-step expected-call count. A truly non-uniform corpus would
        // require the validator to switch to per-case denominators; today's
        // corpus is uniform and the tests exercise both uniformity and the
        // per-round `expectedTool` layout via `cases`.
        throw new Error(
          "eval corpus projection cannot represent non-uniform multi-step expected-call counts",
        );
      }
    }
    projectedCases.push(Object.freeze({ phase, rounds: Object.freeze(projectedRounds) }));
  }
  return Object.freeze({
    cases: Object.freeze(projectedCases),
    plannedSingle,
    plannedMulti,
    expectedCallsPerScenario,
    maxRoundsPerCase,
  });
}

/**
 * Compute the planned scoring denominators from the supplied corpus cases (the
 * fingerprint-bound {@link buildEvalCases} output, or a hermetic test corpus).
 * The zero-argument form builds a fresh corpus for callers that just want the
 * production denominators without owning a case array. The executed evaluator
 * ALWAYS supplies the same `cases` value it fingerprints and projects, so
 * fingerprint, plan, projection, and the case loop all derive from one exact
 * corpus instance (finding 1).
 */
export function evalPlan(cases: readonly EvalCase[] = buildEvalCases()): EvalPlan {
  let expectedCall = 0;
  let single = 0;
  let multi = 0;
  let rounds = 0;
  let maxRoundsPerCase = 0;
  let expectedCallsPerScenario = 0;
  for (const evalCase of cases) {
    rounds += evalCase.rounds.length;
    maxRoundsPerCase = Math.max(maxRoundsPerCase, evalCase.rounds.length);
    let caseExpected = 0;
    for (const round of evalCase.rounds) {
      if (round.expectedTool !== undefined) caseExpected += 1;
    }
    expectedCall += caseExpected;
    if (evalCase.rounds.length > 1) {
      multi += 1;
      // The corpus is uniform, so every multi scenario contributes the same count.
      expectedCallsPerScenario = caseExpected;
    } else {
      single += 1;
    }
  }
  return {
    plannedUpstreamRounds: rounds,
    expectedCall,
    single,
    multi,
    expectedCallsPerScenario,
    maxRoundsPerCase,
  };
}

/**
 * A deterministic, content-free fingerprint of the supplied corpus. The
 * checkpoint records it so a resume can only continue a run built from the exact
 * same corpus; a fingerprint mismatch fails closed before any credential read or
 * network I/O. The digest is over invented synthetic content only, so it exposes
 * no repository or customer data.
 *
 * The zero-argument form builds a fresh corpus for callers that only need the
 * production fingerprint. The executed evaluator ALWAYS supplies the same
 * `cases` value it plans and projects, so fingerprint, plan, projection, and
 * the case loop all derive from one exact corpus instance (finding 1). Every
 * bit of the deterministic corpus — case ordering, tool metadata, prompts,
 * expected tools, model set, and schemas — is included in the digest exactly
 * as before.
 */
export function corpusFingerprint(cases: readonly EvalCase[] = buildEvalCases()): string {
  const canonical = JSON.stringify({
    singleRoundCases: SINGLE_ROUND_CASES,
    multiStepScenarios: MULTI_STEP_SCENARIOS,
    multiStepRounds: MULTI_STEP_ROUNDS,
    cases,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
