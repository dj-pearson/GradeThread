# Android release runbook: from an empty Play record to a submitted app

An ordered operator sequence. Start at Phase 1 and go down. The order is not a
preference: Play App Signing does not exist until the first upload, the App
Links fingerprint comes out of Play App Signing, and the purchase round trip
cannot run until the products, the server env and the Pub/Sub topic are all in
place. Doing these out of order is how a week disappears.

Companion docs, and what each is for:

- `android/PLAY_STORE_SUBMISSION.md` - the reasoning, the exact answers to every
  Play Console form, and the listing copy. This runbook points at it rather than
  repeating it.
- `android/README.md` - building, verifying and working without Android Studio.
- `vault/10-ops/env-reference.md` - every environment variable in the portfolio,
  and which surface owns it.

Rough budget: two working days of setup, then days (not hours) of Google review
on a first-time developer account.

| Fact | Value |
|---|---|
| Package name | `com.gradethread.myapp` - permanent after the first upload |
| Artifact | App Bundle (`.aab`), built by GitHub Actions |
| Signing | Play App Signing; we hold only the upload key |
| Version name | Comes from the git tag (`android-v1.0.0` gives `1.0.0`) |
| Version code | The GitHub Actions run number, never hand-edited |
| Products | 6 subscriptions + 4 consumable credit packs |

---

## Phase 0. What you are about to create

Three Google surfaces, and they are separate things people mix up:

1. **Play Console** - the store record, the listing, the products, the tracks.
2. **Google Cloud project** - where the APIs and the service accounts live. Play
   Console links to one; the link is what lets a robot upload builds and verify
   purchases.
3. **Firebase project** - push notifications only. Optional at launch. It sits
   on top of a Google Cloud project and can reuse the same one.

You will create **two service accounts**, and it is worth knowing why before you
make them:

| Account | Lives in | Used by | Secret name |
|---|---|---|---|
| Publishing | Google Cloud | GitHub Actions / fastlane, to upload builds | `PLAY_SERVICE_ACCOUNT_JSON` (Infisical) |
| Billing | Google Cloud | The edge service, to verify purchases | `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (Coolify) |

One account with both permissions works and is one fewer thing to rotate. Two
accounts means a leaked CI credential cannot read your revenue. Pick one and be
consistent; this runbook assumes two.

---

## Phase 1. Play Console: finish the account and the app record

**1.1 Verify the developer account.** Play Console, Setup, whatever it is
prompting you for. An organization account needs a D-U-N-S number and the
verification can take days on its own. Nothing below matters until this clears.

**1.2 Set up the payments profile.** Monetize, Payments profile. Without it the
subscription and credit-pack products cannot be created, and that blocks Phase 8.

**1.3 The package name is `com.gradethread.myapp`.** That is the name on the
existing Play Console record, and the code was changed to match it rather than
the other way round. Play locks a package name to a record permanently, so this
is now fixed for the life of the app.

> [!warning] The Android store id is NOT the Kotlin package and NOT the iOS bundle id
> Both of those are `com.gradethread.app`, and all three coexisting is deliberate.
> `applicationId` in `app/build.gradle.kts` is the store identity; `namespace` is
> the code. "Fixing" one to match the other orphans either the listing or every
> source file. The four places that carry the store id are `app/build.gradle.kts`,
> `fastlane/Appfile`, `android/scripts/device.mjs` and
> `functions/.well-known/assetlinks.json.ts`, and each one says so in a comment.

**1.4 Link a Google Cloud project.** Play Console, Setup, API access, then link
an existing project or create one. This is the handshake that makes Phase 3
possible. Note the project id.

---

## Phase 2. The upload key

Play holds the real app signing key. You hold the **upload key**, which is what
proves a build came from you. An upload key can be reset by Google if you lose
it, which takes days, so it is recoverable rather than disposable.

**2.1 Generate it once.** On any machine with a JDK:

```bash
keytool -genkeypair -v -keystore gradethread-upload.jks \
  -alias gradethread -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Pearson Media LLC, O=Pearson Media LLC, C=US"
