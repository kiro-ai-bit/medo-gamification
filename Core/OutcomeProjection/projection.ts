import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import {
  createDoseOutcomeProjectionRepo,
  type UpsertLatestWinsResult,
} from "@infrastructure/Persistence/repositories.js";
import type { DoseOutcomeProjectionRow } from "@infrastructure/Persistence/schema/index.js";
import type { OutcomeClass } from "../Scoring/scoring.js";

const exec = (e: Db | DbTx) => e as unknown as Db;
const repo = createDoseOutcomeProjectionRepo();

export interface ProjectionFields {
  patientId: string;
  scheduledAt: Date;
  outcome: OutcomeClass;
  actorId?: string;
  occurredAt: Date;
  medicineId?: string;
}

export type { DoseOutcomeProjectionRow };

// LLD §4.5 — upsert keyed doseId; applies only when
// incoming.occurredAt >= stored.occurredAt (equal → sequential last-wins).
// actorId stored for audit, never scored. scheduled_at/patient_id immutable
// on update (enforced in repo — update set excludes them).
export async function applyOutcomeEvent(
  e: Db | DbTx,
  doseId: string,
  fields: ProjectionFields,
): Promise<UpsertLatestWinsResult> {
  return repo.upsertLatestWins(exec(e), {
    doseId,
    patientId: fields.patientId,
    scheduledAt: fields.scheduledAt,
    outcome: fields.outcome,
    actorId: fields.actorId ?? null,
    occurredAt: fields.occurredAt,
    medicineId: fields.medicineId ?? null,
  });
}

export async function getProjection(
  e: Db | DbTx,
  doseId: string,
): Promise<DoseOutcomeProjectionRow | null> {
  return repo.getByDoseId(exec(e), doseId);
}

export async function listProjectionForPatient(
  e: Db | DbTx,
  patientId: string,
): Promise<DoseOutcomeProjectionRow[]> {
  return repo.listByPatientId(exec(e), patientId);
}

export async function patientHasProjection(
  e: Db | DbTx,
  patientId: string,
): Promise<boolean> {
  return repo.existsForPatient(exec(e), patientId);
}

export interface ProjectionSeed {
  doseId: string;
  patientId: string;
  scheduledAt: Date;
  outcome: OutcomeClass;
  actorId?: string;
  occurredAt: Date;
  medicineId?: string;
}

// LLD §4.5 — bulk upsert of bootstrap-seeded rows (same latest-wins guard).
export async function seedProjectionRows(
  e: Db | DbTx,
  seeds: ProjectionSeed[],
  now: Date = new Date(),
): Promise<number> {
  return repo.seedBatch(
    exec(e),
    seeds.map((s) => ({
      doseId: s.doseId,
      patientId: s.patientId,
      scheduledAt: s.scheduledAt,
      outcome: s.outcome,
      actorId: s.actorId ?? null,
      occurredAt: s.occurredAt,
      medicineId: s.medicineId ?? null,
    })),
    now,
  );
}
