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
  writeSync as realWriteSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setRecoveryJournalFsForTests,
  deleteRecoveryJournal,
  ensureSafeDiscoveryDir,
  FileRecoveryJournal,
  InMemoryRecoveryJournal,
  readRecoveryJournal,
  RECOVERY_JOURNAL_FILENAME,
  RECOVERY_JOURNAL_FORMAT,
  writeRecoveryJournal,
  type JournalFsOps,
  type RecoveryJournalData,
} from "../../src/collectiviq/recovery-journal.js";

const ORIGIN = "https://api.prod.collectiviq.ai";
// Synthetic, non-account ids only.
const ID_A = "t-synthetic-a";
const ID_B = "t-synthetic-b";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ciq-journal-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journalFile(dir: string): string {
  return join(dir, RECOVERY_JOURNAL_FILENAME);
}

function data(threadIds: string[]): RecoveryJournalData {
  return { formatVersion: RECOVERY_JOURNAL_FORMAT, destinationOrigin: ORIGIN, threadIds };
}

describe("recovery journal file round-trip", () => {
  it("writes with mode 0600 and reads back the same content", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A, ID_B]));
    const mode = statSync(journalFile(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
    const read = readRecoveryJournal(dir);
    expect(read).toEqual(data([ID_A, ID_B]));
  });

  it("returns null when the journal is absent", () => {
    expect(readRecoveryJournal(tempDir())).toBeNull();
  });

  it("writes atomically, leaving no temp file behind", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const names = readdirSync(dir);
    expect(names).toContain(RECOVERY_JOURNAL_FILENAME);
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("removes the journal on delete, but is a no-op when absent", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    deleteRecoveryJournal(dir);
    expect(readRecoveryJournal(dir)).toBeNull();
    expect(() => deleteRecoveryJournal(dir)).not.toThrow();
  });
});

