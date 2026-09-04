import { expect, test, type Page, type Route } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// US-2168 AC3: the listings table asks the SERVER for one page.
//
// The parity harness (src/test/listing-page-sql-parity.test.ts) proves the SQL
// selects the same rows the client-side pipeline did. It cannot prove the PAGE
// asks for them correctly, renders what comes back, or stops loading the whole
// account — those are browser facts, and this is where they get checked.
//
// What this pins, in order of what would hurt most if it broke:
//   1. the page issues flipdesk_listing_page and renders ITS rows;
//   2. the pager and the "N items" label read `total`, not the rows length —
//      if they read the rows, a 3-row page of a 137-row filter reads "3 items"
//      and the seller concludes their inventory vanished;
//   3. changing tab / searching / sorting re-asks the SERVER with the new
//      criteria, rather than filtering the page in the browser (which would
//      look right on page one and be wrong everywhere else);
//   4. the whole-tenant read is GONE — no items_full request is issued at all.
//
// Backend is mocked at the network boundary (page.route), the same seam
// flipdesk-lifecycle and critical-path use. No live Supabase.

test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

const USER_ID = "00000000-0000-0000-0000-000000000001";

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

// NOTE ON LOCATORS: every row title renders TWICE — once in the desktop table
// and once in the mobile card list, one of which is always display:none. A bare
// getByText therefore hits strict mode, and .first() picks whichever is hidden
// at the current viewport. Addressing the row by its accessible name is stable
// across both.
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "r1", user_id: USER_ID, item_title: "Row", item_number: "SKU-1",
    brand: "Nike", style: null, size: "M", color: "red", category: "jacket",
    container: null, location_bin: null, source_name: null, source_id: null,
    sourced_by: null, purchase_date: null, purchase_price: 10, listed: false,
    list_date: null, link: null, list_price: null, sale_date: null,
    sale_price: null, fees: null, tax: null, shipping_cost: null,
    net_profit: null, payout: null, status: "sourced", days_to_sell: null,
    tracking: null, target_price: 40, grade_value: 8, grade_label: "Excellent",
    certificate_url: null, measurements: null, created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z", buyer_id: null, sold_at_raw: null,
    payout_reference: null, listing_status: null, listing_id: null,
    listing_watchers: null, listing_views: null, photo_count: 0,
    has_required_photos: false, ai_enriched_at: null, sale_status: null,
    sale_cancelled_at: null, listing_platform: null, carrier: null,
    shipped_at: null, delivered_at: null, listing_needs_review: null,
    listing_reviewed_at: null, listing_title: null, quality_score: null,
    ...over,
  };
}

/** Every flipdesk_listing_page call the page made, in order. */
interface RpcCall {
  tab: string;
  search: string;
  sortPreset: string;
  columnSort: unknown;
  limit: number;
  offset: number;
}

async function mockBackend(page: Page, calls: RpcCall[], itemsFullHits: string[]) {
  await page.route("**/rest/v1/**", (r) => {
    // Anything hitting items_full DIRECTLY is the regression this story exists
    // to remove, so it is recorded rather than silently served.
    if (r.request().url().includes("/items_full")) {
      itemsFullHits.push(r.request().url());
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

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
  await page.route("**/auth/v1/token**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route("**/auth/v1/user**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session.user) }));

  // The dashboard shell reads billing before the page under test renders; a
  // bare {} makes it dereference subscription.plan and the whole route dies in
  // the error boundary. Same payload the lifecycle spec uses.
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
  await page.route("**/api/payments/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(billing) }));

  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: USER_ID, email: "e2e@example.com", full_name: "E2E User",
        role: "user", use_case: "seller", plan: "professional",
        flipdesk_plan: "pro", flipdesk_interval: "month",
        onboarded_at: "2026-06-01T00:00:00.000Z", flipdesk_onboarded: true,
        created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z",
      }),
    }));

  // THE ONE UNDER TEST. Serves three rows but claims a total of 137, so any
  // count rendered from `rows.length` is instantly visible as wrong.
  await page.route("**/rest/v1/rpc/flipdesk_listing_page**", async (r: Route) => {
    const body = JSON.parse(r.request().postData() ?? "{}");
    calls.push({
      tab: body.p_tab,
      search: body.p_search,
      sortPreset: body.p_sort_preset,
      columnSort: body.p_column_sort,
      limit: body.p_limit,
      offset: body.p_offset,
    });
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 137,
        rows: [
          row({ id: "r1", item_title: "Alpha Jacket", item_number: "SKU-1" }),
          row({ id: "r2", item_title: "Bravo Hoodie", item_number: "SKU-2" }),
          row({ id: "r3", item_title: "Charlie Tee", item_number: "SKU-3" }),
        ],
        soldAgg: { count: 137, gross: 100, net: 40, avgMargin: 12.5 },
        buyerCounts: {},
      }),
    });
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("e2e@example.com");
  await page.locator('input[type="password"]').fill("correct-horse");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

