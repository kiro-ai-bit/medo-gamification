import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrokerEvent } from "@kiro-ai-bit/eventing";
import type { DoseDetailDto, DoseSummaryDto } from "@kiro-ai-bit/contracts";
import { createTestApp, wrap, type TestApp } from "../helpers.js";
import {
  createConsumerDispatch,
  dispatchEvent,
  InvalidEventError,
  type ConsumerDeps,
} from "@application/EventConsumer/dispatch.js";
import { pullOutcomeHistory } from "@application/Bootstrap/bootstrap.js";
import { createCheckLinkCache } from "@infrastructure/CareClient/checkLink.js";
import { startGamificationConsumer } from "@infrastructure/Eventing/index.js";
import { PeerNotFoundError } from "@infrastructure/Clients/http.js";
import {
  createBootstrapStateRepo,
  createDoseOutcomeProjectionRepo,
  createGamificationStateRepo,
  createProcessedEventMarkerRepo,
  createPurgeTombstoneRepo,
} from "@infrastructure/Persistence/repositories.js";
import type { ScheduleDoseClient } from "@infrastructure/ScheduleDoseClient/index.js";
import { getState } from "@core/GamificationState/state.js";
import type { Db } from "@infrastructure/Persistence/db.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const MED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MED2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACTOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let t: TestApp;
let db: Db;
const projRepo = createDoseOutcomeProjectionRepo();
const bootRepo = createBootstrapStateRepo();
const markerRepo = createProcessedEventMarkerRepo();
const tombRepo = createPurgeTombstoneRepo();
const stateRepo = createGamificationStateRepo();

beforeAll(async () => {
  t = await createTestApp();
  db = t.db;
});
afterAll(async () => {
  await t.closeAll();
});

// doseIds are globally unique PKs and patients own separate state — every
// test gets fresh ids to stay isolated on the shared PGlite database.
let idSeq = 0;
function uid(): string {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

function doseEvent(over: Record<string, unknown> = {}): BrokerEvent {
  return {
    id: "1",
    eventId: uid(),
    occurredAt: "2026-11-26T11:59:00.000Z",
    type: "DoseOutcomeChanged",
    doseId: uid(),
    medicineId: MED,
    patientId: uid(),
    outcome: "taken-on-time",
    ...over,
  } as BrokerEvent;
}

function deletedEvent(userId: string): BrokerEvent {
  return {
    id: "1",
    eventId: uid(),
    occurredAt: "2026-11-26T11:59:00.000Z",
    type: "AccountDeleted",
    userId,
  } as BrokerEvent;
}

function summary(over: Partial<DoseSummaryDto> = {}): DoseSummaryDto {
  return {
    id: uid(),
    medicineId: MED,
    patientId: uid(),
    scheduleId: uid(),
    localDate: "2026-01-01",
    doseTime: "08:00",
    scheduledAt: "2026-01-01T08:00:00.000Z",
    outcome: "taken-on-time",
    skippedByUser: false,
    snoozedUntil: null,
    actorId: ACTOR,
    markedAt: "2026-01-01T08:05:00.000Z",
    ...over,
  };
}

function detail(over: Partial<DoseDetailDto> = {}): DoseDetailDto {
  return {
    ...summary(),
    createdAt: "2026-01-01T07:00:00.000Z",
    updatedAt: "2026-01-01T08:05:00.000Z",
    ...over,
  };
}

interface FakeSd {
  client: ScheduleDoseClient;
  listCalls: { patientId: string; from: string; to: string }[];
  getCalls: string[];
}

function fakeScheduleDose(opts: {
  doses?: DoseSummaryDto[];
  details?: Record<string, DoseDetailDto>;
}): FakeSd {
  const listCalls: FakeSd["listCalls"] = [];
  const getCalls: string[] = [];
  const client: ScheduleDoseClient = {
    listPatientDoses: vi.fn(async (patientId, from, to) => {
      listCalls.push({ patientId, from, to });
      return opts.doses ?? [];
    }),
    getDose: vi.fn(async (doseId) => {
      getCalls.push(doseId);
      const d = opts.details?.[doseId];
      if (d === undefined) throw new PeerNotFoundError(`dose ${doseId} 404`);
      return d;
    }),
  };
  return { client, listCalls, getCalls };
}

function makeDeps(sd: ScheduleDoseClient): ConsumerDeps {
  return {
    db,
    scheduleDose: sd,
    checkLinkCache: createCheckLinkCache(),
    metrics: { incr: () => {}, observe: () => {} },
    now: () => NOW,
  };
}

describe("DoseOutcomeChanged — first-sight bootstrap + apply", () => {
  it("bootstraps history then applies the event atomically", async () => {
    const patient = uid();
    const dSeed = uid();
    const dTrig = uid();
    const dUnmarked = uid();
    const sd = fakeScheduleDose({
      doses: [
        summary({ id: dSeed, patientId: patient }), // taken-on-time, markedAt 08:05
        summary({
          id: dUnmarked,
          patientId: patient,
          outcome: "unmarked",
          markedAt: null,
          scheduledAt: "2026-01-01T09:00:00.000Z",
        }), // filtered — unmarked contributes nothing
        summary({
          id: dTrig,
          patientId: patient,
          outcome: "taken-late",
          scheduledAt: "2026-01-02T08:00:00.000Z",
          markedAt: "2026-01-02T09:00:00.000Z",
        }),
      ],
    });
    const deps = makeDeps(sd.client);
    const ev = doseEvent({
      patientId: patient,
      doseId: dTrig,
      outcome: "taken-late",
    });

    await dispatchEvent(deps, ev);

    // epoch→now pull, no outcome param (client signature carries none)
    expect(sd.listCalls).toHaveLength(1);
    expect(sd.listCalls[0].patientId).toBe(patient);
    expect(sd.listCalls[0].from).toBe("1970-01-01T00:00:00.000Z");
    expect(sd.listCalls[0].to).toBe(NOW.toISOString());
    expect(sd.getCalls).toHaveLength(0);

    // projection: seed rows + triggering dose; unmarked absent
    expect(await projRepo.existsByDoseId(db, dSeed)).toBe(true);
    expect(await projRepo.existsByDoseId(db, dTrig)).toBe(true);
    expect(await projRepo.existsByDoseId(db, dUnmarked)).toBe(false);
    // seed occurredAt = markedAt (LD-GAM-04)
    const seed = await projRepo.getByDoseId(db, dSeed);
    expect(seed?.occurredAt.toISOString()).toBe("2026-01-01T08:05:00.000Z");

    // score: +10 (on-time) then -5 (late) = 5, theme Uneasy
    const dto = await getState(db, patient);
    expect(dto.harmonyPoints).toBe(5);
    expect(dto.themeState).toBe("Uneasy");
    expect(dto.updatedAt).toBe(NOW.toISOString());

    // bootstrap bookkeeping + dedup marker
    const bs = await bootRepo.get(db, patient);
    expect(bs?.bootstrapCount).toBe(1);
    expect(bs?.gapEpisodeOpen).toBe(false);
    expect(
      await markerRepo.has(db, ev.eventId as string, "dose-outcome-applied"),
    ).toBe(true);
  });

  it("redelivery of the same eventId is a no-op", async () => {
    const patient = uid();
    const dSeed = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
    });
    const deps = makeDeps(sd.client);
    const ev = doseEvent({ patientId: patient, doseId: dSeed });
    await dispatchEvent(deps, ev);
    await dispatchEvent(deps, ev);
    expect(sd.listCalls).toHaveLength(1);
  });
});

