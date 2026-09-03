/**
 * `POST /v1/chat/completions` under OpenCode thread reuse (Phase 5A;
 * specification section 5.1.1).
 *
 * Hermetic end-to-end coverage over the real route, the real gateway
 * authenticator (with real HMAC-derived scopes), the real thread-reuse
 * coordinator, and an INJECTED in-memory stand-in for Redis. No socket, no
 * Redis, no CollectivIQ call, and no real credential — only synthetic values.
 *
 * The load-bearing questions these tests answer are WHEN reuse engages, WHAT
 * ORDER the gates run in, and what the mapping looks like afterwards: which
 * requests are stateless and byte-for-byte unchanged, which spend a rate-limit
 * unit, which never reach capacity or upstream, and whether an answer can ever
 * escape before the mapping is durably recorded.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createReadinessState } from "../../src/api/health-route.js";
import type { AppConfig, VirtualModel } from "../../src/config/schema.js";
import {
  ChatCompletionError,
  RequestCancelledError,
  type ChatCompletionRequestContext,
  type ChatCompletionService,
  type CompletionResult,
  type CompletionRunOptions,
  type PreparedCompletion,
} from "../../src/generation/chat-completion.js";
import { CONTEXT_LENGTH_EXCEEDED_ERROR } from "../../src/openai/errors.js";
import type { TitleBridge, TitleRegistration } from "../../src/opencode/title-bridge.js";
import { buildServer, type GatewayServer } from "../../src/server.js";
import {
  buildReuseStorageKey,
  createThreadReuseCoordinator,
  deriveModelPolicyFingerprint,
  deriveThreadReuseKeyring,
  deriveThreadReuseScope,
  deriveUpstreamPrincipalFingerprint,
  REUSE_AMBIGUOUS_TTL_MS,
  type ThreadReuseCoordinator,
} from "../../src/thread-reuse/index.js";
import { createFakeRateLimiter, type FakeRateLimiter } from "../support/fake-rate-limiter.js";
import {
  createFakeThreadReuseStore,
  type FakeThreadReuseStore,
} from "../support/fake-thread-reuse-store.js";

const GATEWAY_KEY = "gw-fake-key-alpha";
const OTHER_GATEWAY_KEY = "gw-fake-key-bravo";
const MASTER_KEY = randomBytes(32).toString("base64url");
const NAMESPACE = "test-ns";
const ORIGIN = "https://api.example.invalid";
const UPSTREAM_CREDENTIAL = "sk-fake-upstream";

const ANSWER = "the synthetic answer";
const SESSION_ID = "ses_fake_alpha";
const SESSION_HEADER = "x-collectiviq-opencode-session-id";

const url = "/v1/chat/completions";
const auth = { authorization: `Bearer ${GATEWAY_KEY}` };

const KEYRING = deriveThreadReuseKeyring(MASTER_KEY);

const BUSY_BODY = {
  error: {
    message: "Another request is already using this OpenCode session's CollectivIQ thread.",
    type: "invalid_request_error",
    param: null,
    code: "thread_reuse_busy",
  },
};
const UNAVAILABLE_BODY = {
  error: {
    message: "OpenCode thread reuse is currently unavailable.",
    type: "server_error",
    param: null,
    code: "thread_reuse_unavailable",
  },
};

function model(id: string, over: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id,
    displayName: id,
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

/** The reuse-eligible default, plus deliberately ineligible variants. */
const DIRECT_MODEL = model("collectiviq-claude-direct");
const PROTOCOL_MODEL = model("collectiviq-claude", { promptMode: "protocol" });
const TOOLS_MODEL = model("collectiviq-claude-tools", {
  promptMode: "protocol",
  toolMode: "emulated",
});
const ALT_POLICY_MODEL = model("collectiviq-claude-direct-alt", { answerSource: "gpt" });

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ENVIRONMENT: "development",
    HOST: "127.0.0.1",
    PORT: 8787,
    COLLECTIVIQ_BASE_URL: ORIGIN,
    COLLECTIVIQ_AUTH_MODE: "bearer",
    COLLECTIVIQ_API_KEY: UPSTREAM_CREDENTIAL,
    COLLECTIVIQ_GATEWAY_KEYS: [GATEWAY_KEY, OTHER_GATEWAY_KEY],
    MODEL_CONFIG_PATH: "./config/models.yaml",
    LOG_LEVEL: "silent",
    LOG_CONTENT: false,
    MAX_REQUEST_BODY_BYTES: 8_388_608,
    MAX_CONCURRENT_REQUESTS: 4,
    MAX_CONCURRENT_REQUESTS_PER_KEY: 2,
    MAX_QUEUED_REQUESTS: 20,
    MAX_QUEUE_WAIT_MS: 5_000,
    SHUTDOWN_DRAIN_MS: 30_000,
    // Present so `buildServer` derives REAL, non-null scopes. It never creates a
    // Redis client: every back end is injected below.
    REDIS_URL: "redis://127.0.0.1:6379",
    IDEMPOTENCY_ENCRYPTION_KEY: MASTER_KEY,
    IDEMPOTENCY_TTL_MS: 600_000,
    REDIS_KEY_PREFIX: NAMESPACE,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_REQUESTS: 60,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_BURST: 8,
    OPENCODE_THREAD_REUSE_ENABLED: true,
    OPENCODE_THREAD_REUSE_TTL_MS: 604_800_000,
    METRICS_ENABLED: false,
    TRACING_ENABLED: false,
    TRACING_SAMPLE_RATIO: 1,
    models: [DIRECT_MODEL, PROTOCOL_MODEL, TOOLS_MODEL, ALT_POLICY_MODEL],
    ...over,
  };
}

