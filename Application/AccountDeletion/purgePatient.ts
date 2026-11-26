import type { Db } from "@infrastructure/Persistence/db.js";
import {
  createBootstrapStateRepo,
  createDoseOutcomeProjectionRepo,
  createGamificationStateRepo,
  createProcessedEventMarkerRepo,
  createPurgeTombstoneRepo,
} from "@infrastructure/Persistence/repositories.js";
import type { CheckLinkCache } from "@infrastructure/CareClient/checkLink.js";

const stateRepo = createGamificationStateRepo();
const projRepo = createDoseOutcomeProjectionRepo();
const markerRepo = createProcessedEventMarkerRepo();
const bootRepo = createBootstrapStateRepo();
const tombRepo = createPurgeTombstoneRepo();

export interface DeletionDeps {
  db: Db;
  checkLinkCache: CheckLinkCache;
  now: () => Date;
}

// LLD §8.7 — single tx purge + unconditional tombstone (LD-GAM-10): caregiver
// userIds delete nothing on score tables but still write tombstone+marker.
// Post-commit: positive-only check-link cache entries for userId purged.
// Idempotent — redelivery is marker-deduped upstream; tombstone upsert safe.
export async function purgePatient(
  event: { eventId: string; userId: string; occurredAt: Date },
  deps: DeletionDeps,
): Promise<void> {
  const now = deps.now();
  await deps.db.transaction(async (tx) => {
    await stateRepo.deleteByPatientId(tx, event.userId);
    await projRepo.deleteByPatientId(tx, event.userId);
    await markerRepo.deleteByPatientId(tx, event.userId);
    await bootRepo.deleteByPatientId(tx, event.userId);
    await tombRepo.upsert(tx, event.userId, event.occurredAt);
    await markerRepo.insert(tx, {
      eventId: event.eventId,
      action: "account-deleted-purged",
      patientId: event.userId,
      processedAt: now,
    });
  });
  deps.checkLinkCache.invalidateForUser(event.userId);
}
