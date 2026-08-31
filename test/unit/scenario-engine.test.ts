/**
 * Hermetic unit tests for the SHARED, state-aware synthetic transition engine
 * (`src/eval/scenario-engine.ts`, specification sections 30 and 30.1).
 *
 * Every value below is invented synthetic corpus data. The engine touches no
 * filesystem, shell, MCP server, external service, repository content, or real
 * user data; it executes no tool; and it is pure with respect to the supplied
 * state object. These tests assert that contract directly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyToolCall,
  applyToolCallBatch,
  assertCorpusMatchesEngine,
  creditPendingStep,
  creditSatisfiedStep,
  expectedStepTool,
  initializeScenarioTransitions,
  initializeStepEvidence,
  MIN_SUCCESSFUL_SCENARIO_ROUNDS,
  pendingStepIndex,
  popcount,
  prefixMask,
  satisfiedStepCount,
  SCENARIO_STEP_COUNT,
  SCENARIO_STEP_TOOLS,
  stepIndexForTool,
  stepMask,
  type AppliedToolCall,
  type ScenarioTransitionState,
} from "../../src/eval/scenario-engine.js";
import { buildEvalCases, type EvalScenarioState } from "../../src/eval/cases.js";
import type { ParsedToolCall } from "../../src/tools/index.js";

/** The synthetic scenario under test (invented; matches no real path/content). */
const SCENARIO: EvalScenarioState = Object.freeze({
  path: "synthetic/module-0.txt",
  initialContent: "version=1",
  expectedFinalContent: "version=2",
});

/** A SECOND, independent synthetic scenario used for isolation checks. */
const OTHER: EvalScenarioState = Object.freeze({
  path: "synthetic/module-1.txt",
  initialContent: "version=1",
  expectedFinalContent: "version=2",
});

/** A path that belongs to no scenario under test. */
const FOREIGN_PATH = "synthetic/module-9.txt";
/** A replacement the scenario does NOT expect. */
const WRONG_TEXT = "version=3";

let callSeq = 0;
/** Build a synthetic parsed call; the gateway-owned id is never read by the engine. */
function call(name: string, argumentsJson: string): ParsedToolCall {
  callSeq += 1;
  return { id: `call_ciq_SYNTH${callSeq}`, name, argumentsJson };
}
function readCall(path: string = SCENARIO.path): ParsedToolCall {
  return call("read", JSON.stringify({ path }));
}
function editCall(
  path: string = SCENARIO.path,
  text: string = SCENARIO.expectedFinalContent,
): ParsedToolCall {
  return call("edit", JSON.stringify({ path, text }));
}
function testCall(): ParsedToolCall {
  return call("test", "{}");
}

/** Decode a rendered synthetic tool result (always small, bounded JSON). */
function resultOf(applied: AppliedToolCall): Record<string, unknown> {
  return JSON.parse(applied.content) as Record<string, unknown>;
}

/** Drive a state through a successful `read`, returning it for the next step. */
function afterRead(scenario: EvalScenarioState = SCENARIO): ScenarioTransitionState {
  const state = initializeScenarioTransitions(scenario);
  applyToolCall(readCall(scenario.path), scenario, state);
  return state;
}

/** Drive a state through a successful `read` + `edit`. */
function afterEdit(scenario: EvalScenarioState = SCENARIO): ScenarioTransitionState {
  const state = afterRead(scenario);
  applyToolCall(editCall(scenario.path, scenario.expectedFinalContent), scenario, state);
  return state;
}

describe("scenario-engine — read transition", () => {
  it("advances step 0 on the scenario's exact path and supplies the current content", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const applied = applyToolCall(readCall(), SCENARIO, state);
    expect(applied.stepIndex).toBe(0);
    expect(applied.advanced).toBe(true);
    expect(resultOf(applied)).toEqual({
      ok: true,
      path: SCENARIO.path,
      content: SCENARIO.initialContent,
    });
    expect(satisfiedStepCount(state)).toBe(1);
  });

  it("does not advance on a different path and reports failure", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const applied = applyToolCall(readCall(FOREIGN_PATH), SCENARIO, state);
    expect(applied.stepIndex).toBe(0);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: false, path: SCENARIO.path });
    expect(satisfiedStepCount(state)).toBe(0);
    expect(expectedStepTool(state)).toBe("read");
  });
});

