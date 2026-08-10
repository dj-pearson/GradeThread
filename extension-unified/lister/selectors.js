// GradeThread Lister — versioned marketplace selectors / flows (US-716)
//
// ⚠️ MARKETPLACES CHANGE THEIR LISTING FORMS WITHOUT NOTICE — esp. Mercari.
// Assume monthly breakage. Every flow below MUST `probe()` its `required`
// selectors before touching the form and FAIL LOUDLY (degrade to a clear
// "list manually" message) when any required selector is missing, rather than
// half-filling a form or silently doing nothing.
//
// To update a broken target: bump that platform's `version`, set `lastVerified`
// to the date you re-checked it against the live site, fix the selectors, and
// note what changed. The version is reported back to the SaaS + shown in the
// popup so a stale build is visible.
//
// Content scripts run in a shared isolated world per frame, so assigning to the
// global here makes GT_LISTER_SELECTORS visible to common.js + the per-platform
// script that load after it.

const GT_LISTER_SELECTORS = {
  // ── Poshmark — PHASE 1 (enabled) ──────────────────────────────────────
  poshmark: {
    enabled: true,
    version: "2026.08.0",
    // NOT bumped to today on purpose. The selectors below were written from a
    // probe report of the live page, which is evidence about the PAGE, not
    // about the fix — nobody has yet seen these resolve. It moves when a report
    // comes back clean, and until then the staleness warning is accurate.
    lastVerified: "2026-06-13",
    newListingUrl: "https://poshmark.com/create-listing",
    // US-1876: known domains a delist URL must host-match (subdomains included).
    // The background rejects any delist listingUrl outside these.
    hosts: ["poshmark.com"],
    // US-1875 AC3: how to recognise a login/interstitial page, so a logged-out
    // seller is told "log in and retry" instead of "the selectors broke". A
    // password input is the universal tell (checked in isLoginWall); these narrow
    // it for the SPA case where the URL changes but the form renders in place.
    login: { urlPattern: "poshmark\.com/(login|signup)" },
    // US-1877 (AC1): what a LIVE listing's URL looks like once the seller submits.
    // Anchored on the path so the create-listing page we opened can never match
    // itself — a false capture would record the form URL as the live listing.
    liveListingUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/listing/[^/]+",
    // The form is considered "present" only if every required selector resolves.
    required: ["title", "description", "submit"],
    // 2026-08-10, from a probe report on the live create-listing page: Poshmark
    // has REBUILT this as a multi-step wizard, and every selector below was a
    // miss. The editor now starts on a "Single Item / Multi Item" step whose
    // only inputs are title, brand and tags; price and photos moved to a later
    // step, and there is no submit button on screen at all — the primary action
    // is "Next".
    //
    // The wizard does not change what we DO here: the fill flow has never
    // auto-submitted (see runFlow in common.js — category, size and condition
    // pickers vary too much to set safely, so the seller reviews and posts).
    // `submit` is a PRESENCE PROBE, proof the editor rendered, and "Next" is
    // that proof on the new layout. Nothing clicks it.
    //
    // The placeholder anchors are the weak part and are deliberately LAST: they
    // are English-only, so a French-Canadian seller falls through to them and
    // gets "list manually" rather than the wrong field filled. Replace them the
    // moment a report shows a stable class or data-test on these inputs.
    fields: {
      title:
        'input[data-test="listing-editor-title"], input[name="title"], input#title, ' +
        'input[placeholder^="What are you selling"]',
      description:
        'textarea[data-test="listing-editor-description"], textarea[name="description"], ' +
        'textarea#description, textarea[placeholder^="Describe it"]',
      originalPrice: 'input[data-test="listing-editor-original-price"], input[name="originalPrice"]',
      price: 'input[data-test="listing-editor-listing-price"], input[name="listingPrice"]',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    submit:
      'button[data-test="listing-editor-submit"], button[type="submit"].listing-editor__submit, ' +
      'button.btn--primary[type="submit"], button[data-et-name="next"]',
    // US-717: end a live listing. On a Poshmark listing page the owner has an
    // options/menu control exposing "Delete Listing", which opens a confirm
    // modal. Probed + fail-loud like the fill flow.
    delist: {
      enabled: true,
      version: "2026.07.1",
      lastVerified: "2026-06-13",
      // US-1875 AC1: ONLY what can exist before any interaction. `remove` lives
      // inside the overflow menu and does not exist until `menu` is clicked, so
      // requiring it up front (as this did) made the probe unsatisfiable and the
      // whole enabled flow bailed out every run. It is validated after the click.
      required: ["menu"],
      menu:
        'button[data-test="listing-menu"], button.listing__menu, [data-et-name="listing_options"]',
      remove:
        '[data-test="delete-listing"], [data-et-name="delete_listing"], a[href*="delete"]',
      confirm:
        'button[data-test="confirm-delete"], button.btn--primary[data-et-name="yes"], button[data-et-name="confirm"]',
      // US-1875 AC2: proof the delete took. Poshmark bounces to the closet, so the
      // URL change is the primary signal; the listing menu vanishing and the
      // success toast are corroboration for any in-place variant.
      verify: {
        urlChanged: true,
        gone: 'button[data-test="listing-menu"], button.listing__menu',
        toast: '[data-test="toast-success"], .toast--success, [role="alert"].success',
      },
    },

    // ── Engagement automation (US-2482) ────────────────────────────────────
    //
    // Share / follow / send-offer, run in the seller's own closet tab. The caps,
    // pacing and consent gate are NOT here — they are in lister/engagement.js as
    // a pure state machine with its own tests, because those are the parts that
    // can cost a seller their closet and they must be impossible to remove by
    // editing a selector file.
    //
    // What IS here is the DOM, and one selector matters more than the others:
    // `humanCheck`. When Poshmark asks for a human check, the run pauses and the
    // seller finishes it. GradeThread does not answer it, does not route it to a
    // solving service, and does not retry around it — that is a bright line in
    // vault/60-decisions/adr-no-server-side-marketplace-automation.md §3.2, and
    // it holds even though this runs in the seller's own browser.
    engage: {
      enabled: false,
      version: "2026.08.0-draft",
      lastVerified: null,
      // The closet page a share run walks. Locale-free; Poshmark redirects an
      // unauthenticated visitor to login, which isLoginWall catches.
      closetUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/closet/",
      required: ["shareButton"],
      // Each listing tile's share control. Opens a small modal offering "To My
      // Followers" and "To a Party".
      shareButton:
        '[data-et-name="share"], button.share-grey, .tile__social-actions button[aria-label*="Share"]',
      // Inside that modal — the only target we ever click. Sharing to a party is
      // deliberately not automated: parties are themed and time-boxed, and a bot
      // sharing the wrong catalogue into one is the most visible thing a closet
      // can do.
      shareToFollowers:
        '[data-et-name="share_to_followers"], .share-modal a[href*="followers"], button[aria-label*="My Followers"]',
      followButton:
        '[data-et-name="follow"], button.btn--follow, button[aria-label^="Follow"]',
      // "Offer to Likers" on a listing the seller owns.
      offerButton:
        '[data-et-name="offer_to_likers"], button[aria-label*="Offer to Likers"]',
      offerPriceInput:
        'input[data-test="offer-price"], input[name="offerPrice"]',
      offerSubmit:
        'button[data-test="offer-submit"], button[data-et-name="submit_offer"]',
      // Poshmark's own confirmation that one action landed. Without a positive
      // signal the run would count actions it never performed, and the meter
      // would tell the seller they were safe while the real total ran ahead.
      actionConfirmed:
        '[data-test="toast-success"], .toast--success, [data-et-name="shared"]',
      // The pause signal. Broad on purpose — a missed human check means we keep
      // clicking into a wall, which is the single behaviour most likely to get a
      // closet flagged. A FALSE positive just pauses a run the seller resumes.
      humanCheck:
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="challenge"], ' +
        '[data-test="captcha"], [id*="px-captcha"], [class*="captcha"]',
    },
  },

  // ── Mercari — PHASE 2 (not yet enabled) ───────────────────────────────
  // Mercari's React SPA rewrites field ids frequently; flagged off until the
  // selectors are verified against the live sell flow. Until then the content
  // script reports "coming soon — list manually" rather than guessing.
  mercari: {
    enabled: false,
    version: "2026.06.0-draft",
    lastVerified: null,
    newListingUrl: "https://www.mercari.com/sell/",
    hosts: ["mercari.com"],
    login: { urlPattern: "mercari\.com/(signin|login|signup)" },
    liveListingUrlPattern: "^https://[^/]*mercari\\.com/(us/)?item/[^/]+",
    required: ["title", "description", "price", "submit"],
    fields: {
      title: 'input[name="name"], input[data-testid="Name"]',
      description: 'textarea[name="description"], textarea[data-testid="Description"]',
      price: 'input[name="price"], input[data-testid="Price"]',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    submit: 'button[data-testid="ListButton"], button[type="submit"]',
    delist: {
      enabled: false,
      version: "2026.07.0-draft",
      lastVerified: null,
      // US-1875 AC1: pre-interaction selectors only (see the Poshmark note).
      required: ["menu"],
      menu: 'button[data-testid="ListingMenu"], button[aria-label*="menu"]',
      remove: '[data-testid="Delete"], [data-testid="DeleteListing"]',
      confirm: 'button[data-testid="ConfirmDelete"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'button[data-testid="ListingMenu"]',
        toast: '[data-testid="Toast"], [role="alert"]',
      },
    },
  },

  // ── Grailed — PHASE 3 (not yet enabled) ───────────────────────────────
  //
  // 2026-08-10: the LIST flow is verified. A probe report from
  // grailed.com/sell/new resolved all five selectors, page verdict included.
  //
  // Still `enabled: false`, and the reason is the half that is NOT verified.
  // Turning listing on without a working delist is the oversell in Step 5 of
  // vault/30-platform/closing-a-coverage-gap.md: the item sells elsewhere, the
  // Grailed sibling stays live and purchasable, and the seller owes two people
  // one garment. `delist.menu` has only ever been checked from the sell form,
  // where it cannot exist. One report from a live listing flips both.
  grailed: {
    enabled: false,
    version: "2026.06.0-draft",
    lastVerified: null,
    newListingUrl: "https://www.grailed.com/sell/",
    hosts: ["grailed.com"],
    login: { urlPattern: "grailed\.com/(users/sign_in|login|signup)" },
    liveListingUrlPattern: "^https://[^/]*grailed\\.com/listings/[^/]+",
    required: ["title", "description", "price", "submit"],
    fields: {
      title: 'input[name="title"], input#title',
      description: 'textarea[name="description"], textarea#description',
      price: 'input[name="price"], input#price',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    submit: 'button[type="submit"].listItem, button[type="submit"]',
    delist: {
      enabled: false,
      version: "2026.07.0-draft",
      lastVerified: null,
      // US-1875 AC1: pre-interaction selectors only (see the Poshmark note).
      required: ["menu"],
      menu: 'button[aria-label*="actions"], button.listing-actions',
      remove: 'button[data-action="delete"], a[href*="delete"]',
      confirm: 'button[data-action="confirm-delete"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'button[aria-label*="actions"], button.listing-actions',
        toast: '[data-role="toast"], [role="alert"]',
      },
    },
  },

  // ── Vinted — PHASE 4 (US-2479, not yet enabled) ───────────────────────
  //
  // Vinted is EU-first and runs ~20 COUNTRY DOMAINS with the same app on each.
  // That is the whole complication: `newListingUrl` is one string everywhere
  // else, and here it depends on which Vinted the seller's account lives on.
  //
  // The answer is `locales` — a map of covered host → its new-listing URL — and
  // NOT "take the domain from the job payload". The whole point of
  // lister-guard's newListingUrlFor is that the navigation target comes from
  // this bundled config and never from a message, so an XSS on a gradethread.com
  // tab cannot steer the extension anywhere. A locale KEY from the payload is
  // fine; a URL is not. An uncovered locale resolves to null and the seller is
  // told to list manually, naming the domain — never a guess at a form on a
  // domain we have not verified (US-2479 AC2).
  vinted: {
    enabled: false,
    version: "2026.08.0-draft",
    lastVerified: null,
    // The default target when the job names no locale. vinted.com is the
    // smallest of these markets, but defaulting to a European one would silently
    // send US sellers somewhere their account does not exist.
    newListingUrl: "https://www.vinted.com/items/new",
    locales: {
      "vinted.com": "https://www.vinted.com/items/new",
      "vinted.co.uk": "https://www.vinted.co.uk/items/new",
      "vinted.fr": "https://www.vinted.fr/items/new",
      "vinted.de": "https://www.vinted.de/items/new",
      "vinted.es": "https://www.vinted.es/items/new",
      "vinted.it": "https://www.vinted.it/items/new",
      "vinted.nl": "https://www.vinted.nl/items/new",
      "vinted.pl": "https://www.vinted.pl/items/new",
      "vinted.be": "https://www.vinted.be/items/new",
      "vinted.at": "https://www.vinted.at/items/new",
      "vinted.cz": "https://www.vinted.cz/items/new",
      "vinted.sk": "https://www.vinted.sk/items/new",
      "vinted.lt": "https://www.vinted.lt/items/new",
      "vinted.pt": "https://www.vinted.pt/items/new",
      "vinted.se": "https://www.vinted.se/items/new",
      "vinted.ro": "https://www.vinted.ro/items/new",
      "vinted.hu": "https://www.vinted.hu/items/new",
      "vinted.lu": "https://www.vinted.lu/items/new",
      "vinted.hr": "https://www.vinted.hr/items/new",
      "vinted.gr": "https://www.vinted.gr/items/new",
      "vinted.dk": "https://www.vinted.dk/items/new",
      "vinted.fi": "https://www.vinted.fi/items/new",
    },
    // Every host a Vinted listing URL may live on — the delist guard's allowlist.
    // Derived from the same set as `locales` and kept identical by
    // test/vinted-locales.test.cjs, so a locale can never be listable-but-not-
    // delistable (which would leave a live listing after a sale elsewhere).
    hosts: [
      "vinted.com", "vinted.co.uk", "vinted.fr", "vinted.de", "vinted.es",
      "vinted.it", "vinted.nl", "vinted.pl", "vinted.be", "vinted.at",
      "vinted.cz", "vinted.sk", "vinted.lt", "vinted.pt", "vinted.se",
      "vinted.ro", "vinted.hu", "vinted.lu", "vinted.hr", "vinted.gr",
      "vinted.dk", "vinted.fi",
    ],
    login: { urlPattern: "vinted\\.[a-z.]+/(member/general/login|signup)" },
    // Vinted item URLs are /items/<id>-<slug> on every locale. Anchored so the
    // /items/new page we opened cannot match itself.
    liveListingUrlPattern: "^https://[^/]*vinted\\.[a-z.]+/items/\\d+",
    required: ["title", "description", "price", "submit"],
    fields: {
      title: 'input#title, input[name="title"], input[data-testid="item-title--input"]',
      description:
        'textarea#description, textarea[name="description"], textarea[data-testid="item-description--input"]',
      price: 'input#price, input[name="price"], input[data-testid="item-price--input"]',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    submit:
      'button[data-testid="upload-form-save-button"], button#upload-form-save-button, button[type="submit"]',
    delist: {
      enabled: false,
      version: "2026.08.0-draft",
      lastVerified: null,
      // Pre-interaction selectors only (see the Poshmark note) — `remove` lives
      // inside the item's action menu and does not exist until it is opened.
      required: ["menu"],
      menu:
        'button[data-testid="item-action-menu"], button[aria-label*="More"], button.item-actions',
      remove: '[data-testid="item-delete"], button[data-testid="delete-item"], a[href*="delete"]',
      confirm:
        'button[data-testid="modal-confirm-button"], button[data-testid="item-delete-confirm"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'button[data-testid="item-action-menu"], button.item-actions',
        toast: '[data-testid="notification"], [role="alert"]',
      },
    },
  },

  // ── Facebook Marketplace — PHASE 5 (US-2480, not yet enabled) ─────────
  //
  // The highest-traffic channel and the hardest to keep working. Marketplace's
  // markup is machine-generated: class names are hashed and change on every
  // deploy, so a class selector here is worthless within days. Everything below
  // is anchored on ARIA and roles — the attributes Meta's own accessibility
  // requirements stop them from churning — and the flow's fail-loud abort matters
  // more here than anywhere else, because this is the form most likely to have
  // moved since the last verification.
  //
  // Marketplace is also the one channel where "just submit it" is wrong: the
  // create flow is a multi-step dialog with a required category and condition,
  // so the seller finishes it. We prefill what is unambiguous and stop.
  facebook: {
    enabled: false,
    version: "2026.08.0-draft",
    lastVerified: null,
    newListingUrl: "https://www.facebook.com/marketplace/create/item",
    hosts: ["facebook.com", "fb.com"],
    login: { urlPattern: "facebook\\.com/(login|checkpoint|recover)" },
    // A live Marketplace listing is /marketplace/item/<numeric id>. Anchored so
    // /marketplace/create/item can never match itself.
    liveListingUrlPattern: "^https://[^/]*facebook\\.com/marketplace/item/\\d+",
    required: ["title", "price", "submit"],
    fields: {
      // Marketplace labels its inputs rather than naming them; aria-label is the
      // only stable handle. Multiple spellings because the label text is
      // localised and Meta A/B-tests the wording.
      title:
        'input[aria-label="Title"], input[aria-label*="Title"], label[aria-label="Title"] input',
      price:
        'input[aria-label="Price"], input[aria-label*="Price"], label[aria-label="Price"] input',
      description:
        'textarea[aria-label="Description"], textarea[aria-label*="Description"], label[aria-label="Description"] textarea',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    // "Next" on the first step of the create dialog, not a final publish — the
    // seller picks category/condition and publishes. Deliberate: auto-publishing
    // an incomplete Marketplace listing gets it removed and the account flagged.
    submit:
      'div[aria-label="Next"][role="button"], div[aria-label="Publish"][role="button"], button[type="submit"]',
    delist: {
      enabled: false,
      version: "2026.08.0-draft",
      lastVerified: null,
      required: ["menu"],
      menu:
        'div[aria-label="More options"][role="button"], div[aria-label*="More"][role="button"], [aria-label="Actions for this listing"]',
      remove:
        'div[role="menuitem"][aria-label*="Delete"], div[role="menuitem"][aria-label*="Remove"]',
      confirm:
        'div[aria-label="Delete"][role="button"], div[aria-label="Confirm"][role="button"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'div[aria-label="More options"][role="button"]',
        toast: '[role="alert"], [aria-live="assertive"]',
      },
    },
  },
};

// Expose to the other content scripts in this isolated world.
self.GT_LISTER_SELECTORS = GT_LISTER_SELECTORS;
