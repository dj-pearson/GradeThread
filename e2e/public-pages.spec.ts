import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// Public-page accessibility and phone-width checks in a real browser
// (web-growth plan, action 5).
//
// src/pages/__tests__/page-a11y-axe.test.tsx runs axe on three pages in jsdom
// with color-contrast OFF, because jsdom has no layout. Here the same axe-core
// runs inside Chromium against the built SPA, so contrast is computed from the
// real CSS and the pages that sell the product are covered too.
//
// axe is injected straight from the axe-core package that is already a dev
// dependency. @axe-core/playwright would add a second package for what is one
// addScriptTag plus one evaluate.
//
// Every backend call is answered here, like the other specs: nothing leaves
// the browser. The Supabase/edge hosts get an empty 200 so data widgets settle
// into their empty state instead of hanging on a request.

const require = createRequire(import.meta.url);
const AXE_SOURCE = require.resolve("axe-core/axe.min.js");

/**
 * Fixed list, drawn from PUBLIC_ROUTES (src/lib/seo/public-routes.ts) plus the
 * /tools pages, which are public but not prerendered. A fixed list on purpose:
 * a page added to the registry should be added here by a person who has looked
 * at it, not swept in and waived.
 */
const PAGES = [
  "/",
  "/pricing",
  "/how-it-works",
  "/for-resellers",
  "/faq",
  "/verify",
  "/tools/grade-checker",
  "/tools/calculators",
  "/tools/ebay-fee-calculator",
] as const;

const PHONE = { width: 375, height: 812 };

async function mockBackends(page: Page) {
  await page.route(/^https:\/\/(api|functions)\.gradethread\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

type AxeViolation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: unknown[] }>;
};

/** Serious and critical axe violations on the current page, color-contrast ON. */
async function seriousViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_SOURCE });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as {
      axe: { run: (ctx: Document, opts: object) => Promise<{ violations: AxeViolation[] }> };
    }).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target })),
    }));
  });
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

/** Readable one-line-per-rule summary, so a failure names the element. */
function describeViolations(violations: AxeViolation[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target)).join(", ")}${v.nodes.length > 3 ? ` +${v.nodes.length - 3} more` : ""}`)
    .join("\n");
}

async function openSettled(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  // The SPA mounts over the prerendered HTML; wait for a real heading so axe
  // does not run against a Suspense fallback.
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
  await mockBackends(page);
});

for (const path of PAGES) {
  test(`${path}: no serious or critical axe violations (color-contrast on)`, async ({ page }) => {
    await openSettled(page, path);
    const violations = await seriousViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test(`${path}: no horizontal scroll at 375px`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openSettled(page, path);
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth, `${path} is ${scrollWidth}px wide in a ${innerWidth}px viewport`)
      .toBeLessThanOrEqual(innerWidth);
  });
}

test("pricing: the free plan's CTA lands on signup", async ({ page }) => {
  await openSettled(page, "/pricing");
  await page.getByRole("link", { name: "Start free" }).first().click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
});