describe("scenario-engine — edit transition", () => {
  it("does not advance before a successful read (prerequisite-gated)", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const applied = applyToolCall(editCall(), SCENARIO, state);
    expect(applied.stepIndex).toBe(1);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: false, path: SCENARIO.path });
    expect(satisfiedStepCount(state)).toBe(0);
    // The document was NOT rewritten by a premature edit.
    expect(state.content).toBe(SCENARIO.initialContent);
  });

  it("advances step 1 on the exact path + text after a successful read", () => {
    const state = afterRead();
    const applied = applyToolCall(editCall(), SCENARIO, state);
    expect(applied.advanced).toBe(true);
    expect(resultOf(applied)).toEqual({ ok: true, path: SCENARIO.path });
    expect(satisfiedStepCount(state)).toBe(2);
    expect(state.content).toBe(SCENARIO.expectedFinalContent);
  });

  it("does not advance on a wrong path", () => {
    const state = afterRead();
    const applied = applyToolCall(editCall(FOREIGN_PATH), SCENARIO, state);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: false, path: SCENARIO.path });
    expect(satisfiedStepCount(state)).toBe(1);
    expect(state.content).toBe(SCENARIO.initialContent);
  });

  it("does not advance on wrong replacement text", () => {
    const state = afterRead();
    const applied = applyToolCall(editCall(SCENARIO.path, WRONG_TEXT), SCENARIO, state);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: false, path: SCENARIO.path });
    expect(satisfiedStepCount(state)).toBe(1);
    expect(state.content).toBe(SCENARIO.initialContent);
    // The step stays PENDING, so a later correct retry can still land.
    expect(expectedStepTool(state)).toBe("edit");
  });
});

describe("scenario-engine — malformed or missing arguments never advance", () => {
  it("rejects unparsable, non-object, and wrongly-typed read arguments", () => {
    for (const argumentsJson of [
      "not json at all",
      "null",
      '"a bare string"',
      "42",
      "[]",
      "{}",
      '{"path":42}',
      '{"path":null}',
      '{"other":"synthetic/module-0.txt"}',
    ]) {
      const state = initializeScenarioTransitions(SCENARIO);
      const applied = applyToolCall(call("read", argumentsJson), SCENARIO, state);
      expect(applied.advanced).toBe(false);
      expect(resultOf(applied)).toEqual({ ok: false, path: SCENARIO.path });
      expect(satisfiedStepCount(state)).toBe(0);
    }
  });

  it("rejects unparsable or incomplete edit arguments even after a successful read", () => {
    for (const argumentsJson of [
      "not json at all",
      "null",
      "[]",
      "{}",
      '{"path":"synthetic/module-0.txt"}',
      '{"text":"version=2"}',
      '{"path":"synthetic/module-0.txt","text":2}',
    ]) {
      const state = afterRead();
      const applied = applyToolCall(call("edit", argumentsJson), SCENARIO, state);
      expect(applied.advanced).toBe(false);
      expect(resultOf(applied)).toEqual({ ok: false, path: SCENARIO.path });
      expect(satisfiedStepCount(state)).toBe(1);
      expect(state.content).toBe(SCENARIO.initialContent);
    }
  });
});

describe("scenario-engine — test transition", () => {
  it("reports failing tests and does not advance before a successful edit", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const applied = applyToolCall(testCall(), SCENARIO, state);
    expect(applied.stepIndex).toBe(2);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: true, testsPass: false });
    expect(satisfiedStepCount(state)).toBe(0);
  });

  it("reports failing tests when only the read succeeded", () => {
    const state = afterRead();
    const applied = applyToolCall(testCall(), SCENARIO, state);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: true, testsPass: false });
    expect(satisfiedStepCount(state)).toBe(1);
  });

  it("advances step 2 and reports passing tests after a successful edit", () => {
    const state = afterEdit();
    const applied = applyToolCall(testCall(), SCENARIO, state);
    expect(applied.advanced).toBe(true);
    expect(resultOf(applied)).toEqual({ ok: true, testsPass: true });
    expect(satisfiedStepCount(state)).toBe(3);
  });
});

