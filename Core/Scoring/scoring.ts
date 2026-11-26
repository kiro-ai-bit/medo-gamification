// LLD §4.6 / §8.1 — ordered floor-0 replay + theme derive (pure functions).

export type OutcomeClass =
  "taken-on-time" | "taken-late" | "skipped" | "missed";

export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
  "taken-on-time",
  "taken-late",
  "skipped",
  "missed",
];

export type ThemeState = "Harmony" | "Uneasy" | "Horror";

// Map 1 t10 / FR-GAM-006 — verbatim delta table.
export const DELTA_BY_OUTCOME: Record<OutcomeClass, number> = {
  "taken-on-time": 10,
  "taken-late": -5,
  skipped: -10,
  missed: -20,
};

export function themeForOutcome(outcome: OutcomeClass): ThemeState {
  switch (outcome) {
    case "taken-on-time":
      return "Harmony";
    case "taken-late":
    case "skipped":
      return "Uneasy";
    case "missed":
      return "Horror";
  }
}

export interface ScoringRow {
  doseId: string;
  scheduledAt: Date;
  outcome: OutcomeClass;
}

export interface RecomputeResult {
  harmonyPoints: number;
  themeState: ThemeState;
  updatedAt: Date;
}

// Pure function: sort (scheduledAt ASC, doseId ASC) → replay deltas with
// running max(0,·) clamp → theme = f(latest scheduled outcome). Identical
// input rows → identical output (DG-GAM-1).
export function recompute(rows: ScoringRow[], now: Date): RecomputeResult {
  const sorted = [...rows].sort((a, b) => {
    const t = a.scheduledAt.getTime() - b.scheduledAt.getTime();
    if (t !== 0) return t;
    return a.doseId < b.doseId ? -1 : a.doseId > b.doseId ? 1 : 0;
  });
  let total = 0;
  let latest: OutcomeClass | null = null;
  for (const row of sorted) {
    total = Math.max(0, total + DELTA_BY_OUTCOME[row.outcome]);
    latest = row.outcome;
  }
  return {
    harmonyPoints: total,
    themeState: latest === null ? "Harmony" : themeForOutcome(latest),
    updatedAt: now,
  };
}
