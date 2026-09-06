// US-1902: the pricing page must not sell buyer features that still land on a
// placeholder. Rendered to static markup, the not-live guarantee bullet must
// carry a "Coming soon" badge while a live buyer feature (condition alerts)
// does not.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PricingPage } from "@/pages/marketing/pricing";
import { BUYER_FEATURES } from "@/lib/buyer-features";

function render(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingPage />
        </MemoryRouter>
      </QueryClientProvider>
  );
}

describe("pricing page — buyer coming-soon labeling", () => {
  // US-2073: this used to assert the SNAPSHOT — "purchaseGuarantee.live is
  // false, and its bullet is badged". That made shipping the feature fail the
  // test for the right reason but the wrong shape: the thing worth protecting
  // is the INVARIANT (never sell a buyer feature that lands on a placeholder),
  // not which feature happens to be unshipped this week. Asserting the
  // invariant means the next feature to ship needs no test edit, and the next
  // one to REGRESS still fails.
  it("badges every not-live buyer feature and leaves live ones unbadged", () => {
    const html = render();

    const entries = Object.values(BUYER_FEATURES);
    expect(entries.length).toBeGreaterThan(0);

    for (const feature of entries) {
      const idx = html.toLowerCase().indexOf(feature.label.toLowerCase());
      if (idx === -1) continue; // not surfaced on this page — nothing to assert
      const window = html.slice(idx, idx + 450);
      if (feature.live) {
        expect(
          window,
          `"${feature.label}" is live but its pricing bullet is badged "Coming soon"`,
        ).not.toContain("Coming soon");
      } else {
        expect(
          window,
          `"${feature.label}" is NOT live but its pricing bullet has no "Coming soon" badge — ` +
            `the pricing page would be selling a feature that lands on a placeholder`,
        ).toContain("Coming soon");
      }
    }
  });

  it("shows no stale Coming-soon badge once every buyer feature is live", () => {
    // The complement: if nothing is unshipped, the badge should be absent
    // entirely. Without this, a hardcoded badge left in the markup would
    // survive the loop above (which only checks the window around each label).
    const anyNotLive = Object.values(BUYER_FEATURES).some((f) => !f.live);
    if (anyNotLive) return;
    expect(render()).not.toContain("Coming soon");
  });
});
