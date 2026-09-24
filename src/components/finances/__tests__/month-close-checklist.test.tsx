// Money M14: the close-the-month checklist. "Ready to close" needs all four
// rows LOADED as zero; an errored row says "couldn't check" and blocks it, and
// a plan-gated row says so rather than showing a tick.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function q(over: Record<string, unknown> = {}) {
  return { data: undefined as unknown, isError: false, isLoading: false, error: null, ...over };
}

const s = vi.hoisted(() => ({
  queue: null as unknown,
  conflicts: null as unknown,
  items: null as unknown,
  reviewCount: vi.fn(),
  sales: [] as unknown[],
  salesError: null as unknown,
}));

vi.mock("@/lib/supabase", () => {
  const b: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gte", "lt", "order"]) b[k] = () => b;
  b.range = (from: number) =>
    Promise.resolve(
      s.salesError
        ? { data: null, error: s.salesError }
        : { data: from === 0 ? s.sales : [], error: null },
    );
  return { supabase: { from: () => b } };
});
vi.mock("@/stores/auth-store", () => {
  const st = { user: { id: "u1" } };
  const useAuthStore = (sel?: (x: typeof st) => unknown) => (sel ? sel(st) : st);
  return { useAuthStore };
});
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "u1" }),
}));
vi.mock("@/hooks/use-payouts", () => ({ useReconciliationQueue: () => s.queue }));
vi.mock("@/hooks/use-sync-conflicts", () => ({ useSyncConflicts: () => s.conflicts }));
vi.mock("@/hooks/use-items-full", () => ({ useItemsList: () => s.items }));
vi.mock("@/lib/books-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/books-review")>()),
  fetchReviewCount: s.reviewCount,
}));

const { MonthCloseChecklist } = await import("@/components/finances/month-close-checklist");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <MonthCloseChecklist today={new Date(2026, 8, 15)} />
        </QueryClientProvider>
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
const statuses = () =>
  [...document.querySelectorAll("[data-row-status]")].map((e) => e.getAttribute("data-row-status"));

beforeEach(() => {
  s.queue = q({ data: { queue: [], total: 0, hasMore: false, limit: 100 } });
  s.conflicts = q({ data: { conflicts: [], total: 0, showing: 0, has_more: false } });
  s.items = q({ data: [] });
  s.reviewCount.mockReset();
  s.reviewCount.mockResolvedValue(0);
  s.sales = [];
  s.salesError = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("MonthCloseChecklist", () => {
  it("all four at zero shows 'Ready to close'", async () => {
    await render();
    expect(statuses()).toEqual(["count", "count", "count", "count"]);
    expect(text()).toContain("Ready to close");
    expect(text()).toContain("Close September 2026");
    expect(s.reviewCount).toHaveBeenCalledWith("2026-09-01", "2026-10-01");
  });

  it("an errored row says couldn't check and blocks Ready to close", async () => {
    s.conflicts = q({ isError: true, error: Object.assign(new Error("boom"), { status: 500 }) });
    await render();
    expect(text()).toContain("Couldn't check");
    expect(text()).not.toContain("Ready to close");
    expect(text()).toContain("couldn't be checked");
  });

  it("a 402 row shows the plan note, not a tick", async () => {
    s.queue = q({ isError: true, error: Object.assign(new Error("gated"), { status: 402 }) });
    await render();
    expect(text()).toContain("Locked on your plan");
    expect(text()).not.toContain("Ready to close");
  });

  it("a loading row is never a tick", async () => {
    s.reviewCount.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(statuses()).toContain("loading");
    expect(text()).not.toContain("Ready to close");
  });

  it("counts a completed sale charged over its marketplace's schedule", async () => {
    s.items = q({ data: [{ id: "i1", listing_platform: "poshmark" }] });
    s.sales = [
      {
        id: "s1",
        inventory_item_id: "i1",
        status: "completed",
        sale_price: 100,
        platform_fees: 35,
        payment_processing_fees: 0,
        shipping_collected: 0,
        tax: 0,
        platform_order_ref: null,
      },
    ];
    await render();
    expect(text()).toContain("1 to check");
    expect(text()).not.toContain("Ready to close");
  });

  it("a failed sales read makes the fee row couldn't check", async () => {
    s.salesError = { message: "timeout" };
    await render();
    expect(statuses()[2]).toBe("error");
  });
});