```

Pick one strong password and use it for both prompts (store and key). Two
different passwords is legal and is a support ticket waiting to happen.

**2.2 Base64 it and store the four values in Infisical** (project `grade-thread`,
env `prod`, path `/`):

```bash
base64 -w0 gradethread-upload.jks > keystore.b64
```

| Variable | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the contents of `keystore.b64`, one line |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `gradethread` |
| `ANDROID_KEY_PASSWORD` | the key password |

**2.3 Delete the local `.jks` and the `.b64` file.** Keep one offline copy
somewhere you would keep a passport. `*.jks` is gitignored, and committing one
hands anyone who can read the repo the ability to sign an update to your app.

**2.4 Play App Signing turns itself on** when the first bundle is uploaded. There
is nothing to do here yet. Phase 13 comes back for the fingerprint it produces.

---

## Phase 3. Google Cloud: APIs and the two service accounts

**3.1 Enable three APIs** in the linked project (Google Cloud Console, APIs and
services, Enable APIs):

- **Google Play Android Developer API** - uploading builds and verifying purchases.
- **Cloud Pub/Sub API** - real-time billing notifications (Phase 7).
- **Firebase Cloud Messaging API** - push (Phase 5). Skip if you are launching
  without push.

**3.2 Create the publishing service account.** IAM and admin, Service accounts,
Create. No Google Cloud roles are needed; the permissions that matter are granted
inside Play Console. Create a JSON key and download it.

Then Play Console, Users and permissions, Invite new user, the service account
email, and grant **Release manager** on this app only. Not account-wide.

Put the whole JSON document, as one value, into Infisical `prod /` as
`PLAY_SERVICE_ACCOUNT_JSON`.

**3.3 Create the billing service account.** Same steps, second account. In Play
Console grant it **View app information** plus **View financial data, orders and
cancellation survey responses** on this app.

Put its JSON into **Coolify** (edge-functions, Environment) as
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. Not Infisical: this one is read by the
running server, not by a build.

**3.4 Permission changes can take up to 24 hours to propagate.** A fastlane
upload that fails with a permissions error minutes after you granted the role is
usually this, not a wrong key. Wait a day before debugging it.

---

## Phase 4. The build-time values, three of which are checked

This phase has no visible output and is the one most likely to cost you a
rejected review, so it is not optional.

`android/app/build.gradle.kts` bakes eleven values into the binary from the
environment. **A missing value produces an empty string and a build that
succeeds.** An AAB built without `SUPABASE_ANON_KEY` installs fine, opens fine,
and cannot sign anyone in, including the reviewer.

⚠ This paragraph used to end "There is no guard." Three of the eleven are guarded
now: US-2892 made the release lane assert `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`EDGE_API_URL` by name before it builds, and then re-check the finished AAB's dex,
because the environment being right does not prove the value reached the binary.
Seven more (`SENTRY_DSN`, `POSTHOG_API_KEY`, `TURNSTILE_SITE_KEY` and the four
`FIREBASE_*`) warn into the job summary naming what ships dead. `POSTHOG_HOST` is
baked in and checked by neither, which is the eleventh value and the only one
nothing would tell you about. Putting any of them into Infisical is still yours.

Confirm every one of these exists in Infisical `prod /` before you build:

