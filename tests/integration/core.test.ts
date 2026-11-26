import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers.js";
import { createDoseOutcomeProjectionRepo } from "@infrastructure/Persistence/repositories.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import {
  applyOutcomeEvent,
  getProjection,
  seedProjectionRows,
} from "@core/OutcomeProjection/projection.js";
import { getState, upsertRecomputed } from "@core/GamificationState/state.js";
import { recompute } from "@core/Scoring/scoring.js";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const DOSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOSE2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let t: TestApp;
let db: Db;
const repo = createDoseOutcomeProjectionRepo();

beforeAll(async () => {
  t = await createTestApp();
  db = t.db;
});
afterAll(async () => {
  await t.closeAll();
});

function fields(over: Partial<Parameters<typeof applyOutcomeEvent>[2]> = {}) {
  return {
    patientId: PATIENT,
    scheduledAt: new Date("2026-01-01T08:00:00Z"),
    outcome: "taken-on-time" as const,
    occurredAt: new Date("2026-01-01T08:05:00Z"),
    medicineId: MED,
    ...over,
  };
}

describe("dose_outcome_projection upsertLatestWins", () => {
  it("inserts on first sight", async () => {
    const r = await applyOutcomeEvent(db, DOSE, fields());
    expect(r).toBe("inserted");
    const row = await getProjection(db, DOSE);
    expect(row?.outcome).toBe("taken-on-time");
    expect(row?.patientId).toBe(PATIENT);
  });

  it("applies newer occurredAt and ignores stale occurredAt", async () => {
    await applyOutcomeEvent(
      db,
      DOSE,
      fields({
        outcome: "missed",
        occurredAt: new Date("2026-01-01T09:00:00Z"),
      }),
    );
    let row = await getProjection(db, DOSE);
    expect(row?.outcome).toBe("missed");

    // stale event — older occurredAt cannot overwrite
    const stale = await applyOutcomeEvent(
      db,
      DOSE,
      fields({
        outcome: "taken-on-time",
        occurredAt: new Date("2026-01-01T08:30:00Z"),
      }),
    );
    expect(stale).toBe("stale");
    row = await getProjection(db, DOSE);
    expect(row?.outcome).toBe("missed");
  });

  it("equal occurredAt → sequential last-wins", async () => {
    const occ = new Date("2026-01-01T10:00:00Z");
    await applyOutcomeEvent(db, DOSE2, fields({ occurredAt: occ }));
    const r = await applyOutcomeEvent(
      db,
      DOSE2,
      fields({ outcome: "skipped", occurredAt: occ }),
    );
    expect(r).toBe("applied");
    const row = await getProjection(db, DOSE2);
    expect(row?.outcome).toBe("skipped");
  });

  it("patientId consistency — foreign patientId never overwrites (LLD §4.5)", async () => {
    const foreign = "99999999-9999-4999-8999-999999999999";
    const before = await getProjection(db, DOSE2);
    const r = await applyOutcomeEvent(
      db,
      DOSE2,
      fields({
        patientId: foreign,
        scheduledAt: new Date("2030-01-01T00:00:00Z"),
        outcome: "missed",
        occurredAt: new Date("2026-01-05T00:00:00Z"),
      }),
    );
    expect(r).toBe("stale");
    const row = await getProjection(db, DOSE2);
    expect(row?.patientId).toBe(PATIENT);
    expect(row?.outcome).toBe(before?.outcome);
    expect(row?.scheduledAt.toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  it("stores actorId for audit but it is not part of scoring input", async () => {
    const actor = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await applyOutcomeEvent(
      db,
      DOSE,
      fields({ actorId: actor, occurredAt: new Date("2026-01-03T00:00:00Z") }),
    );
    const row = await getProjection(db, DOSE);
    expect(row?.actorId).toBe(actor);
  });

  it("seedProjectionRows bulk-upserts with the same latest-wins guard", async () => {
    const seedDose = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const n1 = await seedProjectionRows(db, [
      {
        doseId: seedDose,
        patientId: PATIENT,
        scheduledAt: new Date("2026-02-01T08:00:00Z"),
        outcome: "taken-on-time",
        occurredAt: new Date("2026-02-01T08:05:00Z"),
      },
    ]);
    expect(n1).toBe(1);
    // stale re-seed does not regress
    const n2 = await seedProjectionRows(db, [
      {
        doseId: seedDose,
        patientId: PATIENT,
        scheduledAt: new Date("2026-02-01T08:00:00Z"),
        outcome: "missed",
        occurredAt: new Date("2026-02-01T07:00:00Z"),
      },
    ]);
    expect(n2).toBe(0);
    const row = await getProjection(db, seedDose);
    expect(row?.outcome).toBe("taken-on-time");
  });

  it("listByPatientId returns rows ordered by (scheduledAt, doseId)", async () => {
    const rows = await repo.listByPatientId(db, PATIENT);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const cmp =
        prev.scheduledAt.getTime() - cur.scheduledAt.getTime() ||
        (prev.doseId < cur.doseId ? -1 : 1);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });
});

describe("gamification_state read/write", () => {
  it("absent state → {0,'Harmony',null} without write", async () => {
    const dto = await getState(db, "55555555-5555-4555-8555-555555555555");
    expect(dto).toEqual({
      harmonyPoints: 0,
      themeState: "Harmony",
      updatedAt: null,
    });
    const row = await t.servicePg.query(
      "SELECT patient_id FROM gamification_state WHERE patient_id = $1",
      ["55555555-5555-4555-8555-555555555555"],
    );
    expect(row.rows.length).toBe(0);
  });

  it("upsertRecomputed persists and getState returns it", async () => {
    const now = new Date("2026-11-26T00:00:00Z");
    const result = recompute(
      [
        {
          doseId: DOSE,
          scheduledAt: new Date("2026-01-01T08:00:00Z"),
          outcome: "taken-on-time",
        },
      ],
      now,
    );
    await upsertRecomputed(db, PATIENT, result);
    const dto = await getState(db, PATIENT);
    expect(dto.harmonyPoints).toBe(10);
    expect(dto.themeState).toBe("Harmony");
    expect(dto.updatedAt).toBe(now.toISOString());
  });
});

describe("schema", () => {
  it("all six tables exist after migration", async () => {
    const res = await t.servicePg.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = res.rows.map((r) => r.tablename);
    for (const tbl of [
      "gamification_state",
      "dose_outcome_projection",
      "purge_tombstones",
      "bootstrap_state",
      "processed_event_markers",
      "consumer_offsets",
    ]) {
      expect(names).toContain(tbl);
    }
    expect(names).not.toContain("outbox");
  });
});