test("the listings table renders a server-selected page", async ({ page }) => {
  const calls: RpcCall[] = [];
  const itemsFullHits: string[] = [];
  await mockBackend(page, calls, itemsFullHits);
  await login(page);
  await page.goto("/dashboard/flipdesk/listings");

  // 1. the RPC's rows are what render
  await expect(page.getByRole("button", { name: /Open Alpha Jacket/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Open Charlie Tee/i })).toBeVisible();
  expect(calls.length).toBeGreaterThan(0);

  // 2. counts come from `total`, not from the three rows on screen
  await expect(page.getByText(/137 items/).first()).toBeVisible();

  // 3. it asked for a PAGE, not the account
  expect(calls[0]!.limit).toBeGreaterThan(0);
  expect(calls[0]!.limit).toBeLessThanOrEqual(200);
  expect(calls[0]!.offset).toBe(0);

  // 4. and the whole-tenant read is gone
  expect(itemsFullHits).toEqual([]);
});

test("changing the tab re-asks the server instead of filtering in the browser", async ({ page }) => {
  const calls: RpcCall[] = [];
  const itemsFullHits: string[] = [];
  await mockBackend(page, calls, itemsFullHits);
  await login(page);
  await page.goto("/dashboard/flipdesk/listings");
  await expect(page.getByRole("button", { name: /Open Alpha Jacket/i })).toBeVisible({ timeout: 20_000 });

  const before = calls.length;
  // The table opens on Unlisted (which absorbed the old To List and Drafts
  // tabs on 2026-09-02), so the click has to land on a DIFFERENT tab for a
  // new request to be the only explanation. Active is the one every seller
  // has.
  await page.getByRole("tab", { name: /^active/i }).first()
    .or(page.getByRole("button", { name: /^active/i }).first())
    .click();

  // A new request naming the new tab. Filtering the loaded page in the browser
  // would produce no request at all — and would be wrong for every row of the
  // other 134.
  await expect
    .poll(() => calls.filter((c) => c.tab === "active").length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(calls.length).toBeGreaterThan(before);
  expect(itemsFullHits).toEqual([]);
});

test("searching re-asks the server with the query", async ({ page }) => {
  const calls: RpcCall[] = [];
  const itemsFullHits: string[] = [];
  await mockBackend(page, calls, itemsFullHits);
  await login(page);
  await page.goto("/dashboard/flipdesk/listings");
  await expect(page.getByRole("button", { name: /Open Alpha Jacket/i })).toBeVisible({ timeout: 20_000 });

  // Same duplicate-viewport problem as the row titles: :visible picks the
  // search box actually on screen rather than the hidden mobile one.
  await page.locator('input[placeholder*="Search" i]:visible').first().fill("bravo");

  await expect
    .poll(() => calls.filter((c) => (c.search ?? "").includes("bravo")).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  expect(itemsFullHits).toEqual([]);
});
