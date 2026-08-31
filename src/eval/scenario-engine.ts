/**
 * The SHARED, state-aware synthetic transition engine used by every
 * approval-gated live evaluator (specification sections 30 and 30.1).
 *
 * WHY THIS EXISTS. A multi-step scenario models an OpenCode-style agent loop
 * over the ordered synthetic workflow
 *
 *     read → edit → test → final text
 *
 * The evaluator used to expect exactly one named tool per upstream round,
 * keyed by round ORDINAL. That schedule is wrong whenever the model uses the
 * parallel tool calls the request enables: a round that correctly returns
 * `[read, edit]` completes two transitions at once, and the next round's
 * `test` was then scored against a stale round-2 `edit` expectation and
 * reported as a failure. This module replaces the positional schedule with the
 * only thing that is actually true about the loop — which transitions have
 * SUCCESSFULLY completed — so both evaluators derive the current expectation
 * from state rather than from position.
 *
 * WHAT "SUCCESSFUL" MEANS (ordered, prerequisite-gated):
 *
 *  - `read` succeeds only when its `path` argument is the scenario's exact
 *    synthetic path.
 *  - `edit` succeeds only AFTER a successful `read`, and only when both its
 *    `path` and its `text` exactly match the scenario's expected write.
 *  - `test` succeeds only AFTER a successful `edit`, and only when the
 *    synthetic content equals the expected final content.
 *
 * A failed, repeated, or out-of-order call still yields a deterministic,
 * content-safe result that stays in the normalized transcript — it simply does
 * not advance the state. Calls inside one parallel batch are folded in their
 * RETURNED order, so `[read, edit]` advances two transitions while
 * `[edit, read]` advances only `read` (the `edit` ran before its prerequisite).
 *
 * PRIVACY AND SAFETY. Every value here is invented synthetic corpus data. The
 * engine touches no filesystem, shell, MCP server, external service,
 * repository content, or real user data; it executes no tool; and it returns
 * only small bounded JSON strings plus closed structural facts. It is pure
 * with respect to the supplied state object and performs no I/O.
 */
import type { EvalScenarioState } from "./cases.js";
import type { ParsedToolCall } from "../tools/index.js";

/**
 * The fixed ordered workflow. Index 0/1/2 is the first/second/third planned
 * transition, and those indices are the STRUCTURAL bit positions the release
 * checkpoint's per-scenario evidence masks use. The tool names live here (and
 * only here); they are never emitted, logged, or persisted.
 */
export const SCENARIO_STEP_TOOLS = Object.freeze(["read", "edit", "test"] as const);

/** One of the three ordered synthetic workflow steps. */
export type ScenarioStepTool = (typeof SCENARIO_STEP_TOOLS)[number];

/** The number of planned transitions in the fixed workflow (3). */
export const SCENARIO_STEP_COUNT = SCENARIO_STEP_TOOLS.length;

/**
 * The minimum number of upstream rounds a SUCCESSFUL scenario can use: at
 * least one round proposing tool calls (a single parallel batch can complete
 * all three transitions) plus exactly one round returning the final text.
 */
export const MIN_SUCCESSFUL_SCENARIO_ROUNDS = 2;

/**
 * Mutable per-scenario transition state. It exists only inside one scenario's
 * run and is discarded when the scenario ends. `satisfied` is always a PREFIX
 * of the workflow (a later transition cannot succeed before its prerequisite),
 * which is what lets the checkpoint persist it as a single count.
 */
export interface ScenarioTransitionState {
  /** The scenario's synthetic document path (invented corpus data). */
  readonly path: string;
  /** The current synthetic document content. */
  content: string;
  /** Per-step success flags, indexed by {@link SCENARIO_STEP_TOOLS} position. */
  readonly satisfied: boolean[];
}

/** Seed a fresh transition state from the scenario's declared synthetic values. */
export function initializeScenarioTransitions(
  scenario: EvalScenarioState,
): ScenarioTransitionState {
  return {
    path: scenario.path,
    content: scenario.initialContent,
    satisfied: new Array<boolean>(SCENARIO_STEP_COUNT).fill(false),
  };
}