describe("recovery journal validation", () => {
  it("rejects more than two ids, empty ids, oversized ids, and duplicates on write", () => {
    const dir = tempDir();
    expect(() => writeRecoveryJournal(dir, data([ID_A, ID_B, "t-c"]))).toThrow();
    expect(() => writeRecoveryJournal(dir, data([""]))).toThrow();
    expect(() => writeRecoveryJournal(dir, data(["x".repeat(257)]))).toThrow();
    expect(() => writeRecoveryJournal(dir, data([ID_A, ID_A]))).toThrow();
  });

  it("rejects malformed JSON, wrong version, bad origin, and a non-array id list on read", () => {
    const dir = tempDir();
    // Written with private mode so the CONTENT is what fails (not the perms gate).
    writeFileSync(journalFile(dir), "{ not json", { mode: 0o600 });
    expect(() => readRecoveryJournal(dir)).toThrow();

    writeFileSync(
      journalFile(dir),
      JSON.stringify({ formatVersion: 99, destinationOrigin: ORIGIN, threadIds: [] }),
      { mode: 0o600 },
    );
    expect(() => readRecoveryJournal(dir)).toThrow();

    writeFileSync(
      journalFile(dir),
      JSON.stringify({
        formatVersion: RECOVERY_JOURNAL_FORMAT,
        destinationOrigin: 5,
        threadIds: [],
      }),
      { mode: 0o600 },
    );
    expect(() => readRecoveryJournal(dir)).toThrow();

    writeFileSync(
      journalFile(dir),
      JSON.stringify({
        formatVersion: RECOVERY_JOURNAL_FORMAT,
        destinationOrigin: ORIGIN,
        threadIds: "nope",
      }),
      { mode: 0o600 },
    );
    expect(() => readRecoveryJournal(dir)).toThrow();
  });

  it("rejects a journal with unexpected extra fields on read", () => {
    const dir = tempDir();
    writeFileSync(
      journalFile(dir),
      JSON.stringify({
        formatVersion: RECOVERY_JOURNAL_FORMAT,
        destinationOrigin: ORIGIN,
        threadIds: [ID_A],
        // An unexpected field must be rejected outright.
        extra: "nope",
      }),
      { mode: 0o600 },
    );
    expect(() => readRecoveryJournal(dir)).toThrow();
  });

  it("rejects a non-private (group/other-readable) file on read", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    // Loosen the mode: a world/group-readable journal must be refused.
    chmodSync(journalFile(dir), 0o644);
    expect(() => readRecoveryJournal(dir)).toThrow();
  });

  it("rejects an oversized journal file on read", () => {
    const dir = tempDir();
    // A syntactically huge file well past the 4 KiB cap (private mode).
    writeFileSync(journalFile(dir), " ".repeat(5_000) + "{}", { mode: 0o600 });
    expect(() => readRecoveryJournal(dir)).toThrow();
  });

  it("rejects a symlink at the journal path on read and delete", () => {
    const dir = tempDir();
    const realTarget = join(dir, "real-target.json");
    writeFileSync(realTarget, JSON.stringify(data([ID_A])), "utf8");
    symlinkSync(realTarget, journalFile(dir));
    expect(lstatSync(journalFile(dir)).isSymbolicLink()).toBe(true);
    expect(() => readRecoveryJournal(dir)).toThrow();
    expect(() => deleteRecoveryJournal(dir)).toThrow();
  });

  it("rejects a non-regular file at the journal path on read", () => {
    const dir = tempDir();
    mkdirSync(journalFile(dir));
    expect(() => readRecoveryJournal(dir)).toThrow();
  });

  it("refuses to overwrite through a symlink on write", () => {
    const dir = tempDir();
    const realTarget = join(dir, "real-target.json");
    writeFileSync(realTarget, "{}", "utf8");
    symlinkSync(realTarget, journalFile(dir));
    expect(() => writeRecoveryJournal(dir, data([ID_A]))).toThrow();
    // The symlink's real target is never modified, and no stale temp is left.
    expect(readFileSync(realTarget, "utf8")).toBe("{}");
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("recovery journal write hardening", () => {
  it("writes a cryptographically-named temp and leaves none behind", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    writeRecoveryJournal(dir, data([ID_A, ID_B]));
    // No temp file survives, and the fixed-pid-style predictable name is gone.
    const names = readdirSync(dir);
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A, ID_B]);
  });

  it("enforces a private (0700) directory on write", () => {
    const dir = tempDir();
    chmodSync(dir, 0o777);
    writeRecoveryJournal(dir, data([ID_A]));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlinked journal directory", () => {
    const parent = tempDir();
    const realDir = join(parent, "real");
    const linkDir = join(parent, "link");
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    expect(() => writeRecoveryJournal(linkDir, data([ID_A]))).toThrow();
  });

  it("refuses a non-regular file at the journal path on write", () => {
    const dir = tempDir();
    mkdirSync(journalFile(dir));
    expect(() => writeRecoveryJournal(dir, data([ID_A]))).toThrow();
  });

  it("preserves the prior valid journal when a replacement payload is invalid", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    // A too-many-ids payload is rejected before any file is touched.
    expect(() => writeRecoveryJournal(dir, data([ID_A, ID_B, "t-c"]))).toThrow();
    // The existing valid journal is intact.
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("FileRecoveryJournal lifecycle", () => {
  it("initializes writable, records, and removes the file when empty", async () => {
    const dir = tempDir();
    const journal = new FileRecoveryJournal(dir, ORIGIN);
    await journal.init();
    expect(readRecoveryJournal(dir)).toEqual(data([]));

    await journal.recordCreated(ID_A);
    await journal.recordCreated(ID_B);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A, ID_B]);

    await journal.recordDeleted(ID_A);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_B]);

    await journal.recordDeleted(ID_B);
    // Empty again → the file is removed.
    expect(readRecoveryJournal(dir)).toBeNull();

    await journal.finalize();
    expect(readRecoveryJournal(dir)).toBeNull();
  });

  it("keeps mode 0600 across updates", async () => {
    const dir = tempDir();
    const journal = new FileRecoveryJournal(dir, ORIGIN);
    await journal.init();
    await journal.recordCreated(ID_A);
    expect(statSync(journalFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("refuses to start when a prior journal still holds unrecovered ids", async () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const journal = new FileRecoveryJournal(dir, ORIGIN);
    await expect(journal.init()).rejects.toThrow();
  });

  it("refuses a journal from a different origin", async () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, {
      formatVersion: RECOVERY_JOURNAL_FORMAT,
      destinationOrigin: "https://example.invalid",
      threadIds: [],
    });
    const journal = new FileRecoveryJournal(dir, ORIGIN);
    await expect(journal.init()).rejects.toThrow();
  });
});

