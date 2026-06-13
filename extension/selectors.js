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
    version: "2026.06.1",
    lastVerified: "2026-06-13",
    newListingUrl: "https://poshmark.com/create-listing",
    // The form is considered "present" only if every required selector resolves.
    required: ["title", "description", "submit"],
    fields: {
      title: 'input[data-test="listing-editor-title"], input[name="title"], input#title',
      description:
        'textarea[data-test="listing-editor-description"], textarea[name="description"], textarea#description',
      originalPrice: 'input[data-test="listing-editor-original-price"], input[name="originalPrice"]',
      price: 'input[data-test="listing-editor-listing-price"], input[name="listingPrice"]',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    submit:
      'button[data-test="listing-editor-submit"], button[type="submit"].listing-editor__submit, button.btn--primary[type="submit"]',
    // US-717: end a live listing. On a Poshmark listing page the owner has an
    // options/menu control exposing "Delete Listing", which opens a confirm
    // modal. Probed + fail-loud like the fill flow.
    delist: {
      enabled: true,
      version: "2026.06.1",
      lastVerified: "2026-06-13",
      required: ["menu", "remove"],
      menu:
        'button[data-test="listing-menu"], button.listing__menu, [data-et-name="listing_options"]',
      remove:
        '[data-test="delete-listing"], [data-et-name="delete_listing"], a[href*="delete"]',
      confirm:
        'button[data-test="confirm-delete"], button.btn--primary[data-et-name="yes"], button[data-et-name="confirm"]',
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
      version: "2026.06.0-draft",
      lastVerified: null,
      required: ["menu", "remove"],
      menu: 'button[data-testid="ListingMenu"], button[aria-label*="menu"]',
      remove: '[data-testid="Delete"], [data-testid="DeleteListing"]',
      confirm: 'button[data-testid="ConfirmDelete"], button[type="submit"]',
    },
  },

  // ── Grailed — PHASE 3 (not yet enabled) ───────────────────────────────
  grailed: {
    enabled: false,
    version: "2026.06.0-draft",
    lastVerified: null,
    newListingUrl: "https://www.grailed.com/sell/",
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
      version: "2026.06.0-draft",
      lastVerified: null,
      required: ["menu", "remove"],
      menu: 'button[aria-label*="actions"], button.listing-actions',
      remove: 'button[data-action="delete"], a[href*="delete"]',
      confirm: 'button[data-action="confirm-delete"], button[type="submit"]',
    },
  },
};

// Expose to the other content scripts in this isolated world.
self.GT_LISTER_SELECTORS = GT_LISTER_SELECTORS;
