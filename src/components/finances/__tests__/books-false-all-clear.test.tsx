// Money M5: in the Books views a failed read must never render as an all-clear
// or as a $0 figure. Each component here is given a rejected query and must
// show an error with a retry instead of its success copy.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boom = () => Promise.reject(new Error("boom"));

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));

vi.mock("@/stores/auth-store", () => {
  const s = { user: { id: "u1" } };
  const useAuthStore = (sel?: (x: typeof s) => unknown) => (sel ? sel(s) : s);
  useAuthStore.getState = () => s;
  return { useAuthStore };
});

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "u1", activeWorkspaceOwnerId: null }),
}));

const mocks = vi.hoisted(() => ({
  fetchReviewQueue: vi.fn(),
  fetchSources: vi.fn(),
  fetchSummary: vi.fn(),
  fetchRowsPage: vi.fn(),
  fetchLedgerEntries: vi.fn(),
  fetchMileageSummary: vi.fn(),
  fetchTrips: vi.fn(),
  fetchHomeOfficeYear: vi.fn(),
  fetchTaxProfileChanges: vi.fn(),
  fetchOperatingExpensesTotal: vi.fn(),
}));

vi.mock("@/lib/books-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/books-review")>()),
  fetchReviewQueue: mocks.fetchReviewQueue,
  fetchDismissals: () => Promise.resolve([]),
}));

vi.mock("@/lib/statement-db", async (orig) => ({
  ...(await orig<typeof import("@/lib/statement-db")>()),
  fetchSources: mocks.fetchSources,
  fetchSummary: mocks.fetchSummary,
  fetchRowsPage: mocks.fetchRowsPage,
}));

vi.mock("@/lib/ledger", async (orig) => ({
  ...(await orig<typeof import("@/lib/ledger")>()),
  ensureLedgerBuilt: () => Promise.resolve(),
  fetchLedgerEntries: mocks.fetchLedgerEntries,
}));

vi.mock("@/lib/mileage", async (orig) => ({
  ...(await orig<typeof import("@/lib/mileage")>()),
  fetchMileageSummary: mocks.fetchMileageSummary,
  fetchTrips: mocks.fetchTrips,
  fetchVehicleYear: () => Promise.resolve(null),
}));

vi.mock("@/lib/home-office", async (orig) => ({
  ...(await orig<typeof import("@/lib/home-office")>()),
  fetchHomeOfficeYear: mocks.fetchHomeOfficeYear,
  fetchHomeOfficeRate: () => Promise.resolve(null),
  fetchOverlap: () => Promise.resolve(null),
}));

vi.mock("@/lib/tax-profile", async (orig) => ({
  ...(await orig<typeof import("@/lib/tax-profile")>()),
  fetchTaxProfile: () => Promise.resolve(null),
  fetchTaxProfileChanges: mocks.fetchTaxProfileChanges,
}));

vi.mock("@/lib/finances-overhead", async (orig) => ({
  ...(await orig<typeof import("@/lib/finances-overhead")>()),
  fetchOperatingExpensesTotal: mocks.fetchOperatingExpensesTotal,
}));

vi.mock("@/lib/finances-dashboard", () => ({
  fetchFinancesDashboard: () =>
    Promise.resolve({
      summary: {
        total_revenue: 500,
        total_costs: 200,
        net_profit: 300,
        profit_margin: 60,
        items_sold: 3,
        avg_profit_per_item: 100,
        avg_days_to_sell: 10,
        inventory_value: 50,
      },
      inventory_aging: { total_count: 2 },
    }),
}));

// Children that are not under test, stubbed so each page renders on its own.
const stub = () => null;
vi.mock("@/components/finances/cogs-worksheet-card", () => ({ CogsWorksheetCard: stub }));
vi.mock("@/components/finances/ledger-drift-banner", () => ({ LedgerDriftBanner: stub }));
vi.mock("@/components/finances/form-1099k-bridge", () => ({ Form1099kBridge: stub }));
vi.mock("@/components/finances/estimated-tax-card", () => ({ EstimatedTaxCard: stub }));
vi.mock("@/components/finances/period-close-card", () => ({ PeriodCloseCard: stub }));
vi.mock("@/components/finances/tax-packet-card", () => ({ TaxPacketCard: stub }));
vi.mock("@/components/finances/quickbooks-card", () => ({ QuickBooksCard: stub }));
vi.mock("@/components/finances/tax-runway-card", () => ({ TaxRunwayCard: stub }));
vi.mock("@/components/finances/filing-walkthrough-card", () => ({ FilingWalkthroughCard: stub }));
vi.mock("@/components/finances/quickbooks-sync-card", () => ({ QuickBooksSyncCard: stub }));
vi.mock("@/components/flipdesk/ad-spend-card", () => ({ AdSpendCard: stub }));
vi.mock("@/components/finances/profit-table", () => ({ ProfitTable: stub }));
vi.mock("@/components/finances/financial-export", () => ({ FinancialExport: stub }));
vi.mock("@/components/finances/financial-charts", () => ({ FinancialCharts: stub }));
vi.mock("@/components/finances/cash-flow", () => ({ CashFlow: stub }));
vi.mock("@/components/finances/time-on-market", () => ({ TimeOnMarket: stub }));
vi.mock("@/components/finances/roi-analytics", () => ({ RoiAnalytics: stub }));
vi.mock("@/components/finances/inventory-aging", () => ({ InventoryAging: stub }));
vi.mock("@/components/finances/grade-price-correlation", () => ({
  GradePriceCorrelation: stub,
}));

