import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// Regression guard for the AutoLister drafts → composer "Maximum update depth
// exceeded" (React #185) error page: an inline `data: photos = []` query
// default fed an identity-keyed setOrder effect, looping until the query
// resolved — on slow loads React hit its nested-update limit and the route
// crashed to the error boundary. The loop was timing-sensitive, so these
// tests run under 6x CPU throttling (which made the pre-fix crash 100%
// reproducible). Backend mocked at the network boundary (same seam as
// flipdesk-lifecycle.spec.ts) with data shaped like a real AutoLister batch:
// a draft listing with batch_id + aspect_review entries, saved specifics, an
// eBay category spec, and comps.

// The consent banner overlays fixed-bottom at z-100 and intercepts clicks
// (see e2e/consent.ts) — seed a decision so it never mounts.
test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ITEM_ID = "11111111-1111-1111-1111-111111111111";
const LISTING_ID = "22222222-2222-2222-2222-222222222222";
const BATCH_ID = "33333333-3333-3333-3333-333333333333";

function fakeJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: USER_ID, email: "e2e@example.com", role: "authenticated",
    aud: "authenticated", aal: "aal1", iat: now, exp: now + 3600,
  })}.c2ln`;
}

const ITEM = {
  id: ITEM_ID,
  user_id: USER_ID,
  item_number: 12, container: null,
  item_title: "Nike Dri-FIT Golf Polo Shirt Mens Large Blue Striped",
  item_description: "Nice polo, light wear.",
  brand: "Nike", style: "Polo", size: "L", notes: "small mark on hem", comps: [],
  category: "shirts", source_name: "Goodwill bins", source_id: null,
  sourced_by: null, purchase_date: "2026-06-01", purchase_price: 4,
  listed: false, list_date: null, link: null, list_price: null,
  sale_date: null, sale_price: null, fees: null, tax: null,
  shipping_cost: null, net_profit: null, payout: null,
  status: "drafted", days_to_sell: null, tracking: null,
  target_price: 24.99, grade_value: 8.5, grade_label: "Excellent",
  certificate_url: null, measurements: { chest: 23, length: 29 },
  location_bin: "A3",
  created_at: "2026-07-02T00:00:00.000Z",
  updated_at: "2026-07-02T00:00:00.000Z",
  buyer_id: null, sold_at_raw: null, payout_reference: null,
  listing_status: "draft", listing_id: LISTING_ID, listing_watchers: null,
  listing_views: null, photo_count: 3, has_required_photos: true,
  ai_field_sources: null, ai_enriched_at: "2026-07-02T00:00:00.000Z",
  sale_status: null, sale_cancelled_at: null,
};

const LISTING = {
  id: LISTING_ID,
  inventory_item_id: ITEM_ID,
  user_id: USER_ID,
  platform: "ebay",
  listing_status: "draft",
  listing_title: "Nike Dri-FIT Golf Polo Shirt Mens Large Blue Striped",
  listing_description: "<p>Nike polo in excellent shape.</p>",
  listing_price: 24.99,
  batch_id: BATCH_ID,
  created_at: "2026-07-02T01:00:00.000Z",
  updated_at: "2026-07-02T01:00:00.000Z",
  scheduled_publish_at: null,
  price_is_estimated: true,
  price_comp_source: "active_asking",
  platform_category_id: "185100",
  needs_review: true,
  aspect_review: [
    { aspect: "Department", value: "Mens", reason: "value_not_allowed" },
    { aspect: "Sleeve Length", value: "Short", reason: "value_not_allowed" },
  ],
  item_specifics_override: {
    Brand: ["Nike"],
    Department: ["Mens"],
    Size: ["L"],
    Color: ["Blue"],
    "Sleeve Length": ["Short"],
  },
  item_specifics_sources: {
    Brand: "inventory_derived",
    Department: "ai_extracted",
    Size: "inventory_derived",
    Color: "ai_extracted",
    "Sleeve Length": "ai_extracted",
  },
  ebay_condition: "USED_EXCELLENT",
  ebay_condition_description: "Excellent pre-owned condition.",
  promo_opt_out: false,
  promo_mode: "cps",
  promo_rate_pct: 8,
  listing_format: "fixed_price",
  auction_start_price_cents: null,
  auction_reserve_price_cents: null,
  auction_buy_it_now_price_cents: null,
  auction_duration: null,
  variations: null,
  primary_photo_id: "p1",
  is_active: false,
  external_listing_id: null,
  publish_error: null,
};

const EBAY_MAPPING = {
  ebay_category_id: "185100",
  ebay_aspects: LISTING.item_specifics_override,
  ebay_aspect_sources: LISTING.item_specifics_sources,
  ai_generated_aspects_at: "2026-07-02T00:30:00.000Z",
  color: "Blue",
  material: "Polyester",
  attributes: { fit: "Regular" },
};

const PHOTOS = [
  { id: "p1", inventory_item_id: ITEM_ID, user_id: USER_ID, photo_url: "/favicon.ico", thumb_url: null, photo_type: "front", sort_order: 0, width: 800, height: 800, created_at: "2026-07-02T00:00:00.000Z" },
  { id: "p2", inventory_item_id: ITEM_ID, user_id: USER_ID, photo_url: "/favicon.ico", thumb_url: null, photo_type: "back", sort_order: 1, width: 800, height: 800, created_at: "2026-07-02T00:00:00.000Z" },
  { id: "p3", inventory_item_id: ITEM_ID, user_id: USER_ID, photo_url: "/favicon.ico", thumb_url: null, photo_type: "tag", sort_order: 2, width: 800, height: 800, created_at: "2026-07-02T00:00:00.000Z" },
];

const CONNECTION = {
  id: "c1", account_handle: "reseller", token_expires_at: null,
  is_active: true, last_synced_at: "2026-07-02T00:00:00.000Z",
  analytics_access_denied: false, refresh_error: null,
};

const sel = (vals: string[]) => vals.map((v) => ({ localizedValue: v }));
const ASPECTS = {
  cached: true,
  categoryName: "Clothing > Men > Shirts > Polos",
  aspects: {
    aspects: [
      { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["Nike", "Adidas", "Puma"]) },
      { localizedAspectName: "Department", aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["Men", "Women", "Unisex Adult"]) },
      { localizedAspectName: "Size", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["S", "M", "L", "XL"]) },
      { localizedAspectName: "Type", aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["Polo", "T-Shirt", "Dress Shirt"]) },
      { localizedAspectName: "Color", aspectConstraint: { aspectRequired: false, aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["Blue", "Black", "Red", "Green", "White"]) },
      { localizedAspectName: "Sleeve Length", aspectConstraint: { aspectRequired: false, aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["Short Sleeve", "Long Sleeve"]) },
      { localizedAspectName: "Size Type", aspectConstraint: { aspectRequired: false, aspectUsage: "RECOMMENDED", aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "SINGLE" }, aspectValues: sel(["Regular", "Big & Tall"]) },
      { localizedAspectName: "Material", aspectConstraint: { aspectRequired: false, aspectUsage: "OPTIONAL", aspectMode: "FREE_TEXT", itemToAspectCardinality: "SINGLE" } },
      { localizedAspectName: "Features", aspectConstraint: { aspectRequired: false, aspectUsage: "OPTIONAL", aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "MULTI" }, aspectValues: sel(["Moisture Wicking", "Breathable", "Stretch"]) },
    ],
  },
};

const COMPS = {
  total: 40,
  items: Array.from({ length: 12 }, (_, i) => ({
    itemId: `comp-${i}`,
    title: `Nike Golf Polo comp ${i}`,
    price: 20 + i,
    currency: "USD",
    imageUrl: `https://i.ebayimg.com/images/g/fake${i}/s-l225.jpg`,
    itemWebUrl: `https://www.ebay.com/itm/${i}`,
    condition: "Pre-owned",
    source: i % 3 === 0 ? "sold" : "active",
  })),
  stats: { count: 40, min: 12, p25: 18, median: 24, p75: 30, max: 45, currency: "USD" },
  breadth: "exact", broadened: false, soldEnabled: true, minResults: 8,
};

