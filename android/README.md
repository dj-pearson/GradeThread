# GradeThread Android

Native Kotlin/Compose client, **partway through** the US-1299 conversion backlog.
The iOS app is the behavioural source of truth.
Reference: [`vault/90-archive/android-conversion-plan.md`](../vault/90-archive/android-conversion-plan.md).

## Status — read this before estimating (US-2015)

**This client is NOT at iOS parity.** It previously said it was, next to a package
map for directories that contained no code; both are corrected below. iOS has
~578 Swift files across ~60 feature areas, Android ~250 Kotlin files across ~12.

**Built and wired:** auth (PKCE) · Room offline cache + sync coordinator, delta
pull, mutation queue *and its replay*, delete reconciliation · CameraX capture and
staged uploads · AI attribute extraction · Snap-to-Value · the full certified
grading path (validate → submit → poll → report → dispute, plus bulk) · inventory
list and item canvas (photos, measurements, comps, eBay specifics) · global search ·
eBay OAuth connect · eBay listing sync (pull → poll → provenance-aware merge),
the unified listing card, and publish/relist with pre-flight, listing-time
category specifics and a live profit estimate · the negotiation inbox (offers,
send-offer, buyer messages) · bulk pricing · orphan-listing reconciliation with
the shell-wide banner · per-listing promotions and markdown sales · post-sale
shipping and feedback · repricing rules with scan-driven suggestions ·
AutoLister batches, photo QA and the drafts library · flaw disclosure with
annotated photos · timezone-aware scheduled drops · trigger/action/scope
automations ·
payout reconciliation against the recorded sales ·
Play Billing for credit packs and FlipDesk subscriptions ·
the paywall, the one-time post-signup plan step and the shell-wide plan gate ·
analytics (grade distribution, brands, sell-through, inventory value, grading ROI,
a range selector and an on-demand AI summary) with the listing-performance
drill-down ·
community benchmarks with brand deep-links into inventory ·
consignors, per-item splits and the payout report ·
listing templates applied from the publish composer ·
Scout (graded, profit-ranked eBay candidates) and in-store Prospect ·
verified-seller status with an offline-tolerant requirements checklist ·
the item passport (pedigree timeline with confidence per hop) ·
the shipping queue with tracking entry and offline-queued mark-shipped ·
FCM push (channels, deep-linked taps, inline accept/counter/mark-shipped/reconnect) ·
Home, Money (KPIs, cash flow, aging, time-on-market, ROI-by-source, per-item
P&L), Sales, Expenses, Settings.

**Not built.** The remaining work is the expensive half, not a polish pass:

| Area | Owning story |
|---|---|
| Glance widgets, onboarding, referrals, feedback, workspaces, CSV import | US-1379–1389 |
| Localization (`values-*`, plurals, locale selector) | US-1393 |

Nothing in that table has an Android implementation — do not treat any of it as
"nearly done" because the offline-sync foundation underneath it is solid.

## Stack (pinned in `gradle/libs.versions.toml`)

Kotlin 2.1.20 · AGP 8.9.2 · Gradle 8.13 (wrapper) · JDK 17 ·
Jetpack Compose (BOM 2025.04) + Material 3 · Hilt · Room · DataStore ·
Navigation-Compose · Coroutines/Flow. minSdk 26, target/compileSdk 35.

## Build

```bash
# Windows dev machines (this repo's loop host): toolchain via scoop —
#   scoop bucket add java && scoop install temurin17-jdk gradle
# local.properties (gitignored) points sdk.dir at the local Android SDK.
./gradlew assembleDebug testDebugUnitTest lintDebug
```

CI: `.github/workflows/android-ci.yml` runs assembleDebug + unit tests + lint
on every push/PR touching `android/**` (ubuntu image ships the SDK).

## Package map

Only packages that **exist and contain code**. The earlier version of this table
listed `grading` / `inventory` / `marketplaces` / `money` / `billing` before any of
them had a single `.kt` file, which read as a finished architecture to anyone who
opened the project (US-2015). Add a row when the code lands, not before.

