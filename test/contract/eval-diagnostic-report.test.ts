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
import type { DiagnosticChoiceKind } from "../../src/eval/cases.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/** The nine closed release failure reasons, enumerated by hand on purpose. */
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
  "expected-already-invoked",
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
 * A synthetic three-step scenario shape: three expected tool rounds followed by
 * a final-text round (`undefined`). It mirrors the production corpus layout
 * without borrowing any of its content.
 */
const EXPECTED_SEQUENCE: readonly (string | undefined)[] = ["read", "edit", "test", undefined];

/** 0-based index of the `read` → `edit` transition the campaign failed at. */
const TRANSITION_ROUND_INDEX = 1;

/** 0-based index of the final-text round. */
const FINAL_ROUND_INDEX = 3;

/** A synthetic allowed tool that appears nowhere in {@link EXPECTED_SEQUENCE}. */
const UNRELATED_TOOL = "grep";

/**
 * The invocation history a scenario would have if every earlier round invoked
 * EXACTLY its own expected tool (no parallel calls). This is the default for the
 * fixtures below, so the position-based expectations that predate history-aware
 * classification stay meaningful; the parallel-call cases override it explicitly.
 */
function sequentialHistory(
  expectedToolByRound: readonly (string | undefined)[],
  roundIndex: number,
): ReadonlySet<string> {
  const invoked = new Set<string>();
  for (let r = 0; r < roundIndex && r < expectedToolByRound.length; r += 1) {
    const name = expectedToolByRound[r];
    if (name !== undefined) invoked.add(name);
  }
  return invoked;
}

