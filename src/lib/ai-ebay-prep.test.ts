import { describe, expect, it } from "vitest";
import {
  EBAY_PREP_FOLLOW_UP_MS,
  planEbayPrepRefresh,
} from "@/lib/ai-ebay-prep";

// US-2270. The regression: the extract's category/aspects pass moved to a
// background task and started returning `ebay: null` + `ebay_pending: true`, but
// both clients still branched on `ebay` being non-null. So the branch that
// refreshes the specifics picker and tells the seller what happened never ran —
// the category WAS resolved and persisted, it just looked like it hadn't.
describe("planEbayPrepRefresh", () => {
  it("refreshes twice and says so while the background pass is running", () => {
    const plan = planEbayPrepRefresh({ ebay: null, ebay_pending: true });

    // Now, because the pass can land before the seller finishes reading...
    expect(plan.refreshNow).toBe(true);
    // ...and again once it has had time to finish.
    expect(plan.refreshAfterMs).toBe(EBAY_PREP_FOLLOW_UP_MS);
    expect(plan.pending).toBe(true);
    expect(plan.message).toMatch(/eBay category/i);
  });

  it("does nothing when there is no pending pass and no inline block", () => {
    expect(planEbayPrepRefresh({ ebay: null })).toEqual({
      refreshNow: false,
      refreshAfterMs: null,
      message: null,
      pending: false,
    });
    expect(planEbayPrepRefresh({ ebay: null, ebay_pending: false }).refreshNow).toBe(
      false,
    );
    // An absent key (an older edge build that doesn't send the flag) is not pending.
    expect(planEbayPrepRefresh({}).pending).toBe(false);
  });

  it("treats an inline ebay block as already done, with no follow-up read", () => {
    const plan = planEbayPrepRefresh({
      ebay: { aspects: { Brand: ["Nike"], Size: ["L"], Colour: [] } },
      // A server that inlines the block has nothing pending, but assert the
      // precedence explicitly: done beats pending.
      ebay_pending: true,
    });
    expect(plan.refreshNow).toBe(true);
    expect(plan.refreshAfterMs).toBeNull();
    expect(plan.pending).toBe(false);
    // Only the FILLED aspects are counted — an empty array isn't a specific.
    expect(plan.message).toBe("eBay category + 2 item specifics filled from photos.");
  });

  it("singularises the count and handles an inline block with nothing filled", () => {
    expect(
      planEbayPrepRefresh({ ebay: { aspects: { Brand: ["Nike"] } } }).message,
    ).toBe("eBay category + 1 item specific filled from photos.");
    expect(planEbayPrepRefresh({ ebay: { aspects: {} } }).message).toBe(
      "eBay category set from photos.",
    );
    expect(planEbayPrepRefresh({ ebay: {} }).message).toBe(
      "eBay category set from photos.",
    );
  });

  it("leaves the follow-up long enough for a ~20s second model call", () => {
    expect(EBAY_PREP_FOLLOW_UP_MS).toBeGreaterThanOrEqual(20_000);
  });
});
