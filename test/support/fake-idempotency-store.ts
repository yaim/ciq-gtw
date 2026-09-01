/**
 * A deterministic in-memory {@link IdempotencyStore} that mirrors the atomic
 * semantics of the real Lua scripts (`src/idempotency/redis-store.ts`).
 *
 * It exists so the coordinator, the route, and the SSE transport can be driven
 * hermetically — no Redis, no socket, no timers — while still exercising the
 * exact owner-token and expected-state guards the production scripts enforce.
 * The real behaviour is separately proven against a live Redis by
 * `test/redis/`; this fake is a stand-in for the SERVER, never for the
 * coordinator logic under test.
 *
 * Everything it holds is synthetic.
 */
import type {
  ActiveLeases,
  CasResult,
  ClaimResult,
  IdempotencyStore,
  ReadResult,
} from "../../src/idempotency/store.js";
import { MAX_RECORD_BYTES } from "../../src/idempotency/limits.js";
import { RECORD_VERSION, type RecordState } from "../../src/idempotency/records.js";

interface Entry {
  raw: string;
  expiresAtMs: number;
}

/** A fault the next matching operation should return instead of succeeding. */
export type StoreFault = "unavailable" | "corrupt";

export interface FakeIdempotencyStore extends IdempotencyStore {
  /** Force `isReady()` (and therefore every command) on or off. */
  setReady(ready: boolean): void;
  /** Advance the fake clock; expired entries disappear exactly like Redis TTLs. */
  advance(ms: number): void;
  /** Queue a fault for the next call to the named operation. */
  failNext(
    operation: "claim" | "read" | "transition" | "renew" | "release",
    fault: StoreFault,
  ): void;
  /**
   * Defer the RESOLUTION of the next `transition` while still applying its write
   * immediately, reproducing the real ordering where Redis has committed a
   * transition but its caller is still awaiting the reply. Returns a function
   * that releases the pending reply.
   */
  stallNextTransition(): () => void;
  /** Remaining lease of a key, in ms, or `null` when absent. */
  ttlMs(key: string): number | null;
  /** Replace a key's stored value directly (used to simulate corruption/tampering). */
  poke(key: string, raw: string, ttlMs?: number): void;
  /** Remove a key directly (used to simulate lease expiry mid-wait). */
  drop(key: string): void;
  /** The raw stored value, or `null` when absent/expired. */
  peek(key: string): string | null;
  /** Ordered log of every operation, for ordering assertions. */
  readonly calls: readonly string[];
}

/**
 * Extract `v` / `s` / `o` exactly as the Lua guard prelude does, failing closed
 * on a non-object root, a non-string `s`/`o`, or an unsupported record version.
 */
function readFields(raw: string): { state: string; owner: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["s"] !== "string" || typeof record["o"] !== "string") return null;
  if (record["v"] !== RECORD_VERSION) return null;
  return { state: record["s"], owner: record["o"] };
}

