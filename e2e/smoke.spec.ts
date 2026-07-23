import { expect, test } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// US-511: harness smoke + public page loads.
// The consent banner overlays fixed-bottom at z-100 and intercepts clicks
// (see e2e/consent.ts) — seed a decision so it never mounts.
test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

test("landing page renders the hero (prerendered, no JS needed)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/GradeThread/i);
  // Hero text is in the prerendered HTML — keep in step with the prerender
  // crawl-parity assertions for "/" (src/prerender/__tests__).
  await expect(page.locator("body")).toContainText(/Photograph it\./i);
});

test("login page renders the email + password form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("signup page renders", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.locator('input[type="email"]')).toBeVisible();
});
