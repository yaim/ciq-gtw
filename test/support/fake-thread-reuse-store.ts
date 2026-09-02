/**
 * A deterministic in-memory {@link ThreadReuseStore} that mirrors the atomic
 * semantics of the real Lua scripts (`src/thread-reuse/redis-store.ts`).
 *
 * It exists so the coordinator and the route can be driven hermetically — no
 * Redis, no socket, no timers — while still exercising the exact owner-token,
 * expected-state, and IN-RECORD LEASE guards the production scripts enforce.
 * Two properties are reproduced faithfully because the state machine's
 * correctness depends on them:
 *
 *  - the lease deadline lives INSIDE the record and is compared against the
 *    store's own clock, not the caller's, so a record survives its lease
 *    exactly as it does in Redis;
 *  - the lease DURATION is chosen from the state being written (and, for a
 *    renewal, from the state actually STORED), so a stale caller view can never
 *    shorten a live `processing` lease;
 *  - the Redis `PX` lifetime is a SEPARATE expiry from the lease, and `ttlFor`
 *    mirrors the Lua exactly: `active` takes the sliding mapping TTL, a leased
 *    state takes at least its own lease plus a conversion grace, and
 *    `committed`/`ambiguous` take their own bounded safety TTLs. Keeping this in
 *    step with the Lua matters — a divergence would hide a real TTL bug from
 *    every hermetic test.
 *
 * Record validation is EQUIVALENT, not weaker or stronger: `decodeReuseRecord`
 * and the Lua `readRecord` both perform complete state-specific validation, so
 * a record one accepts the other accepts. What the fake cannot prove is that the
 * Lua actually EXECUTES as written — only `test/redis/thread-reuse-store.test.ts`
 * runs the real scripts, which is why a relaxed validator or a broken atomic
 * transition is caught there and nowhere else.
 *
 * This fake is a stand-in for the SERVER, never for the coordinator logic under
 * test.
 *
 * Everything it holds is synthetic.
 */
import { MAX_REUSE_RECORD_BYTES } from "../../src/thread-reuse/limits.js";
import {
  decodeReuseRecord,
  encodeReuseRecord,
  REUSE_RECORD_VERSION,
  type ReuseRecordState,
  type ThreadReuseRecord,
} from "../../src/thread-reuse/records.js";
import type {
  ReuseAcquireResult,
  ReuseCasResult,
  ReuseReleaseResult,
  ReuseTimings,
  ThreadReuseStore,
} from "../../src/thread-reuse/store.js";

interface Entry {
  raw: string;
  expiresAtMs: number;
}

/**
 * A fault the next matching operation should return instead of succeeding.
 *
 * `unavailable` and `corrupt` are in every operation's reply vocabulary. The
 * three DEFINITIVE compare-and-transition failures are not: `acquire` can never
 * report them, so queueing one for `acquire` is a test bug and throws rather
 * than being quietly downgraded.
 */
export type ReuseStoreFault = "unavailable" | "corrupt" | "missing" | "lost" | "state";

export type ReuseOperation =
  | "acquire"
  | "bind"
  | "markProcessing"
  | "renew"
  | "commit"
  | "activate"
  | "release"
  | "abandon"
  | "discardUnusable";

