// A10: the Community tab under the page's one range control, with its filters
// in the URL, a price check, plain error copy with a working Retry, and a CSV
// that holds the percentages the table shows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { buttonByText, mount, settle, type Mounted } from "@/test/helpers/mount";
import { presetStart } from "@/lib/analytics-range";
import {
  communityErrorMessage,
  filtersFromParams,
  filtersToParams,
  priceRangeInvalid,
  sameBenchmarkFilters,
  type CommunityBenchmarks,
  type CommunityBenchmarkFilters,
} from "@/lib/community-benchmarks";

const calls: Array<{ periodStart: string | null; filters?: CommunityBenchmarkFilters }> = [];
let failNext: { code: string } | null = null;
const csvs: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [];

const DATA: CommunityBenchmarks = {
  meta: { minSellers: 5, periodStart: null, generatedAt: "2026-09-24" },
  topBrands: [
    {
      brand: "Nike",
      sellers: 12,
      listed: 100,
      sold: 53,
      sellThrough: 0.53,
      avgSalePrice: 40,
      medianRealization: 0.874,
      medianDaysToSell: 12,
    },
  ],
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
};

vi.mock("@/lib/community-benchmarks", async (orig) => ({
  ...(await orig<typeof import("@/lib/community-benchmarks")>()),
  fetchCommunityBenchmarks: vi.fn(
    async (periodStart: string | null, filters?: CommunityBenchmarkFilters) => {
      calls.push({ periodStart, filters });
      if (failNext) {
        const code = failNext.code;
        failNext = null;
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code,
        });
      }
      return DATA;
    },
  ),
}));
vi.mock("@/lib/csv-export", () => ({
  downloadCsv: (name: string, headers: string[], rows: unknown[][]) =>
    csvs.push({ name, headers, rows }),
}));

const { FlipdeskCommunityInsightsPage } = await import(
  "@/pages/flipdesk/community-insights"
);
const Page = FlipdeskCommunityInsightsPage as (p: { embedded?: boolean }) => ReactNode;

let m: Mounted | null = null;
beforeEach(() => {
  calls.length = 0;
  csvs.length = 0;
  failNext = null;
  useAuthStore.setState({
    user: { id: "11111111-1111-4111-8111-111111111111" } as never,
    activeWorkspaceOwnerId: null,
  });
});
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("community filter helpers", () => {
  it("round-trips applied filters through the URL", () => {
    const sp = filtersToParams(new URLSearchParams("preset=30d"), {
      brand: " Nike ",
      priceMin: 20,
      priceMax: null,
    });
    expect(sp.toString()).toBe("preset=30d&brand=Nike&pmin=20");
    expect(filtersFromParams(sp)).toEqual({
      brand: "Nike",
      category: null,
      size: null,
      priceMin: 20,
      priceMax: null,
    });
  });

  it("flags min above max, and treats blank and absent as the same filter", () => {
    expect(priceRangeInvalid({ priceMin: 50, priceMax: 20 })).toBe(true);
    expect(priceRangeInvalid({ priceMin: 20, priceMax: 50 })).toBe(false);
    expect(sameBenchmarkFilters({ brand: "" }, {})).toBe(true);
    expect(sameBenchmarkFilters({ brand: "nike" }, {})).toBe(false);
  });

  it("maps error codes to plain copy", () => {
    expect(communityErrorMessage({ code: "57014" })).toMatch(/taking too long/);
    expect(communityErrorMessage({ code: "42501" })).toBe("Sign in again.");
    expect(communityErrorMessage(new Error("relation does not exist"))).not.toMatch(
      /relation/,
    );
  });
});

describe("Community tab (A10)", () => {
  it("reloads ?preset=30d&brand=nike to the same view with one period control", async () => {
    m = mount(h(Page, { embedded: true }), "/dashboard/flipdesk/analytics/community?preset=30d&brand=nike");
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.periodStart).toBe(presetStart("30d"));
    expect(calls[0]!.filters?.brand).toBe("nike");
    // The page header owns the range; the tab draws no second one.
    expect(m.container.querySelector('[aria-label="Time period"]')).toBeNull();
    // The draft starts from the applied filters.
    expect(m.container.querySelector<HTMLInputElement>("#ci-brand")?.value).toBe("nike");
    // Nothing changed, so there is nothing to apply.
    expect(buttonByText(m.container, "Apply")?.disabled).toBe(true);
  });

  it("writes 53 for a 53% row, with sold and listed columns", async () => {
    m = mount(h(Page, { embedded: true }), "/dashboard/flipdesk/analytics/community?preset=30d&brand=nike");
    await settle();
    const exp = m.container.querySelector<HTMLButtonElement>(
      '[aria-label="Export the community top brands table as CSV"]',
    );
    await act(async () => exp!.click());
    const csv = csvs[0]!;
    expect(csv.headers).toContain("Sell-through (%)");
    expect(csv.headers).toContain("Realization (%)");
    const row = csv.rows[0]!;
    expect(row[csv.headers.indexOf("Sell-through (%)")]).toBe(53);
    expect(row[csv.headers.indexOf("Realization (%)")]).toBe(87);
    expect(row[csv.headers.indexOf("Sold")]).toBe(53);
    expect(row[csv.headers.indexOf("Listed")]).toBe(100);
    expect(csv.name).toMatch(/^gradethread-community-brands-30d-brand-nike-/);
  });

  it("shows plain copy on a timeout and Retry recovers", async () => {
    failNext = { code: "57014" };
    m = mount(h(Page, { embedded: true }), "/dashboard/flipdesk/analytics/community");
    await settle();
    expect(m.container.textContent).toContain("Community numbers are taking too long");
    expect(m.container.textContent).not.toContain("canceling statement");
    // The filters stay on screen.
    expect(m.container.querySelector("#ci-brand")).toBeTruthy();
    const retry = buttonByText(m.container, /Try again/);
    await act(async () => retry!.click());
    await settle();
    expect(calls).toHaveLength(2);
    expect(m.container.textContent).not.toContain("taking too long");
  });
});
