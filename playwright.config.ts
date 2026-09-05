import { defineConfig, devices } from "@playwright/test";

// US-511: E2E for critical user flows. Runs against the built SPA served by
// `vite preview` (the same artifact that ships), with Supabase/Stripe calls
// mocked per-test via page.route — no live backend needed, so it runs in CI on
// an ephemeral runner.
//
// US-520: set E2E_BASE_URL to run against a REMOTE deploy instead (staging /
// a Pages preview): no local web server is started and baseURL is the remote
// URL. The page.route mocks still apply (they intercept in-browser), so specs
// stay deterministic against a live frontend. Used by staging-smoke.yml.
const PORT = 4173;
const REMOTE_BASE_URL = process.env.E2E_BASE_URL?.replace(/\/+$/, "");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: REMOTE_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // US-3063: the selector spec is its own project, so this one does not
      // also run it under the webServer it does not need.
      testIgnore: /extension-selectors\.spec\.ts$/,
    },
    // US-3063: shipped selectors resolved against captured marketplace pages.
    // Its own project because it loads fixtures with page.setContent and needs
    // NO dev server and no built SPA — the webServer below is skipped for it by
    // being irrelevant, and the separation keeps a selector failure legible as
    // "a marketplace changed" rather than as an SPA regression.
    {
      name: "extension-selectors",
      testMatch: /extension-selectors\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: undefined },
    },
  ],
  // Serve the production build. `npm run build` must have run first (CI builds
  // before the e2e job; locally run `npm run build` once). Skipped entirely
  // when targeting a remote deploy via E2E_BASE_URL.
  webServer: REMOTE_BASE_URL ? undefined : {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
