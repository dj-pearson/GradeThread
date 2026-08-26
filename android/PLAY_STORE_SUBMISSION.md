# Play Store Submission Guide — GradeThread (FlipDesk)

Operator playbook for the first Google Play Console submission. Everything here is
derived from the shipping code (`android/`, `services/edge-functions/src/lib/google-play/`)
— product ids, URLs, permissions and Data safety answers MUST stay in sync with
those sources. The listing copy itself lives in `android/fastlane/metadata/android/en-US/`
and is pushed by `bundle exec fastlane metadata`; this file is the reasoning and the
forms that fastlane cannot fill.

Companion docs: `android/README.md` (build + verify), `.github/workflows/android-release.yml`
(the signing and upload lane), `ios/APP_STORE_SUBMISSION.md` (the Apple twin — keep
factual answers aligned, not the wording).

| Fact | Value |
|---|---|
| Store title | GradeThread (11/30 chars) |
| Package name | `com.gradethread.myapp` — **permanent, cannot be changed after first upload** |
| Developer | Pearson Media LLC (Iowa) |
| minSdk / targetSdk | 26 (Android 8.0) / **36** — the floor for a new app from 2026-08-31 (§6.5) |
| Artifact | App Bundle (`.aab`), ABI + density splits on, language split off |
| Supported ABIs | armeabi-v7a, arm64-v8a, x86_64 |
| Signing | Play App Signing; upload key from Infisical (`ANDROID_KEYSTORE_BASE64`) |
| In-app purchases | 6 subscriptions + 4 consumable credit packs (§5) |
| Ads | None |
| Privacy policy | https://gradethread.com/privacy |
| Terms | https://gradethread.com/terms |
| Data deletion URL | https://gradethread.com/account-deletion |
| Support email | **Decide before submitting** — see §4.2 |

---

## 0. What blocks submission today

Read this first. Everything else in this file is fillable once these are true.

