// GradeThread sold-sync — versioned selectors for the seller's OWN pages (US-2698).
//
// Separate from lister/selectors.js on purpose. That file describes the SELL
// FORM; this one describes the seller's Sold list and their active closet. They
// break independently, they are verified independently, and merging them would
// mean one stale date covering two different claims.
//
// ⚠️ `enabled` STARTS FALSE AND STAYS FALSE UNTIL A HUMAN CHECKS IT.
// Every page below is behind a login, so nothing in CI can verify a selector
// here. scripts/verify-lister-selectors.mjs refuses `enabled: true` with a null
// `lastVerified` for exactly this reason: enabling claims somebody loaded the
// real page, and a null date says nobody did.
//
// To enable: open your own Sold page and closet, run the popup's "Check
// selectors", fix what misses, set `lastVerified` to that date, bump `version`,
// and flip `enabled`.

const GT_SYNC_SELECTORS = {
  poshmark: {
    // NOT VERIFIED. Written from the public structure of the pages; no human has
    // loaded a logged-in closet against it. See the header.
    enabled: false,
    version: "2026.08.1-draft",
    lastVerified: null,

    // The delist guard's host rule applies here too: a page outside this list is
    // never read, so a lookalike domain cannot feed us observations.
    // poshmark.com ONLY. The .ca locale is deliberately absent: it is not in
    // manifest host_permissions, and submission-kit.test.cjs pins the host count
    // at 28 because every one of them is justified line by line to store review.
    // A locale we cannot read reports that it cannot, which is the same rule the
    // Vinted lister follows rather than guessing at a page.
    hosts: ["poshmark.com"],

    // US-1875's rule, reused: a logged-out seller must be told "log in", not
    // "the selectors broke", and an empty closet from a login page must never
    // read as an empty closet.
    login: { urlPattern: "poshmark\\.(com|ca)/(login|signup)" },

    // A human check (captcha / "are you a person") stops the read and hands the
    // tab back, exactly as the engagement runner does. Never solved, never
    // retried around.
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], [data-test="captcha"]',

    // ── the seller's own Sold list ──────────────────────────────────────────
    sold: {
      // Where it lives. The observer only ever reads a page matching this.
      urlPattern: "poshmark\\.(com|ca)/order/sales",
      required: ["row"],
      row: '[data-test="order-item"], [data-et-name="order_item"], .order-item',
      // Fields, all read as TEXT and handed to sync/observe.js to parse.
      //
      // There is deliberately no selector for the buyer, the recipient or the
      // shipping address, all of which are printed on this page. The observer
      // could not emit them anyway (ALLOWED_SOLD_FIELDS), and naming them here
      // would be the first half of someone doing so.
      fields: {
        listingUrl: 'a[href*="/listing/"]',
        title: '[data-test="order-title"], .order-item__title, a[href*="/listing/"]',
        priceText: '[data-test="order-price"], .order-item__price',
        dateText: '[data-test="order-date"], .order-item__date, time',
        orderRef: '[data-test="order-number"], .order-item__number',
      },
      // How the list paginates, so coverage can be reported honestly.
      pagination: {
        nextButton: '[data-test="pagination-next"], button[aria-label="Next"]',
        // Present when there are no further pages. Absence of `nextButton` is
        // also treated as the end; this is the positive signal when it exists.
        endMarker: '[data-test="pagination-end"]',
      },
    },

    // ── the seller's own active closet ──────────────────────────────────────
    closet: {
      // `{handle}` is substituted by the content script from the page it is
      // already on. The extension holds no Poshmark handle of its own and never
      // navigates to a handle that arrived in a message (US-1876).
      urlPattern: "poshmark\\.(com|ca)/closet/",
      required: ["tile", "ownClosetTell"],
      // A closet URL is /closet/{handle} for ANY seller, so the match pattern
      // alone cannot tell whose closet this is. Reading a stranger's closet
      // would post their listings to our server as if they were the seller's
      // own, and would make every one of the seller's real listings look absent.
      // This is the owner-only affordance, the same shape as the eBay
      // owner-only Revise controls in test/own-listing.test.cjs.
      ownClosetTell: '[data-test="closet-edit"], [data-test="bulk-actions"], a[href="/edit-profile"]',
      tile: '[data-test="closet-item"], .tile, [data-et-name="listing"]',
      fields: {
        listingUrl: 'a[href*="/listing/"]',
      },
      // A sold overlay on a closet tile means the tile is not evidence of a LIVE
      // listing. Counting it as live would make a sold item look present and
      // suppress the very absence signal we came for.
      soldBadge: '[data-test="sold-tag"], .sold-tag, .tile__inventory-tag--sold',
      pagination: {
        // Poshmark's closet is an infinite scroll rather than paged. The content
        // script scrolls until the count stops growing, and reports reachedEnd
        // only when the end marker appears.
        infiniteScroll: true,
        endMarker: '[data-test="closet-end"], .closet__end',
      },
    },
  },

  // ── Mercari (US-2700) ───────────────────────────────────────────────────
  //
  // Added second precisely to prove the intake is platform-agnostic: this whole
  // adapter is selectors and page shapes, with no new server code and no new
  // content-script logic. If a second marketplace had needed either, the split
  // between "the extension observes" and "the server decides" would have been
  // in the wrong place.
  //
  // ⚠️ NOT VERIFIED, same as Poshmark. The selectors file for the LISTER says to
  // assume monthly breakage on Mercari specifically -- it rewrites its React
  // field ids often -- so this adapter is the one most likely to be stale by the
  // time anyone reads it. Re-check before trusting the date.
  mercari: {
    enabled: false,
    version: "2026.08.1-draft",
    lastVerified: null,

    // mercari.com only. The .jp property is a different company and a different
    // app; matching it would be a new host permission for a site we cannot read.
    hosts: ["mercari.com"],

    login: { urlPattern: "mercari\\.com/(login|signin|account/login)" },
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], [data-testid="captcha"]',

    sold: {
      // The seller's own sold transactions. Under /mypage/, which is
      // owner-scoped by construction -- unlike a closet, there is no version of
      // this page belonging to somebody else.
      urlPattern: "mercari\\.com/mypage/(listings/sold|transactions)",
      required: ["row"],
      row: '[data-testid="ListingCard"], [data-testid="TransactionCard"], li[data-testid*="item"]',
      // No buyer selector, deliberately: the transaction row names the buyer,
      // and ALLOWED_SOLD_FIELDS could not emit it anyway. A selector for it here
      // would be the first half of someone trying.
      fields: {
        listingUrl: 'a[href*="/item/"]',
        title: '[data-testid="ListingCard__ItemName"], [data-testid="item-name"]',
        priceText: '[data-testid="ListingCard__Price"], [data-testid="item-price"]',
        dateText: '[data-testid="ListingCard__Date"], time',
        orderRef: '[data-testid="TransactionCard__OrderId"]',
      },
      pagination: {
        // Mercari pages its sold list rather than infinite-scrolling it, which
        // is the one place its shape differs from Poshmark's. A numbered pager
        // means a passive read CAN legitimately reach the end, so unlike the
        // Poshmark closet this flow is capable of reporting complete coverage.
        nextButton: '[data-testid="pagination-next"], button[aria-label="Next"], a[rel="next"]',
        endMarker: '[data-testid="pagination-last-active"]',
      },
    },

    closet: {
      // The seller's own listing list, also under /mypage/.
      urlPattern: "mercari\\.com/mypage/listings",
      required: ["tile", "ownClosetTell"],
      tile: '[data-testid="ListingCard"], li[data-testid*="item"]',
      // /mypage/ is owner-only by URL, but asserting it rather than assuming it
      // costs one selector and removes a whole class of "we read the wrong
      // page" from the failure surface.
      ownClosetTell: '[data-testid="mypage-nav"], a[href*="/mypage/listings"], [data-testid="EditListingButton"]',
      fields: {
        listingUrl: 'a[href*="/item/"]',
      },
      soldBadge: '[data-testid="ListingCard__SoldBadge"], [data-testid="sold-label"]',
      pagination: {
        nextButton: '[data-testid="pagination-next"], button[aria-label="Next"], a[rel="next"]',
        endMarker: '[data-testid="pagination-last-active"]',
      },
    },
  },
};

// Content scripts share one isolated world per frame, so the global makes this
// visible to the sync content script that loads after it.
if (typeof self !== "undefined") self.GT_SYNC_SELECTORS = GT_SYNC_SELECTORS;
