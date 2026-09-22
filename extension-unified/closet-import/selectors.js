// GradeThread closet import — versioned selectors for the seller's OWN listings (US-9201).
//
// Separate from sync/selectors.js on purpose. Sold-sync reads the Sold page and
// the closet for ONE field per tile (the listing address) and it is wired to a
// delist planner, which is why its adapters stay `enabled: false` until a human
// verifies them. This file reads the same closet for the whole listing (title,
// price, size, brand, cover photo) plus the seller's own listing page for the
// rest (description, condition, every photo), and it feeds a REVERSIBLE import:
// a wrong read produces a wrong row that is one Undo away, never a delisted
// catalogue. That is the difference that lets these run as best-effort
// selectors with `verified: false`, the same posture as research/selectors.js.
//
// The photo URL-upgrade rule is COPIED from research/selectors.js rather than
// referenced, because the research adapters load only on listing pages and
// this script also runs on the closet. vault/10-ops/extension-adapter-
// verification.md is the procedure for proving the rule actually rewrites a
// thumbnail into the full render; the server refuses anything under 500px on
// its long side, so a rule that stops matching shows up as refused photos in
// the seller's error list rather than as thumbnails passing as photos.

const GT_CLOSET_IMPORT_SELECTORS = {
  poshmark: {
    label: "Poshmark",
    enabled: true,
    verified: false,
    version: "2026.09.1",
    hosts: ["poshmark.com"],

    login: { urlPattern: "poshmark\\.com/(login|signup)" },
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], [data-test="captcha"]',

    // Poshmark encodes photo size as a filename prefix: s_/m_/t_ for the small
    // renders, l_ for the large one. Same rule and same reason as US-1880.
    urlUpgrade: { pattern: "/(?:s|m|t)_(?=[^/]*$)", replacement: "/l_", flags: "i" },
    assetIdPattern: "/(?:s|m|t|l)_([a-f0-9]{8,})",
    imageAttrs: ["src", "data-src", "srcset"],

    // ── the seller's own closet, tile by tile ─────────────────────────────
    closet: {
      urlPattern: "poshmark\\.com/closet/",
      // /closet/{handle} matches ANY seller's closet. Owner-only controls are
      // the tell, the same shape sync/selectors.js and own-listing.test.cjs use.
      ownClosetTell: '[data-test="closet-edit"], [data-test="bulk-actions"], a[href="/edit-profile"], [data-et-name="closet_settings"]',
      tile: '[data-test="closet-item"], [data-et-name="listing"], .tile',
      fields: {
        listingUrl: 'a[href*="/listing/"]',
        title: '.tile__title, [data-et-name="listing_title"], a[href*="/listing/"]',
        priceText: '[data-et-name="price"], .fw--bold, .p--t--1',
        sizeText: '[data-et-name="size"], .tile__details__pipe__size, [class*="size"]',
        brandText: '[data-et-name="brand"], .tile__details__pipe__brand, a[href*="/brand/"]',
        image: 'img',
      },
      soldBadge: '[data-test="sold-tag"], .sold-tag, .tile__inventory-tag--sold, [data-et-name="sold_tag"]',
      pagination: { infiniteScroll: true, endMarker: '[data-test="closet-end"], .closet__end' },
    },

    // ── one of the seller's own listing pages ─────────────────────────────
    detail: {
      urlPattern: "poshmark\\.com/listing/",
      // The owner sees Edit / Share-to-followers controls a shopper never does.
      ownListingTell: '[data-et-name="edit_listing"], a[href*="/edit-listing/"], [data-test="edit-listing"], [data-et-name="listing_action_edit"]',
      title: 'h1.listing__title, [data-et-name="listing_title"], h1',
      description: '.listing__description, [data-et-name="listing_description"], [data-test="listing-description"]',
      priceText: '.listing__ipad-centered .p--t--1, [data-et-name="listing_price"], [data-test="listing-price"]',
      sizeText: '[data-et-name="listing_size"], [data-test="listing-size"], .listing__size',
      brandText: 'a[data-et-name="brand"], .listing__brand, a[href*="/brand/"]',
      conditionText: '.condition-tag, [data-et-name="condition"], [data-test="listing-condition"]',
      gallery: '.slideshow img, .listing__ImageGallery img, img[data-test="listing-image"], img[src*="cloudfront"][src*="posts"]',
    },
  },

  mercari: {
    label: "Mercari",
    enabled: true,
    verified: false,
    version: "2026.09.1",
    hosts: ["mercari.com"],

    login: { urlPattern: "mercari\\.com/(login|signin|account/login)" },
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], [data-testid="captcha"]',

    // Mercari's CDN serves size variants under /photos/ with a width segment;
    // the orig render has none. Unverified, like everything else here.
    urlUpgrade: { pattern: "/(?:thumb|w\\d+)/(?=[^/]*$)", replacement: "/orig/", flags: "i" },
    assetIdPattern: "/(m\\d+_\\d+)\\.",
    imageAttrs: ["src", "data-src", "srcset"],

    closet: {
      // The seller's own listing list lives under /mypage/, owner-only by URL.
      urlPattern: "mercari\\.com/mypage/listings",
      ownClosetTell: '[data-testid="mypage-nav"], a[href*="/mypage/listings"], [data-testid="EditListingButton"]',
      tile: '[data-testid="ListingCard"], li[data-testid*="item"]',
      fields: {
        listingUrl: 'a[href*="/item/"]',
        title: '[data-testid="ListingCard__ItemName"], [data-testid="item-name"], [data-testid="ItemName"]',
        priceText: '[data-testid="ListingCard__Price"], [data-testid="item-price"], [data-testid="ItemPrice"]',
        sizeText: '[data-testid="ListingCard__Size"], [data-testid="item-size"]',
        brandText: '[data-testid="ListingCard__Brand"], [data-testid="item-brand"]',
        image: 'img',
      },
      soldBadge: '[data-testid="ListingCard__SoldBadge"], [data-testid="sold-label"]',
      pagination: {
        nextButton: '[data-testid="pagination-next"], button[aria-label="Next"], a[rel="next"]',
        endMarker: '[data-testid="pagination-last-active"]',
      },
    },

    detail: {
      urlPattern: "mercari\\.com/(?:us/)?item/",
      ownListingTell: '[data-testid="EditListingButton"], a[href*="/sell/edit/"], [data-testid="edit-item"]',
      title: 'h1[data-testid="ItemName"], h1',
      description: '[data-testid="ItemDescription"], [data-testid="item-description"]',
      priceText: '[data-testid="ItemPrice"], [data-testid="item-price"]',
      sizeText: '[data-testid="ItemSize"], [data-testid="item-size"]',
      brandText: '[data-testid="ItemBrandName"], a[href*="/brand/"]',
      conditionText: '[data-testid="ItemCondition"], [data-testid="item-condition"]',
      gallery: 'img[data-testid="ItemImage"], [data-testid="image-0"] img, article img, main img[src*="mercdn"]',
    },
  },

  // -- Grailed (US-3155) -------------------------------------------------
  //
  // Every selector below was read off the LIVE site on 2026-09-08 with a
  // browser, not guessed: the tile shape from a public shop feed, the detail
  // fields from a real listing page, and the owner-only tells from the
  // founder's own "For sale" page. `verified` is still false, because that flag
  // means one thing only -- a human watched the shipped selectors produce
  // full-size photos on a real import -- and nobody has run one yet.
  //
  // GRAILED CLASS NAMES ARE CSS-MODULE HASHED: `UserItem_root__8Q2R_`,
  // `Details_title__xxxxx`. The hash changes on their next deploy, so every
  // selector here matches the STABLE prefix with [class*="Name_part"] and never
  // the whole class. A selector written against the full hash would work in
  // testing and break silently within weeks.
  grailed: {
    label: "Grailed",
    enabled: true,
    verified: false,
    version: "2026.09.1",
    hosts: ["grailed.com"],

    login: { urlPattern: "grailed\\.com/(users/sign_up|login|auth)" },
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], #px-captcha',

    // Grailed sizes its renders with a ?w= QUERY parameter, not a path segment
    // (media-assets.grailed.com/.../<id>?w=240 at 1x, ?w=500 at 2x). 1400 is
    // comfortably above the server's 500px refusal floor without asking their
    // CDN for an original nobody needs.
    urlUpgrade: { pattern: "([?&]w=)\\d+", replacement: "$11400", flags: "i" },
    assetIdPattern: "/([a-f0-9]{8,})(?:\\?|$)",
    imageAttrs: ["src", "srcset", "data-src"],

    closet: {
      // Grailed's seller pages live under /users/. This started out permissive,
      // matching all of grailed.com, and closet-import-manifest's guard
      // rejected it -- correctly. Every path the manifest matches has to be one
      // an adapter flow actually reads, or it is reach nobody can justify to a
      // store reviewer. If the founder's own For-sale page turns out to sit
      // somewhere else, this line and the manifest match change together.
      urlPattern: "grailed\\.com/users/",
      // Owner-only controls, taken from the founder's own For-sale page: the
      // per-listing seller actions and the "search YOUR listings" box. Someone
      // browsing another seller's shop sees none of them.
      ownClosetTell:
        'input[placeholder*="Search your listings"], [class*="SellerScore_root"], [class*="Following_root"]',
      tile: '[class*="UserItem_root"]',
      fields: {
        listingUrl: 'a[class*="UserItem_link"], a[href*="/listings/"]',
        title: '[class*="UserItem_title"]',
        priceText: '[data-testid="Current"], [class*="Price_root"]',
        sizeText: '[class*="UserItem_size"]',
        brandText: '[class*="UserItem_designer"]',
        image: '[class*="UserItem_listingCoverPhoto"] img, img[class*="CoverPhoto_root"]',
      },
      soldBadge: '[class*="UserItem_sold"], [class*="Sold_root"]',
      pagination: { infiniteScroll: true, endMarker: '[class*="FeedAndFilters_feed"] + [class*="end"]' },
    },

    detail: {
      urlPattern: "grailed\\.com/listings/",
      ownListingTell: 'a[href*="/sell/edit"], [data-testid="edit-listing"]',
      title: '[class*="Details_title"]',
      description: '[class*="Description_description"]',
      priceText: '[data-testid="Current"]',
      // NOT `Details_metadata`. That one node reads "Men's US 11 / EU 44*Gently
      // Used" -- size and condition joined by a bullet, which no CSS selector
      // can split. The clean size is on the tile, so the tile wins and this
      // stays unset rather than writing a joined string into the size column.
      brandText: '[class*="Designers_designer"], [class*="Details_designers"]',
      // Grailed's Product JSON-LD carries no itemCondition, and the only place
      // the condition appears is the joined node above. Left unmapped on
      // purpose; a wrong condition note is worse than none.
      gallery:
        'img[class*="Photo_picture"], img[class*="Thumbnails_thumbnail"], [class*="ListingPage_layout"] img[class*="Image_"]',
    },
  },

  // -- Vinted (US-3460) --------------------------------------------------
  //
  // Read off the founder's own live, signed-in wardrobe on 2026-09-22
  // (www.vinted.com/member/3175192152) and off a stranger's wardrobe and item
  // page in the same session, because a tell is only a tell once you have
  // watched it be ABSENT. Four owner-only controls on the wardrobe and four on
  // the item page, all eight present on the seller's own pages and all eight
  // missing on the other member's.
  //
  // THREE THINGS VINTED DOES DIFFERENTLY, and each one changed the adapter:
  //
  // 1. THE PHOTO URL CANNOT BE UPGRADED, so there is no urlUpgrade rule and
  //    the wardrobe tile's photo is not read at all. Vinted signs the render
  //    size INTO the URL: images1.vinted.net/t/<token>/310x430/<n>.webp?s=<sig>
  //    on a tile, /f800/ on the item page, and the signature covers the path.
  //    Measured on one real photo: the f800 URL loads at 600x800; the same URL
  //    with 310x430, 620x860, f1200, f2000, or with ?s= removed, all fail to
  //    load. So a string rewrite produces a BROKEN url, which is worse than a
  //    thumbnail. The tile carries no srcset and no data-src either -- one
  //    310x430 render and nothing else -- and 430 is under the server's 500px
  //    floor, so every tile photo would be refused anyway. Photos therefore
  //    come from the item page only, where they are already full size.
  // 2. THE TILE HAS NO TITLE TEXT. On your OWN wardrobe Vinted renders the
  //    SellerItemBox, whose two text lines are "0 views" and "0 favorites";
  //    the title lives only in the overlay link's `title` attribute, as
  //    "<title>, brand: X, condition: Y, size: Z, $28.00". Hence the
  //    {selector, attr, cut} field shape: read the attribute, cut at the first
  //    ", <label>: " pair. The labels are localised across the 22 hosts, the
  //    SHAPE is not. A seller title that itself contains ", word: " loses its
  //    tail; the item page's own h1 is clean and a detail read corrects it.
  // 3. BRAND, SIZE AND CONDITION ARE NOT READ FROM THE TILE. They sit in that
  //    same attribute behind localised labels, and reading them positionally
  //    would put a condition in the brand column the day Vinted reorders its
  //    template. They come from the item page, where each has its own
  //    microdata attribute.
  //
  // CLASS NAMES ARE CSS-MODULE HASHED, like Grailed's:
  // `SellerItemBox-module-scss-module__l0NZ1G__new-item-box__container`. Only
  // the stable suffix is matched.
  vinted: {
    label: "Vinted",
    enabled: true,
    verified: false,
    version: "2026.09.1",
    // The 22 locale hosts, identical to lister/selectors.js and
    // research/selectors.js. host_permissions already covers all of them.
    hosts: [
      "vinted.com", "vinted.co.uk", "vinted.fr", "vinted.de", "vinted.es",
      "vinted.it", "vinted.nl", "vinted.pl", "vinted.be", "vinted.at",
      "vinted.cz", "vinted.sk", "vinted.lt", "vinted.pt", "vinted.se",
      "vinted.ro", "vinted.hu", "vinted.lu", "vinted.hr", "vinted.gr",
      "vinted.dk", "vinted.fi",
    ],

    login: { urlPattern: "vinted\\.[a-z.]+/(member/general/login|signup)" },
    // Vinted fronts item pages with a Cloudflare managed challenge; it showed
    // up as "Just a moment... Verifying you are human" during this read and
    // cleared itself on a reload. The reader stops rather than reading the
    // interstitial's empty DOM as an empty wardrobe.
    humanCheck:
      '#challenge-running, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge"]',

    // No urlUpgrade: see note 1 above. `photosAlreadyFullSize` is what
    // closet-import-manifest.test.cjs accepts in its place, and it is a
    // sentence rather than a flag so the measurement travels with the rule.
    photosAlreadyFullSize:
      "Vinted signs the render size into the photo URL, so no rewrite is possible. " +
      "The item page already serves /f800/ (measured 600x800), which clears the " +
      "server's 500px floor; the wardrobe tile's only render is 310x430 and is not read.",
    // /t/02_01e23_2vgsfk2J5NBoXm8xt6yMSbsv/f800/1789153408.webp -- the token
    // after /t/ is the asset, and it is stable across render sizes.
    assetIdPattern: "/t/([^/]+)/",
    // Measured: one `src`, no srcset, no data-src, anywhere on either page.
    imageAttrs: ["src"],

    // -- the seller's own wardrobe -----------------------------------------
    closet: {
      // /member/<digits>. NOT a bare /member/, which would also match
      // /member/notifications and /member/items/favourite_list -- both real
      // paths on the signed-in account and neither a wardrobe.
      urlPattern: "vinted\\.[a-z.]+/member/\\d+",
      // Owner-only, all four measured present on the founder's own wardrobe
      // and absent on another member's, where a "Follow" button sits instead.
      ownClosetTell:
        'a[href="/settings/profile"], [data-testid="bump-banner"], [data-testid="closet-seller-filters"], [data-testid="bump-button"]',
      tile: '[data-testid^="product-item-id-"][class*="new-item-box__container"]',
      fields: {
        listingUrl: 'a[data-testid$="--overlay-link"]',
        title: {
          selector: 'a[data-testid$="--overlay-link"]',
          attr: "title",
          cut: ",\\s*[^,:]{1,24}:\\s",
        },
        priceText: '[data-testid$="--price-text"]',
        // sizeText, brandText and image are deliberately absent: notes 1 and 3.
      },
      // soldBadge is NOT SET, and not guessed. The account this was read from
      // has no sold listing, so no sold tile could be observed, and the fresh
      // wardrobe renders only an "Active" chip -- Vinted appears to render one
      // status chip per non-empty bucket. A guessed selector that matches
      // nothing is indistinguishable from a wardrobe with no sold items, which
      // is the failure this whole file exists to avoid. When a sold listing
      // exists, read the tile and add it here.
      //
      // Scrolling is still driven to the end because a large wardrobe was not
      // available to measure. Vinted's CATALOG uses numbered pagination
      // (`catalog-pagination--page-N`, `--next-page`); the wardrobe with ten
      // items showed no pager at all, and `?page=2` on a wardrobe is ignored.
      // So whether a 300-item wardrobe scrolls or pages is UNMEASURED, and if
      // it pages, `coverage.reachedEnd` will read true on a partial read. That
      // is the one thing to check on the first real import.
      pagination: { infiniteScroll: true, endMarker: null },
    },

    // -- one of the seller's own item pages --------------------------------
    detail: {
      // /items/9967483973-toadco-womens-size-10-gray-corduroy-stretch-pants-low
      // The numeric id LEADS the slug, like Grailed's.
      urlPattern: "vinted\\.[a-z.]+/items/\\d+",
      ownListingTell:
        '[data-testid="item-edit-button"], [data-testid="item-delete-button"], [data-testid="mark-as-sold-button"], [data-testid="item-bump-button"]',
      title: "h1",
      description: '[itemprop="description"]',
      priceText: '[data-testid="item-price"]',
      sizeText: '[itemprop="size"]',
      // The brand is the only [itemprop="name"] on an item page; the
      // breadcrumbs use itemprop="title". Scoped to the details list anyway,
      // with the brand link as the fallback.
      brandText: '.details-list__item [itemprop="name"], .details-list__item a[href*="/brand"]',
      // TRAP WORTH KNOWING: Vinted's `status` is the CONDITION ("Good"), not
      // whether the listing is live. `item-attributes-status` is the row and
      // [itemprop="status"] is its value.
      conditionText: '[itemprop="status"]',
      gallery: '[data-testid^="item-photo-"] img',
    },
  },

};

// Content scripts share one isolated world per frame, so the global makes this
// visible to closet-import/content.js, which loads after it.
if (typeof self !== "undefined") self.GT_CLOSET_IMPORT_SELECTORS = GT_CLOSET_IMPORT_SELECTORS;
