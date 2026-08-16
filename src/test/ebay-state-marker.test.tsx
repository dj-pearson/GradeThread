// US-2656: eBay's own verdict on a listing reaches the seller.
//
// The server records it on `listings.platform_fields.ebay_state` on every
// change. Two things have to hold for that to be worth writing: the banner shows
// the reasons the local status cannot express, and it stays QUIET for the ones it
// can — a notice above every healthy listing is a notice nobody reads.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ListingAlertMarkers } from "@/components/flipdesk/listing-alert-markers";
import { flaggedListings, type ItemListingRow } from "@/hooks/use-item-listings";

const state = (reason: string, message: string) => ({
  status: reason === "out_of_stock" ? "active" : "ended",
  reason,
  ebay_status: reason.toUpperCase(),
  message,
  observed_at: "2026-08-16T12:00:00.000Z",
});

function row(platformFields: Record<string, unknown> | null): ItemListingRow {
  return { id: "l1", platform: "ebay", platform_fields: platformFields } as ItemListingRow;
}

describe("the eBay state banner", () => {
  it("explains an out-of-stock listing instead of calling it ended", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{
          ebay_state: state("out_of_stock", "eBay shows this listing as out of stock."),
        }}
        platform="ebay"
        listingUrl="https://www.ebay.com/itm/123"
      />,
    );
    expect(html).toContain("Out of stock on eBay");
    expect(html).toContain("eBay shows this listing as out of stock.");
    // The link is the fix, not decoration.
    expect(html).toContain("https://www.ebay.com/itm/123");
  });

  it("says eBay took the listing down, which is not the same as it ending", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{
          ebay_state: state("inactive", "eBay has made this listing inactive."),
        }}
        platform="ebay"
      />,
    );
    expect(html).toContain("eBay made this listing inactive");
  });

  it("stays quiet for the states the status badge already shows", () => {
    for (const reason of ["active", "ended", "completed", "not_in_feed"]) {
      const html = renderToStaticMarkup(
        <ListingAlertMarkers
          platformFields={{ ebay_state: state(reason, "some message") }}
          platform="ebay"
        />,
      );
      expect(html, `${reason} should not raise a banner`).toBe("");
    }
  });

  it("still renders nothing for a listing with no markers at all", () => {
    expect(
      renderToStaticMarkup(<ListingAlertMarkers platformFields={{}} platform="ebay" />),
    ).toBe("");
  });
});

describe("which listings the item page flags", () => {
  it("flags a notable eBay state", () => {
    const rows = [row({ ebay_state: state("inactive", "m") })];
    expect(flaggedListings(rows).map((r) => r.id)).toEqual(["l1"]);
  });

  it("does NOT flag a healthy one", () => {
    // The marker is written for every state including the good ones, so gating
    // on its mere presence would put an empty alerts section over every live
    // listing on the page.
    const rows = [row({ ebay_state: state("active", "m") })];
    expect(flaggedListings(rows)).toEqual([]);
  });

  it("still flags the oversell markers it always did", () => {
    expect(
      flaggedListings([row({ delist_unresolved: { platform: "etsy", reason: "x" } })]),
    ).toHaveLength(1);
    expect(
      flaggedListings([row({ oversell_conflict: { conflicting_listing_id: "b" } })]),
    ).toHaveLength(1);
    expect(flaggedListings([row(null)])).toEqual([]);
  });
});
