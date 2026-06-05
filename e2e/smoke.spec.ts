import { expect, test } from "@playwright/test";

// US-511: harness smoke + public page loads.
test("landing page renders the hero (prerendered, no JS needed)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/GradeThread|Clothing Condition Grading/i);
  // Hero text is in the prerendered HTML.
  await expect(page.locator("body")).toContainText(/Clothing Condition Grading/i);
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
