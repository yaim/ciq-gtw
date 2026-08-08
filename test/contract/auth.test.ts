import { afterEach, describe, expect, it, vi } from "vitest";
import { startMockServer, replyJson, replyRaw, type MockServer } from "./support/mock-server.js";
import {
  AuthConfigError,
  buildCredentialProviderFromEnv,
  buildLoginForm,
  CLI_MAX_LOGINS,
  PasswordCredentialProvider,
  resolveAuthMode,
  staticBearerCredentialProvider,
  validateBearerToken,
  validateLoginResponse,
  validatePassword,
  validateUsername,
} from "../../src/collectiviq/auth.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import { observeUpstreamJson, requestUpstreamJson } from "../../src/collectiviq/http.js";
import type {
  CollectivIQCredentialProvider,
  CredentialLease,
  FetchLike,
  OperationTimeouts,
  TransportBase,
} from "../../src/collectiviq/types.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.useRealTimers();
});

const FAST: OperationTimeouts = {
  headerTimeoutMs: 2_000,
  bodyTimeoutMs: 2_000,
  maxResponseBytes: 1_048_576,
};

const USER = "probe-user@example.com";
const PASS = "probe-pass";
const TOKEN = "minted-access-token";

function passwordProvider(
  base: TransportBase,
  maxLogins = CLI_MAX_LOGINS,
): PasswordCredentialProvider {
  return new PasswordCredentialProvider({ base, username: USER, password: PASS, maxLogins });
}

/** A mock handler that answers /login with a valid token and /available_llms with a body. */
function loginThenApi(loginBody: unknown = { access_token: TOKEN, token_type: "Bearer" }) {
  return (req: { path: string }, res: Parameters<typeof replyJson>[0]) => {
    if (req.path === "/login") return replyJson(res, loginBody, 200);
    return replyJson(res, { llms: { a: {} } }, 200);
  };
}

describe("credential validators (bounds, canonicalization)", () => {
  it("validates bearer tokens (non-empty, <=16 KiB, preserved exactly)", () => {
    expect(validateBearerToken(undefined)).toMatchObject({ ok: false, reason: "is required" });
    expect(validateBearerToken("")).toMatchObject({ ok: false, reason: "is required" });
    expect(validateBearerToken("  keep me  ")).toEqual({ ok: true, value: "  keep me  " });
    expect(validateBearerToken("x".repeat(16_384))).toMatchObject({ ok: true });
    expect(validateBearerToken("x".repeat(16_385))).toMatchObject({
      ok: false,
      reason: "length is outside allowed bounds",
    });
  });

  it("trims usernames and bounds them to 320 bytes", () => {
    expect(validateUsername(undefined)).toMatchObject({ ok: false });
    expect(validateUsername("   ")).toMatchObject({ ok: false });
    expect(validateUsername("  user@example.com  ")).toEqual({
      ok: true,
      value: "user@example.com",
    });
    expect(validateUsername("u".repeat(320))).toMatchObject({ ok: true });
    expect(validateUsername("u".repeat(321))).toMatchObject({ ok: false });
  });

  it("preserves passwords exactly (incl. whitespace), bounded to 4096 bytes", () => {
    expect(validatePassword(undefined)).toMatchObject({ ok: false });
    expect(validatePassword("")).toMatchObject({ ok: false });
    expect(validatePassword("  pad  ")).toEqual({ ok: true, value: "  pad  " });
    expect(validatePassword("p".repeat(4_096))).toMatchObject({ ok: true });
    expect(validatePassword("p".repeat(4_097))).toMatchObject({ ok: false });
  });
});

describe("login form encoding", () => {
  it("encodes grant_type/username/password/scope and omits client_id/client_secret", () => {
    const form = buildLoginForm("u", "p");
    expect(form.get("grant_type")).toBe("password");
    expect(form.get("username")).toBe("u");
    expect(form.get("password")).toBe("p");
    expect(form.get("scope")).toBe("");
    expect(form.has("client_id")).toBe(false);
    expect(form.has("client_secret")).toBe(false);
  });

  it("sends the urlencoded form to /login with NO Authorization header", async () => {
    server = await startMockServer(loginThenApi());
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    await requestUpstreamJson(
      { baseUrl: server.baseUrl, credentials: provider },
      { method: "GET", path: "/available_llms", timeouts: FAST },
    );
    const login = server.requests.find((r) => r.path === "/login");
    expect(login).toBeDefined();
    expect(login?.method).toBe("POST");
    expect(String(login?.headers["content-type"])).toContain("application/x-www-form-urlencoded");
    expect(login?.headers["authorization"]).toBeUndefined();
    const body = new URLSearchParams(login?.text() ?? "");
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe(USER);
    expect(body.get("password")).toBe(PASS);
    expect(body.get("scope")).toBe("");
    // The subsequent API call carried the minted bearer.
    const api = server.requests.find((r) => r.path === "/available_llms");
    expect(String(api?.headers["authorization"])).toBe(`Bearer ${TOKEN}`);
  });
});