describe("safe discovery directory helper (create-or-tighten)", () => {
  it("creates an absent directory as a private 0700 directory", () => {
    const target = join(tempDir(), "discovery");
    ensureSafeDiscoveryDir(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("tightens an existing real 0755 directory to 0700", () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    ensureSafeDiscoveryDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlinked or non-directory path", () => {
    const parent = tempDir();
    const realDir = join(parent, "real");
    const linkDir = join(parent, "link");
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkDir);
    expect(() => ensureSafeDiscoveryDir(linkDir)).toThrow();

    const filePath = join(parent, "a-file");
    writeFileSync(filePath, "x", { mode: 0o600 });
    expect(() => ensureSafeDiscoveryDir(filePath)).toThrow();
  });
});

describe("FileRecoveryJournal recovers a pre-existing 0755 report directory", () => {
  it("initializes cleanly when the directory is 0755 with a sanitized report but no journal", async () => {
    // Regression: a prior run left the shared directory at 0755 (default mkdir
    // mode) containing only a sanitized report — no journal. init() must tighten
    // the directory to 0700 and succeed, rather than refuse the loose directory
    // on the read path.
    const dir = tempDir();
    // A leftover sanitized report file (value-free placeholder) and NO journal.
    writeFileSync(join(dir, "baseline.json"), JSON.stringify({ session: "baseline" }), {
      mode: 0o644,
    });
    chmodSync(dir, 0o755);

    const journal = new FileRecoveryJournal(dir, ORIGIN);
    await expect(journal.init()).resolves.toBeUndefined();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The report is untouched; the journal is initialized empty.
    expect(readRecoveryJournal(dir)).toEqual(data([]));
    expect(readdirSync(dir)).toContain("baseline.json");
  });
});

describe("InMemoryRecoveryJournal", () => {
  it("tracks ids and enforces the two-id bound with synthetic ids", async () => {
    const journal = new InMemoryRecoveryJournal();
    expect(journal.initialized).toBe(false);
    await journal.init();
    expect(journal.initialized).toBe(true);
    await journal.recordCreated(ID_A);
    await journal.recordCreated(ID_B);
    expect(journal.ownedThreadIds()).toEqual([ID_A, ID_B]);
    await expect(journal.recordCreated("t-third")).rejects.toThrow();
    await journal.recordDeleted(ID_A);
    expect(journal.ownedThreadIds()).toEqual([ID_B]);
  });
});

describe("recovery journal directory validation (read + delete)", () => {
  it("returns null / no-ops for an absent directory", () => {
    const absent = join(tempDir(), "does-not-exist");
    expect(readRecoveryJournal(absent)).toBeNull();
    expect(() => deleteRecoveryJournal(absent)).not.toThrow();
  });

  it("rejects a directly symlinked journal directory on read and delete", () => {
    const parent = tempDir();
    const realDir = join(parent, "real");
    const linkDir = join(parent, "link");
    mkdirSync(realDir, { mode: 0o700 });
    writeRecoveryJournal(realDir, data([ID_A]));
    symlinkSync(realDir, linkDir);
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
    expect(() => readRecoveryJournal(linkDir)).toThrow();
    expect(() => deleteRecoveryJournal(linkDir)).toThrow();
    // The real journal behind the symlink is untouched.
    expect(readRecoveryJournal(realDir)?.threadIds).toEqual([ID_A]);
  });

  it("rejects a non-directory path on read and delete", () => {
    const dir = tempDir();
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "x", { mode: 0o600 });
    expect(() => readRecoveryJournal(filePath)).toThrow();
    expect(() => deleteRecoveryJournal(filePath)).toThrow();
  });

  it("rejects a group/world-accessible directory on read and delete", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    chmodSync(dir, 0o755);
    expect(() => readRecoveryJournal(dir)).toThrow();
    expect(() => deleteRecoveryJournal(dir)).toThrow();
    // Restore 0700 before reading the journal for assertions.
    chmodSync(dir, 0o700);
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);
  });
});

