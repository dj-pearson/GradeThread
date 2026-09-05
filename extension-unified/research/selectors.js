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
// US-1879 — merge rule: the hosted copy is used ONLY when its `version` is >= this
// bundled `version` (dotted-numeric compare via IMG.chooseConfig); a stale/rolled-
// back hosted file can never downgrade these adapters. The config-sync guard test
// (test/config-sync.test.cjs, run in verify:web) fails the build if the two files
// drift on version/lastVerified/adapters — so edit them together.
//
// `verified`: eBay's selectors were checked against the live site (US-1755).
// The other adapters are best-effort starting points; the graceful fallback +
// remote update path (US-1756 AC2/AC3) exist precisely so they can be corrected
// from telemetry without shipping a new build.

const GT_CC_CONFIG = {
  version: "2026.08.1",
  lastVerified: "2026-08-16",
  configUrl: "https://gradethread.com/extension/marketplace-selectors.json",
  adapters: {
    ebay: {
      label: "eBay",
      enabled: true,
      verified: true,
      hosts: [
        "ebay.com", "ebay.co.uk", "ebay.de", "ebay.ca", "ebay.com.au",
        "ebay.fr", "ebay.it", "ebay.es", "ebay.ie", "ebay.nl",
        "ebay.at", "ebay.ch", "ebay.pl", "ebay.be"
      ],
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
      // US-1835: listing price (degrades to '' if none resolve).
      price: [
        ".x-price-primary .ux-textspans",
        "[data-testid='x-price-primary'] .ux-textspans",
        ".x-bin-price__content .ux-textspans"
      ],
      // US-2622: proof the VIEWER OWNS this listing. Owner-only controls, and
      // only owner-only ones: 'Sell one like this' is shown to buyers too, and
      // it links to the same /sl/list flow as 'Sell a similar item', so matching
      // on the href alone would hide the read from the shoppers it is for.
      // Verified 2026-08-16 against an owned listing (both match) and a
      // stranger's (neither does).
      ownListing: [
        "a[href*='ReviseItem']",
        ".ux-layout-section__textual-display--reviseList"
      ],
      itemSpec: {
        row: ".ux-labels-values",
        label: ".ux-labels-values__labels",
        value: ".ux-labels-values__values",
        brandLabels: ["Brand"]
      },
      // US-2237 scan mode: the SEARCH page. `card` finds the result tiles; the
      // rest are read relative to each tile. eBay is the only adapter whose
      // cards print a condition, which is why its scan read is the richest.
      // US-2239: the seller's identity on the listing page, so repeat reads of the
      // same seller can be recognised. Buyer-private — never sent anywhere.
      sellerSelectors: [
        ".x-sellercard-atf__info__about-seller a",
        ".x-sellercard-atf__info__about-seller span",
        "[data-testid='x-sellercard-atf'] a[href*='/usr/']",
        "a[href*='/usr/']"
      ],
      // US-2241: eBay serves one photo at many sizes under the same id path
      // segment (…/images/g/<ID>/s-l1600.jpg). Capture the id so the thumbnail
      // and the zoom render of one shot collapse to a single slot.
      assetIdPattern: "/g/([^/]+)/",
      search: {
        detect: { pathIncludes: ["/sch/", "/b/"] },
        queryParams: ["_nkw"],
        card: ["li.s-item", "li.s-card", "ul.srp-results > li"],
        link: ["a.s-item__link", "a.s-card__link", "a[href*='/itm/']"],
        title: [".s-item__title", ".s-card__title", "[role='heading']"],
        price: [".s-item__price", ".s-card__price"],
        condition: [".SECONDARY_INFO", ".s-item__subtitle", ".s-card__subtitle"],
        image: [".s-item__image-wrapper img", ".s-card__image img", "img"]
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
      // US-1880: Poshmark encodes size as a FILENAME prefix (…/<postId>/s_<hash>.jpg
      // → l_ for the large render), NOT a path segment. The old "/s_[a-z0-9]+/"
      // required a trailing slash that real CloudFront URLs don't have, so it
      // never matched and thumbnails got graded. Match the s_/m_/t_ prefix at the
      // filename start (lookahead: no more slashes follow) and upgrade to l_.
      urlUpgrade: { pattern: "/(?:s|m|t)_(?=[^/]*$)", replacement: "/l_", flags: "i" },
      title: ["h1.listing__title", "[data-et-name='listing_title']", "h1"],
      brandSelectors: ["a[data-et-name='brand']", ".listing__brand", "a[href*='/brand/']"],
      sellerSelectors: [
        "[data-et-name='seller_username']",
        ".listing__seller a",
        "a[href^='/closet/']"
      ],
      // The CloudFront filename carries a size prefix (s_/m_/l_) on a stable
      // hash — capture the hash so two sizes of one photo are one photo.
      assetIdPattern: "/(?:s|m|t|l)_([a-f0-9]{8,})",
      search: {
        detect: { pathIncludes: ["/search", "/category/", "/brand/", "/closet/", "/feed"] },
        queryParams: ["query", "q"],
        card: ["[data-et-name='listing']", ".card--small", ".tile"],
        link: ["a.tile__covershot", "a[href*='/listing/']"],
        title: [".tile__title", "a[href*='/listing/']"],
        price: ["[data-et-name='price']", ".fw--bold", ".p--t--1"],
        condition: [".condition-tag", "[data-et-name='condition']"],
        image: ["img"]
      },
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
      sellerSelectors: [
        "[data-testid='Seller']",
        ".Seller_username",
        "a[href*='/users/']"
      ],
      search: {
        detect: { pathIncludes: ["/shop", "/designers/", "/categories/"] },
        queryParams: ["query", "q"],
        card: ["[data-testid='feeditem']", ".feed-item", ".Feeditem"],
        link: ["a[href*='/listings/']"],
        title: [".ListingMetadata-module__designer", ".listing-designer", "p"],
        price: ["[data-testid='Current price']", ".Price", ".listing-price"],
        condition: ["[data-testid='condition']", ".ListingMetadata-module__condition"],
        image: ["img"]
      },
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
      sellerSelectors: [
        "[data-testid='SellerName']",
        "a[href*='/u/'] span",
        "a[href*='/u/']"
      ],
      search: {
        detect: { pathIncludes: ["/search", "/category/", "/brand/"] },
        queryParams: ["keyword", "q"],
        card: ["[data-testid='ItemContainer']", "li[data-testid='ItemCell']", "a[href*='/item/']"],
        link: ["a[href*='/item/']"],
        title: ["[data-testid='ItemName']", "[data-testid='ItemThumbnail']"],
        price: ["[data-testid='ItemPrice']", "[data-testid='ThumbnailPrice']"],
        condition: ["[data-testid='ItemCondition']"],
        image: ["img"]
      },
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
      sellerSelectors: [
        "[data-testid='shopLink']",
        "a[data-testid='username']",
        "a[href^='/'][data-testid*='seller']"
      ],
      search: {
        detect: { pathIncludes: ["/search", "/explore", "/category/", "/brands/"] },
        queryParams: ["q", "query"],
        card: ["li[data-testid='product__item']", "a[data-testid='product__item']", "a[href*='/products/']"],
        link: ["a[href*='/products/']"],
        title: ["[data-testid='product__title']", "p"],
        price: ["[data-testid='product__price']", "[aria-label*='price']"],
        condition: ["[data-testid='product__condition']"],
        image: ["img"]
      },
      maxImages: 4
    },

    vinted: {
      label: "Vinted",
      enabled: true,
      verified: false,
      hosts: [
        "vinted.com", "vinted.co.uk", "vinted.fr", "vinted.de", "vinted.es",
        "vinted.it", "vinted.nl", "vinted.pl", "vinted.lt", "vinted.cz",
        "vinted.be", "vinted.at", "vinted.ro", "vinted.hu", "vinted.sk",
        "vinted.pt", "vinted.se", "vinted.lu", "vinted.hr", "vinted.gr",
        "vinted.dk", "vinted.fi"
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
      sellerSelectors: [
        "[data-testid='profile-username']",
        ".details-list__item-value a[href*='/member/']",
        "a[href*='/member/']"
      ],
      search: {
        detect: { pathIncludes: ["/catalog", "/member/", "/brand/"] },
        queryParams: ["search_text", "q"],
        card: ["[data-testid*='product-item']", ".feed-grid__item", "a[href*='/items/']"],
        link: ["a[href*='/items/']"],
        title: ["[data-testid*='description-title']", ".web_ui__ItemBox__title"],
        price: ["[data-testid*='price-text']", "[data-testid*='description-price']"],
        condition: ["[data-testid*='description-subtitle']"],
        image: ["img"]
      },
      maxImages: 4
    },

    // ── ShopGoodwill (US-3067): a SOURCING site, not a resale marketplace ────
    //
    // Every other adapter above is a place a shopper BUYS from a reseller. This
    // one is where the reseller buys, and the question flip mode answers on it
    // is "should I bid on this", not "is this listing honest". Read-only in the
    // strongest sense: it never bids, never refreshes the page and never
    // navigates to a lot on its own (US-1876).
    //
    // ⚠ GOODWILLFINDS IS NOT HERE, AND CANNOT BE. US-3067 names
    // goodwillfinds.com as the second host. It shut down on 2025-03-28 and the
    // domain no longer resolves - measured 2026-09-05, SERVFAIL on Google
    // public DNS for both the apex and www, with shopgoodwill.com resolving
    // from the same command as the control. Chrome renders ERR_NAME_NOT_RESOLVED.
    // See the story note; do not add an adapter for it.
    //
    // ── WHAT WAS PROBED, AND HOW ────────────────────────────────────────────
    //
    // 2026-09-05, two live item pages (/item/276277887 and /item/276278053),
    // signed out. Confirmed on both: the /item/<digits> URL shape, a single
    // `h1` carrying the title, `.image-gallery` wrapping an `ngx-gallery`, the
    // `Current Price:` row, and a labelled details table whose rows are exactly
    // Item ID / Number of Bids / Bid Increment / Shipping Price / Handling
    // Price / Ends On / Seller.
    //
    // NOT probed: flip mode itself has never run on this site. That is AC8 and
    // it stays open.
    //
    // ── THE GALLERY IS CSS, NOT <img> ───────────────────────────────────────
    //
    // ngx-gallery paints each photo as an inline `background-image`, so there
    // is no `src` to read and `imageAttrs: ["src"]` returns nothing at all --
    // matching elements, zero usable URLs, which is US-1880's second failure
    // mode. `style` is handled in marketplace.js the way `srcset` already is.
    //
    // The carousel only mounts the three tiles around the current one, so
    // `.ngx-gallery-image` is the FULL-SIZE set but INCOMPLETE -- three of six
    // on a six-photo lot. `.ngx-gallery-thumbnail` is the complete set, and the
    // urlUpgrade below turns each thumbnail into its full-size original, so the
    // thumbnails are listed FIRST and are what the grader actually receives.
    //
    // ⚠ MEASURED, NOT ASSUMED (2026-09-05). Fifteen thumbnails across three
    // lots (/item/276278053 six, /item/276277887 three, /item/274725075 six),
    // every derived URL loaded, zero failures, and the size difference is the
    // whole point: 333px thumbnails against 1005-3000px originals. Grading a
    // 333px photo would be grading a smudge.
    //
    // The indexes are NOT contiguous -- 276278053 serves t1..t5 and t7, with
    // no t6 -- so the upgrade rewrites each thumbnail URL and nothing counts.
    shopgoodwill: {
      label: "ShopGoodwill",
      enabled: true,
      verified: true,
      lastVerified: "2026-09-05",
      sourcing: true,
      hosts: ["shopgoodwill.com"],
      detect: { pathIncludes: ["/item/"] },
      // Digits only. The search grid links the same id twice per card, and the
      // id is the only thing this adapter reads out of the URL.
      assetIdPattern: "/item/(\\d+)",
      gallery: [
        ".ngx-gallery-thumbnail",
        ".ngx-gallery-image",
        ".image-gallery img.sr-only"
      ],
      imageAttrs: ["style", "src"],
      // `..._0716t3.jpeg` -> `..._07163.png`. Anchored at the end so a `t` or a
      // `.jpeg` anywhere earlier in the CDN path cannot be rewritten, and the
      // query string is carried through rather than dropped.
      urlUpgrade: {
        pattern: "t(\\d+)\\.jpe?g(\\?.*)?$",
        replacement: "$1.png$2",
        flags: "i"
      },
      title: ["h1"],
      // `Current Price:` is the live figure on an auction and the asking price
      // on a Buy It Now, which is why it is read rather than `Minimum Bid:`.
      // Both sit in a two-column `div.row`, label left, value right, with no
      // stable class on the value -- so the row is found by its LABEL text in
      // marketplace.js rather than by a selector that Angular will rewrite.
      priceRowLabel: "Current Price",
      price: ["div.row.mb-2 div.col-4.text-right", "div.row div.col-4.text-right h3"],
      // The labelled table. Read by label text for the same reason.
      detailTable: "table.table-borderless",
      detailLabels: {
        itemId: "Item ID",
        bidCount: "Number of Bids",
        bidIncrement: "Bid Increment",
        shipping: "Shipping Price",
        handling: "Handling Price",
        endsOn: "Ends On",
        seller: "Seller"
      },
      // ⚠ THERE IS NO COUNTDOWN ELEMENT ON THE ITEM PAGE. US-3067 AC6 says to
      // read the end time "from the page's own countdown element". `Ends On:`
      // is an ABSOLUTE datetime with a trailing timezone, e.g.
      // "09/05/2026 12:03:00 PM PT", so the ten-minute check has to parse that
      // and do its own arithmetic. A countdown would have been self-updating;
      // this is a fixed string read once.
      endsOnFormat: "MM/DD/YYYY hh:mm:ss A [PT]",
      // ⚠ AND THE SHIPPING ESTIMATE IS NOT ON THE PAGE. `Shipping Price:` has
      // THREE states, and only one of them is a number:
      //   "Estimate Shipping"  a button that wants a ZIP before it will say
      //   "Pickup Only"        no shipping at all, and the lot is only worth
      //                        bidding on if you can drive to that Goodwill
      //   "$12.34"             an actual figure, on the lots that carry one
      // Handling IS always stated ($3.99 on all three probed lots). AC2 assumes
      // both a buyer premium and a shipping estimate are readable; neither is,
      // and ShopGoodwill charges no percentage premium at all -- the cost basis
      // is bid + handling + whatever shipping turns out to be.
      maxImages: 6
    }
  }
};

self.GT_CC_CONFIG = GT_CC_CONFIG;
