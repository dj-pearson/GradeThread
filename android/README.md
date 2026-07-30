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
annotated photos ·
credit-pack Play Billing ·
Home, Money (KPIs, cash flow, aging, time-on-market, ROI-by-source, per-item
P&L), Sales, Expenses, Settings.

**Not built.** The remaining work is the expensive half, not a polish pass:

| Area | Owning story |
|---|---|
| Scheduled drops, automations | US-1361, US-1362 |
| Payout reconciliation | US-1365 |
| Subscription billing + paywall / plan gates | US-1366, US-1367 |
| Analytics, community insights | US-1368, US-1369 |
| Consignment, templates, Scout/Prospect, verified badge, passport, fulfilment | US-1372–1377 |
| FCM push, Glance widgets, onboarding, referrals, feedback, workspaces, CSV import | US-1378–1389 |
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
| `billing` | `Billing/` | Play Billing credit packs (no subscriptions — US-1366) |
| `platform` | `Networking/` + `Telemetry/` | EdgeAPI, Supabase, Sentry/PostHog, workspace scope, app lock |

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