const { BooksReviewCard } = await import("@/components/finances/books-review-card");
const { StatementImportCard } = await import(
  "@/components/finances/statement-import-card"
);
const { MileageLogCard } = await import("@/components/finances/mileage-log-card");
const { HomeOfficeCard } = await import("@/components/finances/home-office-card");
const { PnlPage } = await import("@/pages/flipdesk/pnl");
const { TaxSetupPage } = await import("@/pages/flipdesk/tax-setup");
const { FinancesPage } = await import("@/pages/finances");
const { ConfirmProvider } = await import("@/components/ui/confirm-dialog");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ConfirmProvider>{node}</ConfirmProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const text = () => document.body.textContent ?? "";
const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(label),
  );

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("BooksReviewCard", () => {
  it("a failed read is not 'Nothing to sort out'", async () => {
    mocks.fetchReviewQueue.mockImplementation(boom);
    await render(<BooksReviewCard from="2026-01-01" to="2027-01-01" periodLabel="2026" />);
    expect(text()).not.toContain("Nothing to sort out");
    expect(text()).toContain("Couldn't check your books");
  });

  it("an empty successful read is", async () => {
    mocks.fetchReviewQueue.mockResolvedValue([]);
    await render(<BooksReviewCard from="2026-01-01" to="2027-01-01" periodLabel="2026" />);
    expect(text()).toContain("Nothing to sort out");
  });
});

describe("StatementImportCard", () => {
  const source = { id: "s1", name: "Chase", column_map: {} };
  const summary = {
    total: 40,
    matched: 5,
    unreviewed: 35,
    ignored: 0,
    unreviewed_spend_cents: 0,
  };

  it("a failed rows read is not 'Nothing left to review'", async () => {
    mocks.fetchSources.mockResolvedValue([source]);
    mocks.fetchSummary.mockResolvedValue(summary);
    mocks.fetchRowsPage.mockImplementation(boom);
    await render(<StatementImportCard />);
    expect(text()).not.toContain("Nothing left to review");
    expect(text()).toContain("Couldn't load your statement");
  });

  it("asks for one page of 30 and says how many there are", async () => {
    mocks.fetchSources.mockResolvedValue([source]);
    mocks.fetchSummary.mockResolvedValue(summary);
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      source_id: "s1",
      posted_on: "2026-09-01",
      amount_cents: -1000,
      description: `Row ${i}`,
      status: "unreviewed",
      matched_expense_id: null,
      ignored_reason: null,
    }));
    mocks.fetchRowsPage.mockResolvedValue({ rows, total: 35 });
    await render(<StatementImportCard />);
    expect(mocks.fetchRowsPage).toHaveBeenCalledWith("s1", "unreviewed", 30);
    expect(text()).toContain("Showing 30 of 35");
  });
});

describe("PnlPage", () => {
  it("a failed prior read shows no $0 comparison", async () => {
    mocks.fetchLedgerEntries
      .mockResolvedValueOnce([])
      .mockImplementationOnce(boom);
    mocks.fetchReviewQueue.mockResolvedValue([]);
    await render(<PnlPage />);
    expect(text()).toContain("Comparison unavailable");
    expect(text()).not.toContain("compared with");
  });
});

describe("MileageLogCard", () => {
  it("a failed read is an error, not an empty log", async () => {
    mocks.fetchMileageSummary.mockImplementation(boom);
    mocks.fetchTrips.mockImplementation(boom);
    await render(<MileageLogCard />);
    expect(text()).toContain("Couldn't load your mileage log");
    expect(text()).not.toContain("No trips logged");
  });
});

describe("HomeOfficeCard", () => {
  it("a failed read hides the form, so nothing can save over real answers", async () => {
    mocks.fetchHomeOfficeYear.mockImplementation(boom);
    await render(<HomeOfficeCard />);
    expect(text()).toContain("Couldn't load your home office answers");
    for (const b of [...buttons("Save"), ...buttons("I do not have one")]) {
      expect(b.disabled).toBe(true);
    }
  });

  it("a successful read enables Save", async () => {
    mocks.fetchHomeOfficeYear.mockResolvedValue(null);
    await render(<HomeOfficeCard />);
    const save = buttons("Save")[0];
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(false);
  });
});

describe("TaxSetupPage change history", () => {
  it("a failed history read says so rather than vanishing", async () => {
    mocks.fetchTaxProfileChanges.mockImplementation(boom);
    await render(<TaxSetupPage />);
    expect(text()).toContain("Couldn't load your change history");
  });
});

describe("FinancesPage Net After Overhead", () => {
  it("a failed overhead read prints no 'minus $0.00'", async () => {
    mocks.fetchOperatingExpensesTotal.mockImplementation(boom);
    await render(<FinancesPage />);
    expect(text()).toContain("Couldn't load your expenses");
    expect(text()).not.toContain("minus $0.00");
  });

  it("a successful overhead read prints the figure", async () => {
    mocks.fetchOperatingExpensesTotal.mockResolvedValue(100);
    await render(<FinancesPage />);
    expect(text()).toContain("minus $100.00");
  });
});
