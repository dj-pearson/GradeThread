// SD-9: the overview's drops tile must not read "Nothing queued" to a seller
// whose only drops are stuck.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { ScheduledDropRow } from "@/hooks/use-scheduled-drops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = { rows: [] as ScheduledDropRow[], truncated: false };

vi.mock("@/hooks/use-scheduled-drops", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scheduled-drops")>()),
  useScheduledDrops: () => ({
    data: { rows: state.rows, truncated: state.truncated, limit: 500 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

const { FlipdeskScheduledDropsWidget } = await import(
  "@/components/dashboard/widgets/flipdesk-scheduled-drops"
);
const { dropsRefetchInterval, DROPS_REFETCH_MS, DROPS_REFETCH_BUSY_MS } = await import(
  "@/hooks/use-scheduled-drops"
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state.rows = [];
  state.truncated = false;
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
  };
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <FlipdeskScheduledDropsWidget />
      </MemoryRouter>,
    );
  });
}

describe("the drops widget flags stuck drops (SD-9)", () => {
  it("a past-due row reads as needing attention, not Nothing queued", async () => {
    state.rows = [row("late", -60 * 60_000)];
    await render();
    const text = container!.textContent ?? "";
    expect(text).toContain("1 drop needs attention");
    expect(text).not.toContain("Nothing queued");
    expect(container!.querySelector("a")?.getAttribute("href")).toBe(
      "/dashboard/flipdesk/scheduled-drops",
    );
  });

  it("says when the read was capped", async () => {
    state.rows = [row("a", 3_600_000)];
    state.truncated = true;
    await render();
    expect(container!.textContent).toContain("Showing the first 500.");
  });
});

describe("dropsRefetchInterval (SD-9)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  it("polls every minute when nothing is close", () => {
    expect(dropsRefetchInterval([row("a", 0, { scheduled_publish_at: at(3_600_000) })], NOW)).toBe(
      DROPS_REFETCH_MS,
    );
    expect(dropsRefetchInterval(undefined, NOW)).toBe(DROPS_REFETCH_MS);
  });
  it("polls faster when a drop is due within ten minutes or publishing", () => {
    expect(dropsRefetchInterval([row("a", 0, { scheduled_publish_at: at(5 * 60_000) })], NOW)).toBe(
      DROPS_REFETCH_BUSY_MS,
    );
    expect(
      dropsRefetchInterval(
        [row("a", 0, { scheduled_publish_at: at(-3_600_000), publish_claimed_at: at(-60_000) })],
        NOW,
      ),
    ).toBe(DROPS_REFETCH_BUSY_MS);
  });
});
