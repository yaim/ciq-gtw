/**
 * Hermetic filesystem tests for the evaluator's private resume checkpoint store.
 * Every value is synthetic (no account data, no live values). Faults are injected
 * through the module-internal fs seam; directory/symlink/mode cases use real temp
 * directories. No network, no credential.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  __setCheckpointFsForTests,
  checkpointExists,
  deleteCheckpoint,
  readCheckpoint,
  rehydrateDiagnosticFailures,
  validateResumableCheckpoint,
  writeCheckpoint,
  CHECKPOINT_FILENAME,
  CHECKPOINT_FORMAT_VERSION,
  type CheckpointData,
  type CheckpointDiagnosticFailure,
  type CheckpointFsOps,
  type CheckpointLocation,
  type CheckpointScenarioEvidence,
} from "../../src/eval/checkpoint.js";
import { SCENARIO_STEP_COUNT } from "../../src/eval/scenario-engine.js";
import { EVAL_FAILURE_REASON_CODES, MAX_DIAGNOSTIC_FAILURES } from "../../src/eval/report.js";
import {
  buildEvalCases,
  buildEvalCorpusProjection,
  corpusFingerprint,
  evalPlan,
  type EvalCase,
  type EvalCorpusProjection,
} from "../../src/eval/cases.js";

const ORIGIN = "https://api.prod.collectiviq.ai";
const FP = "a".repeat(64);
const EXPECTED = { origin: ORIGIN, corpusFingerprint: FP };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ciq-eval-cp-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Wrap a simple eval directory as a {@link CheckpointLocation}: the temp dir's
 * immediate parent (the OS temp root) is the trusted base and the dir itself is
 * the single managed component that gets symlink/mode-validated. Multi-component
 * ancestry cases build explicit locations instead.
 */
function loc(dir: string): CheckpointLocation {
  return { base: dirname(dir), components: [basename(dir)] };
}

function file(dir: string): string {
  return join(dir, CHECKPOINT_FILENAME);
}

function data(over: Partial<CheckpointData> = {}): CheckpointData {
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    origin: ORIGIN,
    authMode: "password",
    corpusFingerprint: FP,
    resumeState: "resumable",
    abort: null,
    nextCaseIndex: 42,
    runSegments: 2,
    attemptedRounds: 42,
    completedRounds: 42,
    completedSingleRoundCases: 42,
    completedMultiStepScenarios: 0,
    cleanup: { attempted: 42, deleted: 42, failed: 0, journalFailures: 0 },
    gates: {
      expectedCall: { total: 42, schemaValid: 42, nameAccurate: 42, argValid: 42 },
      single: { total: 42, success: 42 },
      multi: { total: 0, success: 0 },
    },
    invariants: { noSilentFallback: true, injectionResistance: true },
    scenarioEvidence: [],
    diagnosticFailures: [],
    ...over,
  };
}

/** A blocked tombstone (finding 2): value-free closed abort stage/reason. */
function blockedData(over: Partial<CheckpointData> = {}): CheckpointData {
  return data({
    resumeState: "blocked",
    abort: { stage: "cleanup-delete", reason: "cleanup-failed" },
    ...over,
  });
}

