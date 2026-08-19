import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ListingAlertMarkers } from "@/components/flipdesk/listing-alert-markers";
import type { EbayStateMarker } from "@/lib/listing-origin";

// US-2684. A seller's eBay order was cancelled. eBay took the listing's
// quantity to zero when the order was placed and never put it back, so the
// listing sat there live, holding its item id, and unbuyable. FlipDesk showed a
// green "buyers can purchase it now" banner over it, and Save & resubmit — the
// only verb on the screen — pushed the title, the price, the description, the
// photos, the category, the condition and every item specific, and never the
// quantity. So the one field that was wrong was the one field that could not be
// fixed from the app.
//
// Three separate guards, because the bug had three independent halves and any
// one of them coming back reproduces it in full.

const COMPOSER = "src/pages/flipdesk/composer.tsx";
const SYNC = "services/edge-functions/src/routes/flipdesk-ebay.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * Strip line and block comments before asserting on code shape.
 *
 * The comment explaining a rule satisfies a regex looking for that rule, which
 * is how a source scan passes against code that no longer does the thing. These
 * files are heavily commented and every phrase below appears in prose nearby.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

describe("Save & resubmit pushes the quantity (US-2684)", () => {
  const src = code(read(COMPOSER));

  it("sends quantity in the revise patch", () => {
    const start = src.indexOf("async function handleResubmitClick");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("\n  }", start));
    // resolveQuantity floors at 1, so this is also what makes a plain resubmit
    // restock a listing eBay left at zero.
    expect(fn).toMatch(/quantity: resolveQuantity\(\{ quantity, listingFormat \}\)/);
  });

  it("has a narrow restock action that pushes ONLY the quantity", () => {
    const start = src.indexOf("async function handleRestockClick");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("\n  }", start));
    expect(fn).toMatch(/patch: \{ quantity: nextQty \}/);
    // The point of the narrow path: a resubmit re-asserts specifics, category,
    // condition and photos, and eBay refusing any one of those would block the
    // fix for a listing that is unbuyable right now.
    expect(fn).not.toMatch(/resync_ebay_fields/);
    expect(fn).not.toMatch(/photos: true/);
  });
});

describe("the composer stops calling an out-of-stock listing buyable (US-2684)", () => {
  const src = code(read(COMPOSER));

  it("gates the green banner on NOT being out of stock", () => {
    expect(src).toMatch(/\{isLiveListing && !ebayOutOfStock && \(/);
    // The sentence that was the actual lie must still be behind that gate.
    expect(src).toMatch(/buyers can purchase it now/);
  });

  it("derives out-of-stock from the marker, not just the local quantity", () => {
    const start = src.indexOf("const ebayOutOfStock =");
    expect(start).toBeGreaterThan(-1);
    const decl = src.slice(start, src.indexOf(";", start));
    // listings.quantity is NOT reliable here: on a GradeThread-originated
    // listing eBay's number is recorded as drift rather than written to the
    // column, so it keeps reading 1 the whole time the listing is dead.
    expect(decl).toMatch(/ebay_state\?\.reason === "out_of_stock"/);
    expect(decl).toMatch(/listing\?\.quantity === 0/);
    expect(decl).toMatch(/isLiveListing/);
  });

  it("offers the restock button on the out-of-stock banner", () => {
    const start = src.indexOf("{ebayOutOfStock && (");
    expect(start).toBeGreaterThan(-1);
    const banner = src.slice(start, start + 3000);
    expect(banner).toMatch(/handleRestockClick/);
    expect(banner).toMatch(/Restock on eBay/);
    // A banner that says "you can't sell this" and offers no verb is what left
    // the seller with nothing to do but press the button that did nothing.
    expect(banner).toMatch(/nobody can buy it/);
  });
});

describe("the sync agrees with itself about a cancelled order (US-2684)", () => {
  const src = code(read(SYNC));

  it("reads the offer quantity, not just the status word", () => {
    expect(src).toMatch(
      /resolveEbayListingState\(o\.listingStatus, o\.availableQuantity\)/,
    );
  });

  it("a reversal does not overwrite a listing the pull just confirmed live", () => {
    const start = src.indexOf("const lifecyclePatch =");
    expect(start).toBeGreaterThan(-1);
    const patch = src.slice(start, src.indexOf(";", start));
    // Both passes run in the same sync and the offers pull flushes first, so the
    // unconditional "ended" here undid a verdict taken from eBay minutes earlier
    // and the next run wrote it back. The row alternated between two words and
    // neither was the true one.
    expect(patch).toMatch(/stillLiveOnEbay/);
    expect(patch).toMatch(/is_active: true/);
    const guard = src.slice(src.indexOf("const pulledState =", start - 800), start);
    expect(guard).toMatch(/ebayStateByItem\.get\(itemId\)/);
    expect(guard).toMatch(/pulledState\?\.isActive === true/);
  });

  it("a completed sale still takes the listing down", () => {
    const start = src.indexOf("const lifecyclePatch =");
    const patch = src.slice(start, src.indexOf(";", start));
    // Only the REVERSAL arm changed. A sale that stands must keep marking the
    // listing sold and inactive or the item holds an activeListings slot it no
    // longer occupies.
    expect(patch).toMatch(/listing_status: "sold", is_active: false/);
  });
});

describe("the out-of-stock notice renders for a seller (US-2684)", () => {
  const marker: EbayStateMarker = {
    status: "active",
    reason: "out_of_stock",
    ebay_status: "ACTIVE",
    message: "eBay shows this listing as out of stock.",
    observed_at: "2026-08-18T12:00:00.000Z",
  };

  it("names the state and links to the listing", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ ebay_state: marker }}
        platform="ebay"
        listingUrl="https://www.ebay.com/itm/327293662366"
      />,
    );
    expect(html).toContain("Out of stock on eBay");
    expect(html).toContain("327293662366");
  });

  it("stays silent for a healthy listing", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ ebay_state: { ...marker, reason: "active" } }}
        platform="ebay"
      />,
    );
    expect(html).toBe("");
  });
});