export function createFakeIdempotencyStore(
  options: { nowMs?: () => number } = {},
): FakeIdempotencyStore {
  const entries = new Map<string, Entry>();
  const faults = new Map<string, StoreFault>();
  const calls: string[] = [];
  let offset = 0;
  let ready = true;
  /** Set while the next `transition` must apply its write but withhold its reply. */
  let stalledTransition: { release: () => void } | null = null;
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

  const takeFault = (operation: string): StoreFault | null => {
    const fault = faults.get(operation);
    if (fault === undefined) return null;
    faults.delete(operation);
    return fault;
  };

  /** Mirrors the Lua `STRLEN`-before-`GET` size guard. */
  const oversized = (raw: string): boolean => Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES;

  /** Shared owner + expected-state guard, mirroring TRANSITION/RELEASE. */
  const guard = (key: string, owner: string, from: RecordState): CasResult | Entry => {
    const entry = live(key);
    if (entry === null) return { kind: "missing" };
    if (oversized(entry.raw)) return { kind: "corrupt" };
    const fields = readFields(entry.raw);
    if (fields === null) return { kind: "corrupt" };
    if (fields.owner !== owner) return { kind: "lost" };
    if (fields.state !== from) return { kind: "state" };
    return entry;
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
      faults.set(operation, fault);
    },
    stallNextTransition(): () => void {
      const gate: { release: () => void } = { release: () => undefined };
      stalledTransition = gate;
      return () => gate.release();
    },
    ttlMs(key: string): number | null {
      const entry = live(key);
      return entry === null ? null : entry.expiresAtMs - now();
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

    isReady(): boolean {
      return ready;
    },

    claim(key: string, record: string, leaseMs: number): Promise<ClaimResult> {
      calls.push(`claim:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      const fault = takeFault("claim");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const existing = live(key);
      if (existing === null) {
        entries.set(key, { raw: record, expiresAtMs: now() + leaseMs });
        return Promise.resolve({ kind: "claimed" });
      }
      if (oversized(existing.raw)) return Promise.resolve({ kind: "corrupt" });
      return Promise.resolve({ kind: "exists", raw: existing.raw });
    },

    read(key: string): Promise<ReadResult> {
      calls.push(`read:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      const fault = takeFault("read");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const entry = live(key);
      if (entry === null) return Promise.resolve({ kind: "missing" });
      if (oversized(entry.raw)) return Promise.resolve({ kind: "corrupt" });
      return Promise.resolve({ kind: "found", raw: entry.raw });
    },

    transition(
      key: string,
      owner: string,
      from: RecordState,
      next: string,
      ttlMs: number,
    ): Promise<CasResult> {
      calls.push(`transition:${from}:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      const fault = takeFault("transition");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const guarded = guard(key, owner, from);
      if ("kind" in guarded) return Promise.resolve(guarded);
      // The write lands FIRST, exactly as Redis applies a script atomically...
      guarded.raw = next;
      guarded.expiresAtMs = now() + ttlMs;
      const result: CasResult = { kind: "ok" };
      // ...and the reply may then be withheld, leaving the caller's local view
      // stale while the stored state has already advanced.
      if (stalledTransition !== null) {
        const gate = stalledTransition;
        stalledTransition = null;
        return new Promise<CasResult>((resolve) => {
          gate.release = () => resolve(result);
        });
      }
      return Promise.resolve(result);
    },

    renew(key: string, owner: string, leases: ActiveLeases): Promise<CasResult> {
      calls.push(`renew:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      const fault = takeFault("renew");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const entry = live(key);
      if (entry === null) return Promise.resolve({ kind: "missing" });
      if (oversized(entry.raw)) return Promise.resolve({ kind: "corrupt" });
      const fields = readFields(entry.raw);
      if (fields === null) return Promise.resolve({ kind: "corrupt" });
      if (fields.owner !== owner) return Promise.resolve({ kind: "lost" });
      // The lease is chosen from the STORED state, exactly as RENEW_SCRIPT does,
      // so a caller with a stale view cannot shorten a `processing` lease. A
      // `final` or `ambiguous` record is never revived.
      if (fields.state !== "reserved" && fields.state !== "processing") {
        return Promise.resolve({ kind: "state" });
      }
      const active: "reserved" | "processing" =
        fields.state === "reserved" ? "reserved" : "processing";
      // Mirrors the script's `if not lease or lease < 1 then corrupt` guard.
      const leaseMs = leases[active];
      if (!Number.isFinite(leaseMs) || leaseMs < 1) return Promise.resolve({ kind: "corrupt" });
      entry.expiresAtMs = now() + leaseMs;
      return Promise.resolve({ kind: "ok", observedState: active });
    },

    release(key: string, owner: string, from: RecordState): Promise<CasResult> {
      calls.push(`release:${from}:${key}`);
      if (!ready) return Promise.resolve({ kind: "unavailable" });
      const fault = takeFault("release");
      if (fault !== null) return Promise.resolve({ kind: fault });
      const guarded = guard(key, owner, from);
      if ("kind" in guarded) return Promise.resolve(guarded);
      entries.delete(key);
      return Promise.resolve({ kind: "ok" });
    },
  };
}