/**
 * How many transitions have succeeded. Because success is prerequisite-gated,
 * the satisfied flags always form a prefix, so this count fully describes the
 * state.
 */
export function satisfiedStepCount(state: ScenarioTransitionState): number {
  let count = 0;
  for (const done of state.satisfied) {
    if (!done) break;
    count += 1;
  }
  return count;
}

/**
 * The 0-based index of the next unsatisfied transition, or `null` when all
 * three have succeeded and the scenario now expects final text.
 */
export function pendingStepIndex(state: ScenarioTransitionState): number | null {
  const count = satisfiedStepCount(state);
  return count >= SCENARIO_STEP_COUNT ? null : count;
}

/**
 * The tool the scenario currently expects, derived from the next unsatisfied
 * transition, or `null` when every transition succeeded (final text expected).
 * This is the state-aware replacement for `EvalRound.expectedTool`.
 */
export function expectedStepTool(state: ScenarioTransitionState): ScenarioStepTool | null {
  const index = pendingStepIndex(state);
  return index === null ? null : (SCENARIO_STEP_TOOLS[index] ?? null);
}

/** The workflow step a tool name belongs to, or `null` for an unrelated name. */
export function stepIndexForTool(name: string): number | null {
  const index = SCENARIO_STEP_TOOLS.indexOf(name as ScenarioStepTool);
  return index < 0 ? null : index;
}

/** The outcome of folding ONE tool call into the scenario state. */
export interface AppliedToolCall {
  /** The workflow step this call targets, or `null` for an unrelated tool. */
  readonly stepIndex: number | null;
  /** True when this call NEWLY completed its transition. */
  readonly advanced: boolean;
  /** The deterministic, content-safe synthetic tool-result JSON string. */
  readonly content: string;
}

/** The outcome of folding a whole parallel batch, in the calls' returned order. */
export interface AppliedToolBatch {
  /** One entry per supplied call, in the same order. */
  readonly applied: readonly AppliedToolCall[];
  /** Step indices NEWLY satisfied by this batch, in the order they advanced. */
  readonly advancedSteps: readonly number[];
}

