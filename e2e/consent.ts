import type { Page } from "@playwright/test";

/**
 * Seed a stored cookie-consent decision BEFORE any app code runs, so the
 * location-aware consent banner (fixed bottom, z-100) never mounts. Without
 * this the banner overlays the bottom of centered forms in the test viewport
 * and INTERCEPTS POINTER EVENTS — the login button was "visible, enabled and
 * stable" yet unclickable for the whole timeout (how the auth spec broke when
 * the privacy epic landed). Deny-all mirrors what a GPC visitor gets, so
 * seeding it changes nothing else about the page under test.
 */
export async function seedCookieConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        "gt_cookie_consent",
        JSON.stringify({ analytics: false, marketing: false }),
      );
    } catch {
      /* storage unavailable — the banner will show; tests may flake */
    }
  });
}