export interface FakeThreadReuseStore extends ThreadReuseStore {
  /** Force `isReady()` (and therefore every command) on or off. */
  setReady(ready: boolean): void;
  /** Advance the fake clock; both leases and `PX` expiries move with it. */
  advance(ms: number): void;
  /** Queue a fault for the next call to the named operation, BEFORE it mutates. */
  failNext(operation: ReuseOperation, fault: ReuseStoreFault): void;
  /**
   * Queue a LOST REPLY for the next call to the named operation: the mutation is
   * applied exactly as Redis would, and only then does the call report
   * `unavailable`.
   *
   * This is the failure mode that makes a single-step terminal transition
   * unsafe, and it is invisible to a fake that can only fail BEFORE mutating —
   * such a fake would let a broken implementation pass. Every acknowledgement-
   * safety test depends on this seam.
   */
  loseReplyNext(operation: ReuseOperation): void;
  /**
   * The record states an operation actually OBSERVED on entry, in order.
   *
   * This is what distinguishes "the mutation applied and its reply was lost"
   * from "the mutation never applied": only in the first case does the retry
   * observe an already-advanced state. Asserting the final outcome alone would
   * pass against a fake that merely fails BEFORE mutating, which would in turn
   * let a non-idempotent implementation through.
   */
  observedStates(operation: ReuseOperation): readonly string[];
  /**
   * Delete the key immediately BEFORE the next call to `operation` reads it,
   * modelling an eviction, an operator delete, or an expiry that lands in that
   * exact window.
   *
   * This is deliberately not `failNext(op, "missing")`: that seam returns before
   * the operation reads anything, so the record is still present afterwards and
   * a test asserting on the resulting state would be self-fulfilling rather than
   * exercising the genuinely-absent path.
   */
  dropBeforeNext(operation: ReuseOperation): void;
  /** Replace a key's stored value directly (simulates corruption/tampering). */
  poke(key: string, raw: string, ttlMs?: number): void;
  /** Remove a key directly (simulates a mapping TTL expiry). */
  drop(key: string): void;
  /** The raw stored value, or `null` when absent/expired. */
  peek(key: string): string | null;
  /** The decoded stored record, or `null` when absent/expired/undecodable. */
  peekRecord(key: string): ThreadReuseRecord | null;
  /** Remaining Redis `PX` lifetime of a key, in ms, or `null` when absent. */
  ttlMs(key: string): number | null;
  /** Every live key (used to assert complete cleanup). */
  keys(): readonly string[];
  /** Ordered log of every operation, for ordering assertions. */
  readonly calls: readonly string[];
}

