---
title: Android conversion plan (superseded)
type: reference
status: archived
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [android, plan, superseded]
summary: Superseded by the 51-story Android epic in the backlog.
---

> [!info] Archived 2026-07-19 — superseded
> **As-of date: 2026-06-26.** Superseded by the 51-story Android epic (US-1299,
> US-1329..1379) in the active backlog, which carries the same scope at story
> granularity. Kept for the original reasoning, not as a plan of record.
# GradeThread — Native Android Conversion Plan

> Authored 2026-06-26 from a deep-dive audit of the iOS app (545 Swift files /
> ~94K LOC across ~60 feature modules). This is the reference companion to the
> `US-1299…US-1396` Android conversion backlog in `prd.json`. The iOS app is the
> source of truth for behavior; this doc maps each subsystem to its Android
> equivalent and flags the parts that are NOT a mechanical translation.

## Goal & scope

Ship a **native Android** client at full feature parity with the iOS app — same
backend (self-hosted Supabase + the Deno/Hono edge service), same data model,
same offline-first behavior, same monetization. Web and edge are unchanged
except for the few **backend dependencies** called out below.

## Stack decision (recommended)

| Concern | iOS | Android target |
|---|---|---|
| Language | Swift 6 | Kotlin |
| UI | SwiftUI | Jetpack Compose + Material 3 |
| DI | manual / env injection | Hilt |
| Local store | SwiftData | Room |
| Preferences | UserDefaults / `@AppStorage` | DataStore (Proto) |
| Secrets at rest | Keychain | EncryptedSharedPreferences (Keystore-backed) |
| Concurrency | async/await + actors | Coroutines + Flow |
| HTTP | URLSession + custom `EdgeAPI` | OkHttp + Retrofit + interceptors |
| Backend SDK | supabase-swift | supabase-kt |
| Camera | AVFoundation | CameraX |
| OCR / barcode | Vision | ML Kit |
| Dictation | Speech (`SFSpeechRecognizer`) | `SpeechRecognizer` |
| Background work | BGTaskScheduler | WorkManager |
| Push | APNs + `UNUserNotificationCenter` | FCM + `NotificationManager` |
| Widgets | WidgetKit + App Group | Glance + DataStore |
| Voice/Spotlight | App Intents / Siri | App Shortcuts + Assistant App Actions |
| Share-in | Share Extension + App Group inbox | Share target Activity + Room inbox |
| Biometric lock | LocalAuthentication | BiometricPrompt + device credential |
| OAuth web | ASWebAuthenticationSession | Chrome Custom Tabs |
| Deep links | Universal Links + custom scheme | App Links (`assetlinks.json`) + scheme |
| IAP | StoreKit 2 | Google Play Billing v6+ |
| Charts | Swift Charts | Vico |
| Images | async image + cache | Coil |
| Crash/analytics | Sentry-Cocoa + PostHog | Sentry-Android + PostHog-Android |
| Build | XcodeGen + Fastlane → TestFlight | Gradle (KTS) + Fastlane `supply` → Play Console |

## Routing / endpoints (unchanged from iOS — see `CLAUDE.md`)

- **Supabase (Kong):** `https://api.gradethread.com` — Auth, PostgREST, Realtime,
  Storage. Self-hosted; anon key is public (RLS enforces access).
- **Edge (Deno/Hono):** `https://functions.gradethread.com` — ALL `/api/*`
  routes: `/api/grade/*`, `/api/flipdesk/*`, `/api/payments/*`,
  `/api/notifications/*`. Hitting `/api/*` on `api.*` 404s.
- Auth: Bearer JWT on every request; `X-Workspace-Owner` header for tenant
  routing. Plan-gate signals arrive as **402 body** (`PlanGateError`) and the
  **`X-Plan-Warning` header** (can ride on ANY status) — intercept on every
  response. AI calls use a longer idle timeout (~120s) than the 20s default.

## The hard parts (NOT a mechanical port)

1. **Offline sync engine.** The single biggest subsystem. Delta pull via
   per-table watermarks (drop-safe advancement so an undecodable row is never
   skipped past), conflict resolution (server-owned vs user-owned-if-locally-
   edited vs timestamp vs eBay-listing-origin), an offline mutation queue with
   idempotent replay, **create-before-edit ordering**, terminal-vs-transient
   error classification, delete reconciliation (delta never reports server-side
   deletes), and Realtime catch-up pulls on every re-subscribe. Correctness
   invariants that MUST survive the port: sign-out wipes cache+queue+watermarks
   (watermark reset BEFORE row wipe); workspace switch re-scopes cache + re-homes
   the Realtime channel; photo presence is the `photos` relation, not the
   denormalized cover URL. See the persistence stories US-1315…US-1322.

