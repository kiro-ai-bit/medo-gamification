import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  bootstrapState,
  doseOutcomeProjection,
  gamificationState,
  processedEventMarkers,
  purgeTombstones,
} from "./schema/index.js";
import type {
  BootstrapStateRow,
  DoseOutcomeProjectionRow,
  GamificationStateRow,
  NewDoseOutcomeProjectionRow,
  NewGamificationStateRow,
  NewProcessedEventMarkerRow,
} from "./schema/index.js";
import type { Db, DbTx } from "./db.js";

// Repos bind to any drizzle executor — pass the tx object (cast as Db) for
// in-transaction work; PGlite is single-connection so mixing db+tx deadlocks.
const exec = (e: Db | DbTx) => e as unknown as Db;

export function createGamificationStateRepo() {
  return {
    async getByPatientId(
      e: Db | DbTx,
      patientId: string,
    ): Promise<GamificationStateRow | null> {
      const rows = await exec(e)
        .select()
        .from(gamificationState)
        .where(eq(gamificationState.patientId, patientId))
        .limit(1);
      return rows[0] ?? null;
    },
    async upsert(
      e: Db | DbTx,
      row: NewGamificationStateRow,
    ): Promise<GamificationStateRow> {
      const rows = await exec(e)
        .insert(gamificationState)
        .values(row)
        .onConflictDoUpdate({
          target: gamificationState.patientId,
          set: {
            harmonyPoints: row.harmonyPoints,
            themeState: row.themeState,
            updatedAt: row.updatedAt,
          },
        })
        .returning();
      return rows[0];
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<void> {
      await exec(e)
        .delete(gamificationState)
        .where(eq(gamificationState.patientId, patientId));
    },
  };
}
export type GamificationStateRepo = ReturnType<
  typeof createGamificationStateRepo
>;

export type UpsertLatestWinsResult = "applied" | "stale" | "inserted";

// LD-GAM-03: latest-occurredAt-wins; equal occurredAt → sequential
// last-wins (<= guard). scheduled_at/patient_id immutable — never in SET.
// Two single statements, PK-serialized: INSERT-or-ignore then guarded
// UPDATE — no SELECT-then-write race.
async function upsertLatestWinsRow(
  e: Db | DbTx,
  row: NewDoseOutcomeProjectionRow,
  now: Date,
): Promise<UpsertLatestWinsResult> {
  const inserted = await exec(e)
    .insert(doseOutcomeProjection)
    .values(row)
    .onConflictDoNothing({ target: doseOutcomeProjection.doseId })
    .returning({ doseId: doseOutcomeProjection.doseId });
  if (inserted.length > 0) return "inserted";
  const applied = await exec(e)
    .update(doseOutcomeProjection)
    .set({
      outcome: row.outcome,
      actorId: row.actorId ?? null,
      occurredAt: row.occurredAt,
      medicineId: row.medicineId ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(doseOutcomeProjection.doseId, row.doseId),
        // patientId consistency (LLD §4.5): a doseId belongs to exactly one
        // patient — mismatched patientId never overwrites (returns 'stale').
        eq(doseOutcomeProjection.patientId, row.patientId),
        lte(doseOutcomeProjection.occurredAt, row.occurredAt),
      ),
    )
    .returning({ doseId: doseOutcomeProjection.doseId });
  return applied.length > 0 ? "applied" : "stale";
}

export function createDoseOutcomeProjectionRepo() {
  return {
    async getByDoseId(
      e: Db | DbTx,
      doseId: string,
    ): Promise<DoseOutcomeProjectionRow | null> {
      const rows = await exec(e)
        .select()
        .from(doseOutcomeProjection)
        .where(eq(doseOutcomeProjection.doseId, doseId))
        .limit(1);
      return rows[0] ?? null;
    },
    async listByPatientId(
      e: Db | DbTx,
      patientId: string,
    ): Promise<DoseOutcomeProjectionRow[]> {
      return exec(e)
        .select()
        .from(doseOutcomeProjection)
        .where(eq(doseOutcomeProjection.patientId, patientId))
        .orderBy(
          asc(doseOutcomeProjection.scheduledAt),
          asc(doseOutcomeProjection.doseId),
        );
    },
    async upsertLatestWins(
      e: Db | DbTx,
      row: NewDoseOutcomeProjectionRow,
      now: Date = new Date(),
    ): Promise<UpsertLatestWinsResult> {
      return upsertLatestWinsRow(e, row, now);
    },
    async seedBatch(
      e: Db | DbTx,
      rows: NewDoseOutcomeProjectionRow[],
      now: Date = new Date(),
    ): Promise<number> {
      let n = 0;
      for (const row of rows) {
        const r = await upsertLatestWinsRow(e, row, now);
        if (r !== "stale") n += 1;
      }
      return n;
    },
    async existsByDoseId(e: Db | DbTx, doseId: string): Promise<boolean> {
      const rows = await exec(e)
        .select({ doseId: doseOutcomeProjection.doseId })
        .from(doseOutcomeProjection)
        .where(eq(doseOutcomeProjection.doseId, doseId))
        .limit(1);
      return rows.length > 0;
    },
    async existsForPatient(e: Db | DbTx, patientId: string): Promise<boolean> {
      const rows = await exec(e)
        .select({ doseId: doseOutcomeProjection.doseId })
        .from(doseOutcomeProjection)
        .where(eq(doseOutcomeProjection.patientId, patientId))
        .limit(1);
      return rows.length > 0;
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<number> {
      const rows = await exec(e)
        .delete(doseOutcomeProjection)
        .where(eq(doseOutcomeProjection.patientId, patientId))
        .returning({ doseId: doseOutcomeProjection.doseId });
      return rows.length;
    },
  };
}
export type DoseOutcomeProjectionRepo = ReturnType<
  typeof createDoseOutcomeProjectionRepo
>;

export function createPurgeTombstoneRepo() {
  return {
    async exists(e: Db | DbTx, patientId: string): Promise<boolean> {
      const rows = await exec(e)
        .select({ patientId: purgeTombstones.patientId })
        .from(purgeTombstones)
        .where(eq(purgeTombstones.patientId, patientId))
        .limit(1);
      return rows.length > 0;
    },
    async upsert(
      e: Db | DbTx,
      patientId: string,
      purgedAt: Date,
    ): Promise<void> {
      await exec(e)
        .insert(purgeTombstones)
        .values({ patientId, purgedAt })
        .onConflictDoUpdate({
          target: purgeTombstones.patientId,
          set: { purgedAt },
        });
    },
  };
}
export type PurgeTombstoneRepo = ReturnType<typeof createPurgeTombstoneRepo>;

export function createBootstrapStateRepo() {
  return {
    async get(
      e: Db | DbTx,
      patientId: string,
    ): Promise<BootstrapStateRow | null> {
      const rows = await exec(e)
        .select()
        .from(bootstrapState)
        .where(eq(bootstrapState.patientId, patientId))
        .limit(1);
      return rows[0] ?? null;
    },
    async upsertAfterBootstrap(
      e: Db | DbTx,
      patientId: string,
      seedCount: number,
      now: Date,
    ): Promise<void> {
      await exec(e)
        .insert(bootstrapState)
        .values({
          patientId,
          firstBootstrapAt: now,
          lastBootstrapAt: now,
          bootstrapCount: 1,
          gapEpisodeOpen: false,
          gapRebootstrapUsed: false,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: bootstrapState.patientId,
          set: {
            lastBootstrapAt: now,
            bootstrapCount: sql`${bootstrapState.bootstrapCount} + 1`,
            gapEpisodeOpen: false,
            gapRebootstrapUsed: false,
            updatedAt: now,
          },
        });
      void seedCount;
    },
    async openGapEpisode(
      e: Db | DbTx,
      patientId: string,
      now: Date,
    ): Promise<void> {
      await exec(e)
        .update(bootstrapState)
        .set({
          gapEpisodeOpen: true,
          gapRebootstrapUsed: true,
          lastBootstrapAt: now,
          // §5.4 — bootstrap_count grows only on gap episodes (initial = 1).
          bootstrapCount: sql`${bootstrapState.bootstrapCount} + 1`,
          updatedAt: now,
        })
        .where(eq(bootstrapState.patientId, patientId));
    },
    async closeGapEpisode(
      e: Db | DbTx,
      patientId: string,
      now: Date,
    ): Promise<void> {
      await exec(e)
        .update(bootstrapState)
        .set({
          gapEpisodeOpen: false,
          gapRebootstrapUsed: false,
          updatedAt: now,
        })
        .where(eq(bootstrapState.patientId, patientId));
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<void> {
      await exec(e)
        .delete(bootstrapState)
        .where(eq(bootstrapState.patientId, patientId));
    },
  };
}
export type BootstrapStateRepo = ReturnType<typeof createBootstrapStateRepo>;

export function createProcessedEventMarkerRepo() {
  return {
    async has(e: Db | DbTx, eventId: string, action: string): Promise<boolean> {
      const rows = await exec(e)
        .select({ eventId: processedEventMarkers.eventId })
        .from(processedEventMarkers)
        .where(
          and(
            eq(processedEventMarkers.eventId, eventId),
            eq(processedEventMarkers.action, action),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async insert(e: Db | DbTx, row: NewProcessedEventMarkerRow): Promise<void> {
      await exec(e)
        .insert(processedEventMarkers)
        .values(row)
        .onConflictDoNothing();
    },
    // LD-GAM-09 — bounded retention: delete at most `limit` rows older than
    // cutoff per call (inline prune, zero jobs).
    async deleteOlderThan(
      e: Db | DbTx,
      cutoff: Date,
      limit: number,
    ): Promise<number> {
      const rows = await exec(e).execute(sql`
        DELETE FROM processed_event_markers
        WHERE ctid IN (
          SELECT ctid FROM processed_event_markers
          WHERE processed_at < ${cutoff.toISOString()}::timestamptz
          LIMIT ${limit}
        )
        RETURNING event_id`);
      return rows.rows.length;
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<number> {
      const rows = await exec(e)
        .delete(processedEventMarkers)
        .where(eq(processedEventMarkers.patientId, patientId))
        .returning({ eventId: processedEventMarkers.eventId });
      return rows.length;
    },
  };
}
export type ProcessedEventMarkerRepo = ReturnType<
  typeof createProcessedEventMarkerRepo
>;
