// US-1897 (AC2): the drafts cockpit's quality-score helpers.
import { describe, expect, it } from "vitest";

import { qualityRankOf, scoreMapFromRows } from "@/pages/flipdesk/draft-quality";

describe("scoreMapFromRows", () => {
  it("maps scored listings", () => {
    expect(
      scoreMapFromRows([
        { id: "a", quality_score: 92, quality_blocked: false },
        { id: "b", quality_score: 40, quality_blocked: true },
      ]),
    ).toEqual({
      a: { score: 92, blocked: false },
      b: { score: 40, blocked: true },
    });
  });

  it("OMITS a never-scored listing rather than calling it zero", () => {
    // NULL and 0 are different facts. Coercing would render a confident chip
    // and sort an unscored draft in with the genuinely worst listings.
    const map = scoreMapFromRows([
      { id: "a", quality_score: null, quality_blocked: null },
      { id: "b", quality_score: 0, quality_blocked: true },
    ]);
    expect("a" in map).toBe(false);
    expect(map.b).toEqual({ score: 0, blocked: true });
  });

  it("treats a null quality_blocked as not blocked", () => {
    expect(scoreMapFromRows([{ id: "a", quality_score: 70, quality_blocked: null }]).a).toEqual({
      score: 70,
      blocked: false,
    });
  });

  it("survives the fail-soft empty result", () => {
    // The page returns [] when the column does not exist yet (migration 00476
    // is held), so this must not throw.
    expect(scoreMapFromRows([])).toEqual({});
    expect(scoreMapFromRows(null)).toEqual({});
    expect(scoreMapFromRows(undefined)).toEqual({});
  });
});

describe("qualityRankOf", () => {
  it("sinks unscored drafts to the END of a worst-first sort", () => {
    // "We don't know" is not evidence of low quality. Ranking unknowns first
    // would bury the listings we DO know are weak, defeating the sort.
    const scored = qualityRankOf({ score: 40, blocked: true });
    const unscored = qualityRankOf(undefined);
    expect(scored).toBeLessThan(unscored);
    expect(unscored).toBe(Number.POSITIVE_INFINITY);
  });

  it("orders scored drafts worst-first", () => {
    const rows = [
      { id: "good", s: { score: 95, blocked: false } },
      { id: "blocked", s: { score: 40, blocked: true } },
      { id: "weak", s: { score: 62, blocked: false } },
      { id: "unscored", s: undefined },
    ];
    const order = [...rows]
      .sort((a, b) => qualityRankOf(a.s) - qualityRankOf(b.s))
      .map((r) => r.id);
    expect(order).toEqual(["blocked", "weak", "good", "unscored"]);
  });
});