const RECOMMENDATION = {
  recommendedCents: 2299, lowCents: 1899, highCents: 2799, currency: "USD",
  gradeValue: 8.5, basis: "ebay_sold", soldBacked: true, sufficient: true,
  confidence: 0.82,
  compSet: { source: "ebay_sold", count: 14, currency: "USD", lowCents: 1500, medianCents: 2300, highCents: 3200 },
  sellThrough: { sellThroughPct: 62, daysLow: 6, daysHigh: 18, label: "moderate", sampleSize: 14 },
};

export interface ScenarioOverrides {
  listing?: Record<string, unknown>;
  mapping?: Record<string, unknown> | null;
  aspects?: unknown;
  aspectsDelayMs?: number;
  mappingDelayMs?: number;
  aspectsStatus?: number;
}

async function mockBackend(page: Page, over: ScenarioOverrides = {}) {
  const LISTING_ROW = { ...LISTING, ...(over.listing ?? {}) };
  const MAPPING_ROW = over.mapping === null ? null : { ...EBAY_MAPPING, ...(over.mapping ?? {}) };
  const ASPECTS_BODY = over.aspects ?? ASPECTS;
  const json = (body: unknown) => ({
    status: 200, contentType: "application/json", body: JSON.stringify(body),
  });

  // Catch-alls first — later registrations win.
  await page.route("**/rest/v1/**", (r) => r.fulfill(json([])));
  await page.route("**/api/**", (r) => r.fulfill(json({})));

  const session = {
    access_token: fakeJwt(), token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r",
    user: {
      id: USER_ID, aud: "authenticated", role: "authenticated",
      email: "e2e@example.com", app_metadata: {}, user_metadata: {},
      created_at: new Date(0).toISOString(),
      email_confirmed_at: new Date(0).toISOString(),
      confirmed_at: new Date(0).toISOString(),
    },
  };
  await page.route("**/auth/v1/token**", (r) => r.fulfill(json(session)));
  await page.route("**/auth/v1/user**", (r) => r.fulfill(json(session.user)));

  // Profile row — onboarded_at set so the first-run onboarding dialog stays
  // closed (its overlay otherwise blocks every click).
  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill(json({
      id: USER_ID, email: "e2e@example.com", full_name: "E2E User",
      role: "user", use_case: "seller",
      onboarded_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    })));

  await page.route("**/rest/v1/items_full**", (r) => r.fulfill(json([ITEM])));

  await page.route("**/rest/v1/listings**", (r) => {
    const url = r.request().url();
    // Composer fetches one row via maybeSingle (object accept); the drafts
    // cockpit fetches the draft list (array).
    //
    // MATCHED AS A WHOLE PARAMETER, not as a substring. `includes("id=eq.")`
    // also matches `inventory_item_id=eq.`, which is how useItemListings reads
    // every listing for an item — so that query was handed a single OBJECT,
    // `const { data: rows = [] }` kept it (the default only fires on undefined),
    // and `flaggedListings(rows)` crashed the composer with "rows.filter is not
    // a function". Three scenarios failed identically for it, and the crash was
    // the mock's, not the product's: PostgREST returns an array for a plain
    // select, and only `.maybeSingle()` asks for an object.
    if (/[?&]id=eq\./.test(url)) return r.fulfill(json(LISTING_ROW));
    return r.fulfill(json([LISTING_ROW]));
  });

  await page.route("**/rest/v1/inventory_items**", (r) => {
    const url = r.request().url();
    if (url.includes("ebay_category_id")) {
      if (over.mappingDelayMs) {
        return new Promise<void>((res) =>
          setTimeout(() => r.fulfill(json(MAPPING_ROW)).then(res), over.mappingDelayMs));
      }
      return r.fulfill(json(MAPPING_ROW));
    }
    return r.fulfill(json([{ id: ITEM_ID, title: ITEM.item_title }]));
  });

  await page.route("**/rest/v1/item_photos**", (r) => r.fulfill(json(PHOTOS)));
  await page.route("**/rest/v1/marketplace_connections**", (r) =>
    r.fulfill(json(CONNECTION)));

  await page.route("**/api/flipdesk/ebay/policies**", (r) =>
    r.fulfill(json({
      policies: [
        { policy_id: "f1", policy_type: "fulfillment", policy_name: "Standard shipping", is_default: true },
        { policy_id: "pay1", policy_type: "payment", policy_name: "Managed payments", is_default: true },
        { policy_id: "ret1", policy_type: "return", policy_name: "30-day returns", is_default: true },
      ],
      defaults: {
        fulfillment_policy_id: "f1", payment_policy_id: "pay1",
        return_policy_id: "ret1", merchant_location_key: "loc1",
      },
    })));
  await page.route("**/api/flipdesk/ebay/category/*/aspects**", (r) => {
    const respond = () =>
      over.aspectsStatus
        ? r.fulfill({ status: over.aspectsStatus, contentType: "application/json", body: JSON.stringify({ error: "Aspect lookup failed." }) })
        : r.fulfill(json(ASPECTS_BODY));
    if (over.aspectsDelayMs) {
      return new Promise<void>((res) => setTimeout(() => respond().then(res), over.aspectsDelayMs));
    }
    return respond();
  });
  await page.route("**/api/flipdesk/ebay/comps**", (r) => r.fulfill(json(COMPS)));
  await page.route("**/api/flipdesk/pricing/price**", (r) =>
    r.fulfill(json({ recommendation: RECOMMENDATION })));
  await page.route("**/api/flipdesk/pricing/forecast**", (r) =>
    r.fulfill(json({ forecast: RECOMMENDATION.sellThrough })));
  await page.route("**/api/flipdesk/ebay/marketing/ad-rate-suggestion**", (r) =>
    r.fulfill(json({ suggested_rate_pct: 8.5 })));
  await page.route("https://i.ebayimg.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64") }));

  const billing = {
    subscription: {
      plan: "pro", interval: "month", status: "active", period_end: null,
      pause_until: null, cancel_at_period_end: false, trial_ends_at: null,
      stripe_customer_id: null, pending_plan: null, pending_interval: null,
      pending_effective_at: null, upcoming_invoice: null,
    },
    grades: { credit_balance: 5, included_used_this_month: 0, reset_at: null },
    usage: { active_listings: 1, marketplaces_connected: 1, ai_actions_used_this_month: 0, ai_action_limit: null },
    alerts: { thresholds: [80], last_warning: {} },
    recent_ledger: [],
  };
  await page.route("**/api/payments/**", (r) => r.fulfill(json(billing)));
}

