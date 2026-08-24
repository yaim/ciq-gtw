/**
 * Synthetic evaluation corpus for the live tool-calling evaluator (specification
 * section 30). Every tool schema, prompt, and expected-tool value here is
 * INVENTED — there is no repository content, no real file path, and no customer
 * data. The corpus is deterministic so a run is reproducible.
 */
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
