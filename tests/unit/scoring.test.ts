import { describe, expect, it } from "vitest";
import {
  DELTA_BY_OUTCOME,
  recompute,
  themeForOutcome,
  type OutcomeClass,
  type ScoringRow,
} from "@core/Scoring/scoring.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");

function row(
  doseId: string,
  scheduledAt: string,
  outcome: OutcomeClass,
): ScoringRow {
  return { doseId, scheduledAt: new Date(scheduledAt), outcome };
}

describe("DELTA_BY_OUTCOME", () => {
  it("matches the Map 1 t10 delta table", () => {
    expect(DELTA_BY_OUTCOME).toEqual({
      "taken-on-time": 10,
      "taken-late": -5,
      skipped: -10,
      missed: -20,
    });
  });
});

describe("themeForOutcome", () => {
  it("maps each outcome class to its theme", () => {
    expect(themeForOutcome("taken-on-time")).toBe("Harmony");
    expect(themeForOutcome("taken-late")).toBe("Uneasy");
    expect(themeForOutcome("skipped")).toBe("Uneasy");
    expect(themeForOutcome("missed")).toBe("Horror");
  });
});

describe("recompute", () => {
  it("returns defaults for zero rows", () => {
    const r = recompute([], NOW);
    expect(r).toEqual({
      harmonyPoints: 0,
      themeState: "Harmony",
      updatedAt: NOW,
    });
  });

  it("replays deltas in scheduled order", () => {
    const r = recompute(
      [
        row("d1", "2026-01-01T08:00:00Z", "taken-on-time"),
        row("d2", "2026-01-01T20:00:00Z", "taken-on-time"),
        row("d3", "2026-01-02T08:00:00Z", "taken-late"),
      ],
      NOW,
    );
    // 10 + 10 - 5 = 15
    expect(r.harmonyPoints).toBe(15);
    expect(r.themeState).toBe("Uneasy");
  });

  it("clamps at floor zero — running max(0,·), non-invertible", () => {
    // +10 then -20 then +10 → 0, then 10 (not -10+10=0 ordering artifact)
    const r = recompute(
      [
        row("d1", "2026-01-01T08:00:00Z", "taken-on-time"),
        row("d2", "2026-01-01T20:00:00Z", "missed"),
        row("d3", "2026-01-02T08:00:00Z", "taken-on-time"),
      ],
      NOW,
    );
    expect(r.harmonyPoints).toBe(10);
    expect(r.themeState).toBe("Harmony");
  });

  it("all-missed history stays at zero and Horror", () => {
    const r = recompute(
      [
        row("d1", "2026-01-01T08:00:00Z", "missed"),
        row("d2", "2026-01-02T08:00:00Z", "missed"),
      ],
      NOW,
    );
    expect(r.harmonyPoints).toBe(0);
    expect(r.themeState).toBe("Horror");
  });

  it("is deterministic — input order does not matter", () => {
    const rows = [
      row("d3", "2026-01-03T08:00:00Z", "skipped"),
      row("d1", "2026-01-01T08:00:00Z", "taken-on-time"),
      row("d2", "2026-01-02T08:00:00Z", "taken-late"),
    ];
    const a = recompute(rows, NOW);
    const b = recompute([...rows].reverse(), NOW);
    expect(a).toEqual(b);
    // 10 - 5 - 10 → clamp: 10,5,0 → 0; theme = latest scheduled = skipped → Uneasy
    expect(a.harmonyPoints).toBe(0);
    expect(a.themeState).toBe("Uneasy");
  });

  it("breaks scheduledAt ties by doseId ASC", () => {
    const same = "2026-01-01T08:00:00Z";
    // doseId "a" sorts before "b" — b's outcome is "latest" for theme
    const r = recompute(
      [row("b-id", same, "missed"), row("a-id", same, "taken-on-time")],
      NOW,
    );
    // order: a-id (+10) then b-id (-20 → clamp 0); theme from b-id = Horror
    expect(r.harmonyPoints).toBe(0);
    expect(r.themeState).toBe("Horror");
  });

  it("theme follows the latest scheduled outcome, not the score", () => {
    const r = recompute(
      [
        row("d1", "2026-01-01T08:00:00Z", "missed"),
        row("d2", "2026-01-02T08:00:00Z", "taken-on-time"),
      ],
      NOW,
    );
    // max(0,-20)=0 then max(0,0+10)=10 — floor-0 clamp makes -20 non-invertible
    expect(r.harmonyPoints).toBe(10);
    expect(r.themeState).toBe("Harmony");
  });
});
