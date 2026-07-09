// GradeThread Condition Check — bundled default selector config (US-1755)
//
// ⚠️ eBay ships DOM changes without notice. When the gallery/title/brand
// selectors below stop resolving, the overlay degrades to a clear "couldn't
// read this listing's photos" message rather than grading nothing — it never
// guesses. To avoid shipping a new extension build for every eBay tweak, the
// content script also fetches a REMOTELY-UPDATABLE copy of this config
// (SELECTOR_CONFIG_URL) and prefers it when its `version` is newer, falling
// back to this bundled default on any fetch/parse failure. Update the hosted
// file (public/extension/ebay-selectors.json) to fix selectors without a store
// resubmission; bump `version` + `lastVerified` there and here in lockstep.
//
// Content scripts share one isolated world per frame, so assigning to the
// global here makes GT_CC_SELECTORS visible to content/ebay.js, which loads
// after this file.

const GT_CC_SELECTORS = {
  version: "2026.07.1",
  lastVerified: "2026-07-09",
  // Remotely-updatable override. Same shape as this object. Optional — the
  // extension works from the bundled default if this is unreachable.
  configUrl: "https://gradethread.com/extension/ebay-selectors.json",
  ebay: {
    // A page is an item page only if the path matches. Cheap guard so the
    // content script no-ops on search / home / seller pages it was injected on.
    itemPathIncludes: "/itm/",
    // Ordered by preference; the first selector that yields <img> elements wins.
    // The main carousel first (full-res zoom images), thumbnails as a fallback.
    gallery: [
      ".ux-image-carousel-item img",
      ".ux-image-carousel img",
      ".ux-image-magnify__container img",
      ".ux-image-filmstrip-carousel-item img",
      "#PicturePanel img",
      "img[data-idx]"
    ],
    // Best-quality attribute to read off a gallery <img>, in order.
    imageAttrs: ["data-zoom-src", "src", "data-src"],
    // Listing title — sharpens the grade (passed to the endpoint as `title`).
    title: [
      "h1.x-item-title__mainTitle span.ux-textspans",
      "h1.x-item-title__mainTitle",
      "h1[data-testid='x-item-title']",
      ".x-item-title__mainTitle"
    ],
    // Brand lives in an item-specifics label/value row. We scan rows whose
    // label text equals one of these and read the paired value.
    itemSpecRow: ".ux-labels-values",
    itemSpecLabel: ".ux-labels-values__labels",
    itemSpecValue: ".ux-labels-values__values",
    brandLabels: ["Brand"]
  }
};

self.GT_CC_SELECTORS = GT_CC_SELECTORS;
