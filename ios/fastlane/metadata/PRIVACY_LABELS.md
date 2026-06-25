# App Privacy — nutrition label mapping (US-197)

App Store Connect's **App Privacy** section is configured through the web
UI, not through `deliver` metadata files. This doc is the source of truth
the operator transcribes into App Store Connect, and it mirrors
`ios/GradeThread/PrivacyInfo.xcprivacy` (the on-device manifest Apple reads
at build time). Keep all three in sync: this file, the `.xcprivacy`, and
the ASC web form.

We do **not** track users across other companies' apps/sites. No data is
used for "Tracking" in Apple's sense. No IDFA, no `ATTrackingManager`.

## Data the app collects

| Data type | ASC category | Linked to identity? | Used for tracking? | Purpose | Collected by |
|---|---|---|---|---|---|
| Email address | Contact Info → Email Address | Yes | No | App Functionality (account sign-in, support) | Supabase Auth |
| Name | Contact Info → Name | Yes | No | App Functionality (account profile) | Supabase |
| Purchase history | Purchases → Purchase History | Yes | No | App Functionality (the seller's own sales + payouts they record/import) | Supabase |
| Photos | User Content → Photos or Videos | Yes | No | App Functionality (garment photos for cataloging + grading) | Supabase Storage |
| Crash data | Diagnostics → Crash Data | No | No | App Functionality (stability) | Sentry |
| Product interaction | Usage Data → Product Interaction | No | No | Analytics (opt-out, on by default — user can disable in Settings) | PostHog |

"Purchase history" here is the reseller's **own** sales bookkeeping, not
App Store purchases. Apple's closest category is Purchase History; clarify
in the review notes if asked.

## Third-party SDK disclosures

| SDK | What it sees | Linked | Notes |
|---|---|---|---|
| Supabase (Auth/DB/Storage) | email, name, item data, photos, sales | Yes | First-party backend (self-hosted at api.gradethread.com) |
| Sentry | crash stacks, breadcrumbs, a non-PII user id | No | Crash reporting only — **always on**, independent of the product-analytics toggle; no email attached (see Telemetry facade) |
| PostHog | product-interaction events | No | **Opt-out, on by default** (user can disable in Settings → Analytics); no events when off |
| eBay OAuth (target) | OAuth tokens for the seller's eBay account | Yes | Used only to publish/sync the seller's listings |

## Age rating

Selling / commercial-activity apps generally land at **17+** on Apple's
questionnaire (the "Unrestricted Web Access" + commercial questions). The
app facilitates listing items for resale on a connected marketplace.

Answer the questionnaire honestly; if the only commercial element is the
seller listing their own goods on eBay (no gambling, no mature content),
the rating typically resolves to **17+** because of unrestricted commerce,
not content. Confirm via the live questionnaire — do not hard-code.

## Required-reason API declarations

Mirrored in `PrivacyInfo.xcprivacy`:

- **UserDefaults** — reason `CA92.1` (read/write data the app itself wrote: opt-in toggles, notification prefs, review-prompt counters)
- **File timestamp** — reason `C617.1` (timestamps of files in the app's own container: IntakeInbox manifests, App Group widget snapshot ordering)

If a new dependency adds another required-reason API (disk space, system
boot time, active keyboards), add it to the manifest **and** this list, or
the build will be flagged at upload.
