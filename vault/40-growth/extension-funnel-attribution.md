---
title: Browser-extension funnel attribution
type: contract
status: current
source_of_truth: vault
code_refs:
  - extension-unified/attribution.js
  - extension-unified/test/attribution.test.cjs
  - src/lib/ad-attribution.ts
  - src/lib/utm-attribution-sync.ts
reviewed: 2026-09-02
tags: [extension, attribution, growth, funnel, utm]
summary: Every link out of the browser extension goes through one tagger, and the install funnel is joined to signups by a campaign tag rather than by an install identifier.
---

# Browser-extension funnel attribution (US-1753)

The extension is a growth surface: a shopper meets GradeThread on someone else's
marketplace, and every link back to gradethread.com is the top of the signup
funnel. This note is the rule that keeps that funnel measurable.

## The rule

**No file in `extension-unified/` may hand-build a `https://gradethread.com/…`
link.** Every one goes through `self.GT_ATTRIBUTION`:

- `siteUrl(path, medium, { campaign, params })` — build one from a path.
- `decorate(url, medium, { campaign, params })` — tag a URL the SERVER built.

`extension-unified/test/attribution.test.cjs` scans every shipped `.js`/`.html`
for a string-literal or `href` site URL and fails the build on any that is not in
its tiny per-file allowlist. Adding an allowlist entry is a decision to keep a
link outside the funnel — make it in a diff someone reads, not by accident.

## What the tagger guarantees

| Param | Value | Why |
|---|---|---|
| `utm_source` | always `extension` | the channel |
| `utm_medium` | the surface: `popup`, `overlay`, `onboarding`, `flip` | which UI produced the click |
| `utm_campaign` | optional; `install` is reserved (see below) | separates the install funnel from ordinary use |
| `utm_content` | `v<manifest version>` | the release cohort — two store releases are two cohorts |

Two behaviours are deliberate and must survive any rewrite:

1. **An existing utm value wins.** `services/edge-functions/src/routes/public-grading.ts`
   builds its own deep links (`/tools/grade-checker` as `second-opinion`,
   `/signup` as `gate`, the fit surface as `fit`) with the medium that describes
   the SERVER's intent. `decorate()` fills in only what is missing. Overwriting
   the server's medium would make those surfaces indistinguishable in the channel
   report.
2. **A third party's URL is returned untouched.** The overlay renders marketplace
   links through the same code path. Tagging one rewrites someone else's URL;
   dropping it breaks the link.

## The install half

Store dashboards report installs. Joining a *signup* back to an install needs a
marker that crosses from the extension to the site — and the one marker we
deliberately do **not** send is an install identifier.

So the join rides a link the user chose to click:

- `background.js` `onInstalled` (reason `install`) opens
  `onboarding.html?first_run=1` and records `installedAt` / `installVersion` in
  `storage.local`. Both stay on the device.
- `onboarding.js` reads `?first_run=1` and tags that page's outbound links
  `utm_campaign=install`. A later reopen of the same page is a real visit but not
  an install, and is tagged `onboarding` instead — counting reopens as installs
  would inflate the funnel every time.
- The site closes the loop with no extension-specific code: `captureUtms()` in
  `src/main.tsx` stores the set first-party on landing,
  `src/lib/utm-attribution-sync.ts` POSTs it to `/api/attribution/utm` once the
  visitor authenticates, and the admin analytics channel table groups by
  source/medium/campaign.

**No new data collection.** utm params are our own query string on our own site.
The per-install `instanceId` is a grading rate-limit key and stays out of these
URLs, which is what keeps the store data-collection disclosures in
`extension-unified/SUBMISSION.md` true. Do not "improve" the join by shipping the
instance id to the site.

## Where to look (US-9210 AC3)

**PostHog insight: [Extension install funnel, weekly](https://us.posthog.com/project/464669/insights/BXwMwdiW)**
— three weekly series: pageviews tagged `utm_source=extension` with
`utm_campaign=install` (a first-run page click, the nearest thing to an install
the site can see), pageviews from `popup` or `overlay` (a read that clicked
through), and `extension_install_cta_click` on the site. Created 2026-09-02 and
already carrying real rows: 3 installs and 3 reads in the week of 2026-08-09, 4
and 5 the week after.

**The signup leg is NOT in that insight, and that is deliberate.** `trial.started`
and `signup_started_from_tool` have never been recorded in this project -- checked
over 180 days on 2026-09-02, zero rows for either. Analytics only initialises
after the visitor grants consent, so a web signup by anyone who declined is
invisible to PostHog by design. Signup attribution rides the first-party path
instead: `captureUtms()` stores the set on landing, `utm-attribution-sync.ts`
POSTs it once the visitor authenticates, and the admin analytics channel table
groups by source/medium/campaign. Read the signup half there, not in PostHog, and
never sum the two.

## The failure mode this replaced

Tags were hand-written per call site, so there were three shapes of the same
string — and the overlay's "Watch on GradeThread" link, the highest-intent click
in the whole extension, had none at all. Every account it created was filed as
direct traffic. Nothing errored; the number was just quietly wrong, which is the
only way this class of bug ever presents.

## Related

- [[seo-distribution-and-measurement]] — the rest of the measurement surface
- [[adr-poshmark-via-extension]] — why the extension exists as a channel at all
- [[flipdesk-plan-gating]] — what the seller-side links upsell into
- [[INDEX]]
