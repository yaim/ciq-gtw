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

/** Compute the planned scoring denominators from the built corpus. */
export function evalPlan(): EvalPlan {
  const cases = buildEvalCases();
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
 * A deterministic, content-free fingerprint of the synthetic corpus. The
 * checkpoint records it so a resume can only continue a run built from the exact
 * same corpus; a fingerprint mismatch fails closed before any credential read or
 * network I/O. The digest is over invented synthetic content only, so it exposes
 * no repository or customer data.
 */
export function corpusFingerprint(): string {
  const cases = buildEvalCases();
  const canonical = JSON.stringify({
    singleRoundCases: SINGLE_ROUND_CASES,
    multiStepScenarios: MULTI_STEP_SCENARIOS,
    multiStepRounds: MULTI_STEP_ROUNDS,
    cases,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