export async function login(page: Page) {
  await page.goto("/login");
  // Dismiss the cookie banner if present (it intercepts pointer events).
  const cookieBtn = page
    .getByRole("dialog", { name: /cookie/i })
    .getByRole("button")
    .first();
  await cookieBtn.click({ timeout: 5_000 }).catch(() => {});
  await page.locator('input[type="email"]').fill("e2e@example.com");
  await page.locator('input[type="password"]').fill("correct-horse");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

const SCENARIOS: Array<{ name: string; over: ScenarioOverrides }> = [
  // Pre-fix, every one of these crashed under 6x throttle (the loop needed
  // only a pending item_photos query). Kept lean: the baseline, a picker-remap
  // path (mismatched saved categories), and a variation-matrix listing (also
  // guards the `variant.aspects` malformed-row crash in ListingFormatControls).
  { name: "baseline", over: {} },
  {
    name: "category mismatch listing vs mapping",
    over: { mapping: { ebay_category_id: "57990" } },
  },
  {
    name: "variations matrix (incl. malformed variant row)",
    over: {
      listing: {
        variations: {
          specifications: ["Size", "Color"],
          variants: [
            { aspects: { Size: "M", Color: "Blue" }, quantity: 1, price_cents: 2499, sku_suffix: "v1" },
            // Malformed on purpose: a variant missing `aspects` must not crash
            // the route (listing-format-controls reads it optionally).
            { quantity: 1, price_cents: 2499, sku_suffix: "v2" },
          ],
        },
      },
    },
  },
];

for (const scenario of SCENARIOS)
test(`composer does not crash: ${scenario.name}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  // Throttle the CPU so commit/effect race windows widen (mirrors a machine
  // under load) — the update loop this guards against was timing-sensitive.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });

  await mockBackend(page, scenario.over);
  await login(page);

  await page.goto("/dashboard/flipdesk/autolister/drafts");
  await expect(
    page.getByText("Nike Dri-FIT Golf Polo Shirt", { exact: false }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("link", { name: /review/i }).first().click();
  await expect(page).toHaveURL(/\/items\/.*\/draft/);
  // Give the slow-CPU page time to finish every query + effect cascade — the
  // pre-fix loop crashed within this window every time.
  await page.waitForTimeout(5000);

  // The error boundary swallows render-phase crashes (no pageerror) — detect
  // its fallback and report WHAT crashed.
  //
  // The visible <pre> carrying the message is DEV-only, so against the
  // production build this used to report `ERROR BOUNDARY: ` with nothing after
  // it. A crash that only reproduces under this test's CPU throttling was
  // therefore undiagnosable from a CI log, and stayed red for ten runs.
  // ErrorBoundary now also puts the message on `data-error-message`, in every
  // build, which is what this reads.
  const fallback = page.locator("[data-testid='error-boundary']").first();
  const boundary =
    (await fallback.isVisible().catch(() => false)) ||
    (await page.getByText("Something went wrong").isVisible().catch(() => false));
  if (boundary) {
    const detail =
      (await fallback.getAttribute("data-error-message").catch(() => null)) ||
      (await page.locator("pre, code").first().innerText().catch(() => "")) ||
      "(no message — is ErrorBoundary still setting data-error-message?)";
    errors.push(`ERROR BOUNDARY: ${detail}`);
  }
  expect(errors).toEqual([]);
});
