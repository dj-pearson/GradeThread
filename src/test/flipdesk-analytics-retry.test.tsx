// A1: the Grading ROI error card depends on TWO queries (buckets and the
// headline summary). Retry used to refetch only the buckets, so a failed
// summary left the card on screen forever. This fails the summary once and
// proves one Retry click brings the report back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { buttonByText, mount, settle, type Mounted } from "@/test/helpers/mount";

const calls = { buckets: 0, summary: 0 };
let summaryFailuresLeft = 0;

vi.mock("@/lib/flipdesk-analytics-server", () => ({
  fetchSellThrough: vi.fn(async () => []),
  fetchGradingRoi: vi.fn(async () => {
    calls.buckets += 1;
    return [];
  }),
  fetchGradingRoiSummary: vi.fn(async () => {
    calls.summary += 1;
    if (summaryFailuresLeft > 0) {
      summaryFailuresLeft -= 1;
      throw new Error("statement timeout");
    }
    return {
      graded: { sold: 0, listed: 0, sellThrough: null, medianDaysToSell: null, avgNetProfit: null },
      ungraded: { sold: 0, listed: 0, sellThrough: null, medianDaysToSell: null, avgNetProfit: null },
      meaningful: false,
      daysFaster: null,
      netProfitLift: null,
      sellThroughLift: null,
    };
  }),
}));
vi.mock("@/components/flipdesk/defect-cost-section", () => ({
  DefectCostSection: () => null,
}));
vi.mock("@/components/flipdesk/share-outcomes-toggle", () => ({
  ShareOutcomesToggle: () => null,
}));

const { GradingRoiReport } = await import("@/pages/flipdesk/analytics");

let m: Mounted | null = null;

beforeEach(() => {
  calls.buckets = 0;
  calls.summary = 0;
  useAuthStore.setState({
    user: { id: "11111111-1111-4111-8111-111111111111" } as never,
    activeWorkspaceOwnerId: null,
  });
});
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("Grading ROI retry (A1)", () => {
  it("refetches the failed summary and shows the report after one click", async () => {
    summaryFailuresLeft = 1;
    m = mount(h(GradingRoiReport), "/dashboard/flipdesk/analytics/grading-roi");
    await settle();
    expect(m.container.textContent).toContain("Couldn't load your grading ROI figures");
    expect(m.container.textContent).not.toContain("numbers below");

    const retry = buttonByText(m.container, /Try again/);
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    await settle();

    expect(calls.summary).toBe(2);
    // The healthy query is not refetched just because its sibling failed.
    expect(calls.buckets).toBe(1);
    expect(m.container.textContent).not.toContain("Couldn't load");
    expect(m.container.textContent).toContain("Does grading pay off?");
  });
});