export function createFakeThreadReuseStore(
  options: { nowMs?: () => number } = {},
): FakeThreadReuseStore {
  const entries = new Map<string, Entry>();
  /**
   * A QUEUE per operation, not a single slot: acknowledgement-safety tests need
   * to script consecutive failures (a commit and its retry both undecided), and
   * a single slot would silently let the retry succeed.
   */
  const faults = new Map<string, ReuseStoreFault[]>();
  const lostReplies = new Map<string, number>();
  const drops = new Set<string>();
  const observations = new Map<string, string[]>();
  const calls: string[] = [];
  let offset = 0;
  let ready = true;
  const baseNow = options.nowMs ?? ((): number => 1_700_000_000_000);
  const now = (): number => baseNow() + offset;

  const live = (key: string): Entry | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= now()) {
      entries.delete(key);
      return null;
    }
    return entry;
  };

  const takeFault = (operation: string): ReuseStoreFault | null => {
    const queued = faults.get(operation);
    if (queued === undefined || queued.length === 0) return null;
    return queued.shift() ?? null;
  };

  /**
   * Whether the next call to `operation` must APPLY its mutation and then report
   * `unavailable`, reproducing a reply lost after Redis committed it.
   */
  const takeLostReply = (operation: string): boolean => {
    const queued = lostReplies.get(operation) ?? 0;
    if (queued === 0) return false;
    lostReplies.set(operation, queued - 1);
    return true;
  };

  /**
   * Delete the key if a test armed `dropBeforeNext` for this operation, so the
   * operation genuinely observes an absent record rather than being handed a
   * canned failure.
   */
  const applyDrop = (operation: string, key: string): void => {
    if (!drops.has(operation)) return;
    drops.delete(operation);
    entries.delete(key);
  };

  /**
   * Record the state an operation observed on entry, so a test can prove a retry
   * saw an ALREADY-ADVANCED record rather than an unchanged one. That is the
   * only externally visible difference between "the mutation applied and its
   * reply was lost" and "the mutation never applied".
   */
  const observe = (operation: string, record: ThreadReuseRecord | "missing" | "corrupt"): void => {
    const seen = observations.get(operation) ?? [];
    seen.push(record === "missing" || record === "corrupt" ? record : record.s);
    observations.set(operation, seen);
  };

  /** Wrap a successful result so a queued lost reply hides it from the caller. */
  const withLostReply = <T extends { kind: string }>(
    operation: string,
    applied: T,
  ): T | { kind: "unavailable" } => (takeLostReply(operation) ? { kind: "unavailable" } : applied);

  /** Mirrors the Lua `STRLEN`-before-`GET` size guard. */
  const oversized = (raw: string): boolean =>
    Buffer.byteLength(raw, "utf8") > MAX_REUSE_RECORD_BYTES;

  /** Mirrors the Lua `leaseFor`: the WRITTEN state picks the lease. */
  const leaseFor = (state: ReuseRecordState, timings: ReuseTimings): number =>
    state === "processing" ? timings.processingLeaseMs : timings.leaseMs;

  /**
   * Mirrors the Lua `ttlFor`: the WRITTEN state picks the Redis lifetime, and a
   * leased state gets at least its own lease plus a conversion grace so the
   * record always outlives the lease it carries.
   */
  const ttlFor = (state: ReuseRecordState, timings: ReuseTimings): number => {
    if (state === "ambiguous") return timings.ambiguousTtlMs;
    if (state === "committed") return timings.committedTtlMs;
    if (state === "reserved" || state === "processing") {
      return Math.max(timings.mappingTtlMs, leaseFor(state, timings) + timings.ambiguousTtlMs);
    }
    return timings.mappingTtlMs;
  };

  /**
   * Mirrors the Lua `readRecord` guard: bounded, versioned, strictly typed.
   *
   * It reuses the PRODUCTION decoder, so it is deliberately STRICTER than the
   * Lua guard (which checks only `v`/`s`/`o`/`l` types): an unknown state, an
   * impossible lease/payload combination, or a malformed seal is `corrupt` here.
   * Lua reaches the same verdict for every such record through its own
   * per-branch guards, but the real-Redis suite is the authority on the Lua
   * side — this fake cannot prove Lua-level acceptance.
   */
  const read = (key: string): ThreadReuseRecord | "missing" | "corrupt" => {
    const entry = live(key);
    if (entry === null) return "missing";
    if (oversized(entry.raw)) return "corrupt";
    const decoded = decodeReuseRecord(entry.raw);
    return decoded.ok ? decoded.record : "corrupt";
  };

  /** The state being written selects its own lifetime; no caller chooses it. */
  const write = (key: string, record: ThreadReuseRecord, timings: ReuseTimings): boolean => {
    const raw = encodeReuseRecord(record);
    if (oversized(raw)) return false;
    entries.set(key, { raw, expiresAtMs: now() + ttlFor(record.s, timings) });
    return true;
  };

  /** Shared owner + expected-state guard, mirroring every CAS script. */
  const guard = (
    key: string,
    owner: string,
    from: ReuseRecordState,
  ): ThreadReuseRecord | Exclude<ReuseCasResult, { kind: "ok" }> => {
    const record = read(key);
    if (record === "missing") return { kind: "missing" };
    if (record === "corrupt") return { kind: "corrupt" };
    if (record.o !== owner) return { kind: "lost" };
    if (record.s !== from) return { kind: "state" };
    return record;
  };

  return {
    calls,

    setReady(value: boolean): void {
      ready = value;
    },
    advance(ms: number): void {
      offset += ms;
    },
    failNext(operation, fault): void {
      const queued = faults.get(operation) ?? [];
      queued.push(fault);
      faults.set(operation, queued);
    },
    loseReplyNext(operation): void {
      lostReplies.set(operation, (lostReplies.get(operation) ?? 0) + 1);
    },
    dropBeforeNext(operation): void {
      drops.add(operation);
    },
    poke(key: string, raw: string, ttlMs = 60_000): void {
      entries.set(key, { raw, expiresAtMs: now() + ttlMs });
    },
    drop(key: string): void {
      entries.delete(key);
    },
    peek(key: string): string | null {
      return live(key)?.raw ?? null;
    },
    peekRecord(key: string): ThreadReuseRecord | null {
      const record = read(key);
      return record === "missing" || record === "corrupt" ? null : record;
    },
    ttlMs(key: string): number | null {
      const entry = live(key);
      return entry === null ? null : entry.expiresAtMs - now();
    },
    keys(): readonly string[] {
      return [...entries.keys()].filter((key) => live(key) !== null);
    },
    observedStates(operation: ReuseOperation): readonly string[] {
      return observations.get(operation) ?? [];
    },

    isReady(): boolean {
      return ready;
    },

    acquire(key: string, owner: string, timings: ReuseTimings): Promise<ReuseAcquireResult> {
      calls.push(`acquire:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("acquire", key);
      const fault = takeFault("acquire");
      if (fault !== null) {
        if (fault !== "unavailable" && fault !== "corrupt") {
          throw new Error(`\`${fault}\` is not in acquire's reply vocabulary`);
        }
        return Promise.resolve({ kind: fault });
      }

      const record = read(key);
      if (record === "corrupt") return Promise.resolve({ kind: "corrupt" });

      let payload: ThreadReuseRecord["p"];
      if (record !== "missing") {
        if (record.s === "ambiguous") return Promise.resolve({ kind: "blocked" });
        // `committed` is NEVER acquirable: its terminal transition was not
        // confirmed, so it fails closed exactly like `ambiguous`.
        if (record.s === "committed") return Promise.resolve({ kind: "blocked" });
        if (record.s === "active") {
          payload = record.p;
        } else {
          // An UNEXPIRED lease belongs to a live competitor.
          if (record.l > now()) return Promise.resolve({ kind: "busy" });
          if (record.s === "processing") {
            // A crashed mid-submit owner is tombstoned, never taken over.
            write(key, { v: REUSE_RECORD_VERSION, s: "ambiguous", o: record.o, l: 0 }, timings);
            return Promise.resolve({ kind: "blocked" });
          }
          payload = record.p;
        }
      }

      const next: ThreadReuseRecord = {
        v: REUSE_RECORD_VERSION,
        s: "reserved",
        o: owner,
        l: now() + leaseFor("reserved", timings),
        ...(payload !== undefined ? { p: payload } : {}),
      };
      if (!write(key, next, timings)) return Promise.resolve({ kind: "corrupt" });
      return Promise.resolve({ kind: "acquired", raw: encodeReuseRecord(next) });
    },

    bind(key, owner, sealed, timings): Promise<ReuseCasResult> {
      calls.push(`bind:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("bind", key);
      const fault = takeFault("bind");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const guarded = guard(key, owner, "reserved");
      if ("kind" in guarded) return Promise.resolve(guarded);
      // Never overwrite an existing binding.
      if (guarded.p !== undefined) return Promise.resolve({ kind: "state" });
      const ok = write(
        key,
        {
          v: REUSE_RECORD_VERSION,
          s: "reserved",
          o: owner,
          l: now() + leaseFor("reserved", timings),
          p: sealed,
        },
        timings,
      );
      return Promise.resolve(ok ? { kind: "ok" } : { kind: "corrupt" });
    },

    markProcessing(key, owner, timings): Promise<ReuseCasResult> {
      calls.push(`markProcessing:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("markProcessing", key);
      const fault = takeFault("markProcessing");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const guarded = guard(key, owner, "reserved");
      if ("kind" in guarded) return Promise.resolve(guarded);
      const sealed = guarded.p;
      // Submitting requires a bound thread.
      if (sealed === undefined) return Promise.resolve({ kind: "corrupt" });
      const ok = write(
        key,
        {
          v: REUSE_RECORD_VERSION,
          s: "processing",
          o: owner,
          l: now() + leaseFor("processing", timings),
          p: sealed,
        },
        timings,
      );
      return Promise.resolve(ok ? { kind: "ok" } : { kind: "corrupt" });
    },

    renew(key, owner, timings): Promise<ReuseCasResult> {
      calls.push(`renew:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("renew", key);
      const fault = takeFault("renew");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const record = read(key);
      if (record === "missing") return Promise.resolve({ kind: "missing" });
      if (record === "corrupt") return Promise.resolve({ kind: "corrupt" });
      if (record.o !== owner) return Promise.resolve({ kind: "lost" });
      // The state comes from the STORED record, so a caller with a stale view
      // can neither revive a finalized mapping nor misapply a lease.
      if (record.s !== "reserved" && record.s !== "processing") {
        return Promise.resolve({ kind: "state" });
      }
      // The lease comes from the STORED state, so a caller mid-transition can
      // never shorten a live `processing` lease with a stale `reserved` view.
      const ok = write(key, { ...record, l: now() + leaseFor(record.s, timings) }, timings);
      return Promise.resolve(ok ? { kind: "ok", observedState: record.s } : { kind: "corrupt" });
    },

    commit(key, owner, timings): Promise<ReuseCasResult> {
      calls.push(`commit:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("commit", key);
      const fault = takeFault("commit");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const record = read(key);
      observe("commit", record);
      if (record === "missing") return Promise.resolve({ kind: "missing" });
      if (record === "corrupt") return Promise.resolve({ kind: "corrupt" });
      if (record.o !== owner) return Promise.resolve({ kind: "lost" });
      // IDEMPOTENT for this owner: an already-committed record acknowledges a
      // mutation whose reply was lost, instead of reporting a false failure.
      if (record.s === "committed") {
        return Promise.resolve(withLostReply<ReuseCasResult>("commit", { kind: "ok" }));
      }
      if (record.s !== "processing") return Promise.resolve({ kind: "state" });
      const sealed = record.p;
      if (sealed === undefined) return Promise.resolve({ kind: "corrupt" });
      const ok = write(
        key,
        { v: REUSE_RECORD_VERSION, s: "committed", o: owner, l: 0, p: sealed },
        timings,
      );
      if (!ok) return Promise.resolve({ kind: "corrupt" });
      return Promise.resolve(withLostReply<ReuseCasResult>("commit", { kind: "ok" }));
    },

    activate(key, owner, timings): Promise<ReuseCasResult> {
      calls.push(`activate:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("activate", key);
      const fault = takeFault("activate");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const record = read(key);
      observe("activate", record);
      if (record === "missing") {
        // Mirrors the Lua: a genuinely absent key is REPAIRED into a bounded
        // tombstone, atomically, and the caller still gets the definitive
        // `missing`. Returning without writing would leave the key absent, and
        // the session's next acquire would silently create a replacement thread.
        write(key, { v: REUSE_RECORD_VERSION, s: "ambiguous", o: owner, l: 0 }, timings);
        return Promise.resolve({ kind: "missing" });
      }
      if (record === "corrupt") return Promise.resolve({ kind: "corrupt" });
      if (record.o !== owner) return Promise.resolve({ kind: "lost" });
      if (record.s === "active") {
        return Promise.resolve(withLostReply<ReuseCasResult>("activate", { kind: "ok" }));
      }
      if (record.s !== "committed") return Promise.resolve({ kind: "state" });
      const sealed = record.p;
      if (sealed === undefined) return Promise.resolve({ kind: "corrupt" });
      const ok = write(
        key,
        { v: REUSE_RECORD_VERSION, s: "active", o: owner, l: 0, p: sealed },
        timings,
      );
      if (!ok) return Promise.resolve({ kind: "corrupt" });
      return Promise.resolve(withLostReply<ReuseCasResult>("activate", { kind: "ok" }));
    },

    release(key, owner, timings): Promise<ReuseReleaseResult> {
      calls.push(`release:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("release", key);
      const fault = takeFault("release");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const guarded = guard(key, owner, "reserved");
      if ("kind" in guarded) return Promise.resolve(guarded);
      const sealed = guarded.p;
      if (sealed === undefined) {
        entries.delete(key);
        return Promise.resolve({ kind: "ok", restored: false });
      }
      const ok = write(
        key,
        { v: REUSE_RECORD_VERSION, s: "active", o: owner, l: 0, p: sealed },
        timings,
      );
      return Promise.resolve(ok ? { kind: "ok", restored: true } : { kind: "corrupt" });
    },

    abandon(key, owner, timings): Promise<ReuseCasResult> {
      calls.push(`abandon:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("abandon", key);
      const fault = takeFault("abandon");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const record = read(key);
      if (record === "missing") return Promise.resolve({ kind: "missing" });
      if (record === "corrupt") return Promise.resolve({ kind: "corrupt" });
      if (record.o !== owner) return Promise.resolve({ kind: "lost" });
      // Accepts `committed` too: a commit whose reply was lost leaves the record
      // in a state its own caller does not know it reached.
      if (record.s !== "processing" && record.s !== "committed") {
        return Promise.resolve({ kind: "state" });
      }
      const ok = write(key, { v: REUSE_RECORD_VERSION, s: "ambiguous", o: owner, l: 0 }, timings);
      return Promise.resolve(ok ? { kind: "ok" } : { kind: "corrupt" });
    },

    discardUnusable(key, owner, timings): Promise<ReuseCasResult> {
      calls.push(`discardUnusable:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      applyDrop("discardUnusable", key);
      const fault = takeFault("discardUnusable");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const guarded = guard(key, owner, "reserved");
      if ("kind" in guarded) return Promise.resolve(guarded);
      // Tombstoned under the AMBIGUOUS TTL, not the sliding mapping TTL: an
      // unusable mapping must age out rather than be renewed by every retry.
      const ok = write(key, { v: REUSE_RECORD_VERSION, s: "ambiguous", o: owner, l: 0 }, timings);
      return Promise.resolve(ok ? { kind: "ok" } : { kind: "corrupt" });
    },
  };
}
