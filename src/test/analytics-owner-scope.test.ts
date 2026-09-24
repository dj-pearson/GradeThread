// Migration 00836: the FlipDesk Analytics RPCs read ONE workspace, the one on
// screen.
//
// The invoker RPCs read items_full / listings, and RLS admits every workspace
// the caller belongs to, so a seller who is also a member elsewhere saw both
// blended. seller_scorecard and community_benchmarks built their "you" figures
// from auth.uid(), so a member inside an owner's workspace saw their own. Each
// now takes p_owner_id. These cases pin that every web fetcher SENDS it, to the
// right function name; the callers pass activeWorkspaceOwnerId ?? user.id
// (analytics-owner-scope-callers.test.tsx). The SQL half is proved against a
// real Postgres by scripts/check-analytics-owner-scope.mjs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: { you: {} }, error: null });
    },
  },
}));

const { fetchSellThrough, fetchGradingRoi, fetchGradingRoiSummary } = await import(
  "@/lib/flipdesk-analytics-server"
);
const { fetchReturnReduction } = await import("@/lib/flipdesk-returns-analytics");
const { fetchSellerScorecard } = await import("@/lib/seller-scorecard");
const { fetchCommunityBenchmarks } = await import("@/lib/community-benchmarks");

beforeEach(() => {
  rpcCalls.length = 0;
});

const OWNER = "owner-b";

// [what, the call, the function it must reach]
const CASES: [string, () => Promise<unknown>, string][] = [
  ["sell-through", () => fetchSellThrough("brand", null, OWNER), "flipdesk_sell_through"],
  ["grading ROI buckets", () => fetchGradingRoi(null, OWNER), "flipdesk_grading_roi"],
  ["grading ROI headline", () => fetchGradingRoiSummary(null, OWNER), "flipdesk_grading_roi_summary"],
  // v2: v1 stays for the iOS app and has no owner argument.
  ["returns", () => fetchReturnReduction(null, OWNER), "flipdesk_return_reduction_v2"],
  ["scorecard", () => fetchSellerScorecard(null, OWNER), "seller_scorecard"],
  // v2: v1 stays for the iOS and Android apps.
  ["community benchmarks", () => fetchCommunityBenchmarks(null, OWNER), "community_benchmarks_v2"],
];

describe("every Analytics fetcher names the workspace on screen (00836)", () => {
  for (const [what, call, fn] of CASES) {
    it(`${what}: calls ${fn} with p_owner_id`, async () => {
      await call();
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0]?.fn).toBe(fn);
      expect(rpcCalls[0]?.args.p_owner_id).toBe(OWNER);
    });
  }
});
