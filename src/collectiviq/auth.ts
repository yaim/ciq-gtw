/**
 * Shared upstream-credential boundary for the CollectivIQ adapter, discovery,
 * SSE, deletion, and recovery tooling.
 *
 * Two authentication modes are supported behind one {@link
 * CollectivIQCredentialProvider} interface (declared in `types.ts`):
 *
 * - `bearer` (default): a static bearer token is used verbatim on every request.
 *   Invalidation is a no-op; there is no login.
 * - `password`: an OAuth2 password-exchange (`POST /login`) mints a short-lived
 *   bearer token that is cached IN MEMORY ONLY. Concurrent acquisitions coalesce
 *   into a single login (single-flight); a caller's cancellation detaches only
 *   that waiter, and the shared login is aborted only once the final waiter
 *   leaves. Invalidation is generation-safe: a late `401` from a request that
 *   used an older token can never clear a newer one.
 *
 * Security invariants:
 * - importing this module performs no I/O and reads no credential;
 * - a login attaches NO Authorization header and uses a dedicated unauthenticated
 *   bounded request path, so it can never recursively request credentials;
 * - raw login bodies, tokens, usernames, or response fields never enter an
 *   exception, log, snapshot, or report; every failure is a normalized,
 *   content-free {@link UpstreamError};
 * - there is no automatic retry inside a single login attempt.
 *
 * Residual risk: the username and password remain resident in process
 * environment/config memory so a later login can run, and a JavaScript string's
 * bytes cannot be deterministically erased. This module never claims otherwise;
 * it only avoids copying, logging, or persisting those values.
 */
import { isUpstreamError, UpstreamError } from "./errors.js";
import { requestUnauthenticatedJson } from "./http.js";
import type {
  CollectivIQCredentialProvider,
  CredentialLease,
  OperationTimeouts,
  TransportBase,
} from "./types.js";

