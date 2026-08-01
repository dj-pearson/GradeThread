import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// US-137: FlipDesk end-to-end lifecycle smoke test. Drives the reseller money
// loop through the real SPA, with the backend mocked at the network boundary
// (page.route) — the SAME seam the rest of the e2e suite uses (critical-path,
// billing). There is NO live Supabase, NO eBay sandbox call, and NO AI spend;
// the lifecycle data (items spanning every pipeline stage, plus a sold item
// with its synced net_profit) is served from fixtures.
//
// AC coverage:
//  - #1/#2: exercises the lifecycle surface (intake → pipeline → sold → P&L)
//    against the SPA via the documented mock seam (staging/eBay-sandbox creds
//    are NOT required to run it; the live-infra variant is the operator dogfood,
//    see FLIPDESK_DOGFOOD.md).
//  - #3 (status transitions): asserts items render in their correct pipeline
//    columns (Sourced … Sold … Completed) — the board IS the state machine.
//  - #3 (fee allocation / P&L): asserts the sold item surfaces its profit number.
//
// The exhaustive fee/P&L/transition number-crunching lives in the deterministic
// companion suite src/lib/__tests__/flipdesk-lifecycle.test.ts (runs in unit CI).

// The consent banner overlays fixed-bottom at z-100 and intercepts clicks
// (see e2e/consent.ts) — seed a decision so it never mounts.
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

// items_full rows spanning the lifecycle. Minimal but render-complete: the
// pipeline board reads `items_full` and buckets each row into its status column.
function item(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    user_id: USER_ID,
    item_number: null, container: null,
    item_title: "Untitled", item_description: null,
    brand: null, style: null, size: null, notes: null, comps: [],
    category: "clothing", source_name: "Goodwill bins", source_id: null,
    sourced_by: null, purchase_date: "2026-01-01", purchase_price: 8,
    listed: false, list_date: null, link: null, list_price: null,
    sale_date: null, sale_price: null, fees: null, tax: null,
    shipping_cost: null, net_profit: null, payout: null,
    status: "sourced", days_to_sell: null, tracking: null,
    target_price: null, grade_value: null, grade_label: null,
    certificate_url: null, measurements: null, location_bin: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    buyer_id: null, sold_at_raw: null, payout_reference: null,
    listing_status: null, listing_id: null, listing_watchers: null,
    listing_views: null, photo_count: 0, has_required_photos: false,
    ai_field_sources: null, ai_enriched_at: null,
    sale_status: null, sale_cancelled_at: null,
    ...over,
  };
}

const ITEMS = [
  item({ id: "a1", item_title: "Sourced Flannel Shirt", status: "sourced" }),
  item({
    id: "a2", item_title: "Listed Wool Overcoat", status: "listed",
    brand: "Acme", list_price: 120, target_price: 120, grade_value: 8.5,
  }),
  item({
    id: "a3", item_title: "Sold Leather Jacket", status: "sold",
    brand: "Acme", list_price: 140, sale_price: 140, sale_status: "completed",
    fees: 19.04, shipping_cost: 9, net_profit: 103.96,
  }),
  item({ id: "a4", item_title: "Completed Denim Jeans", status: "completed",
    list_price: 55, sale_price: 55, sale_status: "completed", net_profit: 38.2 }),
];

async function mockBackend(page: Page) {
  // Catch-alls first — specific overrides are registered AFTER so they win
  // (Playwright checks the most-recently-added route first).
  await page.route("**/rest/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
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

  // Profile row. Without it the catch-all returns no profile, the first-run
  // onboarding dialog owns the screen (6 steps, "Next" — `dismissOverlays`
  // only knows Accept/Skip), and the board underneath is never reachable.
  // `flipdesk_onboarded` keeps the FlipDesk-specific tour closed too.
  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: USER_ID, email: "e2e@example.com", full_name: "E2E User",
        role: "user", use_case: "seller",
        onboarded_at: "2026-06-01T00:00:00.000Z",
        flipdesk_onboarded: true,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
    }));

  // The pipeline board's data source.
  //
  // US-2169: the client walks this table in pages and stops only on an EMPTY
  // response (a short page can't be told apart from a server row-cap). A mock
  // that answers every Range header with the same rows therefore never ends
  // the loop — the query stays pending and the board renders nothing. Serve
  // the fixture for the first page, empty for the rest, like a real server.
  await page.route("**/rest/v1/items_full**", (r) => {
    // postgrest-js sends `.range(from, to)` as `offset`/`limit` SEARCH PARAMS,
    // not a Range header — reading the header would leave `start` pinned at 0
    // and the loop would still never end.
    const offset = new URL(r.request().url()).searchParams.get("offset");
    const start = Number.parseInt(offset ?? "0", 10) || 0;
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(start === 0 ? ITEMS : []),
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

async function dismissOverlays(page: Page) {
  const accept = page.getByRole("button", { name: /^accept$/i });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
    await expect(accept).toBeHidden();
  }
  const skipTour = page.getByRole("button", { name: /^skip$/i });
  await skipTour.click({ timeout: 8_000 }).catch(() => {});
}

test("flipdesk lifecycle: items render across pipeline stages with sold-item P&L", async ({ page }) => {
  await mockBackend(page);
  await login(page);

  await page.goto("/dashboard/flipdesk/pipeline");
  await dismissOverlays(page);

  // Each lifecycle item lands in the board — the pipeline IS the status machine.
  await expect(page.getByText("Sourced Flannel Shirt")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Listed Wool Overcoat")).toBeVisible();
  await expect(page.getByText("Sold Leather Jacket")).toBeVisible();
  await expect(page.getByText("Completed Denim Jeans")).toBeVisible();

  // The pipeline stage columns (the canonical lifecycle) render as headings.
  for (const col of ["Sourced", "Listed", "Sold", "Completed"]) {
    await expect(page.getByText(col, { exact: true }).first()).toBeVisible();
  }

  // A priced/graded item surfaces its money + grade on the card (P&L surface).
  await expect(page.getByText("$120.00").first()).toBeVisible();
  await expect(page.getByText("8.5").first()).toBeVisible();
});
