/**
 * Hermetic tests for the PURE output/classification layer of the multi-step
 * transition diagnostic (`src/eval/diagnostic-report.ts`).
 *
 * The suite performs NO network call, reads NO credential, and touches NO
 * filesystem: it exercises only pure constants, closed ledger code maps, the
 * reason ⇄ dimension contract, and the deterministic relation classifier.
 * Every tool name, sequence, ordinal, and sentinel below is synthetic — there
 * is no account data, no live value, and no captured upstream content anywhere
 * in this file.
 *
 * Report v3 makes the classifier STATE-AWARE: a scenario's expectation is the
 * next UNSATISFIED transition, and the prior/future buckets are judged against
 * transitions that SUCCEEDED rather than against a round's static position or
 * against names that were merely invoked. The v2 member
 * `expected-already-invoked` is therefore unreachable by construction and is
 * gone from the union.
 *
 * The value-freeness group is the point of the module: tool names go IN to the
 * classifier and only closed enums come OUT, so a diagnostic record can never
 * carry a name, path, or prompt fragment.
 */
import { describe, expect, it } from "vitest";
import {
  allowedCallRelationForCode,
  classifyAllowedCallRelation,
  diagnosticCallMultiplicityFor,
  diagnosticCallMultiplicityForCode,
  diagnosticSelectionSourceFor,
  diagnosticSelectionSourceForCode,
  reasonHasSelectedCallSet,
  reasonRequiresAllowedCallRelation,
  transitionDiagnosticDimensionErrors,
  ALLOWED_CALL_RELATION_CODES,
  DIAGNOSTIC_CALL_MULTIPLICITY_CODES,
  DIAGNOSTIC_PROFILE,
  DIAGNOSTIC_REPORT_VERSION,
  DIAGNOSTIC_SELECTION_SOURCE_CODES,
  MAX_TRANSITION_DIAGNOSTICS,
  type AllowedCallRelation,
  type AllowedCallRelationInput,
  type DiagnosticCallMultiplicity,
  type DiagnosticSelectionSource,
  type TransitionDiagnostic,
} from "../../src/eval/diagnostic-report.js";
import {
  EVAL_FAILURE_REASON_CODES,
  EVAL_REPORT_VERSION,
  type EvalFailureReason,
} from "../../src/eval/report.js";
import { SCENARIO_STEP_COUNT } from "../../src/eval/scenario-engine.js";
import type { DiagnosticChoiceKind } from "../../src/eval/cases.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/** The ten closed release failure reasons, enumerated by hand on purpose. */
const ALL_REASONS: readonly EvalFailureReason[] = [
  "expected-tool-returned-text",
  "expected-tool-no-valid-call",
  "expected-tool-unavailable",
  "expected-tool-not-invoked",
  "unauthorized-tool-call",
  "transcript-invalid",
  "unexpected-tool-call-on-final",
  "final-no-valid-call",
  "final-unavailable",
  "scenario-round-budget-exhausted",
];

/** The four reasons whose selection produced a tool-call set. */
const REASONS_WITH_CALL_SET: readonly EvalFailureReason[] = [
  "expected-tool-not-invoked",
  "unauthorized-tool-call",
  "transcript-invalid",
  "unexpected-tool-call-on-final",
];

/** The two reasons that must carry a real (non-`not-applicable`) relation. */
const REASONS_REQUIRING_RELATION: readonly EvalFailureReason[] = [
  "expected-tool-not-invoked",
  "unexpected-tool-call-on-final",
];

const ALL_RELATIONS: readonly AllowedCallRelation[] = [
  "prior-only",
  "future-only",
  "prior-and-future",
  "other-allowed",
  "mixed-other",
  "not-applicable",
];

const ALL_SELECTION_SOURCES: readonly DiagnosticSelectionSource[] = [
  "desired-source",
  "individual-single",
  "individual-consensus",
  "not-applicable",
];

const ALL_MULTIPLICITIES: readonly DiagnosticCallMultiplicity[] = [
  "single",
  "multiple",
  "not-applicable",
];

const CHOICE_KINDS: readonly DiagnosticChoiceKind[] = ["auto", "required", "function"];

/**
 * A synthetic three-step workflow: the ordered transitions a scenario must
 * complete before its final-text round. It mirrors the production corpus layout
 * without borrowing any of its content.
 */
const WORKFLOW: readonly string[] = ["read", "edit", "test"];

/** Transitions satisfied at the `read` → `edit` round the campaign failed at. */
const TRANSITION_SATISFIED = 1;

/** Transitions satisfied at the final-text round (all of them). */
const FINAL_SATISFIED = 3;

/** A synthetic allowed tool that appears nowhere in {@link WORKFLOW}. */
const UNRELATED_TOOL = "grep";

/**
 * The scenario view for a run in which the first `satisfiedCount` transitions
 * SUCCEEDED. `pendingTools[0]` is the tool the round was expected to invoke; an
 * empty pending list means final text was expected.
 */
function split(satisfiedCount: number): {
  readonly satisfiedTools: readonly string[];
  readonly pendingTools: readonly string[];
} {
  return {
    satisfiedTools: WORKFLOW.slice(0, satisfiedCount),
    pendingTools: WORKFLOW.slice(satisfiedCount),
  };
}

function relationInput(over: Partial<AllowedCallRelationInput> = {}): AllowedCallRelationInput {
  return {
    reason: "expected-tool-not-invoked",
    selectedCallNames: ["read"],
    allAllowed: true,
    ...split(TRANSITION_SATISFIED),
    ...over,
  };
}

/** Classify the default synthetic transition round for one selected call set. */
function relationFor(selectedCallNames: readonly string[]): AllowedCallRelation {
  return classifyAllowedCallRelation(relationInput({ selectedCallNames }));
}

/** Classify the synthetic final-text round for one selected call set. */
function finalRelationFor(selectedCallNames: readonly string[]): AllowedCallRelation {
  return classifyAllowedCallRelation(
    relationInput({
      reason: "unexpected-tool-call-on-final",
      ...split(FINAL_SATISFIED),
      selectedCallNames,
    }),
  );
}

/** The four dimensions {@link transitionDiagnosticDimensionErrors} validates. */
interface DimensionShape {
  readonly reason: EvalFailureReason;
  readonly allowedCallRelation: AllowedCallRelation;
  readonly selectionSource: DiagnosticSelectionSource;
  readonly callMultiplicity: DiagnosticCallMultiplicity;
}