/** Supported upstream authentication modes. */
export const AUTH_MODES = ["bearer", "password"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Fixed OAuth2 password-flow token endpoint (from the public OpenAPI document). */
export const LOGIN_ENDPOINT = "/login" as const;

/** Byte bounds for the credential values (shared by config loading and the CLI). */
export const USERNAME_MAX_BYTES = 320;
export const PASSWORD_MAX_BYTES = 4_096;
/** Bearer token / login `access_token` cap: 16 KiB. */
export const BEARER_TOKEN_MAX_BYTES = 16_384;

/** Bounded login exchange transport limits. */
export const LOGIN_TIMEOUTS: OperationTimeouts = {
  headerTimeoutMs: 20_000,
  bodyTimeoutMs: 20_000,
  maxResponseBytes: 65_536,
};

/**
 * The hard per-process login budget imposed by discovery and recovery
 * construction. Two authorized login exchanges are the maximum; exceeding it
 * fails closed with the normalized authentication error.
 */
export const CLI_MAX_LOGINS = 2;

const URLENCODED = "application/x-www-form-urlencoded";

/** A value-free credential validation result. Reasons never echo the value. */
export type CredentialCheck =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Validate a bearer token: non-empty and at most {@link BEARER_TOKEN_MAX_BYTES}.
 * The value is preserved EXACTLY (no trimming). `undefined`/empty is "required".
 */
export function validateBearerToken(raw: string | undefined): CredentialCheck {
  if (raw === undefined || raw.length === 0) return { ok: false, reason: "is required" };
  if (utf8Bytes(raw) > BEARER_TOKEN_MAX_BYTES) {
    return { ok: false, reason: "length is outside allowed bounds" };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a username: trim, require canonical non-empty text (no surrounding
 * whitespace after trimming), at most {@link USERNAME_MAX_BYTES}. Returns the
 * trimmed canonical value.
 */
export function validateUsername(raw: string | undefined): CredentialCheck {
  if (raw === undefined || raw.trim().length === 0) return { ok: false, reason: "is required" };
  const trimmed = raw.trim();
  if (utf8Bytes(trimmed) > USERNAME_MAX_BYTES) {
    return { ok: false, reason: "length is outside allowed bounds" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a password: non-empty and at most {@link PASSWORD_MAX_BYTES}. The
 * value is preserved EXACTLY, including any leading/trailing whitespace.
 */
export function validatePassword(raw: string | undefined): CredentialCheck {
  if (raw === undefined || raw.length === 0) return { ok: false, reason: "is required" };
  if (utf8Bytes(raw) > PASSWORD_MAX_BYTES) {
    return { ok: false, reason: "length is outside allowed bounds" };
  }
  return { ok: true, value: raw };
}

/**
 * Build the fixed `POST /login` urlencoded form. `grant_type` is always
 * `password`; `scope` is empty; `client_id`/`client_secret` are omitted. The
 * username/password are placed verbatim (already validated by the caller).
 */
export function buildLoginForm(username: string, password: string): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "password");
  body.set("username", username);
  body.set("password", password);
  body.set("scope", "");
  return body;
}

/**
 * Validate a `POST /login` response and return the accepted bearer token. The
 * body must be a non-array object with an own `access_token` (non-empty string,
 * at most {@link BEARER_TOKEN_MAX_BYTES}) and an own `token_type` equal to
 * `Bearer` (case-insensitive). Unknown fields — including any refresh token —
 * are ignored and never retained. Any deviation throws a content-free
 * {@link UpstreamError}; the raw body/value is never placed in the error.
 *
 * PROVISIONAL: the published 200 schema is empty, so this is the gateway's own
 * minimal contract until a live login confirms it.
 */
export function validateLoginResponse(json: unknown, rawStatus: number): string {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new UpstreamError("upstream_protocol", rawStatus, "POST");
  }
  const obj = json as Record<string, unknown>;
  if (!Object.hasOwn(obj, "access_token") || !Object.hasOwn(obj, "token_type")) {
    throw new UpstreamError("upstream_protocol", rawStatus, "POST");
  }
  const accessToken = obj["access_token"];
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    utf8Bytes(accessToken) > BEARER_TOKEN_MAX_BYTES
  ) {
    throw new UpstreamError("upstream_protocol", rawStatus, "POST");
  }
  const tokenType = obj["token_type"];
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    throw new UpstreamError("upstream_protocol", rawStatus, "POST");
  }
  return accessToken;
}

/**
 * A value-free authentication observation for password-mode discovery/recovery
 * reports. It carries ONLY the mode, the login-attempt count, the safe login
 * HTTP status (or null when no response was received), and whether the login
 * response normalized. It never carries a token-shaped key, field value,
 * username, response structure, header, or length.
 */
export interface AuthObservation {
  readonly mode: AuthMode;
  readonly loginAttempts: number;
  readonly status: number | null;
  readonly normalized: boolean;
}

/**
 * A static bearer provider. Returns one stable lease and never logs in;
 * invalidation is a no-op. Used for `bearer` mode and (with an empty token) for
 * the discovery auth-error probe.
 */
export function staticBearerCredentialProvider(token: string): CollectivIQCredentialProvider {
  const lease: CredentialLease = { generation: 0, token };
  return {
    acquire: () => Promise.resolve(lease),
    invalidate: () => {},
  };
}

/** An in-flight single-flight login, shared across coalesced acquirers. */
interface LoginFlight {
  readonly controller: AbortController;
  readonly waiters: Set<object>;
  readonly promise: Promise<CredentialLease>;
}

/**
 * OAuth2 password-exchange provider. Caches the accepted token in memory,
 * coalesces concurrent acquisitions into one login, applies generation-safe
 * invalidation, and enforces a hard per-provider login budget.
 */
export class PasswordCredentialProvider implements CollectivIQCredentialProvider {
  readonly #base: TransportBase;
  readonly #username: string;
  readonly #password: string;
  readonly #maxLogins: number;

  #token: string | null = null;
  /** Monotonic sequence; the generation stamped on the current cached token. */
  #genSeq = 0;
  #currentGeneration = 0;
  #loginCount = 0;
  #inflight: LoginFlight | null = null;
  /** Value-free outcome of the most recent login attempt (for reports). */
  #lastLoginStatus: number | null = null;
  #lastLoginNormalized = false;

  constructor(options: {
    readonly base: TransportBase;
    readonly username: string;
    readonly password: string;
    /** Hard login budget for this provider (e.g. {@link CLI_MAX_LOGINS}). */
    readonly maxLogins: number;
  }) {
    this.#base = options.base;
    this.#username = options.username;
    this.#password = options.password;
    this.#maxLogins = options.maxLogins;
  }

  /** Login exchanges attempted so far (for tests/observations; never a token). */
  get loginCount(): number {
    return this.#loginCount;
  }

  /** The value-free authentication observation for a password-mode report. */
  authObservation(): AuthObservation {
    return {
      mode: "password",
      loginAttempts: this.#loginCount,
      status: this.#lastLoginStatus,
      normalized: this.#lastLoginNormalized,
    };
  }

  acquire(signal?: AbortSignal): Promise<CredentialLease> {
    if (signal?.aborted) return Promise.reject(new UpstreamError("cancellation"));
    if (this.#token !== null) {
      return Promise.resolve({ generation: this.#currentGeneration, token: this.#token });
    }
    const flight = this.#ensureFlight();
    if (flight === null) return Promise.reject(new UpstreamError("authentication"));
    return this.#joinFlight(flight, signal);
  }

  invalidate(lease: CredentialLease): void {
    // Generation-safe: only clear the token when the lease matches the CURRENT
    // token generation. A late 401 from a superseded token is a no-op.
    if (this.#token !== null && lease.generation === this.#currentGeneration) {
      this.#token = null;
    }
  }

  /** Start or reuse the single-flight login. Returns null when the budget is spent. */
  #ensureFlight(): LoginFlight | null {
    if (this.#inflight !== null) return this.#inflight;
    if (this.#loginCount >= this.#maxLogins) return null;
    this.#loginCount += 1;

    const controller = new AbortController();
    const waiters = new Set<object>();
    const promise = this.#attemptLogin(controller.signal)
      .then((token): CredentialLease => {
        this.#token = token;
        this.#currentGeneration = ++this.#genSeq;
        return { generation: this.#currentGeneration, token };
      })
      .finally(() => {
        this.#inflight = null;
      });

    const flight: LoginFlight = { controller, waiters, promise };
    this.#inflight = flight;
    return flight;
  }

  /**
   * Perform ONE bounded, unauthenticated `POST /login` and return the accepted
   * token, recording the value-free outcome. Requires exactly HTTP 200 (a
   * 2xx-but-not-200 is a protocol error); a non-2xx status, timeout,
   * cancellation, network, oversized, or malformed outcome is already normalized
   * by the transport. No automatic retry is performed inside the attempt.
   */
  async #attemptLogin(signal: AbortSignal): Promise<string> {
    this.#lastLoginStatus = null;
    this.#lastLoginNormalized = false;

    let result: { status: number; json: unknown };
    try {
      result = await requestUnauthenticatedJson(this.#base, {
        method: "POST",
        path: LOGIN_ENDPOINT,
        body: buildLoginForm(this.#username, this.#password),
        bodyContentType: URLENCODED,
        timeouts: LOGIN_TIMEOUTS,
        signal,
      });
    } catch (error) {
      if (isUpstreamError(error) && typeof error.rawStatus === "number") {
        this.#lastLoginStatus = error.rawStatus;
      }
      throw isUpstreamError(error) ? error : new UpstreamError("authentication");
    }

    this.#lastLoginStatus = result.status;
    if (result.status !== 200) throw new UpstreamError("upstream_protocol", result.status, "POST");
    const token = validateLoginResponse(result.json, result.status);
    this.#lastLoginNormalized = true;
    return token;
  }

  /**
   * Await the shared login as one waiter. The waiter's own cancellation detaches
   * only this waiter and rejects it; the shared login is aborted only when the
   * last waiter has left.
   */
  #joinFlight(flight: LoginFlight, signal?: AbortSignal): Promise<CredentialLease> {
    const waiterKey = {};
    flight.waiters.add(waiterKey);

    return new Promise<CredentialLease>((resolve, reject) => {
      let settled = false;
      const detach = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        flight.waiters.delete(waiterKey);
        detach();
        // Only abort the shared login when no other acquirer still needs it.
        if (flight.waiters.size === 0) flight.controller.abort();
        reject(new UpstreamError("cancellation"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      flight.promise.then(
        (lease) => {
          if (settled) return;
          settled = true;
          flight.waiters.delete(waiterKey);
          detach();
          resolve(lease);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          flight.waiters.delete(waiterKey);
          detach();
          reject(isUpstreamError(error) ? error : new UpstreamError("authentication"));
        },
      );
    });
  }
}

/**
 * A value-free credential/auth-mode configuration failure. Carries a field name
 * and a generic reason; the `name` stays the generic `"Error"` and the message
 * never contains a credential value, so an accidental log emits nothing
 * sensitive.
 */
export class AuthConfigError extends Error {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    super(`${field} ${reason}`);
    this.name = "Error";
    this.field = field;
    this.reason = reason;
  }
}

/** Resolve the auth mode from its raw env value; empty/absent defaults to bearer. */
export function resolveAuthMode(raw: string | undefined): AuthMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "bearer";
  if (value === "bearer" || value === "password") return value;
  throw new AuthConfigError("COLLECTIVIQ_AUTH_MODE", "has unsupported value");
}

/** The provider resolved from the environment, plus the mode it was built for. */
export interface ResolvedCredentials {
  readonly mode: AuthMode;
  readonly provider: CollectivIQCredentialProvider;
  /** The concrete password provider (for auth observations) when mode is password. */
  readonly passwordProvider: PasswordCredentialProvider | null;
}

/**
 * Runtime per-provider login budget. Unlike discovery/recovery (which cap logins
 * at {@link CLI_MAX_LOGINS}), the long-running server may re-login across its
 * whole lifetime — each attempt is still individually bounded (single login
 * flight, single-flight coalescing, bounded transport, no internal retry,
 * generation-safe `401` invalidation, no request replay, `403` non-invalidation).
 */
export const RUNTIME_MAX_LOGINS = Number.POSITIVE_INFINITY;

/**
 * Build the credential provider from ALREADY-VALIDATED configuration values
 * (never re-reading `process.env`). Used by the server runtime after
 * `loadConfig()` so no arbitrary environment state is consulted again. The
 * values are re-checked defensively with the same value-free validators; the
 * inactive mode's credentials are ignored. Constructing the provider performs no
 * I/O and no login (a password login is lazy).
 */
export function buildCredentialProviderFromConfig(input: {
  readonly mode: AuthMode;
  readonly apiKey?: string | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly base: TransportBase;
  readonly maxLogins: number;
}): ResolvedCredentials {
  if (input.mode === "bearer") {
    const token = validateBearerToken(input.apiKey);
    if (!token.ok) throw new AuthConfigError("COLLECTIVIQ_API_KEY", token.reason);
    return {
      mode: "bearer",
      provider: staticBearerCredentialProvider(token.value),
      passwordProvider: null,
    };
  }
  const username = validateUsername(input.username);
  if (!username.ok) throw new AuthConfigError("COLLECTIVIQ_USERNAME", username.reason);
  const password = validatePassword(input.password);
  if (!password.ok) throw new AuthConfigError("COLLECTIVIQ_PASSWORD", password.reason);
  const provider = new PasswordCredentialProvider({
    base: input.base,
    username: username.value,
    password: password.value,
    maxLogins: input.maxLogins,
  });
  return { mode: "password", provider, passwordProvider: provider };
}

/**
 * Build the credential provider for the selected auth mode from the environment.
 * Reads credential values ONLY when called (never at import), so preflight and
 * module import stay credential-free. Inactive-mode credentials are ignored: the
 * explicit mode alone determines which values are read and validated. Throws a
 * value-free {@link AuthConfigError} on any invalid/missing credential.
 */
export function buildCredentialProviderFromEnv(
  env: NodeJS.ProcessEnv,
  base: TransportBase,
  options: { readonly maxLogins: number },
): ResolvedCredentials {
  const mode = resolveAuthMode(env["COLLECTIVIQ_AUTH_MODE"]);
  if (mode === "bearer") {
    const token = validateBearerToken(env["COLLECTIVIQ_API_KEY"]);
    if (!token.ok) throw new AuthConfigError("COLLECTIVIQ_API_KEY", token.reason);
    return { mode, provider: staticBearerCredentialProvider(token.value), passwordProvider: null };
  }
  const username = validateUsername(env["COLLECTIVIQ_USERNAME"]);
  if (!username.ok) throw new AuthConfigError("COLLECTIVIQ_USERNAME", username.reason);
  const password = validatePassword(env["COLLECTIVIQ_PASSWORD"]);
  if (!password.ok) throw new AuthConfigError("COLLECTIVIQ_PASSWORD", password.reason);
  const provider = new PasswordCredentialProvider({
    base,
    username: username.value,
    password: password.value,
    maxLogins: options.maxLogins,
  });
  return { mode, provider, passwordProvider: provider };
}
