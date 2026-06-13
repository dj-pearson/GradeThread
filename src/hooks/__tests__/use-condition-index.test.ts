import { describe, it, expect } from "vitest";
import {
  curveMedianAtGrade,
  formatCurveCents,
  matchConditionIndexEntry,
  type ConditionCurvePoint,
  type ConditionIndexHubItem,
} from "@/hooks/use-condition-index";

function hub(
  partial: Partial<ConditionIndexHubItem> & { slug: string; brand: string },
): ConditionIndexHubItem {
  return {
    label: partial.label ?? partial.slug,
    currency: "USD",
    headlineMedianCents: 5000,
    totalSampleSize: 20,
    refreshedAt: "2026-06-01T00:00:00Z",
    ...partial,
  };
}

const PATA_SWEATER = hub({
  slug: "patagonia-better-sweater",
  brand: "Patagonia",
  label: "Patagonia Better Sweater",
  totalSampleSize: 30,
});
const PATA_JACKET = hub({
  slug: "patagonia-jackets",
  brand: "Patagonia",
  label: "Patagonia Jackets",
  totalSampleSize: 40,
});
const LEVIS = hub({ slug: "levis-501-jeans", brand: "Levi's", label: "Levi's 501 Jeans" });
const ITEMS = [PATA_SWEATER, PATA_JACKET, LEVIS];

describe("matchConditionIndexEntry", () => {
  it("returns null without a brand", () => {
    expect(matchConditionIndexEntry(ITEMS, { brand: "", title: "jacket" })).toBeNull();
    expect(matchConditionIndexEntry(ITEMS, { brand: null })).toBeNull();
  });

  it("returns null when no brand matches", () => {
    expect(matchConditionIndexEntry(ITEMS, { brand: "Nike" })).toBeNull();
  });

  it("matches brand case-insensitively for a single entry", () => {
    expect(matchConditionIndexEntry(ITEMS, { brand: "levi's" })).toBe(LEVIS);
  });

  it("disambiguates multiple brand entries by category/title keyword overlap", () => {
    expect(
      matchConditionIndexEntry(ITEMS, { brand: "Patagonia", category: "Sweaters", title: "Better Sweater 1/4 zip" }),
    ).toBe(PATA_SWEATER);
    expect(
      matchConditionIndexEntry(ITEMS, { brand: "Patagonia", category: "Jackets", title: "Nano Puff jacket" }),
    ).toBe(PATA_JACKET);
  });

  it("falls back to the deepest curve when nothing overlaps", () => {
    // No keyword overlap → tie-break on totalSampleSize (jackets: 40 > sweater: 30).
    expect(matchConditionIndexEntry(ITEMS, { brand: "Patagonia", category: "Pants" })).toBe(PATA_JACKET);
  });
});

function pt(grade: number, medianCents: number | null): ConditionCurvePoint {
  return { grade, lowCents: medianCents, medianCents, highCents: medianCents, sampleSize: 10 };
}

describe("curveMedianAtGrade", () => {
  const points = [pt(10, 9000), pt(8.5, 7000), pt(8, 6000), pt(5, 3000)];

  it("returns the exact point when the grade matches", () => {
    expect(curveMedianAtGrade(points, 8.5)?.medianCents).toBe(7000);
  });

  it("returns the nearest point otherwise", () => {
    expect(curveMedianAtGrade(points, 9)?.grade).toBe(8.5);
    expect(curveMedianAtGrade(points, 4)?.grade).toBe(5);
  });

  it("ignores points without a median", () => {
    expect(curveMedianAtGrade([pt(8, null), pt(5, 3000)], 8)?.grade).toBe(5);
  });

  it("returns null when grade is unknown or no data", () => {
    expect(curveMedianAtGrade(points, null)).toBeNull();
    expect(curveMedianAtGrade([pt(8, null)], 8)).toBeNull();
  });
});

describe("formatCurveCents", () => {
  it("drops cents for whole-dollar values", () => {
    expect(formatCurveCents(4200, "USD")).toBe("$42");
  });

  it("keeps cents otherwise", () => {
    expect(formatCurveCents(3850, "USD")).toBe("$38.50");
  });
});