/** Read a string property from a call's argument JSON without throwing. */
function readStringArg(argumentsJson: string, key: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Fold ONE tool call into the scenario state and render its deterministic
 * synthetic result. Prerequisite-gated per the module docstring: an `edit`
 * before a successful `read`, or a `test` before a successful `edit`, reports
 * failure and leaves the state untouched.
 *
 * The rendered results are bounded, content-safe, and derived only from the
 * scenario's invented state:
 *
 *  - `read`  → `{"ok":true,"path":P,"content":C}` on the exact path, else
 *              `{"ok":false,"path":P}`. A successful read supplies the path and
 *              content the model needs to construct the expected `edit`.
 *  - `edit`  → `{"ok":<bool>,"path":P}`; on success the content flips to the
 *              expected final content.
 *  - `test`  → `{"ok":true,"testsPass":<bool>}`, where the pass value depends
 *              only on prior synthetic state.
 *  - unknown → `{"ok":false}`.
 */
export function applyToolCall(
  call: ParsedToolCall,
  scenario: EvalScenarioState,
  state: ScenarioTransitionState,
): AppliedToolCall {
  const stepIndex = stepIndexForTool(call.name);

  if (call.name === "read") {
    const pathOk = readStringArg(call.argumentsJson, "path") === scenario.path;
    const advanced = pathOk && !state.satisfied[0];
    if (advanced) state.satisfied[0] = true;
    return {
      stepIndex,
      advanced,
      content: pathOk
        ? JSON.stringify({ ok: true, path: state.path, content: state.content })
        : JSON.stringify({ ok: false, path: state.path }),
    };
  }

  if (call.name === "edit") {
    const pathArg = readStringArg(call.argumentsJson, "path");
    const textArg = readStringArg(call.argumentsJson, "text");
    const argsOk = pathArg === scenario.path && textArg === scenario.expectedFinalContent;
    // Prerequisite: the document must have been read successfully first.
    const ok = state.satisfied[0] === true && argsOk;
    if (ok) state.content = scenario.expectedFinalContent;
    const advanced = ok && !state.satisfied[1];
    if (advanced) state.satisfied[1] = true;
    return { stepIndex, advanced, content: JSON.stringify({ ok, path: state.path }) };
  }

  if (call.name === "test") {
    // Prerequisite: the edit must have landed before the tests can pass.
    const testsPass =
      state.satisfied[1] === true && state.content === scenario.expectedFinalContent;
    const advanced = testsPass && !state.satisfied[2];
    if (advanced) state.satisfied[2] = true;
    return { stepIndex, advanced, content: JSON.stringify({ ok: true, testsPass }) };
  }

  // An unrelated tool name. The evaluator only forwards allowed calls, so this
  // is unreachable for the production corpus, but stay explicit and safe.
  return { stepIndex, advanced: false, content: JSON.stringify({ ok: false }) };
}

/**
 * Fold a whole parallel batch of calls into the scenario state, IN THE ORDER
 * THE MODEL RETURNED THEM, and report which transitions newly succeeded. One
 * batch may advance several consecutive transitions (`[read, edit]` advances
 * two; `[read, edit, test]` advances all three), while an out-of-order batch
 * advances only what its prerequisites allow (`[edit, read]` advances only
 * `read`).
 */
export function applyToolCallBatch(
  calls: readonly ParsedToolCall[],
  scenario: EvalScenarioState,
  state: ScenarioTransitionState,
): AppliedToolBatch {
  const applied: AppliedToolCall[] = [];
  const advancedSteps: number[] = [];
  for (const call of calls) {
    const result = applyToolCall(call, scenario, state);
    applied.push(result);
    if (result.advanced && result.stepIndex !== null) advancedSteps.push(result.stepIndex);
  }
  return { applied, advancedSteps };
}

// ---------------------------------------------------------------------------
// Per-step gate evidence
// ---------------------------------------------------------------------------

/**
 * Independent per-step evidence for one scenario's three planned transitions.
 * Each array is indexed by workflow step position and each flag is set at most
 * once, so retrying a step merges its evidence rather than double-counting it.
 *
 * At scenario commit each planned step contributes EXACTLY ONE unit to the
 * section-30 expected-step denominator (the planned 260 total is unchanged);
 * a flag left false is a truthful miss.
 */
export interface ScenarioStepEvidence {
  /** The round produced a schema-valid selected tool-call set for this step. */
  readonly schemaValid: boolean[];
  /** The selected call set satisfied the supplied JSON Schema for this step. */
  readonly argValid: boolean[];
  /** The step's expected tool was present in an allowed selected call set. */
  readonly nameAccurate: boolean[];
  /** The transition SUCCEEDED (implies the three flags above). */
  readonly satisfied: boolean[];
}

/** A fresh, all-false evidence record for the fixed three-step workflow. */
export function initializeStepEvidence(): ScenarioStepEvidence {
  return {
    schemaValid: new Array<boolean>(SCENARIO_STEP_COUNT).fill(false),
    argValid: new Array<boolean>(SCENARIO_STEP_COUNT).fill(false),
    nameAccurate: new Array<boolean>(SCENARIO_STEP_COUNT).fill(false),
    satisfied: new Array<boolean>(SCENARIO_STEP_COUNT).fill(false),
  };
}

/**
 * Record that the CURRENTLY PENDING step received a valid selected tool-call
 * set. Schema and argument evidence follow the existing round behavior (the
 * selection engine only yields schema- and argument-valid calls); expected-name
 * evidence is marked only when that step's tool was actually present in an
 * allowed set.
 */
export function creditPendingStep(
  evidence: ScenarioStepEvidence,
  stepIndex: number,
  options: { readonly schemaAndArgValid: boolean; readonly expectedNamePresent: boolean },
): void {
  if (stepIndex < 0 || stepIndex >= SCENARIO_STEP_COUNT) return;
  if (options.schemaAndArgValid) {
    evidence.schemaValid[stepIndex] = true;
    evidence.argValid[stepIndex] = true;
  }
  if (options.expectedNamePresent) evidence.nameAccurate[stepIndex] = true;
}

/**
 * Record a SUCCESSFULLY COMPLETED transition. A successful transition
 * necessarily proves the call was schema-valid, argument-valid, and correctly
 * named, so it marks all four flags — which is how an extra transition
 * completed inside a parallel batch receives full evidence.
 */
export function creditSatisfiedStep(evidence: ScenarioStepEvidence, stepIndex: number): void {
  if (stepIndex < 0 || stepIndex >= SCENARIO_STEP_COUNT) return;
  evidence.schemaValid[stepIndex] = true;
  evidence.argValid[stepIndex] = true;
  evidence.nameAccurate[stepIndex] = true;
  evidence.satisfied[stepIndex] = true;
}

/** Pack a boolean-per-step array into a compact bitmask (bit i = step i). */
export function stepMask(flags: readonly boolean[]): number {
  let mask = 0;
  for (let i = 0; i < SCENARIO_STEP_COUNT; i += 1) {
    if (flags[i] === true) mask |= 1 << i;
  }
  return mask;
}

/** Count the set bits of a bounded, non-negative step mask. */
export function popcount(mask: number): number {
  let count = 0;
  let remaining = mask;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

/** The mask of the first `count` steps (the satisfied prefix). */
export function prefixMask(count: number): number {
  if (count <= 0) return 0;
  const bounded = Math.min(count, SCENARIO_STEP_COUNT);
  return (1 << bounded) - 1;
}

/**
 * Fail closed unless every multi-step case in the supplied corpus plans EXACTLY
 * the engine's ordered workflow: the same number of expected-tool rounds as
 * {@link SCENARIO_STEP_COUNT}, carrying the same tool at every position as
 * {@link SCENARIO_STEP_TOOLS}.
 *
 * Counting alone is not enough. The engine always evaluates the fixed sequence
 * `read → edit → test`, so a corpus declaring the right NUMBER of transitions
 * in the wrong order (or with a substituted or duplicated tool) would let the
 * planned workflow — which the corpus fingerprint commits to — diverge silently
 * from the semantics the executed evaluator applies. Either kind of mismatch
 * also lets a live run persist evidence its own checkpoint validator rejects,
 * i.e. a legitimate run producing an unresumable checkpoint.
 *
 * Callers invoke this once per run, BEFORE any credential read or network I/O,
 * so a mismatched corpus can never reach the upstream path. The failure is
 * value-free: it names no tool, prompt, argument, path, or supplied value.
 *
 * This is deliberately NOT enforced inside `buildEvalCorpusProjection`: the
 * projection is also built standalone by hermetic tests that probe the
 * validator against non-uniform structural corpora it must still judge
 * correctly.
 */
export function assertCorpusMatchesEngine(
  cases: readonly { readonly rounds: readonly { readonly expectedTool?: string }[] }[],
): void {
  for (const evalCase of cases) {
    if (evalCase.rounds.length <= 1) continue;
    const planned: string[] = [];
    for (const round of evalCase.rounds) {
      if (round.expectedTool !== undefined) planned.push(round.expectedTool);
    }
    if (planned.length !== SCENARIO_STEP_COUNT) {
      throw new Error(
        "eval corpus multi-step case plans a different transition count than the scenario engine tracks",
      );
    }
    for (let i = 0; i < SCENARIO_STEP_COUNT; i += 1) {
      if (planned[i] !== SCENARIO_STEP_TOOLS[i]) {
        throw new Error(
          "eval corpus multi-step case plans a different ordered transition workflow than the scenario engine tracks",
        );
      }
    }
  }
}
