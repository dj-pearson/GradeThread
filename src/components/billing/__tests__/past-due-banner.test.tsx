// US-776: the persistent past-due banner renders from subscription_status and
// clears when the subscription recovers.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { useBillingSummary, useBillingPortal } from "@/hooks/use-billing-summary";
import { PastDueBanner } from "@/components/billing/past-due-banner";

vi.mock("@/hooks/use-billing-summary", () => ({
  useBillingSummary: vi.fn(),
  useBillingPortal: vi.fn(),
}));

const mockedSummary = vi.mocked(useBillingSummary);
const mockedPortal = vi.mocked(useBillingPortal);

// Minimal billing-summary fixture with the given subscription status.
function summaryWithStatus(status: string) {
  return {
    data: {
      subscription: { status, plan: "pro" },
    },
  } as unknown as ReturnType<typeof useBillingSummary>;
}

function render(): string {
  return renderToStaticMarkup(<PastDueBanner />);
}

const BANNER_TEXT = "your plan benefits are paused";

describe("PastDueBanner (US-776)", () => {
  beforeEach(() => {
    mockedSummary.mockReset();
    mockedPortal.mockReset();
    // The portal mutation is unused by the static render but must be callable.
    mockedPortal.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof useBillingPortal>);
  });

  it("renders the banner when the subscription is past_due", () => {
    mockedSummary.mockReturnValue(summaryWithStatus("past_due"));
    const html = render();
    expect(html).toContain(BANNER_TEXT);
    expect(html).toContain("Update payment method");
  });

  it("renders nothing when the subscription is active (recovered)", () => {
    mockedSummary.mockReturnValue(summaryWithStatus("active"));
    expect(render()).toBe("");
  });

  it("renders nothing while the summary is still loading (no data)", () => {
    mockedSummary.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useBillingSummary>);
    expect(render()).toBe("");
  });
});
