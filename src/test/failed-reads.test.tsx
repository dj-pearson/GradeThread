import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSetItemAspect } from "@/hooks/use-ebay";
import { fetchPayoutBreakdown } from "@/lib/payout-breakdown";
import { ApiOverageCard } from "@/components/api/api-overage-card";
import { FilingWalkthroughCard } from "@/components/finances/filing-walkthrough-card";

type Request = { table: string; operation: string; range?: [number, number]; values?: unknown };
type Result = { data: unknown; error: unknown; count?: number };
const mocks = vi.hoisted(() => ({
  read: vi.fn<(request: Request) => Result>(),
  review: vi.fn<() => Promise<number>>(),
  profile: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const request: Request = { table, operation: "read" };
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "gt", "gte", "lt", "lte", "is", "in", "order", "limit", "maybeSingle", "single"]) {
        chain[method] = () => chain;
      }
      chain.update = (values: unknown) => { request.operation = "update"; request.values = values; return chain; };
      chain.range = (from: number, to: number) => { request.range = [from, to]; return chain; };
      chain.then = (resolve: (value: Result) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve().then(() => mocks.read(request)).then(resolve, reject);
      return chain;
    },
  },
}));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (s: { user: { id: string } }) => unknown) => select({ user: { id: "owner" } }) }));
vi.mock("@/lib/books-review", () => ({ fetchReviewCount: () => mocks.review() }));
vi.mock("@/lib/mileage", () => ({ fetchMileageSummary: async () => null, fetchVehicleYear: async () => null }));
vi.mock("@/lib/home-office", () => ({ fetchHomeOfficeYear: async () => null }));
vi.mock("@/lib/form-1099k", () => ({ fetchPlatformsWithSales: async () => [], fetchForms: async () => [], fetchBridge: vi.fn() }));
vi.mock("@/lib/estimated-tax", () => ({ duePeriods: () => [], fetchPayments: async () => [] }));
vi.mock("@/lib/period-close", () => ({ fetchClosedPeriods: async () => [] }));
vi.mock("@/lib/tax-profile", async (original) => ({
  ...await original<typeof import("@/lib/tax-profile")>(),
  fetchTaxProfile: () => mocks.profile(),
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.read.mockReset().mockReturnValue({ data: [], error: null, count: 0 });
  mocks.review.mockReset().mockResolvedValue(0);
  mocks.profile.mockReset().mockResolvedValue({ entity_type: "sole_proprietor", accounting_method: "cash", has_ein: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
async function render(element: React.ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>));
}
async function settle(check: () => void) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await vi.waitFor(check);
}

describe("failed reads cannot become writes or financial facts", () => {
  it.each(["listing", "base", "inventory"])("refuses an aspect write after the %s read fails", async (failure) => {
    const error = { message: "Database unavailable" };
    mocks.read.mockImplementation(({ table }) => {
      if (table === "listings") return failure === "listing"
        ? { data: null, error }
        : { data: failure === "base" ? { id: "listing", item_specifics_override: null } : null, error: null };
      return { data: null, error };
    });
    let mutation!: ReturnType<typeof useSetItemAspect>;
    function Probe() { mutation = useSetItemAspect(); return null; }
    await render(<Probe />);
    await act(async () => {
      await expect(mutation.mutateAsync({ itemId: "item", aspect: "Color", values: ["Blue"] })).rejects.toEqual(error);
    });
    expect(mocks.read.mock.calls.some(([r]) => r.operation === "update")).toBe(false);
  });

  it("preserves the existing aspects on a successful edit", async () => {
    mocks.read.mockImplementation(({ table, operation }) => ({
      data: operation === "update" ? null : table === "listings" ? { id: "listing", item_specifics_override: { Brand: ["Levi's"] } } : null,
      error: null,
    }));
    let mutation!: ReturnType<typeof useSetItemAspect>;
    function Probe() { mutation = useSetItemAspect(); return null; }
    await render(<Probe />);
    await act(async () => { await mutation.mutateAsync({ itemId: "item", aspect: "Color", values: ["Blue"] }); });
    expect(mocks.read.mock.calls.find(([r]) => r.operation === "update")?.[0].values)
      .toEqual({ item_specifics_override: { Brand: ["Levi's"], Color: ["Blue"] } });
  });

  it("rejects a payout whose header lookup failed, while allowing a genuinely absent header", async () => {
    const error = { message: "Header unavailable" };
    mocks.read.mockImplementation(({ table }) => table === "ebay_payouts" ? { data: null, error } : { data: [], error: null });
    await expect(fetchPayoutBreakdown("owner", "payout")).rejects.toEqual(error);
    mocks.read.mockReturnValue({ data: null, error: null });
    expect((await fetchPayoutBreakdown("owner", "payout")).headerAmount).toBeNull();
  });

  it("reads every payout sale even when the server clips each page", async () => {
    mocks.read.mockImplementation(({ table, range }) => ({
      data: table === "sale_pnl" && (range?.[0] ?? 0) < 3
        ? [{ sale_id: String(range![0]), inventory_item_id: null, sale_date: "2026-01-01", revenue: 10, fees: 1, costs: 0, cost_basis: 2, net: 7 }]
        : table === "ebay_payouts" ? null : [],
      error: null,
    }));
    const result = await fetchPayoutBreakdown("owner", "payout");
    expect(result.totals.items).toBe(3);
    expect(result.totals.revenue).toBe(30);
    expect(mocks.read.mock.calls.filter(([r]) => r.table === "sale_pnl").map(([r]) => r.range?.[0])).toEqual([0, 1, 2, 3]);
  });

  it("rejects a payout if a later page fails instead of returning a partial total", async () => {
    mocks.read.mockImplementation(({ range }) => range?.[0] === 0
      ? { data: [{ sale_id: "one" }], error: null }
      : { data: null, error: { message: "Second page failed" } });
    await expect(fetchPayoutBreakdown("owner", "payout")).rejects.toEqual({ message: "Second page failed" });
  });

  it("shows an unavailable credit balance and recovers through Retry", async () => {
    mocks.read.mockReturnValue({ data: null, error: { message: "Offline" } });
    await render(<ApiOverageCard />);
    await settle(() => expect(container.textContent).toContain("Balance: Unavailable"));
    expect(container.textContent).not.toContain("Balance: 0 credits");
    mocks.read.mockReturnValue({ data: { balance: 27 }, error: null });
    await act(async () => (container.querySelector('[role="alert"] button') as HTMLButtonElement).click());
    await settle(() => expect(container.textContent).toContain("Balance: 27 credits"));
  });

  it("shows zero credits when the successful read finds no wallet", async () => {
    mocks.read.mockReturnValue({ data: null, error: null });
    await render(<ApiOverageCard />);
    await settle(() => expect(container.textContent).toContain("Balance: 0 credits"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["review", "snapshots", "receipts", "profile", "profile-exists"])("withholds filing advice when %s cannot be checked", async (failure) => {
    if (failure === "review") mocks.review.mockRejectedValue(new Error("Offline"));
    if (failure === "profile") mocks.profile.mockRejectedValue(new Error("Offline"));
    const tables: Record<string, string> = { snapshots: "inventory_snapshots", receipts: "flipdesk_expenses", "profile-exists": "tax_profiles" };
    const failedTable = tables[failure];
    mocks.read.mockImplementation(({ table }) => table === failedTable
      ? { data: null, error: { message: "Offline" } }
      : { data: [], error: null, count: 0 });
    await render(<FilingWalkthroughCard />);
    await settle(() => expect(container.textContent).toContain("Completion and filing advice are unavailable"));
    expect(container.textContent).not.toContain("What you end up filing");
    expect(container.textContent).not.toContain("Nothing left on the list");
  });
});
