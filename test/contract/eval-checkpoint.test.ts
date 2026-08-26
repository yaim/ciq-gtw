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
} from "../../src/eval/checkpoint.js";
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
      // Format v3+ is also unsupported: only the current version is accepted.
      JSON.stringify({ ...data(), formatVersion: 3 }),
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
 * A semantically-VALID resumable seed for `cursor` with EXACTLY the committed
 * counts a genuine run would persist: a committed scenario contributes
 * `expectedCallsPerScenario` (3) to the gate denominators but `maxRoundsPerCase`
 * (4) upstream rounds. `runSegments` defaults to `data()`'s value (2).
 */
function validSeed(cursor: number, over: Partial<CheckpointData> = {}): CheckpointData {
  const committedSingle = Math.min(cursor, PLAN.plannedSingle);
  const committedMulti = Math.max(0, cursor - PLAN.plannedSingle);
  const expDenom = committedSingle + committedMulti * PLAN.expectedCallsPerScenario;
  const rounds = committedSingle + committedMulti * PLAN.maxRoundsPerCase; // committed upstream rounds
  return data({
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
    ...over,
  });
}

describe("eval checkpoint — semantic corpus-bound validation (finding 1)", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("accepts a valid single-phase, multi-phase, and mid-scenario partial seed", () => {
    ok(validSeed(0)); // fresh anchor, all zero
    ok(validSeed(5)); // single phase
    ok(validSeed(200)); // single/multi boundary
    ok(validSeed(205)); // 5 scenarios committed
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

  it("counts a committed scenario as FOUR upstream rounds, not three (finding 1)", () => {
    // cursor 201 = 200 singles + one committed scenario → 204 upstream rounds (a
    // scenario is read/edit/test/final). 203 (the old *3 count) is short a round.
    const short = { attemptedRounds: 203, completedRounds: 203 };
    bad(
      validSeed(201, {
        ...short,
        cleanup: { attempted: 203, deleted: 203, failed: 0, journalFailures: 0 },
      }),
    );
    ok(validSeed(201)); // 204 upstream rounds is correct
  });

  it("rejects a committed scenario missing its final-answer round (finding 1)", () => {
    // cursor 219 committed 19 scenarios → 200 + 19*4 = 276 upstream rounds. A forgery
    // counting only the three tool steps per scenario (200 + 19*3 = 257) is rejected.
    const forged = 200 + 19 * 3;
    bad(
      validSeed(219, {
        attemptedRounds: forged,
        completedRounds: forged,
        cleanup: { attempted: forged, deleted: forged, failed: 0, journalFailures: 0 },
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
    // cursor 205 (220 committed rounds), runSegments 5: completed ceil 220+5*3=235,
    // attempted ceil 220+5*4=240 (up to 3 completed-uncommitted + 1 failed per segment).
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

describe("eval checkpoint — v2 format version enforcement", () => {
  it("the current on-disk format version is exactly 2", () => {
    expect(CHECKPOINT_FORMAT_VERSION).toBe(2);
  });

  it("REJECTS a v1 checkpoint (no migration path)", () => {
    const dir = tempDir();
    // A shape-legal v1 payload: everything except formatVersion=1 and the
    // missing diagnosticFailures field is otherwise valid.
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

describe("eval checkpoint — v2 semantic (corpus-bound) diagnostic validation", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, PLAN);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, PLAN)).toThrow();

  it("accepts a valid ledger that references only committed cases + real rounds", () => {
    ok(
      validSeed(220 - 1, {
        // cursor 219: everything committed except the last multi scenario.
        diagnosticFailures: [
          diag(1, 1, "expected-tool-returned-text"), // single case 1, auto
          diag(200, 1, "expected-tool-no-valid-call"), // single case 200
          diag(201, 1, "expected-tool-not-invoked"), // multi case 201 round 1
          diag(201, 4, "final-unavailable"), // multi case 201 round 4 (final)
          diag(219, 3, "transcript-invalid"), // multi case 219 round 3
          diag(210, 2, "unauthorized-tool-call"), // any-scope on multi round 2
        ],
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

  it("accepts an `unauthorized-tool-call` on both expected and final rounds", () => {
    ok(
      validSeed(205, {
        diagnosticFailures: [
          diag(3, 1, "unauthorized-tool-call"), // single expected
          diag(201, 1, "unauthorized-tool-call"), // multi expected
          diag(201, 4, "unauthorized-tool-call"), // multi final
        ],
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
  it("returns the fixed reason for every code in 1..9 (unchanged mapping)", async () => {
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
  });

  it("rejects code 42 and every other out-of-range or non-integer value", async () => {
    const { evalFailureReasonForCode } = await import("../../src/eval/report.js");
    expect(evalFailureReasonForCode(0)).toBeUndefined();
    expect(evalFailureReasonForCode(10)).toBeUndefined();
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

/**
 * Build a semantically-VALID resumable seed for a NON-UNIFORM projection at
 * `cursor` (0-based case index). Committed upstream rounds sum the ACTUAL
 * per-case round counts (never `single + multi * maxRoundsPerCase`); gate
 * denominators sum the ACTUAL per-case `hasExpectedTool` counts.
 */
function nonUniformSeed(cursor: number, over: Partial<CheckpointData> = {}): CheckpointData {
  let committedSingle = 0;
  let committedMulti = 0;
  let upstreamRounds = 0;
  let expectedRounds = 0;
  for (let i = 0; i < cursor; i += 1) {
    const c = NONUNIFORM_PROJECTION.cases[i];
    if (c === undefined) break;
    if (c.phase === "single") committedSingle += 1;
    else committedMulti += 1;
    upstreamRounds += c.rounds.length;
    for (const r of c.rounds) if (r.hasExpectedTool) expectedRounds += 1;
  }
  return data({
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
    runSegments: 1,
    ...over,
  });
}

describe("eval checkpoint — Finding 2: non-uniform corpus projection", () => {
  const ok = (d: CheckpointData): void => validateResumableCheckpoint(d, NONUNIFORM_PROJECTION);
  const bad = (d: CheckpointData): void =>
    expect(() => validateResumableCheckpoint(d, NONUNIFORM_PROJECTION)).toThrow();

  it("accepts expected-tool reasons attributed to the ACTUAL expected rounds", () => {
    // Multi case 2 (caseOrdinal 2) has expected rounds at 1 and 3 — NOT the
    // "first 2 rounds" an aggregate inference would accept.
    ok(
      nonUniformSeed(3, {
        diagnosticFailures: [
          [2, 1, EVAL_FAILURE_REASON_CODES["expected-tool-returned-text"]],
          [2, 3, EVAL_FAILURE_REASON_CODES["expected-tool-no-valid-call"]],
        ],
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
    ok(
      nonUniformSeed(3, {
        diagnosticFailures: [[3, 3, EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"]]],
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
    ok(
      nonUniformSeed(3, {
        diagnosticFailures: [[2, 4, EVAL_FAILURE_REASON_CODES["final-unavailable"]]],
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
    ok(
      nonUniformSeed(3, {
        diagnosticFailures: [[2, 5, EVAL_FAILURE_REASON_CODES["final-no-valid-call"]]],
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
