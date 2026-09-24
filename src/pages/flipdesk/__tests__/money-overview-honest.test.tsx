// Money M6: every card on the Overview waits on, and fails on, only its own
// reads. A pending review count is a skeleton, not "Nothing"; a failed rates
// read still leaves Profit on screen; a workspace member sees whose books these
// are instead of their own empty ledger as $0; and the tab badge shows "?" on
// a failed count rather than hiding, which reads as zero.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  owner: "u1",
  fetchReviewCount: vi.fn(),
  fetchTaxRateYear: vi.fn(),
  fetchLedgerEntries: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));

vi.mock("@/stores/auth-store", () => {
  const s = { user: { id: "u1" } };
  const useAuthStore = (sel?: (x: typeof s) => unknown) => (sel ? sel(s) : s);
  useAuthStore.getState = () => s;
  return { useAuthStore };
});

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: mocks.owner }),
}));

vi.mock("@/lib/ledger", async (orig) => ({
  ...(await orig<typeof import("@/lib/ledger")>()),
  ensureLedgerBuilt: () => Promise.resolve(),
  fetchLedgerEntries: mocks.fetchLedgerEntries,
}));

vi.mock("@/lib/books-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/books-review")>()),
  fetchReviewCount: mocks.fetchReviewCount,
}));

vi.mock("@/lib/estimated-tax", async (orig) => ({
  ...(await orig<typeof import("@/lib/estimated-tax")>()),
  fetchTaxRateYear: mocks.fetchTaxRateYear,
  fetchPayments: () => Promise.resolve([]),
}));

vi.mock("@/lib/tax-profile", async (orig) => {
  const real = await orig<typeof import("@/lib/tax-profile")>();
  return {
    ...real,
    fetchTaxProfile: () =>
      Promise.resolve({ ...real.TAX_PROFILE_DEFAULTS, user_id: "u1" }),
  };
});

vi.mock("@/components/finances/ledger-drift-banner", () => ({
  LedgerDriftBanner: () => null,
}));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
// The host lazy-loads the active view; the badge tests open Tax, stubbed.
vi.mock("@/pages/flipdesk/tax-setup", () => ({ TaxSetupPage: () => null }));

const { MoneyOverviewPage } = await import("@/pages/flipdesk/money-overview");
const { FlipdeskMoneyPage } = await import("@/pages/flipdesk/money");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode, url = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const text = () => document.body.textContent ?? "";
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  mocks.owner = "u1";
  mocks.fetchLedgerEntries.mockResolvedValue([
    { ledger_accounts: { code: "4000" }, amount_cents: 41_250, entry_date: "2026-03-01" },
  ]);
  mocks.fetchTaxRateYear.mockResolvedValue(null);
  mocks.fetchReviewCount.mockResolvedValue(0);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("MoneyOverviewPage", () => {
  it("a pending review count is a skeleton, not 'Nothing'", async () => {
    mocks.fetchReviewCount.mockImplementation(never);
    await render(<MoneyOverviewPage />);
    expect(text()).toContain("Needs a look");
    expect(text()).not.toContain("Nothing");
    expect(document.querySelector('[aria-label="Loading Needs a look"]')).not.toBeNull();
  });

  it("a failed rates read still renders Profit", async () => {
    mocks.fetchTaxRateYear.mockRejectedValue(new Error("boom"));
    await render(<MoneyOverviewPage />);
    expect(text()).toContain("Profit,");
    expect(text()).toContain("$412.50");
    expect(text()).toContain("Couldn't load your tax setup");
    expect(text()).not.toContain("Not set up");
    expect(text()).not.toContain("Couldn't load your money");
  });

  it("a failed ledger read blanks the page", async () => {
    mocks.fetchLedgerEntries.mockRejectedValue(new Error("boom"));
    await render(<MoneyOverviewPage />);
    expect(text()).toContain("Couldn't load your money");
    expect(text()).not.toContain("$0.00");
  });

  it("a member acting in another workspace sees the notice, not $0", async () => {
    mocks.owner = "owner-2";
    await render(<MoneyOverviewPage />);
    expect(text()).toContain("Money shows the account owner's books");
    expect(text()).not.toContain("$0.00");
    expect(mocks.fetchLedgerEntries).not.toHaveBeenCalled();
  });

  it("asks for the review count over the fiscal year the P&L lists", async () => {
    await render(<MoneyOverviewPage />);
    const [from, to] = mocks.fetchReviewCount.mock.calls[0]!;
    expect(from).toMatch(/^\d{4}-01-01$/);
    expect(to).toMatch(/^\d{4}-01-01$/);
  });
});

describe("FlipdeskMoneyPage badge", () => {
  it("a failed count shows '?' with a screen-reader sentence", async () => {
    mocks.fetchReviewCount.mockRejectedValue(new Error("boom"));
    await render(<FlipdeskMoneyPage />, "/?view=tax");
    const badge = [...document.querySelectorAll("span[aria-hidden]")].find(
      (el) => el.textContent === "?",
    );
    expect(badge).toBeTruthy();
    expect(text()).toContain("Couldn't check your books");
  });

  it("a count of 2 shows 2 with a sentence", async () => {
    mocks.fetchReviewCount.mockResolvedValue(2);
    await render(<FlipdeskMoneyPage />, "/?view=tax");
    expect(text()).toContain("2 things in your books need a look");
  });
});