/** The storage key the route's mapping identity resolves to. */
function storageKeyFor(
  over: { sessionId?: string; gatewayKey?: string; policy?: VirtualModel } = {},
): string {
  return buildReuseStorageKey(KEYRING, NAMESPACE, {
    gatewayKeyScope: deriveThreadReuseScope(KEYRING, over.gatewayKey ?? GATEWAY_KEY),
    sessionId: over.sessionId ?? SESSION_ID,
    policyFingerprint: deriveModelPolicyFingerprint(KEYRING, over.policy ?? DIRECT_MODEL),
    origin: ORIGIN,
    principalFingerprint: deriveUpstreamPrincipalFingerprint(KEYRING, {
      authMode: "bearer",
      credentialMaterial: UPSTREAM_CREDENTIAL,
    }),
  });
}

/** What `run` observed, so ordering and thread continuity can be asserted. */
interface RunObservation {
  readonly leasedThreadId: string | undefined;
  readonly hadThreadCreatedHook: boolean;
}

type RunFn = (
  prepared: PreparedCompletion,
  signal: AbortSignal,
  options: CompletionRunOptions | undefined,
  ctx: { readonly newThreadId: string },
) => Promise<CompletionResult>;

interface Harness {
  readonly app: GatewayServer;
  readonly store: FakeThreadReuseStore;
  readonly limiter: FakeRateLimiter;
  readonly runs: RunObservation[];
  readonly capacityAcquisitions: { count: number };
  readonly titles: TitleRegistration[];
  readonly shutdown: AbortController;
  /** Fire the renewal timer for every live session. */
  tick(): void;
}

/**
 * A `run` that behaves like the real orchestration: it creates a thread when
 * none is leased, drives the bind/submit hooks in order, and succeeds.
 */
const succeeds: RunFn = async (_prepared, _signal, options, ctx) => {
  const leased = options?.leasedThreadId;
  const threadId = leased ?? ctx.newThreadId;
  if (leased === undefined) await options?.onThreadCreated?.(threadId, _signal);
  await options?.onBeforeSubmit?.(_signal);
  return {
    kind: "text",
    content: ANSWER,
    upstreamThreadId: threadId,
    upstreamThreadCreated: leased === undefined,
  };
};

