/**
 * Synthetic evaluation corpus for the live tool-calling evaluator (specification
 * section 30). Every tool schema, prompt, and expected-tool value here is
 * INVENTED — there is no repository content, no real file path, and no customer
 * data. The corpus is deterministic so a run is reproducible.
 *
 * Multi-step scenarios represent a genuine OpenCode-style agent loop over
 * synthetic in-memory state: ONE initial user message states the whole goal,
 * and later rounds accumulate ONLY through assistant `tool_calls` messages and
 * exactly linked `role: "tool"` synthetic result messages. The evaluator never
 * injects a fresh user instruction between tool results.
 */
import { createHash } from "node:crypto";
import type { NormalizedTool, NormalizedToolChoice } from "../tools/index.js";

/** Exactly 200 single-round cases (one upstream completion each). */
export const SINGLE_ROUND_CASES = 200;
/** Exactly 20 three-step scenarios (read → edit → test → final = 4 rounds each). */
export const MULTI_STEP_SCENARIOS = 20;
/** Maximum rounds per scenario when every step is attempted (3 tool steps + 1 final answer). */
export const MULTI_STEP_ROUNDS = 4;
/**
 * MAXIMUM upstream completions a full corpus can execute (200 + 20 × 4 = 280).
 *
 * NOTE: this is the complete-corpus UPPER BOUND, not the exact attempt count.
 * When a multi-step scenario terminates early (spec §30, early-termination
 * accounting) it stops issuing upstream rounds after its terminal failure, so
 * the actual `attemptedRounds` reported by a complete failed corpus can be
 * strictly less than this maximum. The section-30 gate denominators are
 * unaffected: a terminated scenario still contributes {@link EvalPlan.
 * expectedCallsPerScenario} to `expectedCall.total` and 1 to `multi.total`.
 */
export const MAX_UPSTREAM_COMPLETIONS =
  SINGLE_ROUND_CASES + MULTI_STEP_SCENARIOS * MULTI_STEP_ROUNDS;

/** One upstream round within a scenario. */
export interface EvalRound {
  readonly choice: NormalizedToolChoice;
  /**
   * The prompt string. For a SINGLE-round case, this is the sole user message.
   * For a MULTI-step scenario, ONLY `rounds[0].prompt` is used as the ONE
   * initial user message — later rounds' `prompt` field is ignored by the
   * evaluator (a scenario must not inject a fresh user instruction between
   * tool results). The field is retained so single-round cases stay simple
   * and so the corpus fingerprint captures the intent of every round.
   */
  readonly prompt: string;
  /**
   * The tool this round is PLANNED to produce (omitted → final text).
   *
   * For a SINGLE-round case this is the runtime expectation directly. For a
   * MULTI-step scenario it describes the planned workflow only: it fixes the
   * corpus fingerprint and the section-30 planned denominators
   * (`expectedCallsPerScenario`), but the evaluator no longer scores a
   * multi-step round against the value at its ordinal. The live expectation is
   * derived from the scenario's SUCCESSFULLY completed transitions — see
   * `src/eval/scenario-engine.ts` — because one parallel batch can complete
   * several transitions at once and would otherwise be scored against a stale
   * positional expectation.
   */
  readonly expectedTool?: string;
}

/**
 * Deterministic synthetic state that backs a multi-step scenario's simulated
 * read → edit → test → final loop. Present ONLY for multi-step scenarios;
 * absent for single-round cases. Every field is invented (no repository or
 * customer content) and small/bounded so persisted evidence stays truthful.
 *
 * The loop is entirely synthetic: no filesystem, shell, MCP, external service,
 * repository content, or real user data is ever touched.
 */
export interface EvalScenarioState {
  /** The synthetic path the loop reads/edits (e.g. `synthetic/module-<j>.txt`). */
  readonly path: string;
  /** The deterministic starting content (e.g. `version=1`). */
  readonly initialContent: string;
  /**
   * The exact deterministic replacement the `edit` step is expected to write
   * (e.g. `version=2`). An edit call whose `text` argument matches this value
   * — and whose `path` argument matches {@link path} — flips the runtime
   * state so a later `test` call reports `testsPass: true`.
   */
  readonly expectedFinalContent: string;
}

/** One evaluation case (a single-round case has exactly one round). */
export interface EvalCase {
  readonly tools: readonly NormalizedTool[];
  readonly selectedLlms: readonly string[];
  readonly rounds: readonly EvalRound[];
  /** Present ONLY for multi-step scenarios; absent for single-round cases. */
  readonly scenarioState?: EvalScenarioState;
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
 * read → edit → test → final scenarios. Multi-step scenarios use ONE initial
 * user message (in `rounds[0].prompt`) and a synthetic state that later
 * `read`/`edit`/`test` results reference; later rounds carry an empty prompt
 * as documentation only — the evaluator never re-injects user text mid-loop.
 * All content is synthetic.
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
    const path = `synthetic/module-${j}.txt`;
    const initialContent = "version=1";
    const expectedFinalContent = "version=2";
    // ONE initial user message states the whole goal; later rounds do not
    // inject fresh user instructions between tool results.
    const initialUserPrompt =
      `Synthetic multi-step scenario #${j}: read the document at ${path}, ` +
      `use the edit tool to overwrite its content with exactly "${expectedFinalContent}", ` +
      `then invoke the synthetic tests, and finally return a brief summary of what happened.`;
    cases.push({
      tools: SYNTHETIC_TOOLS,
      selectedLlms: SELECTED_LLMS,
      scenarioState: { path, initialContent, expectedFinalContent },
      rounds: [
        { choice: { kind: "auto" }, prompt: initialUserPrompt, expectedTool: "read" },
        { choice: { kind: "auto" }, prompt: "", expectedTool: "edit" },
        { choice: { kind: "auto" }, prompt: "", expectedTool: "test" },
        { choice: { kind: "auto" }, prompt: "" },
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
  /**
   * MAXIMUM upstream rounds a complete run can perform (the hard cap).
   *
   * NOTE: this is the complete-corpus UPPER BOUND, not the exact attempt
   * count. A complete failed corpus can attempt strictly fewer rounds when
   * multi-step scenarios terminate early (their remaining planned expected-
   * tool steps count as gate misses, NOT as attempted upstream rounds).
   */
  readonly plannedUpstreamRounds: number;
  /** Rounds expected to yield a tool call (schema/name/argument denominators). */
  readonly expectedCall: number;
  /** Single-round cases (single-round-success denominator). */
  readonly single: number;
  /** Three-step scenarios (multi-round-success denominator). */
  readonly multi: number;
  /**
   * Expected-tool-call rounds per multi-step scenario — the rounds carrying an
   * `expectedTool` (read/edit/test = 3 for this corpus). Every COMMITTED
   * scenario contributes exactly this many rounds to the expected-call gate
   * denominator regardless of how many rounds were actually attempted (an
   * early-terminated scenario's remaining expected-tool rounds are counted
   * as gate misses). This is DISTINCT from the number of upstream rounds a
   * scenario performs.
   */
  readonly expectedCallsPerScenario: number;
  /**
   * MAXIMUM upstream rounds any single case can contain (a three-step
   * scenario has four: read → edit → test → final answer). This is the
   * upstream-round CEILING per scenario, used to bound checkpoint round
   * counters and per-scenario executed-round-count ledger entries; the
   * ACTUAL count for a committed scenario can be lower when the scenario
   * terminated early.
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
 * expected tools, model set, schemas, AND each multi-step scenario's synthetic
 * state — is included in the digest exactly as before.
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
