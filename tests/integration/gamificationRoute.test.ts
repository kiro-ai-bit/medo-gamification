import { afterAll, describe, expect, it } from "vitest";
import {
  auth,
  caregiverToken,
  createTestApp,
  j,
  makeKeys,
  OTHER_USER_ID,
  PATIENT_ID,
  patientToken,
  type TestApp,
} from "../helpers.js";

const apps: TestApp[] = [];
async function appWithCare(
  active: boolean | "down",
): Promise<{ t: TestApp; calls: () => number }> {
  const keys = await makeKeys();
  let calls = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const u = String(input);
    if (u.endsWith("/.well-known/jwks.json")) {
      return new Response(JSON.stringify({ keys: [keys.identityPublicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/v1/care/check-link")) {
      calls += 1;
      if (active === "down") return new Response("err", { status: 503 });
      return new Response(JSON.stringify({ active }), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  const t = await createTestApp({ keys, fetchImpl });
  apps.push(t);
  return { t, calls: () => calls };
}

afterAll(async () => {
  for (const t of apps) await t.closeAll();
});

const url = (id: string) => `/v1/patients/${id}/gamification`;

describe("GET /v1/patients/{id}/gamification — authz + contract", () => {
  it("patient-self read returns defaults for absent state", async () => {
    const { t } = await appWithCare(true);
    const tok = await patientToken(t);
    const res = await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res)).toEqual({
      harmonyPoints: 0,
      themeState: "Harmony",
      updatedAt: null,
    });
  });

  it("rejects missing JWT with 401 UNAUTHORIZED", async () => {
    const { t } = await appWithCare(true);
    const res = await t.app.inject({ method: "GET", url: url(PATIENT_ID) });
    expect(res.statusCode).toBe(401);
    expect(j(res).error.code).toBe("UNAUTHORIZED");
  });

  it("rejects non-UUID patientId with 400 VALIDATION_FAILED", async () => {
    const { t } = await appWithCare(true);
    const tok = await patientToken(t);
    const res = await t.app.inject({
      method: "GET",
      url: url("not-a-uuid"),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(400);
    expect(j(res).error.code).toBe("VALIDATION_FAILED");
  });

  it("denies Patient role reading another patient with 403, no leakage", async () => {
    const { t, calls } = await appWithCare(true);
    const tok = await patientToken(t, OTHER_USER_ID);
    const res = await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(403);
    expect(j(res).error.code).toBe("FORBIDDEN");
    expect(Object.keys(j(res))).toEqual(["error"]);
    expect(calls()).toBe(0); // non-caregiver never reaches check-link
  });

  it("caregiver with active link gets 200 same DTO shape", async () => {
    const { t } = await appWithCare(true);
    const tok = await caregiverToken(t);
    const res = await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res)).toEqual({
      harmonyPoints: 0,
      themeState: "Harmony",
      updatedAt: null,
    });
  });

  it("caregiver with inactive link gets 403 FORBIDDEN", async () => {
    const { t } = await appWithCare(false);
    const tok = await caregiverToken(t);
    const res = await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(403);
    expect(j(res).error.code).toBe("FORBIDDEN");
  });

  it("caregiver negative result is never cached — repeat calls re-hit Care", async () => {
    const { t, calls } = await appWithCare(false);
    const tok = await caregiverToken(t);
    await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(calls()).toBe(2);
  });

  it("caregiver positive result IS cached ≤15s — one upstream call", async () => {
    const { t, calls } = await appWithCare(true);
    const tok = await caregiverToken(t);
    await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(calls()).toBe(1);
  });

  it("check-link failure fails closed → 503 DEPENDENCY_UNAVAILABLE", async () => {
    const { t } = await appWithCare("down");
    const tok = await caregiverToken(t);
    const res = await t.app.inject({
      method: "GET",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(503);
    expect(j(res).error.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("non-GET methods → 404", async () => {
    const { t } = await appWithCare(true);
    const tok = await patientToken(t);
    const res = await t.app.inject({
      method: "POST",
      url: url(PATIENT_ID),
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(404);
  });
});
