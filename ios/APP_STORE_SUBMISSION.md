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

Display names: "Starter", "Pro", "Business" (+ "(Yearly)" suffix on annual).
Group display name shown on Apple's manage-subscriptions sheet: "FlipDesk Plans".

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

| Product ID | Display name | Price |
|---|---|---|
| `com.gradethread.credits.10` | 10 Grade Credits | $24.99 |
| `com.gradethread.credits.25` | 25 Grade Credits | $59.99 |
| `com.gradethread.credits.50` | 50 Grade Credits | $109.99 |
| `com.gradethread.credits.100` | 100 Grade Credits | $199.99 |

Description (each): "Credits for AI condition grading reports. Credits never expire."
Server grants credits idempotently via `grant_appstore_credits` RPC
(migration `00104_appstore_billing.sql`) keyed on Apple `transactionId`.

### 6.3 Per-product checklist (all 10 products)
- [ ] Localized display name + description (en-US minimum)
- [ ] Price set, **Cleared for Sale**
- [ ] **Review screenshot** uploaded (a paywall screenshot works for all)
- [ ] Attach all 10 to the 1.0 version submission (first-time IAPs review WITH the binary)

### 6.4 App Store Server Notifications (ASC → App Information)
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

### 6.7 Sandbox testing before submission
- Create a Sandbox Apple Account (ASC → Users and Access → Sandbox Testers).
- On a staging edge deploy with `APPSTORE_ENVIRONMENT=Sandbox`, purchase each
  tier + one credit pack; verify `users.flipdesk_plan`, `billing_source='appstore'`,
  and credit balance update; then cancel and verify `EXPIRED` lapses to free.
- Verify the Stripe-precedence guard: a user with an active Stripe sub sees the
  "managed on web" paywall state and cannot double-subscribe (`PaywallStore.managedOnWeb`).

---

## 7. App Privacy (nutrition labels)

Transcribe `ios/fastlane/metadata/PRIVACY_LABELS.md` into ASC → App Privacy.
Summary (must match `PrivacyInfo.xcprivacy`):

- **Tracking: NO** (no IDFA, no ATT, nothing shared for cross-app tracking)
- Collected, linked to identity, App Functionality: Email Address, Name,
  Purchase History (the seller's own sales bookkeeping — clarify in review notes
  if asked), Photos (garment shots)
- Collected, NOT linked: Crash Data (Sentry, always on, non-PII user UUID),
  Product Interaction (PostHog, **opt-in only** via Settings toggle)
- Privacy Policy URL: `https://gradethread.com/privacy`
- Required-reason APIs already declared in the manifest: UserDefaults `CA92.1`,
  file timestamp `C617.1`

⚠️ One new addition since that doc was written: **In-App Purchase history** —
with StoreKit IAP live, also declare "Purchases" as collected (App Functionality,
linked to identity), covering both the bookkeeping data AND Apple purchase state.

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
3. `Release.xcconfig` — `SENTRY_DSN` is an empty placeholder; set it (or ship
   knowingly without crash reporting).

### Review notes
`notes.txt` has been updated (see file) — the previous version told Apple that
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
   launch day; flip the switch when the web side is ready (LAUNCH_CHECKLIST.md).
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
- [ ] Server notifications V2 URL set (prod + sandbox)
- [ ] `APPLE_BUNDLE_ID` / `APPLE_ROOT_CA_G3_B64` / `APPSTORE_ENVIRONMENT` set in Coolify
- [ ] Sandbox purchase round-trip verified (sub + credits + cancel)
- [ ] App Privacy labels transcribed (incl. new Purchases type)
- [ ] Age rating questionnaire completed (expect 4+/13+)
- [ ] Content rights: No third-party content
- [ ] Accessibility: Larger Text, Reduced Motion, Dark Interface declared
- [ ] Screenshots: 6.9" iPhone + 13" iPad sets
- [ ] SENTRY_DSN set in Release.xcconfig (or accepted gap)
- [ ] TestFlight external beta passed
- [ ] Release set to Manual