| Variable | If missing |
|---|---|
| `SUPABASE_ANON_KEY` | **Nobody can sign in.** The app is a dead shell. |
| `TURNSTILE_SITE_KEY` | Signup captcha does not render; signup fails if GoTrue captcha is on. |
| `SENTRY_DSN` | No crash reports from production. |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` | No analytics. Harmless. |
| `FIREBASE_PROJECT_ID` / `_APP_ID` / `_API_KEY` / `_SENDER_ID` | Push disables itself cleanly. See Phase 5. |

`SUPABASE_URL` and `EDGE_API_URL` default to production and need nothing.

How to verify rather than hope: install the internal-track build on a real device
in Phase 12 and sign in. That is the only check that exists.

---

## Phase 5. Firebase, for push (skippable at launch)

All four Firebase values must be present or the app disables push rather than
half-initializing a client that fails on the first send. Launching without push
is a supported state.

**5.1** Firebase Console, add project (reuse the Google Cloud project from 1.4),
then add an **Android** app with package `com.gradethread.myapp`.

**5.2** Take the four values from the generated config into Infisical `prod /`:
`FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_API_KEY`,
`FIREBASE_SENDER_ID`. This app reads them from `BuildConfig` and does **not** use
a committed `google-services.json`.

**5.3** Project settings, Service accounts, generate a private key. Put that JSON
into Coolify as `FCM_SERVICE_ACCOUNT_JSON`. That is the sending half; the four
values above are the receiving half, and push needs both.

---

## Phase 6. Coolify: the edge service needs to know about Play

Coolify, edge-functions, Environment:

| Variable | Value | If missing |
|---|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | the billing account JSON from 3.3 | Every purchase verify fails. The buyer is charged and gets nothing. |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.gradethread.myapp` | Same. |
| `GOOGLE_RTDN_WEBHOOK_SECRET` | a long random string you invent | Phase 7 cannot authenticate. Lapses and refunds are only caught by the daily sweep, within 72 hours. |
| `GOOGLEPLAY_SWEEP_GRACE_HOURS` | optional, defaults to 72 | nothing |

Redeploy the service. Generate the secret with something like
`openssl rand -hex 32` and keep it: Phase 7 needs the same string.

---

## Phase 7. Real-time developer notifications (Pub/Sub)

This is what tells the server within seconds that somebody cancelled, lapsed or
was refunded. The daily sweep is the backstop, not the mechanism.

**7.1** Google Cloud, Pub/Sub, Create topic. Name it something like `play-rtdn`.
Note the full name, `projects/<project-id>/topics/play-rtdn`.

**7.2** On that topic, grant **Pub/Sub Publisher** to Google's own publisher:

```
google-play-developer-notifications@system.gserviceaccount.com
```

Play refuses the topic in 7.4 without this grant, and says so unhelpfully.

**7.3** Create a **push** subscription on the topic with this endpoint, with your
Phase 6 secret substituted in:

```
https://functions.gradethread.com/api/webhooks/google-play?token=<GOOGLE_RTDN_WEBHOOK_SECRET>
```

The route also accepts the secret as a bearer token in an `Authorization` header
if you prefer it out of the URL. It fails closed: a wrong or absent secret is a
401 and nothing is processed.

**7.4** Play Console, Monetize, Monetization setup, Real-time developer
notifications. Paste the topic name, save, then **Send test notification**.

**7.5** Verify it arrived. A 401 in the edge logs means the secret does not
match; a 200 means the chain works end to end.

Warning: `functions.gradethread.com` is the edge service. `api.gradethread.com`
is Supabase and will 404 this path.

---

## Phase 8. Create the ten products

Play Console, Monetize, Products. **The ids must match exactly.** The server
fails closed on an unknown id, which means a typo here is a customer who is
charged by Google and entitled to nothing.

### Subscriptions

| Product ID | Plan | Interval | Price USD |
|---|---|---|---|
| `flipdesk_starter_monthly` | Starter | Monthly | 29.00 |
| `flipdesk_starter_yearly` | Starter | Yearly | 290.00 |
| `flipdesk_pro_monthly` | Pro | Monthly | 59.00 |
| `flipdesk_pro_yearly` | Pro | Yearly | 590.00 |
| `flipdesk_business_monthly` | Business | Monthly | 99.00 |
| `flipdesk_business_yearly` | Business | Yearly | 990.00 |

Each one needs **a base plan AND at least one offer attached to it**. The Android
paywall reads the offer token and renders a row as unpurchasable without one, so
a base plan with no offer ships as a price tag with a dead button.

Settings that matter: grace period **on, 3 days**; account hold **on**;
resubscribe **on**; proration default.

### Consumable credit packs

| Product ID | Credits | Price USD |
|---|---|---|
| `credits_10` | 10 | 24.99 |
| `credits_25` | 25 | 59.99 |
| `credits_50` | 50 | 109.99 |
| `credits_100` | 100 | 199.99 |

