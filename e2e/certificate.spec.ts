import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// US-511: public certificate view (AC#1) — mocked PostgREST so no live backend.

// The consent banner overlays fixed-bottom at z-100 and intercepts clicks
// (see e2e/consent.ts) — seed a decision so it never mounts.
test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

const CERT_ID = "11111111-1111-1111-1111-111111111111";

const REPORT = {
  id: "22222222-2222-2222-2222-222222222222",
  submission_id: "33333333-3333-3333-3333-333333333333",
  certificate_id: CERT_ID,
  created_at: new Date(0).toISOString(),
  overall_score: 8.5,
  grade_tier: "excellent",
  fabric_condition_score: 8.5,
  structural_integrity_score: 9.0,
  cosmetic_appearance_score: 8.0,
  functional_elements_score: 8.5,
  odor_cleanliness_score: 9.0,
  ai_summary: "Garment is in excellent pre-owned condition with minimal wear.",
  model_version: "composite_v2",
  human_reviewed: false,
  defects_found: [],
  detected_style_attributes: [],
  authenticity_checked: true,
  authenticity_manipulation_suspected: false,
  authenticity_screenshot_or_watermark_detected: false,
  confidence_label: "high",
};

async function mockCert(page: Page, report: unknown | null) {
  // public_grade_reports uses .single() → return the object, or 406/empty for not-found.
  await page.route("**/rest/v1/public_grade_reports**", (route) => {
    if (report === null) {
      return route.fulfill({ status: 406, contentType: "application/json", body: JSON.stringify({ code: "PGRST116", message: "no rows" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report) });
  });
  // submission lookup (.single()) — minimal object.
  await page.route("**/rest/v1/submissions**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "33333333-3333-3333-3333-333333333333", garment_type: "Jacket", brand: "Acme" }) }),
  );
  await page.route("**/rest/v1/submission_images**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  // Integrity verify endpoint degrades gracefully; return a benign body.
  await page.route("**/api/content/public/certificates/**/verify", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
}

test("a valid public certificate renders the grade + AI disclosure", async ({ page }) => {
  await mockCert(page, REPORT);
  await page.goto(`/cert/${CERT_ID}`);
  // The grade is shown.
  await expect(page.locator("body")).toContainText("8.5");
  // US-514: the AI-generated disclosure must be visible to buyers.
  await expect(page.locator("body")).toContainText(/not a professional appraisal/i);
});

test("an unknown certificate shows a not-found state (route loads, no crash)", async ({ page }) => {
  await mockCert(page, null);
  await page.goto(`/cert/${CERT_ID}`);
  await expect(page.locator("body")).toContainText(/not found|invalid|couldn't|could not/i);
});