| Package (`com.gradethread.app.…`) | iOS counterpart | Owns |
|---|---|---|
| `auth` | `Auth/` | PKCE sign-in/up, session store, auth-state Flow |
| `sync` | `Persistence/` + sync engine | Room cache, delta pull, mutation queue + replay, Realtime, delete reconcile |
| `capture` | `Capture/` | CameraX intake, staged uploads, capture drafts |
| `upload` | `Upload/` | WorkManager photo uploads, signed URLs |
| `ai` | `AIExtract/` | attribute extraction + review sheet |
| `vision` / `speech` | on-device ML | ML Kit OCR + barcode, dictation |
| `snap` | `Snap/` | Snap-to-Value free grade |
| `grading` | `Grading/` | validate/submit/poll, reports, certificates, disputes, bulk |
| `inventory` | `Inventory/` + `DetailsIntake/` + `Measure/` | list, facets, item canvas, photos, measurements, comps, eBay aspects, search |
| `marketplaces` | `Marketplaces/` | eBay OAuth connect + multi-account (connect only — no listing lifecycle yet) |
| `money` | `Money/` + `Sales/` + `Dashboard/` | rollups (KPIs, cash flow, aging, ROI, P&L), sales list, expenses |
| `home` | `Dashboard/` + `Onboarding/` | snapshot, sparkline, quick actions, activation checklist |
| `settings` | `Settings/` | profile, plan, preferences, diagnostics, sign-out |
| `billing` | `Billing/` | Play Billing credit packs + FlipDesk subscriptions, paywall, post-signup plan step |
| `plangate` | `PlanGate.swift` | shell-wide 402 upgrade dialog + 80% soft-warning banner |
| `analytics` | `Analytics/` | grade/brand/sell-through/value/ROI rollups, AI narrative, listing performance, community benchmarks |
| `consignment` | `Consignment/` | consignor CRUD (RLS-scoped), per-item split picker, payout report |
| `templates` | `Templates/` | listing-preset CRUD (RLS-scoped), editor, apply-to-composer |
| `scout` | `Scout/` + `Prospect/` | ScoutAI deal finder, in-store photo prospecting, buy-or-walk verdict |
| `verified` | `Verified/` | read-only badge status, requirements checklist, cached-offline standing |
| `passport` | `Passport/` | PII-free pedigree timeline, confidence taxonomy, chain strength |
| `fulfillment` | `Fulfillment/` | shipping queue, tracking entry, mark-shipped (eBay or local, offline-queued) |
| `platform` | `Networking/` + `Telemetry/` | EdgeAPI, Supabase, Sentry/PostHog, workspace scope, app lock, FCM push |

## Play Billing (US-1338, US-1366)

The client never decides an entitlement. It sends the product id and the purchase
token to `POST /api/payments/google/verify`, which checks the token with Google,
maps it through `ANDROID_CATALOG` in the edge's `lib/google-play/products.ts`, and
grants the plan or the credits. Anything Play-specific sits behind the
`PlayBilling` interface so the whole purchase path runs against `FakePlayBilling`
in a plain JVM test.

**Product ids** must match the Play Console (Monetize → Products) AND the server
catalog exactly. The server fails closed on an unknown id, so a typo is a purchase
the buyer completes and is never credited for. `SubscriptionCatalogTest` and
`CreditTopUpFlowTest` pin both lists.

| Kind | Product ids | Console type |
|---|---|---|
| Subscriptions | `flipdesk_{starter,pro,business}_{monthly,yearly}` | Subscription (one base plan each) |
| Credit packs | `credits_{10,25,50,100}` | One-time product, **consumable** |

**Testing a purchase without spending money.** Play has no local sandbox — a
purchase always goes through a real Play Store on a real signed build:

1. Upload a signed build to an internal-testing track (the app must be published
   to a track before Billing responds at all; an unpublished app returns an empty
   product list, which looks exactly like a typo in the ids).
2. Play Console → Setup → License testing: add the tester's Google account. Their
   purchases are free, renew fast (a monthly sub renews every ~5 minutes), and can
   be refunded from the order page.
3. Install as that account from the internal-testing link, not by sideloading —
   Billing checks the install source.
4. Google's reserved ids (`android.test.purchased` and friends) work only for the
   deprecated AIDL flow and are **not** usable with Billing 7. Use real test SKUs.

**Where the plans are shown.** `PaywallScreen` (route `ShellRoutes.PAYWALL`,
reached from Settings → Plan, Settings → Grading credits, or any plan gate),
`PlanStepHost` (the one-time post-signup step, rendered over the shell and
recorded per ACCOUNT so a shared tablet still asks the second person), and
`PlanGateHost` (the 402 dialog + 80% banner, mounted once above the section
content so a cap hit in any tab reaches the seller).

Settlement rules the tests hold to: consumables are **consumed** (so they can be
bought again), subscriptions are **acknowledged** (Play auto-refunds an
unacknowledged purchase after three days), and NEITHER happens until the server
has confirmed the grant.

## Push (US-1378)

There is deliberately **no `google-services` Gradle plugin and no
`google-services.json`**. That plugin fails the build outright when the file is
absent, which would stop anyone building this app without Firebase credentials
that aren't ours to commit. Firebase is initialized by hand in `PushConfig` from
four BuildConfig values — `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`,
`FIREBASE_API_KEY`, `FIREBASE_SENDER_ID` — supplied like every other secret (CI
env var, then `local.properties`). **All four or none:** a half-configured client
initializes fine and then fails on the first token request. An unconfigured build
simply has no push, the same DSN-gated shape Sentry uses.

