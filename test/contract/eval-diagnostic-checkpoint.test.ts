/**
 * Hermetic filesystem tests for the multi-step transition diagnostic's PRIVATE
 * resume checkpoint store and its corpus-bound semantic validation.
 *
 * Every value is synthetic (no account data, no live value, no credential).
 * Faults are injected through the module-internal fs seam; directory/symlink/
 * mode cases use real temp directories. No network, no credential, and the fixed
 * production origin is never contacted.
 *
 * The most important property proven here is ISOLATION: the diagnostic store can
 * never read, overwrite, finalize, or remove the RELEASE evaluator's checkpoint,
 * even when both files live in the same directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  __setDiagnosticCheckpointFsForTests,
  buildDiagnosticCorpusProjection,
  deleteDiagnosticCheckpoint,
  diagnosticCheckpointExists,
  readDiagnosticCheckpoint,
  rehydrateTransitionDiagnostics,
  selectDiagnosticScenarios,
  validateResumableDiagnosticCheckpoint,
  writeDiagnosticCheckpoint,
  DIAGNOSTIC_CHECKPOINT_FILENAME,
  DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
  defaultDiagnosticCheckpointLocation,
  type DiagnosticCheckpointData,
  type DiagnosticCheckpointEntry,
  type DiagnosticCheckpointLocation,
  type DiagnosticCorpusProjection,
  type DiagnosticScenario,
} from "../../src/eval/diagnostic-checkpoint.js";
import {
  ALLOWED_CALL_RELATION_CODES,
  DIAGNOSTIC_CALL_MULTIPLICITY_CODES,
  DIAGNOSTIC_PROFILE,
  DIAGNOSTIC_SELECTION_SOURCE_CODES,
  MAX_TRANSITION_DIAGNOSTICS,
} from "../../src/eval/diagnostic-report.js";
import { EVAL_FAILURE_REASON_CODES } from "../../src/eval/report.js";
import { CHECKPOINT_FILENAME } from "../../src/eval/checkpoint.js";
import { buildEvalCases, corpusFingerprint, type EvalCase } from "../../src/eval/cases.js";

const ORIGIN = "https://api.prod.collectiviq.ai";
const FP = "a".repeat(64);
const EXPECTED = { origin: ORIGIN, corpusFingerprint: FP };

/** The production corpus's multi-step slice: 20 scenarios at ordinals 201–220. */
const SCENARIOS = selectDiagnosticScenarios(buildEvalCases());
const PROJECTION = buildDiagnosticCorpusProjection(SCENARIOS);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ciq-diag-cp-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Wrap a simple directory as a location: the temp dir's parent (the OS temp
 * root) is the trusted base and the dir itself is the single managed component
 * that gets symlink/mode-validated.
 */
function loc(dir: string): DiagnosticCheckpointLocation {
  return { base: dirname(dir), components: [basename(dir)] };
}

function file(dir: string): string {
  return join(dir, DIAGNOSTIC_CHECKPOINT_FILENAME);
}

function data(over: Partial<DiagnosticCheckpointData> = {}): DiagnosticCheckpointData {
  return {
    formatVersion: DIAGNOSTIC_CHECKPOINT_FORMAT_VERSION,
    origin: ORIGIN,
    authMode: "password",
    profile: DIAGNOSTIC_PROFILE,
    corpusFingerprint: FP,
    resumeState: "resumable",
    abort: null,
    nextScenarioIndex: 3,
    runSegments: 1,
    attemptedRounds: 12,
    completedRounds: 12,
    completedScenarios: 3,
    successfulScenarios: 3,
    cleanup: { attempted: 12, deleted: 12, failed: 0, journalFailures: 0 },
    executedScenarioRounds: [4, 4, 4],
    diagnostics: [],
    ...over,
  };
}

/** A blocked tombstone: value-free closed abort stage/reason only. */
function blockedData(over: Partial<DiagnosticCheckpointData> = {}): DiagnosticCheckpointData {
  return data({
    resumeState: "blocked",
    abort: { stage: "cleanup-delete", reason: "cleanup-failed" },
    ...over,
  });
}

/**
 * A truthful all-successful resumable checkpoint at scenario cursor `k` for the
 * REAL corpus projection (every committed scenario ran its full four rounds).
 */