describe("validateLoginResponse (provisional shape)", () => {
  it("accepts a valid object and ignores unknown fields (incl. refresh token)", () => {
    expect(
      validateLoginResponse(
        { access_token: TOKEN, token_type: "bearer", refresh_token: "ignored", extra: 1 },
        200,
      ),
    ).toBe(TOKEN);
    // token_type is case-insensitive.
    expect(validateLoginResponse({ access_token: TOKEN, token_type: "Bearer" }, 200)).toBe(TOKEN);
  });

  it("rejects malformed shapes with a content-free protocol error", () => {
    const bad: unknown[] = [
      null,
      [],
      "str",
      {},
      { token_type: "Bearer" },
      { access_token: "", token_type: "Bearer" },
      { access_token: 123, token_type: "Bearer" },
      { access_token: "x".repeat(16_385), token_type: "Bearer" },
      { access_token: TOKEN },
      { access_token: TOKEN, token_type: "MAC" },
      { access_token: TOKEN, token_type: 1 },
    ];
    for (const value of bad) {
      expect(() => validateLoginResponse(value, 200)).toThrow(UpstreamError);
      try {
        validateLoginResponse(value, 200);
      } catch (error) {
        expect((error as UpstreamError).category).toBe("upstream_protocol");
      }
    }
  });
});

describe("static bearer provider", () => {
  it("returns one stable lease and never invalidates it", async () => {
    const provider = staticBearerCredentialProvider("static-token");
    const a = await provider.acquire();
    const b = await provider.acquire();
    expect(a).toEqual({ generation: 0, token: "static-token" });
    expect(b).toEqual(a);
    expect(() => provider.invalidate(a)).not.toThrow();
    expect(await provider.acquire()).toEqual(a);
  });
});

