// Migration 00836, the caller half: every Analytics read passes the workspace
// on screen (activeWorkspaceOwnerId ?? user.id, which is useTenantKey()) to its
// fetcher, and keys its cache on the same value.
//
// A member acting inside an owner's workspace is the case that matters, so the
// store here has the member signed in and the OWNER active. A caller that sent
// user.id would get the member's own (empty) figures, and one that sent nothing
// would get the same from the server's NULL fallback. Both fail below.
//
// Mounted where the component is exported and cheap to render; the three
// report bodies private to analytics.tsx and the Community page are pinned by
// reading their source, since each is one queryFn line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useAuthStore } from "@/stores/auth-store";
import { mount, settle, type Mounted } from "@/test/helpers/mount";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

const seen: { fn: string; owner: unknown }[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock("@/lib/flipdesk-analytics-server", () => ({
  fetchSellThrough: vi.fn(async (_g: string, _p: string | null, owner: string) => {
    seen.push({ fn: "fetchSellThrough", owner });
    return [];
  }),
  fetchGradingRoi: vi.fn(async (_p: string | null, owner: string) => {
    seen.push({ fn: "fetchGradingRoi", owner });
    return [];
  }),
  fetchGradingRoiSummary: vi.fn(async (_p: string | null, owner: string) => {
    seen.push({ fn: "fetchGradingRoiSummary", owner });
    return null;
  }),
}));
vi.mock("@/lib/seller-scorecard", async (orig) => ({
  ...(await orig<typeof import("@/lib/seller-scorecard")>()),
  fetchSellerScorecard: vi.fn(async (_p: string | null, owner: string) => {
    seen.push({ fn: "fetchSellerScorecard", owner });
    const { EMPTY_SCORECARD } = await import("@/lib/seller-scorecard");
    return EMPTY_SCORECARD;
  }),
}));
vi.mock("@/lib/community-benchmarks", async (orig) => ({
  ...(await orig<typeof import("@/lib/community-benchmarks")>()),
  fetchCommunityBenchmarks: vi.fn(async (_p: string | null, owner: string) => {
    seen.push({ fn: "fetchCommunityBenchmarks", owner });
    throw new Error("not under test");
  }),
}));
vi.mock("@/lib/condition-price-curve", async (orig) => ({
  ...(await orig<typeof import("@/lib/condition-price-curve")>()),
  fetchConditionPriceCurve: vi.fn(async () => {
    const { EMPTY_CURVE } = await import("@/lib/condition-price-curve");
    return EMPTY_CURVE;
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "flipdesk_listing_performance_page") return { data: [], error: null };
      return {
        data: [{ total_listings: 0, total_views: 0, avg_ctr: null, stale_count: 0, last_synced_at: null }],
        error: null,
      };
    }),
  },
}));
vi.mock("@/components/flipdesk/defect-cost-section", () => ({
  DefectCostSection: () => null,
}));
vi.mock("@/components/flipdesk/share-outcomes-toggle", () => ({
  ShareOutcomesToggle: () => null,
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

const { GradingRoiReport } = await import("@/pages/flipdesk/analytics");
const { SellerScorecardCard } = await import("@/components/flipdesk/seller-scorecard-card");
const { PriceCurveReport } = await import("@/components/flipdesk/price-curve-report");
const { CommunityInsightsWidget } = await import(
  "@/components/flipdesk/community-insights-widget"
);
const { FlipdeskListingPerformancePage } = await import(
  "@/pages/flipdesk/listing-performance"
);

let m: Mounted | null = null;
beforeEach(() => {
  seen.length = 0;
  rpcCalls.length = 0;
  // The member is signed in; the owner's workspace is on screen.
  useAuthStore.setState({ user: { id: MEMBER } as never, activeWorkspaceOwnerId: OWNER });
});
afterEach(() => {
  m?.unmount();
  m = null;
});

function ownersFor(fn: string): unknown[] {
  return seen.filter((c) => c.fn === fn).map((c) => c.owner);
}

describe("Analytics callers pass the workspace on screen (00836)", () => {
  it("Grading ROI sends the owner to both reads", async () => {
    m = mount(h(GradingRoiReport), "/dashboard/flipdesk/analytics/grading-roi");
    await settle();
    expect(ownersFor("fetchGradingRoi")).toEqual([OWNER]);
    expect(ownersFor("fetchGradingRoiSummary")).toEqual([OWNER]);
  });

  it("the scorecard sends the owner", async () => {
    m = mount(h(SellerScorecardCard, { periodStart: null }));
    await settle();
    expect(ownersFor("fetchSellerScorecard")).toEqual([OWNER]);
  });

  it("the price curve's pickers read sell-through for the owner", async () => {
    m = mount(h(PriceCurveReport, { periodStart: null }));
    await settle();
    const owners = ownersFor("fetchSellThrough");
    expect(owners.length).toBe(2);
    expect(owners.every((o) => o === OWNER)).toBe(true);
  });

  it("the Overview's community widget sends the owner", async () => {
    m = mount(h(CommunityInsightsWidget, {}));
    await settle();
    expect(ownersFor("fetchCommunityBenchmarks")).toEqual([OWNER]);
  });

  it("falls back to the signed-in user in their own workspace", async () => {
    useAuthStore.setState({ user: { id: MEMBER } as never, activeWorkspaceOwnerId: null });
    m = mount(h(SellerScorecardCard, { periodStart: null }));
    await settle();
    expect(ownersFor("fetchSellerScorecard")).toEqual([MEMBER]);
  });

  it("Listing Performance sends the owner to the page and the tiles", async () => {
    const Page = FlipdeskListingPerformancePage as (p: { embedded?: boolean }) => ReactNode;
    m = mount(h(Page, { embedded: true }), "/dashboard/flipdesk/analytics/listings");
    await settle();
    const page = rpcCalls.filter((c) => c.fn === "flipdesk_listing_performance_page");
    const summary = rpcCalls.filter((c) => c.fn === "flipdesk_listing_performance_summary");
    expect(page.length).toBeGreaterThan(0);
    expect(summary.length).toBeGreaterThan(0);
    expect(page.every((c) => c.args.p_owner_id === OWNER)).toBe(true);
    expect(summary.every((c) => c.args?.p_owner_id === OWNER)).toBe(true);
  });
});

// The three report bodies that are private to analytics.tsx, and the
// Community page, which needs the whole filter form to render. One queryFn
// line each; a caller that drops the owner changes exactly that line.
describe("the unexported callers pass tenantKey (00836)", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("sell-through, returns and the condition guarantee in analytics.tsx", () => {
    const src = read("src/pages/flipdesk/analytics.tsx");
    expect(src).toContain("fetchSellThrough(groupKey, periodStart, tenantKey as string)");
    expect(src).toContain("fetchReturnReduction(periodStart, tenantKey as string)");
    expect(src).toContain("fetchReturnReduction(null, tenantKey as string)");
  });

  it("the Community page", () => {
    const src = read("src/pages/flipdesk/community-insights.tsx");
    expect(src).toContain(
      "fetchCommunityBenchmarks(periodStart, tenantKey as string, activeFilters)",
    );
  });

  it("every fetch in those files names an owner, none is left with the old arity", () => {
    // A new call added later with the old two-argument shape is a type error
    // (the owner is a required parameter), so this only has to catch a caller
    // passing something other than tenantKey.
    for (const p of [
      "src/pages/flipdesk/analytics.tsx",
      "src/pages/flipdesk/community-insights.tsx",
      "src/components/flipdesk/price-curve-report.tsx",
      "src/components/flipdesk/seller-scorecard-card.tsx",
      "src/components/flipdesk/community-insights-widget.tsx",
    ]) {
      const calls = read(p).match(
        /fetch(?:SellThrough|GradingRoi|GradingRoiSummary|ReturnReduction|SellerScorecard|CommunityBenchmarks)\([^)]*\)/g,
      ) ?? [];
      expect(calls.length, p).toBeGreaterThan(0);
      for (const c of calls) expect(c, p).toContain("tenantKey as string");
    }
  });
});