describe("DoseOutcomeChanged — gap episode state machine", () => {
  it("re-bootstraps once per episode, then dose-detail; covered event closes", async () => {
    const patient = uid();
    const dSeed = uid();
    const dGap1 = uid();
    const dGap2 = uid();
    const dGap3 = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
      details: {
        [dGap1]: detail({
          id: dGap1,
          patientId: patient,
          scheduledAt: "2026-02-01T08:00:00.000Z",
        }),
        [dGap2]: detail({
          id: dGap2,
          patientId: patient,
          scheduledAt: "2026-02-02T08:00:00.000Z",
        }),
        [dGap3]: detail({
          id: dGap3,
          patientId: patient,
          scheduledAt: "2026-02-03T08:00:00.000Z",
        }),
      },
    });
    const deps = makeDeps(sd.client);
    const base = { patientId: patient, medicineId: MED };

    // e1 — first sight: bootstrap (pull #1)
    await dispatchEvent(deps, doseEvent({ ...base, doseId: dSeed }));
    expect(sd.listCalls).toHaveLength(1);

    // e2 — gap: episode opens, ONE re-pull (#2), still absent → dose-detail
    await dispatchEvent(
      deps,
      doseEvent({ ...base, doseId: dGap1, outcome: "taken-on-time" }),
    );
    expect(sd.listCalls).toHaveLength(2);
    expect(sd.getCalls).toEqual([dGap1]);
    let bs = await bootRepo.get(db, patient);
    expect(bs?.gapEpisodeOpen).toBe(true);
    expect(bs?.gapRebootstrapUsed).toBe(true);

    // e3 — episode open: straight to dose-detail, NO re-pull
    await dispatchEvent(
      deps,
      doseEvent({ ...base, doseId: dGap2, outcome: "skipped" }),
    );
    expect(sd.listCalls).toHaveLength(2);
    expect(sd.getCalls).toEqual([dGap1, dGap2]);
    bs = await bootRepo.get(db, patient);
    expect(bs?.gapEpisodeOpen).toBe(true);

    // e4 — covered doseId → episode closes
    await dispatchEvent(
      deps,
      doseEvent({
        ...base,
        doseId: dSeed,
        outcome: "taken-late",
        occurredAt: "2026-11-26T11:58:00.000Z",
      }),
    );
    bs = await bootRepo.get(db, patient);
    expect(bs?.gapEpisodeOpen).toBe(false);
    expect(bs?.gapRebootstrapUsed).toBe(false);

    // e5 — new gap after close → fresh episode, re-pull #3
    await dispatchEvent(
      deps,
      doseEvent({ ...base, doseId: dGap3, outcome: "missed" }),
    );
    expect(sd.listCalls).toHaveLength(3);
    expect(sd.getCalls).toEqual([dGap1, dGap2, dGap3]);
    bs = await bootRepo.get(db, patient);
    expect(bs?.gapEpisodeOpen).toBe(true);
    expect(bs?.bootstrapCount).toBe(3); // initial + 2 gap re-bootstraps
  });
});

