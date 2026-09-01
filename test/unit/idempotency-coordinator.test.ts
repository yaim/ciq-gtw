import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createIdempotencyCoordinator,
  type IdempotencyCoordinator,
  type IdempotencyOwnerSession,
} from "../../src/idempotency/coordinator.js";
import { buildStorageKey, deriveIdempotencyKeyring } from "../../src/idempotency/keyring.js";
import {
  MAX_PROCESSING_LEASE_MS,
  PROCESSING_LEASE_MARGIN_MS,
  RESERVED_LEASE_MS,
} from "../../src/idempotency/limits.js";
import { decodeRecord } from "../../src/idempotency/records.js";
import type { CachedResult } from "../../src/idempotency/payload.js";
import type { Clock, Sleeper } from "../../src/generation/types.js";
import {
  createFakeIdempotencyStore,
  type FakeIdempotencyStore,
} from "../support/fake-idempotency-store.js";

const MASTER = randomBytes(32).toString("base64url");
const KEYRING = deriveIdempotencyKeyring(MASTER);
const NAMESPACE = "test-ns";
const TTL_MS = 600_000;
const SCOPE = "scope-alpha";
const CLIENT_KEY = "client-key-1";
const FINGERPRINT = "ZmluZ2VycHJpbnQtYQ";
const OTHER_FINGERPRINT = "ZmluZ2VycHJpbnQtYg";
const IDENTITY = { id: "chatcmpl_ciq_owner", created: 1_700_000_000, model: "test-model" };
const TEXT_RESULT: CachedResult = { kind: "text", content: "the answer" };

const STORAGE_KEY = buildStorageKey(KEYRING, NAMESPACE, SCOPE, CLIENT_KEY);

interface Harness {
  readonly coordinator: IdempotencyCoordinator;
  readonly store: FakeIdempotencyStore;
  readonly renew: () => void;
  advance(ms: number): void;
}

/**
 * Build a coordinator over the fake store with a fully controlled clock, an
 * instant sleeper (so waiter backoff is deterministic and never real time), and
 * a manually driven lease-renewal trigger.
 */