function seed(k: number, over: Partial<DiagnosticCheckpointData> = {}): DiagnosticCheckpointData {
  const rounds = 4 * k;
  return data({
    corpusFingerprint: corpusFingerprint(),
    nextScenarioIndex: k,
    runSegments: 1,
    attemptedRounds: rounds,
    completedRounds: rounds,
    completedScenarios: k,
    successfulScenarios: k,
    cleanup: { attempted: rounds, deleted: rounds, failed: 0, journalFailures: 0 },
    executedScenarioRounds: Array.from({ length: k }, () => 4),
    diagnostics: [],
    ...over,
  });
}

/** The observed production failure shape: round 2, wrong-but-allowed prior tool. */
function priorOnlyEntry(caseOrdinal: number): DiagnosticCheckpointEntry {
  return [
    caseOrdinal,
    2,
    EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
    ALLOWED_CALL_RELATION_CODES["prior-only"],
    DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
    DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
  ];
}

/**
 * The history-aware shape added in format v2: round 2's expected tool had
 * already been invoked as a parallel call in an accepted earlier round.
 */
function alreadyInvokedEntry(caseOrdinal: number): DiagnosticCheckpointEntry {
  return [
    caseOrdinal,
    2,
    EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
    ALLOWED_CALL_RELATION_CODES["expected-already-invoked"],
    DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
    DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
  ];
}

describe("diagnostic checkpoint — corpus selection and projection", () => {
  it("selects exactly the 20 multi-step scenarios at global ordinals 201–220", () => {
    expect(SCENARIOS).toHaveLength(20);
    expect(SCENARIOS.map((s) => s.caseOrdinal)).toEqual(
      Array.from({ length: 20 }, (_, i) => 201 + i),
    );
    for (const scenario of SCENARIOS) {
      expect(scenario.evalCase.rounds.length).toBe(4);
      expect(scenario.evalCase.scenarioState).toBeDefined();
    }
  });

  it("never selects a single-round case", () => {
    const cases = buildEvalCases();
    for (const scenario of SCENARIOS) {
      expect(cases[scenario.caseOrdinal - 1]?.rounds.length).toBeGreaterThan(1);
    }
    // 220 total cases, 200 single-round, so the slice is exactly the remainder.
    expect(cases).toHaveLength(220);
    expect(cases.filter((c) => c.rounds.length === 1)).toHaveLength(200);
  });

  it("projects the actual per-round layout and derived bounds", () => {
    expect(PROJECTION.scenarios).toHaveLength(20);
    expect(PROJECTION.maxRoundsPerScenario).toBe(4);
    expect(PROJECTION.plannedUpstreamRounds).toBe(80);
    const first = PROJECTION.scenarios[0];
    expect(first?.caseOrdinal).toBe(201);
    expect(first?.rounds.map((r) => r.hasExpectedTool)).toEqual([true, true, true, false]);
    expect(first?.rounds.map((r) => r.choiceKind)).toEqual(["auto", "auto", "auto", "auto"]);
  });

  it("rejects a multi-round case that carries no synthetic scenario state", () => {
    const broken: EvalCase = {
      tools: [],
      selectedLlms: ["claude"],
      rounds: [
        { choice: { kind: "auto" }, prompt: "a", expectedTool: "read" },
        { choice: { kind: "auto" }, prompt: "b" },
      ],
    };
    expect(() => selectDiagnosticScenarios([broken])).toThrow();
  });

  it("fails closed at projection build on a tool choice outside the diagnostic union", () => {
    const withNone: DiagnosticScenario = {
      caseOrdinal: 1,
      evalCase: {
        tools: [],
        selectedLlms: ["claude"],
        scenarioState: { path: "p", initialContent: "a", expectedFinalContent: "b" },
        rounds: [
          { choice: { kind: "none" }, prompt: "a", expectedTool: "read" },
          { choice: { kind: "auto" }, prompt: "b" },
        ],
      },
    };
    expect(() => buildDiagnosticCorpusProjection([withNone])).toThrow();
  });
});