| # | Blocker | Owner | State |
|---|---|---|---|
| 1 | **In-app account deletion.** Play's User Data policy requires an in-app path for any app that lets users create an account, plus a web URL. Settings → Delete account previously showed "email support@gradethread.com", which does not satisfy it. | Code | **Fixed** — `SettingsViewModel.confirmDeleteAccount` now calls `POST /api/account/delete` behind a typed confirmation, mirroring the web flow. |
| 2 | **Data deletion URL.** Play Console → Data safety asks for a public page describing deletion. | Web | **Fixed** — `/account-deletion`, registered in `src/lib/seo/public-routes.ts`. |
| 3 | **Upload key.** The Play Console record exists (`com.gradethread.myapp`). `ANDROID_KEYSTORE_BASE64` / `PLAY_SERVICE_ACCOUNT_JSON` must be in Infisical `prod /` before the release lane can build a signed bundle. | Operator | ☐ |
| 4 | **10 in-app products created in Play Console** with ids matching `ANDROID_CATALOG` exactly (§5). The server fails closed on an unknown id, so a typo is a charge with no entitlement. | Operator | ☐ |
| 5 | **Reviewer demo account.** The app is login-gated end to end; without credentials in App access, review returns "we could not access the app". | Operator | ☐ |
| 6 | **Screenshots.** `metadata/.../phoneScreenshots/` holds a README and no PNGs. Play will not accept a listing without at least 2 phone screenshots. | Operator | ☐ |
| 7 | **Server env for Play billing** — `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_RTDN_WEBHOOK_SECRET` in Coolify (§5.4). Without them every purchase verifies as an error and the buyer is charged with no plan. | Operator | ☐ |
| 8 | **App config in the bundle.** `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `EDGE_API_URL` must be in Infisical `prod /`. `secret()` defaults the anon key to an empty string and `AppConfig.validateAtStartup()` throws on it, so a release built without it is signed, versioned, under budget — and **crashes on launch for every user**, with every gate in the lane green. | Code | **Fixed** — US-2892. The release lane asserts all three before building and then re-checks the finished AAB's dex, because the env being right does not prove the value reached the binary. The seven optional values (`SENTRY_DSN`, `POSTHOG_API_KEY`, `TURNSTILE_SITE_KEY`, the four `FIREBASE_*`) warn into the job summary naming what ships dead. Operator still has to put them in Infisical. |

**Analytics consent is location-aware (US-2897).** Android resolves the same
consent regime the web uses: **opt-in everywhere except the United States**,
failing safe to opt-in whenever the country is unknown. A seller who has made
an explicit choice keeps it under either regime.

⚠ AN EARLIER VERSION OF THIS SECTION WAS WRONG, and the correction is worth
keeping because it was repeated into a story before anyone checked. It said
"analytics defaults to ON here and to OFF on iOS". iOS did **not** default to
off: `Telemetry.swift` reads `object(forKey:) ?? true` and its own comment says
"Opt-out, on by default". Both mobile clients behaved identically. The real gap
was between MOBILE and WEB — `src/lib/consent-regime.ts` had been
location-aware since US-2513 while both phones were not, so an EU seller on a
phone got a posture the web side had already decided was unacceptable for them,
under one shared privacy policy.

Android now mirrors the web. **iOS still does not** — it remains opt-out
worldwide, tracked as US-2914, and `ios/APP_STORE_SUBMISSION.md` must say so
until that lands rather than implying parity.

The rule itself, the three-client comparison and the reasoning live in
`vault/20-domain/client-analytics-consent.md`. That note is the source of truth;
this section describes what to type into the Console. Change one and change both.

**No seller was silently switched.** The question of grandfathering an existing
collected population does not arise here: this app has never been submitted, so
there is no installed base — every Console blocker in the table above is still
open. The tri-state store means the migration would be a no-op anyway; a seller
who never touched the toggle has no stored key, so the regime simply starts
deciding.

---

## 1. Store listing copy

Managed in `android/fastlane/metadata/android/en-US/`, pushed by
`bundle exec fastlane metadata`. Character limits are Play's, and they differ from
Apple's — the short description gets 80 characters here against Apple's 30-character
subtitle, so the two are not interchangeable even though the brand line is the same.

### App name — `title.txt` (30 max)

**GradeThread** (11)

Matches the App Store name and the launcher label (`app_name` in `strings.xml`).
Keep them identical: a Play title that disagrees with the launcher icon reads as a
different app on the home screen.

Play indexes the title heavily. If discovery needs help post-launch, the safe
expansion is **`GradeThread: Resell & List`** (26) — it adds two category terms
without a third-party mark. Do not put "eBay" in the title; it is someone else's
trademark and it is the field Play polices hardest.

### Short description — `short_description.txt` (80 max)

**AI listings, condition grades, and eBay selling in one reseller workspace.** (74)

The previous value was "Resell smarter, list faster" (27), carried over from the
Apple subtitle. It is a good line and it wastes 53 characters of the field that
shows directly under the title in search results. Keep the brand line for ads and
the App Store; use the space here.

Alternates:
- `Snap a garment, let AI write the listing, publish to eBay in seconds.` (69)
- `Photo-to-listing AI, 1-10 condition grades, and eBay sync for resellers.` (72)

### Full description — `full_description.txt` (4,000 max)

The current text is accurate to the shipped feature set and stays. Two additions
are required rather than optional:

1. **Subscription disclosure.** Play's Subscriptions policy requires the price,
   the billing period, and how to cancel to be stated where the user can see them
   before purchase. The listing is the first of those places.
2. **Terms and Privacy links.** Play requires the privacy policy in the Console
   field; putting both in the description as well is what stops a reviewer hunting
   for them.

Both are appended in the file. The block reads:

```
SUBSCRIPTIONS & CREDITS
FlipDesk offers optional auto-renewing subscriptions - Starter, Pro and Business,
monthly or yearly - and one-time grade credit packs. Payment is charged to your
Google Play account at confirmation of purchase. Subscriptions renew automatically
unless you cancel at least 24 hours before the end of the current period. Manage or
cancel any time in Google Play > Payments & subscriptions.

A free account lets you catalog and grade items. Paid plans unlock higher volumes
and the advanced selling tools.

Terms: https://gradethread.com/terms
Privacy Policy: https://gradethread.com/privacy
Delete your account: https://gradethread.com/account-deletion
```

Formatting note: Play renders the description as plain text with a small set of
HTML tags. It does NOT render Markdown, so the heading lines are bare uppercase and
the bullets are hyphens. Do not add `**` or `#`; they ship literally.

### Release notes — `changelogs/default.txt` (500 max)

One file per version code. `default.txt` applies to any code without its own file,
which is what you want until the first update. The current text covers the 1.0
feature set and stays; the only edit is dropping "First release of FlipDesk for
Android" in favour of naming the app the way the listing does.

