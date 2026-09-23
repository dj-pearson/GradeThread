# Web app UX, marketing site, SEO/GEO & content

Health: **ok**

The module is well guarded in code. Routes are lazy-loaded, the prerender fails the build on a bad route, labels on form controls are at zero, and npm run ui:check passes today (src 0, functions 0 blocking). The biggest gains are not new code. They are shipping content that is already written (83 help articles, CTR title rewrites), and turning Lighthouse and accessibility checks into signals someone actually sees on the SSR pages that carry the search traffic.

## Actions

### 1. Seed the Help Center, and stop an empty /help from being indexed

Impact: high | Effort: S | Story: US-2618

**Why:** US-2618 is open: prod /help renders zero articles while content/help/ holds 83. On the code side, helpUrls always adds /help to the sitemap even when articles is empty (functions/_shared/sitemap.ts:968-970). The only robots meta in the help SSR is the search page's noindex (functions/help/[[path]].ts:277), so an empty hub is served as indexable thin content. US-2619 AC5 (/og/help) is also blocked on this seed.

**Steps:**
- Operator: run scripts/seed-help-articles.mjs against prod with the service key, as US-2618 AC5 describes
- In helpUrls, leave /help out of the sitemap when articles.length === 0
- In functions/help/[[path]].ts, give the hub robots 'noindex, follow' when the index has zero articles, and add a case to src/test/help-ssr.test.ts
- After seeding, re-check /og/help/<slug> and close US-2619 AC5

### 2. Ship the SERP title/description rewrite, and merge the two stories that describe it

Impact: high | Effort: S | Story: US-3412

**Why:** GSC shows a 1.01% CTR, with 20 pages in the top 10 getting zero clicks (US-3412 description). The same work is filed twice: US-3412 in prd.json (priority 2) and US-9017 'CTR copy pass on the page-one URLs' in prd-seo.json (priority 2). The condition-index SSR title template is named as the worst case.

**Steps:**
- Close one of US-3412 or US-9017 as a duplicate of the other
- Rewrite the top-10 zero-click registry routes in src/lib/seo/public-routes.ts so title + ' | GradeThread' is 60 chars or less
- Shorten the /condition-index/:slug title in functions/_shared/condition-index-render.ts so it leads with the answer
- Keep route-metadata.test.ts green, then annotate the GSC date so CTR can be compared at +28 days

### 3. Fix the two nested-card groups left on the homepage

Impact: medium | Effort: S | Story: none

**Why:** US-2833 (closed) found 10 nested-card pairs on / and left them unfixed. Both are still in the code: an inner card 'rounded-md border border-border bg-background p-3' at src/pages/landing.tsx:420 sits inside the card at :408, and 'mb-4 rounded-xl border border-border/50 bg-background/70 p-3' at src/pages/landing.tsx:968 sits inside a bordered, shadowed glass-card panel at :957. The :968 block copies src/components/marketing/flipdesk-pipeline-preview.tsx:28, which for-resellers.tsx already imports.

**Steps:**
- Replace the inline carousel in landing.tsx (~950-990) with the shared FlipDeskPipelinePreview component, or give both one fix
- Take off the inner border and rounding in both places, the same way pricing.tsx was fixed in commit 2a9288b64
- Pick a border or a shadow on the flipdesk-panel outer card, not both
- Re-run node scripts/check-ui-browser.mjs on / only (one URL per call) and confirm the nested-cards count drops

### 4. Make Lighthouse a signal someone sees, and point it at the SSR pages that rank

Impact: medium | Effort: M | Story: none

**Why:** Every assertion is 'warn' (lighthouserc.json, lighthouserc.mobile.json), both collect steps are continue-on-error, and the header says it 'never blocks a merge' (.github/workflows/lighthouse.yml:7-10). The results go to a PR comment, but only 10 of the last 300 commits came in through a PR. It measures only 13 prerendered static URLs from dist/. The edge-SSR pages that carry the search traffic (/condition-index/*, /blog/*, /cert/*, /help/*) are never measured, and there is no accessibility category in either config.

**Steps:**
- Add a third config that runs weekly against prod URLs: 2 condition-index pages, 1 blog post, 1 cert, /help
- Add a categories:accessibility assertion to all configs
- Promote cumulative-layout-shift and categories:seo to 'error' on the static configs once one run shows them passing
- Send the weekly result somewhere people look, such as a GitHub issue or the ops alert channel, not only the Job Summary

### 5. Run public-page accessibility and phone-width checks in a real browser

Impact: medium | Effort: M | Story: none

**Why:** Axe runs only on landing, login and signup in jsdom, with color-contrast turned off (src/pages/__tests__/page-a11y-axe.test.tsx:22-25, :41). Pricing, how-it-works, help, tools and certificate pages get no axe check. e2e/smoke.spec.ts covers just 3 pages, and the only 375px no-horizontal-scroll check is for worth-my-time (e2e/worth-my-time-live.spec.ts:243). CLAUDE.md says the Playwright suite runs in about 44s with all backends mocked, so adding more pages is cheap.

**Steps:**
- Add @axe-core/playwright as a dev dependency (axe-core ^4.12 is already present)
- Add e2e/public-pages.spec.ts that loops over a fixed list from PUBLIC_ROUTES: /, /pricing, /how-it-works, /for-resellers, /faq, /tools/*, /verify
- For each page, assert no serious or critical axe violations with color-contrast ON, and scrollWidth <= innerWidth at 375px
- Add a pricing CTA to signup click-through to the same spec
- This also gives US-2335 a browser-level check ahead of its manual screen-reader AC

### 6. Break up SettingsPage before it grows further

Impact: low | Effort: M | Story: none

**Why:** SettingsPage runs from src/pages/settings.tsx:105 to about :1340 as one component with 37 useState calls. Only three sub-cards are split out (SignOutAllCard :1341, DangerZoneCard :1383, PhotoArchiveCard :1502). No test imports SettingsPage, so its tab deep-link logic (:115-120) and form state have no tests.

**Steps:**
- Pull each TabsContent (profile, security, notifications, etc.) into its own component under src/components/settings/
- Move each tab's state into that tab's component
- Add a vitest case that ?tab=security opens the Security tab and that an unknown tab falls back to Profile
- Keep the route and the ?tab= URLs the same

## Risks

- The Help Center seed needs prod service-role credentials, so it is an operator step. Until it runs, /help stays an empty page in the sitemap on a domain with an open indexing problem (US-2095).
- The backlog has the SEO CTR work filed twice (US-3412 and US-9017). Two agents could rewrite the same titles in different ways.
- check-ui-browser.mjs is report-only and under-reports when given more than one URL per call. Any nested-cards progress must be measured one URL at a time.
- Gating Lighthouse on prod URLs adds network flakiness. Keep the prod lane report-only and gate only the static dist/ lane.
- Lighthouse and axe in CI need Playwright browser build 1223, but the cloud image has 1194. Local runs need the alias workaround in CLAUDE.md.
