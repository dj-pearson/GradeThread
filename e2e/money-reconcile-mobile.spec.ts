import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// Money M13: Reconcile inside Money at phone width. The four inner tabs and
// the photo board toolbar used to overflow a 375px screen, so the page
// scrolled sideways. Below sm the tabs are a picker now and the toolbar
// wraps. The backend is mocked with page.route, as the rest of this suite is.

const USER_ID = "00000000-0000-0000-0000-000000000001";

test.use({ viewport: { width: 375, height: 812 } });

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

async function mockBackend(page: Page) {
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
  // The plan read has a real shape; an empty object crashes usePlanUsage.
  await page.route("**/api/payments/**", (r) =>
    r.fulfill(json({
      subscription: {
        plan: "business", interval: "month", status: "active", period_end: null,
        pause_until: null, cancel_at_period_end: false, trial_ends_at: null,
        stripe_customer_id: null, pending_plan: null, pending_interval: null,
        pending_effective_at: null, upcoming_invoice: null,
      },
      grades: { credit_balance: 5, included_used_this_month: 0, reset_at: null },
      usage: { active_listings: 0, marketplaces_connected: 0, ai_actions_used_this_month: 0, ai_action_limit: null },
      alerts: { thresholds: [80], last_warning: {} },
      recent_ledger: [],
    })));
  await page.route("**/auth/v1/token**", (r) => r.fulfill(json(session)));
  await page.route("**/auth/v1/user**", (r) => r.fulfill(json(session.user)));
  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill(json({
      id: USER_ID, email: "e2e@example.com", full_name: "E2E User",
      role: "user", use_case: "seller",
      onboarded_at: "2026-06-01T00:00:00.000Z",
      flipdesk_onboarded: true,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    })));
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("e2e@example.com");
  await page.locator('input[type="password"]').fill("correct-horse");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, "the page scrolls sideways at 375px").toBeLessThanOrEqual(0);
}

test("reconcile at 375px: payouts first, a tab picker, and no sideways scroll", async ({ page }) => {
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/money?view=reconcile");
  await page.getByRole("button", { name: /skip tour/i })
    .click({ timeout: 8_000 }).catch(() => {});

  const picker = page.locator("#reconcile-tab");
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await expect(picker).toContainText("Payouts");
  await expect(page.getByText("Import payouts")).toBeVisible();
  await noSideScroll(page);

  await page.goto("/dashboard/flipdesk/money?view=reconcile&tab=photos");
  await expect(page.getByText("Photo Dump Reconcile")).toBeVisible({ timeout: 15_000 });
  await noSideScroll(page);
});

test("the retired /reconciliation link keeps its inner tab", async ({ page }) => {
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/reconciliation?tab=payouts");
  await expect(page).toHaveURL(/view=reconcile/, { timeout: 15_000 });
  await expect(page).toHaveURL(/tab=payouts/);
});