describe("scenario-engine — repeated calls never double-advance", () => {
  it("a second successful read leaves the satisfied count unchanged", () => {
    const state = afterRead();
    const applied = applyToolCall(readCall(), SCENARIO, state);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({
      ok: true,
      path: SCENARIO.path,
      content: SCENARIO.initialContent,
    });
    expect(satisfiedStepCount(state)).toBe(1);
  });

  it("a second successful edit leaves the satisfied count unchanged", () => {
    const state = afterEdit();
    const applied = applyToolCall(editCall(), SCENARIO, state);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: true, path: SCENARIO.path });
    expect(satisfiedStepCount(state)).toBe(2);
    expect(state.content).toBe(SCENARIO.expectedFinalContent);
  });

  it("a second test leaves the satisfied count unchanged", () => {
    const state = afterEdit();
    applyToolCall(testCall(), SCENARIO, state);
    const applied = applyToolCall(testCall(), SCENARIO, state);
    expect(applied.advanced).toBe(false);
    expect(resultOf(applied)).toEqual({ ok: true, testsPass: true });
    expect(satisfiedStepCount(state)).toBe(3);
  });
});

describe("scenario-engine — parallel batches fold in the returned order", () => {
  it("[read, edit] advances exactly two steps in one batch", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch([readCall(), editCall()], SCENARIO, state);
    expect(batch.advancedSteps).toEqual([0, 1]);
    expect(batch.applied.map((a) => a.advanced)).toEqual([true, true]);
    expect(satisfiedStepCount(state)).toBe(2);
    expect(expectedStepTool(state)).toBe("test");
  });

  it("[read, edit, test] advances all three in one batch", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch([readCall(), editCall(), testCall()], SCENARIO, state);
    expect(batch.advancedSteps).toEqual([0, 1, 2]);
    expect(satisfiedStepCount(state)).toBe(SCENARIO_STEP_COUNT);
    expect(expectedStepTool(state)).toBeNull();
    expect(resultOf(batch.applied[2] as AppliedToolCall)).toEqual({ ok: true, testsPass: true });
  });

  it("[edit, read] advances only read (the edit ran before its prerequisite)", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch([editCall(), readCall()], SCENARIO, state);
    expect(batch.advancedSteps).toEqual([0]);
    expect(batch.applied.map((a) => a.advanced)).toEqual([false, true]);
    expect(satisfiedStepCount(state)).toBe(1);
    expect(expectedStepTool(state)).toBe("edit");
    expect(state.content).toBe(SCENARIO.initialContent);
  });

  it("[read, test] advances only read and the test result reports failure", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch([readCall(), testCall()], SCENARIO, state);
    expect(batch.advancedSteps).toEqual([0]);
    expect(resultOf(batch.applied[1] as AppliedToolCall)).toEqual({ ok: true, testsPass: false });
    expect(satisfiedStepCount(state)).toBe(1);
  });

  it("an empty batch advances nothing", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch([], SCENARIO, state);
    expect(batch.applied).toEqual([]);
    expect(batch.advancedSteps).toEqual([]);
    expect(satisfiedStepCount(state)).toBe(0);
  });
});

describe("scenario-engine — unrelated tool names", () => {
  it('yields {"ok":false} and advances nothing', () => {
    const state = afterRead();
    const applied = applyToolCall(call("unrelated", "{}"), SCENARIO, state);
    expect(applied.stepIndex).toBeNull();
    expect(applied.advanced).toBe(false);
    expect(applied.content).toBe('{"ok":false}');
    expect(satisfiedStepCount(state)).toBe(1);
  });

  it("is excluded from a batch's advanced steps", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch(
      [call("unrelated", "{}"), readCall(), call("also-unrelated", "{}")],
      SCENARIO,
      state,
    );
    expect(batch.advancedSteps).toEqual([0]);
    expect(satisfiedStepCount(state)).toBe(1);
  });
});

