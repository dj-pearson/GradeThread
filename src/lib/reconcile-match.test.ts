import { describe, it, expect } from "vitest";
import { rankItemMatches, type MatchCandidate } from "./reconcile-match";

const candidates: MatchCandidate[] = [
  { id: "1", title: "Nike Dri-Fit Running Tee", brand: "Nike", sku: "ABC-1" },
  { id: "2", title: "Patagonia Better Sweater Fleece", brand: "Patagonia", sku: "PAT-9" },
  { id: "3", title: "Vintage Levi's 501 Denim", brand: "Levi's", sku: "LV-501" },
];

describe("rankItemMatches", () => {
  it("ranks a brand hit highest", () => {
    const ranked = rankItemMatches({ brand: "Patagonia", keywords: ["fleece"] }, candidates);
    expect(ranked[0]!.id).toBe("2");
    expect(ranked[0]!.score).toBeGreaterThan(0.5);
  });

  it("matches on keywords when brand is unknown", () => {
    const ranked = rankItemMatches({ brand: null, keywords: ["denim", "501"] }, candidates);
    expect(ranked[0]!.id).toBe("3");
  });

  it("matches against the SKU token", () => {
    const ranked = rankItemMatches({ brand: null, keywords: ["LV-501"] }, candidates);
    expect(ranked[0]!.id).toBe("3");
  });

  it("returns nothing when there are no usable hints", () => {
    expect(rankItemMatches({ brand: null, keywords: [] }, candidates)).toEqual([]);
    expect(rankItemMatches({ brand: "  ", keywords: ["—"] }, candidates)).toEqual([]);
  });

  it("excludes candidates with zero overlap", () => {
    const ranked = rankItemMatches({ brand: "Supreme", keywords: ["hoodie"] }, candidates);
    expect(ranked).toEqual([]);
  });

  it("orders by descending score", () => {
    const ranked = rankItemMatches({ brand: "Nike", keywords: ["running", "tee"] }, candidates);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });
});
