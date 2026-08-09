// US-2235 AC1 + AC2 — the browser half of filtered community benchmarks.
//
// The thing this file exists to protect is not the mapping, it is the LOCATION
// of the filtering. Community Insights returns pre-aggregated, k-anonymous
// medians. Filtering those client-side hides rows without recomputing anything,
// so "Carhartt sell-through" would still be everyone's sell-through with the
// other brands' rows deleted — a plausible number that is simply wrong. The
// filters therefore have to reach the RPC, and these cases pin that they do.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const {
  fetchCommunityBenchmarks,
  hasActiveFilters,
  normalizeBenchmarkFilters,
} = await import("./community-benchmarks");

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { meta: { minSellers: 5 } }, error: null });
});

describe("normalizeBenchmarkFilters", () => {
  it("turns a blank input into null, not into an empty-string filter", () => {
    // This is the one that would silently return a real and very wrong cohort:
    // the RPC compares against a coalesced 'No brand' / 'Uncategorized', so an
    // empty string is a value, not an absence.
    expect(normalizeBenchmarkFilters({ brand: "", category: "   " })).toEqual({
      brand: null,
      category: null,
      size: null,
      priceMin: null,
      priceMax: null,
    });
  });

  it("trims text so one cohort is one cache entry", () => {
    const n = normalizeBenchmarkFilters({ brand: "  Carhartt  ", size: " L " });
    expect(n.brand).toBe("Carhartt");
    expect(n.size).toBe("L");
  });

  it("drops a non-finite price rather than sending NaN to the RPC", () => {
    // An empty number input reads as NaN; sending it would compare every row
    // against NaN and return an empty cohort with no explanation.
    const n = normalizeBenchmarkFilters({ priceMin: Number.NaN, priceMax: 80 });
    expect(n.priceMin).toBeNull();
    expect(n.priceMax).toBe(80);
  });

  it("keeps a zero price bound — zero is a real floor, not an absence", () => {
    expect(normalizeBenchmarkFilters({ priceMin: 0 }).priceMin).toBe(0);
  });

  it("handles undefined input", () => {
    expect(normalizeBenchmarkFilters(undefined).brand).toBeNull();
  });
});

describe("hasActiveFilters", () => {
  it("is false for empty, blank and undefined", () => {
    expect(hasActiveFilters(undefined)).toBe(false);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ brand: "  ", size: "" })).toBe(false);
  });

  it("is true as soon as one filter narrows the cohort", () => {
    expect(hasActiveFilters({ brand: "Nike" })).toBe(true);
    expect(hasActiveFilters({ priceMin: 0 })).toBe(true);
  });
});

describe("fetchCommunityBenchmarks", () => {
  it("sends every filter to the RPC, so the SERVER narrows the cohort", () => {
    return fetchCommunityBenchmarks("2026-01-01", {
      brand: " Carhartt ",
      category: "outerwear",
      size: "L",
      priceMin: 20,
      priceMax: 150,
    }).then(() => {
      expect(rpc).toHaveBeenCalledWith("community_benchmarks", {
        p_period_start: "2026-01-01",
        p_brand: "Carhartt",
        p_category: "outerwear",
        p_size: "L",
        p_price_min: 20,
        p_price_max: 150,
      });
    });
  });

  it("sends explicit nulls when unfiltered, never omits the params", () => {
    // Omitting them would let the SQL defaults apply, which happens to be the
    // same result — but it would also mean a future param could be forgotten
    // silently. The typed args object makes that a compile error instead.
    return fetchCommunityBenchmarks(null).then(() => {
      expect(rpc).toHaveBeenCalledWith("community_benchmarks", {
        p_period_start: null,
        p_brand: null,
        p_category: null,
        p_size: null,
        p_price_min: null,
        p_price_max: null,
      });
    });
  });

  it("surfaces the RPC error rather than returning an empty snapshot", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(fetchCommunityBenchmarks(null)).rejects.toThrow("permission denied");
  });

  it("refuses an empty body instead of rendering zeros as community truth", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(fetchCommunityBenchmarks(null)).rejects.toThrow(/No benchmark data/);
  });
});
