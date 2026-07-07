import { describe, expect, it } from "vitest";
import { maxCompPrice, scoreListability } from "../listability";
import type { ItemFullRow } from "@/types/database";

// Minimal item builder — only the fields scoreListability/maxCompPrice read.
function item(opts: Partial<{
  grade_value: number | null;
  comps: Array<{ price: unknown }> | null;
  target_price: number | null;
  list_price: number | null;
  purchase_price: number | null;
  created_at: string | null;
}>): ItemFullRow {
  return {
    grade_value: opts.grade_value ?? null,
    comps: opts.comps ?? null,
    target_price: opts.target_price ?? null,
    list_price: opts.list_price ?? null,
    purchase_price: opts.purchase_price ?? null,
    created_at: opts.created_at ?? null,
  } as unknown as ItemFullRow;
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("scoreListability", () => {
  it("a bare item scores 0 with no reasons and null margin", () => {
    const r = scoreListability(item({}));
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
    expect(r.margin).toBeNull();
  });

  it("awards readiness points for grade, comps and target price", () => {
    const r = scoreListability(item({
      grade_value: 8,
      comps: [{ price: 40 }],
      target_price: 50,
      purchase_price: 50, // margin 0 → 0 margin pts, no 'high margin'
      created_at: daysAgo(1),
    }));
    expect(r.reasons).toContain("graded");
    expect(r.reasons).toContain("has comps");
    expect(r.reasons).toContain("target priced");
    expect(r.reasons).not.toContain("high margin");
    // 25 + 20 + 15 = 60, plus 0 margin, plus 0 age pts (1 day)
    expect(r.score).toBe(60);
  });

  it("computes margin from list_price when no target_price, and flags high margin", () => {
    const r = scoreListability(item({ list_price: 100, purchase_price: 20 }));
    expect(r.reasons).not.toContain("target priced");
    expect(r.margin).toBeCloseTo(0.8, 5);
    expect(r.reasons).toContain("high margin"); // 0.8 >= 0.6
  });

  it("does not flag high margin just below the 0.6 threshold", () => {
    const r = scoreListability(item({ target_price: 100, purchase_price: 45 }));
    expect(r.margin).toBeCloseTo(0.55, 5);
    expect(r.reasons).not.toContain("high margin");
  });

  it("adds an age nudge and flags an aging backlog past 30 days", () => {
    const fresh = scoreListability(item({ created_at: daysAgo(3) }));
    expect(fresh.reasons).not.toContain("aging backlog");
    const old = scoreListability(item({ created_at: daysAgo(60) }));
    expect(old.reasons).toContain("aging backlog");
    expect(old.score).toBeGreaterThan(fresh.score);
  });

  it("ignores an unparseable created_at", () => {
    const r = scoreListability(item({ created_at: "not-a-date" }));
    expect(r.reasons).not.toContain("aging backlog");
    expect(r.score).toBe(0);
  });

  it("treats a non-positive price as no margin", () => {
    const r = scoreListability(item({ target_price: 0, purchase_price: 10 }));
    expect(r.margin).toBeNull();
  });

  it("caps the score at 100", () => {
    const r = scoreListability(item({
      grade_value: 9,
      comps: [{ price: 999 }],
      target_price: 1000,
      purchase_price: 0, // margin 1.0 → 25 pts
      created_at: daysAgo(400), // age capped at 15
    }));
    expect(r.score).toBe(100);
  });
});

describe("maxCompPrice", () => {
  it("returns 0 when there are no comps", () => {
    expect(maxCompPrice(item({}))).toBe(0);
    expect(maxCompPrice(item({ comps: [] }))).toBe(0);
  });

  it("returns the largest finite comp price and skips non-finite ones", () => {
    const it0 = item({ comps: [{ price: 10 }, { price: "oops" }, { price: 42 }, { price: 30 }] });
    expect(maxCompPrice(it0)).toBe(42);
  });
});
