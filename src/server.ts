import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { registerHealthRoutes, type ReadinessState } from "./api/health-route.js";
import { registerV1Routes } from "./api/v1-routes.js";
import { createGatewayAuthenticator } from "./api/gateway-auth.js";
import { createModelCatalog, type ModelCatalog } from "./generation/model-catalog.js";
import type { AppConfig } from "./config/schema.js";

/** The concrete Fastify instance type this application constructs. */
export type GatewayServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export interface BuildServerOptions {
  /** Validated, immutable application configuration. */
  readonly config: AppConfig;
  /** Injected readiness dependency; the server never mutates it. */
  readonly readiness: ReadinessState;
  /** Optional pre-configured logger; when omitted Fastify logging is disabled. */
  readonly logger?: FastifyBaseLogger;
  /**
   * Unix-seconds clock used to capture the one-time catalog timestamp. Injected
   * only for deterministic tests; defaults to the wall clock. Ignored when
   * {@link BuildServerOptions.catalog} is provided.
   */
  readonly now?: () => number;
  /**
   * Pre-built model catalog. Injected only for tests (e.g. to exercise the
   * internal-error path); production builds the catalog from `config.models`.
   */
  readonly catalog?: ModelCatalog;
}

/**
 * Construct the Fastify application without binding a socket.
 *
 * The returned instance can be exercised in-process with `app.inject(...)`.
 * The server knows nothing about CollectivIQ wire schemas.
 */
export function buildServer(options: BuildServerOptions): GatewayServer {
  const { config, readiness, logger } = options;

  const app: GatewayServer = Fastify({
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    // Automatic per-request logging is disabled so request metadata (including
    // headers and URLs) is never emitted by default. Only explicit, safe
    // startup/shutdown lines and health responses are produced.
    logController: new LogController({ disableRequestLogging: true }),
    ...(logger ? { loggerInstance: logger } : {}),
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Liveness/readiness stay unauthenticated on the root instance.
  registerHealthRoutes(app, readiness);

  // Authenticated public API. The catalog captures a single Unix-seconds
  // timestamp at construction and reuses it for every model object it serves.
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const catalog = options.catalog ?? createModelCatalog(config.models, now());
  const authenticator = createGatewayAuthenticator(config.COLLECTIVIQ_GATEWAY_KEYS);
  registerV1Routes(app, { authenticator, catalog });

  return app;
}