describe("scenario-engine — expectation tracking follows the satisfied prefix", () => {
  it("names the fixed workflow and its bounds", () => {
    expect([...SCENARIO_STEP_TOOLS]).toEqual(["read", "edit", "test"]);
    expect(SCENARIO_STEP_COUNT).toBe(3);
    expect(MIN_SUCCESSFUL_SCENARIO_ROUNDS).toBe(2);
    expect(stepIndexForTool("read")).toBe(0);
    expect(stepIndexForTool("edit")).toBe(1);
    expect(stepIndexForTool("test")).toBe(2);
    expect(stepIndexForTool("unrelated")).toBeNull();
  });

  it("tracks pendingStepIndex / expectedStepTool / satisfiedStepCount across the workflow", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    expect(satisfiedStepCount(state)).toBe(0);
    expect(pendingStepIndex(state)).toBe(0);
    expect(expectedStepTool(state)).toBe("read");

    applyToolCall(readCall(), SCENARIO, state);
    expect(satisfiedStepCount(state)).toBe(1);
    expect(pendingStepIndex(state)).toBe(1);
    expect(expectedStepTool(state)).toBe("edit");

    applyToolCall(editCall(), SCENARIO, state);
    expect(satisfiedStepCount(state)).toBe(2);
    expect(pendingStepIndex(state)).toBe(2);
    expect(expectedStepTool(state)).toBe("test");

    applyToolCall(testCall(), SCENARIO, state);
    expect(satisfiedStepCount(state)).toBe(3);
    // All three succeeded: the scenario now expects FINAL TEXT, not a tool.
    expect(pendingStepIndex(state)).toBeNull();
    expect(expectedStepTool(state)).toBeNull();
  });

  it("counts only the leading prefix, never a stray later flag", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    // A non-prefix flag combination cannot arise from the engine itself; assert
    // the accessor still reports the truthful prefix if one is ever supplied.
    state.satisfied[2] = true;
    expect(satisfiedStepCount(state)).toBe(0);
    expect(expectedStepTool(state)).toBe("read");
  });
});

describe("scenario-engine — step masks round-trip", () => {
  it("packs a boolean-per-step array into a bitmask", () => {
    expect(stepMask([])).toBe(0);
    expect(stepMask([true, false, false])).toBe(0b001);
    expect(stepMask([false, true, false])).toBe(0b010);
    expect(stepMask([true, false, true])).toBe(0b101);
    expect(stepMask([true, true, true])).toBe(0b111);
    // Only the fixed three step positions are ever packed.
    expect(stepMask([true, true, true, true])).toBe(0b111);
  });

  it("counts set bits and builds satisfied prefixes", () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(0b001)).toBe(1);
    expect(popcount(0b101)).toBe(2);
    expect(popcount(0b111)).toBe(3);
    expect(prefixMask(-1)).toBe(0);
    expect(prefixMask(0)).toBe(0);
    expect(prefixMask(1)).toBe(0b001);
    expect(prefixMask(2)).toBe(0b011);
    expect(prefixMask(3)).toBe(0b111);
    // Clamped to the fixed workflow length.
    expect(prefixMask(9)).toBe(0b111);
    for (let count = 0; count <= SCENARIO_STEP_COUNT; count += 1) {
      expect(popcount(prefixMask(count))).toBe(count);
    }
  });

  it("round-trips a live scenario's satisfied flags through mask + popcount", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    for (const step of [readCall(), editCall(), testCall()]) {
      applyToolCall(step, SCENARIO, state);
      const mask = stepMask(state.satisfied);
      expect(mask).toBe(prefixMask(satisfiedStepCount(state)));
      expect(popcount(mask)).toBe(satisfiedStepCount(state));
    }
  });
});

