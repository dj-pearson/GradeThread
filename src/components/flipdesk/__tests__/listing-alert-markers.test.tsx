// US-2165 (AC3) + US-1290 (AC3): the oversell-risk banners render, and — the part
// that actually caused the bug these stories fix — a clean listing renders
// NOTHING, so the component can be dropped in unconditionally.
//
// Rendered markup is asserted via renderToStaticMarkup (the repo's convention).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ListingAlertMarkers } from "@/components/flipdesk/listing-alert-markers";

const UNRESOLVED = {
  platform: "etsy",
  reason: "Etsy is no longer connected.",
  detected_at: "2026-07-25T10:00:00.000Z",
};

const OVERSELL = {
  conflicting_listing_id: "listing-b",
  detected_at: "2026-07-25T11:00:00.000Z",
};

describe("ListingAlertMarkers", () => {
  it("renders nothing when the listing carries no markers", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers platformFields={{}} platform="etsy" />,
    );
    expect(html).toBe("");
  });

  it("renders nothing for null platform_fields", () => {
    // A listing that has never been touched by a sync has null here, and the
    // section renders this component for every listing on the item.
    const html = renderToStaticMarkup(
      <ListingAlertMarkers platformFields={null} platform="ebay" />,
    );
    expect(html).toBe("");
  });

  it("names the marketplace and says the listing may still be live", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ delist_unresolved: UNRESOLVED }}
        platform="etsy"
      />,
    );
    // The seller has to know WHICH marketplace to go end it on — a generic
    // "couldn't delist" is not actionable.
    expect(html).toContain("Etsy");
    expect(html).toContain("may still be live");
    expect(html).toContain("Etsy is no longer connected.");
  });

  it("prefers the marker's own platform over the row's", () => {
    // The marker records the platform it was stamped for. If those ever disagree
    // the marker is authoritative — it is what the delist actually failed on.
    // Note the neutral reason: asserting the row's platform is ABSENT only means
    // something if the fixture's other strings don't mention it.
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{
          delist_unresolved: {
            platform: "whatnot",
            reason: "No delist API for this marketplace yet.",
          },
        }}
        platform="etsy"
      />,
    );
    expect(html).toContain("Whatnot");
    expect(html).not.toContain("Etsy");
  });

  it("falls back to the row's platform when the marker omits one", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ delist_unresolved: { reason: "boom" } }}
        platform="shopify"
      />,
    );
    expect(html).toContain("Shopify");
  });

  it("links to the live listing when a URL is known", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ delist_unresolved: UNRESOLVED }}
        platform="etsy"
        listingUrl="https://etsy.com/listing/123"
      />,
    );
    // A link is the difference between a warning and a fix.
    expect(html).toContain("https://etsy.com/listing/123");
    expect(html).toContain("Open the listing to end it");
  });

  it("omits the link when no URL is known", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ delist_unresolved: UNRESOLVED }}
        platform="etsy"
      />,
    );
    expect(html).not.toContain("Open the listing to end it");
  });

  it("renders the double-sale banner and never claims to have resolved it", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{ oversell_conflict: OVERSELL }}
        platform="ebay"
      />,
    );
    expect(html).toContain("Possible double sale");
    // US-1290: we must never imply we picked a winner — the seller cancels one.
    expect(html).toContain("cancel one");
  });

  it("renders both banners when a listing carries both markers", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{
          delist_unresolved: UNRESOLVED,
          oversell_conflict: OVERSELL,
        }}
        platform="etsy"
      />,
    );
    expect(html).toContain("may still be live");
    expect(html).toContain("Possible double sale");
  });

  it("survives a malformed detected_at without rendering Invalid Date", () => {
    const html = renderToStaticMarkup(
      <ListingAlertMarkers
        platformFields={{
          delist_unresolved: { ...UNRESOLVED, detected_at: "not-a-date" },
        }}
        platform="etsy"
      />,
    );
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("Detected");
    // The banner itself must still render — a bad timestamp can't suppress an
    // oversell warning.
    expect(html).toContain("may still be live");
  });
});
