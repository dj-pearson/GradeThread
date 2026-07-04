import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// US-511: billing/checkout entry (AC#1) — an authenticated user can reach the
// billing surface (the entry point for Stripe checkout). Backend mocked.

// The consent banner overlays fixed-bottom at z-100 and intercepts clicks
// (see e2e/consent.ts) — seed a decision so it never mounts.
test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

function fakeJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: "00000000-0000-0000-0000-000000000001",
    email: "e2e@example.com", role: "authenticated", aud: "authenticated",
    aal: "aal1", iat: now, exp: now + 3600,
  })}.c2ln`;
}

async function loginMocked(page: Page) {
  const access = fakeJwt();
  const session = {
    access_token: access, token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r",
    user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "e2e@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
  };
  await page.route("**/auth/v1/token**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route("**/auth/v1/user**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session.user) }));
  await page.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // Billing summary (edge) — benign payload; the page header renders regardless.
  await page.route("**/api/payments/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: "free", credits: 0 }) }));

  await page.goto("/login");
  await page.locator('input[type="email"]').fill("e2e@example.com");
  await page.locator('input[type="password"]').fill("correct-horse");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

test("an authenticated user can reach the billing page (checkout entry)", async ({ page }) => {
  await loginMocked(page);
  await page.goto("/dashboard/billing");
  // The authed session reaches the billing entry point and is NOT bounced back
  // to /login by the auth guard — this is the checkout entry the AC asks for.
  await expect(page).toHaveURL(/\/dashboard\/billing/);
  await expect(page).not.toHaveURL(/\/login/);
});