Tokens register at `POST /api/notifications/register` with `platform=fcm` on
every cold start (the route is idempotent, and the server prunes stale tokens —
a client that only registered on rotation would never come back). Sign-out
`DELETE`s the token **before** clearing the session, since unregistering needs
that session to authenticate.

Five channels, not one per category: `money`, `selling`, `grading`, `urgent`,
`updates`. Only `urgent` (an expiring eBay token) bypasses Do Not Disturb.
POST_NOTIFICATIONS is requested at a **money moment** (first sale / first grade),
never at launch — Android auto-denies the second dialog, so there is one real ask.

## Background refresh (US-1379)

A `PeriodicWorkRequest` (30 minutes, 10-minute flex, `CONNECTED` +
`requiresBatteryNotLow`) runs the same pull the foreground uses, then compares
what arrived against a stored baseline and posts a local notification for
anything new. `sync/BackgroundRefresh.kt` holds every decision and is pure, so
the part that runs with nobody watching is the part under test.

Three rules that are not obvious:

- **No baseline, no notifications.** `baselineEstablished` is tracked separately
  from the id sets being empty, because "brand-new account with no sales" and
  "never baselined" are different states. Conflating them is how a first sync
  announces an entire back catalogue.
- **The baseline is written AFTER posting.** A crash between the two re-notifies.
  A duplicate is a nuisance; a missed sale alert is the thing this prevents.
- **Past three findings it collapses to one summary.** A wall of notifications
  teaches people to swipe the lot away unread.

`ExistingPeriodicWorkPolicy.KEEP` on every cold start doubles as the reboot
rescheduler (WorkManager restores its own queue), and REPLACE would reset the
period each launch so a frequent user would never reach a run. Settings has a
toggle that moves the stored flag and the schedule together; sign-out clears the
baseline so the next account doesn't inherit the previous seller's.

## Home-screen widget (US-1380)

Glance, in `widget/`. The app computes a small rollup after every sync and
writes it to one DataStore key; the widget only ever reads it back. **No Room
and no network at render** — a widget draw runs on the system's schedule with a
hard budget, and anything slow shows up as a blank tile.

iOS needs an App Group container because its widget is a separate process.
Glance runs inside the app process, so a plain DataStore is enough — no shared
container, no extra entitlement. One JSON blob rather than seven keys, so a read
is atomic; half-updated numbers are worse than slightly old ones.

`WidgetPublisher.decide` is the coalescing rule and is pure: identical numbers
publish nothing at all, and a change landing inside the 30-second window is
stored but held. Unlike iOS, which drops the held reload, Android schedules a
`WidgetReloadWorker` for the rest of the window — otherwise a change one second
after a reload is stranded until the next sync.

Taps go through `com.gradethread.app://widget/…` (US-1314's grammar), not the
https app link: an unverified app link falls back to a browser chooser, and a
seller tapping their own sales figure should never be asked which app to open.

Sign-out **overwrites** the snapshot with the signed-out placeholder rather than
deleting it. Deleting leaves the store empty, which is indistinguishable from
"never published", so the next publish would redraw every widget for nothing.
Signed-out is also deliberately distinct from an all-zero signed-in snapshot,
which is a real seller having a quiet day.

TalkBack labels are composed in `WidgetCopy` rather than inline, because a
Glance composable cannot be asserted from a JVM test and the spoken label is the
only version of this widget some sellers ever get.

## Non-negotiables carried from iOS (see the plan's "hard parts")

- Offline sync invariants: watermark reset BEFORE row wipe on sign-out;
  create-before-edit replay ordering; deletes reconciled explicitly.
- Every client-minted UUID is **lowercased** at creation (Postgres normalizes;
  case-mismatched ids caused duplicate-item sync bugs on iOS).
- Plan-gate: 402 body + `X-Plan-Warning` header intercepted on EVERY response.
- Photo presence = the `photos` relation, never the denormalized cover URL.
- Only COMPLETED sales count toward any money figure (migration `00111`), and
  every profit number nets through `money/SalePnL.kt` — the one definition shared
  with iOS's `GradeThreadCore/SalePnL.swift` and the web's `src/lib/pnl.ts`.
- Money sums go through `money/Money.kt` (BigDecimal, HALF_UP), never
  `sumOf { }` — float drift passes a cent on the set sizes a real seller has.

### A caution about wiring, learned twice here

Three subsystems were built, unit-tested, and then never called: the sync pull
primitives (US-2151), the mutation-queue drain, and `SessionScope.signOutWipe`.
Each looked complete — the tests passed and the code was right — but nothing in
production invoked them, so Room stayed empty, offline edits never reached the
server, and sign-out left the previous account's data on the device. When you add
a component here, **grep for a production caller before calling it done.**
