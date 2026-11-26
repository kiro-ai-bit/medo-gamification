import type { Db } from "@infrastructure/Persistence/db.js";
import {
  createBootstrapStateRepo,
  createDoseOutcomeProjectionRepo,
} from "@infrastructure/Persistence/repositories.js";
import {
  applyOutcomeEvent,
  seedProjectionRows,
  type ProjectionFields,
  type ProjectionSeed,
} from "@core/OutcomeProjection/projection.js";
import type { OutcomeClass } from "@core/Scoring/scoring.js";
import type { Metrics } from "@core/metrics.js";
import type { ScheduleDoseClient } from "@infrastructure/ScheduleDoseClient/index.js";
import {
  PeerNotFoundError,
  PeerUnavailableError,
} from "@infrastructure/Clients/http.js";
import { DependencyError } from "@core/errors.js";
import { InvalidEventError } from "../Shared/errors.js";

const EPOCH_FROM = "1970-01-01T00:00:00.000Z"; // LD-GAM-04 — full history

const bootRepo = createBootstrapStateRepo();
const projRepo = createDoseOutcomeProjectionRepo();

export interface BootstrapDeps {
  db: Db;
  scheduleDose: ScheduleDoseClient;
  metrics?: Metrics;
  now: () => Date;
}

// Subset of the triggering event needed to seed/verify a projection row.
export interface OutcomeEventRef {
  medicineId: string;
  outcome: OutcomeClass;
  actorId?: string;
  occurredAt: Date;
}

export type CoverageVia =
  "existing" | "bootstrapped" | "gap-repulled" | "dose-detail";

