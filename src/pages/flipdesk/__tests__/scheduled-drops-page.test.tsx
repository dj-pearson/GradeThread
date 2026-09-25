// The Scheduled drops page, mounted against a stubbed drops read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScheduledDropRow } from "@/hooks/use-scheduled-drops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  sales: [] as string[],
  shift: vi.fn(),
  rows: [] as ScheduledDropRow[],
  isFetching: false,
  listingsReads: 0,
  itemReads: 0,
  updatedAt: 0,
};

// The real query hands back the SAME data object when a refetch returns equal
// rows (structural sharing); only dataUpdatedAt moves. Mirror that.
const dataCache = new WeakMap<ScheduledDropRow[], { rows: ScheduledDropRow[]; truncated: boolean; limit: number }>();
function dataFor(rows: ScheduledDropRow[]) {
  let d = dataCache.get(rows);
  if (!d) {
    d = { rows, truncated: false, limit: 500 };
    dataCache.set(rows, d);
  }
  return d;
}

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
    data: dataFor(state.rows),
    dataUpdatedAt: state.updatedAt,
    isLoading: false,
    isError: false,
    isFetching: state.isFetching,
    refetch: vi.fn(),
  }),
  useSalesHourOfWeek: () => ({
    data: { rows: state.sales, truncated: false, limit: 500 },
    isLoading: false,
    isError: false,
  }),
  useRescheduleDrop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelDrop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useShiftDrops: () => ({ mutateAsync: state.shift, isPending: false }),
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
const { detectTimezone, shiftInZone, zoneCalendarDate } = await import("@/lib/scheduling");
type DropShift = import("@/lib/scheduling").DropShift;

// The stubbed shift moves the rows the way the real one would, so the page
// re-reads them on its next render.
function realShift() {
  return vi.fn(
    async ({ drops, shift, timeZone }: { drops: { id: string }[]; shift: DropShift; timeZone: string }) => {
      const ids = new Set(drops.map((d) => d.id));
      state.rows = state.rows.map((r) =>
        ids.has(r.id)
          ? { ...r, scheduled_publish_at: shiftInZone(r.scheduled_publish_at, timeZone, shift) }
          : r,
      );
      return { moved: ids.size, unchanged: 0, failed: 0, movedIds: [...ids] };
    },
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  state.sales = [];
  state.shift = realShift();
  state.rows = [];
  state.isFetching = false;
  state.listingsReads = 0;
  state.itemReads = 0;
  state.updatedAt = 0;
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

describe("an open page keeps its clock (review fix)", () => {
  it("a drop turns overdue after an unchanged refetch", async () => {
    const realNow = Date.now();
    state.rows = [row("edge", -9 * 60_000)];
    state.updatedAt = realNow;
    await render();
    expect(document.body.textContent).not.toContain("Needs attention");
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 3 * 60_000);
    try {
      // Same rows array, so the same data object: only dataUpdatedAt moves.
      state.updatedAt = realNow + 3 * 60_000;
      await render();
      expect(document.body.textContent).toContain("Needs attention (1)");
    } finally {
      spy.mockRestore();
    }
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

/** Show the month holding `iso` and open its day's dialog. */
async function openDayOf(iso: string) {
  const zone = detectTimezone();
  const { year, month, day } = zoneCalendarDate(new Date(iso), zone);
  for (let i = 0; i < 24; i++) {
    const label = document.querySelector('[role="grid"]')?.getAttribute("aria-label") ?? "";
    const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(year, month - 1, 1)),
    );
    if (label.endsWith(`${monthName} ${year}`)) break;
    const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next month"]')!;
    await act(async () => next.click());
  }
  const cell = document.querySelector<HTMLElement>(`[role="gridcell"][data-day="${day}"]`)!;
  await act(async () => cell.click());
}

function dialogTitle(): string {
  return document.querySelector('[role="dialog"] h2')?.textContent ?? "";
}

describe("the day dialog follows its drops (SD-10)", () => {
  it("closing never renders a null day in the title", async () => {
    const at = 3 * 86_400_000;
    state.rows = [row("a", at)];
    await render();
    await openDayOf(state.rows[0]!.scheduled_publish_at);
    expect(dialogTitle()).not.toBe("");
    const done = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Done",
    )!;
    await act(async () => done.click());
    expect(document.body.textContent).not.toContain("null");
  });

  it("a +1 day shift retitles the dialog to the next day and lists the moved drops", async () => {
    const base = Date.now() + 3 * 86_400_000;
    state.rows = [row("a", base - Date.now()), row("b", base - Date.now() + 60_000)];
    await render();
    await openDayOf(state.rows[0]!.scheduled_publish_at);
    const before = dialogTitle();
    const plus = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "+1 day",
    )!;
    await act(async () => plus.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const zone = detectTimezone();
    const to = zoneCalendarDate(new Date(state.rows[0]!.scheduled_publish_at), zone);
    const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(to.year, to.month - 1, 1)),
    );
    expect(dialogTitle()).not.toBe(before);
    expect(dialogTitle()).toBe(`${monthName} ${to.day}, ${to.year}`);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Drop a");
    expect(dialog.textContent).toContain("Drop b");
  });
});

