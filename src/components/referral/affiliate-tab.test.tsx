// The Affiliate tab: an error is an error (not "no program"), cash is shown to
// creators only, and nothing under /api/affiliate is fetched until the tab opens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (url: string) => { status: number; body: unknown };
let handler: Handler = () => ({ status: 200, body: {} });
const calls: string[] = [];
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: async (url: string) => {
    calls.push(url);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { AffiliateTab } from "@/components/referral/affiliate-tab";
import { ReferralsPage } from "@/pages/referrals";

const ME = {
  code: "ABCD2345",
  stats: { total: 0, pending: 0, qualified: 0, granted: 0, waiting: 0, forfeit: 0 },
  credits: { per_referral: 5, earned: 0, pending: 0 },
  rules: { per_referral: 5, referred_bonus: 3, referred_on_qualify: 3, window_days: 0, cap: 0, cap_remaining: null },
  milestones: { tiers: [], earned_thresholds: [], earned_bonus_credits: 0, next: null },
  leaderboard: { enabled: false, display_name: null, rank: null, tied: false },
  referred_by: null,
  redeem_eligible: true,
};

const PAYOUTS_BASE = {
  rate: 5,
  minimum_payout: 25,
  hold_days: 30,
  onboarding: { connected: false, payouts_enabled: false },
  balance: { accrued_payable: 0, accrued_held: 0, paid: 0, in_transit: 0 },
  tax: { threshold: 2000, paid_this_year: 0, reaches_1099_threshold: false },
  payouts: [],
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  calls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function render(ui: ReactNode, path = "/dashboard/account?tab=referrals") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("AffiliateTab", () => {
  it("shows an error with Retry when payouts fail, not an empty program", async () => {
    handler = (url) =>
      url === "/api/affiliate/payouts"
        ? { status: 500, body: { error: "boom" } }
        : { status: 200, body: { code: "ABCD2345", clicks: { total: 0, last30: 0, converted: 0 }, conversions: 0 } };
    await render(<AffiliateTab code="ABCD2345" onOpenCreator={() => {}} />);
    expect(container.textContent).toContain("Couldn't load your payouts");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => /Try again/.test(b.textContent ?? ""));
    expect(retry).toBeTruthy();
  });

  it("offers no Stripe button to a seller outside the creator program", async () => {
    handler = (url) =>
      url === "/api/affiliate/payouts"
        ? { status: 200, body: { ...PAYOUTS_BASE, enabled: false, program: "user" } }
        : { status: 200, body: { code: "ABCD2345", clicks: { total: 4, last30: 1, converted: 1 }, conversions: 1 } };
    await render(<AffiliateTab code="ABCD2345" onOpenCreator={() => {}} />);
    expect(container.textContent).toContain("Cash is for approved creators");
    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(labels.some((t) => /Set up payouts|Finish setup/.test(t))).toBe(false);
    expect(container.textContent).toContain("25%");
  });

  it("shows a creator the checklist, the payout history and the 1099 progress", async () => {
    handler = (url) =>
      url === "/api/affiliate/payouts"
        ? {
            status: 200,
            body: {
              ...PAYOUTS_BASE,
              enabled: true,
              program: "creator",
              commission_model: "subscription_pct",
              commission_pct: 25,
              commission_window_months: 12,
              commission_cap_usd: 250,
              tax_profile_certified: false,
              tax: { threshold: 2000, paid_this_year: 120, reaches_1099_threshold: false },
              payouts: [
                { id: "p1", amount: 30, status: "failed", stripe_transfer_id: null, paid_at: null, created_at: "2026-09-01T00:00:00Z" },
              ],
            },
          }
        : { status: 200, body: { code: "ABCD2345", clicks: { total: 0, last30: 0, converted: 0 }, conversions: 0 } };
    await render(<AffiliateTab code="ABCD2345" onOpenCreator={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("25% of their first 12 months, up to $250.00 per account.");
    expect(text).toContain("Tax form on file");
    expect(text).toContain("Failed");
    expect(text).toContain("$120.00 of $2,000.00 this year");
  });

  it("the eBay line carries no link", async () => {
    handler = () => ({ status: 500, body: {} });
    await render(<AffiliateTab code="ABCD2345" onOpenCreator={() => {}} />);
    const ebay = container.querySelector<HTMLInputElement>('input[aria-label="eBay proof-of-grade line"]')!;
    expect(ebay.value).not.toMatch(/http|<a/i);
  });
});

describe("ReferralsPage on the Share tab", () => {
  it("makes no /api/affiliate request", async () => {
    handler = (url) =>
      url === "/api/referrals/me"
        ? { status: 200, body: ME }
        : url === "/api/referrals/me/events"
          ? { status: 200, body: { events: [], truncated: false } }
          : { status: 200, body: {} };
    await render(<ReferralsPage />);
    expect(container.textContent).toContain("Your referral link");
    expect(calls.some((u) => u.startsWith("/api/affiliate/"))).toBe(false);
  });
});