function toDependency(err: unknown, label: string): Error {
  if (err instanceof PeerUnavailableError) {
    return new DependencyError(`${label}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// LD-GAM-04 — epoch→now single pull, no outcome param; Core filters
// outcome != 'unmarked'; occurredAt := markedAt ?? scheduledAt.
export async function pullOutcomeHistory(
  patientId: string,
  deps: BootstrapDeps,
): Promise<ProjectionSeed[]> {
  let doses;
  try {
    doses = await deps.scheduleDose.listPatientDoses(
      patientId,
      EPOCH_FROM,
      deps.now().toISOString(),
    );
  } catch (err) {
    throw toDependency(err, "schedule-dose listPatientDoses");
  }
  const seeds: ProjectionSeed[] = [];
  for (const d of doses) {
    if (d.outcome === "unmarked") continue;
    seeds.push({
      doseId: d.id,
      patientId: d.patientId,
      scheduledAt: new Date(d.scheduledAt),
      outcome: d.outcome as OutcomeClass,
      actorId: d.actorId ?? undefined,
      occurredAt: new Date(d.markedAt ?? d.scheduledAt),
      medicineId: d.medicineId,
    });
  }
  return seeds;
}

// Pull upstream, then seed + bookkeeping in one tx; metrics fire only after
// the tx commits and rows_seeded counts actually-applied rows.
async function pullAndSeed(
  patientId: string,
  deps: BootstrapDeps,
  mode: "first-sight" | "gap",
): Promise<void> {
  let seeds: ProjectionSeed[];
  try {
    seeds = await pullOutcomeHistory(patientId, deps);
  } catch (err) {
    deps.metrics?.incr("medo_gamification_bootstrap_total", {
      result: "error",
    });
    throw err;
  }
  const seeded = await deps.db.transaction(async (tx) => {
    const n = await seedProjectionRows(tx, seeds, deps.now());
    if (mode === "first-sight") {
      await bootRepo.upsertAfterBootstrap(
        tx,
        patientId,
        seeds.length,
        deps.now(),
      );
    } else {
      await bootRepo.openGapEpisode(tx, patientId, deps.now());
    }
    return n;
  });
  deps.metrics?.incr("medo_gamification_bootstrap_total", { result: "ok" });
  deps.metrics?.incr(
    "medo_gamification_projection_rows_seeded_total",
    {},
    seeded,
  );
}

// LD-GAM-06 — dose-detail fallback: verify patientId+medicineId consistency,
// map to ProjectionFields from the EVENT (scheduledAt comes from the detail).
// 404/mismatch → InvalidEventError (poison → DLQ); transport → DependencyError.
export async function resolveUnseenDose(
  doseId: string,
  expected: { patientId: string; medicineId: string },
  event: OutcomeEventRef,
  deps: BootstrapDeps,
): Promise<ProjectionFields> {
  let detail;
  try {
    detail = await deps.scheduleDose.getDose(doseId);
  } catch (err) {
    deps.metrics?.incr("medo_gamification_dose_detail_fallback_total", {
      result: "error",
    });
    if (err instanceof PeerNotFoundError) {
      throw new InvalidEventError(`dose ${doseId} not found upstream`);
    }
    throw toDependency(err, "schedule-dose getDose");
  }
  if (detail.patientId !== expected.patientId) {
    deps.metrics?.incr("medo_gamification_dose_detail_fallback_total", {
      result: "mismatch",
    });
    throw new InvalidEventError(
      `dose ${doseId} patientId mismatch: ${detail.patientId} != ${expected.patientId}`,
    );
  }
  if (detail.medicineId !== expected.medicineId) {
    deps.metrics?.incr("medo_gamification_dose_detail_fallback_total", {
      result: "mismatch",
    });
    throw new InvalidEventError(`dose ${doseId} medicineId mismatch`);
  }
  return {
    patientId: expected.patientId,
    scheduledAt: new Date(detail.scheduledAt),
    outcome: event.outcome,
    actorId: event.actorId,
    occurredAt: event.occurredAt,
    medicineId: expected.medicineId,
  };
}

// Pre-main-tx dose-detail insert — dedicated small tx, idempotent upsert
// (latest-wins). Failure → throw → event retries (FR-GAM-010).
async function insertFromDoseDetail(
  patientId: string,
  doseId: string,
  event: OutcomeEventRef,
  deps: BootstrapDeps,
): Promise<void> {
  const fields = await resolveUnseenDose(
    doseId,
    { patientId, medicineId: event.medicineId },
    event,
    deps,
  );
  await deps.db.transaction(async (tx) => {
    await applyOutcomeEvent(tx, doseId, fields);
  });
  deps.metrics?.incr("medo_gamification_dose_detail_fallback_total", {
    result: "ok",
  });
}

// LLD §8.2/§8.3 — first-sight bootstrap / once-per-episode gap re-bootstrap /
// dose-detail fallback. All upstream pulls complete BEFORE any local write;
// returns which coverage path resolved the doseId so the caller can run the
// gap-episode close rule (only a pre-existing projection row closes it).
export async function ensureProjectionCoverage(
  patientId: string,
  doseId: string,
  event: OutcomeEventRef,
  deps: BootstrapDeps,
): Promise<{ via: CoverageVia }> {
  const state = await bootRepo.get(deps.db, patientId);

  if (!state) {
    // FIRST SIGHT — pull first, then seed + bookkeeping in one tx so a failed
    // pull leaves zero footprint and the event retries the whole bootstrap.
    await pullAndSeed(patientId, deps, "first-sight");
    // Edge: triggering dose not yet visible upstream — dose-detail fallback.
    if (!(await projRepo.existsByDoseId(deps.db, doseId))) {
      await insertFromDoseDetail(patientId, doseId, event, deps);
      return { via: "dose-detail" };
    }
    return { via: "bootstrapped" };
  }

  if (await projRepo.existsByDoseId(deps.db, doseId)) {
    return { via: "existing" };
  }

  // GAP — once-per-episode: re-pull only when no episode is open.
  if (!state.gapEpisodeOpen) {
    await pullAndSeed(patientId, deps, "gap");
    if (await projRepo.existsByDoseId(deps.db, doseId)) {
      return { via: "gap-repulled" };
    }
  } else {
    deps.metrics?.incr("medo_gamification_bootstrap_total", {
      result: "skipped",
    });
  }

  await insertFromDoseDetail(patientId, doseId, event, deps);
  return { via: "dose-detail" };
}