describe("scenario-engine — per-step evidence is merged, never double-counted", () => {
  it("starts all-false for the fixed three-step workflow", () => {
    const evidence = initializeStepEvidence();
    expect(evidence.schemaValid).toEqual([false, false, false]);
    expect(evidence.argValid).toEqual([false, false, false]);
    expect(evidence.nameAccurate).toEqual([false, false, false]);
    expect(evidence.satisfied).toEqual([false, false, false]);
  });

  it("creditPendingStep records schema/argument and expected-name evidence independently", () => {
    const evidence = initializeStepEvidence();
    creditPendingStep(evidence, 1, { schemaAndArgValid: true, expectedNamePresent: false });
    expect(stepMask(evidence.schemaValid)).toBe(0b010);
    expect(stepMask(evidence.argValid)).toBe(0b010);
    expect(stepMask(evidence.nameAccurate)).toBe(0);
    expect(stepMask(evidence.satisfied)).toBe(0);

    creditPendingStep(evidence, 1, { schemaAndArgValid: false, expectedNamePresent: true });
    expect(stepMask(evidence.nameAccurate)).toBe(0b010);
    // A later false never clears an already-recorded flag.
    expect(stepMask(evidence.schemaValid)).toBe(0b010);
    expect(stepMask(evidence.satisfied)).toBe(0);
  });

  it("creditPendingStep is idempotent: crediting twice does not change the masks", () => {
    const evidence = initializeStepEvidence();
    const options = { schemaAndArgValid: true, expectedNamePresent: true } as const;
    creditPendingStep(evidence, 0, options);
    const snapshot = [
      stepMask(evidence.schemaValid),
      stepMask(evidence.argValid),
      stepMask(evidence.nameAccurate),
      stepMask(evidence.satisfied),
    ];
    creditPendingStep(evidence, 0, options);
    creditPendingStep(evidence, 0, options);
    expect([
      stepMask(evidence.schemaValid),
      stepMask(evidence.argValid),
      stepMask(evidence.nameAccurate),
      stepMask(evidence.satisfied),
    ]).toEqual(snapshot);
  });

  it("creditSatisfiedStep sets schema + argument + name + satisfied together, idempotently", () => {
    const evidence = initializeStepEvidence();
    creditSatisfiedStep(evidence, 2);
    expect(stepMask(evidence.schemaValid)).toBe(0b100);
    expect(stepMask(evidence.argValid)).toBe(0b100);
    expect(stepMask(evidence.nameAccurate)).toBe(0b100);
    expect(stepMask(evidence.satisfied)).toBe(0b100);

    creditSatisfiedStep(evidence, 2);
    creditSatisfiedStep(evidence, 2);
    expect(popcount(stepMask(evidence.schemaValid))).toBe(1);
    expect(popcount(stepMask(evidence.nameAccurate))).toBe(1);
    expect(popcount(stepMask(evidence.satisfied))).toBe(1);
  });

  it("ignores an out-of-range step index instead of growing the evidence arrays", () => {
    const evidence = initializeStepEvidence();
    creditPendingStep(evidence, -1, { schemaAndArgValid: true, expectedNamePresent: true });
    creditPendingStep(evidence, SCENARIO_STEP_COUNT, {
      schemaAndArgValid: true,
      expectedNamePresent: true,
    });
    creditSatisfiedStep(evidence, -1);
    creditSatisfiedStep(evidence, SCENARIO_STEP_COUNT);
    expect(evidence.schemaValid).toHaveLength(SCENARIO_STEP_COUNT);
    expect(evidence.satisfied).toHaveLength(SCENARIO_STEP_COUNT);
    expect(stepMask(evidence.schemaValid)).toBe(0);
    expect(stepMask(evidence.satisfied)).toBe(0);
  });

  it("merges a retried step's evidence into ONE unit of credit", () => {
    // A wrong-text edit credits schema/argument/name but not satisfaction; the
    // later correct retry completes the transition. Each flag stays a single bit.
    const evidence = initializeStepEvidence();
    creditPendingStep(evidence, 1, { schemaAndArgValid: true, expectedNamePresent: true });
    creditPendingStep(evidence, 1, { schemaAndArgValid: true, expectedNamePresent: true });
    creditSatisfiedStep(evidence, 1);
    expect(popcount(stepMask(evidence.schemaValid))).toBe(1);
    expect(popcount(stepMask(evidence.argValid))).toBe(1);
    expect(popcount(stepMask(evidence.nameAccurate))).toBe(1);
    expect(popcount(stepMask(evidence.satisfied))).toBe(1);
  });
});