Type **Consumable**. Set the USD price and let Play convert for other countries.
Do not hand-set regional prices.

Activate every product. A draft product is invisible to the app.

---

## Phase 9. The listing: text and pictures

**9.1 The text already exists** in `android/fastlane/metadata/android/en-US/` and
is accurate. Do not retype it into the Console; Phase 12 pushes it.

**9.2 The pictures do not exist.** Play rejects a listing without them:

| Asset | Spec | Path |
|---|---|---|
| Icon | 512x512 PNG, no alpha | `metadata/android/en-US/images/icon.png` |
| Feature graphic | 1024x500 PNG or JPEG, no alpha | `.../images/featureGraphic.png` |
| Phone screenshots | 2 to 8, each side 320-3840px | `.../images/phoneScreenshots/` |
| Tablet screenshots | optional, 0 to 8 | `.../images/sevenInchScreenshots/`, `tenInchScreenshots/` |

The icon can come from the iOS one at
`ios/GradeThread/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`, downscaled
to 512 with the alpha channel flattened onto a solid background.

Screenshots, named so they sort in order (`1_capture.png`, `2_ai_draft.png`):

1. Guided photo capture with the AI fields filling in
2. The finished listing draft
3. The condition grade report and certificate
4. The eBay publish screen with the profit estimate
5. Money tab
6. Inventory grid

Two ways to get them: `node android/scripts/device.mjs screenshot <file>` from a
running device or emulator, or `npm run android:screenshots` and crop the
Roborazzi renders, which are real renders of the real screens.

Do not put a price, a rating or a Play badge inside a screenshot. Play treats an
in-image price as a claim it has to enforce.

---

## Phase 10. The reviewer's demo account

The app is login-gated from the first screen. Without working credentials the
review comes back "we could not access the app".

**10.1** Run the seed script with the production service-role key:

```bash
SUPABASE_URL=https://api.gradethread.com \
SUPABASE_SERVICE_ROLE_KEY=<prod service-role key> \
REVIEW_DEMO_EMAIL=appreview@gradethread.com \
REVIEW_DEMO_PASSWORD=<a strong password> \
node scripts/seed-review-demo-account.mjs
```

**10.2** Sign in as that user **in the app** and create the data a reviewer needs
to see: two or three inventory items, one completed grade with a certificate, a
listing, and a few credits. Doing it through the app is what guarantees the rows
are schema-correct.

**10.3** Put the credentials and the review-notes block from
`PLAY_STORE_SUBMISSION.md` section 3.2 into Play Console, Policy, App content,
App access. The notes explain the sandbox eBay connection and the microphone
permission before a reviewer has to ask.

---

## Phase 11. The App content forms

Play Console, Policy, App content. Every one of these blocks release. Every
answer is written out, with its reasoning, in `PLAY_STORE_SUBMISSION.md` section
3. Work down that list rather than answering from memory:

Privacy policy, App access, Ads (no), Content rating, Target audience (18+),
News (no), Data safety, Government apps (no), Financial features (no), Health
(no), Account deletion (both paths).

Two things to decide before you fill in Data safety:

- ⚠ **Analytics is location-aware and all three clients agree.** This line used
  to say "defaults to ON in the Android app and OFF on iOS", and that was never
  true of either - iOS read `object(forKey:) ?? true`, so both phones were
  opt-out. Android mirrored the web in US-2897 and iOS followed in US-2914, so
  the rule is now one rule: opt-in everywhere except the United States, opt-in
  whenever the country is unknown, an explicit choice honoured under either
  regime. Describe the three clients identically on the form. The reasoning is
  in `vault/20-domain/client-analytics-consent.md`.
- **The public support email**, which is shown on the listing.
  `support@gradethread.com` is the answer the checklist assumes, and it matches
  the domain that already has mail authentication set up.

---

## Phase 12. First build, to the internal track

Internal testing has no review queue and reaches testers in minutes. That is
where you find the crash that only happens on a real device.

**12.1** Confirm the code is green:

```bash
npm run verify:android
```

**12.2** Fire the release lane. Either push a tag:

```bash
git tag android-v1.0.0 && git push origin android-v1.0.0
```