describe("eval checkpoint — round trip", () => {
  it("writes 0600 and reads back the same content", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    expect(statSync(file(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readCheckpoint(loc(dir), EXPECTED)).toEqual(data());
    expect(checkpointExists(loc(dir))).toBe(true);
  });

  it("returns null when absent", () => {
    const dir = tempDir();
    expect(readCheckpoint(loc(dir), EXPECTED)).toBeNull();
    expect(checkpointExists(loc(dir))).toBe(false);
  });

  it("deletes the checkpoint", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    deleteCheckpoint(loc(dir));
    expect(readCheckpoint(loc(dir), EXPECTED)).toBeNull();
  });

  it("tightens a loose (0755) directory to 0700 on write", () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    writeCheckpoint(loc(dir), data());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("eval checkpoint — fail-closed validation", () => {
  it("rejects a wrong origin", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    expect(() =>
      readCheckpoint(loc(dir), { origin: "https://evil.example", corpusFingerprint: FP }),
    ).toThrow();
  });

  it("rejects a wrong corpus fingerprint", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    expect(() =>
      readCheckpoint(loc(dir), { origin: ORIGIN, corpusFingerprint: "b".repeat(64) }),
    ).toThrow();
  });

  it("rejects a wrong auth mode / version / non-hex fingerprint on disk", () => {
    const dir = tempDir();
    for (const bad of [
      JSON.stringify({ ...data(), authMode: "bearer" }),
      // Format v1 predates the compact diagnostic ledger; the reader MUST refuse
      // it with no migration path (see `parseCheckpoint` version rejection).
      JSON.stringify({ ...data(), formatVersion: 1 }),
      // Format v2 predates any per-scenario ledger, and v3's ledger was a
      // POSITIONAL executed-round count that cannot be replayed under v4
      // transition-based accounting; both are rejected outright.
      JSON.stringify({ ...data(), formatVersion: 2 }),
      JSON.stringify({ ...data(), formatVersion: 3 }),
      // Format v5+ is also unsupported: only the current version is accepted.
      JSON.stringify({ ...data(), formatVersion: 5 }),
      JSON.stringify({ ...data(), corpusFingerprint: "ZZZ" }),
    ]) {
      writeFileSync(file(dir), bad, { mode: 0o600 });
      expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("rejects an unexpected field and a missing field", () => {
    const dir = tempDir();
    writeFileSync(file(dir), JSON.stringify({ ...data(), extra: 1 }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    const { runSegments: _omit, ...missing } = data();
    void _omit;
    writeFileSync(file(dir), JSON.stringify(missing), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects an out-of-range or non-integer count", () => {
    const dir = tempDir();
    writeFileSync(file(dir), JSON.stringify({ ...data(), nextCaseIndex: -1 }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    writeFileSync(file(dir), JSON.stringify({ ...data(), attemptedRounds: 1.5 }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    writeFileSync(file(dir), JSON.stringify({ ...data(), runSegments: 1e12 }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a non-boolean invariant", () => {
    const dir = tempDir();
    writeFileSync(
      file(dir),
      JSON.stringify({ ...data(), invariants: { noSilentFallback: 1, injectionResistance: true } }),
      { mode: 0o600 },
    );
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects malformed JSON", () => {
    const dir = tempDir();
    writeFileSync(file(dir), "{ not json", { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects an oversized file", () => {
    const dir = tempDir();
    writeFileSync(
      file(dir),
      JSON.stringify({ ...data(), corpusFingerprint: FP }) + " ".repeat(9000),
      {
        mode: 0o600,
      },
    );
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a non-private (0644) file", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    chmodSync(file(dir), 0o644);
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a symlinked file", () => {
    const dir = tempDir();
    const realDir = tempDir();
    writeCheckpoint(loc(realDir), data());
    symlinkSync(file(realDir), file(dir));
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a symlinked directory", () => {
    const realDir = tempDir();
    mkdirSync(join(realDir, "real"), { mode: 0o700 });
    const linkDir = join(realDir, "link");
    symlinkSync(join(realDir, "real"), linkDir);
    expect(() => readCheckpoint(loc(linkDir), EXPECTED)).toThrow();
  });

  it("rejects a non-0700 directory on read", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    chmodSync(dir, 0o755);
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });
});

describe("eval checkpoint — injected write faults", () => {
  function withFs<T>(overrides: Partial<CheckpointFsOps>, run: () => T): T {
    const restore = __setCheckpointFsForTests(overrides);
    try {
      return run();
    } finally {
      restore();
    }
  }

  it("fails closed on a zero-progress writeSync, removing the temp and preserving the prior file", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data()); // a valid prior checkpoint
    withFs({ writeSync: () => 0 }, () => {
      expect(() => writeCheckpoint(loc(dir), data({ nextCaseIndex: 99 }))).toThrow();
    });
    // Prior file intact; no leftover temp files.
    expect(readCheckpoint(loc(dir), EXPECTED)?.nextCaseIndex).toBe(42);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("fails closed and preserves the prior file when rename fails", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    withFs(
      {
        renameSync: () => {
          throw new Error("rename failed");
        },
      },
      () => {
        expect(() => writeCheckpoint(loc(dir), data({ nextCaseIndex: 77 }))).toThrow();
      },
    );
    expect(readCheckpoint(loc(dir), EXPECTED)?.nextCaseIndex).toBe(42);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("fails closed when the descriptor grows past the cap after fstat", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    // fstat reports a small size, but readSync keeps returning bytes past the cap.
    withFs(
      {
        fstatSync: (() => ({
          isFile: () => true,
          mode: 0o600,
          size: 10,
        })) as unknown as CheckpointFsOps["fstatSync"],
        readSync: () => 4096,
      },
      () => {
        expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
      },
    );
  });
});

describe("eval checkpoint — directory access edge", () => {
  it("checkpointExists returns false for an absent directory", () => {
    expect(checkpointExists(loc(join(tmpdir(), "ciq-eval-cp-does-not-exist-xyz")))).toBe(false);
  });
  it("lstat-verifies the file is not a symlink for checkpointExists", () => {
    const dir = tempDir();
    const realDir = tempDir();
    writeCheckpoint(loc(realDir), data());
    symlinkSync(file(realDir), file(dir));
    expect(() => checkpointExists(loc(dir))).toThrow();
    // Confirm it is genuinely a symlink (sanity).
    expect(lstatSync(file(dir)).isSymbolicLink()).toBe(true);
  });
});

describe("eval checkpoint — exact 0600 mode contract (finding 3)", () => {
  for (const mode of [0o400, 0o200, 0o000, 0o700, 0o640] as const) {
    it(`rejects a checkpoint file with mode ${mode.toString(8)}`, () => {
      const dir = tempDir();
      writeCheckpoint(loc(dir), data());
      chmodSync(file(dir), mode);
      expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    });
  }
  it("accepts exactly 0600", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data());
    expect(statSync(file(dir)).mode & 0o777).toBe(0o600);
    expect(readCheckpoint(loc(dir), EXPECTED)?.nextCaseIndex).toBe(42);
  });
});

describe("eval checkpoint — managed-component ancestry (finding 2)", () => {
  const COMPONENTS = [".agent", "sessions", "eval"] as const;
  const loc3 = (base: string): CheckpointLocation => ({ base, components: [...COMPONENTS] });

  /** Create `base/<a>/<b>/…` as real 0700 dirs; return the deepest dir. */
  function realTree(base: string, comps: readonly string[]): string {
    let cur = base;
    for (const c of comps) {
      cur = join(cur, c);
      mkdirSync(cur, { mode: 0o700 });
    }
    return cur;
  }

  it("succeeds with a safe trusted base and real managed directories", () => {
    const base = tempDir();
    const location = loc3(base);
    writeCheckpoint(location, data());
    expect(readCheckpoint(location, EXPECTED)).toEqual(data());
    expect(checkpointExists(location)).toBe(true);
    deleteCheckpoint(location);
    expect(readCheckpoint(location, EXPECTED)).toBeNull();
  });

  it("ignores a platform symlink AT/above the trusted base", () => {
    // The base itself is a symlink to a real dir; every managed component is real.
    // Ancestry at/above the trusted base is deliberately out of scope.
    const realBase = tempDir();
    const linkBase = join(tempDir(), "platform-link");
    symlinkSync(realBase, linkBase);
    const location = loc3(linkBase);
    writeCheckpoint(location, data());
    expect(readCheckpoint(location, EXPECTED)?.nextCaseIndex).toBe(42);
    // Materialized under the real target reachable via the trusted base symlink.
    expect(readCheckpoint(loc3(realBase), EXPECTED)?.nextCaseIndex).toBe(42);
  });

  // A symlink at EACH managed component, WITH the descendants (and a real seeded
  // checkpoint) already existing THROUGH it — the exact gap finding 2 closes. Every
  // op must reject before traversing the symlink, and the target must be untouched.
  for (const symlinkAt of COMPONENTS) {
    it(`rejects every op when '${symlinkAt}' is a symlink whose child exists through it`, () => {
      const base = tempDir();
      const realRoot = tempDir();
      const idx = COMPONENTS.indexOf(symlinkAt);
      const prefix = COMPONENTS.slice(0, idx);
      const suffix = COMPONENTS.slice(idx + 1);
      // Real managed prefix under base; the real symlink target subtree under realRoot.
      const baseParent = realTree(base, prefix);
      const targetEval = realTree(realRoot, [symlinkAt, ...suffix]);
      writeCheckpoint(loc(targetEval), data()); // a real checkpoint in the target
      // Replace `symlinkAt` in base's chain with a symlink into the real target.
      symlinkSync(join(realRoot, symlinkAt), join(baseParent, symlinkAt));
      const location = loc3(base);
      expect(() => readCheckpoint(location, EXPECTED)).toThrow();
      // The rejected write must not create or modify a checkpoint in the target.
      expect(() => writeCheckpoint(location, data({ nextCaseIndex: 99 }))).toThrow();
      expect(() => deleteCheckpoint(location)).toThrow();
      expect(() => checkpointExists(location)).toThrow();
      expect(readCheckpoint(loc(targetEval), EXPECTED)?.nextCaseIndex).toBe(42);
    });
  }

  // A NON-directory (regular file) at each managed component is rejected too.
  for (const nonDirAt of COMPONENTS) {
    it(`rejects a non-directory '${nonDirAt}' managed component`, () => {
      const base = tempDir();
      const idx = COMPONENTS.indexOf(nonDirAt);
      const parent = realTree(base, COMPONENTS.slice(0, idx));
      writeFileSync(join(parent, nonDirAt), "x", { mode: 0o600 });
      const location = loc3(base);
      expect(() => readCheckpoint(location, EXPECTED)).toThrow();
      expect(() => writeCheckpoint(location, data())).toThrow();
      expect(() => checkpointExists(location)).toThrow();
    });
  }

  it("creates missing managed components one at a time (no recursive follow)", () => {
    // None of .agent/sessions/eval exist yet; write must create each safely.
    const base = tempDir();
    const location = loc3(base);
    writeCheckpoint(location, data());
    for (const c of [".agent", ".agent/sessions", ".agent/sessions/eval"]) {
      const s = lstatSync(join(base, c));
      expect(s.isSymbolicLink()).toBe(false);
      expect(s.isDirectory()).toBe(true);
    }
    expect(statSync(join(base, ".agent/sessions/eval")).mode & 0o777).toBe(0o700);
  });
});

describe("eval checkpoint — resumeState + tombstone schema (finding 2)", () => {
  it("round-trips a blocked tombstone with a closed abort stage/reason", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), blockedData());
    expect(readCheckpoint(loc(dir), EXPECTED)).toEqual(blockedData());
  });

  it("rejects an invalid resumeState", () => {
    const dir = tempDir();
    writeFileSync(file(dir), JSON.stringify({ ...data(), resumeState: "maybe" }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a resumable checkpoint carrying a non-null abort", () => {
    const dir = tempDir();
    writeFileSync(
      file(dir),
      JSON.stringify({ ...data(), abort: { stage: "cleanup-delete", reason: "cleanup-failed" } }),
      { mode: 0o600 },
    );
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a blocked tombstone with a null / unknown-stage / unknown-reason abort", () => {
    const dir = tempDir();
    for (const bad of [
      { ...data(), resumeState: "blocked", abort: null },
      { ...data(), resumeState: "blocked", abort: { stage: "made-up", reason: "cleanup-failed" } },
      { ...data(), resumeState: "blocked", abort: { stage: "cleanup-delete", reason: "made-up" } },
      { ...data(), resumeState: "blocked", abort: { stage: "cleanup-delete" } },
    ]) {
      writeFileSync(file(dir), JSON.stringify(bad), { mode: 0o600 });
      expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });
});

/**
 * The fingerprint-bound corpus projection: the SOLE trust source for
 * corpus-bound checkpoint validation. Aggregate bounds (single=200, multi=20,
 * expectedCallsPerScenario=3, maxRoundsPerCase=4) plus the ACTUAL per-round
 * `choiceKind`/`hasExpectedTool` layout are all derived from
 * `buildEvalCases()` — never from external claims.
 */
const PROJECTION: EvalCorpusProjection = buildEvalCorpusProjection(buildEvalCases());
/** Legacy short alias used across the semantic-validation `it` blocks. */
const PLAN = PROJECTION;

/**
 * Derive the exact `{ noSilentFallback, injectionResistance }` a truthful run
 * would have persisted for `cp`, given the fingerprint-bound corpus projection
 * `projection`. Test seed helpers use this to auto-fill invariants so tests
 * that model a specific diagnostic ledger stay consistent with the runner's
 * live invariant state (see `checkpoint.ts` derivation). This mirrors the
 * derivation inside `validateResumableCheckpoint` — but here it is
 * intentionally used only to CONSTRUCT semantically consistent test data,
 * never to short-circuit the production validator's derivation.
 */
function deriveInvariantsForTests(
  cp: CheckpointData,
  projection: EvalCorpusProjection,
): { noSilentFallback: boolean; injectionResistance: boolean } {
  let noSilentFallback = true;
  let injectionResistance = true;
  const perCase = new Map<number, { ro: number; reason: string }>();
  for (const [co, ro, rc] of cp.diagnosticFailures) {
    const reason = Object.entries(EVAL_FAILURE_REASON_CODES).find(([, code]) => code === rc)?.[0];
    if (reason === undefined) continue;
    perCase.set(co, { ro, reason });
  }
  let ledgerIdx = 0;
  for (let i = 0; i < cp.nextCaseIndex; i += 1) {
    const projectedCase = projection.cases[i];
    if (projectedCase === undefined) continue;
    const co = i + 1;
    const diag = perCase.get(co) ?? null;
    if (projectedCase.phase === "single") {
      const round = projectedCase.rounds[0];
      if (round === undefined) continue;
      const constrained = round.choiceKind === "required" || round.choiceKind === "function";
      if (diag?.reason === "unauthorized-tool-call") injectionResistance = false;
      if (round.hasExpectedTool) {
        if (constrained && diag?.reason === "expected-tool-returned-text") {
          noSilentFallback = false;
        }
      } else if (constrained && diag === null) {
        noSilentFallback = false;
      }
      continue;
    }
    // State-aware multi-step derivation: every round before the terminal one
    // was an accepted tool-call round, so only the terminal round can witness
    // ordinary text or an unauthorized call.
    const executed = cp.scenarioEvidence[ledgerIdx]?.[0] ?? projectedCase.rounds.length;
    ledgerIdx += 1;
    const terminalRound = projectedCase.rounds[executed - 1];
    if (terminalRound === undefined) continue;
    const constrained =
      terminalRound.choiceKind === "required" || terminalRound.choiceKind === "function";
    if (diag?.reason === "unauthorized-tool-call") injectionResistance = false;
    if (constrained && (diag === null || diag.reason === "expected-tool-returned-text")) {
      noSilentFallback = false;
    }
  }
  return { noSilentFallback, injectionResistance };
}

/** All-steps-set mask for the fixed three-step workflow. */
const FULL_STEP_MASK = (1 << SCENARIO_STEP_COUNT) - 1;

/**
 * Build a truthful {@link CheckpointScenarioEvidence} tuple for a committed
 * multi-step scenario, mirroring exactly what the runner would persist.
 *
 * `satisfied` defaults to "every planned transition succeeded"; the masks
 * default to the satisfied prefix plus, when `pendingEvidence` is supplied, the
 * schema/argument/name bits the terminal round earned for the still-pending
 * step (the same contributions `accumulateExpectedRound` derives from a
 * diagnostic reason).
 */
function evidence(
  executed: number,
  satisfied: number = SCENARIO_STEP_COUNT,
  pendingEvidence: { schemaAndArg?: boolean; name?: boolean } = {},
): CheckpointScenarioEvidence {
  const prefix = satisfied <= 0 ? 0 : (1 << satisfied) - 1;
  const pendingBit = satisfied < SCENARIO_STEP_COUNT ? 1 << satisfied : 0;
  const schemaArgBit = pendingEvidence.schemaAndArg === true ? pendingBit : 0;
  const nameBit = pendingEvidence.name === true ? pendingBit : 0;
  return [executed, satisfied, prefix | schemaArgBit, prefix | nameBit, prefix | schemaArgBit];
}

/** Convenience: a fully successful scenario that used `executed` upstream rounds. */
function successEvidence(executed: number): CheckpointScenarioEvidence {
  return [executed, SCENARIO_STEP_COUNT, FULL_STEP_MASK, FULL_STEP_MASK, FULL_STEP_MASK];
}

/**
 * Auto-fill `cp.invariants` from its own diagnostic + executed-round ledgers
 * unless the caller passed an explicit `invariantsOverride`. Preserves the
 * existing helper contract (round-trip / write / read tests never carry
 * violation-implying diagnostics, so their invariants stay `{ true, true }`).
 */
function withDerivedInvariants(
  cp: CheckpointData,
  projection: EvalCorpusProjection,
  invariantsOverride?: CheckpointData["invariants"],
): CheckpointData {
  if (invariantsOverride !== undefined) return { ...cp, invariants: invariantsOverride };
  return { ...cp, invariants: deriveInvariantsForTests(cp, projection) };
}

/**
 * A semantically-VALID resumable seed for `cursor` with EXACTLY the committed
 * counts a genuine (fully-successful) run would persist: a committed scenario
 * contributes `expectedCallsPerScenario` (3) to the gate denominators and, by
 * default, `maxRoundsPerCase` (4) upstream rounds with every transition
 * satisfied — the per-scenario evidence ledger is uniformly
 * `[[4, 3, 7, 7, 7], ...]` (length = committedMulti). Callers may override
 * `scenarioEvidence` and the round counters to model an early-terminated or
 * parallel-shortened scenario (see {@link evidence} / {@link successEvidence};
 * `attemptedRounds == committedSingle + Σ executedRounds` for a
 * resumable-anchor seed). `runSegments` defaults to `data()`'s value (2).
 * `invariants` is auto-derived from the resulting diagnostic + evidence ledgers
 * so tests that model a specific diagnostic stay consistent with the runner's
 * live invariant state; pass `over.invariants` to override for a
 * forgery-probing test.
 *
 * Gate numerators default to the fully-successful values, so a seed that models
 * a diagnostic must pass matching `gates` overrides — exactly as before.
 */
function validSeed(cursor: number, over: Partial<CheckpointData> = {}): CheckpointData {
  const committedSingle = Math.min(cursor, PLAN.plannedSingle);
  const committedMulti = Math.max(0, cursor - PLAN.plannedSingle);
  const expDenom = committedSingle + committedMulti * PLAN.expectedCallsPerScenario;
  const scenarioEvidence =
    over.scenarioEvidence ??
    Array.from({ length: committedMulti }, () => successEvidence(PLAN.maxRoundsPerCase));
  const rounds = committedSingle + scenarioEvidence.reduce((sum, [executed]) => sum + executed, 0);
  const invariantsOverride = over.invariants;
  const built = data({
    nextCaseIndex: cursor,
    completedSingleRoundCases: committedSingle,
    completedMultiStepScenarios: committedMulti,
    attemptedRounds: rounds,
    completedRounds: rounds,
    cleanup: { attempted: rounds, deleted: rounds, failed: 0, journalFailures: 0 },
    gates: {
      expectedCall: {
        total: expDenom,
        schemaValid: expDenom,
        nameAccurate: expDenom,
        argValid: expDenom,
      },
      single: { total: committedSingle, success: committedSingle },
      multi: { total: committedMulti, success: committedMulti },
    },
    scenarioEvidence,
    ...over,
  });
  return withDerivedInvariants(built, PLAN, invariantsOverride);
}

describe("eval checkpoint — semantic corpus-bound validation (finding 1)", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("accepts a valid single-phase, multi-phase, and mid-scenario partial seed", () => {
    ok(validSeed(0)); // fresh anchor, all zero
    ok(validSeed(5)); // single phase
    ok(validSeed(200)); // single/multi boundary
    ok(validSeed(205)); // 5 scenarios committed (all executed the full 4 rounds)
    // Mid-scenario partial: cursor 205, 5 committed, an in-flight scenario ran 2 rounds.
    ok(
      validSeed(205, {
        completedRounds: 200 + 5 * 4 + 2,
        attemptedRounds: 200 + 5 * 4 + 2,
        cleanup: {
          attempted: 200 + 5 * 4 + 2,
          deleted: 200 + 5 * 4 + 2,
          failed: 0,
          journalFailures: 0,
        },
      }),
    );
  });

  it("REJECTS a forged complete + passing checkpoint (cursor == corpus length)", () => {
    // cursor 220 = complete corpus. A genuine complete run removes its checkpoint,
    // so a resumable cursor==length can only be a forgery/crash-window; reject it
    // so it can never grant a zero-network pass.
    bad(
      validSeed(220, {
        nextCaseIndex: 220,
        completedSingleRoundCases: 200,
        completedMultiStepScenarios: 20,
        attemptedRounds: 280,
        completedRounds: 280,
        cleanup: { attempted: 280, deleted: 280, failed: 0, journalFailures: 0 },
        gates: {
          expectedCall: { total: 260, schemaValid: 260, nameAccurate: 260, argValid: 260 },
          single: { total: 200, success: 200 },
          multi: { total: 20, success: 20 },
        },
      }),
    );
  });

  it("REJECTS a zero-attempt checkpoint claiming committed cases", () => {
    bad(
      validSeed(5, {
        attemptedRounds: 0,
        completedRounds: 0,
        cleanup: { attempted: 0, deleted: 0, failed: 0, journalFailures: 0 },
      }),
    );
  });

  it("rejects cursor/committed-count mismatches", () => {
    bad(validSeed(5, { completedSingleRoundCases: 4 }));
    bad(validSeed(205, { completedMultiStepScenarios: 4 }));
    bad(validSeed(5, { nextCaseIndex: -1 }));
  });

  it("rejects denominator mismatches (planned bounds from the real plan)", () => {
    bad(
      validSeed(5, {
        gates: {
          expectedCall: { total: 4, schemaValid: 4, nameAccurate: 4, argValid: 4 },
          single: { total: 5, success: 5 },
          multi: { total: 0, success: 0 },
        },
      }),
    );
    bad(
      validSeed(5, {
        gates: {
          expectedCall: { total: 5, schemaValid: 5, nameAccurate: 5, argValid: 5 },
          single: { total: 4, success: 4 },
          multi: { total: 0, success: 0 },
        },
      }),
    );
    bad(
      validSeed(205, {
        gates: {
          expectedCall: { total: 215, schemaValid: 215, nameAccurate: 215, argValid: 215 },
          single: { total: 200, success: 200 },
          multi: { total: 4, success: 4 },
        },
      }),
    );
  });

  it("rejects numerators above their denominator", () => {
    bad(
      validSeed(5, {
        gates: {
          expectedCall: { total: 5, schemaValid: 6, nameAccurate: 5, argValid: 5 },
          single: { total: 5, success: 5 },
          multi: { total: 0, success: 0 },
        },
      }),
    );
    bad(
      validSeed(5, {
        gates: {
          expectedCall: { total: 5, schemaValid: 5, nameAccurate: 5, argValid: 5 },
          single: { total: 5, success: 6 },
          multi: { total: 0, success: 0 },
        },
      }),
    );
  });

  it("rejects untruthful resumable cleanup accounting", () => {
    bad(validSeed(5, { cleanup: { attempted: 5, deleted: 4, failed: 1, journalFailures: 0 } })); // failed != 0
    bad(validSeed(5, { cleanup: { attempted: 5, deleted: 5, failed: 0, journalFailures: 1 } })); // journal failure
    bad(validSeed(5, { cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 } })); // attempted != attemptedRounds(5)
    bad(validSeed(5, { completedRounds: 6 })); // completed > attempted(5)
  });

  it("rejects completed-rounds below the committed minimum", () => {
    bad(
      validSeed(205, {
        completedRounds: 214,
        attemptedRounds: 214,
        cleanup: { attempted: 214, deleted: 214, failed: 0, journalFailures: 0 },
      }),
    );
  });

  it("counts a committed scenario using its executed-round ledger, not maxRoundsPerCase (finding 1)", () => {
    // A committed multi-step scenario contributes BETWEEN 1 and maxRoundsPerCase
    // (4) upstream rounds; the `scenarioEvidence` ledger's executed-round
    // element is the SOLE source of truth. `validSeed` defaults to a uniform
    // `successEvidence(4)` for one committed scenario (= 200 + 4 = 204 upstream
    // rounds); a claim of 203 against that ledger is internally inconsistent
    // and rejected.
    const short = { attemptedRounds: 203, completedRounds: 203 };
    bad(
      validSeed(201, {
        ...short,
        cleanup: { attempted: 203, deleted: 203, failed: 0, journalFailures: 0 },
      }),
    );
    ok(validSeed(201)); // 204 upstream rounds is correct for [4]
  });

  it("accepts a committed early-terminated scenario with a truthful evidence entry (spec §30)", () => {
    // A scenario that legitimately terminated at its third upstream round
    // commits with ONE evidence tuple AND exactly ONE primary diagnostic AT
    // that terminal round — the runner writes both together at scenario
    // commit. `multi.success` cannot count an early-terminated scenario, so
    // it is 0 here. Transition accounting:
    //
    //   200 single expected rounds (all passed) → 200 schema/arg/name.
    //   Case 201 satisfied its first two transitions (read, edit) → the
    //     satisfied prefix 0b011 is set in all three masks.
    //   Its terminal round is diagnosed `expected-tool-returned-text`
    //     (decision.kind = "text"), so the still-pending third transition
    //     earned no schema/argument/name evidence → its bit stays clear.
    //
    // So: expectedCall.total = 200 + 3 (every PLANNED transition counts) and
    // schema/arg/name = 200 + popcount(0b011) = 202. The unsatisfied
    // transition is a truthful miss, not an attempted upstream round. The
    // scenario's upstream floor is 200 + 3 = 203.
    ok(
      validSeed(201, {
        scenarioEvidence: [evidence(3, 2)],
        diagnosticFailures: [[201, 3, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
        gates: {
          expectedCall: {
            total: 200 + 3,
            schemaValid: 200 + 2,
            nameAccurate: 200 + 2,
            argValid: 200 + 2,
          },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("rejects a scenarioEvidence ledger whose length disagrees with the committed multi count", () => {
    // committed multi = 1, but the ledger claims 2 entries.
    bad(
      validSeed(201, {
        scenarioEvidence: [successEvidence(4), successEvidence(4)],
      }),
    );
    // committed multi = 2, but the ledger claims 1 entry.
    bad(
      validSeed(202, {
        scenarioEvidence: [successEvidence(4)],
      }),
    );
  });

  it("rejects a scenarioEvidence executed-round count below 1 or above its case's round count", () => {
    // Zero → below the minimum (a committed scenario always ran round 1).
    bad(validSeed(201, { scenarioEvidence: [successEvidence(0)] }));
    // Five → above case 201's actual round count (4).
    bad(validSeed(201, { scenarioEvidence: [successEvidence(5)] }));
  });

  it("rejects a committed upstream floor that disagrees with the executed-round ledger", () => {
    // Ledger sums to 4 upstream rounds; committedSingle=200 → floor 204. A
    // claim of 210 attempted+completed with runSegments=1 exceeds the resume
    // ceiling (204 + 1*4 = 208).
    bad(
      validSeed(201, {
        runSegments: 1,
        attemptedRounds: 210,
        completedRounds: 210,
        cleanup: { attempted: 210, deleted: 210, failed: 0, journalFailures: 0 },
      }),
    );
  });

  it("rejects arbitrarily inflated operational counters (finding 1)", () => {
    // runSegments 1 permits at most committedUpstreamRounds + 1*maxRoundsPerCase slack.
    bad(
      validSeed(201, {
        runSegments: 1,
        attemptedRounds: 10_000_000,
        completedRounds: 10_000_000,
        cleanup: { attempted: 10_000_000, deleted: 10_000_000, failed: 0, journalFailures: 0 },
      }),
    );
  });

  it("accepts operational counters exactly at the per-segment resume ceiling", () => {
    // cursor 205 (220 committed rounds with a uniform [4]×5 ledger), runSegments
    // 5: completed ceil 220+5*3=235, attempted ceil 220+5*4=240 (up to 3
    // completed-uncommitted + 1 failed per segment).
    ok(
      validSeed(205, {
        runSegments: 5,
        completedRounds: 235,
        attemptedRounds: 240,
        cleanup: { attempted: 240, deleted: 240, failed: 0, journalFailures: 0 },
      }),
    );
  });

  it("rejects operational counters just beyond the resume ceiling", () => {
    // One attempted round beyond the ceiling.
    bad(
      validSeed(205, {
        runSegments: 5,
        completedRounds: 235,
        attemptedRounds: 241,
        cleanup: { attempted: 241, deleted: 241, failed: 0, journalFailures: 0 },
      }),
    );
    // One completed round beyond the completed ceiling.
    bad(
      validSeed(205, {
        runSegments: 5,
        completedRounds: 236,
        attemptedRounds: 240,
        cleanup: { attempted: 240, deleted: 240, failed: 0, journalFailures: 0 },
      }),
    );
  });

  it("rejects a run-segment count below one", () => {
    bad(validSeed(5, { runSegments: 0 }));
  });

  it("rejects a blocked tombstone as non-resumable", () => {
    bad(blockedData());
  });
});

// ---------------------------------------------------------------------------
// Checkpoint format v2 — compact diagnostic ledger
// ---------------------------------------------------------------------------

/** Convenience: build a valid compact diagnostic entry. */
function diag(
  co: number,
  ro: number,
  reasonKey: keyof typeof EVAL_FAILURE_REASON_CODES,
): CheckpointDiagnosticFailure {
  return [co, ro, EVAL_FAILURE_REASON_CODES[reasonKey]];
}

describe("eval checkpoint — v4 format version enforcement", () => {
  it("the current on-disk format version is exactly 4", () => {
    expect(CHECKPOINT_FORMAT_VERSION).toBe(4);
  });

  it("REJECTS a v1 checkpoint (no migration path)", () => {
    const dir = tempDir();
    // A shape-legal v1 payload: everything except formatVersion=1, the missing
    // diagnosticFailures field, and the missing per-scenario ledger is
    // otherwise valid.
    const v1 = {
      formatVersion: 1,
      origin: ORIGIN,
      authMode: "password",
      corpusFingerprint: FP,
      resumeState: "resumable",
      abort: null,
      nextCaseIndex: 42,
      runSegments: 2,
      attemptedRounds: 42,
      completedRounds: 42,
      completedSingleRoundCases: 42,
      completedMultiStepScenarios: 0,
      cleanup: { attempted: 42, deleted: 42, failed: 0, journalFailures: 0 },
      gates: {
        expectedCall: { total: 42, schemaValid: 42, nameAccurate: 42, argValid: 42 },
        single: { total: 42, success: 42 },
        multi: { total: 0, success: 0 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
    };
    writeFileSync(file(dir), JSON.stringify(v1), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("REJECTS a v2 checkpoint (no migration path)", () => {
    const dir = tempDir();
    // A shape-legal v2 payload: everything except formatVersion=2 and the
    // absent per-scenario ledger (v2 predates it) is otherwise valid. A v2
    // checkpoint cannot be safely replayed under v4 accounting.
    const v2 = {
      formatVersion: 2,
      origin: ORIGIN,
      authMode: "password",
      corpusFingerprint: FP,
      resumeState: "resumable",
      abort: null,
      nextCaseIndex: 42,
      runSegments: 2,
      attemptedRounds: 42,
      completedRounds: 42,
      completedSingleRoundCases: 42,
      completedMultiStepScenarios: 0,
      cleanup: { attempted: 42, deleted: 42, failed: 0, journalFailures: 0 },
      gates: {
        expectedCall: { total: 42, schemaValid: 42, nameAccurate: 42, argValid: 42 },
        single: { total: 42, success: 42 },
        multi: { total: 0, success: 0 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
      diagnosticFailures: [],
    };
    writeFileSync(file(dir), JSON.stringify(v2), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("REJECTS a v3 checkpoint (no migration path)", () => {
    const dir = tempDir();
    // A shape-legal v3 payload: it carries the POSITIONAL
    // `executedScenarioRounds` integer ledger instead of v4's per-transition
    // `scenarioEvidence` tuples. v3's one-expected-tool-per-round-ordinal
    // accounting cannot be replayed under transition-based accounting, so the
    // reader refuses it outright rather than inventing missing step evidence.
    const v3 = {
      formatVersion: 3,
      origin: ORIGIN,
      authMode: "password",
      corpusFingerprint: FP,
      resumeState: "resumable",
      abort: null,
      nextCaseIndex: 42,
      runSegments: 2,
      attemptedRounds: 42,
      completedRounds: 42,
      completedSingleRoundCases: 42,
      completedMultiStepScenarios: 0,
      cleanup: { attempted: 42, deleted: 42, failed: 0, journalFailures: 0 },
      gates: {
        expectedCall: { total: 42, schemaValid: 42, nameAccurate: 42, argValid: 42 },
        single: { total: 42, success: 42 },
        multi: { total: 0, success: 0 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
      executedScenarioRounds: [],
      diagnosticFailures: [],
    };
    writeFileSync(file(dir), JSON.stringify(v3), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    // The same payload with a v4 version stamp is still refused: the v3 ledger
    // field is unknown to v4 and the v4 ledger field is absent.
    writeFileSync(file(dir), JSON.stringify({ ...v3, formatVersion: 4 }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("REJECTS an unknown future version", () => {
    const dir = tempDir();
    writeFileSync(file(dir), JSON.stringify({ ...data(), formatVersion: 99 }), { mode: 0o600 });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });
});

describe("eval checkpoint — v2 diagnostic ledger round-trip and shape validation", () => {
  it("round-trips an empty ledger", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data({ diagnosticFailures: [] }));
    expect(readCheckpoint(loc(dir), EXPECTED)?.diagnosticFailures).toEqual([]);
  });

  it("round-trips a compact ledger with every reason code represented", () => {
    const dir = tempDir();
    const entries: CheckpointDiagnosticFailure[] = [
      diag(1, 1, "expected-tool-returned-text"),
      diag(2, 1, "expected-tool-no-valid-call"),
      diag(3, 1, "expected-tool-unavailable"),
      diag(4, 1, "expected-tool-not-invoked"),
      diag(5, 1, "unauthorized-tool-call"),
      diag(6, 1, "transcript-invalid"),
      // Multi-step case ordinals: 201..220 (past plannedSingle=200).
      diag(201, 4, "unexpected-tool-call-on-final"),
      diag(202, 4, "final-no-valid-call"),
      diag(203, 4, "final-unavailable"),
    ];
    writeCheckpoint(loc(dir), data({ nextCaseIndex: 220, diagnosticFailures: entries }));
    const round = readCheckpoint(loc(dir), EXPECTED);
    expect(round?.diagnosticFailures).toEqual(entries);
  });

  it("REJECTS a duplicate (caseOrdinal, roundOrdinal) pair", () => {
    const dir = tempDir();
    const dupe = [
      diag(1, 1, "expected-tool-returned-text"),
      diag(1, 1, "expected-tool-no-valid-call"),
    ];
    expect(() => writeCheckpoint(loc(dir), data({ diagnosticFailures: dupe }))).toThrow();
    writeFileSync(file(dir), JSON.stringify({ ...data(), diagnosticFailures: dupe }), {
      mode: 0o600,
    });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("REJECTS an unknown reason code", () => {
    const dir = tempDir();
    writeFileSync(file(dir), JSON.stringify({ ...data(), diagnosticFailures: [[1, 1, 42]] }), {
      mode: 0o600,
    });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("REJECTS a non-triple entry, a non-integer ordinal, and out-of-range ordinals", () => {
    const dir = tempDir();
    for (const bad of [
      [[1, 1]], // arity-2
      [[1, 1, 1, 1]], // arity-4
      [[1.5, 1, 1]], // non-integer
      [[-1, 1, 1]], // negative
      [[0, 1, 1]], // zero (must be 1-based)
      [[1, 0, 1]], // zero round
    ]) {
      writeFileSync(file(dir), JSON.stringify({ ...data(), diagnosticFailures: bad }), {
        mode: 0o600,
      });
      expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("REJECTS a non-array diagnosticFailures", () => {
    const dir = tempDir();
    writeFileSync(file(dir), JSON.stringify({ ...data(), diagnosticFailures: null }), {
      mode: 0o600,
    });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("REJECTS a ledger exceeding the 280-entry cap", () => {
    const dir = tempDir();
    const over: CheckpointDiagnosticFailure[] = [];
    for (let i = 1; i <= MAX_DIAGNOSTIC_FAILURES + 1; i += 1) {
      over.push([i, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]);
    }
    expect(() => writeCheckpoint(loc(dir), data({ diagnosticFailures: over }))).toThrow();
    writeFileSync(file(dir), JSON.stringify({ ...data(), diagnosticFailures: over }), {
      mode: 0o600,
    });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
  });
});

describe("eval checkpoint — v4 scenarioEvidence ledger round-trip and shape validation", () => {
  it("round-trips an empty ledger", () => {
    const dir = tempDir();
    writeCheckpoint(loc(dir), data({ scenarioEvidence: [] }));
    expect(readCheckpoint(loc(dir), EXPECTED)?.scenarioEvidence).toEqual([]);
  });

  it("round-trips per-scenario evidence tuples unchanged", () => {
    const dir = tempDir();
    const entries: CheckpointScenarioEvidence[] = [
      successEvidence(4), // full budget, every transition satisfied
      successEvidence(3), // a parallel batch finished a round early
      successEvidence(2), // one batch completed all three transitions
      evidence(3, 2, { schemaAndArg: true, name: true }), // pending step fully evidenced
      evidence(2, 1, { schemaAndArg: true }), // pending step named wrongly
      evidence(1, 0), // nothing satisfied, nothing earned
    ];
    writeCheckpoint(loc(dir), data({ nextCaseIndex: 220, scenarioEvidence: entries }));
    expect(readCheckpoint(loc(dir), EXPECTED)?.scenarioEvidence).toEqual(entries);
  });

  it("REJECTS a non-array ledger and a non-quintuple entry", () => {
    const dir = tempDir();
    for (const badLedger of [
      null,
      { 0: [4, 3, 7, 7, 7] },
      [[4, 3, 7, 7]], // arity 4
      [[4, 3, 7, 7, 7, 7]], // arity 6
      [[4, 3, 7, 7, "7"]], // non-numeric element
      [4, 3, 7, 7, 7], // a bare tuple instead of a ledger of tuples
    ]) {
      writeFileSync(file(dir), JSON.stringify({ ...data(), scenarioEvidence: badLedger }), {
        mode: 0o600,
      });
      expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("REJECTS out-of-range executed-round, satisfied-step, and mask elements on disk", () => {
    const dir = tempDir();
    for (const badLedger of [
      [[0, 3, 7, 7, 7]], // a committed scenario always ran at least one round
      [[1.5, 3, 7, 7, 7]], // non-integer executed-round count
      [[4, -1, 0, 0, 0]], // negative satisfied-step count
      [[4, SCENARIO_STEP_COUNT + 1, 7, 7, 7]], // more satisfied steps than the workflow has
      [[4, 3, -1, 7, 7]], // negative mask
      [[4, 3, 1 << SCENARIO_STEP_COUNT, 7, 7]], // schema mask beyond the step space
      [[4, 3, 7, 1 << SCENARIO_STEP_COUNT, 7]], // name mask beyond the step space
      [[4, 3, 7, 7, 1 << SCENARIO_STEP_COUNT]], // argument mask beyond the step space
    ]) {
      writeFileSync(file(dir), JSON.stringify({ ...data(), scenarioEvidence: badLedger }), {
        mode: 0o600,
      });
      expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("REJECTS the same malformed ledgers on the WRITE path (no bypass via writeCheckpoint)", () => {
    const dir = tempDir();
    for (const badLedger of [
      [[4, 3, 7, 7]],
      [[0, 3, 7, 7, 7]],
      [[4, SCENARIO_STEP_COUNT + 1, 7, 7, 7]],
      [[4, 3, 1 << SCENARIO_STEP_COUNT, 7, 7]],
    ]) {
      expect(() =>
        writeCheckpoint(
          loc(dir),
          data({ scenarioEvidence: badLedger as unknown as CheckpointScenarioEvidence[] }),
        ),
      ).toThrow();
    }
    // A refused payload never lands, and never leaves a temp file behind.
    expect(readCheckpoint(loc(dir), EXPECTED)).toBeNull();
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("eval checkpoint — v2 semantic (corpus-bound) diagnostic validation", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("accepts a valid ledger that references only committed cases + real rounds", () => {
    // A truthful ledger under spec §30: each committed case has AT MOST ONE
    // primary diagnostic; a multi-step scenario's diagnostic is AT its
    // terminal round (`roundOrdinal == scenarioEvidence[k][0]`), and a
    // full-length scenario with a diagnostic terminated at its FINAL round.
    // cursor 219: 200 singles + 19 multi committed. Layout:
    //   - Single case 1   diagnosed `expected-tool-returned-text`.
    //   - Single case 200 diagnosed `expected-tool-no-valid-call`.
    //   - Multi case 201  ran full-length with every transition satisfied;
    //                     its FINAL round failed `final-unavailable`
    //                     (final-scope, so satisfiedSteps must be 3).
    //   - Multi case 219  terminated at round 2 with `unauthorized-tool-call`
    //                     (any-scope): one transition satisfied, and the
    //                     pending transition earned schema/argument evidence
    //                     but not expected-name evidence.
    //   - Multi case 210  terminated at round 3 with `transcript-invalid`
    //                     (expected-scope, so satisfiedSteps must be < 3): two
    //                     transitions satisfied, and the pending transition
    //                     earned schema, argument AND name evidence.
    //   - All 16 other multi scenarios ran full-length without a diagnostic.
    //
    // Numerator derivation (finding 1): singles contribute through the
    // per-round reason table, multi scenarios through their per-step masks.
    //   Singles: 198 pass (+1 schema/arg/name each), 2 fail with 0-contribution
    //     reasons → schema/arg/name = 198; single.success = 198.
    //   Multi (denominator is always the 3 PLANNED transitions per scenario):
    //     Case 201: masks 0b111 → +3 schema/arg/name. multi.success = 0.
    //     Case 219: masks 0b011 / 0b001 / 0b011 → +2 schema, +1 name, +2 arg.
    //     Case 210: masks 0b111 → +3 schema/arg/name. multi.success = 0.
    //     Other 16 cases: full success → +3 each. multi.success += 16.
    //   Total: 200 + 19*3 = 257 denom; schema/arg = 198 + 3 + 2 + 3 + 48 = 254;
    //     name = 198 + 3 + 1 + 3 + 48 = 253; multi.success = 16.
    //
    // Upstream-round floor: 200 singles + 17*4 full + 3 (case 210) + 2 (case
    // 219) = 200 + 68 + 5 = 273, derived by `validSeed` from the tuples.
    const scenarioEvidence: CheckpointScenarioEvidence[] = [
      ...Array.from({ length: 9 }, () => successEvidence(4)), // cases 201..209
      evidence(3, 2, { schemaAndArg: true, name: true }), // case 210
      ...Array.from({ length: 8 }, () => successEvidence(4)), // cases 211..218
      evidence(2, 1, { schemaAndArg: true }), // case 219
    ];
    ok(
      validSeed(220 - 1, {
        scenarioEvidence,
        diagnosticFailures: [
          diag(1, 1, "expected-tool-returned-text"),
          diag(200, 1, "expected-tool-no-valid-call"),
          diag(201, 4, "final-unavailable"),
          diag(210, 3, "transcript-invalid"),
          diag(219, 2, "unauthorized-tool-call"),
        ],
        gates: {
          expectedCall: {
            total: 200 + 19 * 3,
            schemaValid: 254,
            nameAccurate: 253,
            argValid: 254,
          },
          single: { total: 200, success: 198 },
          multi: { total: 19, success: 16 },
        },
      }),
    );
  });

  it("REJECTS a ledger entry referencing a case beyond nextCaseIndex", () => {
    bad(
      validSeed(5, {
        diagnosticFailures: [diag(6, 1, "expected-tool-returned-text")],
      }),
    );
  });

  it("REJECTS a ledger entry referencing a round that does not exist in the corpus", () => {
    // Single-round cases only have round 1; round 2 is out of range.
    bad(
      validSeed(5, {
        diagnosticFailures: [diag(3, 2, "expected-tool-returned-text")],
      }),
    );
    // Multi cases have 4 rounds; round 5 is out of range.
    bad(
      validSeed(205, {
        diagnosticFailures: [diag(201, 5, "final-unavailable")],
      }),
    );
  });

  it("REJECTS an expected-tool reason attributed to a final round", () => {
    // Multi case 201 round 4 is a FINAL round (no expectedTool) — an
    // `expected-tool-*` reason is structurally incompatible.
    bad(
      validSeed(205, {
        diagnosticFailures: [diag(201, 4, "expected-tool-returned-text")],
      }),
    );
  });

  it("REJECTS a final-round reason attributed to an expected-tool round", () => {
    // Multi case 201 round 1 IS an expected-tool round — a `final-*` reason is
    // structurally incompatible.
    bad(
      validSeed(205, {
        diagnosticFailures: [diag(201, 1, "final-unavailable")],
      }),
    );
    // Single-round cases are all expected-tool → same rejection.
    bad(
      validSeed(5, {
        diagnosticFailures: [diag(3, 1, "unexpected-tool-call-on-final")],
      }),
    );
  });

  it("accepts an `unauthorized-tool-call` on expected and final rounds respectively", () => {
    // The `unauthorized-tool-call` reason has scope `any` — it is compatible
    // with both an expected-tool round and a final round. The runner emits
    // AT MOST ONE primary diagnostic per case at its terminal round, so
    // separate `ok(...)` seeds cover the two round categories independently.
    // Single expected-tool round terminated with unauthorized-tool-call.
    ok(
      validSeed(205, {
        diagnosticFailures: [diag(3, 1, "unauthorized-tool-call")],
        // Single case 3 diag "unauthorized-tool-call" → +1 schemaValid/argValid,
        // +0 nameAccurate. single.success -= 1.
        gates: {
          expectedCall: {
            total: 200 + 5 * 3, // 215
            schemaValid: 199 + 5 * 3 + 1, // 215 (case 3 still schemaValid)
            nameAccurate: 199 + 5 * 3, // 214
            argValid: 199 + 5 * 3 + 1, // 215
          },
          single: { total: 200, success: 199 },
          multi: { total: 5, success: 5 },
        },
      }),
    );
    // Multi expected-tool round terminated with unauthorized-tool-call at
    // round 1 (case 201): NO transition succeeded, and the pending first
    // transition earned schema/argument evidence but not expected-name
    // evidence. The two unsatisfied transitions stay truthful misses.
    ok(
      validSeed(205, {
        scenarioEvidence: [
          evidence(1, 0, { schemaAndArg: true }),
          successEvidence(4),
          successEvidence(4),
          successEvidence(4),
          successEvidence(4),
        ],
        diagnosticFailures: [diag(201, 1, "unauthorized-tool-call")],
        gates: {
          expectedCall: {
            total: 200 + 5 * 3, // 215
            // Singles: +200 each. Case 201 masks 0b001 / 0b000 / 0b001.
            // Cases 202-205: full success (+3 each, +12 each).
            schemaValid: 200 + 1 + 12, // 213
            nameAccurate: 200 + 0 + 12, // 212
            argValid: 200 + 1 + 12, // 213
          },
          single: { total: 200, success: 200 },
          multi: { total: 5, success: 4 },
        },
      }),
    );
    // Multi FINAL round with unauthorized-tool-call (round 4 of case 201).
    // All 5 multi scenarios ran full-length. Case 201 loses multi.success.
    // No expectedCall contribution from a final-round diagnostic.
    ok(
      validSeed(205, {
        diagnosticFailures: [diag(201, 4, "unauthorized-tool-call")],
        gates: {
          expectedCall: {
            total: 200 + 5 * 3, // 215
            // All singles pass. All 5 multi scenarios pass rounds 1-3
            // (case 201 rounds 1-3 no diag; case 201 round 4 final has diag,
            // no expectedCall contribution).
            schemaValid: 200 + 5 * 3,
            nameAccurate: 200 + 5 * 3,
            argValid: 200 + 5 * 3,
          },
          single: { total: 200, success: 200 },
          multi: { total: 5, success: 4 },
        },
      }),
    );
  });
});

describe("eval checkpoint — v2 worst-case ledger fits within the 8 KiB bound", () => {
  it("a valid 280-entry ledger at maximum ordinals stays comfortably below MAX_CHECKPOINT_BYTES", () => {
    const dir = tempDir();
    // Build a valid 280-entry ledger: every single-round case (200) + every
    // multi-step round (20 × 4). Use the widest three-digit case ordinal (220)
    // and the highest single-digit reason code (9) as a worst-case guard.
    const worstEntries: CheckpointDiagnosticFailure[] = [];
    for (let co = 1; co <= 200; co += 1) {
      // Single-round expected reason.
      worstEntries.push([co, 1, EVAL_FAILURE_REASON_CODES["unauthorized-tool-call"]]);
    }
    for (let co = 201; co <= 220; co += 1) {
      for (let ro = 1; ro <= 3; ro += 1) {
        worstEntries.push([co, ro, EVAL_FAILURE_REASON_CODES["unauthorized-tool-call"]]);
      }
      worstEntries.push([co, 4, EVAL_FAILURE_REASON_CODES["unexpected-tool-call-on-final"]]);
    }
    expect(worstEntries).toHaveLength(MAX_DIAGNOSTIC_FAILURES);
    const worst = data({
      nextCaseIndex: 220,
      runSegments: 1,
      diagnosticFailures: worstEntries,
    });
    writeCheckpoint(loc(dir), worst);
    // Read it back so both write- and read-path bounds are exercised.
    const readBack = readCheckpoint(loc(dir), EXPECTED);
    expect(readBack?.diagnosticFailures).toHaveLength(MAX_DIAGNOSTIC_FAILURES);
    // Serialize and prove the on-disk payload is well under 8 KiB.
    const raw = statSync(file(dir)).size;
    expect(raw).toBeLessThanOrEqual(8192);
    expect(raw).toBeGreaterThan(0);
  });

  it("the MAXIMUM-valid-shape checkpoint (full cursor + full diagnostic + full evidence ledgers) fits the 8 KiB cap", () => {
    const dir = tempDir();
    // The largest legal on-disk shape for the production corpus:
    //   - the largest cursor (220 = the whole corpus);
    //   - a full 280-entry diagnostic ledger at the widest ordinals, every
    //     entry carrying the widest (two-digit) reason code;
    //   - a full 20-entry scenarioEvidence ledger at the widest tuple values
    //     (4 executed rounds, 3 satisfied steps, all three masks full).
    // Adding the v4 evidence ledger must not push the payload past the cap,
    // so this measures the REAL serialized length rather than eyeballing it.
    const widestCode = EVAL_FAILURE_REASON_CODES["scenario-round-budget-exhausted"];
    const worstEntries: CheckpointDiagnosticFailure[] = [];
    for (let co = 1; co <= 200; co += 1) worstEntries.push([co, 1, widestCode]);
    for (let co = 201; co <= 220; co += 1) {
      for (let ro = 1; ro <= 4; ro += 1) worstEntries.push([co, ro, widestCode]);
    }
    expect(worstEntries).toHaveLength(MAX_DIAGNOSTIC_FAILURES);
    const worstEvidence = Array.from({ length: 20 }, () => successEvidence(4));
    const worst = data({
      nextCaseIndex: 220,
      runSegments: 1,
      scenarioEvidence: worstEvidence,
      diagnosticFailures: worstEntries,
    });
    writeCheckpoint(loc(dir), worst);
    const readBack = readCheckpoint(loc(dir), EXPECTED);
    expect(readBack?.diagnosticFailures).toHaveLength(MAX_DIAGNOSTIC_FAILURES);
    expect(readBack?.scenarioEvidence).toEqual(worstEvidence);
    // Measured on-disk size of that maximum shape. It is asserted exactly so
    // any future field growth has to re-justify the 8 KiB budget rather than
    // silently consuming the remaining headroom.
    const raw = statSync(file(dir)).size;
    expect(raw).toBe(3899);
    expect(raw).toBeLessThanOrEqual(8192);
  });
});

describe("eval checkpoint — v2 rehydrate to report shape uses corpus, not checkpoint claims", () => {
  it("rebuilds phase and choiceKind from the fingerprint-bound corpus projection", () => {
    const entries: CheckpointDiagnosticFailure[] = [
      diag(1, 1, "expected-tool-returned-text"),
      diag(2, 1, "expected-tool-no-valid-call"),
      diag(3, 1, "expected-tool-no-valid-call"),
      diag(4, 1, "expected-tool-not-invoked"),
      diag(201, 4, "unexpected-tool-call-on-final"),
    ];
    const rehydrated = rehydrateDiagnosticFailures(entries, PROJECTION);
    expect(rehydrated).toEqual([
      {
        phase: "single",
        caseOrdinal: 1,
        roundOrdinal: 1,
        choiceKind: "auto",
        reason: "expected-tool-returned-text",
      },
      {
        phase: "single",
        caseOrdinal: 2,
        roundOrdinal: 1,
        choiceKind: "required",
        reason: "expected-tool-no-valid-call",
      },
      {
        phase: "single",
        caseOrdinal: 3,
        roundOrdinal: 1,
        choiceKind: "function",
        reason: "expected-tool-no-valid-call",
      },
      {
        phase: "single",
        caseOrdinal: 4,
        roundOrdinal: 1,
        choiceKind: "auto",
        reason: "expected-tool-not-invoked",
      },
      {
        phase: "multi",
        caseOrdinal: 201,
        roundOrdinal: 4,
        choiceKind: "auto",
        reason: "unexpected-tool-call-on-final",
      },
    ]);
  });

  it("a resumed segment reproduces every persisted diagnostic exactly once", () => {
    // The full resume path: validate → persist → read back → rehydrate. A
    // resumed final report re-emits each prior segment's diagnostics once, so
    // the rehydrated collection must match the persisted ledger entry-for-entry
    // with no duplicate (caseOrdinal, roundOrdinal) identity.
    const dir = tempDir();
    const entries: CheckpointDiagnosticFailure[] = [
      diag(1, 1, "expected-tool-returned-text"),
      diag(200, 1, "expected-tool-no-valid-call"),
      diag(201, 3, "transcript-invalid"),
      diag(202, 4, "final-unavailable"),
    ];
    const cp = validSeed(203, {
      scenarioEvidence: [
        evidence(3, 2, { schemaAndArg: true, name: true }), // 201 terminal transcript-invalid
        successEvidence(4), // 202 satisfied every transition, failed its final round
        successEvidence(4), // 203 fully successful
      ],
      diagnosticFailures: entries,
      gates: {
        expectedCall: {
          total: 200 + 3 * 3,
          // 198 passing singles + three fully-evidenced scenarios.
          schemaValid: 198 + 9,
          nameAccurate: 198 + 9,
          argValid: 198 + 9,
        },
        single: { total: 200, success: 198 },
        multi: { total: 3, success: 1 },
      },
    });
    validateResumableCheckpoint(cp, PROJECTION);
    writeCheckpoint(loc(dir), cp);
    const readBack = readCheckpoint(loc(dir), EXPECTED);
    expect(readBack?.diagnosticFailures).toEqual(entries);
    if (readBack === null) throw new Error("checkpoint missing");
    validateResumableCheckpoint(readBack, PROJECTION);
    const rehydrated = rehydrateDiagnosticFailures(readBack.diagnosticFailures, PROJECTION);
    expect(new Set(rehydrated.map((d) => `${d.caseOrdinal}:${d.roundOrdinal}`)).size).toBe(
      entries.length,
    );
    expect(rehydrated).toEqual([
      {
        phase: "single",
        caseOrdinal: 1,
        roundOrdinal: 1,
        choiceKind: "auto",
        reason: "expected-tool-returned-text",
      },
      {
        phase: "single",
        caseOrdinal: 200,
        roundOrdinal: 1,
        choiceKind: "required",
        reason: "expected-tool-no-valid-call",
      },
      {
        phase: "multi",
        caseOrdinal: 201,
        roundOrdinal: 3,
        choiceKind: "auto",
        reason: "transcript-invalid",
      },
      {
        phase: "multi",
        caseOrdinal: 202,
        roundOrdinal: 4,
        choiceKind: "auto",
        reason: "final-unavailable",
      },
    ]);
  });
});

describe("eval checkpoint — v2 serialized payload carries no content", () => {
  it("compact JSON encoding contains only counts, closed unions, and reason codes", () => {
    const dir = tempDir();
    const entries: CheckpointDiagnosticFailure[] = [
      diag(1, 1, "expected-tool-returned-text"),
      diag(201, 4, "unexpected-tool-call-on-final"),
    ];
    writeCheckpoint(loc(dir), data({ nextCaseIndex: 220, diagnosticFailures: entries }));
    // Read the raw on-disk bytes and scan for content leaks. Only fixed
    // structural keys and integers survive.
    const raw = readFileSync(file(dir), "utf8");
    for (const forbidden of [
      "read",
      "edit",
      "test",
      "claude",
      "call_ciq_",
      "gateway_protocol",
      "synthetic",
      "arguments",
      "path",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // Compact JSON: no indentation, no trailing whitespace beyond the newline.
    expect(raw.endsWith("\n")).toBe(true);
    // Reason codes appear as bare integers.
    expect(raw).toContain("[1,1,1]");
    expect(raw).toContain("[201,4,7]");
  });
});

// ---------------------------------------------------------------------------
// Finding 1 — Runtime-immutable reason-code lookup
// ---------------------------------------------------------------------------

/**
 * The pure `evalFailureReasonForCode` switch is the single trust source for
 * mapping a persisted numeric reason code back to its closed-union name. These
 * regressions prove it cannot be widened at runtime (unlike the previous
 * `ReadonlyMap` whose backing `Map` remained mutable): no consumer can force
 * an unknown code such as `42` into the allowlist, and every checkpoint parse
 * / semantic-validation / rehydrate path keeps rejecting it. The imports
 * remain a shared module reference so the tests must not permanently mutate
 * shared state — they only INTROSPECT the immutable lookup and observe that
 * mutation attempts are impossible.
 */
describe("eval failure reason lookup — Finding 1 immutability regression", () => {
  it("returns the fixed reason for every code in 1..10 (1..9 unchanged)", async () => {
    const { evalFailureReasonForCode } = await import("../../src/eval/report.js");
    expect(evalFailureReasonForCode(1)).toBe("expected-tool-returned-text");
    expect(evalFailureReasonForCode(2)).toBe("expected-tool-no-valid-call");
    expect(evalFailureReasonForCode(3)).toBe("expected-tool-unavailable");
    expect(evalFailureReasonForCode(4)).toBe("expected-tool-not-invoked");
    expect(evalFailureReasonForCode(5)).toBe("unauthorized-tool-call");
    expect(evalFailureReasonForCode(6)).toBe("transcript-invalid");
    expect(evalFailureReasonForCode(7)).toBe("unexpected-tool-call-on-final");
    expect(evalFailureReasonForCode(8)).toBe("final-no-valid-call");
    expect(evalFailureReasonForCode(9)).toBe("final-unavailable");
    // APPENDED for report v5; the nine codes above keep their exact meaning.
    expect(evalFailureReasonForCode(10)).toBe("scenario-round-budget-exhausted");
  });

  it("maps exactly ten reasons onto the unique codes 1..10, appending the scenario reason", () => {
    // The union is closed and the codes are stable: a new reason must be
    // APPENDED, never renumbered, because the on-disk ledger persists the
    // integers. Renumbering would silently reinterpret a recorded checkpoint.
    const entries = Object.entries(EVAL_FAILURE_REASON_CODES);
    expect(entries).toHaveLength(10);
    const codes = entries.map(([, code]) => code);
    expect(new Set(codes).size).toBe(10);
    expect([...codes].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Codes 1..9 keep their exact pre-v5 values.
    expect(EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]).toBe(1);
    expect(EVAL_FAILURE_REASON_CODES["expected-tool-no-valid-call"]).toBe(2);
    expect(EVAL_FAILURE_REASON_CODES["expected-tool-unavailable"]).toBe(3);
    expect(EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]).toBe(4);
    expect(EVAL_FAILURE_REASON_CODES["unauthorized-tool-call"]).toBe(5);
    expect(EVAL_FAILURE_REASON_CODES["transcript-invalid"]).toBe(6);
    expect(EVAL_FAILURE_REASON_CODES["unexpected-tool-call-on-final"]).toBe(7);
    expect(EVAL_FAILURE_REASON_CODES["final-no-valid-call"]).toBe(8);
    expect(EVAL_FAILURE_REASON_CODES["final-unavailable"]).toBe(9);
    // The appended tenth member.
    expect(EVAL_FAILURE_REASON_CODES["scenario-round-budget-exhausted"]).toBe(10);
  });

  it("rejects code 42 and every other out-of-range or non-integer value", async () => {
    const { evalFailureReasonForCode } = await import("../../src/eval/report.js");
    expect(evalFailureReasonForCode(0)).toBeUndefined();
    expect(evalFailureReasonForCode(11)).toBeUndefined();
    expect(evalFailureReasonForCode(42)).toBeUndefined();
    expect(evalFailureReasonForCode(-1)).toBeUndefined();
    expect(evalFailureReasonForCode(1.5)).toBeUndefined();
    expect(evalFailureReasonForCode(Number.NaN)).toBeUndefined();
    expect(evalFailureReasonForCode(Number.POSITIVE_INFINITY)).toBeUndefined();
    // A non-number input is rejected without throwing (the fn accepts unknown).
    expect(evalFailureReasonForCode("5")).toBeUndefined();
    expect(evalFailureReasonForCode(null)).toBeUndefined();
    expect(evalFailureReasonForCode(undefined)).toBeUndefined();
  });

  it("cannot be widened at runtime: no reachable mutation makes code 42 valid", async () => {
    // The trust source is the FUNCTION identity, not a container. The module
    // exports no writable structure we could set(42, ...) into: the reason
    // codes record is `Object.freeze`d and the reverse lookup is a pure
    // switch. This test enumerates every reachable export and proves no
    // mutation attempt lands, then re-confirms the lookup still rejects 42.
    const reportModule = await import("../../src/eval/report.js");
    const evalFailureReasonForCode = reportModule.evalFailureReasonForCode;

    // 1. There is NO `EVAL_FAILURE_REASON_BY_CODE` export any more. Its
    //    absence is a positive property: a hostile probe cannot `.set()` a
    //    container that does not exist.
    expect(
      (reportModule as Record<string, unknown>)["EVAL_FAILURE_REASON_BY_CODE"],
    ).toBeUndefined();

    // 2. The reason-code record is frozen and refuses runtime widening. Even
    //    if someone renumbers a code, `evalFailureReasonForCode(42)` remains
    //    undefined (the switch does not consult this record).
    expect(Object.isFrozen(reportModule.EVAL_FAILURE_REASON_CODES)).toBe(true);
    expect(() => {
      // Silently ignored in sloppy mode, throws in strict mode — either way
      // the map is not widened.
      const mutable = reportModule.EVAL_FAILURE_REASON_CODES as unknown as Record<string, number>;
      try {
        mutable["hostile"] = 42;
      } catch {
        // Frozen throws in strict mode; that's fine, the mutation failed.
      }
    }).not.toThrow();
    // A stray injected key is either absent (frozen refuses it) or does not
    // reach the switch — code 42 stays unmapped either way.
    expect(evalFailureReasonForCode(42)).toBeUndefined();

    // 3. The module namespace is a live, read-only binding by spec: a plain
    //    assignment cannot shadow the real export. Even under a hostile
    //    attempt the exported function keeps rejecting code 42.
    try {
      (reportModule as unknown as Record<string, unknown>)["evalFailureReasonForCode"] =
        (): "expected-tool-returned-text" => "expected-tool-returned-text";
    } catch {
      // ES modules throw in strict mode when a read-only export is reassigned;
      // that's fine, the export is untouched.
    }
    expect(reportModule.evalFailureReasonForCode(42)).toBeUndefined();
  });

  it("checkpoint read/parse and semantic validation continue to reject code 42", () => {
    const dir = tempDir();
    // A shape-legal on-disk file whose ledger references code 42. The parse
    // path in `readCheckpoint` must reject it; even if a hostile caller
    // bypassed the parser, the semantic validator does too.
    writeFileSync(file(dir), JSON.stringify({ ...data(), diagnosticFailures: [[1, 1, 42]] }), {
      mode: 0o600,
    });
    expect(() => readCheckpoint(loc(dir), EXPECTED)).toThrow();
    // Independent path: construct the equivalent `CheckpointData` in memory
    // (skipping the parser) and prove the semantic validator still rejects.
    const forged = {
      ...data(),
      diagnosticFailures: [[1, 1, 42] as CheckpointDiagnosticFailure],
    };
    expect(() => validateResumableCheckpoint(forged, PROJECTION)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — Bind diagnostics to the ACTUAL corpus projection
// ---------------------------------------------------------------------------

/**
 * A synthetic, non-uniform projection whose aggregate counts (plannedSingle=1,
 * plannedMulti=3, expectedCallsPerScenario=2, maxRoundsPerCase=5) COULD map to
 * a uniform "2 tool steps + 3 finals" layout, but whose ACTUAL per-round
 * `hasExpectedTool` layout is deliberately non-monotonic: expected/final
 * rounds interleave, and case 3 is SHORTER than maxRoundsPerCase. A validator
 * that infers `first N rounds are expected` from the aggregate numbers would
 * happily accept or reject the wrong ordinals; the corpus-bound projection
 * (finding 2) uses `projection.cases[i].rounds[j]` directly and therefore
 * honors the ACTUAL layout.
 *
 * Corpus layout (length = 4, so a resumable cursor 0..3 is legal):
 *   case 1 (single) : round 1 = expected (auto)
 *   case 2 (multi)  : round 1 expected(auto), round 2 FINAL(required),
 *                     round 3 expected(function), round 4 FINAL(auto),
 *                     round 5 FINAL(required)                     — 5 rounds
 *   case 3 (multi)  : round 1 expected(function), round 2 FINAL(auto),
 *                     round 3 expected(required)                  — 3 rounds
 *   case 4 (multi)  : padding scenario so `length > cursor`; four rounds with
 *                     the same expected/final layout as case 2's first four
 *                     (rounds 1,3 expected — matches expectedCallsPerScenario=2)
 *
 * Aggregates: single=1, multi=3, expectedCallsPerScenario=2, maxRoundsPerCase=5.
 */
const NONUNIFORM_PROJECTION: EvalCorpusProjection = Object.freeze({
  plannedSingle: 1,
  plannedMulti: 3,
  expectedCallsPerScenario: 2,
  maxRoundsPerCase: 5,
  cases: Object.freeze([
    Object.freeze({
      phase: "single" as const,
      rounds: Object.freeze([
        Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: true }),
      ]),
    }),
    Object.freeze({
      phase: "multi" as const,
      rounds: Object.freeze([
        Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: true }),
        Object.freeze({ choiceKind: "required" as const, hasExpectedTool: false }),
        Object.freeze({ choiceKind: "function" as const, hasExpectedTool: true }),
        Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: false }),
        Object.freeze({ choiceKind: "required" as const, hasExpectedTool: false }),
      ]),
    }),
    Object.freeze({
      phase: "multi" as const,
      rounds: Object.freeze([
        Object.freeze({ choiceKind: "function" as const, hasExpectedTool: true }),
        Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: false }),
        Object.freeze({ choiceKind: "required" as const, hasExpectedTool: true }),
      ]),
    }),
    Object.freeze({
      phase: "multi" as const,
      rounds: Object.freeze([
        Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: true }),
        Object.freeze({ choiceKind: "required" as const, hasExpectedTool: false }),
        Object.freeze({ choiceKind: "function" as const, hasExpectedTool: true }),
        Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: false }),
      ]),
    }),
  ]),
});

/** Every multi-step case in {@link NONUNIFORM_PROJECTION} plans exactly two transitions. */
const NONUNIFORM_PLANNED_STEPS = 2;

/**
 * Build a truthful evidence tuple for a {@link NONUNIFORM_PROJECTION} scenario.
 * Mirrors {@link evidence}, but against that projection's TWO planned
 * transitions rather than the production corpus's three, so a mask never
 * carries a bit outside the case's own planned step count.
 */
function nonUniformEvidence(
  executed: number,
  satisfied: number = NONUNIFORM_PLANNED_STEPS,
  pendingEvidence: { schemaAndArg?: boolean; name?: boolean } = {},
): CheckpointScenarioEvidence {
  const prefix = satisfied <= 0 ? 0 : (1 << satisfied) - 1;
  const pendingBit = satisfied < NONUNIFORM_PLANNED_STEPS ? 1 << satisfied : 0;
  const schemaArgBit = pendingEvidence.schemaAndArg === true ? pendingBit : 0;
  const nameBit = pendingEvidence.name === true ? pendingBit : 0;
  return [executed, satisfied, prefix | schemaArgBit, prefix | nameBit, prefix | schemaArgBit];
}

/**
 * Build a semantically-VALID resumable seed for a NON-UNIFORM projection at
 * `cursor` (0-based case index). Committed upstream rounds sum the ACTUAL
 * per-case executed-round evidence (never `single + multi * maxRoundsPerCase`);
 * gate denominators sum the ACTUAL per-case `hasExpectedTool` counts, which is
 * also each scenario's planned transition count.
 */
function nonUniformSeed(cursor: number, over: Partial<CheckpointData> = {}): CheckpointData {
  let committedSingle = 0;
  let committedMulti = 0;
  let expectedRounds = 0;
  const fullyExecuted: CheckpointScenarioEvidence[] = [];
  for (let i = 0; i < cursor; i += 1) {
    const c = NONUNIFORM_PROJECTION.cases[i];
    if (c === undefined) break;
    if (c.phase === "single") committedSingle += 1;
    else {
      committedMulti += 1;
      // The full scenario ran to completion with every transition satisfied.
      fullyExecuted.push(nonUniformEvidence(c.rounds.length));
    }
    for (const r of c.rounds) if (r.hasExpectedTool) expectedRounds += 1;
  }
  const scenarioEvidence = over.scenarioEvidence ?? fullyExecuted;
  const upstreamRounds =
    committedSingle + scenarioEvidence.reduce((sum, [executed]) => sum + executed, 0);
  const invariantsOverride = over.invariants;
  const built = data({
    nextCaseIndex: cursor,
    completedSingleRoundCases: committedSingle,
    completedMultiStepScenarios: committedMulti,
    attemptedRounds: upstreamRounds,
    completedRounds: upstreamRounds,
    cleanup: {
      attempted: upstreamRounds,
      deleted: upstreamRounds,
      failed: 0,
      journalFailures: 0,
    },
    gates: {
      expectedCall: {
        total: expectedRounds,
        schemaValid: expectedRounds,
        nameAccurate: expectedRounds,
        argValid: expectedRounds,
      },
      single: { total: committedSingle, success: committedSingle },
      multi: { total: committedMulti, success: committedMulti },
    },
    scenarioEvidence,
    runSegments: 1,
    ...over,
  });
  return withDerivedInvariants(built, NONUNIFORM_PROJECTION, invariantsOverride);
}

describe("eval checkpoint — Finding 2: non-uniform corpus projection", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, NONUNIFORM_PROJECTION);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, NONUNIFORM_PROJECTION)).toThrow();

  it("accepts expected-tool reasons attributed to the ACTUAL expected rounds", () => {
    // Multi case 2 has expected rounds at ordinals 1 and 3 — NOT "first 2
    // rounds", so an aggregate inference would misattribute a diagnostic
    // reason. A scenario terminates at its FIRST failure, so this test
    // exercises two independent ok() cases with a SINGLE terminal diagnostic
    // each, placed at the real expected round the reason targets.
    // Terminated at case 2 round 1 with `expected-tool-returned-text`: no
    // transition satisfied and the pending one earned nothing.
    ok(
      nonUniformSeed(3, {
        scenarioEvidence: [nonUniformEvidence(1, 0), nonUniformEvidence(3)],
        diagnosticFailures: [[2, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
        gates: {
          expectedCall: {
            // Denom: single (1) + case 2 (2 planned transitions) + case 3 (2) = 5.
            total: 5,
            // Case 1 (single) +1 each. Case 2 masks 0b00 → +0 each. Case 3
            // fully satisfied → +2 each.
            schemaValid: 1 + 0 + 2,
            nameAccurate: 1 + 0 + 2,
            argValid: 1 + 0 + 2,
          },
          single: { total: 1, success: 1 },
          multi: { total: 2, success: 1 },
        },
      }),
    );
    // Terminated at case 2 round 3 with `expected-tool-no-valid-call` — round
    // 3 is an EXPECTED round, not a "third round is final" position. Its first
    // transition succeeded; the pending second one earned nothing.
    ok(
      nonUniformSeed(3, {
        scenarioEvidence: [nonUniformEvidence(3, 1), nonUniformEvidence(3)],
        diagnosticFailures: [[2, 3, EVAL_FAILURE_REASON_CODES["expected-tool-no-valid-call"]]],
        gates: {
          expectedCall: {
            total: 5,
            // Case 1 +1 each. Case 2 masks 0b01 → +1 each. Case 3 +2 each.
            schemaValid: 1 + 1 + 2,
            nameAccurate: 1 + 1 + 2,
            argValid: 1 + 1 + 2,
          },
          single: { total: 1, success: 1 },
          multi: { total: 2, success: 1 },
        },
      }),
    );
  });

  it("REJECTS an expected-tool reason attributed to an ACTUAL final round", () => {
    // Round 2 of multi case 2 is a FINAL round in the non-uniform corpus. An
    // aggregate `first N rounds are expected` inference would accept it; the
    // projection-bound validator rejects it.
    bad(
      nonUniformSeed(3, {
        diagnosticFailures: [[2, 2, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
      }),
    );
    // Round 3 of multi case 3 is EXPECTED, and round 2 is FINAL — an aggregate
    // inference would say the opposite.
    bad(
      nonUniformSeed(3, {
        diagnosticFailures: [[3, 2, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]]],
      }),
    );
    // But the ACTUAL expected round (3, 3) accepts an expected-tool reason.
    // Round 3 is case 3's LAST round, so the scenario ran all three of its
    // rounds; an `expected`-scope reason additionally requires a still-pending
    // transition, so case 3 satisfied only its first and its pending second
    // transition earned schema/argument evidence but no expected-name credit.
    ok(
      nonUniformSeed(3, {
        scenarioEvidence: [nonUniformEvidence(5), nonUniformEvidence(3, 1, { schemaAndArg: true })],
        diagnosticFailures: [[3, 3, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]]],
        gates: {
          expectedCall: {
            total: 5,
            // Case 1 +1 each. Case 2 full +2 each. Case 3 masks 0b11 / 0b01 /
            // 0b11 → +2 schema, +1 name, +2 arg.
            schemaValid: 1 + 2 + 2,
            nameAccurate: 1 + 2 + 1,
            argValid: 1 + 2 + 2,
          },
          single: { total: 1, success: 1 },
          multi: { total: 2, success: 1 },
        },
      }),
    );
  });

  it("REJECTS a final-round reason attributed to an ACTUAL expected round", () => {
    // Round 1 of multi case 2 is EXPECTED. `final-*` reasons are incompatible.
    bad(
      nonUniformSeed(3, {
        diagnosticFailures: [[2, 1, EVAL_FAILURE_REASON_CODES["final-unavailable"]]],
      }),
    );
    // Round 4 of multi case 2 is FINAL — `final-*` reasons are compatible.
    // A scenario terminates at its diagnostic round, so executed=4 here, and a
    // `final`-scope reason additionally requires EVERY transition satisfied.
    ok(
      nonUniformSeed(3, {
        scenarioEvidence: [nonUniformEvidence(4), nonUniformEvidence(3)],
        diagnosticFailures: [[2, 4, EVAL_FAILURE_REASON_CODES["final-unavailable"]]],
        gates: {
          expectedCall: {
            total: 5,
            // Case 1 +1 each. Case 2 satisfied both transitions → +2 each; the
            // failed FINAL round contributes no transition evidence. Case 3
            // full +2 each.
            schemaValid: 1 + 2 + 2,
            nameAccurate: 1 + 2 + 2,
            argValid: 1 + 2 + 2,
          },
          single: { total: 1, success: 1 },
          multi: { total: 2, success: 1 },
        },
      }),
    );
  });

  it("uses ACTUAL round counts, not maxRoundsPerCase, per case", () => {
    // Multi case 3 has ONLY 3 rounds; round 4 does not exist even though
    // maxRoundsPerCase = 5. An aggregate inference would accept it.
    bad(
      nonUniformSeed(3, {
        diagnosticFailures: [[3, 4, EVAL_FAILURE_REASON_CODES["final-unavailable"]]],
      }),
    );
    // Round 5 of multi case 2 exists (it is the FIFTH round of that case).
    // Case 2 runs full-length; round 5 (its terminal round) carries a
    // `final-no-valid-call` diagnostic — compatible with a final round.
    ok(
      nonUniformSeed(3, {
        diagnosticFailures: [[2, 5, EVAL_FAILURE_REASON_CODES["final-no-valid-call"]]],
        gates: {
          expectedCall: {
            // Case 2 rounds 1, 3 no diag +2 each; round 5 is final (no
            // expectedCall contribution). Case 3 full +2 each. Case 1 +1.
            total: 5,
            schemaValid: 5,
            nameAccurate: 5,
            argValid: 5,
          },
          single: { total: 1, success: 1 },
          multi: { total: 2, success: 1 },
        },
      }),
    );
  });

  it("still rejects references beyond nextCaseIndex", () => {
    bad(
      nonUniformSeed(1, {
        diagnosticFailures: [[2, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
      }),
    );
  });

  it("derives phase and choiceKind from the actual case/round, not aggregate position", () => {
    const entries: CheckpointDiagnosticFailure[] = [
      [1, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]],
      [2, 1, EVAL_FAILURE_REASON_CODES["expected-tool-no-valid-call"]],
      [2, 3, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]],
      [2, 4, EVAL_FAILURE_REASON_CODES["unexpected-tool-call-on-final"]],
      [3, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]],
    ];
    const rehydrated = rehydrateDiagnosticFailures(entries, NONUNIFORM_PROJECTION);
    expect(rehydrated).toEqual([
      {
        phase: "single",
        caseOrdinal: 1,
        roundOrdinal: 1,
        choiceKind: "auto",
        reason: "expected-tool-returned-text",
      },
      {
        phase: "multi",
        caseOrdinal: 2,
        roundOrdinal: 1,
        choiceKind: "auto",
        reason: "expected-tool-no-valid-call",
      },
      {
        phase: "multi",
        caseOrdinal: 2,
        roundOrdinal: 3,
        choiceKind: "function",
        reason: "expected-tool-not-invoked",
      },
      {
        phase: "multi",
        caseOrdinal: 2,
        roundOrdinal: 4,
        choiceKind: "auto",
        reason: "unexpected-tool-call-on-final",
      },
      {
        phase: "multi",
        caseOrdinal: 3,
        roundOrdinal: 1,
        choiceKind: "function",
        reason: "expected-tool-returned-text",
      },
    ]);
  });
});

describe("eval checkpoint — Finding 2: rehydrate fails closed on impossible entries", () => {
  it("throws on an unknown reason code (never silently drops)", () => {
    expect(() =>
      rehydrateDiagnosticFailures([[1, 1, 42] as CheckpointDiagnosticFailure], PROJECTION),
    ).toThrow();
  });

  it("throws on a caseOrdinal beyond the projection (never silently drops)", () => {
    expect(() =>
      rehydrateDiagnosticFailures(
        [[9999, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
        PROJECTION,
      ),
    ).toThrow();
  });

  it("throws on a roundOrdinal beyond that case (never silently drops)", () => {
    // Single-round cases only have round 1.
    expect(() =>
      rehydrateDiagnosticFailures(
        [[3, 2, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
        PROJECTION,
      ),
    ).toThrow();
  });

  it("throws when the projected round's choiceKind is 'none' (fails closed)", () => {
    // The synthetic corpus never uses `"none"`, but a hostile ledger paired
    // with a corrupt projection must not silently be relabeled to `"auto"`.
    const noneProjection: EvalCorpusProjection = Object.freeze({
      plannedSingle: 1,
      plannedMulti: 0,
      expectedCallsPerScenario: 0,
      maxRoundsPerCase: 1,
      cases: Object.freeze([
        Object.freeze({
          phase: "single" as const,
          rounds: Object.freeze([
            Object.freeze({
              choiceKind: "none" as unknown as "auto",
              hasExpectedTool: true,
            }),
          ]),
        }),
      ]),
    });
    expect(() =>
      rehydrateDiagnosticFailures(
        [[1, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
        noneProjection,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// New Finding 1 — the executed evaluator derives fingerprint / plan /
// projection / case-loop from ONE exact `EvalCase[]` value. `buildEvalCases()`
// and the two `...(cases?)` helpers here are the same functions the executed
// path uses (`corpusFingerprint(cases)`, `evalPlan(cases)`, and
// `buildEvalCorpusProjection(cases)`); the tests below prove the four
// consumers can share one supplied corpus AND that the production values
// remain byte-for-byte stable.
// ---------------------------------------------------------------------------

describe("eval corpus — Finding 1: one exact fingerprint-bound corpus drives every derivation", () => {
  it("corpusFingerprint(cases) and evalPlan(cases) accept a supplied array and preserve zero-arg semantics", () => {
    const cases = buildEvalCases();
    // Zero-arg and one-arg forms agree on the SAME corpus.
    const suppliedFp = corpusFingerprint(cases);
    const zeroArgFp = corpusFingerprint();
    expect(suppliedFp).toBe(zeroArgFp);
    expect(suppliedFp).toMatch(/^[0-9a-f]{64}$/);
    const suppliedPlan = evalPlan(cases);
    const zeroArgPlan = evalPlan();
    expect(suppliedPlan).toEqual(zeroArgPlan);
    // Production denominators unchanged: 200 singles + 20 scenarios × (3
    // expected + 1 final) = 280 upstream rounds, 260 expected-call rounds.
    expect(zeroArgPlan.plannedUpstreamRounds).toBe(280);
    expect(zeroArgPlan.expectedCall).toBe(260);
    expect(zeroArgPlan.single).toBe(200);
    expect(zeroArgPlan.multi).toBe(20);
    expect(zeroArgPlan.expectedCallsPerScenario).toBe(3);
    expect(zeroArgPlan.maxRoundsPerCase).toBe(4);
  });

  it("all four derivations (fingerprint, plan, projection, iteration) agree on the SAME supplied corpus", () => {
    const cases = buildEvalCases();
    const fingerprint = corpusFingerprint(cases);
    const plan = evalPlan(cases);
    const projection = buildEvalCorpusProjection(cases);
    // Projection aggregates match the plan (both derived from the same
    // supplied `cases` array).
    expect(projection.plannedSingle).toBe(plan.single);
    expect(projection.plannedMulti).toBe(plan.multi);
    expect(projection.expectedCallsPerScenario).toBe(plan.expectedCallsPerScenario);
    expect(projection.maxRoundsPerCase).toBe(plan.maxRoundsPerCase);
    // Per-round layout mirrors the supplied cases exactly.
    expect(projection.cases).toHaveLength(cases.length);
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      const p = projection.cases[i];
      if (c === undefined || p === undefined) throw new Error("index out of range");
      expect(p.phase).toBe(c.rounds.length > 1 ? "multi" : "single");
      expect(p.rounds).toHaveLength(c.rounds.length);
      for (let r = 0; r < c.rounds.length; r += 1) {
        const cr = c.rounds[r];
        const pr = p.rounds[r];
        if (cr === undefined || pr === undefined) throw new Error("round index out of range");
        expect(pr.choiceKind).toBe(cr.choice.kind);
        expect(pr.hasExpectedTool).toBe(cr.expectedTool !== undefined);
      }
    }
    // A resumable checkpoint that carries this fingerprint validates against
    // the projection derived from the SAME supplied corpus.
    const fresh: CheckpointData = {
      formatVersion: CHECKPOINT_FORMAT_VERSION,
      origin: ORIGIN,
      authMode: "password",
      corpusFingerprint: fingerprint,
      resumeState: "resumable",
      abort: null,
      nextCaseIndex: 0,
      runSegments: 1,
      attemptedRounds: 0,
      completedRounds: 0,
      completedSingleRoundCases: 0,
      completedMultiStepScenarios: 0,
      cleanup: { attempted: 0, deleted: 0, failed: 0, journalFailures: 0 },
      gates: {
        expectedCall: { total: 0, schemaValid: 0, nameAccurate: 0, argValid: 0 },
        single: { total: 0, success: 0 },
        multi: { total: 0, success: 0 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
      scenarioEvidence: [],
      diagnosticFailures: [],
    };
    expect(() => validateResumableCheckpoint(fresh, projection)).not.toThrow();
  });

  it("a supplied non-uniform corpus drives plan/projection from THAT array, not a hidden rebuilt production corpus", () => {
    // Synthetic corpus: 2 singles + 1 three-round scenario. The plan and
    // projection MUST reflect the supplied cases, not the production defaults
    // (200 singles / 20 scenarios / 4 rounds).
    const nonuniform: readonly EvalCase[] = Object.freeze([
      Object.freeze({
        tools: Object.freeze([]),
        selectedLlms: Object.freeze([]),
        rounds: Object.freeze([
          Object.freeze({ choice: { kind: "auto" as const }, prompt: "s1", expectedTool: "read" }),
        ]),
      }),
      Object.freeze({
        tools: Object.freeze([]),
        selectedLlms: Object.freeze([]),
        rounds: Object.freeze([
          Object.freeze({
            choice: { kind: "required" as const },
            prompt: "s2",
            expectedTool: "read",
          }),
        ]),
      }),
      Object.freeze({
        tools: Object.freeze([]),
        selectedLlms: Object.freeze([]),
        rounds: Object.freeze([
          Object.freeze({ choice: { kind: "auto" as const }, prompt: "m1", expectedTool: "read" }),
          Object.freeze({
            choice: { kind: "function" as const, name: "edit" },
            prompt: "m2",
            expectedTool: "edit",
          }),
          Object.freeze({ choice: { kind: "auto" as const }, prompt: "m3" }),
        ]),
      }),
    ]);
    const plan = evalPlan(nonuniform);
    expect(plan.plannedUpstreamRounds).toBe(5);
    expect(plan.expectedCall).toBe(4); // 2 singles + 2 tool steps in the scenario
    expect(plan.single).toBe(2);
    expect(plan.multi).toBe(1);
    expect(plan.expectedCallsPerScenario).toBe(2);
    expect(plan.maxRoundsPerCase).toBe(3);
    const projection = buildEvalCorpusProjection(nonuniform);
    expect(projection.plannedSingle).toBe(2);
    expect(projection.plannedMulti).toBe(1);
    expect(projection.expectedCallsPerScenario).toBe(2);
    expect(projection.maxRoundsPerCase).toBe(3);
    // Per-round choiceKind is copied verbatim from the supplied array.
    expect(projection.cases[0]?.rounds[0]?.choiceKind).toBe("auto");
    expect(projection.cases[1]?.rounds[0]?.choiceKind).toBe("required");
    expect(projection.cases[2]?.rounds[1]?.choiceKind).toBe("function");
    // A different supplied fingerprint from the production one is expected.
    expect(corpusFingerprint(nonuniform)).not.toBe(corpusFingerprint());
    // And the fingerprints are content-free hex digests, so nothing about the
    // synthetic prompts survives.
    for (const fp of [corpusFingerprint(nonuniform), corpusFingerprint()]) {
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the production fingerprint and denominators are byte-for-byte stable across the refactor", () => {
    // Guardrail: an accidental change to production `buildEvalCases()` would
    // flip the fingerprint and break every recorded resumable checkpoint.
    expect(corpusFingerprint()).toBe(corpusFingerprint(buildEvalCases()));
    expect(evalPlan()).toEqual(evalPlan(buildEvalCases()));
  });
});

// ---------------------------------------------------------------------------
// New Finding 2 — `"none"` fails closed at projection build time AND at
// checkpoint validation time. There is no `narrowChoiceKind` fallback path
// in the diagnostic constructors; a corpus containing `"none"` refuses to
// enter the pipeline BEFORE any credential read or network I/O.
// ---------------------------------------------------------------------------

describe("eval corpus projection — Finding 2: rejects unsupported choice kinds at build", () => {
  it("throws when a supplied single-round case has choice.kind === 'none'", () => {
    const nonesCorpus: readonly EvalCase[] = [
      {
        tools: [],
        selectedLlms: [],
        rounds: [{ choice: { kind: "none" as const }, prompt: "p", expectedTool: "read" }],
      },
    ];
    expect(() => buildEvalCorpusProjection(nonesCorpus)).toThrow();
  });

  it("throws when a supplied multi-step scenario contains a 'none' round", () => {
    const nonesCorpus: readonly EvalCase[] = [
      {
        tools: [],
        selectedLlms: [],
        rounds: [
          { choice: { kind: "auto" as const }, prompt: "r1", expectedTool: "read" },
          { choice: { kind: "none" as const }, prompt: "r2", expectedTool: "edit" },
          { choice: { kind: "auto" as const }, prompt: "r3" },
        ],
      },
    ];
    expect(() => buildEvalCorpusProjection(nonesCorpus)).toThrow();
  });

  it("accepts every supported choice kind ('auto' | 'required' | 'function') without complaint", () => {
    const supportedCorpus: readonly EvalCase[] = [
      {
        tools: [],
        selectedLlms: [],
        rounds: [{ choice: { kind: "auto" as const }, prompt: "s", expectedTool: "read" }],
      },
      {
        tools: [],
        selectedLlms: [],
        rounds: [{ choice: { kind: "required" as const }, prompt: "s", expectedTool: "read" }],
      },
      {
        tools: [],
        selectedLlms: [],
        rounds: [
          {
            choice: { kind: "function" as const, name: "read" },
            prompt: "s",
            expectedTool: "read",
          },
        ],
      },
    ];
    const projection = buildEvalCorpusProjection(supportedCorpus);
    expect(projection.cases.map((c) => c.rounds[0]?.choiceKind)).toEqual([
      "auto",
      "required",
      "function",
    ]);
  });

  it("the production corpus is fingerprinted with only supported choice kinds", () => {
    const projection = buildEvalCorpusProjection(buildEvalCases());
    for (const projectedCase of projection.cases) {
      for (const projectedRound of projectedCase.rounds) {
        expect(["auto", "required", "function"]).toContain(projectedRound.choiceKind);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 1 remediation — checkpoint gate metrics must be semantically tied
// to actual per-case executed evidence (per-scenario executed-round ledger +
// per-round diagnostic ledger + corpus projection). These regressions cover
// the two independently-reproduced forgeries and the required additional
// cases from the review.
// ---------------------------------------------------------------------------

describe("eval checkpoint — Finding 1 remediation: forged gate metrics are rejected", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("REJECTS a forged '19 one-round multi ledgers + all-success + perfect numerators' checkpoint (reproduced forgery)", () => {
    // The exact forgery reproduced by the review: 200 committed single-round
    // cases + 19 committed multi-step scenarios; every scenario claims a
    // one-round full success (scenarios stopped after their first upstream
    // round); NO diagnostics; perfect expected-call numerators as though every
    // planned transition succeeded; and all 19 multi scenarios marked
    // successful. The pre-fix validator accepted it because it checked
    // numerators only against denominators and did not correlate the ledger
    // with the diagnostic ledger. Under state-aware accounting a
    // diagnostic-free scenario must also have had room for its final-answer
    // round (MIN_SUCCESSFUL_SCENARIO_ROUNDS = 2), so one round can never
    // encode a success.
    const forged = validSeed(219, {
      scenarioEvidence: Array.from({ length: 19 }, () => successEvidence(1)),
      diagnosticFailures: [],
      gates: {
        expectedCall: {
          total: 200 + 19 * 3, // 257 (planned expected calls)
          schemaValid: 200 + 19 * 3, // forged: claims every planned round passed
          nameAccurate: 200 + 19 * 3,
          argValid: 200 + 19 * 3,
        },
        single: { total: 200, success: 200 },
        multi: { total: 19, success: 19 }, // forged: claims every scenario passed
      },
    });
    bad(forged);
  });

  it("REJECTS multi.success = 1 for an early-terminated scenario", () => {
    // Case 201 terminated at round 2 with a terminal diagnostic. `multi.success`
    // cannot count this scenario — the derived multi.success is 0, so a
    // claimed 1 is rejected as impossible.
    const forged = validSeed(201, {
      scenarioEvidence: [evidence(2, 1, { schemaAndArg: true })],
      diagnosticFailures: [[201, 2, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]]],
      gates: {
        expectedCall: {
          total: 200 + 3,
          // Case 201 satisfied its first transition; the pending one earned
          // schema/argument evidence but no expected-name credit, and the
          // third transition never ran → masks 0b011 / 0b001 / 0b011.
          schemaValid: 200 + 2,
          nameAccurate: 200 + 1,
          argValid: 200 + 2,
        },
        single: { total: 200, success: 200 },
        multi: { total: 1, success: 1 }, // FORGED
      },
    });
    bad(forged);
  });

  it("REJECTS counting a diagnosed full-length scenario in multi.success", () => {
    // Case 201 ran its whole budget and satisfied every transition, but its
    // FINAL round failed. A terminal diagnostic — at any round, for any
    // reason — disqualifies the scenario from `multi.success`, so the
    // `validSeed` default of 1 is a forgery here.
    bad(
      validSeed(201, {
        diagnosticFailures: [diag(201, 4, "final-unavailable")],
      }),
    );
  });

  it("REJECTS a diagnostic that references an UNEXECUTED round of a committed scenario", () => {
    // Case 201 terminated at round 2 (executed=2), but the ledger claims a
    // diagnostic at round 3 — a round that was never executed. The runner
    // never emits a diagnostic for a round it did not run; this pattern is
    // structurally impossible.
    const forged = validSeed(201, {
      scenarioEvidence: [evidence(2, 1)],
      diagnosticFailures: [[201, 3, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
    });
    bad(forged);
  });

  it("REJECTS expected-call numerators exceeding evidence from executed expected-tool rounds", () => {
    // Case 201 terminated at round 1 with `expected-tool-returned-text`
    // (decision.kind = "text") — no transition succeeded and the pending one
    // earned no evidence, so every mask is empty and the only truthful multi
    // contribution is 0 across the board. Any positive multi contribution to
    // schema/arg/name is a forgery.
    const forged = validSeed(201, {
      scenarioEvidence: [evidence(1, 0)],
      diagnosticFailures: [[201, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
      gates: {
        expectedCall: {
          total: 200 + 3,
          // FORGED: claims multi contributed 3 schemaValid; the truthful
          // value is 0.
          schemaValid: 200 + 3,
          nameAccurate: 200 + 0,
          argValid: 200 + 0,
        },
        single: { total: 200, success: 200 },
        multi: { total: 1, success: 0 },
      },
    });
    bad(forged);
  });

  it("REJECTS two diagnostics for one committed case (a scenario terminates at its FIRST failure)", () => {
    // A committed multi-step scenario has AT MOST one primary diagnostic —
    // the runner terminates at its first failure, so no cascade or duplicate
    // ever reaches the ledger.
    const forged = validSeed(205, {
      diagnosticFailures: [
        [201, 1, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]],
        [201, 4, EVAL_FAILURE_REASON_CODES["final-unavailable"]],
      ],
    });
    bad(forged);
  });

  it("REJECTS a multi-step diagnostic that is not at the scenario's TERMINAL round", () => {
    // Case 201 ran to full length (executed=4), but the ledger places a
    // diagnostic at round 1 — a diagnostic marks the round the scenario
    // terminated at. A full-length scenario with a diagnostic must have it
    // at the FINAL round.
    const forged = validSeed(201, {
      diagnosticFailures: [[201, 1, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]]],
    });
    bad(forged);
  });

  it("REJECTS an early-terminated scenario with no terminal diagnostic", () => {
    // Case 201 committed with only two executed rounds and an INCOMPLETE
    // transition prefix (it stopped before its final answer round) but NO
    // diagnostic ledger entry — an early-terminated scenario always emits one
    // primary diagnostic per spec §30 lifecycle, so the absence of a
    // diagnostic here is a forgery. Under state-aware accounting the
    // structural tell is the unsatisfied transition: a diagnostic-free
    // scenario must have satisfied EVERY planned transition.
    const forged = validSeed(201, {
      scenarioEvidence: [evidence(2, 2)],
      diagnosticFailures: [],
      gates: {
        expectedCall: {
          total: 200 + 3,
          // Even if the numerators are shaped to look consistent for a
          // "case terminated with no failure" fantasy, the missing terminal
          // diagnostic is structurally impossible and the validator rejects
          // BEFORE the numerator check.
          schemaValid: 200 + 2,
          nameAccurate: 200 + 2,
          argValid: 200 + 2,
        },
        single: { total: 200, success: 200 },
        multi: { total: 1, success: 0 },
      },
    });
    bad(forged);
  });

  it("REJECTS a single-round diagnostic at any round other than 1", () => {
    // Single-round cases only have round 1; a diagnostic at round 2 is
    // structurally impossible. This was already covered by the read-path
    // shape check, but the semantic validator also rejects.
    const forged = validSeed(5, {
      diagnosticFailures: [[3, 2, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
    });
    bad(forged);
  });

  it("accepts a truthful early-terminal checkpoint (Finding 1 acceptance case)", () => {
    // A committed multi-step scenario that terminated at round 3 with
    // `expected-tool-returned-text` (the model returned final text while a
    // transition was still pending). Every accumulator, ledger entry, and
    // diagnostic is internally consistent.
    ok(
      validSeed(201, {
        scenarioEvidence: [evidence(3, 2)],
        diagnosticFailures: [[201, 3, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]]],
        gates: {
          expectedCall: {
            total: 200 + 3,
            // Case 201 satisfied its first two transitions (masks 0b011); the
            // pending third earned nothing from a text answer.
            schemaValid: 200 + 2,
            nameAccurate: 200 + 2,
            argValid: 200 + 2,
          },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("accepts a truthful complete resumable checkpoint (Finding 1 acceptance case)", () => {
    // Every committed multi scenario ran to full length without a
    // diagnostic (the default `validSeed` behavior).
    ok(validSeed(219));
    ok(validSeed(205));
  });
});

// ---------------------------------------------------------------------------
// Finding 2 remediation — the per-case ledger bound must be
// `[1, correspondingCase.rounds.length]`, NOT the global `maxRoundsPerCase`.
// A non-uniform test projection with mixed round counts proves the bound is
// evaluated against THAT case's rounds.length, not the projection maximum.
// ---------------------------------------------------------------------------

describe("eval checkpoint — Finding 2 remediation: per-case round-count bound", () => {
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, NONUNIFORM_PROJECTION)).toThrow();

  it("REJECTS a scenarioEvidence entry that fits maxRoundsPerCase but exceeds its per-case length", () => {
    // NONUNIFORM_PROJECTION: multi case 2 has 5 rounds, multi case 3 has 3
    // rounds, and `maxRoundsPerCase = 5`. A ledger claiming 5 executed rounds
    // for BOTH fits the global maximum, but the second entry exceeds case 3's
    // ACTUAL rounds.length (3). The pre-fix validator accepted the second 5
    // because it bounded every entry by `maxRoundsPerCase`; the corrected
    // validator maps each entry to its corresponding committed multi case
    // and enforces `[1, correspondingCase.rounds.length]`.
    const forged = nonUniformSeed(3, {
      scenarioEvidence: [nonUniformEvidence(5), nonUniformEvidence(5)],
    });
    bad(forged);
  });

  it("REJECTS a mask bit outside the case's PLANNED transition count", () => {
    // Every NONUNIFORM_PROJECTION scenario plans TWO transitions, so bit 2 is
    // outside its full mask (0b11) even though the shape parser tolerates it
    // for the production corpus's three-step workflow.
    bad(
      nonUniformSeed(3, {
        scenarioEvidence: [[5, 2, 0b111, 0b011, 0b011], nonUniformEvidence(3)],
      }),
    );
    bad(
      nonUniformSeed(3, {
        scenarioEvidence: [nonUniformEvidence(5), [3, 2, 0b011, 0b111, 0b011]],
      }),
    );
    bad(
      nonUniformSeed(3, {
        scenarioEvidence: [nonUniformEvidence(5), [3, 2, 0b011, 0b011, 0b111]],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 1 (round 2) — invariant gate release-evidence forgery.
// `noSilentFallback` and `injectionResistance` are now derived from executed
// evidence, so a persisted boolean that disagrees with the diagnostic +
// executed-round ledgers is rejected before any credential read or network
// I/O. Truthful invariant failures continue to be accepted (and resume
// correctly seeds the runner). A text outcome under `auto` never counts as
// silent fallback; an executed constrained final round with no diagnostic
// does; and unexecuted rounds contribute nothing.
// ---------------------------------------------------------------------------

describe("eval checkpoint — Finding 1 (round 2): invariant release-gate forgery", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("REJECTS an unauthorized-tool-call checkpoint claiming injectionResistance:true", () => {
    // Multi case 201 terminates at round 1 with `unauthorized-tool-call`.
    // The derived invariant is `injectionResistance: false`; a persisted
    // `true` disagrees and must be rejected as content-free invalid state.
    const forged = validSeed(205, {
      scenarioEvidence: [
        evidence(1, 0, { schemaAndArg: true }),
        successEvidence(4),
        successEvidence(4),
        successEvidence(4),
        successEvidence(4),
      ],
      diagnosticFailures: [diag(201, 1, "unauthorized-tool-call")],
      gates: {
        expectedCall: {
          total: 200 + 5 * 3,
          schemaValid: 200 + 1 + 12,
          nameAccurate: 200 + 0 + 12,
          argValid: 200 + 1 + 12,
        },
        single: { total: 200, success: 200 },
        multi: { total: 5, success: 4 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
    });
    bad(forged);
  });

  it("accepts the same structurally-truthful checkpoint when injectionResistance:false", () => {
    // Identical shape, but `injectionResistance` now matches derived truth.
    ok(
      validSeed(205, {
        scenarioEvidence: [
          evidence(1, 0, { schemaAndArg: true }),
          successEvidence(4),
          successEvidence(4),
          successEvidence(4),
          successEvidence(4),
        ],
        diagnosticFailures: [diag(201, 1, "unauthorized-tool-call")],
        gates: {
          expectedCall: {
            total: 200 + 5 * 3,
            schemaValid: 200 + 1 + 12,
            nameAccurate: 200 + 0 + 12,
            argValid: 200 + 1 + 12,
          },
          single: { total: 200, success: 200 },
          multi: { total: 5, success: 4 },
        },
        invariants: { noSilentFallback: true, injectionResistance: false },
      }),
    );
  });

  it("REJECTS a required-choice expected-tool-returned-text checkpoint claiming noSilentFallback:true", () => {
    // Single case 2 has `choiceKind: "required"` (i%3==1). A diagnostic
    // `expected-tool-returned-text` on this round represents the model
    // returning ordinary text under a constrained tool_choice — a silent
    // fallback. A persisted `noSilentFallback: true` disagrees with that
    // derived truth.
    const forged = validSeed(5, {
      diagnosticFailures: [diag(2, 1, "expected-tool-returned-text")],
      gates: {
        expectedCall: {
          total: 5,
          schemaValid: 4,
          nameAccurate: 4,
          argValid: 4,
        },
        single: { total: 5, success: 4 },
        multi: { total: 0, success: 0 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
    });
    bad(forged);
  });

  it("accepts the same required-choice checkpoint when noSilentFallback:false", () => {
    ok(
      validSeed(5, {
        diagnosticFailures: [diag(2, 1, "expected-tool-returned-text")],
        gates: {
          expectedCall: {
            total: 5,
            schemaValid: 4,
            nameAccurate: 4,
            argValid: 4,
          },
          single: { total: 5, success: 4 },
          multi: { total: 0, success: 0 },
        },
        invariants: { noSilentFallback: false, injectionResistance: true },
      }),
    );
  });

  it("an `auto` text fallback does not falsely fail noSilentFallback", () => {
    // Single case 1 has `choiceKind: "auto"` (i%3==0). A diagnostic
    // `expected-tool-returned-text` here is NOT a silent-fallback
    // violation because the tool choice is unconstrained. Derived
    // invariants stay `{ true, true }` and match the seed's default.
    ok(
      validSeed(5, {
        diagnosticFailures: [diag(1, 1, "expected-tool-returned-text")],
        gates: {
          expectedCall: {
            total: 5,
            schemaValid: 4,
            nameAccurate: 4,
            argValid: 4,
          },
          single: { total: 5, success: 4 },
          multi: { total: 0, success: 0 },
        },
      }),
    );
  });

  it("a successful final-text round under required/named-function choice derives noSilentFallback:false", () => {
    // A synthetic non-uniform corpus whose only committed case is a
    // multi-step scenario ending in a REQUIRED-choice final round with NO
    // diagnostic (an accepted final-text outcome). The derived invariant is
    // `noSilentFallback: false`; a persisted `true` disagrees. This proves
    // the rule is projection-driven and NOT hardcoded to the current
    // corpus's always-`auto` final rounds.
    const projection: EvalCorpusProjection = Object.freeze({
      plannedSingle: 0,
      plannedMulti: 1,
      expectedCallsPerScenario: 1,
      maxRoundsPerCase: 2,
      cases: Object.freeze([
        Object.freeze({
          phase: "multi" as const,
          rounds: Object.freeze([
            Object.freeze({ choiceKind: "auto" as const, hasExpectedTool: true }),
            Object.freeze({ choiceKind: "required" as const, hasExpectedTool: false }),
          ]),
        }),
      ]),
    });
    // A fresh anchor is not resumable (cursor >= length). Build a resumable
    // seed against a two-scenario projection instead so cursor=1 leaves
    // scenario #2 remaining.
    const twoCase: EvalCorpusProjection = Object.freeze({
      plannedSingle: 0,
      plannedMulti: 2,
      expectedCallsPerScenario: 1,
      maxRoundsPerCase: 2,
      cases: Object.freeze([
        projection.cases[0]!,
        projection.cases[0]!, // reuse same layout for the padding scenario
      ]),
    });
    // Cursor 1 = committed case 1 (multi) ran to full length (2 rounds).
    const cp: CheckpointData = data({
      nextCaseIndex: 1,
      completedSingleRoundCases: 0,
      completedMultiStepScenarios: 1,
      attemptedRounds: 2,
      completedRounds: 2,
      cleanup: { attempted: 2, deleted: 2, failed: 0, journalFailures: 0 },
      gates: {
        expectedCall: { total: 1, schemaValid: 1, nameAccurate: 1, argValid: 1 },
        single: { total: 0, success: 0 },
        multi: { total: 1, success: 1 },
      },
      // One planned transition, satisfied, with full (single-bit) evidence.
      scenarioEvidence: [[2, 1, 0b1, 0b1, 0b1]],
      diagnosticFailures: [],
      runSegments: 1,
      invariants: { noSilentFallback: true, injectionResistance: true },
    });
    expect(() => validateResumableCheckpoint(cp, twoCase)).toThrow();
    // Accepted when the derived invariant matches:
    const truthful: CheckpointData = {
      ...cp,
      invariants: { noSilentFallback: false, injectionResistance: true },
    };
    validateResumableCheckpoint(truthful, twoCase);
  });

  it("unexecuted required/function rounds do not alter the invariant", () => {
    // Multi case 201 committed with ONE executed round and a terminal
    // `expected-tool-returned-text` diagnostic on it. Case 201's round 1 has
    // `choiceKind: "auto"` — no violation. Rounds 2-4 (which include no
    // `required`/`function` rounds in the production corpus anyway) never
    // ran, so they cannot contribute to the invariant. Derived invariants
    // stay `{ true, true }`.
    ok(
      validSeed(201, {
        scenarioEvidence: [evidence(1, 0)],
        diagnosticFailures: [diag(201, 1, "expected-tool-returned-text")],
        gates: {
          expectedCall: {
            total: 200 + 3,
            schemaValid: 200 + 0,
            nameAccurate: 200 + 0,
            argValid: 200 + 0,
          },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("REJECTS the compound 19 one-round multi ledger forgery when invariants are also inflated", () => {
    // This is a defense-in-depth guard: even if the caller inflates
    // invariants alongside the pre-existing gate-numerator forgery, the
    // per-case ledger + terminal-diagnostic-required rule keeps the
    // checkpoint rejected. Combines the original "19 one-round multi"
    // forgery from finding-1 with a matching invariant inflation.
    const forged = validSeed(219, {
      scenarioEvidence: Array.from({ length: 19 }, () => successEvidence(1)),
      diagnosticFailures: [],
      gates: {
        expectedCall: {
          total: 200 + 19 * 3, // 257
          schemaValid: 200 + 19 * 3,
          nameAccurate: 200 + 19 * 3,
          argValid: 200 + 19 * 3,
        },
        single: { total: 200, success: 200 },
        multi: { total: 19, success: 19 },
      },
      invariants: { noSilentFallback: true, injectionResistance: true },
    });
    bad(forged);
  });
});

describe("eval checkpoint — Finding 2: validation rejects a corrupt projection carrying 'none'", () => {
  it("throws when a supplied projection contains a 'none' choiceKind, even before ledger validation", () => {
    // A hand-crafted projection that bypasses `buildEvalCorpusProjection`.
    // The ledger is otherwise legal (empty), so this proves validation
    // rejects the projection ITSELF, not just a specific ledger entry.
    const corruptProjection: EvalCorpusProjection = Object.freeze({
      plannedSingle: 1,
      plannedMulti: 0,
      expectedCallsPerScenario: 0,
      maxRoundsPerCase: 1,
      cases: Object.freeze([
        Object.freeze({
          phase: "single" as const,
          rounds: Object.freeze([
            Object.freeze({
              choiceKind: "none" as unknown as "auto",
              hasExpectedTool: true,
            }),
          ]),
        }),
      ]),
    });
    const anchor: CheckpointData = data({
      nextCaseIndex: 0,
      completedSingleRoundCases: 0,
      completedMultiStepScenarios: 0,
      attemptedRounds: 0,
      completedRounds: 0,
      cleanup: { attempted: 0, deleted: 0, failed: 0, journalFailures: 0 },
      gates: {
        expectedCall: { total: 0, schemaValid: 0, nameAccurate: 0, argValid: 0 },
        single: { total: 0, success: 0 },
        multi: { total: 0, success: 0 },
      },
      runSegments: 1,
      diagnosticFailures: [],
    });
    expect(() => validateResumableCheckpoint(anchor, corruptProjection)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Report v5 / checkpoint v4 — STATE-AWARE per-transition scenario evidence.
// A committed multi-step scenario now persists what its planned TRANSITIONS
// earned (`[executedRounds, satisfiedSteps, schemaMask, nameMask, argMask]`)
// instead of a positional executed-round count, because the request enables
// parallel tool calls and one accepted batch can complete several transitions
// at once. Transition success is prerequisite-gated, so the satisfied steps are
// always a leading PREFIX and a count fully describes them. These regressions
// pin the acceptance and rejection rules that replace the positional schedule.
// ---------------------------------------------------------------------------

describe("eval checkpoint — v4 state-aware scenario evidence", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("ACCEPTS an early three-round success (the parallel-batch case)", () => {
    // The headline new behavior. A scenario whose first round returned the
    // parallel batch `[read, edit]` completes two transitions at once and
    // reaches its accepted final answer in THREE rounds, not four. The
    // positional v3 ledger could not tell that apart from an early
    // termination and would have demanded a terminal diagnostic.
    ok(validSeed(201, { scenarioEvidence: [successEvidence(3)] }));
  });

  it("ACCEPTS a two-round success and REJECTS a one-round 'success'", () => {
    // `[read, edit, test]` in a single batch leaves exactly one round for the
    // final answer — MIN_SUCCESSFUL_SCENARIO_ROUNDS. One round leaves no room
    // for a final answer at all, so a diagnostic-free one-round scenario is
    // structurally impossible however complete its masks claim to be.
    ok(validSeed(201, { scenarioEvidence: [successEvidence(2)] }));
    bad(validSeed(201, { scenarioEvidence: [successEvidence(1)] }));
  });

  it("REJECTS a satisfied-step count outside the case's planned transitions", () => {
    bad(validSeed(201, { scenarioEvidence: [[4, SCENARIO_STEP_COUNT + 1, 7, 7, 7]] }));
    bad(validSeed(201, { scenarioEvidence: [[4, -1, 0, 0, 0]] }));
  });

  it("REJECTS a mask that omits a bit of the satisfied PREFIX", () => {
    // A successful transition necessarily proves schema, name AND argument
    // evidence for its step, so a satisfied prefix bit can never be missing.
    bad(validSeed(201, { scenarioEvidence: [[4, 3, 0b101, 0b111, 0b111]] }));
    bad(validSeed(201, { scenarioEvidence: [[4, 3, 0b111, 0b101, 0b111]] }));
    bad(validSeed(201, { scenarioEvidence: [[4, 3, 0b111, 0b111, 0b101]] }));
  });

  it("REJECTS aggregate numerators that disagree with the mask popcounts", () => {
    // One committed scenario terminated at its second round: transition 1
    // satisfied, transition 2 schema/argument-valid but wrongly named,
    // transition 3 never reached → masks 0b011 / 0b001 / 0b011. Each gate
    // numerator is exactly the popcount of its mask plus the singles.
    const scenarioEvidence = [evidence(2, 1, { schemaAndArg: true })];
    const truthful = {
      total: 200 + 3,
      schemaValid: 200 + 2,
      nameAccurate: 200 + 1,
      argValid: 200 + 2,
    };
    const seed = (expectedCall: typeof truthful): CheckpointData =>
      validSeed(201, {
        scenarioEvidence,
        diagnosticFailures: [diag(201, 2, "expected-tool-not-invoked")],
        gates: {
          expectedCall,
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      });
    ok(seed(truthful));
    // Probe each numerator independently: none may exceed its mask evidence.
    bad(seed({ ...truthful, schemaValid: truthful.schemaValid + 1 }));
    bad(seed({ ...truthful, nameAccurate: truthful.nameAccurate + 1 }));
    bad(seed({ ...truthful, argValid: truthful.argValid + 1 }));
  });

  it("REJECTS a terminal diagnostic whose SCOPE disagrees with the satisfied state", () => {
    // An `expected`-scope reason describes a still-PENDING transition, so it
    // is impossible once every transition succeeded …
    bad(
      validSeed(201, {
        scenarioEvidence: [successEvidence(3)],
        diagnosticFailures: [diag(201, 3, "expected-tool-not-invoked")],
      }),
    );
    // … and a `final`-scope reason describes the final-answer round, so it is
    // impossible while a transition is still pending.
    bad(
      validSeed(201, {
        scenarioEvidence: [evidence(4, 2)],
        diagnosticFailures: [diag(201, 4, "final-unavailable")],
      }),
    );
    // Each scope IS accepted against the satisfied state it actually describes.
    ok(
      validSeed(201, {
        scenarioEvidence: [evidence(3, 2)],
        diagnosticFailures: [diag(201, 3, "expected-tool-returned-text")],
        gates: {
          expectedCall: { total: 203, schemaValid: 202, nameAccurate: 202, argValid: 202 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
    ok(
      validSeed(201, {
        diagnosticFailures: [diag(201, 4, "final-unavailable")],
        gates: {
          expectedCall: { total: 203, schemaValid: 203, nameAccurate: 203, argValid: 203 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("REJECTS a diagnostic beyond the scenario's executed rounds", () => {
    bad(
      validSeed(201, {
        scenarioEvidence: [successEvidence(2)],
        diagnosticFailures: [diag(201, 3, "expected-tool-not-invoked")],
      }),
    );
  });

  it("REJECTS a diagnostic-free scenario with incomplete transitions or incomplete evidence", () => {
    // No diagnostic ⇒ the scenario SUCCEEDED, which requires every planned
    // transition satisfied with full step evidence.
    bad(validSeed(201, { scenarioEvidence: [evidence(4, 2)] }));
    bad(validSeed(201, { scenarioEvidence: [evidence(4, 0)] }));
    // Claiming full satisfaction with a hole in a mask is caught by the
    // satisfied-prefix rule before the success check even runs.
    bad(validSeed(201, { scenarioEvidence: [[4, 3, 0b011, 0b111, 0b111]] }));
  });

  it("ACCEPTS `scenario-round-budget-exhausted` at a multi-step scenario's terminal round", () => {
    // A whole-scenario reason: no individual round failed terminally, but the
    // budget ran out before an accepted final answer. Its scope is `any`, so
    // it fits a still-pending state …
    ok(
      validSeed(201, {
        scenarioEvidence: [evidence(4, 2, { schemaAndArg: true })],
        diagnosticFailures: [diag(201, 4, "scenario-round-budget-exhausted")],
        gates: {
          expectedCall: { total: 203, schemaValid: 203, nameAccurate: 202, argValid: 203 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
    // … and a fully-satisfied one whose final answer never arrived.
    ok(
      validSeed(201, {
        diagnosticFailures: [diag(201, 4, "scenario-round-budget-exhausted")],
        gates: {
          expectedCall: { total: 203, schemaValid: 203, nameAccurate: 203, argValid: 203 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("REJECTS `scenario-round-budget-exhausted` on a single-round case", () => {
    // A one-round case has no budget to exhaust, so the whole-scenario reason
    // cannot describe it — even though its `any` scope clears the positional
    // expected/final compatibility check.
    bad(validSeed(5, { diagnosticFailures: [diag(3, 1, "scenario-round-budget-exhausted")] }));
  });
});

describe("eval checkpoint — multi-step scope is state-aware, never positional", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("ACCEPTS a final-scope reason at an EARLY positional expected-tool slot", () => {
    // Round 1 returned `[read, edit, test]`, so all three transitions were
    // satisfied at once and round 2 expected FINAL TEXT — even though corpus
    // slot 2 is positionally the `edit` step. The scenario then failed to
    // produce a usable final answer.
    ok(
      validSeed(201, {
        scenarioEvidence: [successEvidence(2)],
        diagnosticFailures: [diag(201, 2, "final-no-valid-call")],
        gates: {
          expectedCall: { total: 203, schemaValid: 203, nameAccurate: 203, argValid: 203 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("ACCEPTS an expected-scope reason at the positional FINAL slot", () => {
    // A semantically failed `edit` retry left a transition PENDING into round
    // 4, so round 4 still expected a tool — even though corpus slot 4 is
    // positionally the final-answer step. The pending step earned schema and
    // argument evidence but not the expected name.
    ok(
      validSeed(201, {
        scenarioEvidence: [evidence(4, 2, { schemaAndArg: true })],
        diagnosticFailures: [diag(201, 4, "expected-tool-not-invoked")],
        gates: {
          expectedCall: { total: 203, schemaValid: 203, nameAccurate: 202, argValid: 203 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("still REJECTS a final-scope reason while a transition is pending", () => {
    bad(
      validSeed(201, {
        scenarioEvidence: [evidence(2, 1, { schemaAndArg: true })],
        diagnosticFailures: [diag(201, 2, "final-no-valid-call")],
        gates: {
          expectedCall: { total: 203, schemaValid: 202, nameAccurate: 201, argValid: 202 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("still REJECTS an expected-scope reason once every transition is satisfied", () => {
    bad(
      validSeed(201, {
        scenarioEvidence: [successEvidence(4)],
        diagnosticFailures: [diag(201, 4, "expected-tool-not-invoked")],
        gates: {
          expectedCall: { total: 203, schemaValid: 203, nameAccurate: 203, argValid: 203 },
          single: { total: 200, success: 200 },
          multi: { total: 1, success: 0 },
        },
      }),
    );
  });

  it("keeps SINGLE-round scope checks strict and positional", () => {
    // A single-round case has no transition state, so its sole round's own
    // `hasExpectedTool` disposition (true for every production single case)
    // remains the trust source in both directions.
    ok(
      validSeed(5, {
        diagnosticFailures: [diag(3, 1, "expected-tool-not-invoked")],
        gates: {
          expectedCall: { total: 5, schemaValid: 5, nameAccurate: 4, argValid: 5 },
          single: { total: 5, success: 4 },
          multi: { total: 0, success: 0 },
        },
      }),
    );
    for (const reason of ["final-no-valid-call", "final-unavailable"] as const) {
      bad(validSeed(5, { diagnosticFailures: [diag(3, 1, reason)] }));
    }
    bad(validSeed(5, { diagnosticFailures: [diag(3, 1, "unexpected-tool-call-on-final")] }));
  });
});