describe("scenario-engine — purely in-memory, no I/O and no tool execution", () => {
  it("imports no filesystem, process, or network capability", () => {
    // An explicit structural guard: the engine renders results from the supplied
    // synthetic state ONLY. Acquiring any of these capabilities would mean it had
    // started touching a real file, shell, or service.
    const source = readFileSync(
      new URL("../../src/eval/scenario-engine.ts", import.meta.url),
      "utf8",
    );
    for (const capability of [
      "node:fs",
      "node:child_process",
      "node:process",
      "node:http",
      "node:https",
      "node:net",
      "node:worker_threads",
      "execSync",
      "spawn",
      "fetch(",
      "require(",
    ]) {
      expect(source).not.toContain(capability);
    }
  });

  it("depends only on the supplied state: a fresh state reproduces the result byte-for-byte", () => {
    const first = applyToolCall(readCall(), SCENARIO, initializeScenarioTransitions(SCENARIO));
    const second = applyToolCall(readCall(), SCENARIO, initializeScenarioTransitions(SCENARIO));
    expect(second).toEqual(first);
    // `test` reports passing tests purely from prior in-memory state — nothing ran.
    const pending = applyToolCall(testCall(), SCENARIO, initializeScenarioTransitions(SCENARIO));
    const completed = applyToolCall(testCall(), SCENARIO, afterEdit());
    expect(resultOf(pending)).toEqual({ ok: true, testsPass: false });
    expect(resultOf(completed)).toEqual({ ok: true, testsPass: true });
  });

  it("two independently initialized states do not interfere", () => {
    const a = initializeScenarioTransitions(SCENARIO);
    const b = initializeScenarioTransitions(OTHER);
    applyToolCallBatch([readCall(SCENARIO.path), editCall(SCENARIO.path)], SCENARIO, a);
    expect(satisfiedStepCount(a)).toBe(2);
    expect(a.content).toBe(SCENARIO.expectedFinalContent);
    // `b` saw none of `a`'s work.
    expect(satisfiedStepCount(b)).toBe(0);
    expect(b.content).toBe(OTHER.initialContent);
    expect(expectedStepTool(b)).toBe("read");
    const bRead = applyToolCall(call("read", JSON.stringify({ path: OTHER.path })), OTHER, b);
    expect(resultOf(bRead)).toEqual({
      ok: true,
      path: OTHER.path,
      content: OTHER.initialContent,
    });
    // And `a` is unchanged by `b`'s work.
    expect(satisfiedStepCount(a)).toBe(2);
  });

  it("never mutates the scenario descriptor it is given", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    applyToolCallBatch([readCall(), editCall(), testCall()], SCENARIO, state);
    expect(SCENARIO).toEqual({
      path: "synthetic/module-0.txt",
      initialContent: "version=1",
      expectedFinalContent: "version=2",
    });
    // The state is seeded from — not aliased to — the descriptor.
    expect(state.path).toBe(SCENARIO.path);
    expect(state.content).toBe(SCENARIO.expectedFinalContent);
  });

  it("renders only small bounded JSON drawn from the scenario's own values", () => {
    const state = initializeScenarioTransitions(SCENARIO);
    const batch = applyToolCallBatch(
      [readCall(), editCall(), testCall(), call("unrelated", "{}")],
      SCENARIO,
      state,
    );
    for (const applied of batch.applied) {
      expect(applied.content.length).toBeLessThan(256);
      const parsed = resultOf(applied);
      for (const key of Object.keys(parsed)) {
        expect(["ok", "path", "content", "testsPass"]).toContain(key);
      }
      for (const value of Object.values(parsed)) {
        if (typeof value === "string") {
          expect([SCENARIO.path, SCENARIO.initialContent, SCENARIO.expectedFinalContent]).toContain(
            value,
          );
        }
      }
    }
  });
});

