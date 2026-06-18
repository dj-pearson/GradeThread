import { describe, expect, it } from "vitest";
import {
  cohortConfidence,
  confidenceLevel,
  deriveRecommendations,
  inventoryBrandLink,
  sourceCompsLink,
} from "./community-recommendations";
import type { CommunityBenchmarks } from "./community-benchmarks";

function benchmarks(
  partial: Partial<CommunityBenchmarks>,
): CommunityBenchmarks {
  return {
    meta: { minSellers: 5, periodStart: null, generatedAt: "2026-06-18" },
    topBrands: [],
    categories: [],
    trendingCategories: [],
    priceRealization: null,
    timeToSell: null,
    trends: { windows: { d30: null, d90: null, d365: null }, monthly: [] },
    you: {
      listed: 0,
      sold: 0,
      sellThrough: null,
      medianDaysToSell: null,
      medianRealization: null,
      peerComparison: null,
    },
    ...partial,
  };
}

describe("cohortConfidence", () => {
  it("floors at the k-anonymity threshold and climbs with sellers", () => {
    expect(cohortConfidence(5)).toBeCloseTo(0.4, 5);
    expect(cohortConfidence(20)).toBeCloseTo(0.85, 5);
    // Caps at 0.95 no matter how large the cohort.
    expect(cohortConfidence(100)).toBe(0.95);
  });

  it("never returns below the floor for tiny cohorts", () => {
    expect(cohortConfidence(0)).toBe(0.4);
  });
});

describe("confidenceLevel", () => {
  it("buckets into high/medium/low", () => {
    expect(confidenceLevel(0.8)).toBe("high");
    expect(confidenceLevel(0.6)).toBe("medium");
    expect(confidenceLevel(0.5)).toBe("low");
  });
});

describe("deriveRecommendations", () => {
  it("suggests sourcing a high-sell-through brand and pricing it near the avg", () => {
    const recs = deriveRecommendations(
      benchmarks({
        topBrands: [
          {
            brand: "Patagonia",
            sellers: 20,
            listed: 100,
            sold: 80,
            sellThrough: 0.8,
            avgSalePrice: 65,
          },
        ],
      }),
    );
    const source = recs.find((r) => r.kind === "source");
    const price = recs.find((r) => r.kind === "price");
    expect(source).toBeDefined();
    expect(source?.subject).toBe("Patagonia");
    expect(source?.cohortSize).toBe(20);
    expect(source?.deepLink).toBe(sourceCompsLink("Patagonia"));
    expect(price).toBeDefined();
    expect(price?.title).toContain("$65.00");
    expect(price?.deepLink).toBe(inventoryBrandLink("Patagonia"));
  });

  it("does NOT suggest sourcing a low-sell-through brand", () => {
    const recs = deriveRecommendations(
      benchmarks({
        topBrands: [
          {
            brand: "Slowmover",
            sellers: 12,
            listed: 100,
            sold: 20,
            sellThrough: 0.2,
            avgSalePrice: 30,
          },
        ],
      }),
    );
    expect(recs.some((r) => r.kind === "source")).toBe(false);
    // ...but a price reference is still useful.
    expect(recs.some((r) => r.kind === "price")).toBe(true);
  });

  it("surfaces a rising category and skips flat/declining ones", () => {
    const recs = deriveRecommendations(
      benchmarks({
        trendingCategories: [
          {
            category: "outerwear",
            sellers: 15,
            soldRecent: 60,
            soldPrevious: 30,
            growth: 1.0,
          },
          {
            category: "tops",
            sellers: 10,
            soldRecent: 31,
            soldPrevious: 30,
            growth: 0.03,
          },
        ],
      }),
    );
    const cats = recs.filter((r) => r.subject === "outerwear");
    expect(cats).toHaveLength(1);
    expect(recs.some((r) => r.subject === "tops")).toBe(false);
  });

  it("ranks by score (strong signal + large cohort first)", () => {
    const recs = deriveRecommendations(
      benchmarks({
        topBrands: [
          {
            brand: "Weak",
            sellers: 5,
            listed: 10,
            sold: 6,
            sellThrough: 0.6,
            avgSalePrice: 20,
          },
          {
            brand: "Strong",
            sellers: 25,
            listed: 100,
            sold: 95,
            sellThrough: 0.95,
            avgSalePrice: 80,
          },
        ],
      }),
    );
    expect(recs[0]?.subject).toBe("Strong");
  });

  it("returns nothing when there are no qualifying cohorts", () => {
    expect(deriveRecommendations(benchmarks({}))).toEqual([]);
  });
});