describe("diagnostic checkpoint — round trip", () => {
  it("writes 0600 inside a 0700 directory and reads back the same content", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(loc(dir), data());
    expect(statSync(file(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readDiagnosticCheckpoint(loc(dir), EXPECTED)).toEqual(data());
    expect(diagnosticCheckpointExists(loc(dir))).toBe(true);
  });

  it("returns null when absent and deletes cleanly", () => {
    const dir = tempDir();
    expect(readDiagnosticCheckpoint(loc(dir), EXPECTED)).toBeNull();
    expect(diagnosticCheckpointExists(loc(dir))).toBe(false);
    writeDiagnosticCheckpoint(loc(dir), data());
    deleteDiagnosticCheckpoint(loc(dir));
    expect(readDiagnosticCheckpoint(loc(dir), EXPECTED)).toBeNull();
  });

  it("round-trips a blocked tombstone with its closed abort stage/reason", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(loc(dir), blockedData());
    const read = readDiagnosticCheckpoint(loc(dir), EXPECTED);
    expect(read?.resumeState).toBe("blocked");
    expect(read?.abort).toEqual({ stage: "cleanup-delete", reason: "cleanup-failed" });
  });

  it("persists diagnostics as six-integer tuples and reads them back", () => {
    const dir = tempDir();
    const payload = data({
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [priorOnlyEntry(202)],
    });
    writeDiagnosticCheckpoint(loc(dir), payload);
    const read = readDiagnosticCheckpoint(loc(dir), EXPECTED);
    expect(read?.diagnostics).toEqual([priorOnlyEntry(202)]);
    expect(read?.diagnostics[0]).toHaveLength(6);
  });

  it("round-trips the appended history-aware relation code", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(
      loc(dir),
      data({
        nextScenarioIndex: 2,
        completedScenarios: 2,
        successfulScenarios: 1,
        executedScenarioRounds: [4, 2],
        attemptedRounds: 6,
        completedRounds: 6,
        cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
        diagnostics: [alreadyInvokedEntry(202)],
      }),
    );
    const read = readDiagnosticCheckpoint(loc(dir), EXPECTED);
    expect(read?.diagnostics).toEqual([alreadyInvokedEntry(202)]);
    expect(read?.diagnostics[0]?.[3]).toBe(7);
    // The persisted tuple carries only integers — no relation NAME on disk.
    const raw = readFileSync(file(dir), "utf8");
    expect(raw).not.toContain("expected-already-invoked");
  });

  it("writes compact, content-free bytes (no prompt, tool name, or path)", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(
      loc(dir),
      data({
        nextScenarioIndex: 2,
        completedScenarios: 2,
        successfulScenarios: 1,
        executedScenarioRounds: [4, 2],
        attemptedRounds: 6,
        completedRounds: 6,
        cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
        diagnostics: [priorOnlyEntry(202)],
      }),
    );
    const raw = readFileSync(file(dir), "utf8");
    for (const forbidden of [
      '"read"',
      '"edit"',
      '"test"',
      "synthetic/",
      "version=1",
      "version=2",
      "Synthetic",
      "gateway_protocol",
      "claude",
      "call_ciq_",
      "expected-tool-not-invoked",
      "prior-only",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(8_192);
  });
});

