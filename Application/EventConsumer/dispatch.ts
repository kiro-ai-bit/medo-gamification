import {
  EVENT_SCHEMAS,
  type BrokerEvent,
  type EventType,
} from "@kiro-ai-bit/eventing";
import { createProcessedEventMarkerRepo } from "@infrastructure/Persistence/repositories.js";
import {
  handleAccountDeleted,
  type AccountDeletedPayload,
} from "./handleAccountDeleted.js";
import {
  handleDoseOutcomeChanged,
  type DoseOutcomeChangedPayload,
} from "./handleDoseOutcomeChanged.js";
import type { ConsumerDeps } from "./deps.js";
export { InvalidEventError, SchemaValidationError } from "../Shared/errors.js";
export type { ConsumerDeps } from "./deps.js";

const TYPE_LABEL: Record<string, string> = {
  DoseOutcomeChanged: "dose-outcome",
  AccountDeleted: "account-deleted",
};

function metricType(eventType: string): string {
  return TYPE_LABEL[eventType] ?? eventType;
}

// LLD §4.8/§7.2 — zod re-parse at dispatch boundary; unknown → skip.
// Offset advances only after dispatchEvent resolves (consumer worker).
export async function dispatchEvent(
  deps: ConsumerDeps,
  event: BrokerEvent,
): Promise<void> {
  const label = metricType(event.type);
  try {
    const type = event.type as EventType;
    const schema = EVENT_SCHEMAS[type];
    if (!schema) {
      deps.metrics?.incr("medo_gamification_events_consumed_total", {
        type: label,
        result: "skipped",
      });
      return;
    }
    const parsed = schema.parse(event);
    switch (type) {
      case "DoseOutcomeChanged":
        await handleDoseOutcomeChanged(
          deps,
          parsed as unknown as DoseOutcomeChangedPayload,
        );
        break;
      case "AccountDeleted":
        await handleAccountDeleted(
          deps,
          parsed as unknown as AccountDeletedPayload,
        );
        break;
      default:
        deps.metrics?.incr("medo_gamification_events_consumed_total", {
          type: label,
          result: "skipped",
        });
        return;
    }
    deps.metrics?.incr("medo_gamification_events_consumed_total", {
      type: label,
      result: "ok",
    });
  } catch (err) {
    deps.metrics?.incr("medo_gamification_events_consumed_total", {
      type: label,
      result: "failed",
    });
    throw err;
  }
}

// LD-GAM-09 — bounded inline marker retention (30d, job-free): each consumed
// event runs one bounded DELETE. Prune failure must never fail the event —
// the reaction already committed; offset advance depends on dispatch resolving.
const MARKER_RETENTION_MS = 30 * 24 * 3600 * 1000;
const MARKER_PRUNE_BATCH = 500;

export function createConsumerDispatch(deps: ConsumerDeps) {
  const markerRepo = createProcessedEventMarkerRepo();
  return async (event: BrokerEvent): Promise<void> => {
    try {
      await dispatchEvent(deps, event);
    } finally {
      try {
        await markerRepo.deleteOlderThan(
          deps.db,
          new Date(deps.now().getTime() - MARKER_RETENTION_MS),
          MARKER_PRUNE_BATCH,
        );
      } catch {
        // maintenance-only — never block consumption
      }
    }
  };
}
