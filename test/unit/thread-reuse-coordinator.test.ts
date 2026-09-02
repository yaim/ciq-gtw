/**
 * The thread-reuse state machine (Phase 5A; specification section 5.1.1).
 *
 * These tests drive the real coordinator against the in-memory store fake,
 * which reproduces the Lua guards — owner token, expected state, and the
 * IN-RECORD lease deadline that lets a record outlive its lease. What they
 * assert is the contract a stateful upstream mapping lives or dies by: that two
 * requests can never both address one session's thread, that a proven pre-submit
 * failure costs the session nothing, that anything at or after a possible submit
 * blocks rather than guesses, and that nothing sensitive reaches Redis.
 *
 * Every value here is synthetic.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MODEL_CONFIG_LIMITS,
  THREAD_REUSE_LIMITS,
  type VirtualModel,
} from "../../src/config/schema.js";
import {
  buildMappingIdentityDigest,
  buildReuseStorageKey,
  createThreadReuseCoordinator,
  decodeReuseRecord,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  MAX_REUSE_PROCESSING_LEASE_MS,
  openThreadId,
  REUSE_COMMITTED_TTL_MS,
  REUSE_AMBIGUOUS_TTL_MS,
  REUSE_LEASE_MS,
  REUSE_PROCESSING_LEASE_MARGIN_MS,
  sealThreadId,
  type ThreadReuseCoordinator,
  type ThreadReuseSession,
} from "../../src/thread-reuse/index.js";
import {
  createFakeThreadReuseStore,
  type FakeThreadReuseStore,
} from "../support/fake-thread-reuse-store.js";

const MASTER_KEY = randomBytes(32).toString("base64url");
const KEYRING = deriveThreadReuseKeyring(MASTER_KEY);
const NAMESPACE = "test-ns";
const ORIGIN = "https://api.example.invalid";

const GATEWAY_KEY_SENTINEL = "gw-fake-key-SENTINEL";
const SESSION_SENTINEL = "ses_fake_SENTINEL";
const THREAD_SENTINEL = "thread-SENTINEL-991";
const UPSTREAM_CREDENTIAL_SENTINEL = "sk-fake-upstream-SENTINEL";

const SCOPE = deriveThreadReuseScope(KEYRING, GATEWAY_KEY_SENTINEL);
const PRINCIPAL = deriveUpstreamPrincipalFingerprint(KEYRING, {
  authMode: "bearer",
  credentialMaterial: UPSTREAM_CREDENTIAL_SENTINEL,
});
const MAPPING_TTL_MS = 604_800_000;

function model(over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: "collectiviq-claude-direct",
    displayName: "direct",
    selectedLlms: ["claude"],
    generateCombined: false,
    answerSource: "claude",
    toolMode: "disabled",
    promptMode: "direct",
    requestTimeoutMs: 90_000,
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 5_000,
    maximumPromptBytes: 6_291_456,
    ...over,
  };
}

interface Harness {
  readonly coordinator: ThreadReuseCoordinator;
  readonly store: FakeThreadReuseStore;
  /** Fire the renewal timer for every live session. */
  tick(): void;
  readonly key: string;
  /** The storage key for a non-default model policy. */
  keyFor(model: VirtualModel): string;
}

function harness(): Harness {
  const store = createFakeThreadReuseStore();
  const renewals: (() => void)[] = [];
  const coordinator = createThreadReuseCoordinator({
    store,
    keyring: KEYRING,
    namespace: NAMESPACE,
    origin: ORIGIN,
    principalFingerprint: PRINCIPAL,
    mappingTtlMs: MAPPING_TTL_MS,
    scheduleRenewal: (fn) => {
      renewals.push(fn);
      return { cancel: () => renewals.splice(renewals.indexOf(fn), 1) };
    },
  });
  const keyFor = (policy: VirtualModel): string =>
    buildReuseStorageKey(KEYRING, NAMESPACE, {
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      policyFingerprint: deriveModelPolicyFingerprint(KEYRING, policy),
      origin: ORIGIN,
      principalFingerprint: PRINCIPAL,
    });
  return {
    coordinator,
    store,
    tick: () => {
      for (const fn of [...renewals]) fn();
    },
    key: keyFor(model()),
    keyFor,
  };
}

async function lease(
  coordinator: ThreadReuseCoordinator,
  over: { sessionId?: string; model?: VirtualModel; gatewayKeyScope?: string } = {},
): Promise<ThreadReuseSession> {
  const outcome = await coordinator.acquire({
    gatewayKeyScope: over.gatewayKeyScope ?? SCOPE,
    sessionId: over.sessionId ?? SESSION_SENTINEL,
    model: over.model ?? model(),
  });
  if (outcome.kind !== "leased") throw new Error(`expected a lease, got ${outcome.kind}`);
  return outcome.session;
}

