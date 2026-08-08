import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDiscoveryArgs,
  runDiscoveryCli,
  type DiscoveryCliDeps,
  type DiscoveryRunnerLike,
} from "../../src/collectiviq/discovery-cli.js";
import {
  parseRecoveryArgs,
  runRecoveryCli,
  type RecoveryCliDeps,
} from "../../src/collectiviq/discovery-recovery-cli.js";
import {
  buildPreflightReport,
  DISCOVERY_ORIGIN,
  type DiscoveryBaselineReport,
} from "../../src/collectiviq/discovery.js";
import { buildCredentialProviderFromEnv } from "../../src/collectiviq/auth.js";
import {
  RECOVERY_JOURNAL_FILENAME,
  RECOVERY_JOURNAL_FORMAT,
  writeRecoveryJournal,
  type RecoveryJournalSink,
} from "../../src/collectiviq/recovery-journal.js";
import { STRUCTURAL_CAPTURE_FORMAT } from "../../src/collectiviq/structural-capture.js";

/** A model selection that lets preflight succeed; carries NO credential. */
const MODEL_ENV = {
  CIQ_DISCOVERY_SINGLE_LLM: "model-a",
  CIQ_DISCOVERY_COMBINED_LLMS: "model-a,model-b",
} as const;

describe("discovery CLI argument gating (approvals precede any secret read)", () => {
  it("requires --session=baseline", () => {
    expect(() => parseDiscoveryArgs([])).toThrow();
    expect(() => parseDiscoveryArgs(["--session=other"])).toThrow();
    expect(parseDiscoveryArgs(["--session=baseline"]).executeApproved).toBe(false);
  });

  it("requires recovery-journal approval before authenticated execution", () => {
    expect(() => parseDiscoveryArgs(["--session=baseline", "--execute-approved"])).toThrow();
    const args = parseDiscoveryArgs([
      "--session=baseline",
      "--execute-approved",
      "--recovery-journal-approved",
    ]);
    expect(args.executeApproved).toBe(true);
    expect(args.recoveryJournalApproved).toBe(true);
  });

  it("requires cleanup approval for not-found observation, and rejects unknown flags", () => {
    expect(() =>
      parseDiscoveryArgs(["--session=baseline", "--observe-not-found-approved"]),
    ).toThrow();
    expect(() => parseDiscoveryArgs(["--session=baseline", "--nope"])).toThrow();
  });
});

describe("recovery CLI argument gating", () => {
  it("requires all three approvals and rejects unknown flags", () => {
    expect(() => parseRecoveryArgs([])).toThrow();
    expect(() => parseRecoveryArgs(["--execute-approved"])).toThrow();
    expect(() => parseRecoveryArgs(["--execute-approved", "--cleanup-approved"])).toThrow();
    expect(() =>
      parseRecoveryArgs([
        "--execute-approved",
        "--cleanup-approved",
        "--recovery-journal-approved",
        "--nope",
      ]),
    ).toThrow();
    const args = parseRecoveryArgs([
      "--execute-approved",
      "--cleanup-approved",
      "--recovery-journal-approved",
    ]);
    expect(args).toEqual({
      executeApproved: true,
      cleanupApproved: true,
      recoveryJournalApproved: true,
    });
  });
});

