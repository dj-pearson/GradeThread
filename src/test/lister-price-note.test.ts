// 2026-08-11: what the seller is told about the PRICE after a prefill.
//
// THE BUG, found by running the selector check against the live Poshmark form.
// `fields.price` pointed at `input[data-test="listing-editor-listing-price"],
// input[name="listingPrice"]`, and neither exists on poshmark.com/create-listing —
// the price input lives inside a dialog the seller opens later. So GT.fill found
// nothing, did nothing, returned false, and nobody looked at the return value.
// The run reported `filled: true` and the toast said "review and submit" over a
// listing whose price had never been touched.
//
// It survived because price is not in Poshmark's `required` set, so the probe
// stayed green. A field can be missing without the flow being broken; what it
// cannot be is missing and unmentioned.
//
// The copy IS the fix, so the copy is what gets tested.

import { describe, it, expect } from "vitest";
import { priceNote } from "@/components/flipdesk/listing-kit";

describe("price fill reporting", () => {
  it("says nothing when the price was filled", () => {
    // Silence is correct — there is nothing for the seller to do.
    expect(priceNote({ priceFilled: true })).toBe("");
  });

  it("THE BIG ONE: an unfilled price is named, and says who has to act", () => {
    const note = priceNote({ priceFilled: false });
    expect(note).toMatch(/price/i);
    expect(note).toMatch(/not filled/i);
    // The seller is standing in front of the form. Tell them to do the thing.
    expect(note).toMatch(/before you post/i);
  });

  it("an extension too old to report it stays SILENT", () => {
    // The compatibility rule, and the reason this is `=== false` rather than a
    // falsy check. Every install built before priceFilled existed sends nothing.
    // Reading "did not say" as "did not fill" would warn on every one of their
    // runs, and a warning that fires constantly is one the seller learns to
    // click past — including the time it is real.
    expect(priceNote({})).toBe("");
    expect(priceNote({ priceFilled: undefined })).toBe("");
  });
});
