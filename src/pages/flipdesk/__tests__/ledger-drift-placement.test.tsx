// money.md action 6: where the ledger drift banner sits, and for which period.
//
// This used to be a string match on `<LedgerDriftBanner periodStart={...} />`
// in the page source, which says the JSX is spelled a certain way and nothing
// about what the banner is handed once the page runs. These render the real
// P&L and money overview with the banner stubbed to print its props, so the
// check is on the period the page actually computed, including a custom range
// that ended in the past (the case ledger_reconciliation cannot bound, and
// the reason the banner needs the end date for its copy).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: unknown) => unknown) =>
    select({ user: { id: "seller" }, workspaces: [] }),
}));
vi.mock("@/components/finances/ledger-drift-banner", () => ({
  LedgerDriftBanner: (p: { periodStart: string; periodEnd?: string }) => (
    <p data-drift-banner data-start={p.periodStart} data-end={p.periodEnd ?? ""} />
  ),
}));
vi.mock("@/components/finances/cogs-worksheet-card", () => ({
  CogsWorksheetCard: () => null,
}));
vi.mock("@/components/finances/books-review-card", () => ({
  BooksReviewCard: () => null,
}));
vi.mock("@/lib/ledger", async (original) => ({
  ...(await original<typeof import("@/lib/ledger")>()),
  ensureLedgerBuilt: vi.fn(async () => 0),
  fetchLedgerEntries: vi.fn(async () => []),
}));
vi.mock("@/lib/tax-profile", async (original) => ({
  ...(await original<typeof import("@/lib/tax-profile")>()),
  fetchTaxProfile: vi.fn(async () => null),
}));
vi.mock("@/lib/books-review", async (original) => ({
  ...(await original<typeof import("@/lib/books-review")>()),
  fetchReviewCount: vi.fn(async () => 0),
}));
vi.mock("@/lib/estimated-tax", async (original) => ({
  ...(await original<typeof import("@/lib/estimated-tax")>()),
  fetchPayments: vi.fn(async () => []),
  fetchTaxRateYear: vi.fn(async () => null),
}));

import { PnlPage } from "@/pages/flipdesk/pnl";
import { MoneyOverviewPage } from "@/pages/flipdesk/money-overview";
import { TAX_PROFILE_DEFAULTS, periodRange } from "@/lib/tax-profile";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function render(page: React.ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{page}</MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

async function banner(): Promise<{ start: string; end: string }> {
  const el = await vi.waitFor(() => {
    const found = container.querySelectorAll<HTMLElement>("[data-drift-banner]");
    expect(found.length).toBe(1);
    return found[0]!;
  });
  return { start: el.dataset.start!, end: el.dataset.end! };
}

function setInput(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const thisYear = () =>
  periodRange("year", TAX_PROFILE_DEFAULTS.fiscal_year_start_month, new Date());

describe("LedgerDriftBanner placement", () => {
  it("P&L hands it the period on screen, start and exclusive end", async () => {
    await render(<PnlPage />);
    expect(await banner()).toEqual({ start: thisYear().from, end: thisYear().to });
  });

  it("P&L follows a custom range that ended in the past", async () => {
    await render(<PnlPage />);
    await banner();
    const custom = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Custom",
    )!;
    await act(async () => custom.click());
    await act(async () => {
      setInput("pnl-from", "2025-01-01");
      setInput("pnl-to", "2025-03-31");
    });
    // The input's "to" is inclusive; the range, and so the banner, is not.
    await vi.waitFor(async () =>
      expect(await banner()).toEqual({ start: "2025-01-01", end: "2025-04-01" }),
    );
  });

  it("the money overview hands it the fiscal year", async () => {
    await render(<MoneyOverviewPage />);
    expect(await banner()).toEqual({ start: thisYear().from, end: thisYear().to });
  });
});