function build(
  run: RunFn = succeeds,
  options: {
    readonly withCoordinator?: boolean;
    readonly withRateLimiter?: boolean;
    readonly config?: Partial<AppConfig>;
    readonly failPrepare?: boolean;
    readonly store?: FakeThreadReuseStore;
  } = {},
): Harness {
  const store = options.store ?? createFakeThreadReuseStore();
  const limiter = createFakeRateLimiter();
  const runs: RunObservation[] = [];
  const capacityAcquisitions = { count: 0 };
  const titles: TitleRegistration[] = [];
  const shutdown = new AbortController();
  const renewals: (() => void)[] = [];
  let seq = 0;
  let threadSeq = 0;

  const coordinator: ThreadReuseCoordinator = createThreadReuseCoordinator({
    store,
    keyring: KEYRING,
    namespace: NAMESPACE,
    origin: ORIGIN,
    principalFingerprint: deriveUpstreamPrincipalFingerprint(KEYRING, {
      authMode: "bearer",
      credentialMaterial: UPSTREAM_CREDENTIAL,
    }),
    mappingTtlMs: 604_800_000,
    scheduleRenewal: (fn) => {
      renewals.push(fn);
      return { cancel: () => renewals.splice(renewals.indexOf(fn), 1) };
    },
  });

  const chatService: ChatCompletionService = {
    prepare: (ctx: ChatCompletionRequestContext): PreparedCompletion => {
      if (options.failPrepare === true) {
        throw new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR);
      }
      seq += 1;
      return {
        id: `chatcmpl_ciq_${String(seq)}`,
        created: 1_700_000_000 + seq,
        model: ctx.request.model,
        prompt: "PROMPT",
        policy: ctx.model,
        selectedLlms: ctx.model.selectedLlms,
        keyId: ctx.keyId,
      };
    },
    run: async (prepared, signal, runOptions) => {
      runs.push({
        leasedThreadId: runOptions?.leasedThreadId,
        hadThreadCreatedHook: runOptions?.onThreadCreated !== undefined,
      });
      capacityAcquisitions.count += 1;
      threadSeq += 1;
      return run(prepared, signal, runOptions, { newThreadId: `thread-${String(threadSeq)}` });
    },
  };

  const titleBridge: TitleBridge = {
    register: (registration) => {
      titles.push(registration);
    },
    lookup: () => Promise.resolve({ kind: "unavailable" }),
  };

  const app = buildServer({
    config: makeConfig(options.config),
    readiness: createReadinessState(true),
    completion: { chatService, titleBridge, shutdownSignal: shutdown.signal },
    ...(options.withCoordinator === false ? {} : { threadReuse: coordinator }),
    ...(options.withRateLimiter === true ? { rateLimiter: limiter } : {}),
  });
  return {
    app,
    store,
    limiter,
    runs,
    capacityAcquisitions,
    titles,
    shutdown,
    tick: () => {
      for (const fn of [...renewals]) fn();
    },
  };
}

let current: GatewayServer | undefined;
afterEach(async () => {
  if (current) await current.close();
  current = undefined;
});

function use(harness: Harness): Harness {
  current = harness.app;
  return harness;
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "collectiviq-claude-direct",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  };
}

function withSession(sessionId: string = SESSION_ID): Record<string, string> {
  return { ...auth, [SESSION_HEADER]: sessionId };
}

describe("chat completions — reuse does not engage", () => {
  it("performs ZERO reuse operations when the feature is disabled", async () => {
    const h = use(
      build(succeeds, { config: { OPENCODE_THREAD_REUSE_ENABLED: false }, withCoordinator: false }),
    );
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(h.store.calls).toEqual([]);
    expect(h.store.keys()).toEqual([]);
    // The completion ran exactly as it did before Phase 5A.
    expect(h.runs).toEqual([{ leasedThreadId: undefined, hadThreadCreatedHook: false }]);
  });

  it("performs ZERO reuse operations when the session header is absent", async () => {
    const h = use(build());
    const response = await h.app.inject({ method: "POST", url, headers: auth, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(h.store.calls).toEqual([]);
    expect(h.runs[0]?.hadThreadCreatedHook).toBe(false);
  });

  it("keeps protocol-mode and tool-enabled models stateless even with a session header", async () => {
    const h = use(build());
    for (const id of ["collectiviq-claude", "collectiviq-claude-tools"]) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: withSession(),
        payload: body({ model: id }),
      });
      expect(response.statusCode).toBe(200);
    }
    expect(h.store.calls).toEqual([]);
    for (const observed of h.runs) expect(observed.leasedThreadId).toBeUndefined();
  });

  it("still IGNORES a malformed session header for an ineligible request", async () => {
    // The pre-Phase-5A behaviour: a bad header simply skips native-title
    // correlation. Only a reuse-eligible request reports it.
    const h = use(build());
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...auth, [SESSION_HEADER]: "not a valid session id!" },
      payload: body({ model: "collectiviq-claude" }),
    });
    expect(response.statusCode).toBe(200);
    expect(h.store.calls).toEqual([]);
    expect(h.titles).toEqual([]);
  });
});