function relationInput(over: Partial<AllowedCallRelationInput> = {}): AllowedCallRelationInput {
  const expectedToolByRound = over.expectedToolByRound ?? EXPECTED_SEQUENCE;
  const roundIndex = over.roundIndex ?? TRANSITION_ROUND_INDEX;
  return {
    reason: "expected-tool-not-invoked",
    selectedCallNames: ["read"],
    allAllowed: true,
    expectedToolByRound,
    roundIndex,
    priorInvokedNames: sequentialHistory(expectedToolByRound, roundIndex),
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
      roundIndex: FINAL_ROUND_INDEX,
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
  it("pins the diagnostic output-model version to 2", () => {
    expect(DIAGNOSTIC_REPORT_VERSION).toBe(2);
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
      label: "an earlier round's expected tool",
      selectedCallNames: ["read"],
      expected: "prior-only",
    },
    {
      label: "a later round's expected tool",
      selectedCallNames: ["test"],
      expected: "future-only",
    },
    {
      label: "both an earlier and a later expected tool",
      selectedCallNames: ["read", "test"],
      expected: "prior-and-future",
    },
    {
      label: "only an allowed tool outside the expected sequence",
      selectedCallNames: [UNRELATED_TOOL],
      expected: "other-allowed",
    },
    {
      label: "an unrelated allowed tool beside a prior expected tool",
      selectedCallNames: ["read", UNRELATED_TOOL],
      expected: "mixed-other",
    },
    {
      label: "an unrelated allowed tool beside a future expected tool",
      selectedCallNames: ["test", UNRELATED_TOOL],
      expected: "mixed-other",
    },
  ];

  for (const testCase of applicableCases) {
    it(`classifies ${testCase.label} as ${testCase.expected}`, () => {
      expect(relationFor(testCase.selectedCallNames)).toBe(testCase.expected);
    });
  }

  it("produces all seven closed relation members across the fixture set", () => {
    const produced = new Set<AllowedCallRelation>(
      applicableCases.map((testCase) => relationFor(testCase.selectedCallNames)),
    );
    produced.add(classifyAllowedCallRelation(relationInput({ selectedCallNames: null })));
    // The history-aware member: this round's expected tool already ran earlier.
    produced.add(
      classifyAllowedCallRelation(
        relationInput({
          priorInvokedNames: new Set(["read", "edit"]),
          selectedCallNames: ["test"],
        }),
      ),
    );
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
      label: "this round's expected tool was present after all",
      over: { selectedCallNames: ["edit"] },
    },
    {
      label: "this round's expected tool was present beside an unrelated tool",
      over: { selectedCallNames: ["edit", UNRELATED_TOOL] },
    },
    {
      label: "this round's expected tool was present beside a prior expected tool",
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
// 2b. History-aware classification (parallel tool calls)
// ---------------------------------------------------------------------------

describe("diagnostic report — history-aware relation", () => {
  // The round request enables parallel tool calls, so an accepted round can
  // invoke several tools at once. Judging prior/future by STATIC round position
  // then reports a correct continuation as a fabricated skip-ahead.

  it("reports expected-already-invoked when the round's tool ran as a parallel call", () => {
    // Round 1 returned [read, edit]; round 2 still statically expects `edit`,
    // but `edit` already ran, so moving on to `test` is correct behavior.
    expect(
      classifyAllowedCallRelation(
        relationInput({
          priorInvokedNames: new Set(["read", "edit"]),
          selectedCallNames: ["test"],
        }),
      ),
    ).toBe("expected-already-invoked");
  });

  it("prefers expected-already-invoked over any per-name bucket", () => {
    // Whatever the selected names are, a stale expectation outranks them.
    const history = new Set(["read", "edit"]);
    for (const selectedCallNames of [
      ["test"],
      ["read"],
      ["read", "test"],
      [UNRELATED_TOOL],
      ["read", UNRELATED_TOOL],
      ["test", UNRELATED_TOOL],
    ]) {
      expect(
        classifyAllowedCallRelation(
          relationInput({ priorInvokedNames: history, selectedCallNames }),
        ),
      ).toBe("expected-already-invoked");
    }
  });

  it("treats a repeat of an early parallel call as prior, not future", () => {
    // Round 1 returned [read, test]; round 2 repeats `test`. `test` is expected
    // by a LATER round, but it already ran, so history wins over position.
    expect(
      classifyAllowedCallRelation(
        relationInput({
          priorInvokedNames: new Set(["read", "test"]),
          selectedCallNames: ["test"],
        }),
      ),
    ).toBe("prior-only");
  });

  it("still reports a genuine skip-ahead as future-only", () => {
    // Round 1 returned only [read]; `test` has not run and a later round expects
    // it, so selecting `test` at round 2 IS a skip-ahead.
    expect(
      classifyAllowedCallRelation(
        relationInput({ priorInvokedNames: new Set(["read"]), selectedCallNames: ["test"] }),
      ),
    ).toBe("future-only");
  });

  it("still reports a repeat of the previous step as prior-only", () => {
    expect(
      classifyAllowedCallRelation(
        relationInput({ priorInvokedNames: new Set(["read"]), selectedCallNames: ["read"] }),
      ),
    ).toBe("prior-only");
  });

  it("classifies an unrelated allowed tool as other regardless of history", () => {
    expect(
      classifyAllowedCallRelation(
        relationInput({
          priorInvokedNames: new Set(["read"]),
          selectedCallNames: [UNRELATED_TOOL],
        }),
      ),
    ).toBe("other-allowed");
    expect(
      classifyAllowedCallRelation(
        relationInput({
          priorInvokedNames: new Set(["read", "test"]),
          selectedCallNames: ["test", UNRELATED_TOOL],
        }),
      ),
    ).toBe("mixed-other");
  });

  it("treats an empty history as everything-still-ahead", () => {
    // Nothing has run: a later-expected name is a skip-ahead, and a name that
    // WOULD have been an earlier step is simply unrelated to what ran.
    expect(
      classifyAllowedCallRelation(
        relationInput({ priorInvokedNames: new Set(), selectedCallNames: ["test"] }),
      ),
    ).toBe("future-only");
    expect(
      classifyAllowedCallRelation(
        relationInput({ priorInvokedNames: new Set(), selectedCallNames: ["read"] }),
      ),
    ).toBe("other-allowed");
  });

  it("keeps the current-tool-present rule ahead of the future bucket", () => {
    // `edit` (the current expectation) is present and has NOT already run, so
    // the round's failure is not a transition confusion.
    expect(
      classifyAllowedCallRelation(
        relationInput({
          priorInvokedNames: new Set(["read"]),
          selectedCallNames: ["edit", "test"],
        }),
      ),
    ).toBe("not-applicable");
  });

  it("does not mutate or retain the supplied history set", () => {
    const history = new Set(["read"]);
    classifyAllowedCallRelation(
      relationInput({ priorInvokedNames: history, selectedCallNames: ["test", UNRELATED_TOOL] }),
    );
    expect([...history]).toEqual(["read"]);
  });

  it("emits only a closed enum even when the history holds sentinel names", () => {
    const sentinel = "SYNTHETIC-HISTORY-TOOL-5d31";
    const relation = classifyAllowedCallRelation(
      relationInput({
        expectedToolByRound: [sentinel, "edit", "test", undefined],
        priorInvokedNames: new Set([sentinel, "edit"]),
        selectedCallNames: ["test"],
      }),
    );
    expect(relation).toBe("expected-already-invoked");
    expect(JSON.stringify(relation)).not.toContain(sentinel);
    expect(JSON.stringify(relation)).not.toContain("SYNTHETIC");
  });
});

// ---------------------------------------------------------------------------
// 3. Determinism and documented precedence
// ---------------------------------------------------------------------------

describe("diagnostic report — classifier determinism and precedence", () => {
  /** `read` is BOTH a prior (round 0) and a future (round 2) expected tool. */
  const AMBIGUOUS_SEQUENCE: readonly (string | undefined)[] = ["read", "edit", "read", undefined];

  const ambiguousInput = relationInput({
    expectedToolByRound: AMBIGUOUS_SEQUENCE,
    selectedCallNames: ["read"],
  });

  it("resolves a name occupying two expected positions identically on every call", () => {
    const results = [
      classifyAllowedCallRelation(ambiguousInput),
      classifyAllowedCallRelation(ambiguousInput),
      classifyAllowedCallRelation(ambiguousInput),
      classifyAllowedCallRelation(ambiguousInput),
      classifyAllowedCallRelation(ambiguousInput),
    ];
    expect(new Set(results).size).toBe(1);
    expect(results).toEqual(["prior-only", "prior-only", "prior-only", "prior-only", "prior-only"]);
  });

  it("returns the same relation for freshly built, structurally equal inputs", () => {
    const first = classifyAllowedCallRelation(
      relationInput({ expectedToolByRound: AMBIGUOUS_SEQUENCE, selectedCallNames: ["read"] }),
    );
    const second = classifyAllowedCallRelation(
      relationInput({ expectedToolByRound: AMBIGUOUS_SEQUENCE, selectedCallNames: ["read"] }),
    );
    expect(first).toBe(second);
    expect(first).toBe("prior-only");
  });

  it("does not mutate its inputs", () => {
    const selectedCallNames: readonly string[] = ["read", UNRELATED_TOOL];
    const expectedToolByRound: readonly (string | undefined)[] = [...AMBIGUOUS_SEQUENCE];
    classifyAllowedCallRelation(relationInput({ selectedCallNames, expectedToolByRound }));
    expect(selectedCallNames).toEqual(["read", UNRELATED_TOOL]);
    expect(expectedToolByRound).toEqual(["read", "edit", "read", undefined]);
  });

  it("reports a stale expectation when this round's tool already ran earlier", () => {
    // `edit` is both this round's expected tool and round 0's expected tool, so
    // the sequential history already contains it: the round's expectation is
    // stale, which outranks per-name bucketing.
    expect(
      classifyAllowedCallRelation(
        relationInput({
          expectedToolByRound: ["edit", "edit", "test", undefined],
          selectedCallNames: ["edit"],
        }),
      ),
    ).toBe("expected-already-invoked");
  });

  it("ranks the current expected tool above a future occurrence of the same name", () => {
    expect(
      classifyAllowedCallRelation(
        relationInput({
          expectedToolByRound: ["read", "edit", "edit", undefined],
          selectedCallNames: ["edit"],
        }),
      ),
    ).toBe("not-applicable");
  });

  it("ranks a prior expected tool above a future occurrence of the same name", () => {
    expect(classifyAllowedCallRelation(ambiguousInput)).toBe("prior-only");
  });

  it("ranks a future expected tool above the unrelated-allowed bucket", () => {
    expect(relationFor(["test"])).toBe("future-only");
    expect(relationFor(["test", UNRELATED_TOOL])).toBe("mixed-other");
  });
});

// ---------------------------------------------------------------------------
// 3b. The round-index range guard (fails closed rather than guessing)
// ---------------------------------------------------------------------------

describe("diagnostic report — round-index range guard", () => {
  // `roundIndex` and `expectedToolByRound` arrive as separate arguments, so an
  // off-by-one or a scenario/round mispairing at the call site must be LOUD.
  // Without the guard an index past the end silently buckets every named round
  // as prior (a confident `prior-only`) and a negative index buckets them all as
  // future (a confident `future-only`) — a plausible-looking but wrong answer.
  const outOfRange: readonly number[] = [
    EXPECTED_SEQUENCE.length,
    EXPECTED_SEQUENCE.length + 1,
    99,
    -1,
    -42,
  ];

  for (const roundIndex of outOfRange) {
    it(`throws for a round index of ${String(roundIndex)}`, () => {
      expect(() => classifyAllowedCallRelation(relationInput({ roundIndex }))).toThrow();
    });
  }

  for (const roundIndex of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`throws for a non-integer round index of ${String(roundIndex)}`, () => {
      expect(() => classifyAllowedCallRelation(relationInput({ roundIndex }))).toThrow();
    });
  }

  it("throws BEFORE any reason or call-set short-circuit could hide the mispairing", () => {
    // A reason that would otherwise return `not-applicable` immediately, and a
    // null call set, must still surface the bad index.
    expect(() =>
      classifyAllowedCallRelation(
        relationInput({ reason: "expected-tool-unavailable", roundIndex: 99 }),
      ),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation(relationInput({ selectedCallNames: null, roundIndex: 99 })),
    ).toThrow();
    expect(() =>
      classifyAllowedCallRelation(relationInput({ allAllowed: false, roundIndex: -1 })),
    ).toThrow();
  });

  it("accepts every in-range index of the fixture sequence", () => {
    for (let roundIndex = 0; roundIndex < EXPECTED_SEQUENCE.length; roundIndex += 1) {
      expect(() => classifyAllowedCallRelation(relationInput({ roundIndex }))).not.toThrow();
    }
  });

  it("throws value-free: the message carries no tool name, path, or prompt", () => {
    const sentinel = "SYNTHETIC-GUARD-TOOL-3f8c";
    let message = "";
    try {
      classifyAllowedCallRelation(
        relationInput({
          expectedToolByRound: [sentinel, "edit", "test", undefined],
          selectedCallNames: [sentinel],
          roundIndex: 99,
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain("SYNTHETIC");
    expect(message).not.toContain("99");
  });
});

// ---------------------------------------------------------------------------
// 4. The final-text round
// ---------------------------------------------------------------------------

describe("diagnostic report — final-round relation", () => {
  it("confirms the fixture's final round expects text rather than a tool", () => {
    expect(EXPECTED_SEQUENCE[FINAL_ROUND_INDEX]).toBeUndefined();
  });

  const finalCases: readonly {
    readonly label: string;
    readonly selectedCallNames: readonly string[];
    readonly expected: AllowedCallRelation;
  }[] = [
    { label: "the first expected tool", selectedCallNames: ["read"], expected: "prior-only" },
    { label: "the middle expected tool", selectedCallNames: ["edit"], expected: "prior-only" },
    {
      label: "every expected tool",
      selectedCallNames: ["read", "edit", "test"],
      expected: "prior-only",
    },
    {
      label: "only an unrelated allowed tool",
      selectedCallNames: [UNRELATED_TOOL],
      expected: "other-allowed",
    },
    {
      label: "an unrelated allowed tool beside an expected tool",
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
          roundIndex: FINAL_ROUND_INDEX,
          selectedCallNames: null,
        }),
      ),
    ).toBe("not-applicable");
    expect(
      classifyAllowedCallRelation(
        relationInput({
          reason: "unexpected-tool-call-on-final",
          roundIndex: FINAL_ROUND_INDEX,
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
    expect(ALL_REASONS).toHaveLength(9);
    expect(new Set(ALL_REASONS).size).toBe(9);
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

  it("covers all seven relation-free reasons in the loop above", () => {
    expect(relationFreeReasons).toHaveLength(7);
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
  it("pins the relation codes so a persisted ledger never renumbers", () => {
    // Codes 1–6 are unchanged from format v1; the history-aware member was
    // APPENDED as 7 rather than renumbering existing entries.
    expect({ ...ALLOWED_CALL_RELATION_CODES }).toEqual({
      "prior-only": 1,
      "future-only": 2,
      "prior-and-future": 3,
      "other-allowed": 4,
      "mixed-other": 5,
      "not-applicable": 6,
      "expected-already-invoked": 7,
    });
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
      label: "a prior expected tool",
      input: relationInput({
        expectedToolByRound: [TOOL_SENTINEL, "edit", "test", undefined],
        selectedCallNames: [TOOL_SENTINEL],
      }),
      expected: "prior-only",
    },
    {
      label: "a future expected tool",
      input: relationInput({
        expectedToolByRound: ["read", "edit", TOOL_SENTINEL, undefined],
        selectedCallNames: [TOOL_SENTINEL],
      }),
      expected: "future-only",
    },
    {
      label: "the current expected tool",
      input: relationInput({
        expectedToolByRound: ["read", TOOL_SENTINEL, "test", undefined],
        selectedCallNames: [TOOL_SENTINEL],
      }),
      expected: "not-applicable",
    },
    {
      label: "a path- and a prompt-like name beside a prior expected tool",
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
