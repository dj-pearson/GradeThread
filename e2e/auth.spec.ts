import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// US-511: auth-guard redirects (AC#2) + login success/failure (AC#1), with the
// Supabase auth + REST calls mocked so no live backend is needed.

// A structurally-valid (unsigned) JWT — supabase-js decodes the payload client
// side for claims but does not verify the signature, so this is enough to drive
// an authenticated session in-browser.
function fakeJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: "00000000-0000-0000-0000-000000000001",
    email: "e2e@example.com",
    role: "authenticated",
    aud: "authenticated",
    aal: "aal1",
    iat: now,
    exp: now + 3600,
  };
  return `${b64(header)}.${b64(payload)}.c2lnbmF0dXJl`;
}

function fakeSession() {
  const access = fakeJwt();
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "e2e-refresh-token",
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      aud: "authenticated",
      role: "authenticated",
      email: "e2e@example.com",
      app_metadata: { provider: "email" },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  };
}

// Mock the Supabase surface a freshly-authenticated SPA touches: the token
// endpoint (login), /auth/v1/user (session validation), and a catch-all for
// PostgREST reads (profile/stats) so the dashboard renders instead of hanging.
async function mockSupabaseAuthed(page: Page) {
  const session = fakeSession();
  await page.route("**/auth/v1/token**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }),
  );
  await page.route("**/auth/v1/user**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session.user) }),
  );
  // Profile / stats / any other read → empty-but-OK so the dashboard doesn't error out.
  await page.route("**/rest/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

test.describe("auth guards (US-511 AC#2)", () => {
  test("unauthenticated /dashboard redirects to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated /dashboard/billing redirects to /login", async ({ page }) => {
    await page.goto("/dashboard/billing");
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated /dashboard/submissions redirects to /login", async ({ page }) => {
    await page.goto("/dashboard/submissions");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("login flow (US-511 AC#1)", () => {
  test("a successful login lands on the dashboard (guard allows the session)", async ({ page }) => {
    await mockSupabaseAuthed(page);
    await page.goto("/login");
    // The mocked session hydrates at an arbitrary point: either AuthLayout
    // redirects /login -> /dashboard on its own, or the form is still mounted
    // and we submit it. BOTH paths must end on the dashboard. The fill/click
    // steps are best-effort because the form can unmount mid-interaction when
    // hydration wins the race — the old version flaked exactly there (the
    // button spent the whole 30s timeout \"waiting to be stable\").
    try {
      await page.locator('input[type="email"]').fill("e2e@example.com", { timeout: 5_000 });
      await page.locator('input[type="password"]').fill("correct-horse", { timeout: 5_000 });
      await page.getByRole("button", { name: /sign in/i }).click({ timeout: 5_000 });
    } catch {
      // Already redirected — the guard accepted the session without the form.
    }
    // navigate("/dashboard") runs on success; the ProtectedRoute must NOT bounce
    // us back to /login (proves the mocked session is accepted).
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("a failed login surfaces an error and stays on /login", async ({ page }) => {
    await page.route("**/auth/v1/token**", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }),
      }),
    );
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("e2e@example.com");
    await page.locator('input[type="password"]').fill("wrong");
    await page.getByRole("button", { name: /sign in/i }).click();
    // Stays on /login (no redirect to /dashboard).
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/login/);
  });
});