describe("chat completions — thread reuse across turns", () => {
  it("creates and binds on the first turn, then reuses on the second", async () => {
    const h = use(build());
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(first.statusCode).toBe(200);
    expect(h.runs[0]).toEqual({ leasedThreadId: undefined, hadThreadCreatedHook: true });

    const second = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(second.statusCode).toBe(200);
    // The second turn continues the FIRST turn's thread and creates none.
    expect(h.runs[1]?.leasedThreadId).toBe("thread-1");
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("active");
  });

  it("keeps using one thread for 25 sequential turns (no hidden turn cap)", async () => {
    const h = use(build());
    for (let turn = 1; turn <= 25; turn += 1) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: withSession(),
        payload: body(),
      });
      expect(response.statusCode).toBe(200);
    }
    expect(h.runs).toHaveLength(25);
    expect(h.runs[0]?.leasedThreadId).toBeUndefined();
    // Every later turn reused the very first thread; none rotated it.
    for (const observed of h.runs.slice(1)) expect(observed.leasedThreadId).toBe("thread-1");
    expect(h.store.keys()).toHaveLength(1);
  });

  it("gives a different session, gateway key, or model policy its own mapping", async () => {
    const h = use(build());
    await h.app.inject({ method: "POST", url, headers: withSession(), payload: body() });

    const variants = [
      { headers: withSession("ses_fake_bravo"), payload: body() },
      {
        headers: { authorization: `Bearer ${OTHER_GATEWAY_KEY}`, [SESSION_HEADER]: SESSION_ID },
        payload: body(),
      },
      {
        headers: withSession(),
        payload: body({ model: "collectiviq-claude-direct-alt" }),
      },
    ];
    for (const variant of variants) {
      const response = await h.app.inject({ method: "POST", url, ...variant });
      expect(response.statusCode).toBe(200);
    }
    // Four independent mappings, each having created its own thread.
    expect(h.store.keys()).toHaveLength(4);
    for (const observed of h.runs) expect(observed.leasedThreadId).toBeUndefined();
  });

  it("registers native-title correlation only for the turn that CREATED the thread", async () => {
    const h = use(build());
    await h.app.inject({ method: "POST", url, headers: withSession(), payload: body() });
    await h.app.inject({ method: "POST", url, headers: withSession(), payload: body() });
    await h.app.inject({ method: "POST", url, headers: withSession(), payload: body() });
    expect(h.titles).toEqual([
      { keyId: "k0", sessionId: SESSION_ID, upstreamThreadId: "thread-1" },
    ]);
  });

  it("exposes no session, mapping, or thread identifier in the response", async () => {
    const h = use(build());
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    const serialized = JSON.stringify({
      headers: response.headers,
      body: response.json<unknown>(),
    });
    for (const secret of [SESSION_ID, GATEWAY_KEY, UPSTREAM_CREDENTIAL, "thread-1", NAMESPACE]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reuses one thread across the synthetic SSE transport too", async () => {
    const h = use(build());
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body({ stream: true }),
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const second = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body({ stream: true }),
    });
    expect(second.statusCode).toBe(200);
    expect(h.runs[1]?.leasedThreadId).toBe("thread-1");
    expect(second.body).not.toContain(SESSION_ID);
    expect(second.body).not.toContain("thread-1");
  });
});

