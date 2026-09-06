import { describe, it, expect, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement as h, StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TransparencyPage } from "@/pages/marketing/transparency";
import {
  escapeJsonForScript,
  setTransparencySeed,
  TRANSPARENCY_SEED_DOM_ID,
} from "@/lib/seo/transparency-seed";

// US-1399: the transparency page's numeric facts must reach the SSR HTML when
// the build-time seed is present, and degrade to the pre-seed placeholders
// when it isn't (the graceful-fallback contract that keeps CI green).

function ssr(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToString(
    h(StrictMode, null,
      h(QueryClientProvider, { client: qc },
        h(MemoryRouter, { initialEntries: ["/transparency"] },
          h(TransparencyPage)))),
  );
}

const SEED = {
  generated_at: "2026-07-01T00:00:00Z",
  scale: { min: 1, max: 10, increment: 0.5, tiers: 7 },
  volume: { items_graded: 4321, human_reviews: 321, graded_sales: 111 },
  quality: {
    human_agreement_rate: 0.912,
    mean_absolute_error: 0.34,
    intentional_misread_rate: 0.021,
    avg_confidence: 0.88,
    human_review_rate: 0.14,
  },
  outcomes: { dispute_rate: 0.009 },
  category_quality: [
    {
      garment_category: "jeans",
      mean_absolute_error: 0.41,
      agreement_rate: 0.87,
      reviews: 58,
    },
  ],
  gate: { max_mae: 0.5, min_agreement: 0.85 },
  model: { active: [{ stage: "composite", version_name: "composite_v4" }] },
  changelog: [],
  reliability: null,
};

afterEach(() => setTransparencySeed(null));

describe("US-1399 transparency SSR seed", () => {
  it("renders the live numeric facts into SSR HTML when seeded", () => {
    setTransparencySeed(SEED);
    const html = ssr();
    // Key numeric facts present without JS:
    expect(html).toContain("91.2%"); // agreement rate
    expect(html).toContain("0.34"); // MAE
    expect(html).toContain("0.9%"); // dispute rate
    expect(html).toContain("Jeans"); // category row (label-cased)
    // The embedded seed script rides along for client hydration.
    expect(html).toContain(`id="${TRANSPARENCY_SEED_DOM_ID}"`);
    expect(html).toContain('"human_reviews":321');
  });

  it("degrades to placeholders when unseeded (the CI-safe path)", () => {
    setTransparencySeed(null);
    const html = ssr();
    // Unseeded SSR is the pre-US-1399 behavior: loading placeholders that
    // hydrate client-side; the seed script must be absent.
    expect(html).toContain("Loading category breakdown");
    expect(html).not.toContain("91.2%");
    expect(html).not.toContain(`id="${TRANSPARENCY_SEED_DOM_ID}"`);
  });

  it("escapes script-terminating sequences in the embedded JSON", () => {
    expect(escapeJsonForScript({ x: "</script><script>alert(1)" }))
      .not.toContain("</script>");
    expect(escapeJsonForScript({ x: "</script>" }))
      .toContain("\\u003c/script");
  });
});