For later releases, add `changelogs/<versionCode>.txt`. The Fastfile deliberately
does not use `changelog_from_git_commit` — commit subjects carry story ids and
half-finished work, and every tester sees this text.

---

## 2. Graphics

Play rejects a listing with any of these missing. None of them exist in the repo yet.

| Asset | Spec | Where it goes |
|---|---|---|
| App icon | 512×512 PNG, 32-bit, no alpha, under 1MB | `metadata/android/en-US/images/icon.png` |
| Feature graphic | 1024×500 PNG or JPEG, no alpha | `.../images/featureGraphic.png` |
| Phone screenshots | 2–8, PNG/JPEG, 16:9 to 9:16, each side 320–3840px | `.../images/phoneScreenshots/` |
| 7" tablet | 0–8, same rules | `.../images/sevenInchScreenshots/` |
| 10" tablet | 0–8, same rules | `.../images/tenInchScreenshots/` |
| Promo video | YouTube URL, optional | Console only, not fastlane |

The tablet sets are optional, but omitting them puts a "not designed for tablets"
notice on the listing for tablet and ChromeOS users. The app is Compose with
`material3-window-size-class` wired in, so it adapts; take the shots.

Screenshots sort by filename, so name them `1_capture.png`, `2_ai_draft.png` and so
on. Suggested storyline, in the order that matches what the app actually does:

1. Guided photo capture with AI fields filling in — the hero shot
2. The AI-extracted listing draft, title and description ready
3. The condition grade report and certificate — the trust differentiator
4. The eBay publish screen with the live profit estimate
5. Money tab: sales, payouts, profit
6. Inventory grid with bulk actions
7. The home-screen widget in place on a launcher (tablet set: the two-pane layout)

The first two are what 90% of browsers see. Capture them on a device with
`npm run android:device screenshot`, or render the Compose screens with
`npm run android:screenshots` and crop — the Roborazzi goldens are real renders of
the real Composables.

⚠️ Do not put a price, a rating, or a Play badge inside a screenshot. Play's
metadata policy treats an in-image price as a claim it has to enforce, and it
changes per region.

---

## 3. App content declarations (Play Console → Policy → App content)

Every one of these is a separate form and every one blocks release until answered.

### 3.1 Privacy policy

`https://gradethread.com/privacy`. Verify it returns 200 as an anonymous request
before submitting — the crawler that checks it is not signed in.

### 3.2 App access

The app is login-gated from the first screen, so choose **"All or some
functionality is restricted"** and supply credentials.

Provide one entry:

