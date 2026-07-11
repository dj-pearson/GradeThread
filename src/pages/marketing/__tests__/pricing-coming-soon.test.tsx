// US-1902: the pricing page must not sell buyer features that still land on a
// placeholder. Rendered to static markup, the not-live guarantee bullet must
// carry a "Coming soon" badge while a live buyer feature (condition alerts)
// does not.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PricingPage } from "@/pages/marketing/pricing";
import { BUYER_FEATURES } from "@/lib/buyer-features";

function render(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PricingPage />
        </MemoryRouter>
      </QueryClientProvider>
    </HelmetProvider>,
  );
}

describe("pricing page — buyer coming-soon labeling", () => {
  it("badges the not-live guarantee bullet and renders live features unbadged", () => {
    const html = render();

    // Sanity: the guarantee feature is the one not-live surface.
    expect(BUYER_FEATURES.purchaseGuarantee.live).toBe(false);

    // The page shows the "Coming soon" badge somewhere (the guarantee bullets).
    expect(html).toContain("Coming soon");

    // The badge sits next to the guarantee bullet: the substring between a
    // guarantee mention and the next list item includes the badge.
    const guaranteeIdx = html.indexOf("grade-locked purchase guarantee");
    expect(guaranteeIdx).toBeGreaterThan(-1);
    const afterGuarantee = html.slice(guaranteeIdx, guaranteeIdx + 450);
    expect(afterGuarantee).toContain("Coming soon");

    // A live buyer feature bullet (condition alerts) is NOT badged: the badge
    // never appears immediately after an alerts bullet.
    const alertsIdx = html.indexOf("condition alerts");
    if (alertsIdx > -1) {
      const afterAlerts = html.slice(alertsIdx, alertsIdx + 60);
      expect(afterAlerts).not.toContain("Coming soon");
    }
  });
});