or run **Actions, Android Release, Run workflow** and pick `internal`. A dispatch
leaves the version name at the project default; the tag is what sets `1.0.0`.

The lane pulls the secrets from Infisical, asserts each one by name, builds,
**fails if the bundle came out unsigned**, checks the per-ABI download size,
uploads to Play with the listing text and images, and sends the R8 mapping to
Sentry so crash reports are readable.

**12.3** Install it on a real device from the internal track and sign in. This is
the check for Phase 4.

---

## Phase 13. App Links, after the first upload exists

`https://gradethread.com/.well-known/assetlinks.json` returns **503** today, with
a body naming the variable it wants. Until it returns 200, tapping a
gradethread.com link opens a browser rather than the app, and the OAuth sign-in
return uses its custom-scheme fallback rather than the App Link.

**13.1** Play Console, Release, Setup, App integrity, App signing. Copy the
**SHA-256 certificate fingerprint** of the app signing key. Colon-separated
uppercase hex. This value does not exist before the first upload, which is why
this phase is here and not in Phase 2.

**13.2** Cloudflare Pages project, Settings, Environment variables:

| Variable | Value |
|---|---|
| `ANDROID_PACKAGE_NAME` | `com.gradethread.myapp` |
| `ANDROID_CERT_SHA256` | the fingerprint from 13.1 |

Redeploy the Pages project. Environment variables only take effect on a new
deployment.

**13.3** Verify:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://gradethread.com/.well-known/assetlinks.json
node android/scripts/device.mjs deeplink https://gradethread.com/app/auth-callback
```

200 and the app opening are the two things you want.

---

## Phase 14. Prove somebody can actually pay

Play Console, Setup, License testing. Add your own Google account. Testers buy
every product with no charge and on a compressed clock, where a monthly
subscription renews every five minutes. The server tags those grants as sandbox
so they never look like revenue.

Run all five, in order, on the internal build:

1. Buy `flipdesk_pro_monthly`. The users row flips to `pro` with billing source
   `googleplay`.
2. Buy `credits_25`. Balance goes up by 25, and verifying the same purchase again
   grants nothing more.
3. Cancel in Play. Access holds until the period end.
4. Let it expire. The RTDN lapses it, or the daily sweep does within 72 hours.
5. Buy the same product on a second account. Rejected, because a purchase token
   is bound to one user.

Step 1 failing at the server with a constraint error would mean the `googleplay`
billing-source fix has not reached production. It is on main and applied, so this
should pass; it is listed because it is the failure that costs a real customer
real money.

---

## Phase 15. Submit

**15.1** Push everything to production as a **draft**:

```bash
cd android && bundle exec fastlane production
```

or the workflow with track `production`. The lane uploads as a draft on purpose.
Play has no un-publish, only a halt that leaves a bad build on every device that
already took it.

**15.2** Open Play Console and roll it out by hand.

**15.3** First review on a new developer account takes days, not hours.
Rejections usually name a form from Phase 11 rather than the binary.

**15.4** Work the full checklist in `PLAY_STORE_SUBMISSION.md` section 7 before
you click. It is the same ground as this runbook, in checkbox form.

---

## When something breaks

| Symptom | Almost always |
|---|---|
| fastlane: permission denied on upload | The Play Console role grant from 3.2 has not propagated. Wait a day. |
| Play rejects the bundle as unsigned | The keystore variables are missing from Infisical. The lane catches this now. |
| The build succeeds, nobody can sign in | `SUPABASE_ANON_KEY` was empty at build time (Phase 4). |
| A price shows but the buy button does nothing | The subscription has a base plan and no offer (Phase 8). |
| Buyer charged, no plan granted | The three Coolify variables from Phase 6, or a product id that does not match. |
| RTDN never arrives | The secret in the subscription URL does not match Coolify, or the publisher grant in 7.2 is missing. |
| Links open the browser instead of the app | `ANDROID_CERT_SHA256` is not set on Pages, or Pages was not redeployed (Phase 13). |
| Version code rejected as already used | Never hand-edit it. The lane uses the run number. |
