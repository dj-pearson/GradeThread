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

// ── US-2455: the buyer product ──────────────────────────────────────────────
//
// The banner read the SELLER status and was mounted in the seller layout only,
// so a buyer whose card was declined saw nothing on any page — the dunning
// email was the entire signal, and email is the weakest channel exactly when a
// card has gone stale along with the address.

function summaryWith(seller: string, buyer: string) {
  return {
    data: {
      subscription: { status: seller, plan: "pro" },
      buyer: { status: buyer, plan: "guard" },
    },
  } as unknown as ReturnType<typeof useBillingSummary>;
}

const BUYER_TEXT = "your buyer plan benefits are paused";

describe("PastDueBanner — per product (US-2455)", () => {
  beforeEach(() => {
    mockedSummary.mockReset();
    mockedPortal.mockReset();
    mockedPortal.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof useBillingPortal>);
  });

  it("warns a buyer whose buyer subscription is past_due", () => {
    mockedSummary.mockReturnValue(summaryWith("active", "past_due"));
    const html = renderToStaticMarkup(<PastDueBanner product="buyer" />);
    expect(html).toContain(BUYER_TEXT);
    expect(html).toContain("Update payment method");
  });

  it("does NOT show the buyer alarm for a seller-only failure", () => {
    // THE ONE THAT MATTERS FOR A DUAL-ROLE ACCOUNT. Someone past_due on their
    // FlipDesk card must not be told their BUYER benefits are paused inside the
    // buyer app — it is an alarm about something they cannot act on from there,
    // and the button would send them to the wrong billing page to fix it.
    mockedSummary.mockReturnValue(summaryWith("past_due", "active"));
    expect(renderToStaticMarkup(<PastDueBanner product="buyer" />)).toBe("");
  });

  it("does NOT show the seller alarm for a buyer-only failure", () => {
    mockedSummary.mockReturnValue(summaryWith("active", "past_due"));
    expect(renderToStaticMarkup(<PastDueBanner />)).toBe("");
  });

  it("opens the portal for the product it is mounted for", () => {
    // The return path (US-2125): a buyer sent to the seller billing page after
    // Stripe cannot get back to what they were fixing.
    mockedSummary.mockReturnValue(summaryWith("active", "past_due"));
    renderToStaticMarkup(<PastDueBanner product="buyer" />);
    expect(mockedPortal).toHaveBeenCalledWith("buyer");
  });

  it("defaults to the seller product, so existing mounts are unchanged", () => {
    mockedSummary.mockReturnValue(summaryWith("past_due", "active"));
    const html = renderToStaticMarkup(<PastDueBanner />);
    expect(html).toContain("your plan benefits are paused");
    expect(html).not.toContain("buyer plan");
    expect(mockedPortal).toHaveBeenCalledWith("flipdesk");
  });
});
