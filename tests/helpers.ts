import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "@kiro-ai-bit/eventing";
import * as schema from "@infrastructure/Persistence/schema/index.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import { buildApp, type AppConfig, type BuiltApp } from "@webapi/bootstrap.js";
import type { JWK } from "jose";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

export function wrap(pg: PGlite): Queryable {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      const res = await pg.query<T>(text, params as unknown[]);
      return { rows: res.rows };
    },
  };
}

export interface TestKeys {
  identityPrivateJwk: JWK;
  identityPublicJwk: JWK;
  gamificationServicePrivateJwk: JWK;
  peerServicePublicJwkByIss: Record<string, JWK[]>;
}

export async function makeKeys(): Promise<TestKeys> {
  const ident = await generateKeyPair("ES256", { extractable: true });
  const svc = await generateKeyPair("ES256", { extractable: true });
  const ip = (await exportJWK(ident.publicKey)) as JWK;
  const is = (await exportJWK(ident.privateKey)) as JWK;
  const cp = (await exportJWK(svc.publicKey)) as JWK;
  const cs = (await exportJWK(svc.privateKey)) as JWK;
  for (const k of [ip, is, cp, cs]) {
    k.kid = "test-kid";
    k.alg = "ES256";
    k.use = "sig";
  }
  return {
    identityPrivateJwk: is,
    identityPublicJwk: ip,
    gamificationServicePrivateJwk: cs,
    peerServicePublicJwkByIss: {
      "medo-identity": [cp],
      "medo-care": [cp],
      "medo-medicine": [cp],
      "medo-notification": [cp],
      "medo-gamification": [cp],
      "medo-schedule-dose": [cp],
    },
  };
}

export function makeConfig(
  keys: TestKeys,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    databaseUrl: "pglite://",
    brokerDatabaseUrl: "pglite://",
    servicePublicKeys: keys.peerServicePublicJwkByIss,
    identityJwksUrl: "http://identity.test/.well-known/jwks.json",
    servicePrivateKey: keys.gamificationServicePrivateJwk,
    careBaseUrl: "http://care.test",
    scheduleDoseBaseUrl: "http://schedule-dose.test",
    sentryDsn: "",
    ...overrides,
  };
}

export interface TestApp extends BuiltApp {
  servicePg: PGlite;
  brokerPg: PGlite;
  config: AppConfig;
  keys: TestKeys;
  closeAll: () => Promise<void>;
}

export async function createTestApp(
  opts: {
    configOverrides?: Partial<AppConfig>;
    fetchImpl?: typeof fetch;
    keys?: TestKeys;
  } = {},
): Promise<TestApp> {
  const keys = opts.keys ?? (await makeKeys());
  const config = makeConfig(keys, opts.configOverrides);
  const fetchImpl =
    opts.fetchImpl ??
    ((async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) {
        return new Response(
          JSON.stringify({ keys: [keys.identityPublicJwk] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);
  const servicePg = new PGlite();
  const brokerPg = new PGlite();
  const serviceDb = drizzlePglite(servicePg, { schema });
  await migratePglite(serviceDb, { migrationsFolder: MIGRATIONS });
  const db = serviceDb as unknown as Db;
  const built = await buildApp({
    config,
    db,
    gamificationQueryable: wrap(servicePg),
    brokerQueryable: wrap(brokerPg),
    rateLimitOptions: {
      limits: { public: 100000, write: 100000, read: 100000 },
    },
    fetchImpl,
  });
  return {
    ...built,
    servicePg,
    brokerPg,
    config,
    keys,
    closeAll: async () => {
      await built.close();
      await servicePg.close();
      await brokerPg.close();
    },
  };
}

export async function mintUserToken(
  keys: TestKeys,
  opts: { sub: string; role: "Patient" | "Caregiver"; sid?: string },
): Promise<string> {
  const key = await importJWK(keys.identityPrivateJwk, "ES256");
  return new SignJWT({ role: opts.role, sid: opts.sid ?? "sess-1" })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid", typ: "JWT" })
    .setIssuer("medo-identity")
    .setAudience("medo")
    .setSubject(opts.sub)
    .setIssuedAt()
    .setExpirationTime("25m")
    .sign(key as CryptoKey);
}

export const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
export const CAREGIVER_ID = "22222222-2222-4222-8222-222222222222";
export const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const j = (r: { json(): unknown }) => r.json() as Record<string, any>;
export const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

export function patientToken(t: TestApp, sub = PATIENT_ID) {
  return mintUserToken(t.keys, { sub, role: "Patient" });
}

export function caregiverToken(t: TestApp, sub = CAREGIVER_ID) {
  return mintUserToken(t.keys, { sub, role: "Caregiver" });
}