describe("diagnostic checkpoint — isolation from the release evaluator checkpoint", () => {
  it("uses a filename distinct from the release evaluator's", () => {
    expect(DIAGNOSTIC_CHECKPOINT_FILENAME).not.toBe(CHECKPOINT_FILENAME);
    expect(DIAGNOSTIC_CHECKPOINT_FILENAME).toContain("diagnostic");
  });

  it("resolves the same ignored managed directory but its own filename", () => {
    const location = defaultDiagnosticCheckpointLocation();
    expect(location.components).toEqual([".agent", "sessions", "eval"]);
  });

  it("never reads a release checkpoint that sits in the same directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CHECKPOINT_FILENAME), '{"formatVersion":3}\n', { mode: 0o600 });
    chmodSync(dir, 0o700);
    expect(readDiagnosticCheckpoint(loc(dir), EXPECTED)).toBeNull();
    expect(diagnosticCheckpointExists(loc(dir))).toBe(false);
  });

  it("never overwrites, truncates, or removes a co-located release checkpoint", () => {
    const dir = tempDir();
    const releasePath = join(dir, CHECKPOINT_FILENAME);
    const releaseBytes = '{"formatVersion":3,"origin":"x"}\n';
    writeFileSync(releasePath, releaseBytes, { mode: 0o600 });

    writeDiagnosticCheckpoint(loc(dir), data());
    expect(readFileSync(releasePath, "utf8")).toBe(releaseBytes);

    deleteDiagnosticCheckpoint(loc(dir));
    expect(readFileSync(releasePath, "utf8")).toBe(releaseBytes);
    expect(statSync(releasePath).mode & 0o777).toBe(0o600);
  });

  it("rejects a checkpoint whose profile is not the diagnostic profile", () => {
    const dir = tempDir();
    chmodSync(dir, 0o700);
    const foreign = { ...data(), profile: "release-evaluator" };
    writeFileSync(file(dir), `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
  });
});

describe("diagnostic checkpoint — fail-closed reads", () => {
  function writeRaw(dir: string, raw: string, mode = 0o600): void {
    chmodSync(dir, 0o700);
    writeFileSync(file(dir), raw, { mode });
    chmodSync(file(dir), mode);
  }

  it("rejects malformed JSON", () => {
    const dir = tempDir();
    writeRaw(dir, "{not json");
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects any format version other than 2, including v1 (no migration path)", () => {
    for (const version of [0, 1, 3, 4]) {
      const dir = tempDir();
      writeRaw(dir, `${JSON.stringify({ ...data(), formatVersion: version })}\n`);
      expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("rejects a v1 checkpoint BEFORE any credential access, even when otherwise valid", () => {
    // A v1 file's relation codes were derived under the POSITION-based rules, so
    // replaying it under v2's history-aware accounting would mix two
    // incompatible classifications. It must fail closed at read.
    const dir = tempDir();
    const v1 = {
      ...data({
        nextScenarioIndex: 2,
        completedScenarios: 2,
        successfulScenarios: 1,
        executedScenarioRounds: [4, 2],
        attemptedRounds: 6,
        completedRounds: 6,
        cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
        diagnostics: [priorOnlyEntry(202)],
      }),
      formatVersion: 1,
    };
    writeRaw(dir, `${JSON.stringify(v1)}\n`);
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    // The file is left in place for deliberate operator archival/removal.
    expect(readFileSync(file(dir), "utf8")).toContain('"formatVersion":1');
  });

  it("rejects an origin, auth-mode, or fingerprint mismatch", () => {
    const wrongOrigin = tempDir();
    writeRaw(wrongOrigin, `${JSON.stringify({ ...data(), origin: "https://other.example" })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(wrongOrigin), EXPECTED)).toThrow();

    const wrongAuth = tempDir();
    writeRaw(wrongAuth, `${JSON.stringify({ ...data(), authMode: "bearer" })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(wrongAuth), EXPECTED)).toThrow();

    const wrongFp = tempDir();
    writeRaw(wrongFp, `${JSON.stringify({ ...data(), corpusFingerprint: "b".repeat(64) })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(wrongFp), EXPECTED)).toThrow();

    const badFp = tempDir();
    writeRaw(badFp, `${JSON.stringify({ ...data(), corpusFingerprint: "nope" })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(badFp), EXPECTED)).toThrow();
  });

  it("rejects unexpected and missing root fields", () => {
    const extra = tempDir();
    writeRaw(extra, `${JSON.stringify({ ...data(), surprise: 1 })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(extra), EXPECTED)).toThrow();

    const missing = tempDir();
    const { runSegments: _drop, ...withoutField } = data();
    void _drop;
    writeRaw(missing, `${JSON.stringify(withoutField)}\n`);
    expect(() => readDiagnosticCheckpoint(loc(missing), EXPECTED)).toThrow();
  });

  it("rejects a resumable checkpoint carrying an abort, and a blocked one without", () => {
    const withAbort = tempDir();
    writeRaw(
      withAbort,
      `${JSON.stringify({
        ...data(),
        abort: { stage: "cleanup-delete", reason: "cleanup-failed" },
      })}\n`,
    );
    expect(() => readDiagnosticCheckpoint(loc(withAbort), EXPECTED)).toThrow();

    const blockedNoAbort = tempDir();
    writeRaw(blockedNoAbort, `${JSON.stringify({ ...data(), resumeState: "blocked" })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(blockedNoAbort), EXPECTED)).toThrow();
  });

  it("rejects an out-of-closed-union abort stage or reason in a tombstone", () => {
    const badStage = tempDir();
    writeRaw(
      badStage,
      `${JSON.stringify({
        ...blockedData(),
        abort: { stage: "made-up", reason: "cleanup-failed" },
      })}\n`,
    );
    expect(() => readDiagnosticCheckpoint(loc(badStage), EXPECTED)).toThrow();

    const badReason = tempDir();
    writeRaw(
      badReason,
      `${JSON.stringify({
        ...blockedData(),
        abort: { stage: "cleanup-delete", reason: "made-up" },
      })}\n`,
    );
    expect(() => readDiagnosticCheckpoint(loc(badReason), EXPECTED)).toThrow();
  });

  it("rejects out-of-range counters and negative or non-integer values", () => {
    const fields = [
      "nextScenarioIndex",
      "runSegments",
      "attemptedRounds",
      "completedRounds",
      "completedScenarios",
      "successfulScenarios",
    ] as const;
    for (const field of fields) {
      for (const bad of [-1, 1.5, Number.NaN, 10_000_001, 1e12, "3", null]) {
        const dir = tempDir();
        writeRaw(dir, `${JSON.stringify({ ...data(), [field]: bad })}\n`);
        expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
      }
    }
  });

  it("rejects out-of-range cleanup counters", () => {
    for (const field of ["attempted", "deleted", "failed", "journalFailures"] as const) {
      const dir = tempDir();
      const payload = data();
      writeRaw(
        dir,
        `${JSON.stringify({ ...payload, cleanup: { ...payload.cleanup, [field]: -1 } })}\n`,
      );
      expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("rejects a malformed diagnostic ledger", () => {
    const cases: unknown[] = [
      "not an array",
      [[201, 2, 4]], // wrong tuple arity
      [[201, 2, 4, 1, 1, 1, 9]], // too many members
      [[0, 2, 4, 1, 1, 1]], // zero ordinal
      [[201, 0, 4, 1, 1, 1]], // zero round
      [[201, 2, 42, 1, 1, 1]], // unknown reason code
      [[201, 2, 4, 99, 1, 1]], // unknown relation code
      [[201, 2, 4, 1, 99, 1]], // unknown source code
      [[201, 2, 4, 1, 1, 99]], // unknown multiplicity code
      [[201, 2, 4, 6, 1, 1]], // expected-tool-not-invoked + not-applicable relation
      [priorOnlyEntry(201), priorOnlyEntry(201)], // duplicate ordinal pair
      [["201", 2, 4, 1, 1, 1]], // non-number
    ];
    for (const diagnostics of cases) {
      const dir = tempDir();
      writeRaw(dir, `${JSON.stringify({ ...data(), diagnostics })}\n`);
      expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("rejects a diagnostic ledger above the scenario bound", () => {
    const dir = tempDir();
    const tooMany = Array.from({ length: MAX_TRANSITION_DIAGNOSTICS + 1 }, (_, i) =>
      priorOnlyEntry(201 + i),
    );
    writeRaw(dir, `${JSON.stringify({ ...data(), diagnostics: tooMany })}\n`);
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a malformed executed-round ledger", () => {
    for (const ledger of ["nope", [0], [-1], [1.5], ["4"]]) {
      const dir = tempDir();
      writeRaw(dir, `${JSON.stringify({ ...data(), executedScenarioRounds: ledger })}\n`);
      expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("requires EXACTLY mode 0600", () => {
    for (const mode of [0o400, 0o200, 0o000, 0o640, 0o644, 0o700, 0o666]) {
      const dir = tempDir();
      writeRaw(dir, `${JSON.stringify(data())}\n`, mode);
      expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    }
  });

  it("requires a private (0700) managed directory", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(loc(dir), data());
    chmodSync(dir, 0o755);
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("rejects a symlinked checkpoint file", () => {
    const dir = tempDir();
    const real = tempDir();
    const target = join(real, "real.json");
    writeFileSync(target, `${JSON.stringify(data())}\n`, { mode: 0o600 });
    chmodSync(dir, 0o700);
    symlinkSync(target, file(dir));
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
    expect(() => diagnosticCheckpointExists(loc(dir))).toThrow();
    expect(() => deleteDiagnosticCheckpoint(loc(dir))).toThrow();
  });

  it("rejects a symlink at ANY managed component, even with real descendants", () => {
    const root = tempDir();
    const elsewhere = tempDir();
    // A real `sessions/eval` exists under `elsewhere`, reached through a
    // symlinked `.agent` under `root`: the top-down lstat walk must catch it.
    mkdirSync(join(elsewhere, "sessions", "eval"), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(root, ".agent"));
    const location: DiagnosticCheckpointLocation = {
      base: root,
      components: [".agent", "sessions", "eval"],
    };
    expect(() => readDiagnosticCheckpoint(location, EXPECTED)).toThrow();
    expect(() => diagnosticCheckpointExists(location)).toThrow();
    expect(() => writeDiagnosticCheckpoint(location, data())).toThrow();
    expect(() => deleteDiagnosticCheckpoint(location)).toThrow();
  });

  it("rejects an oversized file", () => {
    const dir = tempDir();
    writeRaw(dir, "x".repeat(9_000));
    expect(() => readDiagnosticCheckpoint(loc(dir), EXPECTED)).toThrow();
  });

  it("refuses to write a payload that exceeds the byte cap", () => {
    const dir = tempDir();
    expect(() =>
      writeDiagnosticCheckpoint(loc(dir), data({ origin: `${ORIGIN}${"x".repeat(9_000)}` })),
    ).toThrow();
  });
});

describe("diagnostic checkpoint — atomic write faults", () => {
  it("keeps the previous valid checkpoint and removes the temp when a write fails", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(loc(dir), data());
    const before = readFileSync(file(dir), "utf8");
    const restore = __setDiagnosticCheckpointFsForTests({
      writeSync: () => {
        throw new Error("injected write failure");
      },
    });
    try {
      expect(() => writeDiagnosticCheckpoint(loc(dir), data({ runSegments: 9 }))).toThrow();
    } finally {
      restore();
    }
    expect(readFileSync(file(dir), "utf8")).toBe(before);
    expect(readDiagnosticCheckpoint(loc(dir), EXPECTED)?.runSegments).toBe(1);
  });

  it("keeps the previous valid checkpoint when the rename fails", () => {
    const dir = tempDir();
    writeDiagnosticCheckpoint(loc(dir), data());
    const before = readFileSync(file(dir), "utf8");
    const restore = __setDiagnosticCheckpointFsForTests({
      renameSync: () => {
        throw new Error("injected rename failure");
      },
    });
    try {
      expect(() => writeDiagnosticCheckpoint(loc(dir), data({ runSegments: 9 }))).toThrow();
    } finally {
      restore();
    }
    expect(readFileSync(file(dir), "utf8")).toBe(before);
  });

  it("rejects a write reporting invalid progress", () => {
    const dir = tempDir();
    const restore = __setDiagnosticCheckpointFsForTests({ writeSync: () => 0 });
    try {
      expect(() => writeDiagnosticCheckpoint(loc(dir), data())).toThrow();
    } finally {
      restore();
    }
  });
});

describe("diagnostic checkpoint — corpus-bound semantic validation", () => {
  it("accepts a truthful all-successful resumable checkpoint", () => {
    expect(() => validateResumableDiagnosticCheckpoint(seed(5), PROJECTION)).not.toThrow();
    expect(() => validateResumableDiagnosticCheckpoint(seed(0), PROJECTION)).not.toThrow();
  });

  it("accepts a truthful early-terminated scenario carrying the history-aware relation", () => {
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [alreadyInvokedEntry(202)],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).not.toThrow();
    expect(rehydrateTransitionDiagnostics(cp.diagnostics, PROJECTION)[0]).toMatchObject({
      caseOrdinal: 202,
      roundOrdinal: 2,
      reason: "expected-tool-not-invoked",
      allowedCallRelation: "expected-already-invoked",
    });
  });

  it("accepts a truthful early-terminated scenario with its terminal diagnostic", () => {
    // Scenario 202 (index 1) stopped at round 2 with one terminal diagnostic.
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [priorOnlyEntry(202)],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).not.toThrow();
  });

  it("rejects a checkpoint that encodes a COMPLETE corpus (a complete run removes it)", () => {
    expect(() => validateResumableDiagnosticCheckpoint(seed(20), PROJECTION)).toThrow();
    expect(() => validateResumableDiagnosticCheckpoint(seed(21), PROJECTION)).toThrow();
  });

  it("rejects a blocked tombstone as resumable state", () => {
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        blockedData({ corpusFingerprint: corpusFingerprint() }),
        PROJECTION,
      ),
    ).toThrow();
  });

  it("requires the executed-round ledger length to equal the cursor and the scenario count", () => {
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(3, { executedScenarioRounds: [4, 4] }),
        PROJECTION,
      ),
    ).toThrow();
    expect(() =>
      validateResumableDiagnosticCheckpoint(seed(3, { completedScenarios: 2 }), PROJECTION),
    ).toThrow();
  });

  it("bounds each executed-round entry by its OWN scenario's round count", () => {
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(2, {
          executedScenarioRounds: [4, 5],
          attemptedRounds: 9,
          completedRounds: 9,
          cleanup: { attempted: 9, deleted: 9, failed: 0, journalFailures: 0 },
        }),
        PROJECTION,
      ),
    ).toThrow();
  });

  it("rejects a forged successful-scenario count", () => {
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 2, // forged: scenario 202 terminated early
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [priorOnlyEntry(202)],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).toThrow();
  });

  it("requires an early-terminated scenario to carry a terminal diagnostic", () => {
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).toThrow();
  });

  it("rejects a diagnostic that is not at its scenario's terminal round", () => {
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [
        [
          202,
          1,
          EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
          ALLOWED_CALL_RELATION_CODES["prior-only"],
          DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
          DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
        ],
      ],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).toThrow();
  });

  it("rejects a diagnostic referencing an uncommitted scenario or unknown round", () => {
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(2, { diagnostics: [priorOnlyEntry(210)] }),
        PROJECTION,
      ),
    ).toThrow();
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(2, { diagnostics: [priorOnlyEntry(1)] }),
        PROJECTION,
      ),
    ).toThrow();
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(2, {
          diagnostics: [
            [
              201,
              9,
              EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
              ALLOWED_CALL_RELATION_CODES["prior-only"],
              DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
              DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
            ],
          ],
        }),
        PROJECTION,
      ),
    ).toThrow();
  });

  it("rejects two diagnostics for the same scenario", () => {
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [
        priorOnlyEntry(202),
        [
          202,
          3,
          EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
          ALLOWED_CALL_RELATION_CODES["prior-only"],
          DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
          DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
        ],
      ],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).toThrow();
  });

  it("rejects a reason whose scope disagrees with the referenced round", () => {
    // `final-unavailable` is a FINAL-round reason attributed to round 2, which
    // carries an expected tool.
    const cp = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 2,
      completedScenarios: 2,
      successfulScenarios: 1,
      executedScenarioRounds: [4, 2],
      attemptedRounds: 6,
      completedRounds: 6,
      cleanup: { attempted: 6, deleted: 6, failed: 0, journalFailures: 0 },
      diagnostics: [
        [
          202,
          2,
          EVAL_FAILURE_REASON_CODES["final-unavailable"],
          ALLOWED_CALL_RELATION_CODES["not-applicable"],
          DIAGNOSTIC_SELECTION_SOURCE_CODES["not-applicable"],
          DIAGNOSTIC_CALL_MULTIPLICITY_CODES["not-applicable"],
        ],
      ],
    });
    expect(() => validateResumableDiagnosticCheckpoint(cp, PROJECTION)).toThrow();
  });

  it("bounds the upstream-round counters by the committed floor plus segment slack", () => {
    expect(() =>
      validateResumableDiagnosticCheckpoint(seed(3, { completedRounds: 11 }), PROJECTION),
    ).toThrow();
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(3, { completedRounds: 13, attemptedRounds: 12 }),
        PROJECTION,
      ),
    ).toThrow();
    expect(() =>
      validateResumableDiagnosticCheckpoint(
        seed(3, {
          completedRounds: 999,
          attemptedRounds: 999,
          cleanup: { attempted: 999, deleted: 999, failed: 0, journalFailures: 0 },
        }),
        PROJECTION,
      ),
    ).toThrow();
  });

  it("requires truthful resumable cleanup accounting", () => {
    const variants: Partial<DiagnosticCheckpointData>[] = [
      { cleanup: { attempted: 12, deleted: 11, failed: 1, journalFailures: 0 } },
      { cleanup: { attempted: 12, deleted: 12, failed: 0, journalFailures: 1 } },
      { cleanup: { attempted: 12, deleted: 11, failed: 0, journalFailures: 0 } },
      { cleanup: { attempted: 13, deleted: 13, failed: 0, journalFailures: 0 } },
    ];
    for (const over of variants) {
      expect(() => validateResumableDiagnosticCheckpoint(seed(3, over), PROJECTION)).toThrow();
    }
  });

  it("requires a positive run-segment count", () => {
    expect(() =>
      validateResumableDiagnosticCheckpoint(seed(3, { runSegments: 0 }), PROJECTION),
    ).toThrow();
  });

  it("rejects a hand-crafted projection carrying an unsupported tool choice kind", () => {
    const hostile = {
      scenarios: [
        {
          caseOrdinal: 201,
          rounds: [
            { choiceKind: "none" as never, hasExpectedTool: true },
            { choiceKind: "auto" as const, hasExpectedTool: false },
          ],
        },
      ],
      maxRoundsPerScenario: 2,
      plannedUpstreamRounds: 2,
    } satisfies DiagnosticCorpusProjection;
    expect(() => validateResumableDiagnosticCheckpoint(seed(0), hostile)).toThrow();
  });

  it("rejects a 'complete and all-successful, zero-attempt' forgery", () => {
    const forged = data({
      corpusFingerprint: corpusFingerprint(),
      nextScenarioIndex: 19,
      completedScenarios: 19,
      successfulScenarios: 19,
      executedScenarioRounds: Array.from({ length: 19 }, () => 4),
      attemptedRounds: 0,
      completedRounds: 0,
      cleanup: { attempted: 0, deleted: 0, failed: 0, journalFailures: 0 },
      diagnostics: [],
    });
    expect(() => validateResumableDiagnosticCheckpoint(forged, PROJECTION)).toThrow();
  });
});

describe("diagnostic checkpoint — rehydration", () => {
  it("derives choiceKind from the projection and remaps every code", () => {
    const rehydrated = rehydrateTransitionDiagnostics([priorOnlyEntry(202)], PROJECTION);
    expect(rehydrated).toEqual([
      {
        caseOrdinal: 202,
        roundOrdinal: 2,
        choiceKind: "auto",
        reason: "expected-tool-not-invoked",
        allowedCallRelation: "prior-only",
        selectionSource: "desired-source",
        callMultiplicity: "single",
      },
    ]);
  });

  it("fails closed on an unknown code, unknown scenario, or unknown round", () => {
    expect(() => rehydrateTransitionDiagnostics([[202, 2, 42, 1, 1, 1]], PROJECTION)).toThrow();
    expect(() => rehydrateTransitionDiagnostics([[202, 2, 4, 99, 1, 1]], PROJECTION)).toThrow();
    expect(() => rehydrateTransitionDiagnostics([priorOnlyEntry(1)], PROJECTION)).toThrow();
    expect(() =>
      rehydrateTransitionDiagnostics(
        [
          [
            202,
            99,
            EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
            ALLOWED_CALL_RELATION_CODES["prior-only"],
            DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
            DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
          ],
        ],
        PROJECTION,
      ),
    ).toThrow();
  });

  it("fails closed on a dimension combination that violates the reason contract", () => {
    expect(() =>
      rehydrateTransitionDiagnostics(
        [
          [
            202,
            2,
            EVAL_FAILURE_REASON_CODES["expected-tool-not-invoked"],
            ALLOWED_CALL_RELATION_CODES["not-applicable"],
            DIAGNOSTIC_SELECTION_SOURCE_CODES["desired-source"],
            DIAGNOSTIC_CALL_MULTIPLICITY_CODES.single,
          ],
        ],
        PROJECTION,
      ),
    ).toThrow();
  });
});