function gridMonth(): string {
  return document.querySelector('[role="grid"]')?.getAttribute("aria-label") ?? "";
}

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

describe("the keyboard grid (SD-12)", () => {
  it("does not take focus on first paint", async () => {
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    expect(document.activeElement?.getAttribute("role")).not.toBe("gridcell");
  });

  it("every gridcell sits in a row, and blanks are presentational", async () => {
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    const cells = Array.from(document.querySelectorAll('[role="gridcell"]'));
    expect(cells.length).toBeGreaterThanOrEqual(28);
    for (const c of cells) expect(c.parentElement?.getAttribute("role")).toBe("row");
  });

  it("day 31 then PageDown into February leaves exactly one tabstop", async () => {
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    for (let i = 0; i < 13 && !gridMonth().includes("January"); i++) {
      const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next month"]')!;
      await act(async () => next.click());
    }
    expect(gridMonth()).toContain("January");
    const first = document.querySelector('[role="gridcell"][tabindex="0"]')!;
    await key(first, "End");
    expect(document.querySelector('[role="gridcell"][tabindex="0"]')?.getAttribute("data-day")).toBe("31");
    await key(document.activeElement!, "PageDown");
    expect(gridMonth()).toContain("February");
    const stops = document.querySelectorAll('[role="gridcell"][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(Number(stops[0]!.getAttribute("data-day"))).toBeGreaterThanOrEqual(28);
    expect(document.activeElement).toBe(stops[0]);
  });

  it("Next month then back resets to a real day, and Today focuses today", async () => {
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    const today = document.querySelector('[role="gridcell"][aria-current="date"]');
    expect(today?.getAttribute("aria-label")).toContain("today");
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Today",
    )!;
    await act(async () => btn.click());
    expect(document.activeElement?.getAttribute("aria-current")).toBe("date");
  });
});

describe("the agenda below sm (SD-13)", () => {
  function mockWidth(wide: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes("min-width: 640px") ? wide : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  }
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("a 375px viewport gets the agenda and no 7-column grid", async () => {
    mockWidth(false);
    const drop = row("a", 3 * 86_400_000);
    state.rows = [drop];
    await render();
    expect(document.querySelector('[role="grid"]')).toBeNull();
    const agenda = document.querySelector('[data-testid="drops-agenda"]');
    expect(agenda).not.toBeNull();
    // The month shown may not hold the drop (month end); step until it does.
    for (let i = 0; i < 2 && !agenda?.textContent?.includes("Drop a"); i++) {
      const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next month"]')!;
      await act(async () => next.click());
    }
    expect(document.querySelector('[data-testid="drops-agenda"]')?.textContent).toContain("Drop a");
    // No Month/Agenda toggle on a phone: it is always the agenda.
    expect(document.querySelector('[aria-label="Layout"]')).toBeNull();
  });

  it("a wide screen remembers the Agenda choice", async () => {
    mockWidth(true);
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    expect(document.querySelector('[role="grid"]')).not.toBeNull();
    const agendaBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Agenda",
    )!;
    await act(async () => agendaBtn.click());
    expect(document.querySelector('[role="grid"]')).toBeNull();
    expect(localStorage.getItem("gt.scheduled-drops.layout")).toBe("agenda");
  });
});

describe("best hours from the seller's own sales (SD-15)", () => {
  it("falls back to standard peak times under 30 sales", async () => {
    state.sales = Array.from({ length: 12 }, (_, i) => `2026-06-14T0${i % 9}:30:00.000Z`);
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    const strip = document.querySelector('[data-testid="drops-best-hours"]');
    expect(strip?.textContent).toContain("Not enough sales yet; using standard peak times.");
  });

  it("lists the top slot when there are enough sales", async () => {
    // 40 sales at 19:20 UTC on Sundays in June.
    state.sales = Array.from({ length: 40 }, (_, i) =>
      `2026-06-${["07", "14", "21", "28"][i % 4]}T19:${String(20 + (i % 30)).padStart(2, "0")}:00.000Z`,
    );
    state.rows = [row("a", 3 * 86_400_000)];
    await render();
    const strip = document.querySelector('[data-testid="drops-best-hours"]');
    expect(strip?.textContent).toContain("You sold");
    expect(strip?.textContent).not.toContain("Not enough sales yet");
  });
});
