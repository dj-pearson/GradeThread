// The Scheduled drops page, mounted against a stubbed drops read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScheduledDropRow } from "@/hooks/use-scheduled-drops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  rows: [] as ScheduledDropRow[],
  isFetching: false,
  listingsReads: 0,
  itemReads: 0,
};

function builder(table: string) {
  if (table === "listings") state.listingsReads += 1;
  if (table === "inventory_items") state.itemReads += 1;
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order", "limit", "gte", "is", "lt"]) {
    b[m] = () => b;
  }
  b.then = (res: (v: unknown) => void) => res({ data: [], error: null });
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn((t: string) => builder(t)) },
}));

vi.mock("@/hooks/use-scheduled-drops", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scheduled-drops")>()),
  useScheduledDrops: () => ({
    // A background refetch keeps isLoading false; only isFetching flips.
    data: { rows: state.rows, truncated: false, limit: 500 },
    isLoading: false,
    isError: false,
    isFetching: state.isFetching,
    refetch: vi.fn(),
  }),
  useRescheduleDrop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelDrop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useShiftDrops: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ role: "owner", can: () => true }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "u1" }, activeWorkspaceOwnerId: null }),
}));

vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));

const { FlipdeskScheduledDropsPage } = await import("@/pages/flipdesk/scheduled-drops");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  state.rows = [];
  state.isFetching = false;
  state.listingsReads = 0;
  state.itemReads = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  client = null;
});

function row(id: string, msFromNow: number, extra: Partial<ScheduledDropRow> = {}): ScheduledDropRow {
  return {
    id,
    inventory_item_id: `item-${id}`,
    listing_title: `Drop ${id}`,
    listing_price: 25,
    scheduled_publish_at: new Date(Date.now() + msFromNow).toISOString(),
    promo_opt_out: null,
    promo_rate_pct: null,
    publish_error: null,
    publish_failed_at: null,
    publish_attempts: 0,
    publish_claimed_at: null,
    synced_to_ebay_at: null,
    item_title: null,
    ...extra,
  } as ScheduledDropRow;
}

let client: QueryClient | null = null;

/** Mounts the page, or re-renders the mounted one with the current state. */
async function render() {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter>
          <FlipdeskScheduledDropsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Let any secondary query settle.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("stuck drops lead the page (SD-4)", () => {
  it("lists an overdue drop in the strip and under Past due, not Upcoming", async () => {
    state.rows = [row("late", -60 * 60_000), row("soon", 2 * 3_600_000)];
    await render();
    const strip = document.querySelector('[data-testid="drops-attention-list"]');
    expect(strip?.querySelectorAll("li")).toHaveLength(1);
    expect(strip?.textContent).toContain("Drop late");
    expect(document.body.textContent).toContain("Needs attention (1)");
    const past = document.querySelector('[data-testid="drops-past-list"]');
    expect(past?.textContent).toContain("Drop late");
    const upcoming = document.querySelector('[data-testid="drops-upcoming-list"]');
    expect(upcoming?.textContent).toContain("Drop soon");
    expect(upcoming?.textContent).not.toContain("Drop late");
  });

  it("names the overdue state in the day cell's accessible name", async () => {
    // An hour ago may be yesterday near midnight, and in another month; the
    // cell only exists in the grid for the month on screen.
    const late = row("late", -60 * 60_000);
    state.rows = [late];
    await render();
    const sameMonth =
      new Date(late.scheduled_publish_at).getMonth() === new Date().getMonth();
    if (!sameMonth) {
      const prev = document.querySelector<HTMLButtonElement>('button[aria-label="Previous month"]')!;
      await act(async () => prev.click());
    }
    const cells = Array.from(document.querySelectorAll('[role="gridcell"][aria-label]'));
    const labelled = cells.filter((c) => c.getAttribute("aria-label")!.includes("overdue"));
    expect(labelled).toHaveLength(1);
  });
});

describe("one read, no title waterfall (SD-8)", () => {
  it("reads no inventory_items rows and names a drop from the embedded title", async () => {
    state.rows = [row("a", 3 * 3_600_000, { listing_title: null, item_title: "Levi's 501" })];
    await render();
    expect(state.itemReads).toBe(0);
    expect(document.body.textContent).toContain("Levi's 501");
  });

  it("keeps the grid mounted through a refetch after a row goes away", async () => {
    state.rows = [row("a", 3 * 3_600_000), row("b", 4 * 3_600_000)];
    await render();
    expect(document.querySelector('[role="grid"]')).not.toBeNull();
    state.rows = [state.rows[0]!];
    state.isFetching = true;
    await render();
    expect(document.querySelector('[role="grid"]')).not.toBeNull();
    expect(document.querySelector(".animate-spin.border-t-transparent")).toBeNull();
  });
});
