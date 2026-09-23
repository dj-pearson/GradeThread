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
    // VERIFIED 2026-09-23 against a logged-in seller's own /order/sales table
    // and /closet/{handle}, and against a stranger's closet for ownClosetTell.
    enabled: true,
    version: "2026.09.1",
    lastVerified: "2026-09-23",

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
    login: { urlPattern: "poshmark\\.com/(login|signup)" },

    // A human check (captcha / "are you a person") stops the read and hands the
    // tab back, exactly as the engagement runner does. Never solved, never
    // retried around.
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], [data-test="captcha"]',

    // ── the seller's own Sold list ──────────────────────────────────────────
    sold: {
      // Where it lives. The observer only ever reads a page matching this.
      urlPattern: "poshmark\\.com/order/sales",
      // US-2701: the page the scheduled poll opens. It is a value FROM THIS
      // CONFIG and never from a message, the same rule newListingUrlFor follows:
      // a URL that arrived in a message is a URL somebody else chose.
      pollUrl: "https://poshmark.com/order/sales",
      required: ["row"],
      // The sales page is a desktop TABLE, one <tr> per order.
      row: "tr.my-sales-desktop-table__row",
      // Fields, all read as TEXT and handed to sync/observe.js to parse.
      //
      // There is deliberately no selector for the buyer, the recipient or the
      // shipping address, all of which are printed on this page. The observer
      // could not emit them anyway (ALLOWED_SOLD_FIELDS), and naming them here
      // would be the first half of someone doing so.
      fields: {
        // The row has NO link to the listing: the title links to the ORDER.
        // The listing id is the folder in the thumbnail path
        // (/posts/2026/09/04/<listingId>/m_<imageId>.jpeg); `extract` below
        // turns it back into a listing URL.
        listingUrl: "img.my-sales-desktop-table__thumb",
        title: "a.my-sales-desktop-table__item-title",
        priceText: "td.my-sales-desktop-table__price-col",
        dateText: "td.my-sales-desktop-table__date-col",
        orderRef: "a.my-sales-desktop-table__item-title",
      },
      // Fields read from an attribute rather than as text. `match` runs on the
      // attribute and keeps its first group; `build` substitutes it for $1.
      extract: {
        listingUrl: {
          attr: "src",
          match: "/posts/\\d{4}/\\d{2}/\\d{2}/([0-9a-f]{24})/",
          build: "https://poshmark.com/listing/$1",
        },
        orderRef: { attr: "href", match: "/order/sales/([0-9a-f]{24})" },
      },
      // A cancelled order puts the listing back up for sale, so it is not a
      // sale and must not end the item's other listings.
      skipRowIf: { selector: "td.my-sales-desktop-table__status-col", pattern: "cancel" },
      // How the list paginates, so coverage can be reported honestly.
      pagination: {
        nextButton: ".my-sales-desktop-table__pagination-btn:last-child",
        // The table has no positive end marker; its pager prints "Showing 1-20
        // of N" instead. No marker reads as not-the-end, which under-claims.
        endMarker: null,
      },
    },

    // ── the seller's own active closet ──────────────────────────────────────
    closet: {
      // `{handle}` is substituted by the content script from the page it is
      // already on. The extension holds no Poshmark handle of its own and never
      // navigates to a handle that arrived in a message (US-1876).
      urlPattern: "poshmark\\.com/closet/",
      required: ["tile", "ownClosetTell"],
      // A closet URL is /closet/{handle} for ANY seller, so the match pattern
      // alone cannot tell whose closet this is. Reading a stranger's closet
      // would post their listings to our server as if they were the seller's
      // own, and would make every one of the seller's real listings look absent.
      // This is the owner-only affordance, the same shape as the eBay
      // owner-only Revise controls in test/own-listing.test.cjs.
      // "Edit Profile" in the closet header. Checked 2026-09-23: present on the
      // seller's own closet, absent on a stranger's.
      ownClosetTell: '.closet__header__edit-profile a[href*="/edit-profile"], a[href="/user/edit-profile"]',
      tile: '.tile-grid-redesign[data-et-name="listing"]',
      fields: {
        listingUrl: "a.tile__covershot",
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
  // VERIFIED 2026-09-23 against a logged-in seller's own My listings pages.
  // The selectors file for the LISTER says to assume monthly breakage on Mercari
  // specifically, so this is the adapter most likely to go stale. The class
  // names are styled-components hashes and are never used here; everything
  // hangs off data-testid or table structure.
  mercari: {
    enabled: true,
    version: "2026.09.1",
    lastVerified: "2026-09-23",

    // mercari.com only. The .jp property is a different company and a different
    // app; matching it would be a new host permission for a site we cannot read.
    hosts: ["mercari.com"],

    login: { urlPattern: "mercari\\.com/(login|signin|account/login)" },
    humanCheck: 'iframe[src*="recaptcha"], iframe[title*="challenge"], [data-testid="captcha"]',

    sold: {
      // The seller's own sold transactions. Under /mypage/, which is
      // owner-scoped by construction -- unlike a closet, there is no version of
      // this page belonging to somebody else.
      // "Sold" in the My listings sidebar is TWO pages: In progress (sold, not
      // yet rated) and Complete. A new sale lands in In progress first, so both
      // are read. There is no /listings/sold page; that URL 404s.
      urlPattern: "mercari\\.com/(us/)?mypage/listings/(in_progress|complete)",
      pollUrl: "https://www.mercari.com/mypage/listings/in_progress/",
      required: ["row"],
      // One <tr> per item. The table first renders empty skeleton rows, which
      // have no ItemLink; the reader drops rows with neither a URL nor a title.
      row: '[data-testid="Listings"] tbody tr',
      // No buyer selector, deliberately: ALLOWED_SOLD_FIELDS could not emit one
      // anyway, and a selector for it here would be the first half of trying.
      fields: {
        listingUrl: 'a[data-testid="ItemLink"]',
        title: 'a[data-testid="ItemLink"]',
        priceText: '[data-testid="ItemPrice"]',
        // The "Updated" column, which on a sold row is the sale date (MM/DD/YY).
        dateText: "td:nth-child(6)",
        orderRef: 'a[data-testid="ViewOrderButton"]',
      },
      extract: {
        // /transaction/order_status/m123/ - the item id, which sells once.
        orderRef: { attr: "href", match: "/transaction/order_status/(m\\d+)" },
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
      // Active only. The sold pages share the /mypage/listings prefix and must
      // not also read as a closet.
      urlPattern: "mercari\\.com/(us/)?mypage/listings/active",
      required: ["tile", "ownClosetTell"],
      tile: '[data-testid="Listings"] tbody tr',
      // /mypage/ is owner-only by URL, but asserting it rather than assuming it
      // costs one selector and removes a whole class of "we read the wrong
      // page" from the failure surface.
      ownClosetTell: 'a[href*="/mypage/listings/active"]',
      fields: {
        listingUrl: 'a[data-testid="ItemLink"]',
      },
      soldBadge: '[data-testid="ItemStatusDecoration"]',
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
