import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// LLD §5.5 — per-(eventId, action) dedup markers; patient_id enables
// AccountDeleted-scoped purge; processed_at drives bounded 30d retention.
export const processedEventMarkers = pgTable(
  "processed_event_markers",
  {
    eventId: uuid("event_id").notNull(),
    action: text("action").notNull(),
    patientId: uuid("patient_id"),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.action] }),
    index("idx_markers_processed_at").on(t.processedAt),
    index("idx_markers_patient").on(t.patientId),
  ],
);

export type ProcessedEventMarkerRow = typeof processedEventMarkers.$inferSelect;
export type NewProcessedEventMarkerRow =
  typeof processedEventMarkers.$inferInsert;
