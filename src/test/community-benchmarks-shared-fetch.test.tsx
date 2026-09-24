// A8: the Overview's community widget and the Analytics > Community tab build
// their key from one helper, so the same window is one cache entry and ONE
// cross-seller community_benchmarks call rather than two.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, Fragment, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { mount, settle, type Mounted } from "@/test/helpers/mount";
import type { CommunityBenchmarks } from "@/lib/community-benchmarks";

let rpcCalls = 0;

const EMPTY: CommunityBenchmarks = {
  meta: { minSellers: 5, periodStart: null, generatedAt: "2026-09-24" },
  topBrands: [],
  categories: [],
  trendingCategories: [],
  priceRealization: null,
  timeToSell: null,
  trends: { windows: { d30: null, d90: null, d365: null }, monthly: [] },
  you: {
    listed: 0,
    sold: 0,
    sellThrough: null,
    medianDaysToSell: null,
    medianRealization: null,
    peerComparison: null,
  },
};

vi.mock("@/lib/community-benchmarks", async (orig) => ({
  ...(await orig<typeof import("@/lib/community-benchmarks")>()),
  fetchCommunityBenchmarks: vi.fn(async () => {
    rpcCalls += 1;
    return EMPTY;
  }),
}));

const { CommunityInsightsWidget } = await import(
  "@/components/flipdesk/community-insights-widget"
);
const { FlipdeskCommunityInsightsPage } = await import(
  "@/pages/flipdesk/community-insights"
);

let m: Mounted | null = null;
beforeEach(() => {
  rpcCalls = 0;
  useAuthStore.setState({
    user: { id: "11111111-1111-4111-8111-111111111111" } as never,
    activeWorkspaceOwnerId: null,
  });
});
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("community benchmarks are fetched once for the widget and the tab", () => {
  it("makes one community_benchmarks request for both", async () => {
    m = mount(
      h(
        Fragment,
        null,
        h(CommunityInsightsWidget),
        h(FlipdeskCommunityInsightsPage as (p: { embedded?: boolean }) => ReactNode, { embedded: true }),
      ),
      "/dashboard/flipdesk/analytics/community?preset=12mo",
    );
    await settle();
    expect(rpcCalls).toBe(1);
  });
});
