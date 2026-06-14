import { describe, it, expect } from "vitest";
import {
  resolveCounters,
  type PublicStats,
} from "@/components/marketing/stat-counters-logic";

// US-865: the resolver is the honesty gate — it decides which counters are worth
// showing and degrades gracefully when a metric is too small or unavailable.

const base: PublicStats = {
  generated_at: "2026-06-13T00:00:00.000Z",
  items_graded: 0,
  verified_sellers: 0,
  graded_sales: 0,
  agreement_rate: null,
};

describe("resolveCounters", () => {
  it("returns nothing when there is no data", () => {
    expect(resolveCounters(undefined)).toEqual([]);
    expect(resolveCounters(null)).toEqual([]);
  });

  it("renders nothing when every metric is empty / below threshold", () => {
    expect(resolveCounters(base)).toEqual([]);
    // Small non-zero counts below their bands are still dropped.
    expect(
      resolveCounters({ ...base, items_graded: 50, verified_sellers: 3, graded_sales: 40 }),
    ).toEqual([]);
  });

  it("shows exact, localized counts once a metric clears its threshold", () => {
    const out = resolveCounters({
      ...base,
      items_graded: 30000,
      verified_sellers: 42,
      graded_sales: 2500,
    });
    const byKey = Object.fromEntries(out.map((c) => [c.key, c.display]));
    expect(byKey.items_graded).toBe("30,000");
    expect(byKey.verified_sellers).toBe("42");
    expect(byKey.graded_sales).toBe("2,500");
  });

  it("degrades to qualitative copy for mid-size counts on qualitative metrics", () => {
    const out = resolveCounters({ ...base, items_graded: 4000, graded_sales: 300 });
    const items = out.find((c) => c.key === "items_graded");
    const sales = out.find((c) => c.key === "graded_sales");
    // 4k items is below the 25k exact floor → "Thousands of items graded".
    expect(items).toMatchObject({ display: "Thousands", label: "of items graded" });
    // 300 sales is in the hundreds band.
    expect(sales).toMatchObject({ display: "Hundreds", label: "of graded sales tracked" });
  });

  it("never fabricates qualitative copy for a small-cohort metric", () => {
    // verified_sellers is non-qualitative: below its threshold it just hides,
    // never "Hundreds of verified sellers".
    expect(resolveCounters({ ...base, verified_sellers: 7 })).toEqual([]);
  });

  it("formats agreement as a whole-number percent, and omits it when null", () => {
    const withRate = resolveCounters({ ...base, agreement_rate: 0.923 });
    expect(withRate).toEqual([
      { key: "agreement", display: "92%", label: "AI-vs-expert agreement" },
    ]);
    expect(resolveCounters({ ...base, agreement_rate: null })).toEqual([]);
  });

  it("orders counters items → sellers → agreement → sales", () => {
    const out = resolveCounters({
      generated_at: base.generated_at,
      items_graded: 30000,
      verified_sellers: 30,
      graded_sales: 2500,
      agreement_rate: 0.9,
    });
    expect(out.map((c) => c.key)).toEqual([
      "items_graded",
      "verified_sellers",
      "agreement",
      "graded_sales",
    ]);
  });
});
