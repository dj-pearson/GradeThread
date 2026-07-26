// US-2174: which notifications mean "listing state may have changed".
//
// The classification is the whole judgement in this hook, and both directions
// are load-bearing:
//   • too NARROW and a sold listing keeps showing as Active until the backstop
//     poll catches it — the bug this story exists to fix;
//   • too WIDE and every grading or billing notification blows away the tenant's
//     whole inventory cache, undoing the caching it is meant to preserve.
import { describe, expect, it } from "vitest";
import { isListingStateNotification } from "@/hooks/use-realtime-listing-state";

describe("isListingStateNotification", () => {
  it("fires for low_stock — the ONLY type actually emitted today", () => {
    // inventory-monitor's notifyStockLevel runs during the eBay sync pull as
    // quantities cross down, so a one-of-a-kind garment selling goes 1 → 0 →
    // stockout → notify. This single case is what makes the hook do anything;
    // if it ever stops firing, the hook is dead and should go with it.
    expect(isListingStateNotification("low_stock")).toBe(true);
  });

  it("fires for the declared-but-unemitted listing types", () => {
    // These are in the edge's NotificationType union but NOTHING emits them as
    // notifications — sale_recorded goes through emitEvent() into `user_events`,
    // a table that isn't in the realtime publication at all. Kept accepted here
    // so wiring one up later needs no change, NOT because they work today.
    for (const type of [
      "sale_recorded",
      "listing_live",
      "item_status_change",
      "return_requested",
    ]) {
      expect(isListingStateNotification(type), type).toBe(true);
    }
  });

  it("does NOT fire for notifications unrelated to listing state", () => {
    // Invalidating on these would drop the whole inventory cache for events that
    // change nothing about a listing.
    for (const type of [
      "grade_complete",
      "grading_submitted",
      "grading_finalized",
      "billing",
      "dispute_update",
      "payout_imported",
      "system",
    ]) {
      expect(isListingStateNotification(type), type).toBe(false);
    }
  });

  it("treats a missing or empty type as not listing-state", () => {
    // A malformed realtime payload must not trigger a tenant-wide invalidation.
    expect(isListingStateNotification(null)).toBe(false);
    expect(isListingStateNotification(undefined)).toBe(false);
    expect(isListingStateNotification("")).toBe(false);
  });

  it("does not match on a prefix or a near-miss", () => {
    expect(isListingStateNotification("sale")).toBe(false);
    expect(isListingStateNotification("sale_recorded_v2")).toBe(false);
    expect(isListingStateNotification("listing")).toBe(false);
  });
});