describe("chat completions — reuse rejections", () => {
  it("rejects a present but invalid session header on an eligible request", async () => {
    const h = use(build());
    for (const value of ["", "not valid!", "x".repeat(129)]) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: { ...auth, [SESSION_HEADER]: value },
        payload: body(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: "The OpenCode session header is invalid for this request.",
          type: "invalid_request_error",
          param: "X-CollectivIQ-OpenCode-Session-ID",
          code: "invalid_opencode_session_id",
        },
      });
    }
    // Nothing downstream ran.
    expect(h.store.calls).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("rejects an eligible request that also supplies an Idempotency-Key", async () => {
    const h = use(build(succeeds, { withRateLimiter: true }));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...withSession(), "idempotency-key": "idem-fake-0001" },
      payload: body(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Idempotency-Key is not supported for OpenCode thread-reuse requests.",
        type: "invalid_request_error",
        param: "Idempotency-Key",
        code: "unsupported_parameter",
      },
    });
    // Decided BEFORE rate limiting, any reuse Redis operation, capacity, and
    // any upstream call.
    expect(h.limiter.calls.count).toBe(0);
    expect(h.store.calls).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("still accepts an Idempotency-Key for an INELIGIBLE model", async () => {
    // The two features remain independently usable; only their combination on
    // one request is refused.
    const h = use(build());
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: { ...withSession(), "idempotency-key": "idem-fake-0001" },
      payload: body({ model: "collectiviq-claude" }),
    });
    // No idempotency coordinator is wired here, so the keyed request fails
    // closed with the EXISTING Phase 4A envelope rather than the reuse one.
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("idempotency_unavailable");
  });

  it("returns 409 with Retry-After when another turn holds the session", async () => {
    // A genuine live competitor: the first turn holds its lease inside `run`
    // until the test releases it, so the second turn races a real reservation
    // rather than an artificially poked record.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocks: RunFn = async (prepared, signal, options, ctx) => {
      await held;
      return succeeds(prepared, signal, options, ctx);
    };
    const h = use(build(blocks));

    const first = h.app.inject({ method: "POST", url, headers: withSession(), payload: body() });
    // Let the first request reach `run`, which means it already holds the lease.
    await new Promise((resolve) => setImmediate(resolve));

    const second = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual(BUSY_BODY);
    expect(second.headers["retry-after"]).toBe("2");
    // The loser performed no upstream work at all.
    expect(h.runs).toHaveLength(1);

    release();
    expect((await first).statusCode).toBe(200);
  });

  it("fails closed with 503 when the coordinator is enabled but unwired", async () => {
    const h = use(build(succeeds, { withCoordinator: false }));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    expect(response.headers["retry-after"]).toBe("2");
    expect(h.runs).toEqual([]);
  });

  it("fails closed with 503 when Redis is unavailable", async () => {
    const h = use(build());
    h.store.setReady(false);
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    expect(h.runs).toEqual([]);
  });

  it("fails closed with 503 on corrupt mapping state, without destroying it", async () => {
    const h = use(build());
    const key = storageKeyFor();
    h.store.poke(key, '{"v":1,"s":"active","o":"b3Jhbmdl","l":0}');
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    // Never silently replaced with a fresh thread.
    expect(h.store.peek(key)).not.toBeNull();
    expect(h.runs).toEqual([]);
  });

  it("fails closed with 503 while the mapping is ambiguous, and recovers after its TTL", async () => {
    // Only the FIRST turn fails after submitting; the recovery attempt below
    // must be able to succeed once the ambiguous window has elapsed.
    let alreadyFailed = false;
    const failsOnceAfterSubmit: RunFn = async (_prepared, signal, options, ctx) => {
      const leased = options?.leasedThreadId;
      const threadId = leased ?? ctx.newThreadId;
      if (leased === undefined) await options?.onThreadCreated?.(threadId, signal);
      await options?.onBeforeSubmit?.(signal);
      if (!alreadyFailed) {
        alreadyFailed = true;
        throw new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR);
      }
      return {
        kind: "text",
        content: ANSWER,
        upstreamThreadId: threadId,
        upstreamThreadCreated: leased === undefined,
      };
    };
    const h = use(build(failsOnceAfterSubmit));
    const failed = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(failed.statusCode).toBe(400);
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("ambiguous");

    const blockedResponse = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(blockedResponse.statusCode).toBe(503);
    expect(blockedResponse.json()).toEqual(UNAVAILABLE_BODY);

    h.store.advance(REUSE_AMBIGUOUS_TTL_MS + 1);
    const recovered = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(recovered.statusCode).toBe(200);
  });
});

