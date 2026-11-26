import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// LLD §5.2 — per-doseId scoring projection; latest-occurredAt-wins upsert.
export const doseOutcomeProjection = pgTable(
  "dose_outcome_projection",
  {
    doseId: uuid("dose_id").primaryKey(),
    patientId: uuid("patient_id").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    actorId: uuid("actor_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    medicineId: uuid("medicine_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "dose_outcome_projection_outcome_chk",
      sql`${t.outcome} IN ('taken-on-time','taken-late','skipped','missed')`,
    ),
    index("idx_projection_patient_sched").on(
      t.patientId,
      t.scheduledAt,
      t.doseId,
    ),
    index("idx_projection_patient").on(t.patientId),
  ],
);

export type DoseOutcomeProjectionRow =
  typeof doseOutcomeProjection.$inferSelect;
export type NewDoseOutcomeProjectionRow =
  typeof doseOutcomeProjection.$inferInsert;
