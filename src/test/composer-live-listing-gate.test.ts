// US-2395 AC5: a published multi-variation listing counts as LIVE in the composer.
//
// eBay publishes a variation listing through an inventory_item_group and never
// mints a `platform_offer_id` for it. `isLiveListing` required one, so every
// live variation listing was classified as a DRAFT — and the footer then offered
// to "Publish to eBay" something that was already live.
//
// That is the worse half of the US-2395 bug. The revise 409 at least REFUSED;
// this invited the seller to publish a duplicate of their own listing.
//
// A source scan, because the gate is a derived boolean inside a 2,000-line
// component and rendering it needs the whole FlipDesk shell. What matters is the
// CONDITION, and the condition is a property of the text.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/pages/flipdesk/composer.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

function gate(): string {
  const at = SRC.indexOf("const isLiveListing =");
  expect(at, "isLiveListing was renamed").toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf(";", at));
}

describe("US-2395: the composer's live-listing gate", () => {
  it("still requires an active listing", () => {
    // The gate widened; it must not have loosened. A non-active listing is not
    // live whatever else it carries.
    expect(gate()).toContain('listing.listing_status === "active"');
  });

  it("accepts a variation listing that has a platform_listing_id", () => {
    const g = gate();
    expect(
      g.includes("listing.variations"),
      "a live variation listing reads as a draft again, so the footer offers to " +
        "publish something already live",
    ).toBe(true);
    // Keyed on platform_listing_id — the eBay item id publish-by-group returns —
    // NOT on the offer id a group will never have.
    expect(g).toContain("listing.platform_listing_id");
  });

  it("still accepts an ordinary single-offer listing", () => {
    // The common path. Widening the gate must not have replaced it.
    expect(gate()).toContain("listing.platform_offer_id");
  });

  it("requires BOTH halves of the variation branch, not either", () => {
    // `variations` alone would call an unpublished draft matrix live; a
    // platform_listing_id alone is the single-offer case already covered.
    const g = gate().replace(/\s+/g, " ");
    expect(
      /!!listing\.variations && !!listing\.platform_listing_id/.test(g),
      "the variation branch no longer requires both a matrix AND a published " +
        "eBay item id",
    ).toBe(true);
  });
});