describe("DoseOutcomeChanged — dose-detail fallback guards", () => {
  it("patientId mismatch → InvalidEventError, nothing persisted", async () => {
    const patient = uid();
    const dSeed = uid();
    const dGap = uid();
    const foreign = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
      details: {
        [dGap]: detail({
          id: dGap,
          patientId: foreign, // mismatch
          medicineId: MED,
        }),
      },
    });
    const deps = makeDeps(sd.client);
    const ev = doseEvent({ patientId: patient, doseId: dGap, medicineId: MED });
    await expect(dispatchEvent(deps, ev)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    expect(await projRepo.existsByDoseId(db, dGap)).toBe(false);
    expect(
      await markerRepo.has(db, ev.eventId as string, "dose-outcome-applied"),
    ).toBe(false);
  });

  it("medicineId mismatch → InvalidEventError", async () => {
    const patient = uid();
    const dSeed = uid();
    const dGap = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
      details: {
        [dGap]: detail({
          id: dGap,
          patientId: patient,
          medicineId: MED2, // mismatch vs event MED
        }),
      },
    });
    const deps = makeDeps(sd.client);
    await expect(
      dispatchEvent(
        deps,
        doseEvent({ patientId: patient, doseId: dGap, medicineId: MED }),
      ),
    ).rejects.toBeInstanceOf(InvalidEventError);
  });

  it("upstream 404 on dose-detail → InvalidEventError (poison → DLQ path)", async () => {
    const patient = uid();
    const dSeed = uid();
    const dGap = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
      // dGap absent from details → getDose throws PeerNotFoundError
    });
    const deps = makeDeps(sd.client);
    await expect(
      dispatchEvent(
        deps,
        doseEvent({ patientId: patient, doseId: dGap, medicineId: MED }),
      ),
    ).rejects.toBeInstanceOf(InvalidEventError);
  });

  it("non-enum outcome is rejected before any write", async () => {
    const deps = makeDeps(fakeScheduleDose({}).client);
    const ev = doseEvent({ outcome: "bogus-outcome" });
    await expect(dispatchEvent(deps, ev)).rejects.toThrow();
    expect(
      await markerRepo.has(db, ev.eventId as string, "dose-outcome-applied"),
    ).toBe(false);
  });
});

describe("AccountDeleted — purge + tombstone", () => {
  it("purges all patient-scoped state and writes tombstone + marker", async () => {
    const patient = uid();
    const dSeed = uid();
    const dLate = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
    });
    const deps = makeDeps(sd.client);
    const ev1 = doseEvent({ patientId: patient, doseId: dSeed });
    await dispatchEvent(deps, ev1); // creates state+projection+bootstrap+marker

    const del = deletedEvent(patient);
    await dispatchEvent(deps, del);

    expect(await stateRepo.getByPatientId(db, patient)).toBeNull();
    expect(await projRepo.existsForPatient(db, patient)).toBe(false);
    expect(await bootRepo.get(db, patient)).toBeNull();
    expect(
      await markerRepo.has(db, del.eventId as string, "account-deleted-purged"),
    ).toBe(true);
    expect(await tombRepo.exists(db, patient)).toBe(true);
    // patient-scoped markers purged (old dose marker gone)
    expect(
      await markerRepo.has(db, ev1.eventId as string, "dose-outcome-applied"),
    ).toBe(false);

    // late DoseOutcomeChanged cannot resurrect — ignored, marker still written
    const late = doseEvent({ patientId: patient, doseId: dLate });
    await dispatchEvent(deps, late);
    expect(await projRepo.existsByDoseId(db, dLate)).toBe(false);
    expect(await stateRepo.getByPatientId(db, patient)).toBeNull();
    expect(
      await markerRepo.has(db, late.eventId as string, "dose-outcome-applied"),
    ).toBe(true);
    expect(sd.getCalls).toHaveLength(0); // tombstone check precedes coverage
  });

  it("caregiver-style userId writes tombstone+marker, deletes nothing", async () => {
    const sd = fakeScheduleDose({});
    const deps = makeDeps(sd.client);
    const user = uid();
    const del = deletedEvent(user);
    await dispatchEvent(deps, del);
    expect(await tombRepo.exists(db, user)).toBe(true);
    expect(
      await markerRepo.has(db, del.eventId as string, "account-deleted-purged"),
    ).toBe(true);
  });
});