describe("password provider — caching and single-flight", () => {
  it("caches the token: multiple sequential acquires log in once", async () => {
    server = await startMockServer(loginThenApi());
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    const l1 = await provider.acquire();
    const l2 = await provider.acquire();
    expect(l1.token).toBe(TOKEN);
    expect(l2).toEqual(l1);
    expect(provider.loginCount).toBe(1);
    expect(server.requests.filter((r) => r.path === "/login")).toHaveLength(1);
  });

  it("performs no login until acquire is called", async () => {
    server = await startMockServer(loginThenApi());
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    expect(provider.loginCount).toBe(0);
    expect(server.requests).toHaveLength(0);
    await provider.acquire();
    expect(provider.loginCount).toBe(1);
  });

  it("coalesces concurrent acquisitions into a single login", async () => {
    let logins = 0;
    server = await startMockServer(async (req, res) => {
      if (req.path === "/login") {
        logins += 1;
        await new Promise((r) => setTimeout(r, 40));
        return replyJson(res, { access_token: TOKEN, token_type: "Bearer" }, 200);
      }
      return replyJson(res, {}, 200);
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    const leases = await Promise.all([provider.acquire(), provider.acquire(), provider.acquire()]);
    expect(leases.every((l) => l.token === TOKEN)).toBe(true);
    expect(logins).toBe(1);
    expect(provider.loginCount).toBe(1);
  });
});

describe("password provider — cancellation semantics", () => {
  it("detaches only the cancelled waiter; a remaining waiter still resolves", async () => {
    let logins = 0;
    server = await startMockServer(async (req, res) => {
      if (req.path === "/login") {
        logins += 1;
        await new Promise((r) => setTimeout(r, 60));
        return replyJson(res, { access_token: TOKEN, token_type: "Bearer" }, 200);
      }
      return replyJson(res, {}, 200);
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    const controller = new AbortController();
    const cancelled = provider.acquire(controller.signal);
    const survivor = provider.acquire();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ category: "cancellation" });
    const lease = await survivor;
    expect(lease.token).toBe(TOKEN);
    expect(logins).toBe(1);
  });

  it("aborts the shared login when the final waiter leaves, and can log in again later", async () => {
    server = await startMockServer(async (req, res) => {
      if (req.path === "/login") {
        await new Promise((r) => setTimeout(r, 80));
        return replyJson(res, { access_token: TOKEN, token_type: "Bearer" }, 200);
      }
      return replyJson(res, {}, 200);
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl }, 5);
    const controller = new AbortController();
    const only = provider.acquire(controller.signal);
    controller.abort();
    await expect(only).rejects.toMatchObject({ category: "cancellation" });
    // A later acquire starts a fresh login and succeeds.
    const lease = await provider.acquire();
    expect(lease.token).toBe(TOKEN);
  });
});

describe("password provider — invalidation and budget", () => {
  it("is generation-safe: a stale lease cannot clear a newer token", async () => {
    let n = 0;
    server = await startMockServer((req, res) => {
      if (req.path === "/login") {
        n += 1;
        return replyJson(res, { access_token: `tok-${n}`, token_type: "Bearer" }, 200);
      }
      return replyJson(res, {}, 200);
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl }, 5);
    const lease1 = await provider.acquire();
    expect(lease1.token).toBe("tok-1");
    provider.invalidate(lease1); // clears tok-1
    const lease2 = await provider.acquire();
    expect(lease2.token).toBe("tok-2");
    expect(lease2.generation).not.toBe(lease1.generation);
    // A late invalidation carrying the OLD lease must be a no-op.
    provider.invalidate(lease1);
    const lease3 = await provider.acquire();
    expect(lease3.token).toBe("tok-2"); // still cached; no new login
    expect(provider.loginCount).toBe(2);
  });

  it("enforces a hard login budget and fails closed with authentication", async () => {
    let n = 0;
    server = await startMockServer((req, res) => {
      if (req.path === "/login") {
        n += 1;
        return replyJson(res, { access_token: `tok-${n}`, token_type: "Bearer" }, 200);
      }
      return replyJson(res, {}, 200);
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl }, 2);
    const a = await provider.acquire();
    provider.invalidate(a);
    const b = await provider.acquire();
    provider.invalidate(b);
    // Third login would exceed the budget of 2.
    await expect(provider.acquire()).rejects.toMatchObject({ category: "authentication" });
    expect(provider.loginCount).toBe(2);
    expect(server.requests.filter((r) => r.path === "/login")).toHaveLength(2);
  });
});

describe("password provider — login failure outcomes", () => {
  const cases: Array<{ name: string; handler: MockHandlerLike; category: string }> = [
    {
      name: "401",
      handler: (_r, res) => replyJson(res, { detail: "no" }, 401),
      category: "authentication",
    },
    { name: "429", handler: (_r, res) => replyJson(res, {}, 429), category: "quota" },
    { name: "422", handler: (_r, res) => replyJson(res, {}, 422), category: "validation" },
    {
      name: "500",
      handler: (_r, res) => replyJson(res, {}, 500),
      category: "unexpected_upstream",
    },
    {
      name: "2xx-not-200 (201)",
      handler: (_r, res) => replyJson(res, { access_token: TOKEN, token_type: "Bearer" }, 201),
      category: "upstream_protocol",
    },
    {
      name: "non-JSON body",
      handler: (_r, res) => replyRaw(res, "not json", 200, "text/plain"),
      category: "upstream_protocol",
    },
    {
      name: "malformed JSON",
      handler: (_r, res) => replyRaw(res, "{bad", 200, "application/json"),
      category: "upstream_protocol",
    },
    {
      name: "invalid token shape",
      handler: (_r, res) => replyJson(res, { token_type: "Bearer" }, 200),
      category: "upstream_protocol",
    },
  ];

  for (const c of cases) {
    it(`normalizes a login ${c.name} to ${c.category}`, async () => {
      server = await startMockServer(c.handler);
      const provider = passwordProvider({ baseUrl: server.baseUrl });
      await expect(provider.acquire()).rejects.toMatchObject({ category: c.category });
    });
  }

  it("rejects a login redirect (redirect:error) without following it", async () => {
    server = await startMockServer((_r, res) => {
      res.writeHead(302, { location: "https://elsewhere.example" });
      res.end();
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    await expect(provider.acquire()).rejects.toBeInstanceOf(UpstreamError);
  });

  it("reports a value-free auth observation", async () => {
    server = await startMockServer(loginThenApi());
    const provider = passwordProvider({ baseUrl: server.baseUrl });
    await provider.acquire();
    expect(provider.authObservation()).toEqual({
      mode: "password",
      loginAttempts: 1,
      status: 200,
      normalized: true,
    });
  });
});

/**
 * Real login-deadline tests. These drive the FIXED `LOGIN_TIMEOUTS`
 * (header/body = 20_000ms) through vitest fake timers and an INJECTED
 * `FetchLike` on `base.fetch` — no real socket, and the production timeout
 * constants are never made configurable. Each proves the deadline fires as a
 * `timeout`/`upstream_timeout` and that a single attempt runs with no internal
 * retry. A separate test proves caller cancellation is a distinct outcome.
 */
describe("password provider — login deadlines (fake timers, injected fetch)", () => {
  const passwordProviderWith = (fetch: FetchLike): PasswordCredentialProvider =>
    new PasswordCredentialProvider({
      base: { baseUrl: "http://fake.invalid", fetch },
      username: USER,
      password: PASS,
      maxLogins: 5,
    });

  /** Assert a normalized timeout that leaks no credential value. */
  const expectContentFreeTimeout = (error: unknown): void => {
    const upstream = error as UpstreamError;
    expect(upstream).toBeInstanceOf(UpstreamError);
    expect(upstream.category).toBe("timeout");
    expect(upstream.code).toBe("upstream_timeout");
    const serialized = JSON.stringify({
      message: (error as Error).message,
      category: upstream.category,
      code: upstream.code,
    });
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain(PASS);
    expect(serialized).not.toContain(TOKEN);
  };

  it("aborts at the 20s header deadline as a timeout, with exactly one attempt", async () => {
    vi.useFakeTimers();
    // A fetch that only ever settles by rejecting when the transport aborts it,
    // so the header timer is the sole thing that can end the wait.
    const fakeFetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const provider = passwordProviderWith(fakeFetch);

    let caught: unknown;
    const acquire = provider.acquire().catch((error: unknown) => {
      caught = error;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await acquire;

    expectContentFreeTimeout(caught);
    // Exactly one login attempt; no automatic retry inside the attempt.
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(provider.loginCount).toBe(1);
  });

  it("aborts at the 20s body deadline as a timeout, with exactly one attempt", async () => {
    vi.useFakeTimers();
    // Headers arrive immediately (200 + JSON), but the body stream never
    // enqueues and only errors once the transport's body-deadline abort fires.
    const fakeFetch = vi.fn<FetchLike>((_url, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      );
    });
    const provider = passwordProviderWith(fakeFetch);

    let caught: unknown;
    const acquire = provider.acquire().catch((error: unknown) => {
      caught = error;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await acquire;

    expectContentFreeTimeout(caught);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(provider.loginCount).toBe(1);
  });

  it("treats the caller's own cancellation as a distinct cancellation outcome", async () => {
    // Distinct from the deadline tests above: the caller aborts, not a timer, so
    // the outcome is `cancellation`/`request_cancelled` rather than `timeout`.
    const fakeFetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const provider = passwordProviderWith(fakeFetch);

    const controller = new AbortController();
    const acquire = provider.acquire(controller.signal);
    controller.abort();

    await expect(acquire).rejects.toMatchObject({
      category: "cancellation",
      code: "request_cancelled",
    });
    // The single in-flight attempt was started, then cancelled — never retried.
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(provider.loginCount).toBe(1);
  });
});

// A minimal handler type mirroring the mock server's signature.
type MockHandlerLike = Parameters<typeof startMockServer>[0];

/** A spy provider that records acquire/invalidate calls and serves a static token. */
class SpyProvider implements CollectivIQCredentialProvider {
  acquires = 0;
  invalidations: CredentialLease[] = [];
  readonly #lease: CredentialLease = { generation: 1, token: "spy-token" };
  acquire(): Promise<CredentialLease> {
    this.acquires += 1;
    return Promise.resolve(this.#lease);
  }
  invalidate(lease: CredentialLease): void {
    this.invalidations.push(lease);
  }
}

describe("transport lease behavior (401 invalidation, no replay, 403)", () => {
  it("invalidates the lease on 401 and never replays the request", async () => {
    server = await startMockServer((_r, res) => replyJson(res, { detail: "no" }, 401));
    const spy = new SpyProvider();
    await expect(
      requestUpstreamJson(
        { baseUrl: server.baseUrl, credentials: spy },
        { method: "GET", path: "/get_messages", timeouts: FAST },
      ),
    ).rejects.toMatchObject({ category: "authentication", rawStatus: 401 });
    expect(spy.acquires).toBe(1);
    expect(spy.invalidations).toHaveLength(1);
    expect(server.requests).toHaveLength(1); // no replay
  });

  it("does NOT invalidate the lease on 403", async () => {
    server = await startMockServer((_r, res) => replyJson(res, { detail: "no" }, 403));
    const spy = new SpyProvider();
    await expect(
      requestUpstreamJson(
        { baseUrl: server.baseUrl, credentials: spy },
        { method: "POST", path: "/create_thread", timeouts: FAST },
      ),
    ).rejects.toMatchObject({ category: "authentication", rawStatus: 403 });
    expect(spy.invalidations).toHaveLength(0);
    expect(server.requests).toHaveLength(1);
  });

  it("re-authenticates on the NEXT distinct request after a 401 (password mode)", async () => {
    let calls = 0;
    server = await startMockServer((req, res) => {
      if (req.path === "/login") {
        calls += 1;
        return replyJson(res, { access_token: `tok-${calls}`, token_type: "Bearer" }, 200);
      }
      // First API call rejects with 401; the second succeeds.
      const apiCalls = req.headers["authorization"];
      if (apiCalls === "Bearer tok-1") return replyJson(res, { detail: "stale" }, 401);
      return replyJson(res, { messages: [] }, 200);
    });
    const provider = passwordProvider({ baseUrl: server.baseUrl }, 5);
    const config = { baseUrl: server.baseUrl, credentials: provider };
    await expect(
      requestUpstreamJson(config, { method: "GET", path: "/get_messages", timeouts: FAST }),
    ).rejects.toMatchObject({ category: "authentication", rawStatus: 401 });
    // The 401 invalidated tok-1; the next distinct request logs in again (tok-2).
    const ok = await requestUpstreamJson(config, {
      method: "GET",
      path: "/get_messages",
      timeouts: FAST,
    });
    expect(ok.status).toBe(200);
    expect(provider.loginCount).toBe(2);
  });

  it("invalidates the lease on a 401 observation (discovery path) without replay", async () => {
    server = await startMockServer((_r, res) => replyJson(res, { detail: "no" }, 401));
    const spy = new SpyProvider();
    const obs = await observeUpstreamJson(
      { baseUrl: server.baseUrl, credentials: spy },
      { method: "GET", path: "/available_llms", timeouts: FAST },
    );
    expect(obs.status).toBe(401);
    expect(obs.ok).toBe(false);
    expect(spy.invalidations).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });
});

describe("env → provider resolver", () => {
  const base: TransportBase = { baseUrl: "https://api.prod.collectiviq.ai" };

  it("resolves the auth mode with a bearer default", () => {
    expect(resolveAuthMode(undefined)).toBe("bearer");
    expect(resolveAuthMode("")).toBe("bearer");
    expect(resolveAuthMode(" Bearer ")).toBe("bearer");
    expect(resolveAuthMode("password")).toBe("password");
    expect(() => resolveAuthMode("token")).toThrow(AuthConfigError);
  });

  it("builds a static provider in bearer mode and ignores inactive-mode creds", () => {
    const resolved = buildCredentialProviderFromEnv(
      {
        COLLECTIVIQ_AUTH_MODE: "bearer",
        COLLECTIVIQ_API_KEY: "sk-fake",
        // Inactive-mode creds present but ignored:
        COLLECTIVIQ_USERNAME: "ignored",
        COLLECTIVIQ_PASSWORD: "ignored",
      },
      base,
      { maxLogins: CLI_MAX_LOGINS },
    );
    expect(resolved.mode).toBe("bearer");
    expect(resolved.passwordProvider).toBeNull();
  });

  it("builds a password provider and rejects missing credentials value-free", () => {
    const resolved = buildCredentialProviderFromEnv(
      { COLLECTIVIQ_AUTH_MODE: "password", COLLECTIVIQ_USERNAME: "u", COLLECTIVIQ_PASSWORD: "p" },
      base,
      { maxLogins: CLI_MAX_LOGINS },
    );
    expect(resolved.mode).toBe("password");
    expect(resolved.passwordProvider).toBeInstanceOf(PasswordCredentialProvider);

    expect(() =>
      buildCredentialProviderFromEnv({ COLLECTIVIQ_AUTH_MODE: "bearer" }, base, { maxLogins: 2 }),
    ).toThrow(AuthConfigError);
    try {
      buildCredentialProviderFromEnv({ COLLECTIVIQ_AUTH_MODE: "password" }, base, { maxLogins: 2 });
    } catch (error) {
      expect(error).toBeInstanceOf(AuthConfigError);
      // Value-free: field + generic reason only, and the generic name.
      expect((error as AuthConfigError).name).toBe("Error");
      expect((error as AuthConfigError).field).toBe("COLLECTIVIQ_USERNAME");
    }
  });

  it("caps the CLI login budget at two", () => {
    expect(CLI_MAX_LOGINS).toBe(2);
  });
});
