# GradeThread Android

Native Kotlin/Compose client at iOS parity — the US-1299 conversion backlog.
Reference: [`vault/90-archive/android-conversion-plan.md`](../ANDROID_CONVERSION_PLAN.md) (the
iOS app is the behavioral source of truth).

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

## Package map (mirrors the iOS feature grouping)

| Package (`com.gradethread.app.…`) | iOS counterpart | Owns |
|---|---|---|
| `auth` | `Auth/` | PKCE sign-in/up, session store, auth-state Flow |
| `sync` | `Sync/` + SwiftData stores | Room cache, delta pull, mutation queue, Realtime |
| `capture` | `Capture/` | CameraX intake, staging uploads, share-in |
| `grading` | `Grading/` | submissions, reports, certificates |
| `inventory` | `Inventory/` | items, photos, item canvas |
| `marketplaces` | `Marketplaces/` | eBay lifecycle, negotiation, AutoLister |
| `money` | `Money/` | sales, P&L, reconciliation |
| `billing` | `Billing/` | Play Billing, plan gates |
| `platform` | `Networking/` + `Telemetry/` | EdgeAPI, Supabase, Sentry/PostHog, workspace scope |

## Non-negotiables carried from iOS (see the plan's "hard parts")

- Offline sync invariants: watermark reset BEFORE row wipe on sign-out;
  create-before-edit replay ordering; deletes reconciled explicitly.
- Every client-minted UUID is **lowercased** at creation (Postgres normalizes;
  case-mismatched ids caused duplicate-item sync bugs on iOS).
- Plan-gate: 402 body + `X-Plan-Warning` header intercepted on EVERY response.
- Photo presence = the `photos` relation, never the denormalized cover URL.
