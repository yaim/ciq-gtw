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

  registerHealthRoutes(app, readiness);

  return app;
}
