// GradeThread unified extension — marketplace attribution notices (US-3112)
//
// DOM-free, dependency-free, so it is unit-testable in node
// (test/ebay-attribution.test.cjs) AND loadable as a classic script by the
// content script, the popup and compare.html alike (it sets self.GT_MP_NOTICE).
// The UMD shim gives node's require() a module.exports.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// eBay's API License Agreement asks for two things wherever eBay data is shown
// to a person: that the data is identified as coming from eBay, and that we say
// plainly we are not endorsed by eBay. The web app has carried both since
// US-3033 (src/components/marketplace/ebay-attribution.tsx).
//
// The extension never did — and the extension is the surface where it matters
// most. The web app is read by a seller who came to gradethread.com on purpose.
// The overlay is read by a SHOPPER, mid-purchase, inside eBay's own page, in a
// card we drew. That is the one place a person could reasonably conclude this
// is an eBay feature. The notice is what stops that conclusion.
//
// ── WHY IT IS KEYED BY MARKETPLACE ───────────────────────────────────────────
//
// The overlay also runs on Poshmark, Grailed, Mercari, Depop and Vinted.
// Stamping eBay's non-endorsement notice onto a Vinted page would be worse than
// having none at all: it is factually wrong, and it reads as boilerplate nobody
// checked. Only marketplaces with a notice below get one, and everything else
// gets null rather than a generic sentence.
//
// ── WHY THE WORDING IS DUPLICATED, NOT SHARED ────────────────────────────────
//
// The extension ships as a zip to two stores and cannot import from src/. So
// the sentence is repeated here deliberately, and test/ebay-attribution.test.cjs
// asserts it still matches the web component word for word. A reader who meets
// GradeThread in both places should see one company saying one thing.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_MP_NOTICE = api; // content / popup / page
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NOTICE_BY_MARKETPLACE = {
    ebay:
      "Listing data from eBay, retrieved through the eBay API. eBay is a " +
      "trademark of eBay Inc. GradeThread uses the eBay API but is not " +
      "endorsed or certified by eBay Inc.",
  };

  /**
   * The notice for one marketplace key, or null when that marketplace has none.
   * Case-insensitive because the key arrives from stored tray entries written by
   * older versions as well as from the live adapter.
   */
  function noticeFor(marketplace) {
    if (typeof marketplace !== "string") return null;
    const key = marketplace.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(NOTICE_BY_MARKETPLACE, key)
      ? NOTICE_BY_MARKETPLACE[key]
      : null;
  }

  /**
   * The distinct notices a mixed list of entries needs, in a stable order.
   *
   * Used by the compare view, where the shopper has pinned listings from
   * several marketplaces into one table: it must carry eBay's notice when an
   * eBay row is present and must not carry it when none is.
   */
  function noticesForMarketplaces(marketplaces) {
    const seen = new Set();
    const out = [];
    for (const m of marketplaces || []) {
      const notice = noticeFor(m);
      if (notice && !seen.has(notice)) {
        seen.add(notice);
        out.push(notice);
      }
    }
    return out;
  }

  /**
   * Append the notice as a plain paragraph. Returns the element it created, or
   * null when the marketplace needs none, so a caller can branch without
   * knowing the policy.
   *
   * Plain text, no logo: eBay's brand assets carry their own usage terms, and a
   * wordmark we drew ourselves would be worse than words.
   */
  function appendNotice(doc, parent, marketplace, className) {
    const text = noticeFor(marketplace);
    if (!text || !doc || !parent) return null;
    const p = doc.createElement("p");
    p.className = className || "gt-cc-attribution";
    p.textContent = text;
    parent.appendChild(p);
    return p;
  }

  return {
    NOTICE_BY_MARKETPLACE: NOTICE_BY_MARKETPLACE,
    noticeFor: noticeFor,
    noticesForMarketplaces: noticesForMarketplaces,
    appendNotice: appendNotice,
  };
});