describe("chat completions — reuse ordering and settlement", () => {
  it("meters the rate limit BEFORE taking the lease", async () => {
    const h = use(build(succeeds, { withRateLimiter: true, config: { RATE_LIMIT_ENABLED: true } }));
    h.limiter.onNextConsume(() => {
      // At this point no reuse operation may have happened yet.
      expect(h.store.calls).toEqual([]);
    });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(h.limiter.calls.count).toBe(1);
    expect(h.store.calls[0]).toContain("acquire");
  });

  it("never takes a lease for a rate-limited request", async () => {
    const h = use(build(succeeds, { withRateLimiter: true, config: { RATE_LIMIT_ENABLED: true } }));
    h.limiter.always({ kind: "limited", retryAfterSeconds: 3 });
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(429);
    expect(h.store.calls).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("spends a rate-limit unit for a busy or unavailable reuse attempt", async () => {
    // A reuse rejection happens AFTER the gate, so it is metered exactly like
    // any other otherwise-valid attempt.
    const h = use(
      build(succeeds, {
        withRateLimiter: true,
        config: { RATE_LIMIT_ENABLED: true },
        withCoordinator: false,
      }),
    );
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(h.limiter.calls.count).toBe(1);
  });

  it("spends nothing and takes no lease when preparation fails", async () => {
    const h = use(
      build(succeeds, {
        failPrepare: true,
        withRateLimiter: true,
        config: { RATE_LIMIT_ENABLED: true },
      }),
    );
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(400);
    expect(h.limiter.calls.count).toBe(0);
    expect(h.store.calls).toEqual([]);
  });

  it("restores the mapping when the completion fails before submitting", async () => {
    const h = use(build());
    // Turn 1 establishes the mapping.
    await h.app.inject({ method: "POST", url, headers: withSession(), payload: body() });

    const capacityRejected: RunFn = () =>
      Promise.reject(new ChatCompletionError(CONTEXT_LENGTH_EXCEEDED_ERROR));
    const h2 = use(build(capacityRejected, { store: h.store }));
    const failed = await h2.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(failed.statusCode).toBe(400);
    // The mapping survives untouched, so the session loses nothing.
    const record = h.store.peekRecord(storageKeyFor());
    expect(record?.s).toBe("active");

    const h3 = use(build(succeeds, { store: h.store }));
    const next = await h3.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(next.statusCode).toBe(200);
    expect(h3.runs[0]?.leasedThreadId).toBe("thread-1");
  });

  it("emits no answer and blocks the mapping when finalization fails (JSON)", async () => {
    const h = use(build());
    // BOTH commit attempts must be undecided. A single failure is recoverable by
    // the idempotent retry, which is the whole point of the two-step terminal
    // transition — only an unacknowledgeable commit withholds the answer.
    h.store.failNext("commit", "unavailable");
    h.store.failNext("commit", "unavailable");
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE_BODY);
    expect(response.body).not.toContain(ANSWER);
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("ambiguous");
  });

  it("emits no answer content when finalization fails on the streamed path", async () => {
    const h = use(build());
    h.store.failNext("commit", "unavailable");
    h.store.failNext("commit", "unavailable");
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body({ stream: true }),
    });
    // The SSE headers and the role opener are committed before `run()` by
    // design, so the failure is a content-free error record, not an HTTP status.
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(ANSWER);
    expect(response.body).toContain("thread_reuse_unavailable");
    expect(response.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // No terminal `stop` chunk accompanies an error record.
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(h.titles).toEqual([]);
  });

  it("tombstones the mapping when the client disconnects after submitting", async () => {
    const disconnects: RunFn = async (_prepared, signal, options, ctx) => {
      const threadId = options?.leasedThreadId ?? ctx.newThreadId;
      if (options?.leasedThreadId === undefined) {
        await options?.onThreadCreated?.(threadId, signal);
      }
      await options?.onBeforeSubmit?.(signal);
      throw new RequestCancelledError();
    };
    const h = use(build(disconnects));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    // Still connected, so a cancellation is reported as a shutdown `503`.
    expect(response.statusCode).toBe(503);
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("ambiguous");
  });

  it("settles a first turn that is cancelled before it ever binds a thread", async () => {
    // A cancelled first turn is provably pre-submit and never bound a thread, so
    // the reservation must be DELETED outright: the session is left exactly as
    // it was, owing nothing. Accepting "any settled state" here would let a bug
    // that skipped the acquire entirely pass unnoticed.
    const cancels: RunFn = () => Promise.reject(new RequestCancelledError());
    const h = use(build(cancels));
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(503);
    expect(h.store.calls).toContain(`acquire:${storageKeyFor()}`);
    expect(h.store.peek(storageKeyFor())).toBeNull();
    expect(h.store.keys()).toEqual([]);
  });

  it("still succeeds when the commit reply is lost, without leaking a 503", async () => {
    // Acknowledgement safety at the route level: Redis applied the terminal
    // transition but the reply vanished. The idempotent retry acknowledges it,
    // so the client gets its answer instead of a `503` for work that succeeded.
    const h = use(build());
    h.store.loseReplyNext("commit");
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(ANSWER);
    // The retry must have found an ALREADY-COMMITTED record. Asserting only the
    // 200 and the final state would also pass if the first attempt had never
    // mutated, which is a materially weaker property.
    expect(h.store.observedStates("commit")).toEqual(["processing", "committed"]);
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("active");
  });

  it("still succeeds when an APPLIED activation loses its reply", async () => {
    const h = use(build());
    h.store.loseReplyNext("activate");
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(ANSWER);
    expect(h.store.observedStates("activate")).toEqual(["committed", "active"]);
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("active");
  });

  it("blocks the next turn instead of silently replacing a thread that vanished at activation", async () => {
    // The end-to-end shape of the silent-failure regression: the commit is
    // acknowledged, the record then disappears, and the request fails closed.
    // What matters is the turn AFTER it — it must be refused, not quietly given
    // a brand-new thread that drops the conversation.
    const h = use(build());
    h.store.dropBeforeNext("activate");
    const first = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(first.statusCode).toBe(503);
    expect(first.headers["retry-after"]).toBe("2");
    expect(first.body).not.toContain(ANSWER);

    const runsAfterFirst = h.runs.length;
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("ambiguous");

    const second = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(second.statusCode).toBe(503);
    expect(second.headers["retry-after"]).toBe("2");
    // Blocked BEFORE any upstream work: no `create_thread`, no `process_message`.
    expect(h.runs).toHaveLength(runsAfterFirst);
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("ambiguous");

    // Only after the bounded window may the session start a clean thread.
    h.store.advance(REUSE_AMBIGUOUS_TTL_MS + 1);
    const third = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(third.statusCode).toBe(200);
    expect(h.runs).toHaveLength(runsAfterFirst + 1);
    expect(h.runs.at(-1)?.leasedThreadId).toBeUndefined();
  });

  it("still succeeds when activation is undecided, and settles the mapping safely", async () => {
    // Once the commit is acknowledged the answer is authorized, so an undecided
    // activation must not become a client-visible failure. The record is
    // non-acquirable until settlement confirms it.
    const h = use(build());
    h.store.failNext("activate", "unavailable");
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: withSession(),
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(ANSWER);
    // Settlement retried activation on the way out.
    expect(h.store.peekRecord(storageKeyFor())?.s).toBe("active");
  });

  it("leaves no held lease behind after any completed request", async () => {
    const h = use(build());
    for (const payload of [body(), body({ stream: true })]) {
      await h.app.inject({ method: "POST", url, headers: withSession(), payload });
    }
    for (const key of h.store.keys()) {
      const record = h.store.peekRecord(key);
      expect(record?.s).toBe("active");
      expect(record?.l).toBe(0);
    }
  });
});
