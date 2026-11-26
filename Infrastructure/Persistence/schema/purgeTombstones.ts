import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

// LLD §5.3 — resurrection guard written inside the AccountDeleted purge tx.
export const purgeTombstones = pgTable("purge_tombstones", {
  patientId: uuid("patient_id").primaryKey(),
  purgedAt: timestamp("purged_at", { withTimezone: true }).notNull(),
});

export type PurgeTombstoneRow = typeof purgeTombstones.$inferSelect;
