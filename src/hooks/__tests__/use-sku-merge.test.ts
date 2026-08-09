import { describe, it, expect } from "vitest";
import {
  composeRetryOutcome,
  composeSurvivorView,
  mergeOverridesToItemUpdate,
} from "@/hooks/use-sku-merge";
import { rowToMergeValues } from "@/lib/merge-values";
import type { InventoryItemRow } from "@/types/database";

// US-2445: a duplicate-SKU collision was silently dropping the seller's edits.
//
// The composer saves inventory_items FIRST and returns on the collision, so the
// `listings` update carrying `listing_title` never ran at all. The merge dialog
// then read the survivor back OUT OF THE DATABASE — which the rolled-back save
// had left untouched — so "This item" showed the ORIGINAL title, and the only
// edits carried forward were the two fields a hand-written `extraPatch` happened
// to name. The seller pushed to eBay and got the old title; the synced sheet
// agreed with eBay, so nothing looked broken.
//
// The fix re-runs the whole save after the merge frees the SKU. These are the
// two decisions that fix turns on.

const ROW = {
  id: "item-1",
  title: "Vintage Denim Jacket",
  container: "Bin A",
  brand: "Levi's",
  style: null,
  size: "M",
  color: null,
  material: null,
  description: null,
  condition_notes: null,
  item_category: null,
  sourced_by: null,
  status: "drafted",
  acquired_date: null,
  acquired_price: null,
  target_price: null,
  comp_set: [],
  measurements: null,
} as unknown as InventoryItemRow;

describe("composeSurvivorView (what the dialog calls 'This item')", () => {
  it("overlays the patch the collided save was carrying", () => {
    const view = composeSurvivorView(ROW, {
      container: "Bin Q",
      brand: "Wrangler",
    });
    const values = rowToMergeValues(view);
    expect(values.container).toBe("Bin Q");
    expect(values.brand).toBe("Wrangler");
    // Untouched columns still come from the row — the overlay is the pending
    // edit, not a replacement record.
    expect(values.size).toBe("M");
  });

  it("leaves the row alone when there is no pending patch", () => {
    // An absent recovery is not an empty edit: nothing may imply we checked for
    // pending changes and found none.
    expect(composeSurvivorView(ROW, null)).toBe(ROW);
    expect(composeSurvivorView(ROW, undefined)).toBe(ROW);
  });

  it("shows the seller's pending value rather than the stale database one", () => {
    // The bug, stated as a test: without the overlay this reads the old title.
    const stale = rowToMergeValues(ROW).title;
    const fresh = rowToMergeValues(
      composeSurvivorView(ROW, { title: "Vintage Levi's Trucker Jacket" }),
    ).title;
    expect(stale).toBe("Vintage Denim Jacket");
    expect(fresh).toBe("Vintage Levi's Trucker Jacket");
  });
});

describe("composeRetryOutcome (did the re-run save actually save?)", () => {
  it("treats a FALSY id as a failure, not a success", () => {
    // Both composer saves catch their own errors and `return null`. Awaiting one
    // and watching only for a throw is how a dropped edit becomes a confident
    // "your edits saved" toast — the precise failure this story exists for.
    expect(composeRetryOutcome({ attempted: true, savedId: null })).toEqual({
      state: "failed",
      reason: "the save reported a failure of its own",
    });
    expect(composeRetryOutcome({ attempted: true, savedId: undefined }).state).toBe(
      "failed",
    );
  });

  it("reports a thrown error with its message", () => {
    expect(
      composeRetryOutcome({ attempted: true, error: "row level security" }),
    ).toEqual({ state: "failed", reason: "row level security" });
  });

  it("is three states, never two", () => {
    // `none` must not collapse into either neighbour: read as saved it claims
    // edits were restored that were never attempted; read as failed it alarms
    // the seller about a save that was never owed.
    expect(composeRetryOutcome({ attempted: false }).state).toBe("none");
    expect(composeRetryOutcome({ attempted: true, savedId: "listing-9" }).state).toBe(
      "saved",
    );
    const states = new Set(
      [
        composeRetryOutcome({ attempted: false }),
        composeRetryOutcome({ attempted: true, savedId: "x" }),
        composeRetryOutcome({ attempted: true, savedId: null }),
      ].map((r) => r.state),
    );
    expect(states.size).toBe(3);
  });

  it("only a real id is a success", () => {
    expect(composeRetryOutcome({ attempted: true, savedId: "" }).state).toBe(
      "failed",
    );
  });
});

describe("mergeOverridesToItemUpdate (the dialog's explicit choices)", () => {
  it("writes only the fields taken from the other record", () => {
    const patch = mergeOverridesToItemUpdate({ brand: "Wrangler" }, "Fallback");
    expect(patch).toEqual({ brand: "Wrangler" });
    // Everything else keeps the survivor's value, which after the retry is the
    // seller's edit — so an empty override set must write nothing at all.
    expect(mergeOverridesToItemUpdate({}, "Fallback")).toEqual({});
  });

  it("falls back rather than writing an empty title", () => {
    expect(mergeOverridesToItemUpdate({ title: "   " }, "Fallback").title).toBe(
      "Fallback",
    );
  });

  it("keeps an explicit empty string distinct from an absent field", () => {
    // `undefined` means "not chosen" and must not become a null write.
    expect("brand" in mergeOverridesToItemUpdate({}, "F")).toBe(false);
    expect(mergeOverridesToItemUpdate({ brand: "  " }, "F").brand).toBe(null);
  });
});