describe("recovery journal write/read fault injection (deterministic seam)", () => {
  it("completes correctly across positive partial writes (one byte at a time)", () => {
    const dir = tempDir();
    const restore = __setRecoveryJournalFsForTests({
      // Advance one byte per call: a positive partial write must still complete.
      writeSync: ((fd: number, buf: NodeJS.ArrayBufferView, off: number) =>
        realWriteSync(fd, buf, off, 1, null)) as unknown as JournalFsOps["writeSync"],
    });
    try {
      writeRecoveryJournal(dir, data([ID_A, ID_B]));
    } finally {
      restore();
    }
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A, ID_B]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("fails closed (no hang) when a write makes zero progress, preserving the prior journal", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const restore = __setRecoveryJournalFsForTests({
      writeSync: () => 0,
    });
    try {
      expect(() => writeRecoveryJournal(dir, data([ID_B]))).toThrow();
    } finally {
      restore();
    }
    // Prior journal intact; the exact temp file was removed.
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("fails closed when a write reports more bytes than requested, preserving the prior journal", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const restore = __setRecoveryJournalFsForTests({
      // Claim one more byte than was requested without writing it: the loop must
      // reject rather than advance the offset past the never-written tail and
      // rename an incomplete temp over the prior valid journal.
      writeSync: ((_fd: number, _buf: NodeJS.ArrayBufferView, _off: number, length: number) =>
        length + 1) as unknown as JournalFsOps["writeSync"],
    });
    try {
      expect(() => writeRecoveryJournal(dir, data([ID_B]))).toThrow();
    } finally {
      restore();
    }
    // The prior journal is unchanged and the incomplete temp was removed.
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("propagates a temp-name collision (EEXIST) and leaves the prior journal intact", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const restore = __setRecoveryJournalFsForTests({
      openSync: () => {
        const err = new Error("exists") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      },
    });
    try {
      expect(() => writeRecoveryJournal(dir, data([ID_B]))).toThrow();
    } finally {
      restore();
    }
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("removes the temp file and preserves the prior journal when rename fails", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const restore = __setRecoveryJournalFsForTests({
      renameSync: () => {
        throw new Error("rename failed");
      },
    });
    try {
      expect(() => writeRecoveryJournal(dir, data([ID_B]))).toThrow();
    } finally {
      restore();
    }
    // The write produced a real temp file, but the failed rename removed it and
    // left the previous valid journal untouched.
    expect(readRecoveryJournal(dir)?.threadIds).toEqual([ID_A]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("bounds a descriptor that grows past 4096 bytes after the initial fstat", () => {
    const dir = tempDir();
    writeRecoveryJournal(dir, data([ID_A]));
    const restore = __setRecoveryJournalFsForTests({
      // fstat reports a small file, but the descriptor keeps yielding bytes: the
      // bounded read loop must reject rather than read unboundedly.
      readSync: ((_fd: number, buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x20, offset, offset + length);
        return length;
      }) as unknown as JournalFsOps["readSync"],
    });
    try {
      expect(() => readRecoveryJournal(dir)).toThrow();
    } finally {
      restore();
    }
  });
});
