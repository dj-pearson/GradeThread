// A2 (US-3217 rule): a failed analytics read must look like a failure with a
// Retry button, never like "nothing to report". Three shapes are covered: the
// scorecard (which used to render nothing), the price curve (which used to say
// "No sales to draw yet") and a sub-card (source yield, which used to vanish).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { buttonByText, mount, settle, type Mounted } from "@/test/helpers/mount";

const fail = { scorecard: true, curve: true, sourceYield: true };
const calls = { scorecard: 0, curve: 0, sourceYield: 0 };

vi.mock("@/lib/seller-scorecard", async (orig) => ({
  ...(await orig<typeof import("@/lib/seller-scorecard")>()),
  fetchSellerScorecard: vi.fn(async () => {
    calls.scorecard += 1;
    if (fail.scorecard) throw new Error("boom");
    const { EMPTY_SCORECARD } = await import("@/lib/seller-scorecard");
    return EMPTY_SCORECARD;
  }),
}));
vi.mock("@/lib/condition-price-curve", async (orig) => ({
  ...(await orig<typeof import("@/lib/condition-price-curve")>()),
  fetchConditionPriceCurve: vi.fn(async () => {
    calls.curve += 1;
    if (fail.curve) throw new Error("boom");
    const { EMPTY_CURVE } = await import("@/lib/condition-price-curve");
    return EMPTY_CURVE;
  }),
}));
vi.mock("@/lib/flipdesk-analytics-server", () => ({
  fetchSellThrough: vi.fn(async () => []),
  fetchGradingRoi: vi.fn(async () => []),
  fetchGradingRoiSummary: vi.fn(async () => null),
}));
vi.mock("@/lib/source-yield", async (orig) => ({
  ...(await orig<typeof import("@/lib/source-yield")>()),
  fetchSourceYield: vi.fn(async () => {
    calls.sourceYield += 1;
    if (fail.sourceYield) throw new Error("boom");
    const { EMPTY_SOURCE_YIELD } = await import("@/lib/source-yield");
    return EMPTY_SOURCE_YIELD;
  }),
}));

const { SellerScorecardCard } = await import(
  "@/components/flipdesk/seller-scorecard-card"
);
const { PriceCurveReport } = await import(
  "@/components/flipdesk/price-curve-report"
);
const { SourceYieldCard } = await import("@/components/flipdesk/sourcing-section");

let m: Mounted | null = null;

beforeEach(() => {
  fail.scorecard = fail.curve = fail.sourceYield = true;
  calls.scorecard = calls.curve = calls.sourceYield = 0;
  useAuthStore.setState({
    user: { id: "11111111-1111-4111-8111-111111111111" } as never,
    activeWorkspaceOwnerId: null,
  });
});
afterEach(() => {
  m?.unmount();
  m = null;
});

async function retryClears(key: keyof typeof fail) {
  fail[key] = false;
  const retry = buttonByText(m!.container, "Retry");
  expect(retry).toBeTruthy();
  await act(async () => retry!.click());
  await settle();
  expect(calls[key]).toBe(2);
  expect(m!.container.textContent).not.toContain("Couldn't load this.");
}

describe("analytics cards show an error, not an empty state (A2)", () => {
  it("scorecard: error row with Retry", async () => {
    m = mount(h(SellerScorecardCard, { periodStart: null }));
    await settle();
    expect(m.container.querySelector('[role="alert"]')).toBeTruthy();
    expect(m.container.textContent).toContain("Couldn't load this.");
    await retryClears("scorecard");
  });

  it("scorecard: holds a skeleton while loading instead of nothing", async () => {
    fail.scorecard = false;
    m = mount(h(SellerScorecardCard, { periodStart: null }));
    // Before the query settles.
    expect(m.container.textContent).toContain("Loading your scorecard");
    await settle();
  });

  it("price curve: error row, not 'No sales to draw yet'", async () => {
    m = mount(h(PriceCurveReport, { periodStart: null }));
    await settle();
    expect(m.container.textContent).toContain("Couldn't load this.");
    expect(m.container.textContent).not.toContain("No sales to draw yet");
    // The filters stay on screen so the seller can change them.
    expect(
      m.container.querySelector('[aria-label="Filter the curve by brand"]'),
    ).toBeTruthy();
    await retryClears("curve");
    expect(m.container.textContent).toContain("No sales to draw yet");
  });

  it("sub-card (source yield): error row instead of vanishing", async () => {
    m = mount(h(SourceYieldCard, { periodStart: null }));
    await settle();
    expect(m.container.textContent).toContain("Source yield");
    expect(m.container.textContent).toContain("Couldn't load this.");
    await retryClears("sourceYield");
    // A successful empty result still renders nothing.
    expect(m.container.textContent).toBe("");
  });
});
