import type { ConsumerDeps } from "./deps.js";
import { purgePatient } from "@application/AccountDeletion/purgePatient.js";
import { createProcessedEventMarkerRepo } from "@infrastructure/Persistence/repositories.js";

const markerRepo = createProcessedEventMarkerRepo();
export const ACCOUNT_DELETED_ACTION = "account-deleted-purged";

export interface AccountDeletedPayload {
  eventId: string;
  occurredAt: string;
  userId: string;
}

// LLD §8.7 — dedup → purgePatient (single tx + tombstone) → cache invalidate.
export async function handleAccountDeleted(
  deps: ConsumerDeps,
  ev: AccountDeletedPayload,
): Promise<void> {
  if (await markerRepo.has(deps.db, ev.eventId, ACCOUNT_DELETED_ACTION)) {
    deps.metrics?.incr("medo_gamification_dedup_hits_total");
    return;
  }
  await purgePatient(
    {
      eventId: ev.eventId,
      userId: ev.userId,
      occurredAt: new Date(ev.occurredAt),
    },
    {
      db: deps.db,
      checkLinkCache: deps.checkLinkCache,
      now: deps.now,
    },
  );
}
