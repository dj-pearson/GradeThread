import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// The Marketplaces page's first-run path in a real browser: connect eBay,
// come back from OAuth, then create the business policies eBay needs before a
// publish. It is the first thing a new reseller does, and until now only a
// jsdom render (src/pages/flipdesk/__tests__/marketplaces.test.tsx) covered it.
//
// The backend is mocked at the network boundary with page.route, the seam the
// rest of this suite uses. No Supabase, no edge, no eBay. The OAuth consent
// URL is answered with the page's own callback address, which is where eBay's
// redirect lands once the edge callback has stored the grant.

const USER_ID = "00000000-0000-0000-0000-000000000001";

test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

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

const json = (body: unknown) => ({
  status: 200, contentType: "application/json", body: JSON.stringify(body),
});

interface EbayState {
  connected: boolean;
  policiesCreated: boolean;
  createBodies: unknown[];
}

async function mockBackend(page: Page, state: EbayState) {
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

  await page.route("**/api/payments/**", (r) =>
    r.fulfill(json({
      subscription: {
        plan: "pro", interval: "month", status: "active", period_end: null,
        pause_until: null, cancel_at_period_end: false, trial_ends_at: null,
        stripe_customer_id: null, pending_plan: null, pending_interval: null,
        pending_effective_at: null, upcoming_invoice: null,
      },
      grades: { credit_balance: 5, included_used_this_month: 0, reset_at: null },
      usage: { active_listings: 0, marketplaces_connected: 0, ai_actions_used_this_month: 0, ai_action_limit: null },
      alerts: { thresholds: [80], last_warning: {} },
      recent_ledger: [],
    })));

  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill(json({
      id: USER_ID, email: "e2e@example.com", full_name: "E2E User",
      role: "user", use_case: "seller",
      onboarded_at: "2026-06-01T00:00:00.000Z",
      flipdesk_onboarded: true,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    })));

  // The connection row exists only once the OAuth round trip has happened.
  await page.route("**/rest/v1/marketplace_connections**", (r) =>
    r.fulfill(json(state.connected
      ? [{
        id: "conn-1", account_handle: "thrift_seller", is_active: true,
        token_expires_at: null, last_synced_at: null,
        analytics_access_denied: false, refresh_error: null,
      }]
      : [])));

  await page.route("**/api/flipdesk/ebay/oauth/start**", (r) => {
    // What eBay's redirect does, minus eBay: the edge callback stores the
    // grant and bounces the browser back here with ?ebay=connected.
    state.connected = true;
    const origin = new URL(page.url()).origin;
    return r.fulfill(json({
      consent_url: `${origin}/dashboard/flipdesk/marketplaces?ebay=connected`,
    }));
  });

  await page.route("**/api/flipdesk/ebay/policies", (r) =>
    r.fulfill(json(state.policiesCreated
      ? {
        policies: [
          { policy_id: "f1", policy_type: "fulfillment", policy_name: "Ship in 1 day", is_default: true },
          { policy_id: "p1", policy_type: "payment", policy_name: "Managed payments", is_default: true },
          { policy_id: "r1", policy_type: "return", policy_name: "30 day returns", is_default: true },
        ],
        defaults: {
          merchant_location_key: "home",
          fulfillment_policy_id: "f1", payment_policy_id: "p1", return_policy_id: "r1",
        },
      }
      : {
        policies: [],
        defaults: {
          merchant_location_key: "home",
          fulfillment_policy_id: null, payment_policy_id: null, return_policy_id: null,
        },
      })));

  await page.route("**/api/flipdesk/ebay/policies/create", (r) => {
    state.createBodies.push(r.request().postDataJSON());
    state.policiesCreated = true;
    return r.fulfill(json({ ok: true, created: ["fulfillment", "payment", "return"] }));
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
  await page.getByRole("button", { name: /skip tour/i })
    .click({ timeout: 8_000 }).catch(() => {});
}

test("marketplaces: connect eBay, come back from OAuth, create the policies", async ({ page }) => {
  const state: EbayState = { connected: false, policiesCreated: false, createBodies: [] };
  await mockBackend(page, state);
  await login(page);
  await page.goto("/dashboard/flipdesk/marketplaces");
  await dismissOverlays(page);

  // Disconnected: the connect step leads and the later steps wait on it.
  await expect(page.getByText("Get ready to sell on eBay")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("0 of 3 complete")).toBeVisible();
  await page.getByRole("button", { name: "Connect eBay" }).click();

  // Back from OAuth, connected, with the ship-from location already set and
  // no business policies on the account.
  await expect(page).toHaveURL(/\/dashboard\/flipdesk\/marketplaces/, { timeout: 15_000 });
  await expect(page.getByText("Connected as thrift_seller")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("2 of 3 complete")).toBeVisible();
  await expect(page.getByText("Pick a shipping, payment & return default")).toBeVisible();
  // The callback marker is stripped so a reload does not re-toast.
  await expect(page).not.toHaveURL(/ebay=connected/);

  // The policies step opens its dialog, which offers to create them.
  await page.getByRole("button", { name: "Set up" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Business policies" })).toBeVisible();
  await dialog.getByRole("button", { name: "Create these for me" }).click();

  await expect.poll(() => state.createBodies.length).toBe(1);
  expect(state.createBodies[0]).toMatchObject({
    handling_days: 1,
    shipping_cost_cents: 0,
    accepts_returns: true,
    return_days: 30,
    return_shipping_paid_by: "BUYER",
  });

  await page.keyboard.press("Escape");
  await expect(page.getByText("Ready to publish on eBay")).toBeVisible({ timeout: 15_000 });
});
