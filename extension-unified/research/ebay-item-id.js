// GradeThread unified extension — eBay item id, and nothing else (US-3042).
//
// WHY THIS FILE EXISTS.
//
// Everywhere else in this extension, the content script reads the listing off
// the page: gallery photos, title, brand, condition, price. That is how every
// marketplace adapter works, because Poshmark, Mercari, Grailed, Depop and
// Vinted publish no API a shopper's browser could ask instead.
//
// eBay does. And eBay's API License Agreement says their content comes through
// their API, which a shopper's browser is not. So on eBay this extension reads
// exactly one thing off the page — the item id, which is in the URL — sends
// that, and lets our server ask eBay for the rest.
//
// KEEP IT THAT WAY. `test/ebay-no-scrape.test.cjs` fails the build if the eBay
// adapter's read path calls any of the DOM extractors, so a well-meant "we
// already have the title, why fetch it again" cannot quietly undo this. The
// answer to that question is: because where it came from is the entire point.
//
// The parsing rule is mirrored on the server in
// services/edge-functions/src/lib/ebay-item-read.ts (parseEbayItemId). The
// server validates independently — this is a convenience, never a trust
// boundary — but the two are deliberately the same rule so a URL that works in
// the overlay works in the request it produces.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_EBAY_ITEM = api; // every browser world
})(typeof self !== "undefined" ? self : this, function () {
  // eBay legacy item ids are 9-15 digits. Nothing shorter is an item id, and
  // nothing longer has ever been one.
  const ITEM_ID_RE = /^\d{9,15}$/;
  const EBAY_HOST_RE = /(^|\.)ebay\.[a-z.]{2,6}$/i;

  /** Is this URL on an eBay domain (any of the fifteen we support)? */
  function isEbayUrl(rawUrl) {
    try {
      return EBAY_HOST_RE.test(new URL(rawUrl).hostname);
    } catch (_e) {
      return false;
    }
  }

  /**
   * The listing's item id, or null when this is not an eBay item page.
   *
   * Handles the shapes eBay actually serves:
   *   /itm/123456789012
   *   /itm/nike-air-max-90-mens-size-11/123456789012?hash=item1a2b
   *   /itm/?item=123456789012
   *
   * Returns null for every other eBay page — search results, a seller's store,
   * a category. Null means "this is not a listing", which is the safe direction:
   * the overlay stays quiet rather than grading something that is not an item.
   */
  function itemIdFromUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (_e) {
      return null;
    }
    if (!EBAY_HOST_RE.test(url.hostname)) return null;

    const fromQuery = url.searchParams.get("item");
    if (fromQuery && ITEM_ID_RE.test(fromQuery)) return fromQuery;

    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length || segments[0].toLowerCase() !== "itm") return null;
    // Last numeric segment wins: a slug can contain digits ("air-max-90"), and
    // the id is always the final segment.
    for (let i = segments.length - 1; i >= 1; i--) {
      if (ITEM_ID_RE.test(segments[i])) return segments[i];
    }
    return null;
  }

  return { isEbayUrl, itemIdFromUrl, ITEM_ID_RE };
});
