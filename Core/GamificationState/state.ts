import type { GamificationStateDto } from "@kiro-ai-bit/contracts";
import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import { createGamificationStateRepo } from "@infrastructure/Persistence/repositories.js";
import type { RecomputeResult } from "../Scoring/scoring.js";

const exec = (e: Db | DbTx) => e as unknown as Db;
const repo = createGamificationStateRepo();

// LLD §4.4 — absent row → synthesized defaults {0,'Harmony',null} WITHOUT
// write (LD-GAM-07); read never mutates.
export async function getState(
  e: Db | DbTx,
  patientId: string,
): Promise<GamificationStateDto> {
  const row = await repo.getByPatientId(exec(e), patientId);
  if (!row) {
    return { harmonyPoints: 0, themeState: "Harmony", updatedAt: null };
  }
  return {
    harmonyPoints: row.harmonyPoints,
    themeState: row.themeState as GamificationStateDto["themeState"],
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Single-row upsert — lazy-create on first persisted recompute (FR-GAM-008).
export async function upsertRecomputed(
  e: Db | DbTx,
  patientId: string,
  result: RecomputeResult,
): Promise<void> {
  await repo.upsert(exec(e), {
    patientId,
    harmonyPoints: result.harmonyPoints,
    themeState: result.themeState,
    updatedAt: result.updatedAt,
  });
}
