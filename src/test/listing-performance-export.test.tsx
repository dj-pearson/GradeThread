// A11: the export walks every page of the 200-row-clamped RPC, search waits
// for typing to settle, and a failed read is an error rather than the
// "publish a listing" empty state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { buttonByText, mount, settle, type Mounted } from "@/test/helpers/mount";
import { fetchOffsetPages } from "@/lib/paged-read";

type Args = { p_search: string | null; p_limit: number; p_offset: number };
const pageCalls: Args[] = [];
let TOTAL = 451;
let failPage = false;
const csvs: Array<{ rows: unknown[][] }> = [];

function rowsFor(offset: number, limit: number) {
  // The RPC clamps p_limit to 200, exactly as 00560 does.
  const n = Math.max(0, Math.min(Math.min(limit, 200), TOTAL - offset));
  return Array.from({ length: n }, (_, i) => ({
    id: `l${offset + i}`,
    inventory_item_id: `i${offset + i}`,
    title: `Listing ${offset + i}`,
    listing_url: null,
    listing_price: 10,
    listed_at: "2026-09-01T00:00:00Z",
    views_total: 1,
    watchers_count: 0,
    impressions_7d: 0,
    click_through_rate: null,
    last_metrics_synced_at: null,
    view_trend_7d: null,
    total_count: TOTAL,
  }));
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Args) => {
      if (fn === "flipdesk_listing_performance_page") {
        pageCalls.push(args);
        if (failPage) return { data: null, error: { message: "boom", code: "57014" } };
        return { data: rowsFor(args.p_offset, args.p_limit), error: null };
      }
      return {
        data: [{ total_listings: TOTAL, total_views: 10, avg_ctr: null, stale_count: 0, last_synced_at: null }],
        error: null,
      };
    }),
  },
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => ({ data: null }),
}));
vi.mock("@/hooks/use-repricing", () => ({
  usePerformanceSuggestions: () => ({ data: [] }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => false,
}));
vi.mock("@/components/flipdesk/listing-quality-lift-section", () => ({
  ListingQualityLiftSection: () => null,
}));
vi.mock("@/lib/csv-export", () => ({
  downloadCsv: (_n: string, _h: string[], rows: unknown[][]) => csvs.push({ rows }),
}));

const { FlipdeskListingPerformancePage } = await import(
  "@/pages/flipdesk/listing-performance"
);
const Page = FlipdeskListingPerformancePage as (p: { embedded?: boolean }) => ReactNode;

let m: Mounted | null = null;
beforeEach(() => {
  pageCalls.length = 0;
  csvs.length = 0;
  TOTAL = 451;
  failPage = false;
  useAuthStore.setState({
    user: { id: "11111111-1111-4111-8111-111111111111" } as never,
    activeWorkspaceOwnerId: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
  m?.unmount();
  m = null;
});

describe("fetchOffsetPages", () => {
  it("collects 451 rows from a 200-clamped source in 3 calls", async () => {
    let calls = 0;
    const rows = await fetchOffsetPages(async (offset, limit) => {
      calls += 1;
      const batch = rowsFor(offset, limit);
      return { rows: batch, total: batch[0]?.total_count ?? null };
    }, 200);
    expect(rows).toHaveLength(451);
    expect(calls).toBe(3);
  });
});

describe("Listing performance (A11)", () => {
  it("exports all 451 rows across 3 calls", async () => {
    m = mount(h(Page, { embedded: true }));
    await settle();
    pageCalls.length = 0;
    const btn = m.container.querySelector<HTMLButtonElement>(
      '[aria-label="Export active listing performance as CSV"]',
    );
    await act(async () => btn!.click());
    await settle();
    expect(pageCalls).toHaveLength(3);
    expect(pageCalls.map((c) => c.p_offset)).toEqual([0, 200, 400]);
    expect(csvs[0]!.rows).toHaveLength(451);
  });

  it("typing fast makes one search RPC", async () => {
    m = mount(h(Page, { embedded: true }));
    await settle();
    pageCalls.length = 0;
    const input = m.container.querySelector<HTMLInputElement>(
      '[aria-label="Search active listings by title"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    let typed = "";
    for (const ch of "levis 501") {
      typed += ch;
      await act(async () => {
        setter.call(input, typed);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(pageCalls).toHaveLength(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await settle();
    expect(pageCalls).toHaveLength(1);
    expect(pageCalls[0]!.p_search).toBe("levis 501");
  });

  it("a search with no match says so, with Clear", async () => {
    TOTAL = 0;
    m = mount(h(Page, { embedded: true }));
    await settle();
    const input = m.container.querySelector<HTMLInputElement>(
      '[aria-label="Search active listings by title"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
    });
    await settle();
    expect(m.container.textContent).toContain('No listings match "zzz"');
    expect(buttonByText(m.container, "Clear")).toBeTruthy();
  });

  it("a rejected RPC shows an error, not the publish-a-listing empty state", async () => {
    failPage = true;
    m = mount(h(Page, { embedded: true }));
    await settle();
    expect(m.container.textContent).toContain("Couldn't load your listings");
    expect(m.container.textContent).not.toContain("Publish a listing");
  });
});
