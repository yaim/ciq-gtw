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
  validateResumableCheckpoint,
  writeCheckpoint,
  CHECKPOINT_FILENAME,
  CHECKPOINT_FORMAT_VERSION,
  type CheckpointData,
  type CheckpointFsOps,
  type CheckpointLocation,
  type ResumableCheckpointPlan,
} from "../../src/eval/checkpoint.js";
import { evalPlan } from "../../src/eval/cases.js";

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
      JSON.stringify({ ...data(), formatVersion: 2 }),
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

/** The corpus-derived validator plan projection (single=200, multi=20, calls=3, rounds=4). */
const P = evalPlan();
const PLAN: ResumableCheckpointPlan = {
  plannedSingle: P.single,
  plannedMulti: P.multi,
  expectedCallsPerScenario: P.expectedCallsPerScenario,
  maxRoundsPerCase: P.maxRoundsPerCase,
};

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
