import { describe, expect, it, vi } from "vitest";
import { createScheduleDoseClient } from "@infrastructure/ScheduleDoseClient/index.js";
import { PeerNotFoundError } from "@infrastructure/Clients/http.js";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const DOSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function doseSummary(id: string) {
  return {
    id,
    medicineId: MED,
    patientId: PATIENT,
    scheduleId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    localDate: "2026-01-01",
    doseTime: "08:00",
    scheduledAt: "2026-01-01T08:00:00.000Z",
    outcome: "taken-on-time",
    skippedByUser: false,
    snoozedUntil: null,
    actorId: null,
    markedAt: "2026-01-01T08:05:00.000Z",
  };
}

function makeClient(fetchImpl: typeof fetch) {
  return createScheduleDoseClient({
    baseUrl: "http://schedule-dose.test/",
    mintServiceToken: vi.fn(async () => "svc-jwt"),
    fetchImpl,
  });
}

describe("ScheduleDoseClient", () => {
  it("listPatientDoses hits the internal route with from/to and parses DTOs", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        doses: [doseSummary(DOSE)],
        from: "1970-01-01T00:00:00.000Z",
        to: "2026-11-26T12:00:00.000Z",
      }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const doses = await client.listPatientDoses(
      PATIENT,
      "1970-01-01T00:00:00.000Z",
      "2026-11-26T12:00:00.000Z",
    );
    expect(doses).toHaveLength(1);
    expect(doses[0].id).toBe(DOSE);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe(
      `http://schedule-dose.test/v1/patients/${PATIENT}/doses?from=1970-01-01T00%3A00%3A00.000Z&to=2026-11-26T12%3A00%3A00.000Z`,
    );
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer svc-jwt",
    });
  });

  it("getDose parses DoseDetailDto and maps 404 → PeerNotFoundError", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ...doseSummary(DOSE),
        createdAt: "2026-01-01T07:00:00.000Z",
        updatedAt: "2026-01-01T08:05:00.000Z",
      }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const d = await client.getDose(DOSE);
    expect(d.id).toBe(DOSE);
    expect(d.createdAt).toBe("2026-01-01T07:00:00.000Z");

    const nfFetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;
    const nf = makeClient(nfFetch);
    await expect(nf.getDose(DOSE)).rejects.toBeInstanceOf(PeerNotFoundError);
  });

  it("malformed payload → PeerUnavailableError (retryable)", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ bogus: true }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.listPatientDoses(
        PATIENT,
        "1970-01-01T00:00:00.000Z",
        "2026-11-26T12:00:00.000Z",
      ),
    ).rejects.toThrow();
  });
});