/** The shape every consistency rule accepts for a given reason. */
function consistentShape(reason: EvalFailureReason): DimensionShape {
  const hasCalls = reasonHasSelectedCallSet(reason);
  const needsRelation = reasonRequiresAllowedCallRelation(reason);
  return {
    reason,
    allowedCallRelation: needsRelation ? "prior-only" : "not-applicable",
    selectionSource: hasCalls ? "desired-source" : "not-applicable",
    callMultiplicity: hasCalls ? "single" : "not-applicable",
  };
}

// ---------------------------------------------------------------------------
// 1. Version and profile constants
// ---------------------------------------------------------------------------

describe("diagnostic report — version and profile", () => {
  it("pins the diagnostic output-model version to 3", () => {
    expect(DIAGNOSTIC_REPORT_VERSION).toBe(3);
  });

  it("pins the fixed diagnostic profile name", () => {
    expect(DIAGNOSTIC_PROFILE).toBe("multi-step-transition");
  });

  it("versions the diagnostic contract independently of the release report", () => {
    // The two outputs are SEPARATE contracts: neither version implies anything
    // about the other, and a diagnostic artifact must never be consumable as a
    // release-evaluator artifact. Widened to `number` so the comparison is
    // about the runtime values rather than the literal types. The release
    // version is deliberately NOT pinned here — bumping it must not fail the
    // diagnostic suite, which is the whole point of the independence.
    const diagnosticVersion: number = DIAGNOSTIC_REPORT_VERSION;
    const releaseVersion: number = EVAL_REPORT_VERSION;
    expect(diagnosticVersion).not.toBe(releaseVersion);
  });

  it("caps persisted diagnostics at one per scenario in the 20-scenario corpus", () => {
    expect(MAX_TRANSITION_DIAGNOSTICS).toBe(20);
  });

  it("matches the shared engine's fixed three-step workflow", () => {
    // The classifier's fail-closed total is the engine's step count, so the
    // fixture workflow must describe exactly one whole scenario.
    expect(WORKFLOW).toHaveLength(SCENARIO_STEP_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 2. The six relation categories
// ---------------------------------------------------------------------------

describe("diagnostic report — allowed-call relation categories", () => {
  const applicableCases: readonly {
    readonly label: string;
    readonly selectedCallNames: readonly string[];
    readonly expected: AllowedCallRelation;
  }[] = [
    {
      label: "a transition that already succeeded",
      selectedCallNames: ["read"],
      expected: "prior-only",
    },
    {
      label: "a later still-pending transition",
      selectedCallNames: ["test"],
      expected: "future-only",
    },
    {
      label: "both a satisfied and a later pending transition",
      selectedCallNames: ["read", "test"],
      expected: "prior-and-future",
    },
    {
      label: "only an allowed tool outside the workflow",
      selectedCallNames: [UNRELATED_TOOL],
      expected: "other-allowed",
    },
    {
      label: "an unrelated allowed tool beside a satisfied transition",
      selectedCallNames: ["read", UNRELATED_TOOL],
      expected: "mixed-other",
    },
    {
      label: "an unrelated allowed tool beside a later pending transition",
      selectedCallNames: ["test", UNRELATED_TOOL],
      expected: "mixed-other",
    },
  ];

  for (const testCase of applicableCases) {
    it(`classifies ${testCase.label} as ${testCase.expected}`, () => {
      expect(relationFor(testCase.selectedCallNames)).toBe(testCase.expected);
    });
  }

  it("produces all six closed relation members across the fixture set", () => {
    const produced = new Set<AllowedCallRelation>(
      applicableCases.map((testCase) => relationFor(testCase.selectedCallNames)),
    );
    produced.add(classifyAllowedCallRelation(relationInput({ selectedCallNames: null })));
    expect([...produced].sort()).toEqual([...ALL_RELATIONS].sort());
  });

  const notApplicableCases: readonly {
    readonly label: string;
    readonly over: Partial<AllowedCallRelationInput>;
  }[] = [
    { label: "the selection produced no call set", over: { selectedCallNames: null } },
    { label: "the selected call set is empty", over: { selectedCallNames: [] } },
    { label: "a selected name fell outside the allowlist", over: { allAllowed: false } },
    {
      label: "the currently expected transition was invoked after all",
      over: { selectedCallNames: ["edit"] },
    },
    {
      label: "the currently expected transition was invoked beside an unrelated tool",
      over: { selectedCallNames: ["edit", UNRELATED_TOOL] },
    },
    {
      label: "the currently expected transition was invoked beside a satisfied one",
      over: { selectedCallNames: ["read", "edit"] },
    },
  ];

  for (const testCase of notApplicableCases) {
    it(`returns not-applicable when ${testCase.label}`, () => {
      expect(classifyAllowedCallRelation(relationInput(testCase.over))).toBe("not-applicable");
    });
  }

  it("ignores the order of the selected names", () => {
    expect(relationFor(["read", "test"])).toBe("prior-and-future");
    expect(relationFor(["test", "read"])).toBe("prior-and-future");
    expect(relationFor([UNRELATED_TOOL, "read"])).toBe("mixed-other");
    expect(relationFor(["read", UNRELATED_TOOL])).toBe("mixed-other");
  });

  it("treats a repeated selected name as one occurrence of its bucket", () => {
    expect(relationFor(["read", "read", "read"])).toBe("prior-only");
    expect(relationFor([UNRELATED_TOOL, UNRELATED_TOOL])).toBe("other-allowed");
  });
});

// ---------------------------------------------------------------------------
// 2b. State-aware classification (parallel tool calls)
// ---------------------------------------------------------------------------

describe("diagnostic report — state-aware relation", () => {
  // The round request enables parallel tool calls, so one accepted round can
  // complete several transitions at once. v3 derives the expectation from the
  // transitions that SUCCEEDED, so a correct continuation is never reported as
  // a fabricated skip-ahead and a call that ran but failed is never reported as
  // finished work.

  it("drops the v2 member that a stale expectation used to require", () => {
    // Under v2 a round could statically expect a tool an earlier parallel batch
    // had already invoked, and `expected-already-invoked` existed to avoid
    // calling that correct continuation a skip-ahead. The member is gone.
    const relationNames: readonly string[] = ALL_RELATIONS;
    expect(relationNames).not.toContain("expected-already-invoked");
    expect(relationNames).toHaveLength(6);
  });

  it("cannot expect a transition that already succeeded", () => {
    // The situation the removed member described is unrepresentable: the
    // expectation is `pendingTools[0]`, and satisfied/pending are disjoint at
    // every point of the workflow.
    for (let satisfiedCount = 0; satisfiedCount <= WORKFLOW.length; satisfiedCount += 1) {
      const { satisfiedTools, pendingTools } = split(satisfiedCount);
      expect(pendingTools.filter((name) => satisfiedTools.includes(name))).toEqual([]);
    }
    // A hand-built view that claims otherwise fails closed rather than
    // producing a confident wrong answer.
    expect(() =>
      classifyAllowedCallRelation(
        relationInput({ satisfiedTools: ["read", "edit"], pendingTools: ["edit"] }),
      ),
    ).toThrow();
  });

  it("moves the expectation on after a parallel batch completes two transitions", () => {
    // The OBSERVED live shape: round 1 returns [read, edit] and BOTH
    // transitions succeed, so the next round expects `test`. Calling `test` is
    // correct behavior, and `not-applicable` is the classifier saying "the
    // current expectation was present — this is no transition confusion".
    const afterParallelBatch = {
      satisfiedTools: ["read", "edit"],
      pendingTools: ["test"],
    };
    expect(
      classifyAllowedCallRelation(
        relationInput({ ...afterParallelBatch, selectedCallNames: ["test"] }),
      ),
    ).toBe("not-applicable");
    // Repeating already-finished work from that same state is the real
    // prior-only case.
    expect(
      classifyAllowedCallRelation(
        relationInput({ ...afterParallelBatch, selectedCallNames: ["edit"] }),
      ),
    ).toBe("prior-only");
    expect(
      classifyAllowedCallRelation(
        relationInput({ ...afterParallelBatch, selectedCallNames: ["read", "edit"] }),
      ),
    ).toBe("prior-only");
  });

  it("judges prior by SUCCESSFUL transitions, never by names that merely ran", () => {
    // Round 1 returned [read, test]: `read` advanced the workflow, but `test`
    // ran before its prerequisite and did NOT complete. Selecting `test` again
    // is therefore still a genuine skip-ahead, not a repeat of finished work.
    expect(
      classifyAllowedCallRelation(relationInput({ ...split(1), selectedCallNames: ["test"] })),
    ).toBe("future-only");
  });

  it("keeps a failed transition pending rather than promoting it to prior", () => {
    // `edit` was invoked with the wrong text, so its transition did not
    // complete: it remains the CURRENT expectation, which outranks every
    // per-name bucket.
    expect(relationFor(["edit"])).toBe("not-applicable");
    expect(relationFor(["edit", "test"])).toBe("not-applicable");
    expect(relationFor(["read", "edit", UNRELATED_TOOL])).toBe("not-applicable");
  });

  it("still reports a genuine skip-ahead as future-only", () => {
    // Only `read` succeeded, `edit` is expected, and `test` has not run.
    expect(relationFor(["test"])).toBe("future-only");
  });

  it("still reports a repeat of the completed step as prior-only", () => {
    expect(relationFor(["read"])).toBe("prior-only");
  });

  it("classifies an unrelated allowed tool as other regardless of the state", () => {
    for (let satisfiedCount = 0; satisfiedCount <= WORKFLOW.length; satisfiedCount += 1) {
      expect(
        classifyAllowedCallRelation(
          relationInput({
            ...split(satisfiedCount),
            reason:
              satisfiedCount === WORKFLOW.length
                ? "unexpected-tool-call-on-final"
                : "expected-tool-not-invoked",
            selectedCallNames: [UNRELATED_TOOL],
          }),
        ),
      ).toBe("other-allowed");
    }
  });

  it("treats a fully unsatisfied workflow as everything-still-ahead", () => {
    const fresh = split(0);
    // `read` is the current expectation, so its presence is not a confusion;
    // everything after it is a skip-ahead.
    expect(
      classifyAllowedCallRelation(relationInput({ ...fresh, selectedCallNames: ["read"] })),
    ).toBe("not-applicable");
    expect(
      classifyAllowedCallRelation(relationInput({ ...fresh, selectedCallNames: ["edit"] })),
    ).toBe("future-only");
    expect(
      classifyAllowedCallRelation(relationInput({ ...fresh, selectedCallNames: ["edit", "test"] })),
    ).toBe("future-only");
  });

  it("treats a fully satisfied workflow as everything-prior", () => {
    for (const name of WORKFLOW) {
      expect(finalRelationFor([name])).toBe("prior-only");
    }
    expect(finalRelationFor([...WORKFLOW])).toBe("prior-only");
  });

  it("does not mutate or retain the supplied scenario view", () => {
    const satisfiedTools = ["read"];
    const pendingTools = ["edit", "test"];
    classifyAllowedCallRelation(
      relationInput({ satisfiedTools, pendingTools, selectedCallNames: ["test", UNRELATED_TOOL] }),
    );
    expect(satisfiedTools).toEqual(["read"]);
    expect(pendingTools).toEqual(["edit", "test"]);
  });

  it("emits only a closed enum even when the scenario view holds sentinel names", () => {
    const sentinel = "SYNTHETIC-WORKFLOW-TOOL-5d31";
    const relation = classifyAllowedCallRelation(
      relationInput({
        satisfiedTools: [sentinel],
        pendingTools: ["edit", "test"],
        selectedCallNames: [sentinel],
      }),
    );
    expect(relation).toBe("prior-only");
    expect(JSON.stringify(relation)).not.toContain(sentinel);
    expect(JSON.stringify(relation)).not.toContain("SYNTHETIC");
  });
});

// ---------------------------------------------------------------------------
// 3. Determinism and documented precedence
// ---------------------------------------------------------------------------

describe("diagnostic report — classifier determinism and precedence", () => {
  const repeatedInput = relationInput({ selectedCallNames: ["read", UNRELATED_TOOL] });

  it("resolves the same scenario view identically on every call", () => {
    const results = [
      classifyAllowedCallRelation(repeatedInput),
      classifyAllowedCallRelation(repeatedInput),
      classifyAllowedCallRelation(repeatedInput),
      classifyAllowedCallRelation(repeatedInput),
      classifyAllowedCallRelation(repeatedInput),
    ];
    expect(new Set(results).size).toBe(1);
    expect(results).toEqual([
      "mixed-other",
      "mixed-other",
      "mixed-other",
      "mixed-other",
      "mixed-other",
    ]);
  });

  it("returns the same relation for freshly built, structurally equal inputs", () => {
    const first = classifyAllowedCallRelation(relationInput({ selectedCallNames: ["read"] }));
    const second = classifyAllowedCallRelation(relationInput({ selectedCallNames: ["read"] }));
    expect(first).toBe(second);
    expect(first).toBe("prior-only");
  });

  it("does not mutate its inputs", () => {
    const selectedCallNames: readonly string[] = ["read", UNRELATED_TOOL];
    classifyAllowedCallRelation(relationInput({ selectedCallNames }));
    expect(selectedCallNames).toEqual(["read", UNRELATED_TOOL]);
  });

  it("ranks the current expected transition above every other bucket", () => {
    // `edit` is pending and current; whatever else the round selected, the
    // failure is not a transition confusion.
    for (const selectedCallNames of [
      ["edit"],
      ["read", "edit"],
      ["edit", "test"],
      ["edit", UNRELATED_TOOL],
      ["read", "edit", "test", UNRELATED_TOOL],
    ]) {
      expect(relationFor(selectedCallNames)).toBe("not-applicable");
    }
  });

  it("ranks the current expected transition above a later duplicate of the same name", () => {
    // A pending list may legitimately repeat a name; the CURRENT slot wins, so
    // the round is never reported as a skip-ahead onto itself.
    expect(
      classifyAllowedCallRelation(
        relationInput({
          satisfiedTools: ["read"],
          pendingTools: ["edit", "edit"],
          selectedCallNames: ["edit"],
        }),
      ),
    ).toBe("not-applicable");
  });

  it("keeps the prior and future buckets structurally disjoint", () => {
    // Satisfied and pending may never overlap, so a single name can only ever
    // land in ONE of the two buckets — the v2 ambiguity is gone.
    expect(relationFor(["read"])).toBe("prior-only");
    expect(relationFor(["test"])).toBe("future-only");
    expect(relationFor(["read", "test"])).toBe("prior-and-future");
  });

  it("ranks a future expected tool above the unrelated-allowed bucket", () => {
    expect(relationFor(["test"])).toBe("future-only");
    expect(relationFor(["test", UNRELATED_TOOL])).toBe("mixed-other");
  });
});

// ---------------------------------------------------------------------------
// 3b. The scenario-view guard (fails closed rather than guessing)
// ---------------------------------------------------------------------------

describe("diagnostic report — scenario-view guard", () => {
  // `satisfiedTools` and `pendingTools` arrive as separate arguments, so a
  // mispairing at the call site must be LOUD. Without the guard a short view
  // silently shrinks the prior/future buckets, a duplicated view double-counts
  // a transition, and an overlapping view lets one name occupy two buckets —
  // each a plausible-looking but wrong answer in the one command whose entire
  // purpose is diagnostic accuracy.

  const mispairedViews: readonly {
    readonly label: string;
    readonly over: Partial<AllowedCallRelationInput>;
  }[] = [
    { label: "an empty view", over: { satisfiedTools: [], pendingTools: [] } },
    {
      label: "a short view",
      over: { satisfiedTools: ["read"], pendingTools: ["edit"] },
    },
    {
      label: "a long view",
      over: { satisfiedTools: ["read"], pendingTools: ["edit", "test", UNRELATED_TOOL] },
    },
    {
      label: "a satisfied-only long view",
      over: { satisfiedTools: ["read", "edit", "test", UNRELATED_TOOL], pendingTools: [] },
    },
    {
      label: "a duplicated satisfied transition",
      over: { satisfiedTools: ["read", "read", "edit"], pendingTools: [] },
    },
    {
      label: "a duplicated satisfied transition inside a whole-workflow view",
      over: { satisfiedTools: ["read", "read"], pendingTools: ["edit"] },
    },
    {
      label: "an overlapping view",
      over: { satisfiedTools: ["read"], pendingTools: ["read", "edit"] },
    },
    {
      label: "an overlapping view at the pending tail",
      over: { satisfiedTools: ["read", "edit"], pendingTools: ["read"] },
    },
  ];

  for (const testCase of mispairedViews) {
    it(`throws for ${testCase.label}`, () => {
      expect(() => classifyAllowedCallRelation(relationInput(testCase.over))).toThrow();
    });
  }

  it("throws BEFORE any reason or call-set short-circuit could hide the mispairing", () => {
    // A reason that would otherwise return `not-applicable` immediately, a null
    // call set, and a disallowed call set must all still surface the bad view.
    const short = { satisfiedTools: ["read"], pendingTools: ["edit"] };
    expect(() =>
      classifyAllowedCallRelation(relationInput({ reason: "expected-tool-unavailable", ...short })),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation(relationInput({ selectedCallNames: null, ...short })),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation(relationInput({ allAllowed: false, ...short })),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation(
        relationInput({
          reason: "scenario-round-budget-exhausted",
          satisfiedTools: ["read"],
          pendingTools: ["read", "edit"],
        }),
      ),
    ).toThrow();
  });

  it("accepts every satisfied-state split of the fixture workflow", () => {
    for (let satisfiedCount = 0; satisfiedCount <= WORKFLOW.length; satisfiedCount += 1) {
      expect(() => classifyAllowedCallRelation(relationInput(split(satisfiedCount)))).not.toThrow();
    }
  });

  it("throws value-free: the message carries no tool name, path, or prompt", () => {
    const sentinel = "SYNTHETIC-GUARD-TOOL-3f8c";
    let message = "";
    try {
      classifyAllowedCallRelation(
        relationInput({
          satisfiedTools: [sentinel],
          pendingTools: [sentinel, "edit"],
          selectedCallNames: [sentinel],
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain("SYNTHETIC");
    expect(message).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// 4. The final-text round
// ---------------------------------------------------------------------------

describe("diagnostic report — final-round relation", () => {
  it("confirms the fixture's final round expects text rather than a tool", () => {
    expect(split(FINAL_SATISFIED).pendingTools).toEqual([]);
    expect(split(FINAL_SATISFIED).satisfiedTools).toEqual([...WORKFLOW]);
  });

  const finalCases: readonly {
    readonly label: string;
    readonly selectedCallNames: readonly string[];
    readonly expected: AllowedCallRelation;
  }[] = [
    { label: "the first transition", selectedCallNames: ["read"], expected: "prior-only" },
    { label: "the middle transition", selectedCallNames: ["edit"], expected: "prior-only" },
    {
      label: "every transition",
      selectedCallNames: ["read", "edit", "test"],
      expected: "prior-only",
    },
    {
      label: "only an unrelated allowed tool",
      selectedCallNames: [UNRELATED_TOOL],
      expected: "other-allowed",
    },
    {
      label: "an unrelated allowed tool beside a transition",
      selectedCallNames: ["read", UNRELATED_TOOL],
      expected: "mixed-other",
    },
  ];

  for (const testCase of finalCases) {
    it(`classifies a final round that called ${testCase.label} as ${testCase.expected}`, () => {
      const relation = finalRelationFor(testCase.selectedCallNames);
      expect(relation).toBe(testCase.expected);
      expect(relation).not.toBe("not-applicable");
    });
  }

  it("never reports a future expected tool on the final round", () => {
    for (const testCase of finalCases) {
      const relation = finalRelationFor(testCase.selectedCallNames);
      expect(relation).not.toBe("future-only");
      expect(relation).not.toBe("prior-and-future");
    }
  });

  it("still returns not-applicable on the final round without an allowed call set", () => {
    expect(
      classifyAllowedCallRelation(
        relationInput({
          reason: "unexpected-tool-call-on-final",
          ...split(FINAL_SATISFIED),
          selectedCallNames: null,
        }),
      ),
    ).toBe("not-applicable");
    expect(
      classifyAllowedCallRelation(
        relationInput({
          reason: "unexpected-tool-call-on-final",
          ...split(FINAL_SATISFIED),
          allAllowed: false,
        }),
      ),
    ).toBe("not-applicable");
  });
});

// ---------------------------------------------------------------------------
// 5. The reason ⇄ dimension contract
// ---------------------------------------------------------------------------

describe("diagnostic report — reason ⇄ dimension contract", () => {
  it("enumerates the whole closed failure-reason union", () => {
    // A future union member added to the release report fails HERE first, so
    // the diagnostic's predicates can never silently miss a reason.
    expect([...ALL_REASONS].sort()).toEqual(Object.keys(EVAL_FAILURE_REASON_CODES).sort());
    expect(ALL_REASONS).toHaveLength(10);
    expect(new Set(ALL_REASONS).size).toBe(10);
  });

  for (const reason of ALL_REASONS) {
    const hasCalls = REASONS_WITH_CALL_SET.includes(reason);
    it(`reports a selected call set = ${String(hasCalls)} for ${reason}`, () => {
      expect(reasonHasSelectedCallSet(reason)).toBe(hasCalls);
    });
  }

  for (const reason of ALL_REASONS) {
    const needsRelation = REASONS_REQUIRING_RELATION.includes(reason);
    it(`requires an applicable relation = ${String(needsRelation)} for ${reason}`, () => {
      expect(reasonRequiresAllowedCallRelation(reason)).toBe(needsRelation);
    });
  }

  it("requires a relation for exactly the two always-derivable reasons", () => {
    expect(ALL_REASONS.filter((reason) => reasonRequiresAllowedCallRelation(reason))).toEqual([
      "expected-tool-not-invoked",
      "unexpected-tool-call-on-final",
    ]);
  });

  it("recognizes a selected call set for exactly four reasons", () => {
    expect(ALL_REASONS.filter((reason) => reasonHasSelectedCallSet(reason))).toEqual([
      "expected-tool-not-invoked",
      "unauthorized-tool-call",
      "transcript-invalid",
      "unexpected-tool-call-on-final",
    ]);
  });

  const relationFreeReasons = ALL_REASONS.filter(
    (reason) => !REASONS_REQUIRING_RELATION.includes(reason),
  );

  for (const reason of relationFreeReasons) {
    it(`forces not-applicable for ${reason} even with a classifiable call set`, () => {
      // A failure class the relation cannot usefully describe stays
      // `not-applicable` even when a perfectly bucketable call set is supplied.
      expect(classifyAllowedCallRelation(relationInput({ reason }))).toBe("not-applicable");
      expect(
        classifyAllowedCallRelation(relationInput({ reason, selectedCallNames: ["read", "test"] })),
      ).toBe("not-applicable");
      expect(
        classifyAllowedCallRelation(relationInput({ reason, selectedCallNames: [UNRELATED_TOOL] })),
      ).toBe("not-applicable");
    });
  }

  it("covers all eight relation-free reasons in the loop above", () => {
    expect(relationFreeReasons).toHaveLength(8);
  });

  it("forces not-applicable for transcript-invalid, whose expected tool WAS present", () => {
    const reason: EvalFailureReason = "transcript-invalid";
    expect(reasonHasSelectedCallSet(reason)).toBe(true);
    expect(classifyAllowedCallRelation(relationInput({ reason }))).toBe("not-applicable");
  });

  it("forces not-applicable for unauthorized-tool-call", () => {
    const reason: EvalFailureReason = "unauthorized-tool-call";
    expect(reasonHasSelectedCallSet(reason)).toBe(true);
    expect(classifyAllowedCallRelation(relationInput({ reason }))).toBe("not-applicable");
    // Even the (contradictory) all-allowed shape stays not-applicable: the
    // reason, not the call set, decides.
    expect(classifyAllowedCallRelation(relationInput({ reason, allAllowed: true }))).toBe(
      "not-applicable",
    );
  });

  it("gives the whole-scenario budget reason all-not-applicable dimensions", () => {
    // `scenario-round-budget-exhausted` belongs to the SCENARIO, not to one
    // round's call set: no single round's selection describes it, so all three
    // dimensions must be `not-applicable` and the reason ⇄ dimension contract
    // must accept exactly that shape.
    const reason: EvalFailureReason = "scenario-round-budget-exhausted";
    expect(reasonHasSelectedCallSet(reason)).toBe(false);
    expect(reasonRequiresAllowedCallRelation(reason)).toBe(false);
    expect(classifyAllowedCallRelation(relationInput({ reason }))).toBe("not-applicable");
    expect(
      classifyAllowedCallRelation(
        relationInput({ reason, selectedCallNames: ["read", "test", UNRELATED_TOOL] }),
      ),
    ).toBe("not-applicable");
    expect(
      transitionDiagnosticDimensionErrors({
        reason,
        allowedCallRelation: "not-applicable",
        selectionSource: "not-applicable",
        callMultiplicity: "not-applicable",
      }),
    ).toEqual([]);
    for (const relation of ALL_RELATIONS.filter((r) => r !== "not-applicable")) {
      expect(
        transitionDiagnosticDimensionErrors({
          reason,
          allowedCallRelation: relation,
          selectionSource: "not-applicable",
          callMultiplicity: "not-applicable",
        }),
      ).toEqual(["relation-must-be-not-applicable"]);
    }
    expect(
      transitionDiagnosticDimensionErrors({
        reason,
        allowedCallRelation: "not-applicable",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      }),
    ).toEqual(["selection-source-must-be-not-applicable", "multiplicity-must-be-not-applicable"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Dimension consistency validation
// ---------------------------------------------------------------------------

describe("diagnostic report — dimension consistency validation", () => {
  it("accepts the consistent shape for expected-tool-not-invoked", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "expected-tool-not-invoked",
        allowedCallRelation: "prior-only",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      }),
    ).toEqual([]);
  });

  it("accepts the consistent shape for transcript-invalid", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "transcript-invalid",
        allowedCallRelation: "not-applicable",
        selectionSource: "individual-consensus",
        callMultiplicity: "single",
      }),
    ).toEqual([]);
  });

  it("accepts the consistent shape for unauthorized-tool-call", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "unauthorized-tool-call",
        allowedCallRelation: "not-applicable",
        selectionSource: "individual-single",
        callMultiplicity: "multiple",
      }),
    ).toEqual([]);
  });

  it("accepts the consistent shape for expected-tool-returned-text", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "expected-tool-returned-text",
        allowedCallRelation: "not-applicable",
        selectionSource: "not-applicable",
        callMultiplicity: "not-applicable",
      }),
    ).toEqual([]);
  });

  it("accepts the consistent shape for every closed reason", () => {
    for (const reason of ALL_REASONS) {
      expect(transitionDiagnosticDimensionErrors(consistentShape(reason))).toEqual([]);
    }
  });

  it("rejects expected-tool-not-invoked carrying a not-applicable relation", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "expected-tool-not-invoked",
        allowedCallRelation: "not-applicable",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      }),
    ).toEqual(["relation-must-be-applicable"]);
  });

  it("rejects unexpected-tool-call-on-final carrying a not-applicable relation", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "unexpected-tool-call-on-final",
        allowedCallRelation: "not-applicable",
        selectionSource: "desired-source",
        callMultiplicity: "multiple",
      }),
    ).toEqual(["relation-must-be-applicable"]);
  });

  it("rejects transcript-invalid carrying any real relation", () => {
    for (const relation of ALL_RELATIONS.filter((r) => r !== "not-applicable")) {
      expect(
        transitionDiagnosticDimensionErrors({
          reason: "transcript-invalid",
          allowedCallRelation: relation,
          selectionSource: "desired-source",
          callMultiplicity: "single",
        }),
      ).toEqual(["relation-must-be-not-applicable"]);
    }
  });

  it("rejects a call-set reason whose source and multiplicity are not-applicable", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "unauthorized-tool-call",
        allowedCallRelation: "not-applicable",
        selectionSource: "not-applicable",
        callMultiplicity: "not-applicable",
      }),
    ).toEqual(["selection-source-must-be-applicable", "multiplicity-must-be-applicable"]);
  });

  const noCallSetReasons: readonly EvalFailureReason[] = [
    "expected-tool-returned-text",
    "expected-tool-unavailable",
    "final-no-valid-call",
    "scenario-round-budget-exhausted",
  ];

  for (const reason of noCallSetReasons) {
    it(`rejects ${reason} carrying an applicable selection source`, () => {
      expect(
        transitionDiagnosticDimensionErrors({
          reason,
          allowedCallRelation: "not-applicable",
          selectionSource: "desired-source",
          callMultiplicity: "not-applicable",
        }),
      ).toEqual(["selection-source-must-be-not-applicable"]);
    });

    it(`rejects ${reason} carrying an applicable multiplicity`, () => {
      expect(
        transitionDiagnosticDimensionErrors({
          reason,
          allowedCallRelation: "not-applicable",
          selectionSource: "not-applicable",
          callMultiplicity: "multiple",
        }),
      ).toEqual(["multiplicity-must-be-not-applicable"]);
    });
  }

  it("reports every violated rule for a fully inconsistent shape", () => {
    expect(
      transitionDiagnosticDimensionErrors({
        reason: "final-no-valid-call",
        allowedCallRelation: "prior-only",
        selectionSource: "desired-source",
        callMultiplicity: "multiple",
      }),
    ).toEqual([
      "relation-must-be-not-applicable",
      "selection-source-must-be-not-applicable",
      "multiplicity-must-be-not-applicable",
    ]);
  });

  it("enforces the relation rule across every reason × relation pair", () => {
    for (const reason of ALL_REASONS) {
      const needsRelation = reasonRequiresAllowedCallRelation(reason);
      for (const relation of ALL_RELATIONS) {
        const isNotApplicable = relation === "not-applicable";
        const expected: string[] = [];
        if (needsRelation && isNotApplicable) expected.push("relation-must-be-applicable");
        if (!needsRelation && !isNotApplicable) expected.push("relation-must-be-not-applicable");
        const errors = transitionDiagnosticDimensionErrors({
          ...consistentShape(reason),
          allowedCallRelation: relation,
        });
        expect(errors).toEqual(expected);
      }
    }
  });

  it("enforces the source and multiplicity rules across every reason triple", () => {
    for (const reason of ALL_REASONS) {
      const hasCalls = reasonHasSelectedCallSet(reason);
      for (const selectionSource of ALL_SELECTION_SOURCES) {
        for (const callMultiplicity of ALL_MULTIPLICITIES) {
          const sourceApplicable = selectionSource !== "not-applicable";
          const countApplicable = callMultiplicity !== "not-applicable";
          const expected: string[] = [];
          if (hasCalls && !sourceApplicable) expected.push("selection-source-must-be-applicable");
          if (!hasCalls && sourceApplicable) {
            expected.push("selection-source-must-be-not-applicable");
          }
          if (hasCalls && !countApplicable) expected.push("multiplicity-must-be-applicable");
          if (!hasCalls && countApplicable) expected.push("multiplicity-must-be-not-applicable");
          const errors = transitionDiagnosticDimensionErrors({
            ...consistentShape(reason),
            selectionSource,
            callMultiplicity,
          });
          expect(errors).toEqual(expected);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Closed ledger code maps
// ---------------------------------------------------------------------------

/** Inputs no decoder may ever accept. */
const INVALID_CODES: readonly unknown[] = [
  42,
  0,
  -1,
  1.5,
  // 7 was the v2 `expected-already-invoked` relation code; v3 removed it and no
  // map assigns it, so every decoder must now reject it.
  7,
  99,
  "1",
  "not-applicable",
  null,
  undefined,
  {},
  [],
  true,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

interface CodeMapUnderTest<M extends string> {
  readonly label: string;
  readonly members: readonly M[];
  readonly codes: Readonly<Record<M, number>>;
  readonly decode: (code: unknown) => M | undefined;
}

function describeCodeMap<M extends string>(map: CodeMapUnderTest<M>): void {
  describe(`diagnostic report — ${map.label} ledger codes`, () => {
    it("maps exactly the closed union members", () => {
      expect(Object.keys(map.codes).sort()).toEqual([...map.members].sort());
    });

    it("round-trips every member through encode then decode", () => {
      for (const member of map.members) {
        expect(map.decode(map.codes[member])).toBe(member);
      }
    });

    it("assigns a unique positive integer code to every member", () => {
      const codes = map.members.map((member) => map.codes[member]);
      expect(new Set(codes).size).toBe(map.members.length);
      for (const code of codes) {
        expect(Number.isInteger(code)).toBe(true);
        expect(code).toBeGreaterThan(0);
      }
    });

    it("returns undefined for unknown, non-numeric, and non-finite codes", () => {
      for (const invalid of INVALID_CODES) {
        expect(map.decode(invalid)).toBeUndefined();
      }
    });

    it("freezes the exported code map", () => {
      expect(Object.isFrozen(map.codes)).toBe(true);
    });

    it("keeps the decoder allowlist out of reach of the exported map", () => {
      // The decoder is a closed `switch`, so even a successful write to the
      // exported record could not widen it. Prove both halves: the frozen
      // record refuses the write (throwing under strict mode, silently ignored
      // otherwise) and the decoder still rejects the injected code.
      const mutable = map.codes as unknown as Record<string, number>;
      const before = { ...map.codes };
      try {
        mutable["synthetic-unknown-member"] = 42;
      } catch {
        expect(Object.isFrozen(map.codes)).toBe(true);
      }
      for (const member of map.members) {
        try {
          mutable[member] = 42;
        } catch {
          expect(Object.isFrozen(map.codes)).toBe(true);
        }
      }
      expect({ ...map.codes }).toEqual(before);
      expect(map.decode(42)).toBeUndefined();
      for (const member of map.members) {
        expect(map.decode(map.codes[member])).toBe(member);
      }
    });
  });
}

describeCodeMap<AllowedCallRelation>({
  label: "allowed-call relation",
  members: ALL_RELATIONS,
  codes: ALLOWED_CALL_RELATION_CODES,
  decode: allowedCallRelationForCode,
});

describeCodeMap<DiagnosticSelectionSource>({
  label: "selection source",
  members: ALL_SELECTION_SOURCES,
  codes: DIAGNOSTIC_SELECTION_SOURCE_CODES,
  decode: diagnosticSelectionSourceForCode,
});

describeCodeMap<DiagnosticCallMultiplicity>({
  label: "call multiplicity",
  members: ALL_MULTIPLICITIES,
  codes: DIAGNOSTIC_CALL_MULTIPLICITY_CODES,
  decode: diagnosticCallMultiplicityForCode,
});

describe("diagnostic report — ledger code stability", () => {
  it("pins the six relation codes so a persisted ledger never renumbers", () => {
    // Codes 1–6 are unchanged from formats v1 and v2. The v2 code 7
    // (`expected-already-invoked`) was REMOVED rather than reused, so a stale
    // ledger entry can never decode to a different member.
    expect({ ...ALLOWED_CALL_RELATION_CODES }).toEqual({
      "prior-only": 1,
      "future-only": 2,
      "prior-and-future": 3,
      "other-allowed": 4,
      "mixed-other": 5,
      "not-applicable": 6,
    });
    expect(Object.keys(ALLOWED_CALL_RELATION_CODES)).toHaveLength(6);
    expect(new Set(Object.values(ALLOWED_CALL_RELATION_CODES)).size).toBe(6);
  });

  it("no longer decodes the removed v2 relation code 7", () => {
    expect(allowedCallRelationForCode(7)).toBeUndefined();
    expect(Object.values(ALLOWED_CALL_RELATION_CODES)).not.toContain(7);
  });

  it("pins the selection-source codes", () => {
    expect({ ...DIAGNOSTIC_SELECTION_SOURCE_CODES }).toEqual({
      "desired-source": 1,
      "individual-single": 2,
      "individual-consensus": 3,
      "not-applicable": 4,
    });
  });

  it("pins the multiplicity codes", () => {
    expect({ ...DIAGNOSTIC_CALL_MULTIPLICITY_CODES }).toEqual({
      single: 1,
      multiple: 2,
      "not-applicable": 3,
    });
  });

  it("keeps each decoder scoped to its own map", () => {
    // Code 6 exists only in the relation map; 5 and 4 are out of range for the
    // narrower maps.
    expect(allowedCallRelationForCode(6)).toBe("not-applicable");
    expect(diagnosticSelectionSourceForCode(5)).toBeUndefined();
    expect(diagnosticCallMultiplicityForCode(4)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Selection-source and multiplicity mapping
// ---------------------------------------------------------------------------

describe("diagnostic report — selection-source mapping", () => {
  const sourceCases: readonly {
    readonly input: "desired-source" | "individual-single" | "individual-consensus" | null;
    readonly expected: DiagnosticSelectionSource;
  }[] = [
    { input: "desired-source", expected: "desired-source" },
    { input: "individual-single", expected: "individual-single" },
    { input: "individual-consensus", expected: "individual-consensus" },
    { input: null, expected: "not-applicable" },
  ];

  for (const testCase of sourceCases) {
    it(`maps ${String(testCase.input)} to ${testCase.expected}`, () => {
      const mapped = diagnosticSelectionSourceFor(testCase.input);
      expect(mapped).toBe(testCase.expected);
      expect(ALL_SELECTION_SOURCES).toContain(mapped);
    });
  }

  it("covers every selection-source member", () => {
    const produced = new Set(sourceCases.map((testCase) => testCase.expected));
    expect(produced.size).toBe(ALL_SELECTION_SOURCES.length);
  });
});

describe("diagnostic report — call-multiplicity bucketing", () => {
  const multiplicityCases: readonly {
    readonly input: number | null;
    readonly expected: DiagnosticCallMultiplicity;
  }[] = [
    { input: 1, expected: "single" },
    { input: 2, expected: "multiple" },
    { input: 3, expected: "multiple" },
    { input: 8, expected: "multiple" },
    { input: 128, expected: "multiple" },
    { input: null, expected: "not-applicable" },
    { input: 0, expected: "not-applicable" },
    { input: -1, expected: "not-applicable" },
    { input: -42, expected: "not-applicable" },
    // Not a positive integer: fail closed rather than bucketing nonsense as
    // `multiple`, matching the ledger decoders' posture.
    { input: 0.5, expected: "not-applicable" },
    { input: 1.5, expected: "not-applicable" },
    { input: Number.NaN, expected: "not-applicable" },
    { input: Number.POSITIVE_INFINITY, expected: "not-applicable" },
    { input: Number.NEGATIVE_INFINITY, expected: "not-applicable" },
  ];

  for (const testCase of multiplicityCases) {
    it(`buckets a call count of ${String(testCase.input)} as ${testCase.expected}`, () => {
      const bucketed = diagnosticCallMultiplicityFor(testCase.input);
      expect(bucketed).toBe(testCase.expected);
      expect(ALL_MULTIPLICITIES).toContain(bucketed);
    });
  }

  it("never leaks the exact count into the bucket", () => {
    for (const testCase of multiplicityCases) {
      const bucketed: string = diagnosticCallMultiplicityFor(testCase.input);
      expect(bucketed).not.toContain(String(testCase.input));
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Value-freeness: names go in, closed enums come out
// ---------------------------------------------------------------------------

describe("diagnostic report — value-freeness", () => {
  const TOOL_SENTINEL = "SYNTHETIC-TOOL-NAME-b41f";
  const PATH_SENTINEL = "/synthetic/path/SYNTHETIC-PATH-9c2e.txt";
  const PROMPT_SENTINEL = "SYNTHETIC-PROMPT-TEXT-7a10 open the file and report back";
  const SENTINELS: readonly string[] = [TOOL_SENTINEL, PATH_SENTINEL, PROMPT_SENTINEL];

  const sentinelCases: readonly {
    readonly label: string;
    readonly input: AllowedCallRelationInput;
    readonly expected: AllowedCallRelation;
  }[] = [
    {
      label: "an unrelated allowed tool",
      input: relationInput({ selectedCallNames: [TOOL_SENTINEL] }),
      expected: "other-allowed",
    },
    {
      label: "a satisfied transition",
      input: relationInput({
        satisfiedTools: [TOOL_SENTINEL],
        pendingTools: ["edit", "test"],
        selectedCallNames: [TOOL_SENTINEL],
      }),
      expected: "prior-only",
    },
    {
      label: "a later pending transition",
      input: relationInput({
        satisfiedTools: ["read"],
        pendingTools: ["edit", TOOL_SENTINEL],
        selectedCallNames: [TOOL_SENTINEL],
      }),
      expected: "future-only",
    },
    {
      label: "the currently expected transition",
      input: relationInput({
        satisfiedTools: ["read"],
        pendingTools: [TOOL_SENTINEL, "test"],
        selectedCallNames: [TOOL_SENTINEL],
      }),
      expected: "not-applicable",
    },
    {
      label: "a path- and a prompt-like name beside a satisfied transition",
      input: relationInput({ selectedCallNames: [PATH_SENTINEL, PROMPT_SENTINEL, "read"] }),
      expected: "mixed-other",
    },
  ];

  for (const testCase of sentinelCases) {
    it(`returns only a closed relation member when the sentinel is ${testCase.label}`, () => {
      const relation = classifyAllowedCallRelation(testCase.input);
      expect(relation).toBe(testCase.expected);
      expect(ALL_RELATIONS).toContain(relation);
      const encoded = JSON.stringify(relation);
      for (const sentinel of SENTINELS) {
        expect(encoded).not.toContain(sentinel);
      }
      expect(encoded).not.toContain("SYNTHETIC");
      expect(encoded).not.toContain("/");
    });
  }

  it("emits no name, path, or prompt fragment in a constructed diagnostic", () => {
    for (const choiceKind of CHOICE_KINDS) {
      for (const testCase of sentinelCases) {
        const diagnostic: TransitionDiagnostic = {
          caseOrdinal: 203,
          roundOrdinal: 2,
          choiceKind,
          reason: "expected-tool-not-invoked",
          allowedCallRelation: classifyAllowedCallRelation(testCase.input),
          selectionSource: diagnosticSelectionSourceFor("individual-consensus"),
          callMultiplicity: diagnosticCallMultiplicityFor(
            testCase.input.selectedCallNames?.length ?? null,
          ),
        };
        const encoded = JSON.stringify(diagnostic);
        for (const sentinel of SENTINELS) {
          expect(encoded).not.toContain(sentinel);
        }
        expect(encoded).not.toContain("SYNTHETIC");
        expect(encoded).not.toContain("/");
        expect(encoded).not.toContain("read");
        expect(encoded).not.toContain(UNRELATED_TOOL);
      }
    }
  });

  it("constrains every diagnostic field to a closed set or a bounded ordinal", () => {
    const diagnostic: TransitionDiagnostic = {
      caseOrdinal: 220,
      roundOrdinal: 2,
      choiceKind: "required",
      reason: "expected-tool-not-invoked",
      allowedCallRelation: classifyAllowedCallRelation(
        relationInput({ selectedCallNames: [TOOL_SENTINEL, "read"] }),
      ),
      selectionSource: diagnosticSelectionSourceFor("desired-source"),
      callMultiplicity: diagnosticCallMultiplicityFor(2),
    };
    expect(diagnostic.allowedCallRelation).toBe("mixed-other");
    expect(Object.keys(diagnostic).sort()).toEqual([
      "allowedCallRelation",
      "callMultiplicity",
      "caseOrdinal",
      "choiceKind",
      "reason",
      "roundOrdinal",
      "selectionSource",
    ]);
    expect(ALL_RELATIONS).toContain(diagnostic.allowedCallRelation);
    expect(ALL_SELECTION_SOURCES).toContain(diagnostic.selectionSource);
    expect(ALL_MULTIPLICITIES).toContain(diagnostic.callMultiplicity);
    expect(ALL_REASONS).toContain(diagnostic.reason);
    expect(CHOICE_KINDS).toContain(diagnostic.choiceKind);
    expect(Number.isInteger(diagnostic.caseOrdinal)).toBe(true);
    expect(Number.isInteger(diagnostic.roundOrdinal)).toBe(true);
    expect(transitionDiagnosticDimensionErrors(diagnostic)).toEqual([]);
  });
});
