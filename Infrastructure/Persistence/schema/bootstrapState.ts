import {
  boolean,
  check,
  integer,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// LLD §5.4 — per-patient bootstrap bookkeeping (first-sight/gap episodes).
export const bootstrapState = pgTable(
  "bootstrap_state",
  {
    patientId: uuid("patient_id").primaryKey(),
    firstBootstrapAt: timestamp("first_bootstrap_at", {
      withTimezone: true,
    }).notNull(),
    lastBootstrapAt: timestamp("last_bootstrap_at", {
      withTimezone: true,
    }).notNull(),
    bootstrapCount: integer("bootstrap_count").notNull().default(1),
    gapEpisodeOpen: boolean("gap_episode_open").notNull().default(false),
    gapRebootstrapUsed: boolean("gap_rebootstrap_used")
      .notNull()
      .default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("bootstrap_state_count_chk", sql`${t.bootstrapCount} >= 1`)],
);

export type BootstrapStateRow = typeof bootstrapState.$inferSelect;
export type NewBootstrapStateRow = typeof bootstrapState.$inferInsert;