- **Name**: Seller account (full app)
- **Username / password**: the seeded demo account (blocker #5)
- **Any other instructions**: see the block below

```
The app requires a signed-in seller account; there is no anonymous mode.

The demo account is pre-populated with sample inventory, photos, a completed
condition grade with certificate, listings, sales and payouts, and a small credit
balance so you can run a grading without purchasing.

The eBay connection on this account is eBay's SANDBOX environment. Publishing or
revising a listing from the demo account has no effect on the live eBay
marketplace.

AI features (attribute extraction, listing drafts, condition grading) always
present their output for review before anything is saved.

Sign-in options are email/password (above), Google, and a magic link. Use
email/password.

Delete account: Settings > Delete account, then type DELETE MY ACCOUNT. Please do
not run this on the demo account.
```

### 3.3 Ads

**No, my app does not contain ads.** There is no ad SDK in `libs.versions.toml` and
no ad rendering anywhere in the tree. This answer also keeps the "Contains ads"
badge off the listing.

### 3.4 Content rating (IARC questionnaire)

Category: **Utility, Productivity, Communication or Other**.

Answers, all honest and all "no" unless noted:

- Violence, sexual content, profanity, controlled substances, horror: **No**
- Gambling, simulated gambling, contests: **No**
- **Users can interact / share content**: **No.** There is no user-to-user
  messaging or social feed. The eBay buyer-message inbox relays messages from the
  seller's own eBay account through eBay's system; it is not an in-app social
  surface between GradeThread users. Certificates are view-only web pages.
- **Shares user location**: **No.** Sourcing Radar uses coarse location on device
  and sends a rounded viewport, never a fix, and never to another user.
- **Digital purchases**: **Yes** — subscriptions and consumable credits.
- **Unrestricted internet access**: **No.** External links open specific
  own-domain, eBay OAuth and Play URLs in a Custom Tab; there is no in-app browser
  with an address bar.

Expected rating: **Everyone / PEGI 3 / ESRB Everyone**, with the "In-app purchases"
notice attached.

### 3.5 Target audience and content

- **Target age groups**: **18 and over** only.

  This is a business tool for people who sell goods and take payments; nothing in
  it is designed for minors. Selecting any bracket under 18 pulls the app into the
  Families policy programme, which brings a separate ads/SDK review, a stricter
  content rating, and a "Designed for Families" review queue for no benefit here.

- **Appeal to children**: **No.**
- **Store listing includes children**: **No.** Keep children out of the screenshots
  and the feature graphic; a child in the imagery contradicts the answer.

### 3.6 Data safety

The single form Play polices hardest, because Play compares it against what the
binary actually does. Below is what the code does, mapped to Play's data types.
Sources: `AndroidManifest.xml`, `platform/telemetry/Telemetry.kt`,
`platform/net/EdgeApi.kt`, `intake/`, `sourcing/`, `billing/`.

**Preamble answers**

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | HTTPS only; `network_security_config.xml` forbids cleartext |
| Do you provide a way for users to request that their data be deleted? | **Yes** | In-app Settings → Delete account, plus https://gradethread.com/account-deletion |

**Data types** — for each: collected, whether shared, whether it can be linked to
the user, whether it is optional, and the purposes.

| Play data type | Collected | Shared | Linked | Optional | Purposes | Source in code |
|---|---|---|---|---|---|---|
| Personal → Name | Yes | No | Yes | No | App functionality, Account management | Profile on the users row |
| Personal → Email address | Yes | No | Yes | No | App functionality, Account management | Supabase auth |
| Personal → User IDs | Yes | No | Yes | No | App functionality, Analytics, Crash | Supabase user UUID; the only identity sent to Sentry/PostHog |
| Financial → Purchase history | Yes | No | Yes | No | App functionality | Both the seller's own sales bookkeeping and the Play billing state on the users row |
| Location → Approximate location | Yes | No | Yes | **Yes** | App functionality | `ACCESS_COARSE_LOCATION`, requested from the "Use my location" button in Sourcing Radar only. Radar works with it refused. |
| Photos and videos → Photos | Yes | No | Yes | No | App functionality | Garment photos uploaded for grading and listing |
| Audio → Voice or sound recordings | **No** | No | — | — | — | `RECORD_AUDIO` exists for dictation into item notes. The app hands the mic to the platform `SpeechRecognizer` and keeps only the returned text; it never records, stores or transmits audio itself. Declare the permission's presence in the review notes so the mismatch is explained before it is questioned. |
| App activity → App interactions | Yes | No | No | **Yes** | Analytics | PostHog. Manual screen names only, no autocapture. Toggle in Settings → Privacy. **Off by default outside the US** (US-2897): consent regime resolved from a coarse country signal, failing safe to opt-in when unknown. "Optional" is therefore true in Play's sense rather than nominally true. |
| App info and performance → Crash logs | Yes | No | No | No | App functionality (diagnostics) | Sentry, `isSendDefaultPii = false`, every string through `TelemetryScrubber` |
| App info and performance → Diagnostics | Yes | No | No | No | App functionality (diagnostics) | Sentry performance/breadcrumbs |

**Nothing is "shared"** in Play's sense. Play defines sharing as transfer to a third
party; a processor acting on our instructions under contract (Supabase, Sentry,
PostHog, Anthropic, the marketplace the seller themselves connected) is not sharing.
That is the same position the subprocessor page takes
(`src/pages/legal/subprocessors.tsx`), and the two must not disagree.

**Deliberately NOT declared**, each with the reason, because a reviewer asking
"why isn't X here" is a rejection and an answer written down now is an answer then:

- **Contacts, SMS, Call logs, Calendar, Health, Files** — no permission, no code path.
- **Precise location** — `ACCESS_FINE_LOCATION` is not in the manifest.
- **Payment info** — card details never reach the app or our servers. Play collects
  them; Stripe collects them on the web. We store an identifier, not an instrument.
- **Device or other IDs** — no advertising ID, no `AD_ID` permission, no attribution
  SDK. This also means the **Advertising ID declaration** answer is "No".

**Data safety must be re-checked whenever a dependency is added.** An SDK that
quietly collects an advertising id makes the form false without a line of our code
changing. The dependency-update lane (`npm run android:updates`) is the prompt.

### 3.7 Government apps

**No.**

### 3.8 Financial features

**"My app doesn't provide any financial features."**

Worth stating why, because the app shows money: FlipDesk tracks the seller's own
sales, payouts and profit, and sells subscriptions. It does not offer loans, money
transfer, crypto, insurance, investments, or tax preparation, which are the
categories the declaration covers. Selling a subscription is not a financial
feature; it is in-app billing.

The Inventory Equity work is the one thing that could change this answer, and the
Capital Phase 2 lending half is explicitly not being built (founder decision,
2026-07-09). If that ever reverses, this form changes before the build ships.

### 3.9 Health apps

**No.** No health data, no medical claims.

### 3.10 News apps

**No.** The blog is a marketing surface on the website and is not in the app.

### 3.11 Account deletion

Required, and it is the answer with the most teeth.

- **Does your app let users create an account?** Yes.
- **In-app deletion**: Settings → Delete account. Requires typing
  `DELETE MY ACCOUNT`, and a password for email/password accounts. Calls
  `POST /api/account/delete`, which cascades storage objects, the Stripe customer,
  marketplace tokens and the auth row.
- **Web deletion URL**: `https://gradethread.com/account-deletion`
- **What is deleted vs retained**: the page states it, and it must match
  `vault/10-ops/data-retention.md` and `routes/account.ts` — the endpoint refuses
  deletion while a legal-retention condition holds and says so. Do not describe an
  unconditional erase that the code will decline to perform.

---

## 4. Store settings

### 4.1 Category and tags

- **App category**: **Business.**

  Shopping is the other candidate and it is the wrong one. Shopping browsers are
  buyers; this is a tool for people who sell, and the category drives both the
  browse placement and the audience Play's own recommender sends. Business is where
  inventory, invoicing and marketplace tools sit.

- **Tags** (up to 5, from Play's fixed list): Business tools, Inventory, Small
  business, Photography, Productivity — pick the closest live options at submission
  time; Play edits the list.

### 4.2 Store listing contact details

| Field | Value |
|---|---|
| Email | **Pick one and use it everywhere** (**required**, shown publicly on the listing) |
| Phone | Optional — leave blank rather than publish a personal number |
| Website | https://gradethread.com |
| Privacy policy | https://gradethread.com/privacy |

### 4.3 Countries and pricing

Start with the countries the product actually serves. eBay marketplace coverage,
US-dollar pricing and English-only listing copy all point at **United States,
Canada, United Kingdom, Australia, Ireland, New Zealand** for the first release;
adding countries later is a checkbox, removing one after people have subscribed is
not.

The app itself ships an English and a Spanish string catalogue. The Play listing is
en-US only until someone writes the Spanish listing copy — a machine-translated
listing next to a hand-written app is worse than an English listing.

### 4.4 The things to leave alone at first release

- **Pre-registration**: off. It is a marketing campaign, not a release step.
- **Advance install / app bundle explorer**: read-only, nothing to set.
- **Google Play Games / Play Pass**: not applicable.
- **In-app updates**: not wired; the Play Core library is not a dependency.

---

## 5. Monetization

### 5.1 Subscriptions (Play Console → Monetize → Products → Subscriptions)

One product id per plan and interval, mirroring the App Store structure, because the
server classifies a purchase from the reported product id alone. Ids come from
`android/app/src/main/java/com/gradethread/app/billing/SubscriptionCatalog.kt` and
must match `ANDROID_CATALOG` in
`services/edge-functions/src/lib/google-play/products.ts` exactly. A test pins the
two together; Play Console is the third copy and nothing pins that one but this list.

| Product ID | Plan | Interval | Base price (USD) |
|---|---|---|---|
| `flipdesk_starter_monthly` | Starter | Monthly | $29.00 |
| `flipdesk_starter_yearly` | Starter | Yearly | $290.00 |
| `flipdesk_pro_monthly` | Pro | Monthly | $59.00 |
| `flipdesk_pro_yearly` | Pro | Yearly | $590.00 |
| `flipdesk_business_monthly` | Business | Monthly | $99.00 |
| `flipdesk_business_yearly` | Business | Yearly | $990.00 |

Each subscription needs one **base plan** (auto-renewing, the matching billing
period) and at least one **offer** attached to it — the Android paywall reads
`offerToken` and renders a row as unpurchasable without one, so a base plan with no
offer ships as a price tag with a dead button.

Settings that matter:
- **Grace period**: on, 3 days. A failed card should not drop a paying seller's
  inventory limits mid-week.
- **Account hold**: on (Play's default), so a recovered payment restores rather than
  re-subscribes.
- **Resubscribe**: on.
- **Proration**: default. Plan changes go through the same entitlement resolution as
  Stripe.

### 5.2 Consumable credit packs (Monetize → Products → In-app products)

From `billing/CreditPacks.kt`:

| Product ID | Credits | Base price (USD) |
|---|---|---|
| `credits_10` | 10 | $24.99 |
| `credits_25` | 25 | $59.99 |
| `credits_50` | 50 | $109.99 |
| `credits_100` | 100 | $199.99 |

Type **Consumable**. The client consumes on the server's confirmation, not before —
`credits_*` grants are idempotent on the purchase token.

### 5.3 The prices in the app are fallbacks

`fallbackPriceLabel` renders USD only until Play returns the localized price, which
is authoritative and carries the buyer's currency. Set Play's prices from the table
above and let Play convert; do not hand-set regional prices to match a USD figure.

### 5.4 Server configuration (Coolify → edge-functions → Environment)

| Var | Value | Consequence if missing |
|---|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Play Developer API service-account JSON, as content | Every verify call fails; buyer charged, no entitlement |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.gradethread.myapp` | Same |
| `GOOGLE_RTDN_WEBHOOK_SECRET` | A shared secret, also on the Pub/Sub push subscription | Real-time lapse and refund reconciliation never fire; the daily sweep still catches it within 72h |
| `GOOGLEPLAY_SWEEP_GRACE_HOURS` | Optional, defaults to 72 | — |

The service account needs the **Financial data / Manage orders and subscriptions**
permission in Play Console → Users and permissions, and it must be a *different*
account from the fastlane publishing one if you want upload rights separated from
billing rights. One account with both works and is one fewer thing to rotate.

**RTDN wiring**: Play Console → Monetize → Monetization setup → Real-time developer
notifications → a Pub/Sub topic, with a push subscription pointed at
`https://functions.gradethread.com/api/webhooks/google-play` carrying the shared
secret. The daily `googleplay-expiry-sweep` cron is the backstop, not the mechanism.

### 5.5 License testers

Play Console → Setup → License testing. Add the tester Google accounts there and
they can buy every product with no charge and a compressed renewal clock (a monthly
subscription renews every 5 minutes). This is the only way to exercise the purchase
path end to end before release, and the server tags those grants
`billing_environment: 'sandbox'` so they never look like revenue.

Round-trip to verify before submitting, in order:
1. Buy `flipdesk_pro_monthly` → the users row flips to `pro` / `googleplay`.
2. Buy `credits_25` → balance +25, and a re-verify of the same token grants nothing more.
3. Cancel in Play → `flipdesk_cancel_at_period_end` true, access holds to period end.
4. Let it expire → the RTDN lapses it, or the sweep does within 72 hours.
5. Buy the same product on a second account → rejected, because the purchase token is
   bound to one user.

---

## 6. Release mechanics

### 6.1 Signing

Play App Signing holds the app signing key. What we hold is the **upload key**, in
Infisical `prod /` as `ANDROID_KEYSTORE_BASE64` plus password and alias. The release
lane decodes it to `build/release-keystore.jks` and never writes it elsewhere.

If no keystore exists yet, generate one *once*:

```bash
keytool -genkeypair -v -keystore gradethread-upload.jks \
  -alias gradethread -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Pearson Media LLC, O=Pearson Media LLC, C=US"
```

Then base64 it into Infisical and delete the local file. An upload key is
recoverable (Play can reset it), which is exactly why it must not be treated as
disposable — resetting takes days.

`resolveKeystore()` returns null when the material is absent and the release build
then has **no signing config**. That is deliberate: an unsigned release build still
proves minification and the manifest merge work. It also means a missing secret
produces a bundle Play rejects rather than a build failure, which is why
`android-release.yml` asserts every secret by name before it builds.

### 6.2 Version code

`ANDROID_VERSION_CODE` drives `versionCode`; CI passes the run number. Play rejects a
re-used code outright. Never hand-edit the literal — the default of 1 exists for
local builds only.

`ANDROID_VERSION_NAME` is the human version, `0.1.0` by default. Set it to `1.0.0`
for the first store release.

### 6.3 Tracks

```bash
cd android
bundle exec fastlane bundle       # build the signed AAB only
bundle exec fastlane internal     # upload to internal testing
bundle exec fastlane beta         # closed beta
bundle exec fastlane production   # uploads as a DRAFT, halted for a human
bundle exec fastlane metadata     # listing text + images, no binary
```

Or the workflow: push an `android-v*` tag, or run **Android Release** from the
Actions tab and pick a track.

The order that works: **internal → closed beta → production**. Internal has no
review queue and reaches testers in minutes, which is where you find the crash that
only happens on a real device. The production lane uploads as a draft on purpose —
Play has no un-publish, only a halt that leaves the bad build on devices that
already took it.

First submission to production goes through a full review. Budget days, not hours,
for a first-time developer account.

### 6.4 What the release lane runs before it uploads

The same gates as `npm run verify:android`: format → detekt → lint (warnings are
errors) → unit tests → coverage floor → screenshots → assemble → bundle → ABI budget.
Run it locally before tagging; the pre-push hook runs it automatically when the push
touches `android/**`.

### 6.4a 16 KB page-size support — measured, and now guarded

Play requires 16 KB memory page support for apps targeting Android 15+. A shared
library whose `PT_LOAD` segments are aligned to the old 4 KB page cannot be
mapped on such a device: the app installs and then fails to load the library,
surfacing as a crash in whatever feature touched it first.

**Measured 2026-08-25 against the real release AAB: all 16 sixty-four-bit
libraries already report a 16 KB minimum alignment**, ML Kit's two included
(`libmlkit_google_ocr_pipeline.so` 10.55 MB, `libbarhopper_v3.so` 4.72 MB), plus
both Sentry libraries, CameraX's and Compose's. `extractNativeLibs` is `false`
(AGP's default), which is the correct packaging mode — the libraries are mapped
straight out of the APK rather than extracted. The armeabi-v7a slice is exempt:
16 KB pages are a 64-bit concern.

US-2893 was filed assuming the pinned ML Kit versions predated the requirement.
They do not. **The check still earns its place, and the reason is worth stating:
the app compiles none of this code.** Every `.so` arrives prebuilt from a
dependency, so alignment is a property the app inherits silently and can lose
silently on any version bump — and the symptom is a crash on a class of device
nobody here owns. The fix for a failure is always a dependency upgrade, never a
Gradle flag; AGP aligns what it packages and cannot re-link someone else's
binary.

`android/scripts/check-16kb-alignment.mjs` runs in `verify:android`, on every
push in `android-ci.yml` (it needs no secrets, so the placeholder release build
is enough), and again in `android-release.yml` against the bundle that uploads.
Each invocation self-tests first.

### 6.5 Target API level — the deadline, and what moving to 36 changed

Read from developer.android.com/google/play/requirements/target-sdk on
**2026-08-25**. Re-read it before the next annual step; this section is a
snapshot, not a standing fact.

**From 2026-08-31, a new app must target API 36** (Android 16). A new app below
that floor "is not available to new users on devices running newer versions of
Android" — which, for a product that has never shipped, is the audience. The
extension form (to 2026-11-01) covers updates to apps already live and does not
create a path for a first upload. The check happens at upload, so being wrong
costs a green twenty-minute release lane and then a policy error.

`compileSdk` and `targetSdk` are both 36 as of US-2891. Building against it
needs SDK platform `android-36`; `android/scripts/toolchain.mjs` refuses to run
Gradle without it and names it, and `npm run android:doctor` prints the
`sdkmanager` line that installs it.

**The build now runs on JDK 21, and the reason is not obvious from either end.**
Nothing in the app's code needs 21. The chain is: Play requires targetSdk 36 →
`compileSdk` 36 → the Robolectric suite needs Robolectric's SDK 36 `android-all`
jar → that jar refuses to load below Java 21 (*"Android SDK 36 requires Java 21
(have Java 17)"*). Robolectric was also raised 4.14.1 → 4.16.1, since 4.16 is the
first release with SDK 36 at all.

This is the JVM the **build** runs on, not the bytecode it emits.
`sourceCompatibility`, `targetCompatibility` and `kotlinOptions.jvmTarget` all
stay at **17** on purpose — the shipped APK is byte-for-byte unaffected and
minSdk 26 devices are untouched. Raising those three to match would raise the
floor on what the app can run on, which is a different decision and not one this
story made.

Worth knowing how this failed, because the failure was quiet: the 1798 plain
JUnit tests all passed, so the suite looked ~99% healthy while **all 21
Robolectric classes — and the Roborazzi screenshot lane, which runs through
Robolectric — were not executing at all**. Every failure was an
`initializationError` out of `DefaultSdkPicker`, a message naming neither
Robolectric nor the SDK level. Raise Robolectric in the same commit as any
future `compileSdk` bump.

The API 36 behaviour changes were checked one at a time. Only three touch this
app, and the third is the one worth remembering:

| Change | Applies here? | What was done |
|---|---|---|
| **Edge-to-edge is mandatory** — `windowOptOutEdgeToEdgeEnforcement` is dead | Already compliant | `MainActivity.onCreate` has called `enableEdgeToEdge()` since US-1313, and the opt-out attribute appears nowhere in the manifest. Nothing to do. The white-frame problem on a dark-mode cold start is a *theme* bug, not this one — US-2899. |
| **Predictive back on by default** — `onBackPressed()` is no longer called and `KEYCODE_BACK` is not dispatched | Applies, and was safe | The app had no legacy back handling to break: zero `onBackPressed` overrides, zero `KEYCODE_BACK` reads and zero `BackHandler` calls across 688 Kotlin files. Back is entirely Navigation-Compose's, which androidx.activity already bridges. `android:enableOnBackInvokedCallback="true"` is now set **explicitly**, so a phone on 33-35 and a phone on 36 behave the same way rather than splitting on the platform default. The in-app predictive transitions are still US-2911. |
| **Orientation, resizability and aspect-ratio restrictions ignored at ≥600dp** | Applies, and is a product problem | The manifest declares no `screenOrientation`, no `resizableActivity` and no aspect-ratio bounds, so there is nothing to opt out of and nothing breaks. What it means is that on any tablet, foldable or ChromeOS window the app now fills whatever the user gives it — and today that renders as one stretched column with a navigation rail beside it (§2's tablet-screenshot note). API 36 makes that layout unavoidable rather than a thing a tablet user opts into, and the per-activity opt-out property is explicitly temporary and gone at API 37. **This is the argument for US-2905 (two-pane list-detail), and it is now a deadline rather than a preference.** |

Checked and not applicable: elegant-font APIs (no XML `TextView`s), the
`ScheduledExecutorService.scheduleAtFixedRate` change (WorkManager, not that
API), `MediaStore.getVersion` fingerprint lockdown (never read), granular
health permissions (no `BODY_SENSORS`), local-network restrictions (opt-in, and
no local network access), and the photo-picker pre-selection change (the picker
is `PickVisualMedia`, which is unaffected).

---

## 7. Pre-submission checklist

- [ ] Play Console developer account verified (identity + D-U-N-S if an organization)
- [ ] App record created with package `com.gradethread.myapp`
- [ ] Upload keystore generated and in Infisical `prod /` (4 vars)
- [ ] `PLAY_SERVICE_ACCOUNT_JSON` in Infisical with release-manager rights
- [ ] `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` + `GOOGLE_PLAY_PACKAGE_NAME` + `GOOGLE_RTDN_WEBHOOK_SECRET` in Coolify
- [ ] RTDN Pub/Sub topic + push subscription pointed at the webhook
- [ ] 6 subscriptions created, each with a base plan AND an offer
- [ ] 4 consumable credit packs created
- [ ] License testers added; the five-step purchase round-trip in §5.5 passed
- [ ] Icon 512×512, feature graphic 1024×500
- [ ] 2–8 phone screenshots; tablet sets if claiming tablet support
- [ ] Listing copy pushed (`fastlane metadata`) and read back in the Console
- [ ] Privacy policy resolves 200 anonymously
- [ ] `/account-deletion` resolves 200 anonymously
- [ ] App access: demo account credentials + the review-notes block from §3.2
- [ ] Ads: No
- [ ] Content rating questionnaire completed → Everyone
- [ ] Target audience: 18+
- [ ] Data safety form matches §3.6, including the `RECORD_AUDIO` note
- [ ] Government / Financial / Health / News: all No
- [ ] Account deletion declaration filled with both paths
- [ ] Category Business; contact email set to `support@gradethread.com` (matches the listing copy and the domain with DKIM/SPF/DMARC — see `vault/50-business/deliverability.md`)
- [ ] Countries selected
- [ ] `npm run verify:android` green on the release commit
- [ ] Internal track build installed on a real device and signed into
- [ ] Production rollout left as a draft for a human to release
