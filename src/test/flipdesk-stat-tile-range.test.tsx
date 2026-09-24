import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlipdeskStatSoldWidget } from "@/components/dashboard/widgets/flipdesk-stat-sold";
import { FlipdeskStatNetWidget } from "@/components/dashboard/widgets/flipdesk-stat-net";
import { FlipdeskStatListedWidget } from "@/components/dashboard/widgets/flipdesk-stat-listed";
import { OVERVIEW_RANGES, type OverviewRangeId } from "@/lib/overview-range";
import { resolveSoldWindow } from "@/pages/flipdesk/listings-url-state";
import { matchesSoldFilter } from "@/pages/flipdesk/listings-filter";
import { listingPageArgs } from "@/pages/flipdesk/listings-page-queries";
import { EMPTY_QUERY } from "@/lib/item-filter";

// DASH-10: stat tiles open the list for the same window they counted, and a
// range change keeps the previous number on screen while the new one loads.

const rpc = vi.hoisted(() => ({
  resolvers: new Map<string, (v: unknown) => void>(),
  calls: [] as Array<{ p_from: string | null }>,
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: "u1" } }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (_name: string, args: { p_from: string | null }) => {
      rpc.calls.push(args);
      return new Promise((resolve) => {
        rpc.resolvers.set(String(rpc.calls.length), resolve);
      });
    },
  },
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rpc.resolvers.clear();
  rpc.calls = [];
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

async function render(node: React.ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    )
  );
}

async function answer(call: number, data: Record<string, unknown>) {
  await act(async () => {
    rpc.resolvers.get(String(call))!({ data, error: null });
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("stat tile links carry the window", () => {
  for (const { id } of OVERVIEW_RANGES) {
    it(`Sold and Net link to the Sold tab with window=${id}`, async () => {
      for (const Widget of [FlipdeskStatSoldWidget, FlipdeskStatNetWidget]) {
        client.clear();
        rpc.resolvers.clear();
        rpc.calls = [];
        await render(<Widget size="sm" surface="flipdesk" range={id} />);
        await answer(1, { soldInRange: 3, grossInRange: 90, netInRange: 40 });
        await vi.waitFor(() => expect(container.querySelector("a")).not.toBeNull());
        const href = container.querySelector("a")!.getAttribute("href")!;
        expect(href).toBe(`/dashboard/flipdesk/items?tab=sold&window=${id}`);
        // The Sold tab must understand the value the tile sends.
        expect(resolveSoldWindow(id)).toBe(id);
      }
    });
  }

  it("Listed says it opens every listed item, since the list cannot apply the window", async () => {
    await render(<FlipdeskStatListedWidget size="sm" surface="flipdesk" range="d30" />);
    await answer(1, { listedInRange: 7 });
    await vi.waitFor(() => expect(container.textContent).toContain("See all listed"));
  });
});

describe("the Sold tab understands d90", () => {
  const NOW = Date.parse("2026-09-23T12:00:00Z");
  const row = (daysAgo: number) =>
    ({ sale_date: new Date(NOW - daysAgo * 86_400_000).toISOString() }) as never;

  it("resolveSoldWindow('d90') is d90", () => {
    expect(resolveSoldWindow("d90")).toBe("d90");
  });

  it("matches sales in the last 90 days only", () => {
    expect(matchesSoldFilter(row(80), "d90", NOW)).toBe(true);
    expect(matchesSoldFilter(row(100), "d90", NOW)).toBe(false);
  });

  it("sends d90 to the RPC as a sale_date rule, since p_sold_filter does not know it", () => {
    const args = listingPageArgs(
      {
        tab: "sold",
        search: "",
        soldFilter: "d90",
        unlistedFilter: "all",
        filterQuery: EMPTY_QUERY,
        columnSort: null,
        sortPreset: "default",
        agedThresholdDays: 30,
      } as never,
      new Date(NOW),
    );
    expect(args.p_sold_filter).toBe("all");
    expect(args.p_filter.rules).toEqual([
      expect.objectContaining({
        field: "sale_date",
        op: "gte",
        value: new Date(NOW - 90 * 86_400_000).toISOString(),
      }),
    ]);
  });
});

describe("range changes keep the previous value", () => {
  it("keeps the old number rendered, dimmed, while the new range loads", async () => {
    await render(<FlipdeskStatSoldWidget size="sm" surface="flipdesk" range="d7" />);
    await answer(1, { soldInRange: 11, grossInRange: 10, netInRange: 1 });
    await vi.waitFor(() => expect(container.textContent).toContain("11"));

    await render(
      <FlipdeskStatSoldWidget size="sm" surface="flipdesk" range={"d30" as OverviewRangeId} />,
    );
    // The d30 call is in flight: the d7 number stays, marked as stale.
    expect(rpc.calls.length).toBe(2);
    expect(container.textContent).toContain("11");
    expect(container.querySelector('a[aria-busy="true"]')).not.toBeNull();

    await answer(2, { soldInRange: 42, grossInRange: 10, netInRange: 1 });
    await vi.waitFor(() => expect(container.textContent).toContain("42"));
    expect(container.querySelector('a[aria-busy="true"]')).toBeNull();
  });
});
