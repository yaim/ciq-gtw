import { describe, expect, it, vi } from "vitest";
import {
  buildCredentialProviderFromConfig,
  CLI_MAX_LOGINS,
  RUNTIME_MAX_LOGINS,
  type ResolvedCredentials,
} from "../../src/collectiviq/auth.js";
import { UpstreamError } from "../../src/collectiviq/errors.js";
import type { FetchLike, TransportBase } from "../../src/collectiviq/types.js";

const BASE_URL = "https://api.prod.collectiviq.ai";

/** A synthetic (never real) login credential set. */
const PW_SENTINEL = "PW-SENTINEL-DO-NOT-LEAK";
const USER_SENTINEL = "user-sentinel@example.test";

/** A fake fetch that answers `POST /login` with a fresh Bearer token each call. */
function loginFetch(): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  const fetch: FetchLike = (input) => {
    if (String(input).endsWith("/login")) {
      n += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `token-${n}`, token_type: "Bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch, calls: () => n };
}

function bearerConfig(base: TransportBase, maxLogins = RUNTIME_MAX_LOGINS): ResolvedCredentials {
  return buildCredentialProviderFromConfig({
    mode: "bearer",
    apiKey: "sk-fake-bearer",
    // Password fields set but MUST be ignored in bearer mode.
    username: USER_SENTINEL,
    password: PW_SENTINEL,
    base,
    maxLogins,
  });
}

function passwordConfig(base: TransportBase, maxLogins = RUNTIME_MAX_LOGINS): ResolvedCredentials {
  return buildCredentialProviderFromConfig({
    mode: "password",
    // apiKey set but MUST be ignored in password mode.
    apiKey: "sk-fake-bearer",
    username: USER_SENTINEL,
    password: PW_SENTINEL,
    base,
    maxLogins,
  });
}

describe("buildCredentialProviderFromConfig", () => {
  it("builds a static bearer provider for bearer mode", async () => {
    const resolved = bearerConfig({ baseUrl: BASE_URL });
    expect(resolved.mode).toBe("bearer");
    expect(resolved.passwordProvider).toBeNull();
    const lease = await resolved.provider.acquire();
    expect(lease.token).toBe("sk-fake-bearer");
  });

  it("builds a password provider for password mode", () => {
    const resolved = passwordConfig({ baseUrl: BASE_URL });
    expect(resolved.mode).toBe("password");
    expect(resolved.passwordProvider).not.toBeNull();
  });

  it("uses ONLY the active mode's credentials", () => {
    // Bearer mode builds without any username/password present.
    expect(() =>
      buildCredentialProviderFromConfig({
        mode: "bearer",
        apiKey: "sk-fake-bearer",
        base: { baseUrl: BASE_URL },
        maxLogins: RUNTIME_MAX_LOGINS,
      }),
    ).not.toThrow();
    // Password mode builds without any apiKey present.
    expect(() =>
      buildCredentialProviderFromConfig({
        mode: "password",
        username: USER_SENTINEL,
        password: PW_SENTINEL,
        base: { baseUrl: BASE_URL },
        maxLogins: RUNTIME_MAX_LOGINS,
      }),
    ).not.toThrow();
    // Bearer mode with a missing api key is a value-free config error.
    expect(() =>
      buildCredentialProviderFromConfig({
        mode: "bearer",
        base: { baseUrl: BASE_URL },
        maxLogins: RUNTIME_MAX_LOGINS,
      }),
    ).toThrow();
  });

  it("performs no login/network I/O during construction", () => {
    const fetchSpy = vi.fn<FetchLike>(() => Promise.reject(new Error("no network at construct")));
    bearerConfig({ baseUrl: BASE_URL, fetch: fetchSpy });
    passwordConfig({ baseUrl: BASE_URL, fetch: fetchSpy });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runtime password lease behaviour", () => {
  it("re-logs in beyond the two-login discovery budget after generation-safe 401 invalidations", async () => {
    const { fetch, calls } = loginFetch();
    const resolved = passwordConfig({ baseUrl: BASE_URL, fetch }, RUNTIME_MAX_LOGINS);
    const provider = resolved.passwordProvider;
    expect(provider).not.toBeNull();
    if (provider === null) return;

    const lease1 = await provider.acquire();
    provider.invalidate(lease1); // as the transport does on a 401
    const lease2 = await provider.acquire();
    provider.invalidate(lease2);
    const lease3 = await provider.acquire();

    // Three successful logins — strictly more than the discovery CLI's budget.
    expect(calls()).toBe(3);
    expect(provider.loginCount).toBe(3);
    expect(3).toBeGreaterThan(CLI_MAX_LOGINS);
    expect(lease1.token).not.toBe(lease3.token);
  });

  it("keeps the discovery CLI login budget at two (a spent budget fails closed)", async () => {
    expect(CLI_MAX_LOGINS).toBe(2);
    const { fetch } = loginFetch();
    const resolved = passwordConfig({ baseUrl: BASE_URL, fetch }, CLI_MAX_LOGINS);
    const provider = resolved.passwordProvider;
    if (provider === null) throw new Error("expected a password provider");

    provider.invalidate(await provider.acquire()); // login 1
    provider.invalidate(await provider.acquire()); // login 2 (budget spent)
    await expect(provider.acquire()).rejects.toBeInstanceOf(UpstreamError);
    expect(provider.loginCount).toBe(2);
  });

  it("reuses the cached lease when it is NOT invalidated (as on a 403)", async () => {
    const { fetch, calls } = loginFetch();
    const resolved = passwordConfig({ baseUrl: BASE_URL, fetch }, RUNTIME_MAX_LOGINS);
    const provider = resolved.passwordProvider;
    if (provider === null) throw new Error("expected a password provider");

    const lease1 = await provider.acquire(); // login 1
    // A 403 does NOT invalidate the lease, so the next acquisition reuses it.
    const lease2 = await provider.acquire();
    expect(lease2.token).toBe(lease1.token);
    expect(calls()).toBe(1);
    expect(provider.loginCount).toBe(1);
  });

  it("never surfaces the synthetic password in observations or login errors", async () => {
    // A login that returns 401 must produce a content-free UpstreamError.
    const failing: FetchLike = () => Promise.resolve(new Response("denied", { status: 401 }));
    const resolved = passwordConfig({ baseUrl: BASE_URL, fetch: failing }, RUNTIME_MAX_LOGINS);
    const provider = resolved.passwordProvider;
    if (provider === null) throw new Error("expected a password provider");

    let caught: unknown;
    await provider.acquire().catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(UpstreamError);
    const serializedError = JSON.stringify({
      message: (caught as Error).message,
      ...(caught as object),
    });
    expect(serializedError).not.toContain(PW_SENTINEL);
    expect(serializedError).not.toContain(USER_SENTINEL);
    // The value-free auth observation carries no credential either.
    expect(JSON.stringify(provider.authObservation())).not.toContain(PW_SENTINEL);
    expect(JSON.stringify(provider.authObservation())).not.toContain(USER_SENTINEL);
  });
});
