import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2641. Two things the composer did to a LIVE eBay listing while reporting
// success: it published a previously-listed item without the relist flag, and
// it wrote a new price into the row without pushing it to the marketplace.
//
// Both are source-shape guards rather than render tests. The composer is a
// 3,000-line page whose behaviour here is decided by which prop it passes and
// which client it writes through, and both regressions are one deleted line.

const COMPOSER = "src/pages/flipdesk/composer.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the composer relists rather than re-publishing (US-2641)", () => {
  it("passes relist to the publish dialog", () => {
    const src = read(COMPOSER);
    const dialog = src.slice(src.indexOf("<PublishToEbayDialog"));
    const tag = dialog.slice(0, dialog.indexOf("/>"));
    // Without this the server skips the withdraw-first step and re-publishes the
    // OLD offer. After a seller-side end on eBay that offer answers 25001
    // forever, or hands back the ended listing's id as a success.
    expect(tag).toMatch(/relist=/);
    expect(tag).toMatch(/listing_status === "ended"/);
    expect(tag).toMatch(/listing_status === "active"/);
    expect(tag).toMatch(/listingActive=/);
  });
});

describe("a live listing's price is pushed, not just stored (US-2641)", () => {
  const src = read(COMPOSER);

  it("routes a live reprice through the lifecycle endpoint", () => {
    // /listings/:id/price pushes to the marketplace FIRST and writes our copy
    // only if that succeeded. A direct row write cannot do that, so a wrong
    // price on a live listing read as fixed everywhere except on eBay.
    expect(src).toMatch(/useUpdateListingPrice/);
    expect(src).toMatch(/updateListingPrice\.mutateAsync\(\{\s*listingId,\s*price: next/);
  });

  it("the direct listing_price write is reachable only for an unpublished row", () => {
    const start = src.indexOf("persistPriceRef.current = async");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("useEffect(", start));
    // The live branch comes first and the raw write sits in its else-if, so a
    // published listing can never reach the direct update.
    const livePush = fn.indexOf("updateListingPrice.mutateAsync");
    const rawWrite = fn.indexOf("listing_price: next");
    expect(livePush).toBeGreaterThan(-1);
    expect(rawWrite).toBeGreaterThan(livePush);
    expect(fn).toMatch(/if \(listingId && priceIsLive\)/);
    expect(fn).toMatch(/\} else if \(listingId\) \{/);
  });

  it("liveness mirrors the server's wasPublishedUpstream", () => {
    const start = src.indexOf("const priceIsLive =");
    expect(start).toBeGreaterThan(-1);
    const expr = src.slice(start, src.indexOf(";", start));
    // Same three columns the server checks. Keying on listing_status instead
    // would miss a published row that has since been moved back to draft.
    for (const col of [
      "platform_offer_id",
      "platform_listing_id",
      "synced_to_ebay_at",
    ]) {
      expect(expr).toContain(col);
    }
  });

  it("tells the seller which kind of save failed", () => {
    const card = read("src/components/flipdesk/composer/price-card.tsx");
    expect(card).toMatch(/LIVE_PRICE_SAVE_TEXT/);
    // The live failure is not "retype it" — the old price is still charging
    // buyers, and that is the part the seller has to know.
    expect(card).toMatch(/old price is still live/);
    expect(src).toMatch(/priceIsLive=\{priceIsLive\}/);
  });
});