describe("pullOutcomeHistory mapping (LD-GAM-04)", () => {
  it("epoch→now window, unmarked filtered, occurredAt = markedAt ?? scheduledAt", async () => {
    const patient = uid();
    const dSeed = uid();
    const dNoMarked = uid();
    const dUnmarked = uid();
    const sd = fakeScheduleDose({
      doses: [
        summary({ id: dSeed, patientId: patient }),
        summary({
          id: dUnmarked,
          patientId: patient,
          outcome: "unmarked",
          markedAt: null,
        }),
        summary({
          id: dNoMarked,
          patientId: patient,
          outcome: "skipped",
          markedAt: null, // defensive fallback → scheduledAt
          scheduledAt: "2026-03-01T08:00:00.000Z",
        }),
      ],
    });
    const seeds = await pullOutcomeHistory(patient, {
      scheduleDose: sd.client,
      db,
      now: () => NOW,
    });
    expect(seeds).toHaveLength(2);
    const byId = new Map(seeds.map((s) => [s.doseId, s]));
    expect(byId.get(dSeed)?.occurredAt.toISOString()).toBe(
      "2026-01-01T08:05:00.000Z",
    );
    expect(byId.get(dNoMarked)?.occurredAt.toISOString()).toBe(
      "2026-03-01T08:00:00.000Z",
    );
    expect(byId.has(dUnmarked)).toBe(false);
  });
});

describe("consumer worker + marker prune", () => {
  it("tick processes a broker event and advances the offset", async () => {
    const patient = uid();
    const dSeed = uid();
    const sd = fakeScheduleDose({
      doses: [summary({ id: dSeed, patientId: patient })],
    });
    const deps = makeDeps(sd.client);
    const consumer = await startGamificationConsumer({
      service: wrap(t.servicePg),
      broker: wrap(t.brokerPg),
      dispatch: createConsumerDispatch(deps),
    });
    try {
      const eventId = uid();
      const payload = {
        doseId: dSeed,
        medicineId: MED,
        patientId: patient,
        outcome: "taken-on-time",
        actorId: ACTOR,
        occurredAt: "2026-11-26T11:00:00.000Z",
        eventId,
        type: "DoseOutcomeChanged",
      };
      await t.brokerPg.query(
        `INSERT INTO events (event_id, event_type, payload, occurred_at)
         VALUES ($1, 'DoseOutcomeChanged', $2::jsonb, $3)`,
        [eventId, JSON.stringify(payload), payload.occurredAt],
      );
      const res = await consumer.tick();
      expect(res.processed).toBeGreaterThanOrEqual(1);
      expect(await projRepo.existsByDoseId(db, dSeed)).toBe(true);
      const off = await t.servicePg.query<{ last_event_id: string }>(
        `SELECT last_event_id FROM consumer_offsets WHERE consumer_name = 'gamification'`,
      );
      expect(Number(off.rows[0]?.last_event_id)).toBeGreaterThan(0);
    } finally {
      await consumer.stop();
    }
  });

  it("inline marker prune deletes only rows older than 30d, bounded", async () => {
    const oldId = uid();
    const freshId = uid();
    const patient = uid();
    await t.servicePg.query(
      `INSERT INTO processed_event_markers (event_id, action, patient_id, processed_at)
       VALUES ($1, 'dose-outcome-applied', $2, $3), ($4, 'dose-outcome-applied', $2, now())`,
      [oldId, patient, new Date("2026-10-01T00:00:00.000Z"), freshId],
    );
    const deleted = await markerRepo.deleteOlderThan(
      db,
      new Date(NOW.getTime() - 30 * 24 * 3600 * 1000),
      500,
    );
    expect(deleted).toBe(1);
    expect(await markerRepo.has(db, oldId, "dose-outcome-applied")).toBe(false);
    expect(await markerRepo.has(db, freshId, "dose-outcome-applied")).toBe(
      true,
    );
  });
});
