import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// US-774: the single highest-leverage end-to-end test — the core money/grade
// loop. Seeded login → new submission with fixture images → a (mocked) grade →
// the grade report → the public certificate. The whole backend is mocked at the
// network boundary (page.route), the SAME seam the rest of the e2e suite uses, so
// there is NO real Anthropic spend and no live backend (documented seam: AC#2).
//
// It also pins the no-double-charge guard (AC#3): double-clicking "Submit for
// Grading" must fire exactly ONE /api/grade/submit (US-774 added a synchronous
// submit lock in new-submission.tsx).

const USER_ID = "00000000-0000-0000-0000-000000000001";
const SUB_ID = "44444444-4444-4444-4444-444444444444";
const CERT_ID = "55555555-5555-5555-5555-555555555555";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "garment.png");

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

// A completed submission + its grade report, returned for the detail + cert pages.
const SUBMISSION = {
  id: SUB_ID,
  user_id: USER_ID,
  garment_type: "jacket",
  garment_category: "outerwear",
  brand: "Acme",
  title: "E2E Test Jacket",
  description: "",
  status: "completed",
  payment_status: "included",
  paid_at: new Date(0).toISOString(),
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  quality_feedback: null,
  style_attributes: [],
};

const REPORT = {
  id: "66666666-6666-6666-6666-666666666666",
  submission_id: SUB_ID,
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
  detailed_notes: {},
  model_version: "composite_v2",
  human_reviewed: false,
  defects_found: [],
  detected_style_attributes: [],
  authenticity_checked: true,
  authenticity_manipulation_suspected: false,
  authenticity_screenshot_or_watermark_detected: false,
  confidence_label: "high",
};

