import { describe, it, expect, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement as h, StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ResaleConditionReportPage } from "@/pages/marketing/resale-condition-report";
import { StateOfDurabilityPage } from "@/pages/marketing/state-of-durability";
import { clearPrerenderSeed, setPrerenderSeed, seedDomId } from "@/lib/seo/prerender-seed";

// US-976 / US-1775 (indexability): the data-report pages' figures must reach the
// SSR HTML when the build-time seed is present, and degrade to the pre-seed
// placeholders when it isn't (the graceful-fallback contract that keeps CI green
// when the build-time fetch can't reach the edge).

function ssr(node: React.ReactElement, path: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    h(StrictMode, null,
      h(QueryClientProvider, { client: qc },
        h(MemoryRouter, { initialEntries: [path] }, node))),
  );
}

const RESALE_SEED = {
  generated_at: "2026-07-01T00:00:00Z",
  scale: { min: 1, max: 10, increment: 0.5 },
  sample: { fulfilled_sales: 1000, listed_items: 2000, priced_sales: 900 },
  coverage: { sales_from: "2026-01-01", sales_to: "2026-06-30", listings_from: null, listings_to: null },
  return_rollup: {
    graded: { fulfilled_sales: 600, returns: 12, return_rate: 0.02 },
    ungraded: { fulfilled_sales: 400, returns: 40, return_rate: 0.1 },
    overall: { fulfilled_sales: 1000, returns: 52, return_rate: 0.052 },
  },
  bands: [
    { key: "high", label: "Excellent (8.5-10)", fulfilled_sales: 300, returns: 3, return_rate: 0.01, listed: 400, sold: 320, sell_through: 0.8, median_days_to_sell: 5, median_sale_price: 60 },
    { key: "low", label: "Fair (6 or lower)", fulfilled_sales: 100, returns: 8, return_rate: 0.08, listed: 200, sold: 100, sell_through: 0.5, median_days_to_sell: 14, median_sale_price: 20 },
  ],
  // US-1691: the grading half of the report.
  grading: {
    min_sample: 25,
    sample: { graded_items: 4200, items_with_flaws: 3100, flaw_observations: 5200 },
    average_grade: 7.8,
    by_garment_type: [
      { key: "tops", label: "Tops", graded_items: 2000, average_grade: 7.4, flaw_rate: 0.8, most_common_flaw: { defect_type: "pilling", label: "Pilling", items: 900, share: 0.45 } },
      { key: "outerwear", label: "Outerwear", graded_items: 1200, average_grade: 8.6, flaw_rate: 0.5, most_common_flaw: { defect_type: "fading", label: "Fading", items: 300, share: 0.25 } },
    ],
    common_flaws: [
      { defect_type: "stain", label: "Stains", items: 1200, share: 0.2857 },
      { defect_type: "pilling", label: "Pilling", items: 900, share: 0.2143 },
    ],
  },
};

const DURABILITY_SEED = {
  generated_at: "2026-07-01T00:00:00Z",
  sample: { brands: 12, sufficient_cohorts: 20, total_cohorts: 30, garments: 3456, regrades: 789 },
  most_durable: [{ brand: "Carhartt", brandSlug: "carhartt", retentionPct: 94.5, avgDecay: 0.4, cohortCount: 5 }],
  least_durable: [{ brand: "Zephyr", brandSlug: "zephyr", retentionPct: 71.2, avgDecay: 2.1, cohortCount: 4 }],
  weakest_factors: [{ factor: "structural", label: "Structural integrity", avgDecay: 1.8 }],
};

afterEach(() => clearPrerenderSeed());

describe("resale-condition-report SSR seed", () => {
  it("renders the live figures into SSR HTML when seeded", () => {
    setPrerenderSeed("resale-condition-report", RESALE_SEED);
    const html = ssr(h(ResaleConditionReportPage), "/resale-condition-report");
    // React splits adjacent text with <!-- --> comment markers; strip them so
    // multi-node figures (e.g. "+{n}%") assert as contiguous strings.
    const text = html.replace(/<!-- -->/g, "");
    expect(text).toContain("2.0%"); // graded return rate
    expect(text).toContain("10.0%"); // ungraded return rate
    expect(text).toContain("+200%"); // condition value premium (60 vs 20)
    expect(html).toContain(`id="${seedDomId("resale-condition-report")}"`);
  });

  // US-1691: the grading half + the quotable block must be in the CRAWLABLE HTML
  // too — an AI answer engine that doesn't run JS is the whole audience for them.
  it("renders the grading half and the by-the-numbers block into SSR HTML", () => {
    setPrerenderSeed("resale-condition-report", RESALE_SEED);
    const text = ssr(h(ResaleConditionReportPage), "/resale-condition-report")
      .replace(/<!-- -->/g, "");
    // Assert on the HEADINGS, not the bare phrases — the FAQ copy mentions
    // "By the numbers" too, so a substring match would pass without a section.
    expect(text).toContain("Average condition grade by garment type</h2>");
    expect(text).toContain("Outerwear");
    expect(text).toContain("8.6"); // outerwear average grade
    expect(text).toContain("The most common flaws</h2>");
    expect(text).toContain("Stains");
    expect(text).toContain("By the numbers</h2>");
    expect(text).toContain("7.8 out of 10.0"); // quotable platform-wide average
  });

  it("degrades to placeholders when unseeded", () => {
    const html = ssr(h(ResaleConditionReportPage), "/resale-condition-report");
    expect(html).not.toContain("+200%");
    expect(html).not.toContain("By the numbers</h2>");
    expect(html).not.toContain("Average condition grade by garment type</h2>");
    expect(html).not.toContain(`id="${seedDomId("resale-condition-report")}"`);
  });
});

describe("state-of-durability SSR seed", () => {
  it("renders the brand rankings into SSR HTML when seeded", () => {
    setPrerenderSeed("durability-report", DURABILITY_SEED);
    const html = ssr(h(StateOfDurabilityPage), "/state-of-durability");
    expect(html).toContain("Carhartt");
    expect(html).toContain("94.5%"); // grade retention
    expect(html).toContain("3,456"); // garments measured
    expect(html).toContain(`id="${seedDomId("durability-report")}"`);
  });

  it("degrades to placeholders when unseeded", () => {
    const html = ssr(h(StateOfDurabilityPage), "/state-of-durability");
    expect(html).not.toContain("Carhartt");
    expect(html).not.toContain(`id="${seedDomId("durability-report")}"`);
  });
});
