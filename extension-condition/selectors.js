// GradeThread Condition Check — bundled default adapter config (US-1755, US-1756)
//
// One config, many marketplaces. Each adapter is pure data (a "shared adapter
// interface" expressed as config, so no per-site code branches): host list,
// detail-page detection, gallery/title/brand selectors, and a CDN-specific
// image-URL upgrade rule. The generic content script (content/marketplace.js)
// reads whichever adapter matches the current host.
//
// ⚠️ Marketplaces ship DOM changes without notice. When selectors stop
// resolving, the overlay degrades to a clear "couldn't read this listing's
// photos" message — it never guesses. To avoid a store resubmission per tweak,
// the content script ALSO fetches a remotely-updatable copy of this config
// (configUrl) and prefers it, falling back to this bundled default on any
// failure. Fix selectors in BOTH this file and
// public/extension/marketplace-selectors.json, bumping version + lastVerified.
//
// `verified`: eBay's selectors were checked against the live site (US-1755).
// The other adapters are best-effort starting points; the graceful fallback +
// remote update path (US-1756 AC2/AC3) exist precisely so they can be corrected
// from telemetry without shipping a new build.

const GT_CC_CONFIG = {
  version: "2026.07.3",
  lastVerified: "2026-07-10",
  configUrl: "https://gradethread.com/extension/marketplace-selectors.json",
  adapters: {
    ebay: {
      label: "eBay",
      enabled: true,
      verified: true,
      hosts: ["ebay.com", "ebay.co.uk", "ebay.de", "ebay.ca", "ebay.com.au"],
      detect: { pathIncludes: ["/itm/"] },
      gallery: [
        ".ux-image-carousel-item img",
        ".ux-image-carousel img",
        ".ux-image-magnify__container img",
        ".ux-image-filmstrip-carousel-item img",
        "#PicturePanel img",
        "img[data-idx]"
      ],
      imageAttrs: ["data-zoom-src", "src", "data-src"],
      urlUpgrade: { pattern: "/s-l\\d+(?:_\\d+)?(\\.[a-z0-9]+)(?=($|\\?))", replacement: "/s-l1600$1", flags: "i" },
      title: [
        "h1.x-item-title__mainTitle span.ux-textspans",
        "h1.x-item-title__mainTitle",
        "h1[data-testid='x-item-title']",
        ".x-item-title__mainTitle"
      ],
      // US-1834: seller's stated condition (degrades to '' if none resolve).
      condition: [
        ".x-item-condition-text .ux-textspans",
        ".x-item-condition-value .ux-textspans",
        "[data-testid='x-item-condition'] .ux-textspans"
      ],
      itemSpec: {
        row: ".ux-labels-values",
        label: ".ux-labels-values__labels",
        value: ".ux-labels-values__values",
        brandLabels: ["Brand"]
      },
      maxImages: 4
    },

    poshmark: {
      label: "Poshmark",
      enabled: true,
      verified: false,
      hosts: ["poshmark.com", "poshmark.ca"],
      detect: { pathIncludes: ["/listing/"] },
      gallery: [
        ".slideshow img",
        ".listing__ImageGallery img",
        "img[data-test='listing-image']",
        "img[src*='cloudfront'][src*='posts']"
      ],
      imageAttrs: ["src", "data-src"],
      urlUpgrade: { pattern: "/s_[a-z0-9]+/", replacement: "/l_", flags: "i" },
      title: ["h1.listing__title", "[data-et-name='listing_title']", "h1"],
      brandSelectors: ["a[data-et-name='brand']", ".listing__brand", "a[href*='/brand/']"],
      maxImages: 4
    },

    grailed: {
      label: "Grailed",
      enabled: true,
      verified: false,
      hosts: ["grailed.com"],
      detect: { pathIncludes: ["/listings/"] },
      gallery: [
        ".listing-images img",
        ".Body_photos img",
        "img[src*='grailed']",
        ".-image img"
      ],
      imageAttrs: ["src", "data-src"],
      title: [".details h1", "p.-title", "h1"],
      brandSelectors: ["a[href*='/designers/']", ".-designer", "p.-designer"],
      maxImages: 4
    },

    mercari: {
      label: "Mercari",
      enabled: true,
      verified: false,
      hosts: ["mercari.com"],
      detect: { pathIncludes: ["/item/", "/us/item/"] },
      gallery: [
        "img[data-testid='ItemImage']",
        "[data-testid='image-0'] img",
        "article img",
        "main img[src*='mercari']"
      ],
      imageAttrs: ["src", "data-src"],
      title: ["h1[data-testid='ItemName']", "h1"],
      brandSelectors: ["[data-testid='ItemBrandName']", "a[href*='/brand/']"],
      maxImages: 4
    },

    depop: {
      label: "Depop",
      enabled: true,
      verified: false,
      hosts: ["depop.com"],
      detect: { pathIncludes: ["/products/"] },
      gallery: [
        "img[data-testid='ProductImage']",
        ".ProductImages img",
        "img[src*='depop']",
        "main img"
      ],
      imageAttrs: ["src", "data-src", "srcset"],
      title: ["h1", "[data-testid='product__title']"],
      brandSelectors: ["a[href*='/brands/']", "[data-testid='product__brand']"],
      maxImages: 4
    },

    vinted: {
      label: "Vinted",
      enabled: true,
      verified: false,
      hosts: [
        "vinted.com", "vinted.co.uk", "vinted.fr", "vinted.de", "vinted.es",
        "vinted.it", "vinted.nl", "vinted.pl", "vinted.lt", "vinted.cz"
      ],
      detect: { pathIncludes: ["/items/"] },
      gallery: [
        ".item-photos img",
        "img[data-testid*='photo']",
        "figure img",
        "main img[src*='vinted']"
      ],
      imageAttrs: ["src", "data-src"],
      title: [".details-list__item-title", "[data-testid='item-title']", "h1"],
      brandSelectors: [
        "[data-testid='item-attributes-brand'] a",
        ".details-list__item a[href*='/brand']"
      ],
      maxImages: 4
    }
  }
};

self.GT_CC_CONFIG = GT_CC_CONFIG;
