import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  rateLimitPlugin,
  type RateLimitOptions,
} from "@kiro-ai-bit/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { JWK } from "jose";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import { ensureGamificationEventing } from "@infrastructure/Eventing/index.js";
import { createJwksCache } from "@infrastructure/AuthzClient/jwks.js";
import { createServiceTokenMinter } from "@infrastructure/AuthzClient/serviceToken.js";
import {
  createCachedCheckLink,
  createCareCheckLinkClient,
} from "@infrastructure/CareClient/index.js";
import { registerErrorHandler } from "./Middleware/errors.js";
import { registerAuthn } from "./Middleware/authn.js";
import {
  createMetrics,
  registerRedHook,
  type MetricsImpl,
} from "./Middleware/metrics.js";
import { registerGamificationRoutes } from "./Public/gamification.js";
import { registerPlatformRoutes } from "./Platform/routes.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BROKER_DATABASE_URL: z.string().min(1),
  SERVICE_PUBLIC_KEYS: z.string().min(1),
  SERVICE_PRIVATE_KEY: z.string().min(1),
  IDENTITY_JWKS_URL: z.string().min(1),
  CARE_BASE_URL: z.string().url(),
  SENTRY_DSN: z.string().optional().default(""),
  PORT: z.coerce.number().int().positive().default(3006),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  brokerDatabaseUrl: string;
  servicePublicKeys: Record<string, JWK[]>;
  servicePrivateKey: JWK;
  identityJwksUrl: string;
  careBaseUrl: string;
  sentryDsn: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    brokerDatabaseUrl: e.BROKER_DATABASE_URL,
    servicePublicKeys: JSON.parse(e.SERVICE_PUBLIC_KEYS) as Record<
      string,
      JWK[]
    >,
    servicePrivateKey: JSON.parse(e.SERVICE_PRIVATE_KEY) as JWK,
    identityJwksUrl: e.IDENTITY_JWKS_URL,
    careBaseUrl: e.CARE_BASE_URL,
    sentryDsn: e.SENTRY_DSN,
  };
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  gamificationQueryable: Queryable;
  brokerQueryable: Queryable;
  rateLimitOptions?: RateLimitOptions;
  fetchImpl?: typeof fetch;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  metrics: MetricsImpl;
  checkLinkCache: ReturnType<typeof createCachedCheckLink>["cache"];
  close: () => Promise<void>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  if (config.sentryDsn) {
    Sentry.init({ dsn: config.sentryDsn, environment: config.nodeEnv });
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && h.length > 0 ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
  });

  registerErrorHandler(app);

  const metrics = createMetrics();
  registerRedHook(app, metrics);

  const jwks = createJwksCache({
    jwksUrl: config.identityJwksUrl,
    fetchImpl: deps.fetchImpl,
  });

  // user-JWT authN for the public route; service-JWT auth for platform surface
  registerAuthn(app, {
    jwks,
    userIssuer: "medo-identity",
    userAudience: "medo",
    servicePublicKeys: config.servicePublicKeys,
    serviceAudience: "medo-gamification",
  });
  await app.register(rateLimitPlugin, deps.rateLimitOptions ?? {});

  registerPlatformRoutes(app, {
    db: deps.db,
    broker: deps.brokerQueryable,
    metrics,
  });

  // Outbound service-JWT minter + Care check-link client (positive-only cache).
  const mintToken = createServiceTokenMinter(config.servicePrivateKey);
  const care = createCachedCheckLink(
    createCareCheckLinkClient({
      baseUrl: config.careBaseUrl,
      mintServiceToken: mintToken,
      fetchImpl: deps.fetchImpl,
    }),
    undefined,
    (result) => metrics.incr("medo_gamification_checklink_total", { result }),
  );

  registerGamificationRoutes(app, {
    db: deps.db,
    checkLink: care.checkLink,
    metrics,
  });

  await ensureGamificationEventing({
    service: deps.gamificationQueryable,
    broker: deps.brokerQueryable,
  });

  return {
    app,
    db: deps.db,
    metrics,
    checkLinkCache: care.cache,
    close: async () => {
      await app.close();
    },
  };
}
