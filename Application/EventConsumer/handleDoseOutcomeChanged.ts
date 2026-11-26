import {
  createBootstrapStateRepo,
  createDoseOutcomeProjectionRepo,
  createProcessedEventMarkerRepo,
  createPurgeTombstoneRepo,
} from "@infrastructure/Persistence/repositories.js";
import {
  applyOutcomeEvent,
  listProjectionForPatient,
} from "@core/OutcomeProjection/projection.js";
import { upsertRecomputed } from "@core/GamificationState/state.js";
import { OUTCOME_CLASSES, recompute } from "@core/Scoring/scoring.js";
import type { ConsumerDeps } from "./deps.js";
import { ensureProjectionCoverage } from "@application/Bootstrap/bootstrap.js";
import { SchemaValidationError } from "../Shared/errors.js";

const markerRepo = createProcessedEventMarkerRepo();
const projRepo = createDoseOutcomeProjectionRepo();
const bootRepo = createBootstrapStateRepo();
const tombRepo = createPurgeTombstoneRepo();

export const DOSE_OUTCOME_ACTION = "dose-outcome-applied";

export interface DoseOutcomeChangedPayload {
  eventId: string;
  occurredAt: string;
  doseId: string;
  medicineId: string;
  patientId: string;
  outcome: (typeof OUTCOME_CLASSES)[number];
  actorId?: string;
}

// LLD §8.4 — dedup → tombstone → enum gate → coverage → main tx
// (projection upsert + recompute + state + marker + episode close) atomic.
export async function handleDoseOutcomeChanged(
  deps: ConsumerDeps,
  ev: DoseOutcomeChangedPayload,
): Promise<void> {
  const now = deps.now();
  const occurredAt = new Date(ev.occurredAt);

  if (await markerRepo.has(deps.db, ev.eventId, DOSE_OUTCOME_ACTION)) {
    deps.metrics?.incr("medo_gamification_dedup_hits_total");
    return;
  }

  // Tombstone guard — post-purge resurrection block (HD-GAM-06). Marker is
  // written so redelivery stays a cheap no-op; counted, NOT failed.
  if (await tombRepo.exists(deps.db, ev.patientId)) {
    await deps.db.transaction(async (tx) => {
      await markerRepo.insert(tx, {
        eventId: ev.eventId,
        action: DOSE_OUTCOME_ACTION,
        patientId: ev.patientId,
        processedAt: now,
      });
    });
    deps.metrics?.incr("medo_gamification_tombstone_blocks_total");
    return;
  }

  // Closed 4-class enum gate (FR-GAM-004) — defensive; dispatch zod enforces.
  if (!OUTCOME_CLASSES.includes(ev.outcome)) {
    throw new SchemaValidationError(`unknown outcome class: ${ev.outcome}`);
  }

  const coverage = await ensureProjectionCoverage(
    ev.patientId,
    ev.doseId,
    {
      medicineId: ev.medicineId,
      outcome: ev.outcome,
      actorId: ev.actorId,
      occurredAt,
    },
    {
      db: deps.db,
      scheduleDose: deps.scheduleDose,
      metrics: deps.metrics,
      now: deps.now,
    },
  );

  await deps.db.transaction(async (tx) => {
    // Coverage guarantees the row exists — scheduled_at is immutable and
    // resolved upstream (seed/detail/existing row, §8.4).
    const existing = await projRepo.getByDoseId(tx, ev.doseId);
    if (!existing) {
      throw new SchemaValidationError(
        `projection row missing after coverage for dose ${ev.doseId}`,
      );
    }
    await applyOutcomeEvent(tx, ev.doseId, {
      patientId: ev.patientId,
      scheduledAt: existing.scheduledAt,
      outcome: ev.outcome,
      actorId: ev.actorId,
      occurredAt,
      medicineId: ev.medicineId,
    });
    const rows = await listProjectionForPatient(tx, ev.patientId);
    const t0 = Date.now();
    const result = recompute(
      rows.map((r) => ({
        doseId: r.doseId,
        scheduledAt: r.scheduledAt,
        outcome: r.outcome as (typeof OUTCOME_CLASSES)[number],
      })),
      now,
    );
    deps.metrics?.incr("medo_gamification_recompute_total");
    deps.metrics?.observe?.(
      "medo_gamification_recompute_duration_ms",
      {},
      Date.now() - t0,
    );
    await upsertRecomputed(tx, ev.patientId, result);
    await markerRepo.insert(tx, {
      eventId: ev.eventId,
      action: DOSE_OUTCOME_ACTION,
      patientId: ev.patientId,
      processedAt: now,
    });
    // Gap-episode close: only a doseId already present in the projection at
    // coverage time closes the episode (LLD §8.3 transition table — gap-
    // resolved events leave the episode open for the once-per-episode guard).
    if (coverage.via === "existing") {
      const bs = await bootRepo.get(tx, ev.patientId);
      if (bs?.gapEpisodeOpen) {
        await bootRepo.closeGapEpisode(tx, ev.patientId, now);
      }
    }
  });
}
