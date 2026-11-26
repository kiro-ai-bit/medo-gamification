import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// LLD §5.1 — one row per Patient; lazy-created on first persisted recompute.
export const gamificationState = pgTable(
  "gamification_state",
  {
    patientId: uuid("patient_id").primaryKey(),
    harmonyPoints: integer("harmony_points").notNull(),
    themeState: text("theme_state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("gamification_state_points_chk", sql`${t.harmonyPoints} >= 0`),
    check(
      "gamification_state_theme_chk",
      sql`${t.themeState} IN ('Harmony','Uneasy','Horror')`,
    ),
  ],
);

export type GamificationStateRow = typeof gamificationState.$inferSelect;
export type NewGamificationStateRow = typeof gamificationState.$inferInsert;
