# App Store Submission Guide — FlipDesk by GradeThread

Operator playbook for the first App Store Connect (ASC) submission. Everything here
is derived from the shipping code (`ios/`, `services/edge-functions/src/lib/appstore/`)
— product IDs, URLs, and privacy answers MUST stay in sync with those sources.
Companion docs: `ios/fastlane/metadata/` (deliver-managed copy) and
`ios/fastlane/metadata/PRIVACY_LABELS.md` (privacy nutrition labels, US-197).

| Fact | Value |
|---|---|
| App name | FlipDesk by GradeThread (23/30 chars) |
| Bundle ID | `com.gradethread.app` |
| Version / build | 1.0.0 (1) |
| Minimum OS | iOS 17.0 — iPhone + iPad |
| Seller | Pearson Media LLC |
| Primary / secondary category | Business / Shopping (already in fastlane metadata) |
| Sign in with Apple | YES (required — Google OAuth is also offered, Guideline 4.8) |
| In-app account deletion | YES (Settings → Delete account, Guideline 5.1.1(v)) |

---

## 0. ⚠️ Guideline 2.1(a) resubmission fix — v1.0(41), rejected 2026-06-16

Apple rejected build 1.0(41) (Submission `cd47ea72-c42c-4392-b896-90984d542f09`,
iPad Air 11" M3 / iPadOS 26.5) for two auth bugs. **Both are server-side
configuration on the self-hosted GoTrue** — the iOS code change (native Turnstile
+ captcha-token plumbing, this branch) is necessary but NOT sufficient. Do **all**
of the following before resubmitting, then verify.

### Bug A — "Sign in with Apple" errored

**Root cause:** the Apple provider was never enabled on prod GoTrue
(`/auth/v1/settings` showed `"apple": false` as of 2026-06-11). The app's native
flow (`AuthStore.signInWithApple` → `signInWithIdToken(provider: .apple)`) posts
the Apple identity token to GoTrue, which rejects it because the provider is off.

**Fix (operator — Coolify env on the GoTrue/auth service, then redeploy):**
```
GOTRUE_EXTERNAL_APPLE_ENABLED=true
GOTRUE_EXTERNAL_APPLE_CLIENT_ID=com.gradethread.app   # the BUNDLE ID — GoTrue validates the token's `aud` against it
GOTRUE_EXTERNAL_APPLE_SECRET=<ES256 client-secret JWT generated from the Sign in with Apple .p8 key (Team ID + Key ID)>
```
- `CLIENT_ID` must be (or contain, comma-separated) the **bundle ID** `com.gradethread.app`, because iOS uses the native id_token flow — not a Services ID.
- The `.p8`-derived secret JWT is only exercised by the web code-exchange flow, but the auth image refuses to start the provider without it. See `vault/10-ops/env-reference.md` → "OAuth providers".
- The id_token grant is **not** captcha-gated, so once the provider is on, Apple sign-in works with no captcha involvement.

### Bug B — "Create an account" errored

**Root cause:** prod GoTrue enforces Cloudflare Turnstile captcha (US-368) on
signup / email-password sign-in / password-reset — a call without a valid
`gotrue_meta_security.captcha_token` returns HTTP 400 `captcha protection:
request disallowed`. The web app sends a Turnstile token; iOS sent none.

**Fix (two parts, both required):**
1. **iOS (done on this branch):** the app now renders a native Turnstile widget
   (`Auth/TurnstileView.swift`) and forwards the token on signup / sign-in /
   reset. Gated on `TURNSTILE_SITE_KEY` (blank → no-op, for local/CI).
2. **Operator:** add `TURNSTILE_SITE_KEY` to **Infisical (prod env)** so the
   release workflow injects it at archive time. It must be the **site** key for
   the **same** Turnstile widget whose **secret** is configured as
   `GOTRUE_SECURITY_CAPTCHA_SECRET` on prod GoTrue, and that widget's allowed
   hostnames must include `gradethread.com` (the iOS web view renders the widget
   with that origin). This is the same key as the web build's `VITE_TURNSTILE_SITE_KEY`.
   - `ios-release.yml` now **fails the archive** if `TURNSTILE_SITE_KEY` is empty
     (override with `ALLOW_NO_CAPTCHA=1` only if captcha is disabled server-side).

### Verify before resubmitting
- `curl -s https://api.gradethread.com/auth/v1/settings` → JSON shows
  `"external": { … "apple": true … }` and a non-null captcha config.
- On a TestFlight build of the new archive (real prod backend): **Sign in with
  Apple** completes to a signed-in session, and **Create account** succeeds
  (Turnstile sheet appears, then "Check your email to confirm your account").
- Confirm the archive log shows the "Require captcha site key" step passing
  (i.e. `TURNSTILE_SITE_KEY` was injected).

---

## 1. Store listing copy

All of this lives in `ios/fastlane/metadata/en-US/` and is pushed by `deliver`.
Current copy is good — kept below with character counts and alternates.

### Subtitle (30 chars max)
Current: **"Resell smarter, list faster"** (27) ✓

Alternates if A/B testing later:
- "AI listings + eBay selling" (26)
- "Snap, grade, list, get paid" (27)

### Promotional text (170 chars max — editable anytime WITHOUT a new review)
Current (145):
> Snap a photo, let AI fill the details, and list to eBay in seconds. Track sales, payouts, and profit from one tidy workspace built for resellers.

Use this field for seasonal pushes post-launch (it's the only copy you can change
without submitting a build): launch promos, new-feature callouts, sale events.

### Description (4,000 chars max)
Current `description.txt` (≈2,190 chars) is solid and accurate to the feature set.
One REQUIRED addition for auto-renewable subscriptions (Guideline 3.1.2): the
description or EULA field must link to the Terms of Use. Append this final block:

```
SUBSCRIPTIONS & CREDITS
FlipDesk offers optional auto-renewing subscriptions (Starter, Pro, Business —
monthly or yearly) and one-time grade credit packs. Payment is charged to your
Apple Account at confirmation of purchase. Subscriptions renew automatically
unless cancelled at least 24 hours before the end of the current period. Manage
or cancel anytime in your Apple Account settings.

Terms of Use: https://gradethread.com/terms
Privacy Policy: https://gradethread.com/privacy
```

> Verify `https://gradethread.com/terms` is live (it must resolve before review).
> Also paste the Terms URL into ASC → App Information → "Terms of Use (EULA)" link field.

### Keywords (100 chars max, comma-separated, no spaces needed)
Current (94): `reseller,resell,ebay,poshmark,thrift,flipping,inventory,clothing,listing,crosslist,consignment`

⚠️ Trademark risk: `ebay` and `poshmark` are third-party marks (Guideline 2.3.7).
Many apps survive with them; some get metadata-rejected. If rejected, swap to this
safe set (98 chars):
`reseller,resell,thrift,flipping,inventory,clothing,listing,consignment,depop,closet,seller,grade`
(Better: drop `depop` too if the rejection cites trademarks generally:
`reseller,resell,thrift,flip,flipping,inventory,clothing,listing,consignment,closet,seller,grading`)

Do NOT repeat words already in the name/subtitle (FlipDesk, GradeThread, resell
appears in subtitle — "resell"/"reseller" in keywords is borderline duplication;
keep "reseller" since the subtitle has "Resell").

### What's New (release notes)
Current `release_notes.txt` is fine for 1.0.

### Social / X (Twitter) description
≤280 chars, ready to post:

> Meet FlipDesk by GradeThread 📸 Snap a garment, AI fills in brand, size & condition, and you're listed on eBay in seconds — with a certified 1–10 condition grade buyers can trust. Inventory, sales & payouts in one app. iPhone + iPad. https://gradethread.com

(258 chars. Short variant, 156: "Snap a photo → AI writes the listing → live on eBay in seconds. Certified condition grades, inventory, sales & payouts in one app. https://gradethread.com")

---

## 2. Screenshots & preview (growth surface #1)

Required sets: **6.9" iPhone** (1320×2868) and **13" iPad** (2064×2752) — newer
sizes auto-scale down. 3–10 per device; first 3 are what 90% of browsers see.

Suggested storyline (matches actual screens):
1. Guided photo capture with AI fields filling in (Snap & Catalog) — hero shot
2. AI-extracted listing draft (title/description ready) — "AI does the typing"
3. Condition grade certificate (1–10 grade + factor report) — trust differentiator
4. eBay publish/sync screen — "list without leaving the app"
5. Money tab — sales, payouts, profit
6. Inventory grid with bulk actions
7. iPad three-column workspace (iPad set only)
8. Widget + notifications collage (optional)

App Preview video (15–30s, optional but high-converting for camera-driven apps):
screen-record the snap → AI fill → publish flow. No hands/devices in frame, no
pricing claims inside the video.

---

## 3. Age rating questionnaire

Answer honestly in ASC (the 2025 questionnaire produces 4+/9+/13+/16+/18+):

- All content questions (violence, sexual content, profanity, horror, drugs): **None**
- Gambling / contests: **No**
- Unrestricted web access: **No** — the app opens only specific own-domain and
  eBay-OAuth URLs in `SFSafariViewController` / `ASWebAuthenticationSession`;
  there is no general-purpose browser.
- User-generated content: the app has no user-to-user content sharing or social
  features; photos/listings are the signed-in seller's own private data → answer
  the UGC capability questions **No** (shareable certificate links are
  view-only web pages, not in-app UGC exchange).
- Commerce: the app facilitates the seller listing their own goods on a
  connected marketplace + in-app subscriptions via StoreKit.

Expected outcome: **4+** (possibly 13+ depending on how the commerce questions
resolve). Note: `PRIVACY_LABELS.md` predicted 17+ from "unrestricted web access" —
that assumption no longer holds (no open browser); let the live questionnaire
decide, never hard-code.

---

## 4. Content rights

ASC asks: "Does your app contain, display, or access third-party content?"

Answer: **No.** Everything displayed is the signed-in seller's own data — their
photos, their inventory, their eBay listings and sales accessed via their own
authorized OAuth connection. No licensed media, no scraped third-party content.

---

## 5. Export compliance (encryption)

`ITSAppUsesNonExemptEncryption = false` is already set in `ios/project.yml`
(line ~100), so ASC will NOT prompt at upload — the answer ships in the binary.

- The app uses only standard TLS/HTTPS (ATS) and the iOS Keychain — i.e., only
  encryption provided by Apple's OS. That is **exempt** under App Store export
  rules (qualifies for the (b)(1) mass-market exemption).
- **No encryption documentation upload is required.** No CCATS, no separate
  France declaration for exempt apps.
- Annual U.S. self-classification report: not required when relying solely on
  Apple's OS-provided encryption (Apple files for its own crypto). If we ever
  add our own crypto (e.g., on-device AES of stored data), revisit — set the
  key to true and answer the ASC questionnaire.

---

## 6. In-app purchases — exact ASC setup

Product IDs are compiled into the app (`ios/.../IAPProduct.swift`) and mapped on
the server (`services/edge-functions/src/lib/appstore/products.ts`). They MUST be
created in ASC **character-for-character**; a typo strands the purchase.

### 6.1 Subscription group
Create ONE group: **"FlipDesk Plans"**. Add all 6 auto-renewables. Rank levels
(controls upgrade/downgrade/crossgrade behavior):

| Level | Products (monthly + yearly share a level) | Price |
|---|---|---|
| 1 (highest) | `com.gradethread.sub.business.monthly` / `com.gradethread.sub.business.yearly` | $99/mo / $990/yr |
| 2 | `com.gradethread.sub.pro.monthly` / `com.gradethread.sub.pro.yearly` | $59/mo / $590/yr |
| 3 | `com.gradethread.sub.starter.monthly` / `com.gradethread.sub.starter.yearly` | $29/mo / $290/yr |

Group display name shown on Apple's manage-subscriptions sheet: **"FlipDesk Plans"**.

#### Per-product detail (enter exactly as shown in ASC)

> ⚠️ **ASC description limit: 45 characters** (subscription localization field). Values below are within that limit — do not expand them.

**Starter — Monthly**
| Field | Value |
|---|---|
| Reference name | FlipDesk Starter Monthly |
| Product ID | `com.gradethread.sub.starter.monthly` |
| Display name | Starter |
| Description | 250 listings · 200 AI actions · 10 grades/mo |
| Price | $29.00 / month |
| Review notes | Grants the "starter" plan tier. Allows 250 listings, 200 AI-assist actions, and 10 AI condition grading reports per billing period. The demo account has pre-loaded credits — no purchase is required to review core flows. |

**Starter — Yearly**
| Field | Value |
|---|---|
| Reference name | FlipDesk Starter Yearly |
| Product ID | `com.gradethread.sub.starter.yearly` |
| Display name | Starter (Yearly) |
| Description | 250 listings · 200 AI actions · 10 grades/mo |
| Price | $290.00 / year |
| Review notes | Same entitlements as Starter Monthly; auto-renews annually. Grants "starter" plan with 250 listings, 200 AI actions, 10 grades/month. |

**Pro — Monthly**
| Field | Value |
|---|---|
| Reference name | FlipDesk Pro Monthly |
| Product ID | `com.gradethread.sub.pro.monthly` |
| Display name | Pro |
| Description | 1,000 listings · 750 AI actions · 30 grades |
| Price | $59.00 / month |
| Review notes | Grants the "pro" plan tier. Allows 1,000 listings, 750 AI-assist actions, 30 grades/month, and unlocks the AutoLister bulk-workflow feature. |

**Pro — Yearly**
| Field | Value |
|---|---|
| Reference name | FlipDesk Pro Yearly |
| Product ID | `com.gradethread.sub.pro.yearly` |
| Display name | Pro (Yearly) |
| Description | 1,000 listings · 750 AI actions · 30 grades |
| Price | $590.00 / year |
| Review notes | Same entitlements as Pro Monthly; auto-renews annually. Grants "pro" plan with 1,000 listings, 750 AI actions, 30 grades/month, and AutoLister. |

**Business — Monthly**
| Field | Value |
|---|---|
| Reference name | FlipDesk Business Monthly |
| Product ID | `com.gradethread.sub.business.monthly` |
| Display name | Business |
| Description | Unlimited listings · team seats · API · reconciliation |
| Price | $99.00 / month |
| Review notes | Grants the "business" plan tier. Unlocks unlimited listings, team/multi-seat access, public API, and automated reconciliation. |

**Business — Yearly**
| Field | Value |
|---|---|
| Reference name | FlipDesk Business Yearly |
| Product ID | `com.gradethread.sub.business.yearly` |
| Display name | Business (Yearly) |
| Description | Unlimited listings · team seats · API · reconciliation |
| Price | $990.00 / year |
| Review notes | Same entitlements as Business Monthly; auto-renews annually. Grants "business" plan with unlimited listings, team seats, API, and reconciliation. |

⚠️ Pricing decision (yours): web Stripe prices are $29/$59/$99 with no Apple
commission. Listing identical prices in-app nets 15–30% less after Apple's cut.
Options: (a) same price, eat the margin (simplest, what the code assumes);
(b) raise Apple prices (then update `IAPProduct.swift` display expectations and
the paywall). The server maps by product ID, not price, so either works
technically. Recommend (a) for launch simplicity.

Recommended group settings:
- **Billing Grace Period: ON** (16 days) — server already handles
  `GRACE_PERIOD_EXPIRED` → lapse (`lib/appstore/notifications.ts`).
- Family Sharing: **OFF** (per-seller accounts; server has no family logic).
- Introductory offer: optional. Server handles `OFFER_REDEEMED` → `sub_active`,
  so a 7-day free trial intro offer is safe to add later to match web trials.

### 6.2 Consumables (grade credit packs)

> These are **in-app purchases** — specifically the **Consumable** IAP type. Create them in ASC under **In-App Purchases → Create New → Consumable** (NOT inside the subscription group). They are one-time, non-expiring, and can be purchased multiple times.

**10 Grade Credits**
| Field | Value |
|---|---|
| Reference name | 10 Grade Credits |
| Product ID | `com.gradethread.credits.10` |
| Display name | 10 Grade Credits |
| Description | 10 AI condition grading credits. Never expire. |
| Price | $24.99 |
| Review notes | One-time consumable. Grants 10 AI grading credits added to the user's balance. Credits are non-expiring and used one-per-grading-submission. Server grants idempotently on `transactionId`. |

**25 Grade Credits**
| Field | Value |
|---|---|
| Reference name | 25 Grade Credits |
| Product ID | `com.gradethread.credits.25` |
| Display name | 25 Grade Credits |
| Description | 25 AI condition grading credits. Never expire. |
| Price | $59.99 |
| Review notes | One-time consumable. Grants 25 AI grading credits. Credits are non-expiring and used one-per-grading-submission. Server grants idempotently on `transactionId`. |

**50 Grade Credits**
| Field | Value |
|---|---|
| Reference name | 50 Grade Credits |
| Product ID | `com.gradethread.credits.50` |
| Display name | 50 Grade Credits |
| Description | 50 AI condition grading credits. Never expire. |
| Price | $109.99 |
| Review notes | One-time consumable. Grants 50 AI grading credits. Credits are non-expiring and used one-per-grading-submission. Server grants idempotently on `transactionId`. |

**100 Grade Credits**
| Field | Value |
|---|---|
| Reference name | 100 Grade Credits |
| Product ID | `com.gradethread.credits.100` |
| Display name | 100 Grade Credits |
| Description | 100 AI condition grading credits. Never expire. |
| Price | $199.99 |
| Review notes | One-time consumable. Grants 100 AI grading credits. Credits are non-expiring and used one-per-grading-submission. Server grants idempotently on `transactionId`. |

Server grants credits idempotently via `grant_appstore_credits` RPC
(migration `00104_appstore_billing.sql`) keyed on Apple `transactionId`.

### 6.3 Per-product checklist (all 10 products)
- [ ] Localized display name + description (en-US minimum)
- [ ] Price set, **Cleared for Sale**
- [ ] **Review screenshot** uploaded (a paywall screenshot works for all)
- [ ] Attach all 10 to the 1.0 version submission (first-time IAPs review WITH the binary)

### 6.4 App Store Server Notifications (ASC → App Information) — **OPERATOR (see §6.8 step 1)**
- **Version 2** notifications (the server's `SignedDataVerifier` handles V2 JWS only).
- Production server URL: `https://functions.gradethread.com/api/webhooks/appstore`
- Sandbox server URL: same URL. (The endpoint verifies against the environment
  set by `APPSTORE_ENVIRONMENT`; for sandbox testing set it to `Sandbox` on a
  staging deploy, or accept that sandbox notifications fail verification on prod.)
- Notifications are idempotent server-side (`processed_webhook_events`,
  provider=`appstore`, keyed by `notificationUUID`) — Apple retries are safe.

### 6.5 App-specific shared secret — NOT NEEDED
The server validates StoreKit 2 **JWS signatures** with Apple's Root CA-G3
certificate chain (`lib/appstore/verify.ts`); it never calls the legacy
`verifyReceipt` endpoint. Do not generate/configure a shared secret. (If a future
feature needs the legacy endpoint, that's when one gets minted.)

### 6.6 Server environment variables (Coolify, edge-functions resource)
Add to the deploy env (and to `services/edge-functions/.env.example` — currently
missing; fold into US-779's env sync):

```
APPLE_BUNDLE_ID=com.gradethread.app
APPLE_ROOT_CA_G3_B64=<base64 of AppleRootCA-G3.cer — download from
  https://www.apple.com/certificateauthority/, convert:
  openssl x509 -inform DER -in AppleRootCA-G3.cer -outform PEM | base64 -w0>
APPLE_APP_APPLE_ID=<numeric Apple ID from ASC App Information — set after the
  app record exists; enables strict validation>
APPSTORE_ENVIRONMENT=Production
```

### 6.7 Sandbox testing before submission — **OPERATOR (see §6.8 steps 3–7)**
- Create a Sandbox Apple Account (ASC → Users and Access → Sandbox Testers).
- On a staging edge deploy with `APPSTORE_ENVIRONMENT=Sandbox`, purchase each
  tier + one credit pack; verify `users.flipdesk_plan`, `billing_source='appstore'`,
  and credit balance update; then cancel and verify `EXPIRED` lapses to free.
- Verify the Stripe-precedence guard: a user with an active Stripe sub sees the
  "managed on web" paywall state and cannot double-subscribe (`PaywallStore.managedOnWeb`).

### 6.8 Pre-submission IAP verification runbook (US-788) — run in order

Code status (done — verified by tests):
- `APPLE_APP_APPLE_ID` parsing lives in `lib/appstore/verify-config.ts` (pure,
  unit-tested in `tests/appstore-verify-config_test.ts`): unset/blank/`0`/negative
  → `undefined`, NOT the silent `0` that broke Production JWS validation. The
  verifier warns at init when it's missing in Production.
- Unknown product IDs fail closed (`classifyProduct` → `null`), covered by
  `tests/appstore-products_test.ts`.
- The `appstore` env group is now IAP-GATED (`lib/env-validation.ts`,
  `isIapEnabled`): a deploy NOT running IAP stays quiet and `/health/ready` shows
  `appstore: disabled`; once IAP is enabled (`IAP_ENABLED` truthy or any
  `APPLE_*`/`APPSTORE_*` var set) a half-configured deploy gets a loud boot warning
  + `appstore: missing: …`. Covered by `tests/env-validation_test.ts`.
- The webhook is idempotent (`processed_webhook_events`).

What remains is OPERATOR execution + ASC config:

1. **Register the V2 notification URLs in ASC** → App Information → App Store
   Server Notifications: set BOTH Production and Sandbox "Version 2" URLs to
   `https://functions.gradethread.com/api/webhooks/appstore` (§6.4).
2. **Set the server env** on a staging edge deploy (§6.6) with `IAP_ENABLED=1`,
   `APPSTORE_ENVIRONMENT=Sandbox` and the real `APPLE_BUNDLE_ID`,
   `APPLE_ROOT_CA_G3_B64`, `APPLE_APP_APPLE_ID`. Confirm the boot logs show NO
   "[BOOT] feature 'appstore' is not fully configured" warning and `GET
   /health/ready` reports `features.appstore: "ok"` (it shows `"disabled"` until
   IAP is enabled, `"missing: …"` if enabled-but-incomplete). Sandbox doesn't
   require `APPLE_APP_APPLE_ID`, but set it so the prod flip is one var change.
3. **Create a Sandbox tester** (ASC → Users and Access → Sandbox).
4. **Purchase each product** (3 sub tiers + the 4 credit packs) in a sandbox
   build; after each, assert in the DB: subscriptions →
   `users.flipdesk_plan` + `billing_source='appstore'`; credit packs →
   `grade_credit_transactions` row + balance increase (idempotent on
   `transactionId`).
5. **Expire a subscription** (sandbox renews/cancels fast); assert the
   `EXPIRED`/`GRACE_PERIOD_EXPIRED` notification lapses the user to free.
6. **Re-deliver test**: trigger an ASC "Request Test Notification" and confirm a
   200 + a `processed_webhook_events` row; re-send the same UUID → still 200, no
   double-grant.
7. Flip the prod edge to `APPSTORE_ENVIRONMENT=Production` only after the
   sandbox round-trip passes.

### 6.9 `GradeThread.storekit` reconciliation (US-1177) — **OPERATOR**

`ios/GradeThread.storekit` is the local StoreKit configuration used **only** for
Xcode/simulator testing (and the StoreKit unit tests) — it is NOT read by App
Store review; the real products live in App Store Connect (§6.1–6.2). It ships
with two placeholders that the account owner must replace before relying on local
purchase testing:

- `settings._developerTeamID` is `"TEAMID"` → set to the **10-character Apple
  Developer Team ID** (ASC → Membership, e.g. `A1B2C3D4E5`).
- `settings._applicationInternalID` is `"GradeThread"` → set to the **numeric App
  Store app ID** (ASC → App Information → "Apple ID", the same value as
  `APPLE_APP_APPLE_ID` in §6.6) once the app record exists.

These are local-config values; leaving them as placeholders does not block
submission, but a real Team ID is needed for sandbox StoreKit testing to resolve
against your account.

**Drift guard:** the ten product ids, plan/interval, credits, and reference
prices in this file (and the iOS `IAPProduct.swift` fallback) are kept in lockstep
with the canonical server map (`lib/appstore/products.ts`) by
`tests/iap-catalog-drift_test.ts`. That test asserts the ids/prices match the
server — it does **not** verify the products actually exist or are *Approved* in
App Store Connect, so confirm all **6 subscriptions + 4 consumables** are created
and Cleared for Sale per §6.3 before submitting.

> The paywall shows a runtime **"Save N%"** badge on each yearly row and a
> **"You're on Free"** header when no paid plan is active (US-1177). The savings %
> is derived from the catalog reference prices (`IAPCatalog.yearlySavingsPercent`),
> so it tracks any price change made here + on the server in one place.

---


## Analytics consent and the privacy nutrition label

US-2914. **Analytics is not on by default outside the United States**, and that
is a different declaration from "collected by default" — which is what this app
did until that story landed and what an earlier version of
`android/PLAY_STORE_SUBMISSION.md` wrongly said iOS did *not* do.

The rule, ported from `src/lib/consent-regime.ts` (web, US-2513) and
`ConsentRegime.kt` (Android, US-2897) and living in
`ios/GradeThread/Telemetry/ConsentRegime.swift`:

| Where the seller is | Analytics before they are asked |
|---|---|
| United States | on (CCPA/CPRA notice-and-opt-out) |
| EU, UK, Switzerland, everywhere else | off until they turn it on |
| Country unknown — VPN, Tor, offline, lookup failed | off (fails safe) |

An explicit choice always wins: a seller who turned it **off** stays off in the
US, and one who turned it **on** stays on in the EU.

**What to answer in App Store Connect.** *Analytics → Product Interaction* stays
**collected**, and it is still **not linked to identity for tracking** — the
identifier is the account id and no email or advertising identifier is attached. The
change is that collection is now conditional on consent outside the US, so the
"Data is used for tracking" answer remains **No** and the analytics purpose
remains declared. Do not remove the analytics declaration: it is collected for
some sellers, and a label that under-declares is as wrong as one that
over-declares.

**Crash reporting is separate and unconditional.** Sentry starts immediately at
launch regardless of the regime — crash reporting is operational rather than
product analytics, is declared non-optional in both stores' privacy forms, and
the crash most worth having is the one in the first second of a cold start,
which is inside the window the geo lookup occupies.

**The geo lookup sends nothing.** `https://gradethread.com/geo.json` is a
Cloudflare Pages Function reading the country off the network path the request
already takes — no third-party IP-geolocation service, no body, no cookie, no
identifier, and the answer is never written to disk. It must be the **Pages**
site: `functions.gradethread.com` runs on Coolify behind no Cloudflare edge, so
it could only ever answer "unknown", which fails safe and would therefore look
exactly like it was working.

## 7. App Privacy (nutrition labels)

Transcribe `ios/fastlane/metadata/PRIVACY_LABELS.md` into ASC → App Privacy.
Summary (must match `PrivacyInfo.xcprivacy`):

- **Tracking: NO** (no IDFA, no ATT, nothing shared for cross-app tracking)
- Collected, linked to identity, App Functionality: Email Address, Name,
  Purchase History (covers BOTH the seller's own sales bookkeeping AND StoreKit
  IAP records — clarify in review notes if asked), Photos (garment shots)
- Collected, NOT linked: Crash Data (Sentry, always on, non-PII user UUID),
  Product Interaction (PostHog, **opt-in only** via Settings toggle)
- Privacy Policy URL: `https://gradethread.com/privacy`
- Required-reason APIs already declared in the manifest: UserDefaults `CA92.1`,
  file timestamp `C617.1`

✅ RESOLVED (US-786): StoreKit IAP records ARE already covered by the existing
`NSPrivacyCollectedDataTypePurchaseHistory` entry (Linked, App Functionality).
There is **no separate "In-App Purchases" data type** in the privacy-manifest
schema — "Purchase History" is Apple's single purchases type, so the bookkeeping
data and the IAP purchase state map to the same declaration. In the App Store
Connect privacy questionnaire, when asked about Purchases, answer YES and select
"Purchase History" / App Functionality / linked to identity. No manifest type to
add — the prior note's "add NSPrivacyCollectedDataTypePurchases" was based on a
type code that doesn't exist.

---

## 8. Accessibility (ASC Accessibility Labels)

ASC now lets you declare supported accessibility features on the product page.
Safe to declare today (verified in code):
- **Larger Text** — Dynamic Type scaling throughout
- **Reduced Motion** — shimmer/skeleton animations respect the setting
- **Dark Interface** — full light/dark support

Do NOT declare VoiceOver / Voice Control until someone runs a real VoiceOver
pass over the intake + paywall flows (accessibility labels exist in code, but
declaring it invites targeted review). Add after testing.

---

## 9. App Review information

Files: `ios/fastlane/metadata/review_information/`.

### ⚠️ Placeholders that BLOCK submission — fix before `deliver`:
1. `demo_user.txt` / `demo_password.txt` — still `REVIEW_DEMO_*_PLACEHOLDER`.
   Create the real seeded demo account (sample inventory, listings, sales,
   payouts, eBay **sandbox** connection, a completed grade with certificate,
   and a few grade credits so the reviewer can run a grading without paying).
2. `phone_number.txt` — `+10000000000` is invalid; use a real reachable number.
3. Telemetry secrets (US-787): release builds inject `SENTRY_DSN` /
   `POSTHOG_API_KEY` / `POSTHOG_HOST` as build settings in `ios-release.yml`
   (the empty `Release.xcconfig` placeholders are intentional — CI overrides
   them, exactly like `SUPABASE_ANON_KEY`). **Add these to Infisical (prod env)**
   so the workflow can read them: `SENTRY_DSN` (required — the build now FAILS
   without it unless `ALLOW_NO_TELEMETRY=1`), `POSTHOG_API_KEY` (analytics; warns
   if absent), and for dSYM upload `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` +
   `SENTRY_PROJECT` (the upload step skips cleanly if the token is absent).

### Review notes
`ios/fastlane/metadata/review_information/notes.txt` has been updated (see file) —
the previous version told Apple that
subscriptions are NOT sold in-app, which is now false (StoreKit IAP shipped).
Key points the notes must convey: demo account is pre-populated; eBay connection
is sandbox-only (no live marketplace effects); AI suggestions are review-before-save;
IAP = StoreKit subscriptions + consumable credits, while web-managed (Stripe)
subscribers see a "managed on the web" state — which is reading existing
entitlements, not steering to external purchase (Guideline 3.1.3(b) multiplatform
services); permissions rationale; account deletion location.

---

## 10. Submission mechanics & rollout

1. **TestFlight first**: internal testing → external beta (external builds get a
   lightweight beta review; surfaces issues before the real one).
2. Upload build via Xcode/fastlane; attach all 10 IAPs to the version.
3. **Release option: Manually release this version** — decouples approval from
   launch day; flip the switch when the web side is ready (vault/10-ops/launch-checklist.md).
4. **Phased release: ON** for 1.0 updates (not applicable to the very first
   version, which goes 100% at release).
5. After approval, set `APPLE_APP_APPLE_ID` on the server env (strict JWS validation).

### Growth & marketing setup (post-approval, in ASC)
- **Promotional text** — rotate monthly; it needs no review.
- **Custom Product Pages** (up to 35): start with two — an "eBay seller" page
  (publish/sync screenshots first) and a "condition grading" page (certificate
  first) — and point ads/links at the matching page.
- **Product Page Optimization**: A/B the first screenshot (camera-AI vs certificate).
- **Apple Search Ads**: claim the brand terms ("flipdesk", "gradethread") +
  category terms (reseller inventory, ebay listing tool); custom product pages
  attach to ad variations.
- **Offer codes** (subscriptions) for influencer/creator promos in the reseller
  niche; **promo codes** (100/version) for press.
- **In-App Events** later (e.g., "Spring closet cleanout" event card).
- App Store short link + QR for the website: add a smart app banner
  (`apple-itunes-app` meta) to gradethread.com once the App ID exists.

---

## Pre-submission checklist (condensed)

- [ ] Real demo account credentials in review_information (replace placeholders)
- [ ] Real review contact phone number
- [ ] `https://gradethread.com/terms` live; Terms appended to description + EULA field
- [ ] All 10 IAP products created, priced, screenshot'd, attached to version
- [ ] Subscription group ranked; grace period ON
- [ ] **(OPERATOR — §6.8 step 1)** Server notifications V2 URL set (prod + sandbox)
- [ ] **(OPERATOR — §6.8 step 2)** `IAP_ENABLED` + `APPLE_BUNDLE_ID` / `APPLE_ROOT_CA_G3_B64` / `APPLE_APP_APPLE_ID` / `APPSTORE_ENVIRONMENT` set in Coolify; boot log shows no `appstore` warning and `/health/ready` shows `appstore: ok`
- [ ] **(OPERATOR — §6.8 steps 3–7)** Sandbox purchase round-trip verified (sub + credits + cancel + EXPIRED lapse + re-deliver idempotency)
- [ ] App Privacy labels transcribed (incl. new Purchases type)
- [ ] Age rating questionnaire completed (expect 4+/13+)
- [ ] Content rights: No third-party content
- [ ] Accessibility: Larger Text, Reduced Motion, Dark Interface declared
- [ ] Screenshots: 6.9" iPhone + 13" iPad sets
- [ ] SENTRY_DSN (+ POSTHOG_API_KEY, and SENTRY_AUTH_TOKEN/ORG/PROJECT for dSYMs)
      added to Infisical prod — injected by ios-release.yml (US-787); build fails
      without SENTRY_DSN unless ALLOW_NO_TELEMETRY=1
- [ ] TestFlight external beta passed
- [ ] Release set to Manual