describe("scenario engine — corpus/engine agreement guard", () => {
  const step = (expectedTool?: string): { readonly expectedTool?: string } =>
    expectedTool === undefined ? {} : { expectedTool };

  it("accepts the production corpus", () => {
    expect(() => assertCorpusMatchesEngine(buildEvalCases())).not.toThrow();
  });

  it("ignores single-round cases, which plan no transitions", () => {
    expect(() =>
      assertCorpusMatchesEngine([{ rounds: [step("read")] }, { rounds: [step()] }]),
    ).not.toThrow();
  });

  it("accepts a multi-step case planning exactly the engine's transition count", () => {
    expect(() =>
      assertCorpusMatchesEngine([{ rounds: [step("read"), step("edit"), step("test"), step()] }]),
    ).not.toThrow();
  });

  it("FAILS CLOSED on a multi-step case planning more transitions than the engine tracks", () => {
    // The engine caps its expectation at SCENARIO_STEP_COUNT, so a fourth
    // planned transition would let a truthful run persist evidence its own
    // checkpoint validator rejects as "succeeded without every transition".
    expect(() =>
      assertCorpusMatchesEngine([
        { rounds: [step("read"), step("edit"), step("test"), step("read"), step()] },
      ]),
    ).toThrow(/transition count/);
  });

  it("FAILS CLOSED on a multi-step case planning fewer transitions than the engine tracks", () => {
    // The mirror image: the engine would satisfy three transitions while the
    // validator bounds `satisfiedSteps` by the case's two planned steps.
    expect(() =>
      assertCorpusMatchesEngine([{ rounds: [step("read"), step("edit"), step()] }]),
    ).toThrow(/transition count/);
  });

  it("reports a value-free message naming no tool, prompt, or argument", () => {
    let message = "";
    try {
      assertCorpusMatchesEngine([{ rounds: [step("read"), step("edit"), step()] }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    for (const forbidden of ["read", "edit", "test", "synthetic", "version="]) {
      expect(message).not.toContain(forbidden);
    }
  });
});

describe("scenario engine — corpus guard validates the ORDERED workflow", () => {
  const step = (expectedTool?: string): { readonly expectedTool?: string } =>
    expectedTool === undefined ? {} : { expectedTool };
  /** A multi-step case whose expected-tool rounds are exactly `tools`, in order. */
  const multiCase = (
    tools: readonly string[],
  ): { readonly rounds: readonly { readonly expectedTool?: string }[] } => ({
    rounds: [...tools.map((t) => step(t)), step()],
  });
  const ORDER = /ordered transition workflow/;

  it("accepts the exact engine workflow", () => {
    expect(() => assertCorpusMatchesEngine([multiCase([...SCENARIO_STEP_TOOLS])])).not.toThrow();
  });

  it("REJECTS a reordered workflow with the correct transition count", () => {
    // The defect this guard closes: counting alone accepted `read → test →
    // edit` while the engine always evaluates `read → edit → test`.
    const [read, edit, test] = SCENARIO_STEP_TOOLS;
    expect(() => assertCorpusMatchesEngine([multiCase([read, test, edit])])).toThrow(ORDER);
    expect(() => assertCorpusMatchesEngine([multiCase([edit, read, test])])).toThrow(ORDER);
    expect(() => assertCorpusMatchesEngine([multiCase([test, edit, read])])).toThrow(ORDER);
  });

  it("REJECTS a substituted transition", () => {
    const [read, edit] = SCENARIO_STEP_TOOLS;
    expect(() => assertCorpusMatchesEngine([multiCase([read, edit, "verify"])])).toThrow(ORDER);
    expect(() => assertCorpusMatchesEngine([multiCase(["open", edit, "check"])])).toThrow(ORDER);
  });

  it("REJECTS duplicated transitions", () => {
    const [read, edit, test] = SCENARIO_STEP_TOOLS;
    expect(() => assertCorpusMatchesEngine([multiCase([read, read, test])])).toThrow(ORDER);
    expect(() => assertCorpusMatchesEngine([multiCase([read, edit, edit])])).toThrow(ORDER);
  });

  it("checks EVERY multi-step case, not just the first", () => {
    const [read, edit, test] = SCENARIO_STEP_TOOLS;
    expect(() =>
      assertCorpusMatchesEngine([
        multiCase([read, edit, test]),
        { rounds: [step("read")] },
        multiCase([read, test, edit]),
      ]),
    ).toThrow(ORDER);
  });

  it("keeps the ordered failure value-free", () => {
    let message = "";
    try {
      // A sentinel tool name that must never surface in the thrown text.
      assertCorpusMatchesEngine([multiCase(["read", "edit", "TRANSITION-SENTINEL"])]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(ORDER);
    for (const forbidden of [
      "TRANSITION-SENTINEL",
      "read",
      "edit",
      "test",
      "synthetic",
      "version=",
    ]) {
      expect(message).not.toContain(forbidden);
    }
  });
});
