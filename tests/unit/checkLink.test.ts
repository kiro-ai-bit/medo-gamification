import { describe, expect, it } from "vitest";
import {
  CHECK_LINK_CACHE_TTL_MS,
  createCheckLinkCache,
  createCachedCheckLink,
  createCareCheckLinkClient,
  type CareCheckLinkClient,
} from "@infrastructure/CareClient/index.js";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const CAREGIVER = "22222222-2222-4222-8222-222222222222";

describe("createCheckLinkCache", () => {
  it("caches positives within TTL", () => {
    const c = createCheckLinkCache(1000);
    c.set(`${PATIENT}:${CAREGIVER}`, true);
    expect(c.get(`${PATIENT}:${CAREGIVER}`)).toBe(true);
  });

  it("never caches negatives", () => {
    const c = createCheckLinkCache(1000);
    c.set(`${PATIENT}:${CAREGIVER}`, false);
    expect(c.get(`${PATIENT}:${CAREGIVER}`)).toBeNull();
  });

  it("expires entries after TTL", async () => {
    const c = createCheckLinkCache(5);
    c.set(`${PATIENT}:${CAREGIVER}`, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.get(`${PATIENT}:${CAREGIVER}`)).toBeNull();
  });

  it("invalidateForUser purges both key positions", () => {
    const c = createCheckLinkCache();
    c.set(`${PATIENT}:${CAREGIVER}`, true);
    c.set(`${CAREGIVER}:${PATIENT}`, true);
    c.set("other:other2", true);
    c.invalidateForUser(PATIENT);
    expect(c.get(`${PATIENT}:${CAREGIVER}`)).toBeNull();
    expect(c.get(`${CAREGIVER}:${PATIENT}`)).toBeNull();
    expect(c.get("other:other2")).toBe(true);
  });
});

describe("createCachedCheckLink", () => {
  it("serves repeat calls from positive cache without hitting client", async () => {
    let calls = 0;
    const client: CareCheckLinkClient = {
      checkLink: async () => {
        calls += 1;
        return true;
      },
    };
    const c = createCachedCheckLink(client);
    expect(await c.checkLink(PATIENT, CAREGIVER)).toBe(true);
    expect(await c.checkLink(PATIENT, CAREGIVER)).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not cache negatives — every call hits the client", async () => {
    let calls = 0;
    const client: CareCheckLinkClient = {
      checkLink: async () => {
        calls += 1;
        return false;
      },
    };
    const c = createCachedCheckLink(client);
    expect(await c.checkLink(PATIENT, CAREGIVER)).toBe(false);
    expect(await c.checkLink(PATIENT, CAREGIVER)).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("createCareCheckLinkClient", () => {
  it("calls check-link with service token aud=medo-care", async () => {
    const seen: { url?: string; auth?: string } = {};
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seen.url = String(input);
      seen.auth = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ active: true }), { status: 200 });
    }) as typeof fetch;
    const client = createCareCheckLinkClient({
      baseUrl: "http://care.test",
      mintServiceToken: async (aud) => `tok-${aud}`,
      fetchImpl,
    });
    expect(await client.checkLink(PATIENT, CAREGIVER)).toBe(true);
    expect(seen.url).toContain("/v1/care/check-link");
    expect(seen.url).toContain(`patientId=${PATIENT}`);
    expect(seen.url).toContain(`caregiverId=${CAREGIVER}`);
    expect(seen.auth).toBe("Bearer tok-medo-care");
  });

  it("throws on upstream failure (fail closed upstream of route)", async () => {
    const fetchImpl = (async () =>
      new Response("err", { status: 503 })) as typeof fetch;
    const client = createCareCheckLinkClient({
      baseUrl: "http://care.test",
      mintServiceToken: async () => "tok",
      fetchImpl,
      timeoutMs: 50,
    });
    await expect(client.checkLink(PATIENT, CAREGIVER)).rejects.toThrow();
  });

  it("TTL constant is the approved 15s", () => {
    expect(CHECK_LINK_CACHE_TTL_MS).toBe(15_000);
  });
});