describe("discovery preflight is credential-free", () => {
  it("reports the safe auth mode and projected counts without reading any secret", () => {
    const report = buildPreflightReport(
      { ...MODEL_ENV, COLLECTIVIQ_AUTH_MODE: "password" },
      { cleanupApproved: false, notFoundObservationApproved: false },
    );
    expect(report.authMode).toBe("password");
    expect(report.session).toBe("baseline");
    expect(report.projectedCounts.maxThreads).toBe(2);
    // The report must NOT reveal whether any individual secret variable is set.
    const keys = Object.keys(report);
    for (const forbidden of [
      "COLLECTIVIQ_API_KEY",
      "COLLECTIVIQ_USERNAME",
      "COLLECTIVIQ_PASSWORD",
      "username",
      "password",
      "apiKey",
      "credentialsPresent",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("preflights password mode even when NO credential variables are set", () => {
    // Proves preflight neither reads nor requires the upstream credential.
    const report = buildPreflightReport(
      { ...MODEL_ENV, COLLECTIVIQ_AUTH_MODE: "password" },
      { cleanupApproved: true, notFoundObservationApproved: false },
    );
    expect(report.authMode).toBe("password");
  });

  it("defaults the reported auth mode to bearer", () => {
    const report = buildPreflightReport(MODEL_ENV, {
      cleanupApproved: false,
      notFoundObservationApproved: false,
    });
    expect(report.authMode).toBe("bearer");
  });
});

// --- Orchestration-seam ordering tests --------------------------------------
//
// These drive the SAME `runDiscoveryCli` / `runRecoveryCli` seams production
// `main()` uses, with injected fakes and guarded/recording `Proxy` envs, so we
// assert the actual ORDERING (journal before secret, approvals before provider,
// active-mode creds only) rather than just outcomes. Everything is hermetic:
// no live/network/credential/real-journal-directory access, and the fixed
// destination origin stays hardcoded inside the seam.

/** The three upstream secret env variables the CLIs must never read early. */
const CRED_KEYS = ["COLLECTIVIQ_API_KEY", "COLLECTIVIQ_USERNAME", "COLLECTIVIQ_PASSWORD"] as const;

/** A distinctive password/token sentinel that must never reach any output. */
const SENTINEL = "SENTINEL-CRED-DO-NOT-EMIT";

/**
 * Build a guarded/recording env `Proxy`. Reads of `throwOn` keys throw (proving
 * they are never accessed on that path); reads of `record` keys push a
 * `read:<KEY>` marker into `ledger` (proving ordering). All other reads pass
 * through to the backing values.
 */
function makeEnv(
  values: Record<string, string>,
  opts: { record?: readonly string[]; throwOn?: readonly string[]; ledger?: string[] } = {},
): NodeJS.ProcessEnv {
  const record = opts.record ?? [];
  const throwOn = opts.throwOn ?? [];
  const ledger = opts.ledger;
  return new Proxy(
    { ...values },
    {
      get(target, prop, receiver): unknown {
        if (typeof prop === "string") {
          if (throwOn.includes(prop)) throw new Error(`env read blocked: ${prop}`);
          if (record.includes(prop) && ledger) ledger.push(`read:${prop}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    },
  );
}

/** A minimal well-typed successful baseline report for a faked runner. */
const MINIMAL_REPORT: DiscoveryBaselineReport = {
  session: "baseline",
  destinationOrigin: DISCOVERY_ORIGIN,
  evidenceFormatVersion: STRUCTURAL_CAPTURE_FORMAT,
  observations: [],
  notFound: null,
  notFoundRequested: false,
  cleanup: null,
  correlation: { thread: "not-observed", run: "not-observed" },
};

/** A no-op journal sink (synthetic-only); overridable per test. */
function noopJournal(overrides: Partial<RecoveryJournalSink> = {}): RecoveryJournalSink {
  return {
    init: () => Promise.resolve(),
    recordCreated: () => Promise.resolve(),
    recordDeleted: () => Promise.resolve(),
    finalize: () => Promise.resolve(),
    ownedThreadIds: () => [],
    ...overrides,
  };
}

/** A runner whose baseline always succeeds with the minimal report. */
const successRunner: DiscoveryRunnerLike = {
  executeBaseline: () => Promise.resolve(MINIMAL_REPORT),
};

describe("discovery CLI seam ordering (journal + approvals precede any secret)", () => {
  // The execute path sets a non-zero process.exitCode via the strict-completeness
  // policy on the minimal report; save/restore so it never leaks to the runner.
  let savedExitCode: typeof process.exitCode;
  beforeEach(() => {
    savedExitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("preflight reads model selection + auth mode only; no secret, journal, or provider", async () => {
    const emitted: unknown[] = [];
    const makeJournal = vi.fn();
    const buildProvider = vi.fn();
    await runDiscoveryCli({
      argv: ["--session=baseline"],
      // Reading any secret would throw; preflight must still succeed.
      env: makeEnv({ ...MODEL_ENV, COLLECTIVIQ_AUTH_MODE: "password" }, { throwOn: CRED_KEYS }),
      makeJournal: (dir, origin) => {
        makeJournal(dir, origin);
        return noopJournal();
      },
      buildProvider: (env, base, options) => {
        buildProvider();
        return buildCredentialProviderFromEnv(env, base, options);
      },
      makeRunner: () => {
        throw new Error("runner must not be constructed on the preflight path");
      },
      emit: (value) => emitted.push(value),
      persist: () => {
        throw new Error("persist must not run on the preflight path");
      },
    });
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { session: string }).session).toBe("baseline");
    expect(makeJournal).not.toHaveBeenCalled();
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it("invalid approvals / unknown flags fail during parse, before journal or provider", async () => {
    const makeJournal = vi.fn();
    const buildProvider = vi.fn();
    const deps = (argv: string[]): DiscoveryCliDeps => ({
      argv,
      env: makeEnv({ ...MODEL_ENV }, { throwOn: CRED_KEYS }),
      makeJournal: (dir, origin) => {
        makeJournal(dir, origin);
        return noopJournal();
      },
      buildProvider: (env, base, options) => {
        buildProvider();
        return buildCredentialProviderFromEnv(env, base, options);
      },
      makeRunner: () => {
        throw new Error("runner must not be constructed");
      },
      emit: () => undefined,
      persist: () => undefined,
    });
    // --execute-approved without --recovery-journal-approved is rejected.
    await expect(
      runDiscoveryCli(deps(["--session=baseline", "--execute-approved"])),
    ).rejects.toThrow();
    // Unknown flag.
    await expect(runDiscoveryCli(deps(["--session=baseline", "--nope"]))).rejects.toThrow();
    // Missing --session.
    await expect(runDiscoveryCli(deps(["--execute-approved"]))).rejects.toThrow();
    expect(makeJournal).not.toHaveBeenCalled();
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it("execute: journal.init completes before any credential is read or provider built", async () => {
    const ledger: string[] = [];
    await runDiscoveryCli({
      argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved"],
      env: makeEnv(
        {
          ...MODEL_ENV,
          COLLECTIVIQ_AUTH_MODE: "password",
          COLLECTIVIQ_USERNAME: "probe-user@example.com",
          COLLECTIVIQ_PASSWORD: SENTINEL,
        },
        { record: CRED_KEYS, ledger },
      ),
      // Real credential builder so the ordering of secret reads is authentic.
      buildProvider: buildCredentialProviderFromEnv,
      makeJournal: () =>
        noopJournal({
          init: () => {
            ledger.push("journal.init");
            return Promise.resolve();
          },
        }),
      makeRunner: () => successRunner,
      emit: () => undefined,
      persist: () => undefined,
    });
    const initIdx = ledger.indexOf("journal.init");
    const firstCredIdx = ledger.findIndex((entry) => entry.startsWith("read:"));
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(firstCredIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(firstCredIdx);
  });

  it("execute: a journal.init failure reads no credential and builds no provider/runner", async () => {
    const buildProvider = vi.fn();
    const makeRunner = vi.fn();
    await expect(
      runDiscoveryCli({
        argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved"],
        // Any credential read would throw; the init failure must precede them.
        env: makeEnv({ ...MODEL_ENV, COLLECTIVIQ_AUTH_MODE: "password" }, { throwOn: CRED_KEYS }),
        makeJournal: () =>
          noopJournal({ init: () => Promise.reject(new Error("journal init failed")) }),
        buildProvider: (env, base, options) => {
          buildProvider();
          return buildCredentialProviderFromEnv(env, base, options);
        },
        makeRunner: (config) => {
          makeRunner(config);
          return successRunner;
        },
        emit: () => undefined,
        persist: () => undefined,
      }),
    ).rejects.toThrow();
    expect(buildProvider).not.toHaveBeenCalled();
    expect(makeRunner).not.toHaveBeenCalled();
  });

  it("execute (bearer): reads the API key only, never username/password", async () => {
    const ledger: string[] = [];
    await runDiscoveryCli({
      argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved"],
      env: makeEnv(
        { ...MODEL_ENV, COLLECTIVIQ_AUTH_MODE: "bearer", COLLECTIVIQ_API_KEY: "sk-fake-000" },
        { record: CRED_KEYS, ledger },
      ),
      buildProvider: buildCredentialProviderFromEnv,
      makeJournal: () => noopJournal(),
      makeRunner: () => successRunner,
      emit: () => undefined,
      persist: () => undefined,
    });
    expect(ledger).toContain("read:COLLECTIVIQ_API_KEY");
    expect(ledger).not.toContain("read:COLLECTIVIQ_USERNAME");
    expect(ledger).not.toContain("read:COLLECTIVIQ_PASSWORD");
  });

  it("execute (password): reads username/password only, never the API key", async () => {
    const ledger: string[] = [];
    await runDiscoveryCli({
      argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved"],
      env: makeEnv(
        {
          ...MODEL_ENV,
          COLLECTIVIQ_AUTH_MODE: "password",
          COLLECTIVIQ_USERNAME: "probe-user@example.com",
          COLLECTIVIQ_PASSWORD: SENTINEL,
        },
        { record: CRED_KEYS, ledger },
      ),
      buildProvider: buildCredentialProviderFromEnv,
      makeJournal: () => noopJournal(),
      makeRunner: () => successRunner,
      emit: () => undefined,
      persist: () => undefined,
    });
    expect(ledger).toContain("read:COLLECTIVIQ_USERNAME");
    expect(ledger).toContain("read:COLLECTIVIQ_PASSWORD");
    expect(ledger).not.toContain("read:COLLECTIVIQ_API_KEY");
  });

  it("emits the value-free auth observation only in password mode", async () => {
    const passwordEmitted: unknown[] = [];
    await runDiscoveryCli({
      argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved"],
      env: makeEnv({
        ...MODEL_ENV,
        COLLECTIVIQ_AUTH_MODE: "password",
        COLLECTIVIQ_USERNAME: "probe-user@example.com",
        COLLECTIVIQ_PASSWORD: SENTINEL,
      }),
      buildProvider: buildCredentialProviderFromEnv,
      makeJournal: () => noopJournal(),
      makeRunner: () => successRunner,
      emit: (value) => passwordEmitted.push(value),
      persist: () => undefined,
    });
    expect(passwordEmitted).toHaveLength(1);
    const withAuth = passwordEmitted[0] as { auth?: unknown };
    // The observation is exactly the value-free shape — no token/username/body.
    expect(withAuth.auth).toEqual({
      mode: "password",
      loginAttempts: 0,
      status: null,
      normalized: false,
    });

    const bearerEmitted: unknown[] = [];
    await runDiscoveryCli({
      argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved"],
      env: makeEnv({
        ...MODEL_ENV,
        COLLECTIVIQ_AUTH_MODE: "bearer",
        COLLECTIVIQ_API_KEY: "sk-fake-000",
      }),
      buildProvider: buildCredentialProviderFromEnv,
      makeJournal: () => noopJournal(),
      makeRunner: () => successRunner,
      emit: (value) => bearerEmitted.push(value),
      persist: () => undefined,
    });
    expect(bearerEmitted).toHaveLength(1);
    expect(Object.keys(bearerEmitted[0] as object)).not.toContain("auth");
  });

  it("never lets a credential sentinel reach emitted or persisted output", async () => {
    const emitted: unknown[] = [];
    const persisted: unknown[] = [];
    await runDiscoveryCli({
      argv: ["--session=baseline", "--execute-approved", "--recovery-journal-approved", "--write"],
      env: makeEnv({
        ...MODEL_ENV,
        COLLECTIVIQ_AUTH_MODE: "password",
        COLLECTIVIQ_USERNAME: SENTINEL,
        COLLECTIVIQ_PASSWORD: SENTINEL,
      }),
      buildProvider: buildCredentialProviderFromEnv,
      makeJournal: () => noopJournal(),
      makeRunner: () => successRunner,
      emit: (value) => emitted.push(value),
      persist: (_session, report) => persisted.push(report),
    });
    expect(emitted.length + persisted.length).toBeGreaterThan(0);
    for (const value of [...emitted, ...persisted]) {
      expect(JSON.stringify(value) ?? "").not.toContain(SENTINEL);
    }
  });
});

describe("recovery CLI seam ordering (approvals + journal precede any secret)", () => {
  const tempDirs: string[] = [];
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ciq-cli-"));
    tempDirs.push(dir);
    return dir;
  }

  const ALL_APPROVALS = [
    "--execute-approved",
    "--cleanup-approved",
    "--recovery-journal-approved",
  ] as const;

  it("missing approvals / unknown flags fail during parse, before journal or provider", async () => {
    const buildProvider = vi.fn();
    const runCleanup = vi.fn();
    const deps = (argv: string[]): RecoveryCliDeps => ({
      argv,
      env: makeEnv({}, { throwOn: CRED_KEYS }),
      // A directory that must never be touched, since parse fails first.
      dir: join(tmpdir(), "ciq-cli-must-not-be-read-does-not-exist"),
      buildProvider: (env, base, options) => {
        buildProvider();
        return buildCredentialProviderFromEnv(env, base, options);
      },
      runCleanup: () => {
        runCleanup();
        return Promise.resolve({
          attempted: 0,
          resolved: 0,
          unresolved: 0,
          remaining: 0,
          attempts: [],
        });
      },
      emit: () => undefined,
    });
    await expect(runRecoveryCli(deps([]))).rejects.toThrow();
    await expect(runRecoveryCli(deps(["--execute-approved"]))).rejects.toThrow();
    await expect(runRecoveryCli(deps([...ALL_APPROVALS, "--nope"]))).rejects.toThrow();
    expect(buildProvider).not.toHaveBeenCalled();
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("rejects a missing/empty/malformed/origin-mismatched journal before reading a credential", async () => {
    const buildProvider = vi.fn();
    const runCleanup = vi.fn();
    const deps = (dir: string): RecoveryCliDeps => ({
      argv: [...ALL_APPROVALS],
      // Any credential read would throw; the journal checks must precede them.
      env: makeEnv({ COLLECTIVIQ_AUTH_MODE: "bearer" }, { throwOn: CRED_KEYS }),
      dir,
      buildProvider: (env, base, options) => {
        buildProvider();
        return buildCredentialProviderFromEnv(env, base, options);
      },
      runCleanup: () => {
        runCleanup();
        return Promise.resolve({
          attempted: 0,
          resolved: 0,
          unresolved: 0,
          remaining: 0,
          attempts: [],
        });
      },
      emit: () => undefined,
    });

    // Missing: an empty (journal-free) directory.
    await expect(runRecoveryCli(deps(makeTempDir()))).rejects.toThrow();

    // Empty inventory: a valid, fixed-origin journal holding zero ids.
    const emptyDir = makeTempDir();
    writeRecoveryJournal(emptyDir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: DISCOVERY_ORIGIN,
      threadIds: [],
    });
    await expect(runRecoveryCli(deps(emptyDir))).rejects.toThrow();

    // Malformed: non-JSON content at the fixed private (0600) journal path.
    const malformedDir = makeTempDir();
    const malformedPath = join(malformedDir, RECOVERY_JOURNAL_FILENAME);
    writeFileSync(malformedPath, "not json", { mode: 0o600 });
    chmodSync(malformedPath, 0o600);
    await expect(runRecoveryCli(deps(malformedDir))).rejects.toThrow();

    // Origin mismatch: a valid journal whose origin is NOT the fixed origin.
    const mismatchDir = makeTempDir();
    writeRecoveryJournal(mismatchDir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: "https://mismatch.example",
      threadIds: ["ciq-thread-TESTID"],
    });
    await expect(runRecoveryCli(deps(mismatchDir))).rejects.toThrow();

    expect(buildProvider).not.toHaveBeenCalled();
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("after valid preconditions, builds the provider and runs cleanup against the fixed origin", async () => {
    const dir = makeTempDir();
    writeRecoveryJournal(dir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: DISCOVERY_ORIGIN,
      threadIds: ["ciq-thread-TESTID"],
    });
    const emitted: unknown[] = [];
    const seenConfigOrigins: string[] = [];
    await runRecoveryCli({
      argv: [...ALL_APPROVALS],
      env: makeEnv({ COLLECTIVIQ_AUTH_MODE: "bearer", COLLECTIVIQ_API_KEY: "sk-fake-000" }),
      dir,
      buildProvider: buildCredentialProviderFromEnv,
      // Fake cleanup: assert the fixed origin, do NO network, return a clean report.
      runCleanup: (config) => {
        seenConfigOrigins.push(config.baseUrl);
        return Promise.resolve({
          attempted: 1,
          resolved: 1,
          unresolved: 0,
          remaining: 0,
          attempts: [],
        });
      },
      emit: (value) => emitted.push(value),
    });
    expect(seenConfigOrigins).toEqual([DISCOVERY_ORIGIN]);
    expect(emitted).toHaveLength(1);
    const report = emitted[0] as { destinationOrigin: string; auth?: unknown };
    expect(report.destinationOrigin).toBe(DISCOVERY_ORIGIN);
    // Bearer mode omits the auth observation entirely.
    expect(Object.keys(report)).not.toContain("auth");
    expect(JSON.stringify(report) ?? "").not.toContain("sk-fake-000");
  });

  it("execute (bearer): reads the API key only, runs cleanup after it, and omits auth", async () => {
    const dir = makeTempDir();
    writeRecoveryJournal(dir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: DISCOVERY_ORIGIN,
      threadIds: ["ciq-thread-TESTID"],
    });
    const BEARER_SENTINEL = "sk-fake-bearer-SENTINEL";
    const ledger: string[] = [];
    const emitted: unknown[] = [];
    await runRecoveryCli({
      argv: [...ALL_APPROVALS],
      env: makeEnv(
        { COLLECTIVIQ_AUTH_MODE: "bearer", COLLECTIVIQ_API_KEY: BEARER_SENTINEL },
        {
          record: ["COLLECTIVIQ_API_KEY"],
          throwOn: ["COLLECTIVIQ_USERNAME", "COLLECTIVIQ_PASSWORD"],
          ledger,
        },
      ),
      dir,
      buildProvider: buildCredentialProviderFromEnv,
      // Fake cleanup: no network. Records ordering AFTER provider construction and
      // returns a clean synthetic report so process.exitCode is never set.
      runCleanup: () => {
        ledger.push("runCleanup");
        return Promise.resolve({
          attempted: 1,
          resolved: 1,
          unresolved: 0,
          remaining: 0,
          attempts: [],
        });
      },
      emit: (value) => emitted.push(value),
    });

    // Only the active-mode credential was read (throwOn would have thrown for the
    // password variables, so the run completing proves they were never accessed).
    const apiKeyIdx = ledger.indexOf("read:COLLECTIVIQ_API_KEY");
    const cleanupIdx = ledger.indexOf("runCleanup");
    expect(apiKeyIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    // Cleanup runs only after valid journal preconditions + provider construction.
    expect(apiKeyIdx).toBeLessThan(cleanupIdx);

    // Bearer mode omits the value-free auth observation entirely.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).not.toHaveProperty("auth");
    // The bearer sentinel never reaches the emitted report.
    expect(JSON.stringify(emitted) ?? "").not.toContain(BEARER_SENTINEL);
  });

  it("execute (password): reads username/password only, emits the value-free auth, does no login", async () => {
    const dir = makeTempDir();
    writeRecoveryJournal(dir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: DISCOVERY_ORIGIN,
      threadIds: ["t-recover-a"],
    });
    // Distinct synthetic sentinels so each credential's absence is asserted
    // independently in the emitted output.
    const USERNAME_SENTINEL = "SENTINEL-USERNAME-DO-NOT-EMIT";
    const PASSWORD_SENTINEL = "SENTINEL-PASSWORD-DO-NOT-EMIT";
    const ledger: string[] = [];
    const emitted: unknown[] = [];
    await runRecoveryCli({
      argv: [...ALL_APPROVALS],
      env: makeEnv(
        {
          COLLECTIVIQ_AUTH_MODE: "password",
          COLLECTIVIQ_USERNAME: USERNAME_SENTINEL,
          COLLECTIVIQ_PASSWORD: PASSWORD_SENTINEL,
        },
        {
          record: ["COLLECTIVIQ_USERNAME", "COLLECTIVIQ_PASSWORD"],
          throwOn: ["COLLECTIVIQ_API_KEY"],
          ledger,
        },
      ),
      dir,
      buildProvider: buildCredentialProviderFromEnv,
      // Fake cleanup: never calls the provider's `acquire`, so no login/network
      // ever happens and the provider's loginCount stays 0.
      runCleanup: () => {
        ledger.push("runCleanup");
        return Promise.resolve({
          attempted: 1,
          resolved: 1,
          unresolved: 0,
          remaining: 0,
          attempts: [],
        });
      },
      emit: (value) => emitted.push(value),
    });

    // Both active-mode credentials were read; the API key (throwOn) never was.
    const userIdx = ledger.indexOf("read:COLLECTIVIQ_USERNAME");
    const passIdx = ledger.indexOf("read:COLLECTIVIQ_PASSWORD");
    const cleanupIdx = ledger.indexOf("runCleanup");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeGreaterThanOrEqual(0);
    // Cleanup runs only after the credential reads (provider construction).
    expect(cleanupIdx).toBeGreaterThan(Math.max(userIdx, passIdx));

    // The emitted auth observation is EXACTLY the value-free zero-login shape:
    // the fake cleanup never triggered a login, so loginAttempts stays 0.
    expect(emitted).toHaveLength(1);
    const report = emitted[0] as { auth?: unknown };
    expect(report.auth).toEqual({
      mode: "password",
      loginAttempts: 0,
      status: null,
      normalized: false,
    });
    // Neither the username nor the password sentinel reaches the emitted report.
    const serialized = JSON.stringify(emitted) ?? "";
    expect(serialized).not.toContain(USERNAME_SENTINEL);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
  });
});