/** Drive a complete successful turn: bind if needed, submit, finalize. */
async function completeTurn(
  session: ThreadReuseSession,
  threadId = THREAD_SENTINEL,
): Promise<void> {
  if (session.existingThreadId === null) {
    expect(await session.bindThread(threadId)).toBe("ok");
  }
  expect(await session.markProcessing()).toBe("ok");
  expect(await session.finalize()).toBe("ok");
  await session.finish();
}

describe("thread-reuse coordinator", () => {
  it("reports availability from the store and never throws", () => {
    const h = harness();
    expect(h.coordinator.isAvailable()).toBe(true);
    h.store.setReady(false);
    expect(h.coordinator.isAvailable()).toBe(false);
  });

  it("creates a bare reservation for a new session, then reuses the bound thread", async () => {
    const h = harness();
    const first = await lease(h.coordinator);
    expect(first.existingThreadId).toBeNull();
    await completeTurn(first);

    const stored = h.store.peekRecord(h.key);
    expect(stored?.s).toBe("active");
    expect(stored?.l).toBe(0);

    const second = await lease(h.coordinator);
    expect(second.existingThreadId).toBe(THREAD_SENTINEL);
    // A carried-over thread is already bound; binding again is refused.
    expect(await second.bindThread("thread-other")).toBe("unavailable");
    await completeTurn(second);
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
  });

  it("keeps using one thread across many sequential turns (no hidden turn cap)", async () => {
    const h = harness();
    const first = await lease(h.coordinator);
    await completeTurn(first);
    for (let turn = 2; turn <= 40; turn += 1) {
      const session = await lease(h.coordinator);
      expect(session.existingThreadId).toBe(THREAD_SENTINEL);
      await completeTurn(session);
    }
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
  });

  it("resets the sliding mapping TTL on every turn", async () => {
    const h = harness();
    await completeTurn(await lease(h.coordinator));
    expect(h.store.ttlMs(h.key)).toBe(MAPPING_TTL_MS);
    h.store.advance(MAPPING_TTL_MS - 1_000);
    expect(h.store.ttlMs(h.key)).toBe(1_000);
    await completeTurn(await lease(h.coordinator));
    expect(h.store.ttlMs(h.key)).toBe(MAPPING_TTL_MS);
  });

  it("forgets the mapping after the idle TTL, and the next turn starts fresh", async () => {
    const h = harness();
    await completeTurn(await lease(h.coordinator));
    h.store.advance(MAPPING_TTL_MS + 1);
    expect(h.store.peek(h.key)).toBeNull();
    const next = await lease(h.coordinator);
    expect(next.existingThreadId).toBeNull();
  });

  it("reports `busy` for a second concurrent turn on the same session", async () => {
    const h = harness();
    const held = await lease(h.coordinator);
    expect(held.existingThreadId).toBeNull();
    const competing = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(competing.kind).toBe("busy");
    // Also busy once the first turn is mid-submit.
    expect(await held.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await held.markProcessing()).toBe("ok");
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("busy");
  });

  it("gives different sessions, keys, model policies, and principals separate mappings", async () => {
    const h = harness();
    const held = await lease(h.coordinator);
    expect(await held.bindThread(THREAD_SENTINEL)).toBe("ok");

    // None of these collide with the held mapping, so all four are grantable
    // even while the first session's lease is live.
    for (const over of [
      { sessionId: "ses_fake_other" },
      { gatewayKeyScope: deriveThreadReuseScope(KEYRING, "gw-fake-key-bravo") },
      { model: model({ answerSource: "gpt" }) },
    ]) {
      const other = await lease(h.coordinator, over);
      expect(other.existingThreadId).toBeNull();
    }

    // A different upstream principal or origin is a different coordinator
    // instance, and therefore a different mapping for the SAME session.
    const otherPrincipal = createThreadReuseCoordinator({
      store: h.store,
      keyring: KEYRING,
      namespace: NAMESPACE,
      origin: ORIGIN,
      principalFingerprint: deriveUpstreamPrincipalFingerprint(KEYRING, {
        authMode: "password",
        credentialMaterial: "user-fake",
      }),
      mappingTtlMs: MAPPING_TTL_MS,
      scheduleRenewal: () => ({ cancel: () => undefined }),
    });
    expect((await lease(otherPrincipal)).existingThreadId).toBeNull();

    const otherOrigin = createThreadReuseCoordinator({
      store: h.store,
      keyring: KEYRING,
      namespace: NAMESPACE,
      origin: "https://api.other.invalid",
      principalFingerprint: PRINCIPAL,
      mappingTtlMs: MAPPING_TTL_MS,
      scheduleRenewal: () => ({ cancel: () => undefined }),
    });
    expect((await lease(otherOrigin)).existingThreadId).toBeNull();
  });

  it("restores the previous active mapping when a turn fails before submitting", async () => {
    const h = harness();
    await completeTurn(await lease(h.coordinator));

    const aborted = await lease(h.coordinator);
    expect(aborted.existingThreadId).toBe(THREAD_SENTINEL);
    // Capacity rejection, cancellation, or a failed pre-submit transition.
    await aborted.finish();
    const stored = h.store.peekRecord(h.key);
    expect(stored?.s).toBe("active");

    const next = await lease(h.coordinator);
    expect(next.existingThreadId).toBe(THREAD_SENTINEL);
  });

  it("deletes a never-bound reservation so a failed first turn costs nothing", async () => {
    const h = harness();
    const aborted = await lease(h.coordinator);
    expect(aborted.existingThreadId).toBeNull();
    await aborted.finish();
    expect(h.store.peek(h.key)).toBeNull();
    expect(h.store.keys()).toEqual([]);
  });

  it("keeps a bound-but-unsubmitted thread, so a post-create failure leaves no orphan mapping", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    // `markProcessing` never ran, so the thread is blank and provably unused.
    await session.finish();
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
    expect((await lease(h.coordinator)).existingThreadId).toBe(THREAD_SENTINEL);
  });

  it("blocks the session as `ambiguous` when a turn fails at or after the submit", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    // Upstream failure, timeout, disconnect, or shutdown.
    await session.finish();

    const stored = h.store.peekRecord(h.key);
    expect(stored?.s).toBe("ambiguous");
    // The tombstone drops the thread: it is never reused.
    expect(stored?.p).toBeUndefined();
    expect(h.store.ttlMs(h.key)).toBe(REUSE_AMBIGUOUS_TTL_MS);

    const blocked = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(blocked.kind).toBe("unavailable");

    // After the ambiguous window the session may start a NEW thread.
    h.store.advance(REUSE_AMBIGUOUS_TTL_MS + 1);
    expect((await lease(h.coordinator)).existingThreadId).toBeNull();
  });

  it("keeps a leased record alive past its own lease, even on the shortest mapping TTL", async () => {
    // MUTATION GUARD for the TTL policy. Configuration permits a 5-minute
    // mapping TTL alongside a 10-minute model deadline, so writing every record
    // with only the mapping TTL would let a `processing` key EXPIRE while its
    // lease was still live. The record would simply vanish instead of becoming
    // `ambiguous`, and the next turn would silently start a replacement thread
    // while the previous submit might still be running upstream.
    const store = createFakeThreadReuseStore();
    const shortTtl = createThreadReuseCoordinator({
      store,
      keyring: KEYRING,
      namespace: NAMESPACE,
      origin: ORIGIN,
      principalFingerprint: PRINCIPAL,
      mappingTtlMs: THREAD_REUSE_LIMITS.ttlMs.min,
      scheduleRenewal: () => ({ cancel: () => undefined }),
    });
    const slowest = model({ requestTimeoutMs: MODEL_CONFIG_LIMITS.requestTimeoutMs.max });
    const key = buildReuseStorageKey(KEYRING, NAMESPACE, {
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      policyFingerprint: deriveModelPolicyFingerprint(KEYRING, slowest),
      origin: ORIGIN,
      principalFingerprint: PRINCIPAL,
    });

    const session = await lease(shortTtl, { model: slowest });
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    const record = store.peekRecord(key);
    const leaseRemaining = (record?.l ?? 0) - 1_700_000_000_000;
    const keyLifetime = store.ttlMs(key) ?? 0;
    expect(leaseRemaining).toBe(MAX_REUSE_PROCESSING_LEASE_MS);
    expect(leaseRemaining).toBeGreaterThan(THREAD_REUSE_LIMITS.ttlMs.min);
    // The key must outlive the lease it carries, with room for a competitor to
    // observe the expired lease and tombstone it.
    expect(keyLifetime).toBeGreaterThanOrEqual(leaseRemaining);
    expect(keyLifetime).toBe(MAX_REUSE_PROCESSING_LEASE_MS + REUSE_AMBIGUOUS_TTL_MS);

    // And the conversion actually happens once the lease elapses.
    store.advance(leaseRemaining + 1);
    expect(store.peekRecord(key)?.s).toBe("processing");
    const competitor = await shortTtl.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: slowest,
    });
    expect(competitor.kind).toBe("unavailable");
    expect(store.peekRecord(key)?.s).toBe("ambiguous");
  });

  it("acknowledges a commit whose first reply was lost, and still succeeds", async () => {
    // MUTATION GUARD for acknowledgement safety. Redis APPLIED the transition
    // but the reply never arrived. A non-idempotent single-step terminal write
    // would report failure here while the mapping silently became reusable —
    // the client gets `503` and a later turn continues a thread whose answer was
    // never delivered.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    h.store.loseReplyNext("commit");
    expect(await session.finalize()).toBe("ok");
    // Two commit attempts: the applied-but-lost one, then the idempotent retry.
    expect(h.store.calls.filter((c) => c.startsWith("commit:"))).toHaveLength(2);
    // The load-bearing assertion. The retry must have observed a record that had
    // ALREADY advanced — that is what "the mutation applied, the reply was lost"
    // means, and it is the only thing distinguishing this from a first attempt
    // that never mutated at all. Asserting the outcome alone would pass against
    // a store that simply failed before writing.
    expect(h.store.observedStates("commit")).toEqual(["processing", "committed"]);
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
    await session.finish();
  });

  it("never activates a mapping whose commit could not be acknowledged", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    // Both the write and its retry are undecided.
    h.store.failNext("commit", "unavailable");
    h.store.failNext("commit", "unavailable");
    expect(await session.finalize()).toBe("unavailable");

    const record = h.store.peekRecord(h.key);
    expect(record?.s).toBe("ambiguous");
    expect(record?.s).not.toBe("active");
    // Never acquirable afterwards.
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("unavailable");
  });

  it("tombstones a commit that landed but was never acknowledged", async () => {
    // The nastiest ordering: the first attempt mutates and loses its reply, the
    // retry is also undecided. The record IS `committed`, which the caller does
    // not know — so settlement must be able to retire a `committed` record too.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    h.store.loseReplyNext("commit");
    h.store.failNext("commit", "unavailable");
    expect(await session.finalize()).toBe("unavailable");
    await session.finish();

    // The first attempt really did write `committed`; settlement had to retire
    // that state, not the `processing` one the caller still believed in.
    expect(h.store.observedStates("commit")).toEqual(["processing"]);
    expect(h.store.peekRecord(h.key)?.s).toBe("ambiguous");
  });

  it("still succeeds when an APPLIED activation loses its reply", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    h.store.loseReplyNext("activate");
    // The commit was acknowledged, so the answer is authorized: an undecided
    // activation must not turn a delivered answer into a `503`.
    expect(await session.finalize()).toBe("ok");
    await session.finish();
    // Settlement's retry observed the record ALREADY active, proving the first
    // activation really applied before its reply vanished.
    expect(h.store.observedStates("activate")).toEqual(["committed", "active"]);
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
  });

  it("succeeds and retries activation during settlement when it was undecided", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    h.store.failNext("activate", "unavailable");
    expect(await session.finalize()).toBe("ok");
    // Not yet reusable, and deliberately not acquirable in the meantime.
    expect(h.store.peekRecord(h.key)?.s).toBe("committed");

    await session.finish();
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
  });

  it("leaves a bounded, non-acquirable `committed` record when activation never confirms", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    h.store.failNext("activate", "unavailable");
    expect(await session.finalize()).toBe("ok");
    h.store.failNext("activate", "unavailable");
    await session.finish();

    const record = h.store.peekRecord(h.key);
    expect(record?.s).toBe("committed");
    expect(h.store.ttlMs(h.key)).toBe(REUSE_COMMITTED_TTL_MS);
    // Blocked, never handed out...
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("unavailable");
    // ...and the block clears when the bounded window elapses.
    h.store.advance(REUSE_COMMITTED_TTL_MS + 1);
    expect((await lease(h.coordinator)).existingThreadId).toBeNull();
  });

  it("tombstones a genuinely absent record at activation instead of leaving a clean slate", async () => {
    // REGRESSION for the worst reuse failure there is: a SILENT one.
    //
    // The commit is acknowledged, then the record vanishes (eviction, operator
    // delete, expiry). If activation merely reported `missing`, the key would
    // stay ABSENT — and the session's next turn would see no mapping, create a
    // replacement thread, and quietly lose the conversation. A visible `503`
    // that blocks is strictly better than an invisible break in continuity.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    // The record is PHYSICALLY removed just before activation reads it. This is
    // deliberately not `failNext("activate", "missing")`, which returns before
    // reading and would leave the record in place — making any assertion about
    // the resulting state self-fulfilling.
    h.store.dropBeforeNext("activate");
    expect(await session.finalize()).toBe("unavailable");
    expect(h.store.observedStates("activate")).toEqual(["missing"]);

    // Absence was converted into a bounded tombstone, not left as a clean slate.
    const record = h.store.peekRecord(h.key);
    expect(record?.s).toBe("ambiguous");
    expect(record?.p).toBeUndefined();
    expect(h.store.ttlMs(h.key)).toBe(REUSE_AMBIGUOUS_TTL_MS);

    await session.finish();
    expect(h.store.peekRecord(h.key)?.s).toBe("ambiguous");

    // The next turn is BLOCKED rather than silently starting a new thread...
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("unavailable");

    // ...and only once the ambiguous window elapses may a fresh mapping form.
    h.store.advance(REUSE_AMBIGUOUS_TTL_MS + 1);
    const fresh = await lease(h.coordinator);
    expect(fresh.existingThreadId).toBeNull();
  });

  it.each(["lost", "state", "corrupt"] as const)(
    "fails closed on a DEFINITIVE `%s` activation and never lets the mapping become active",
    async (fault) => {
      // REGRESSION: a definitive activation failure must touch the record NO
      // further. Settling would retry activation, so a transient fault would be
      // followed by a successful retry — the client receiving `503` while the
      // mapping quietly became reusable, which is the exact hazard the two-step
      // transition exists to prevent.
      const h = harness();
      const session = await lease(h.coordinator);
      expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
      expect(await session.markProcessing()).toBe("ok");

      h.store.failNext("activate", fault);
      expect(await session.finalize()).toBe("unavailable");
      expect(h.store.peekRecord(h.key)?.s).not.toBe("active");

      // Settlement must not retry activation. A one-shot fault followed by a
      // retry is exactly how a `503` turns into a reusable mapping.
      await session.finish();
      expect(h.store.calls.filter((c) => c.startsWith("activate:"))).toHaveLength(1);
      expect(h.store.peekRecord(h.key)?.s).not.toBe("active");
      // Nor may it be tombstoned, restored, or otherwise rewritten.
      expect(h.store.peekRecord(h.key)?.s).toBe("committed");
    },
  );

  it("stops renewing once the commit is acknowledged, so no late abort can fire", async () => {
    // REGRESSION: a `committed` record is deliberately not renewable. If the
    // renewal timer survived an unconfirmed activation, its next attempt would
    // come back `state`, lose the lease, and abort the request's signal AFTER
    // the answer was authorized — cancelling the response mid-write, most
    // visibly mid-SSE.
    let tick: (() => void) | null = null;
    const store = createFakeThreadReuseStore();
    const coordinator = createThreadReuseCoordinator({
      store,
      keyring: KEYRING,
      namespace: NAMESPACE,
      origin: ORIGIN,
      principalFingerprint: PRINCIPAL,
      mappingTtlMs: MAPPING_TTL_MS,
      scheduleRenewal: (fn) => {
        tick = fn;
        return {
          cancel: () => {
            tick = null;
          },
        };
      },
    });

    const session = await lease(coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    expect(tick).not.toBeNull();

    store.failNext("activate", "unavailable");
    expect(await session.finalize()).toBe("ok");

    // The timer is cancelled, so nothing can abort the signal afterwards.
    expect(tick).toBeNull();
    expect(session.leaseLost).toBe(false);
    expect(session.signal.aborted).toBe(false);
    await session.finish();
    expect(session.signal.aborted).toBe(false);
  });

  it("refuses to hand a `committed` mapping to another owner mid-finalization", async () => {
    // Cross-owner interleaving: finalization uncertainty must never become an
    // active mapping for someone else while the original request reports `503`.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");

    h.store.failNext("activate", "unavailable");
    expect(await session.finalize()).toBe("ok");
    expect(h.store.peekRecord(h.key)?.s).toBe("committed");

    // A competitor can neither reserve nor advance it, now or after the lease
    // window a `processing` record would have exposed.
    for (const advance of [0, REUSE_LEASE_MS * 4]) {
      h.store.advance(advance);
      const competitor = await h.coordinator.acquire({
        gatewayKeyScope: SCOPE,
        sessionId: SESSION_SENTINEL,
        model: model(),
      });
      expect(competitor.kind).toBe("unavailable");
      expect(h.store.peekRecord(h.key)?.s).toBe("committed");
    }
  });

  it("blocks rather than emits when finalization fails", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    // BOTH attempts must be undecided: a single failure is now recoverable by
    // the idempotent retry, which is the point of the two-step transition.
    h.store.failNext("commit", "unavailable");
    h.store.failNext("commit", "unavailable");
    expect(await session.finalize()).toBe("unavailable");
    // The mapping is tombstoned, so the next turn cannot silently continue a
    // thread whose latest turn the gateway could not record.
    expect(h.store.peekRecord(h.key)?.s).toBe("ambiguous");
    await session.finish();
  });

  it("gives a `processing` mapping a lease that outlives the request's own deadline", async () => {
    // MUTATION GUARD. A fixed short lease for both states would reintroduce the
    // exact starvation race Phase 4A's derived lease exists to prevent: under
    // event-loop starvation the renewals that keep a 30 s lease alive are the
    // first thing to stall, so a HEALTHY long completion could have its mapping
    // tombstoned underneath it and its session blocked for 15 minutes.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    const reservedLease = (h.store.peekRecord(h.key)?.l ?? 0) - 1_700_000_000_000;
    expect(reservedLease).toBe(REUSE_LEASE_MS);

    expect(await session.markProcessing()).toBe("ok");
    const processingLease = (h.store.peekRecord(h.key)?.l ?? 0) - 1_700_000_000_000;
    // 90 s model deadline + the 30 s margin.
    expect(processingLease).toBe(model().requestTimeoutMs + REUSE_PROCESSING_LEASE_MARGIN_MS);
    expect(processingLease).toBeGreaterThan(REUSE_LEASE_MS);

    // A stall far longer than the reserved lease leaves the live owner's mapping
    // intact, so a competitor still sees it as busy rather than tombstoning it.
    h.store.advance(REUSE_LEASE_MS * 3);
    const competing = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(competing.kind).toBe("busy");
    expect(h.store.peekRecord(h.key)?.s).toBe("processing");
    expect(await session.finalize()).toBe("ok");
  });

  it("caps the processing lease for a model with a very long deadline", async () => {
    const h = harness();
    const slow = model({ requestTimeoutMs: 600_000 });
    const session = await lease(h.coordinator, { model: slow });
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    const applied = (h.store.peekRecord(h.keyFor(slow)) ?? { l: 0 }).l - 1_700_000_000_000;
    expect(applied).toBe(MAX_REUSE_PROCESSING_LEASE_MS);
  });

  it("renews a `processing` mapping with the LONG lease, not the reserved one", async () => {
    // The renewal must read the stored state: a caller whose view still says
    // `reserved` must not be able to shorten a live `processing` lease.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    h.store.advance(5_000);
    h.tick();
    await Promise.resolve();
    const renewed = (h.store.peekRecord(h.key)?.l ?? 0) - (1_700_000_000_000 + 5_000);
    expect(renewed).toBe(model().requestTimeoutMs + REUSE_PROCESSING_LEASE_MARGIN_MS);
  });

  it("recovers a crashed pre-submit reservation on the next acquire, thread and all", async () => {
    const h = harness();
    await completeTurn(await lease(h.coordinator));
    const crashed = await lease(h.coordinator);
    expect(crashed.existingThreadId).toBe(THREAD_SENTINEL);
    // The owner disappears without settling; only its lease elapses.
    h.store.advance(REUSE_LEASE_MS + 1);
    expect(h.store.peekRecord(h.key)?.s).toBe("reserved");
    const recovered = await lease(h.coordinator);
    expect(recovered.existingThreadId).toBe(THREAD_SENTINEL);
  });

  it("turns a crashed mid-submit lease into `ambiguous`, never into a reusable mapping", async () => {
    const h = harness();
    const crashed = await lease(h.coordinator);
    expect(await crashed.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await crashed.markProcessing()).toBe("ok");

    // Only once the DERIVED processing lease elapses — not the short reserved
    // one — is the owner presumed dead.
    h.store.advance(model().requestTimeoutMs + REUSE_PROCESSING_LEASE_MARGIN_MS + 1);
    const outcome = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(outcome.kind).toBe("unavailable");
    expect(h.store.peekRecord(h.key)?.s).toBe("ambiguous");
  });

  it("renews the lease from the AUTHORITATIVE stored state", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    const before = h.store.peekRecord(h.key)?.l ?? 0;

    h.store.advance(10_000);
    h.tick();
    await Promise.resolve();
    expect(h.store.peekRecord(h.key)?.l).toBe(before + 10_000);

    // A renewal that races the transition must not misapply a state: after
    // `markProcessing` the renewal keeps the record `processing`.
    expect(await session.markProcessing()).toBe("ok");
    h.store.advance(10_000);
    h.tick();
    await Promise.resolve();
    expect(h.store.peekRecord(h.key)?.s).toBe("processing");
    expect(session.leaseLost).toBe(false);
  });

  it("never revives a finalized mapping through a stray renewal", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    expect(await session.finalize()).toBe("ok");
    h.tick();
    await Promise.resolve();
    const stored = h.store.peekRecord(h.key);
    expect(stored?.s).toBe("active");
    expect(stored?.l).toBe(0);
  });

  it("stops a starved owner from submitting after its reservation was taken over", async () => {
    // MUTATION GUARD, and the reason a SHORT `reserved` lease is safe at all.
    // A starved owner that wakes up after another replica took its reservation
    // must not submit: two requests writing into one thread would interleave two
    // conversations and make both delta polls meaningless. The owner-token guard
    // on `reserved → processing` is the only thing standing between them, and no
    // code path submits without that transition succeeding first.
    const h = harness();
    const starved = await lease(h.coordinator);
    expect(await starved.bindThread(THREAD_SENTINEL)).toBe("ok");

    h.store.advance(REUSE_LEASE_MS + 1);
    const taker = await lease(h.coordinator);
    expect(taker.existingThreadId).toBe(THREAD_SENTINEL);

    // The starved owner can no longer advance, bind, or finalize anything.
    expect(await starved.markProcessing()).toBe("unavailable");
    expect(await starved.finalize()).toBe("unavailable");
    // ...and settling it must not damage the mapping the taker now owns.
    await starved.finish();
    const stored = h.store.peekRecord(h.key);
    // Still the taker's live reservation: not deleted, and not rewound to
    // `active` by the previous owner's release.
    expect(stored?.s).toBe("reserved");
    expect(stored?.p).toBeDefined();
    expect(await taker.markProcessing()).toBe("ok");
    expect(await taker.finalize()).toBe("ok");
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
  });

  it("aborts the request when the lease is lost", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(session.signal.aborted).toBe(false);

    // Another replica took the mapping over.
    h.store.failNext("renew", "unavailable");
    h.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.leaseLost).toBe(true);
    expect(session.signal.aborted).toBe(true);
    // A lost lease can no longer advance the mapping.
    expect(await session.markProcessing()).toBe("unavailable");
    expect(await session.finalize()).toBe("unavailable");
  });

  it("fails closed on every non-throwing store failure", async () => {
    const h = harness();
    h.store.setReady(false);
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("unavailable");

    h.store.setReady(true);
    h.store.failNext("acquire", "corrupt");
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("unavailable");

    const session = await lease(h.coordinator);
    h.store.failNext("bind", "unavailable");
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("unavailable");
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    h.store.failNext("markProcessing", "corrupt");
    expect(await session.markProcessing()).toBe("unavailable");
  });

  it("fails closed on a corrupt stored record without destroying the mapping", async () => {
    const h = harness();
    await completeTurn(await lease(h.coordinator));
    h.store.poke(h.key, '{"v":1,"s":"active","o":"b3Jhbmdl","l":0}', MAPPING_TTL_MS);
    const outcome = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(outcome.kind).toBe("unavailable");
    // Never deleted: silently starting a replacement thread is exactly the
    // behaviour this feature must not have.
    expect(h.store.peek(h.key)).not.toBeNull();
  });

  it("treats an unknown stored state as corrupt rather than a takeover candidate", async () => {
    const h = harness();
    h.store.poke(h.key, '{"v":1,"s":"nope","o":"b3Jhbmdl","l":0}', MAPPING_TTL_MS);
    const outcome = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(outcome.kind).toBe("unavailable");
    expect(h.store.peek(h.key)).not.toBeNull();
  });

  it("fails closed on a sealed thread it cannot authenticate, and lets it AGE OUT", async () => {
    const h = harness();
    // A ciphertext sealed for a DIFFERENT mapping, relocated to this key.
    const foreign = sealThreadId(KEYRING.aeadKey, THREAD_SENTINEL, {
      recordVersion: 1,
      storageKey: "test-ns:reuse:elsewhere",
      mappingIdentityDigest: "elsewhere",
    });
    expect(foreign).not.toBeNull();
    h.store.poke(
      h.key,
      JSON.stringify({ v: 1, s: "active", o: "b3Jhbmdl", l: 0, p: foreign }),
      MAPPING_TTL_MS,
    );
    const outcome = await h.coordinator.acquire({
      gatewayKeyScope: SCOPE,
      sessionId: SESSION_SENTINEL,
      model: model(),
    });
    expect(outcome.kind).toBe("unavailable");

    // MUTATION GUARD. Restoring the mapping here instead of tombstoning it would
    // reset the seven-day sliding TTL on every retry, so an unusable ciphertext
    // would pin the session on a permanent 503 that never ages out. It must be
    // retired under the SHORT ambiguous TTL — still never deleted outright,
    // which would silently start a replacement thread on the next request.
    const tombstone = h.store.peekRecord(h.key);
    expect(tombstone?.s).toBe("ambiguous");
    expect(tombstone?.p).toBeUndefined();
    expect(h.store.ttlMs(h.key)).toBe(REUSE_AMBIGUOUS_TTL_MS);

    // Retrying keeps failing closed, and keeps the bounded window bounded.
    h.store.advance(REUSE_AMBIGUOUS_TTL_MS - 1_000);
    expect(
      (
        await h.coordinator.acquire({
          gatewayKeyScope: SCOPE,
          sessionId: SESSION_SENTINEL,
          model: model(),
        })
      ).kind,
    ).toBe("unavailable");
    expect(h.store.ttlMs(h.key)).toBe(1_000);

    // ...and once it elapses the session starts cleanly on a new thread.
    h.store.advance(2_000);
    expect((await lease(h.coordinator)).existingThreadId).toBeNull();
  });

  it("tombstones when its own `reserved → processing` write landed but the reply was lost", async () => {
    // MUTATION GUARD for the `release → state → abandon` fallback. The caller
    // saw a failure and never submitted, but Redis DID apply the transition, so
    // the gateway cannot prove no submit happened and must not restore the
    // mapping as if it were clean.
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    const owned = h.store.peekRecord(h.key);
    expect(owned?.p).toBeDefined();

    // Redis advanced to `processing` under the SAME owner while the session's
    // own view is still `reserved`.
    h.store.poke(
      h.key,
      JSON.stringify({ ...owned, s: "processing", l: 1_700_000_030_000 }),
      MAPPING_TTL_MS,
    );
    await session.finish();

    expect(h.store.peekRecord(h.key)?.s).toBe("ambiguous");
    expect(h.store.calls).toContain(`release:${h.key}`);
    expect(h.store.calls).toContain(`abandon:${h.key}`);
  });

  it("refuses a cross-owner finalize or abandon and leaves the mapping untouched", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    const before = h.store.peek(h.key);

    const stranger = "c3RyYW5nZXI";
    const timings = {
      leaseMs: REUSE_LEASE_MS,
      processingLeaseMs: 120_000,
      mappingTtlMs: MAPPING_TTL_MS,
      ambiguousTtlMs: REUSE_AMBIGUOUS_TTL_MS,
      committedTtlMs: REUSE_COMMITTED_TTL_MS,
    };
    expect((await h.store.commit(h.key, stranger, timings)).kind).toBe("lost");
    expect((await h.store.activate(h.key, stranger, timings)).kind).toBe("lost");
    expect((await h.store.abandon(h.key, stranger, timings)).kind).toBe("lost");
    expect((await h.store.discardUnusable(h.key, stranger, timings)).kind).toBe("lost");
    expect(h.store.peek(h.key)).toBe(before);

    // The real owner is unaffected.
    expect(await session.finalize()).toBe("ok");
  });

  it("stores nothing sensitive in the Redis key or the record", async () => {
    const h = harness();
    await completeTurn(await lease(h.coordinator));
    const key = h.store.keys()[0] as string;
    const raw = h.store.peek(key) as string;

    const sentinels = [
      GATEWAY_KEY_SENTINEL,
      SESSION_SENTINEL,
      THREAD_SENTINEL,
      UPSTREAM_CREDENTIAL_SENTINEL,
      MASTER_KEY,
      ORIGIN,
      "collectiviq-claude-direct",
    ];
    for (const sentinel of sentinels) {
      expect(key).not.toContain(sentinel);
      expect(raw).not.toContain(sentinel);
    }
    // Only the documented fields are present.
    const decoded = decodeReuseRecord(raw);
    expect(decoded.ok).toBe(true);
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["l", "o", "p", "s", "v"]);
    // The thread id is recoverable only with the right key AND binding.
    const record = decoded.ok ? decoded.record : null;
    const binding = {
      recordVersion: 1,
      storageKey: key,
      mappingIdentityDigest: buildMappingIdentityDigest(KEYRING, NAMESPACE, {
        gatewayKeyScope: SCOPE,
        sessionId: SESSION_SENTINEL,
        policyFingerprint: deriveModelPolicyFingerprint(KEYRING, model()),
        origin: ORIGIN,
        principalFingerprint: PRINCIPAL,
      }),
    };
    expect(openThreadId(KEYRING.aeadKey, record?.p ?? { i: "", c: "", t: "" }, binding)).toBe(
      THREAD_SENTINEL,
    );
  });

  it("is idempotent and non-throwing when settled more than once", async () => {
    const h = harness();
    const session = await lease(h.coordinator);
    expect(await session.bindThread(THREAD_SENTINEL)).toBe("ok");
    expect(await session.markProcessing()).toBe("ok");
    expect(await session.finalize()).toBe("ok");
    // A second finalize is a no-op success; repeated settling never throws and
    // never rewrites the committed mapping.
    expect(await session.finalize()).toBe("ok");
    await session.finish();
    await session.finish();
    expect(h.store.peekRecord(h.key)?.s).toBe("active");
  });
});