2. **Billing — platform-specific, with a backend dependency.** iOS verifies
   StoreKit JWS at `POST /api/payments/appstore/verify`. Android needs a **new
   server endpoint `POST /api/payments/google/verify`** that validates a Google
   Play purchase token via the Play Developer API and flips the same server-side
   plan/credit state. Product IDs differ (Play Console SKUs vs App Store ids);
   the iOS↔server product map must gain an Android column. Stripe-web-sub
   conflict handling (409 → route to web billing) is reused as-is.

3. **Secure photo upload.** Two-phase: mint a short-TTL **signed upload URL**
   (so a long-lived bearer JWT is never persisted to a background-task DB on
   disk) → upload bytes → upsert the `item_photos` row with a **deterministic
   id** (= upload task UUID, lowercased to match RLS `auth.uid()::text`).
   Bucket routing: sensitive slots (tag, tag_2, certificate) → PRIVATE
   `submission-images` (no public URL; signed read URL, TTL ≤ 900s); everything
   else → public `item-photos`. EXIF stripped to orientation-only (US-276).
   WorkManager replaces the background URLSession; encrypt staged JPEGs at rest.

## Backend / infra dependencies (outside the Android app)

These block specific stories and should be tracked as their own work on the
edge/web/ops side:

- `POST /api/payments/google/verify` — Google Play purchase verification +
  plan/credit grant (mirrors the App Store verifier). **Blocks billing.**
- Push fan-out must support an `android`/FCM platform in
  `push_device_tokens` + send via FCM (Firebase Admin) alongside APNs.
- `https://gradethread.com/.well-known/assetlinks.json` — App Links
  verification (package name + signing-cert SHA-256). **Blocks verified deep
  links.**
- Firebase project (FCM + optionally App Indexing) and a Google Play Console
  app record with the SKU catalog mirrored from `APP_STORE_SUBMISSION.md`.
- Photo-profile + all `/api/flipdesk/*`, `/api/grade/*` endpoints already exist
  and are client-agnostic — no change needed.

## Phase map (backlog index)

| Phase | Stories | Theme |
|---|---|---|
| A — Foundation | US-1300…US-1309 | Project scaffold, theme, components, networking, Supabase SDK, telemetry, tenant scope |
| B — Auth & shell | US-1310…US-1315 | PKCE auth, OAuth, captcha, adaptive nav shell, deep links, app lock |
| C — Persistence & sync | US-1316…US-1323 | Room schema, sync engine, conflict policy, mutation queue, reconciliation, Realtime, sign-out/workspace correctness |
| D — Capture, AI & grading | US-1324…US-1341 | CameraX intake, upload pipeline, profiles, dictation, barcode, OCR, AI extract, Snap, certified grading, disputes |
| E — Inventory & canvas | US-1342…US-1349 | List/triage, item canvas, photos, measurements, comps, aspects, bulk actions, global search |
| F — Marketplaces & eBay | US-1350…US-1362 | OAuth, sync, publish/relist, specifics, negotiation, bulk pricing, reconciliation, repricing, AutoLister, disclosure, scheduled drops, automations |
| G — Money, billing & analytics | US-1363…US-1377 | Money dashboard, expenses, payouts, Play Billing, paywall, analytics, insights, home dashboard, sales, consignment, templates, scout/prospect, verified, passport, fulfillment |
| H — Platform & system | US-1378…US-1390 | FCM, background refresh, Glance widgets, shortcuts, share target, settings, onboarding, referrals, support, feedback, teams, import, state restoration |
| I — Release, l10n, privacy & QA | US-1391…US-1396 | Gradle CI, release/Play upload, localization, privacy/data-safety, test suite, accessibility audit |

US-1299 is the umbrella/epic that tracks the whole conversion.

## Testing parity

Mirror the iOS test posture: pure rollups (Money/Analytics/Dashboard) are unit-
testable with no I/O; sync (conflict policy, drop-safe cursor, mutation
ordering, reconciliation protection) gets a dedicated unit suite; a small
Compose-UI / critical-flow E2E lane (sign-in, paywall, capture→grade→draft)
runs on an emulator in CI. Billing is exercised with Play Billing's test SKUs
and a fake `BillingClient` in unit tests.