function harness(options: { sleepAdvancesMs?: number } = {}): Harness {
  // One clock drives the harness, the coordinator, and the fake store's TTLs.
  let nowMs = 1_700_000_000_000;
  const store = createFakeIdempotencyStore({ nowMs: () => nowMs });
  const clock: Clock = { nowMs: () => nowMs };
  const sleepAdvance = options.sleepAdvancesMs ?? 0;
  const sleeper: Sleeper = {
    sleep(ms: number, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      // Advance the clock so the waiter's deadline arithmetic is exercised
      // without any wall-clock delay.
      nowMs += sleepAdvance > 0 ? sleepAdvance : ms;
      return Promise.resolve();
    },
  };
  let trigger = (): void => undefined;
  const coordinator = createIdempotencyCoordinator({
    store,
    keyring: KEYRING,
    namespace: NAMESPACE,
    ttlMs: TTL_MS,
    clock,
    sleeper,
    random: () => 0,
    scheduleRenewal: (fn) => {
      trigger = fn;
      return { cancel: () => (trigger = (): void => undefined) };
    },
  });
  return {
    coordinator,
    store,
    renew: () => trigger(),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function beginInput(
  over: Partial<Parameters<IdempotencyCoordinator["begin"]>[0]> = {},
): Parameters<IdempotencyCoordinator["begin"]>[0] {
  return {
    clientKey: CLIENT_KEY,
    gatewayKeyScope: SCOPE,
    bodyFingerprint: FINGERPRINT,
    identity: IDENTITY,
    signal: new AbortController().signal,
    timeoutMs: 90_000,
    ...over,
  };
}

async function claimOwner(h: Harness): Promise<IdempotencyOwnerSession> {
  const outcome = await h.coordinator.begin(beginInput());
  if (outcome.kind !== "owner") throw new Error(`expected owner, got ${outcome.kind}`);
  return outcome.session;
}

/** Drive a full owner lifecycle to a committed `final` record. */
async function commitOwner(h: Harness, result: CachedResult = TEXT_RESULT): Promise<void> {
  const session = await claimOwner(h);
  expect(await session.markProcessing()).toBe("ok");
  expect(await session.commit(result)).toBe("ok");
  await session.finish();
}

/** Drain the renewal promise chain (`then` → `catch` → `finally`). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function storedState(h: Harness): string | null {
  const raw = h.store.peek(STORAGE_KEY);
  if (raw === null) return null;
  const decoded = decodeRecord(raw);
  return decoded.ok ? decoded.record.s : "corrupt";
}

describe("coordinator: claim and state machine", () => {
  it("claims an absent key and writes a reserved record with a bounded lease", async () => {
    const h = harness();
    const session = await claimOwner(h);
    expect(storedState(h)).toBe("reserved");
    expect(h.store.calls[0]).toBe(`claim:${STORAGE_KEY}`);
    await session.finish();
  });

  it("moves reserved -> processing -> final in that exact order", async () => {
    const h = harness();
    const session = await claimOwner(h);
    expect(await session.markProcessing()).toBe("ok");
    expect(storedState(h)).toBe("processing");
    expect(await session.commit(TEXT_RESULT)).toBe("ok");
    expect(storedState(h)).toBe("final");
    await session.finish();
    // Committing does not undo the final record.
    expect(storedState(h)).toBe("final");
    expect(h.store.calls).toEqual([
      `claim:${STORAGE_KEY}`,
      `transition:reserved:${STORAGE_KEY}`,
      `transition:processing:${STORAGE_KEY}`,
    ]);
  });

  it("refuses to commit before processing began", async () => {
    const h = harness();
    const session = await claimOwner(h);
    expect(await session.commit(TEXT_RESULT)).toBe("unavailable");
    expect(storedState(h)).toBe("reserved");
    await session.finish();
  });

  it("compare-and-deletes a reserved record on a proven pre-processing failure", async () => {
    const h = harness();
    const session = await claimOwner(h);
    // No markProcessing: the completion failed at capacity acquisition.
    await session.finish();
    expect(storedState(h)).toBeNull();
    expect(h.store.calls).toContain(`release:reserved:${STORAGE_KEY}`);
  });

  it("marks ambiguous when a failure occurs after processing began", async () => {
    const h = harness();
    const session = await claimOwner(h);
    expect(await session.markProcessing()).toBe("ok");
    await session.finish(); // no commit: the completion failed
    expect(storedState(h)).toBe("ambiguous");
    expect(h.store.calls).not.toContain(`release:processing:${STORAGE_KEY}`);
  });

  it("is idempotent across repeated finish() calls", async () => {
    const h = harness();
    const session = await claimOwner(h);
    expect(await session.markProcessing()).toBe("ok");
    await session.finish();
    await session.finish();
    await session.finish();
    const transitions = h.store.calls.filter((c) => c.startsWith("transition:processing"));
    expect(transitions).toHaveLength(1);
  });

  it("releases an ambiguously-applied processing write that no upstream call followed", async () => {
    // The `reserved -> processing` write LANDED but its result came back
    // unknown, so the hook threw and `create_thread` was never reached. The
    // record is provably abandoned: settling must delete it rather than leave
    // it `processing` for the whole lease with nobody renewing it.
    const h = harness();
    const session = await claimOwner(h);
    // Apply the transition out of band, then report the client's view: failure.
    const claimed = JSON.parse(h.store.peek(STORAGE_KEY) as string) as Record<string, unknown>;
    const applied = JSON.stringify({
      v: 1,
      s: "processing",
      f: FINGERPRINT,
      o: claimed["o"],
      e: 1,
    });
    h.store.poke(STORAGE_KEY, applied);
    h.store.failNext("transition", "unavailable");
    expect(await session.markProcessing()).toBe("unavailable");

    await session.finish();
    expect(storedState(h)).toBeNull();
    // Both compare-and-delete attempts are owner guarded; the second one is the
    // fallback that recognizes the landed write.
    expect(h.store.calls).toContain(`release:reserved:${STORAGE_KEY}`);
    expect(h.store.calls).toContain(`release:processing:${STORAGE_KEY}`);
  });

  it("never deletes a processing record belonging to another owner", async () => {
    const h = harness();
    const session = await claimOwner(h);
    h.store.poke(
      STORAGE_KEY,
      JSON.stringify({ v: 1, s: "processing", f: FINGERPRINT, o: "b3RoZXItb3duZXI", e: 1 }),
    );
    h.store.failNext("transition", "unavailable");
    expect(await session.markProcessing()).toBe("unavailable");
    await session.finish();
    // The owner-token guard protects the other request's record.
    expect(storedState(h)).toBe("processing");
    expect(h.store.peek(STORAGE_KEY) as string).toContain("b3RoZXItb3duZXI");
  });

  it("keeps a reserved record when marking processing fails, and performs no commit", async () => {
    const h = harness();
    const session = await claimOwner(h);
    h.store.failNext("transition", "unavailable");
    expect(await session.markProcessing()).toBe("unavailable");
    expect(storedState(h)).toBe("reserved");
    // The route treats this as 503 and never calls the upstream; finish() then
    // frees the key so a retry is not blocked by a proven-failed attempt.
    await session.finish();
    expect(storedState(h)).toBeNull();
  });

  it("does NOT emit a success when the final write fails, and blocks with ambiguous", async () => {
    const h = harness();
    const session = await claimOwner(h);
    expect(await session.markProcessing()).toBe("ok");
    h.store.failNext("transition", "unavailable");
    expect(await session.commit(TEXT_RESULT)).toBe("unavailable");
    expect(storedState(h)).toBe("ambiguous");
    await session.finish();
    expect(storedState(h)).toBe("ambiguous");
  });

  it("returns unavailable when the claim itself fails or the store is down", async () => {
    const h = harness();
    h.store.failNext("claim", "unavailable");
    expect((await h.coordinator.begin(beginInput())).kind).toBe("unavailable");

    h.store.setReady(false);
    expect(h.coordinator.isAvailable()).toBe(false);
    expect((await h.coordinator.begin(beginInput())).kind).toBe("unavailable");
  });
});

describe("coordinator: conflict, replay, and waiting", () => {
  it("returns conflict for the same key with a different body in ANY state", async () => {
    for (const drive of [
      async (h: Harness): Promise<void> => {
        await claimOwner(h); // reserved
      },
      async (h: Harness): Promise<void> => {
        const s = await claimOwner(h);
        await s.markProcessing();
      },
      async (h: Harness): Promise<void> => {
        await commitOwner(h); // final
      },
      async (h: Harness): Promise<void> => {
        const s = await claimOwner(h);
        await s.markProcessing();
        await s.finish(); // ambiguous
      },
    ]) {
      const h = harness();
      await drive(h);
      const outcome = await h.coordinator.begin(beginInput({ bodyFingerprint: OTHER_FINGERPRINT }));
      expect(outcome.kind).toBe("conflict");
    }
  });

  it("replays a committed final record with the ORIGINAL identity and result", async () => {
    const h = harness();
    await commitOwner(h);
    const outcome = await h.coordinator.begin(
      beginInput({ identity: { id: "chatcmpl_ciq_duplicate", created: 999, model: "test-model" } }),
    );
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    const resolved = await outcome.resolve();
    expect(resolved).toEqual({
      kind: "cached",
      cached: { ...IDENTITY, result: TEXT_RESULT },
    });
  });

  it("replays validated tool calls unchanged", async () => {
    const h = harness();
    const calls: CachedResult = {
      kind: "tool_calls",
      toolCalls: [{ id: "call_ciq_01", name: "read", argumentsJson: '{"path":"a.txt"}' }],
    };
    await commitOwner(h, calls);
    const outcome = await h.coordinator.begin(beginInput());
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    const resolved = await outcome.resolve();
    expect(resolved).toEqual({ kind: "cached", cached: { ...IDENTITY, result: calls } });
  });

  it("waits while another request holds the claim, then replays its result", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();

    const outcome = await h.coordinator.begin(beginInput());
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    const waiting = outcome.resolve();
    // The owner commits while the waiter polls.
    await session.commit(TEXT_RESULT);
    await session.finish();
    expect(await waiting).toEqual({ kind: "cached", cached: { ...IDENTITY, result: TEXT_RESULT } });
  });

  it("fails closed (never takes over) when the record disappears mid-wait", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    const outcome = await h.coordinator.begin(beginInput());
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    h.store.drop(STORAGE_KEY);
    expect(await outcome.resolve()).toEqual({ kind: "unavailable" });
  });

  it("fails closed when an abandoned RESERVED lease expires mid-wait", async () => {
    // A `reserved` record carries the SHORT lease, so an owner that died before
    // taking capacity frees the key quickly. The waiter still never takes over.
    const h = harness({ sleepAdvancesMs: RESERVED_LEASE_MS + 1 });
    await claimOwner(h); // claimed but never advanced to `processing`
    const outcome = await h.coordinator.begin(beginInput());
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    expect(await outcome.resolve()).toEqual({ kind: "unavailable" });
  });

  it("keeps a PROCESSING record alive past the waiter's deadline", async () => {
    // The processing lease is derived from the request deadline, so a live
    // owner's record can never expire mid-completion — even with renewal
    // suppressed entirely, as here. The waiter therefore reaches its own
    // deadline (504) instead of observing a vanished record (503), which is what
    // stops a second replica from duplicating billed upstream work.
    const timeoutMs = 90_000;
    const h = harness({ sleepAdvancesMs: 10_000 });
    const session = await claimOwner(h);
    expect(await session.markProcessing()).toBe("ok");

    const outcome = await h.coordinator.begin(beginInput({ timeoutMs }));
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    expect(await outcome.resolve()).toEqual({ kind: "timeout" });
    // The record is still owned and still `processing` after the waiter gave up.
    expect(storedState(h)).toBe("processing");
    await session.finish();
  });

  it("derives the processing lease from the request deadline, within the cap", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    // Renewal is never triggered here; the record must survive the model's whole
    // deadline (90 s in `beginInput`) on the strength of the lease alone.
    h.advance(90_000);
    expect(storedState(h)).toBe("processing");
    await session.finish();
    // The lease is bounded even for the largest configurable model deadline.
    expect(MAX_PROCESSING_LEASE_MS).toBe(600_000 + PROCESSING_LEASE_MARGIN_MS);
  });

  it("times out at the request deadline exactly like an ordinary completion", async () => {
    const h = harness({ sleepAdvancesMs: 1_000 });
    const session = await claimOwner(h);
    await session.markProcessing();
    const outcome = await h.coordinator.begin(beginInput({ timeoutMs: 3_000 }));
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    // The owner keeps renewing, so the record never disappears; the waiter's own
    // deadline is what ends the wait.
    const waiting = outcome.resolve();
    for (let i = 0; i < 10; i += 1) h.renew();
    expect(await waiting).toEqual({ kind: "timeout" });
  });

  it("reports cancellation when the request signal aborts during the wait", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    const controller = new AbortController();
    const outcome = await h.coordinator.begin(beginInput({ signal: controller.signal }));
    if (outcome.kind !== "existing") throw new Error("expected an existing record");
    controller.abort();
    expect(await outcome.resolve()).toEqual({ kind: "cancelled" });
  });

  it("re-checks the fingerprint on EVERY poll, so a recycled key cannot leak an answer", async () => {
    // The record a waiter first observed can be released and re-claimed by a
    // DIFFERENT body while the waiter sleeps. Classifying only once would then
    // replay the wrong answer; the fingerprint must be re-validated per poll.
    const h = harness();
    const first = await claimOwner(h);
    await first.markProcessing();

    const outcome = await h.coordinator.begin(beginInput());
    if (outcome.kind !== "existing") throw new Error("expected an existing record");

    // The original owner disappears and a different body claims and commits.
    h.store.drop(STORAGE_KEY);
    const other = await h.coordinator.begin(beginInput({ bodyFingerprint: OTHER_FINGERPRINT }));
    if (other.kind !== "owner") throw new Error("expected a fresh claim");
    await other.session.markProcessing();
    await other.session.commit({ kind: "text", content: "the OTHER body's answer" });
    await other.session.finish();

    // The waiter must see a conflict, never the other body's content.
    const resolved = await outcome.resolve();
    expect(resolved).toEqual({ kind: "conflict" });
    expect(JSON.stringify(resolved)).not.toContain("OTHER body");
  });

  it("blocks on an ambiguous record for the TTL rather than duplicating work", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    await session.finish();
    expect((await h.coordinator.begin(beginInput())).kind).toBe("unavailable");
  });

  it("treats a corrupt or tampered record as unavailable, never replaying it", async () => {
    for (const raw of [
      "not json",
      '{"v":2,"s":"final","f":"x","o":"y","e":1}',
      `{"v":1,"s":"final","f":"${FINGERPRINT}","o":"b3duZXI","e":1,"p":{"i":"AAAAAAAAAAAAAAAA","c":"dGFtcGVyZWQ","t":"dGFn"}}`,
    ]) {
      const h = harness();
      h.store.poke(STORAGE_KEY, raw);
      expect((await h.coordinator.begin(beginInput())).kind).toBe("unavailable");
    }
  });

  it("refuses to replay a final record sealed under a DIFFERENT master key", async () => {
    // Simulates a rolling deployment with mismatched encryption keys: the
    // record authenticates against neither the storage key binding nor the
    // wrong AEAD key, so it fails closed instead of returning garbage.
    const h = harness();
    await commitOwner(h);
    const stolen = h.store.peek(STORAGE_KEY);
    expect(stolen).not.toBeNull();

    const otherKeyring = deriveIdempotencyKeyring(randomBytes(32).toString("base64url"));
    const otherStore = createFakeIdempotencyStore();
    const otherCoordinator = createIdempotencyCoordinator({
      store: otherStore,
      keyring: otherKeyring,
      namespace: NAMESPACE,
      ttlMs: TTL_MS,
      clock: { nowMs: () => 1_700_000_000_000 },
      sleeper: { sleep: () => Promise.resolve() },
    });
    // Place the ciphertext at the key THAT keyring would compute.
    otherStore.poke(buildStorageKey(otherKeyring, NAMESPACE, SCOPE, CLIENT_KEY), stolen as string);
    expect((await otherCoordinator.begin(beginInput())).kind).toBe("unavailable");
  });
});

describe("coordinator: scoping and lease renewal", () => {
  it("keeps separate gateway-key scopes from colliding", async () => {
    const h = harness();
    await commitOwner(h);
    // The SAME client key under a different gateway scope is an independent
    // record, so it claims cleanly rather than replaying another tenant's answer.
    const other = await h.coordinator.begin(beginInput({ gatewayKeyScope: "scope-bravo" }));
    expect(other.kind).toBe("owner");
  });

  it("keeps separate client keys from colliding within one scope", async () => {
    const h = harness();
    await commitOwner(h);
    expect((await h.coordinator.begin(beginInput({ clientKey: "client-key-2" }))).kind).toBe(
      "owner",
    );
  });

  it("renews an active lease without changing state", async () => {
    const h = harness();
    const session = await claimOwner(h);
    h.advance(RESERVED_LEASE_MS - 1);
    h.renew();
    await flush();
    // The lease was extended, so a second near-lease advance does not expire it.
    h.advance(RESERVED_LEASE_MS - 1);
    expect(storedState(h)).toBe("reserved");
    expect(session.ownershipLost).toBe(false);
    await session.finish();
  });

  it("never shortens a processing lease with a renewal that raced the transition", async () => {
    // The exact interleaving the review reproduced:
    //   1. Redis atomically applies `reserved -> processing`,
    //   2. its caller is STILL awaiting the reply, so local state says `reserved`,
    //   3. a renewal fires in that window.
    // If the renewal picked its lease from caller-local state it would PEXPIRE
    // the live `processing` record down to the 30 s reserved lease, letting it
    // expire mid-completion and allowing another replica to duplicate the work.
    const h = harness();
    const session = await claimOwner(h);
    expect(h.store.ttlMs(STORAGE_KEY)).toBe(RESERVED_LEASE_MS);

    // Apply the transition but withhold its reply.
    const releaseTransition = h.store.stallNextTransition();
    const pending = session.markProcessing();
    await flush();

    // The store has advanced; the caller has not observed it yet.
    expect(storedState(h)).toBe("processing");

    // Move the clock so the assertion below distinguishes THREE outcomes, not
    // two: a renewal that shortened the lease (the bug), a renewal that silently
    // no-op'd, and a renewal that correctly re-applied the processing lease.
    h.advance(5_000);
    expect(h.store.ttlMs(STORAGE_KEY)).toBe(90_000 + PROCESSING_LEASE_MARGIN_MS - 5_000);

    // Renew in exactly that window.
    h.renew();
    await flush();

    // The processing lease was applied — never the reserved one, and not a no-op.
    const expectedProcessingLease = 90_000 + PROCESSING_LEASE_MARGIN_MS;
    expect(h.store.ttlMs(STORAGE_KEY)).toBe(expectedProcessingLease);

    releaseTransition();
    expect(await pending).toBe("ok");
    // And the record survives well past the reserved lease.
    h.advance(RESERVED_LEASE_MS + 1);
    expect(storedState(h)).toBe("processing");
    expect(session.ownershipLost).toBe(false);
    await session.finish();
  });

  it("applies the reserved lease while the record is genuinely reserved", async () => {
    // The mirror of the case above: the store still selects per stored state, so
    // a pre-transition renewal must NOT be granted the longer processing lease.
    const h = harness();
    const session = await claimOwner(h);
    h.advance(1_000);
    h.renew();
    await flush();
    expect(h.store.ttlMs(STORAGE_KEY)).toBe(RESERVED_LEASE_MS);
    await session.finish();
  });

  it("aborts the request and never permits takeover when renewal is lost", async () => {
    for (const fault of ["unavailable", "corrupt"] as const) {
      const h = harness();
      const session = await claimOwner(h);
      await session.markProcessing();
      h.store.failNext("renew", fault);
      h.renew();
      await flush();
      expect(session.ownershipLost).toBe(true);
      expect(session.signal.aborted).toBe(true);
      // A lost claim can no longer commit.
      expect(await session.commit(TEXT_RESULT)).toBe("unavailable");
      await session.finish();
    }
  });

  it("aborts when the record was taken by a different owner token", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    // Another owner token now holds the key (e.g. the lease expired and a later
    // request claimed it).
    h.store.poke(
      STORAGE_KEY,
      JSON.stringify({ v: 1, s: "reserved", f: FINGERPRINT, o: "b3RoZXItb3duZXI", e: 1 }),
    );
    h.renew();
    await flush();
    expect(session.ownershipLost).toBe(true);
    // finish() must NOT destroy the other owner's record.
    await session.finish();
    const raw = h.store.peek(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw as string).toContain("b3RoZXItb3duZXI");
  });

  it("uses a real unref'd interval when no scheduler seam is injected", async () => {
    // Every other test injects `scheduleRenewal`, so the PRODUCTION timer path
    // (setInterval + unref + clearInterval) would otherwise be covered only by
    // the Redis-gated suite and never inside `npm run validate`.
    const store = createFakeIdempotencyStore();
    const coordinator = createIdempotencyCoordinator({
      store,
      keyring: KEYRING,
      namespace: NAMESPACE,
      ttlMs: TTL_MS,
      clock: { nowMs: () => Date.now() },
      sleeper: { sleep: () => Promise.resolve() },
      // scheduleRenewal deliberately omitted.
    });

    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const outcome = await coordinator.begin(beginInput());
    if (outcome.kind !== "owner") throw new Error("expected owner");

    // The interval exists but is unref'd, so it can never hold the process open.
    const during = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(during).toBe(before);

    // ...and settling clears it, leaving no handle behind.
    await outcome.session.finish();
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBe(before);
  });

  it("stops renewing once committed", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    await session.commit(TEXT_RESULT);
    const before = h.store.calls.filter((c) => c.startsWith("renew")).length;
    h.renew();
    await flush();
    expect(h.store.calls.filter((c) => c.startsWith("renew"))).toHaveLength(before);
    expect(session.ownershipLost).toBe(false);
  });
});

describe("coordinator: stored content safety", () => {
  it("never writes prompt, answer, client key, or scope material into Redis", async () => {
    const h = harness();
    const session = await claimOwner(h);
    await session.markProcessing();
    await session.commit({ kind: "text", content: "ANSWER-SENTINEL-42" });
    const raw = h.store.peek(STORAGE_KEY) as string;
    for (const sentinel of ["ANSWER-SENTINEL-42", CLIENT_KEY, SCOPE, IDENTITY.id, IDENTITY.model]) {
      expect(raw).not.toContain(sentinel);
    }
    // The KEY itself is an HMAC, not the client's value.
    expect(STORAGE_KEY).not.toContain(CLIENT_KEY);
    expect(STORAGE_KEY).not.toContain(SCOPE);
    await session.finish();
  });

  it("exposes the body fingerprinter without exposing its subkey", () => {
    const h = harness();
    const first = h.coordinator.fingerprintBody({ a: 1, b: 2 });
    const reordered = h.coordinator.fingerprintBody({ b: 2, a: 1 });
    expect(first.ok && reordered.ok && first.fingerprint === reordered.fingerprint).toBe(true);
    expect(h.coordinator.fingerprintBody({ a: undefined })).toEqual({ ok: false });
  });
});