// Counts how many times the submit endpoint was actually hit.
async function mockBackend(page: Page): Promise<{ submitCount: () => number }> {
  let submits = 0;

  // Catch-all PostgREST → empty list. Specific overrides are registered AFTER so
  // they win (Playwright checks the most-recently-added route first).
  await page.route("**/rest/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  // Auth: mocked sign-in session.
  const session = {
    access_token: fakeJwt(), token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r",
    user: {
      id: USER_ID, aud: "authenticated", role: "authenticated",
      email: "e2e@example.com", app_metadata: {}, user_metadata: {},
      created_at: new Date(0).toISOString(),
      // ProtectedRoute gates users with no confirmed email behind a verify gate.
      email_confirmed_at: new Date(0).toISOString(),
      confirmed_at: new Date(0).toISOString(),
    },
  };
  await page.route("**/auth/v1/token**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route("**/auth/v1/user**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session.user) }));

  // Edge billing summary — a COMPLETE, valid shape (new-submission reads
  // summary.grades.credit_balance etc., so a partial object would crash render).
  const billing = {
    subscription: {
      plan: "free", interval: null, status: "none", period_end: null,
      pause_until: null, cancel_at_period_end: false, trial_ends_at: null,
      stripe_customer_id: null, pending_plan: null, pending_interval: null,
      pending_effective_at: null, upcoming_invoice: null,
    },
    grades: { credit_balance: 5, included_used_this_month: 0, reset_at: null },
    usage: { active_listings: 0, marketplaces_connected: 0, ai_actions_used_this_month: 0, ai_action_limit: null },
    alerts: { thresholds: [80], last_warning: {} },
    recent_ledger: [],
  };
  await page.route("**/api/payments/billing-summary", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(billing) }));
  // Any other payments endpoint — benign.
  await page.route("**/api/payments/**", (r) => {
    if (r.request().url().includes("/billing-summary")) return r.fallback();
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  // The grade submit endpoint — mocked AI seam. Returns an included (free) paid
  // result so the pipeline "completes" without real spend. Counts every hit.
  await page.route("**/api/grade/submit", (r) => {
    submits += 1;
    r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        submissionId: SUB_ID,
        payment: { paid: true, method: "included", newIncludedUsed: 1 },
      }),
    });
  });
  // Any other grade endpoint (pay-retry, status) → benign.
  await page.route("**/api/grade/**", (r) => {
    if (r.request().url().includes("/submit")) return r.fallback();
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ submissionId: SUB_ID, status: "completed" }) });
  });

  // Profile (override the catch-all). useAuth does users.select().single(); the
  // catch-all's `[]` body resolves to a TRUTHY empty value with onboarded_at
  // undefined, which trips OnboardingFlow's first-run gate — a non-dismissible
  // modal that then intercepts the garment form. Return a real object WITH
  // onboarded_at set so onboarding never shows. `.single()` wants a bare object.
  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: USER_ID,
        email: "e2e@example.com",
        full_name: "E2E Tester",
        onboarded_at: new Date(0).toISOString(),
        use_case: "seller",
        flipdesk_plan: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      }),
    }));

  // Detail + certificate data (override the catch-all). `.single()` returns the
  // bare object.
  await page.route("**/rest/v1/submissions**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUBMISSION) }));
  await page.route("**/rest/v1/grade_reports**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPORT) }));
  await page.route("**/rest/v1/public_grade_reports**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPORT) }));
  // The detail page does disputes.select().single(); a `[]` from the catch-all
  // would parse to a truthy empty value and render a broken dispute card. Return
  // the PostgREST "no rows" shape so .single() yields data=null (no dispute).
  await page.route("**/rest/v1/disputes**", (r) =>
    r.fulfill({ status: 406, contentType: "application/json", body: JSON.stringify({ code: "PGRST116", message: "no rows" }) }));
  await page.route("**/api/content/public/certificates/**/verify", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));

  return { submitCount: () => submits };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("e2e@example.com");
  await page.locator('input[type="password"]').fill("correct-horse");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

// First-run overlays (cookie consent + the onboarding flow) render as modals
// that intercept pointer events — dismiss them before driving the form.
async function dismissOverlays(page: Page) {
  // Cookie consent first (its overlay sits above the page, blocking the modal
  // beneath it).
  const accept = page.getByRole("button", { name: /^accept$/i });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
    await expect(accept).toBeHidden();
  }

  // First-run onboarding (OnboardingFlow) is a GATED, non-dismissible modal:
  // step 0 is a "Welcome to GradeThread" screen (→ Next); step 1 requires
  // picking a use case BEFORE the "Skip tour" button appears (Escape /
  // outside-click are blocked until then). Drive that exact sequence so the
  // dialog stops intercepting the garment form beneath it. Tolerate absence so
  // the test doesn't hang if onboarding is ever disabled.
  const welcome = page.getByRole("dialog", { name: /welcome to gradethread/i });
  if (await welcome.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /^next$/i }).click(); // welcome → use case
    await page.getByRole("button", { name: /reselling/i }).click(); // required pick
    const skipTour = page.getByRole("button", { name: /skip tour/i });
    await expect(skipTour).toBeVisible();
    await skipTour.click();
  }

  // Belt-and-suspenders: close any other first-run modal (e.g. the FlipDesk
  // onboarding checklist) still intercepting pointer events. Those ARE
  // Escape-dismissible. Bounded so a sticky dialog can't hang the test.
  for (let i = 0; i < 3; i++) {
    const anyDialog = page.getByRole("dialog").first();
    if (!(await anyDialog.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
    await expect(anyDialog).toBeHidden({ timeout: 2_000 }).catch(() => {});
  }
}

async function fillGarmentInfo(page: Page) {
  // Radix selects render options in a portal with role="option".
  await page.locator("#garment-type").click();
  await page.getByRole("option").first().click();
  await page.locator("#garment-category").click();
  await page.getByRole("option").first().click();
  await page.locator("#title").fill("E2E Test Jacket");
  await page.getByRole("button", { name: "Continue" }).click();
}

async function uploadRequiredPhotos(page: Page) {
  // The first four file inputs are the required slots: front, back, label, detail.
  const inputs = page.locator('input[type="file"]');
  for (let i = 0; i < 4; i++) {
    await inputs.nth(i).setInputFiles(FIXTURE);
  }
  // Wait until all four are processed (validate + compress) and the step's
  // Continue button enables.
  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeEnabled({ timeout: 20_000 });
  await cont.click();
}

test("critical path: submit → grade → certificate, with no double-charge", async ({ page }) => {
  const backend = await mockBackend(page);
  await login(page);

  await page.goto("/dashboard/submissions/new");
  await dismissOverlays(page);
  await fillGarmentInfo(page);
  await uploadRequiredPhotos(page);

  // Review step → submit. Double-click to prove the submit lock: only ONE
  // /api/grade/submit must fire (no double charge).
  const submit = page.getByRole("button", { name: /submit for grading/i });
  await expect(submit).toBeEnabled();
  await submit.dblclick();

  // Paid (included) → routed to the submission detail page.
  await expect(page).toHaveURL(new RegExp(`/dashboard/submissions/${SUB_ID}`), { timeout: 15_000 });
  expect(backend.submitCount()).toBe(1); // AC#3: double-click did NOT double-submit

  // The grade report is visible on the detail page.
  await expect(page.locator("body")).toContainText("8.5");

  // The public certificate renders the grade.
  await page.goto(`/cert/${CERT_ID}`);
  await expect(page.locator("body")).toContainText("8.5");
  // The buyer-facing AI disclosure must be present.
  await expect(page.locator("body")).toContainText(/not a professional appraisal/i);
});
