# GradeThread iOS

Native iOS client. Builds, tests, and ships exclusively through GitHub
Actions on macOS runners — no local Xcode required for contributors on
non-Mac hardware.

## Project layout

```
ios/
  project.yml            ← XcodeGen spec (source of truth)
  GradeThread/
    App.swift            ← @main entry
    ContentView.swift    ← Tab bar shell (Inventory / Add / Sales / Settings)
    Info.plist           ← Bundle config
    Assets.xcassets/     ← AppIcon, AccentColor (brand navy)
  GradeThreadTests/
    GradeThreadTests.swift
  .gitignore             ← excludes generated .xcodeproj and signing artifacts
```

The `.xcodeproj` is **not** checked in. CI runs `xcodegen generate` first.
For local Xcode work (if you're on a Mac):

```bash
brew install xcodegen
cd ios
xcodegen generate
open GradeThread.xcodeproj
```

## CI/CD

All workflows live in `.github/workflows/`:

| Workflow              | Triggers                                                       | What it does                                                                                                |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ios-ci.yml`          | push/PR touching `ios/**`                                       | xcodegen → xcodebuild test on iPhone 15 simulator                                                            |
| `ios-release.yml`     | push to `main` touching `ios/**`, `ios-v*` tag, manual dispatch | archive → export .ipa → upload to TestFlight; surfaces auto-generated release notes in the workflow summary |

> **First-time setup?** Read [`RELEASE.md`](./RELEASE.md) — step-by-step
> from a fresh Apple Developer account through your first TestFlight build,
> with PowerShell base64 commands for every secret. The rest of this README
> is a high-level reference for contributors who already have the project
> running.

### Required GitHub secrets (release workflow)

Set these under **Settings → Secrets and variables → Actions**:

| Secret                                | Source                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `APP_STORE_CONNECT_API_KEY_ID`        | App Store Connect → Users and Access → Keys → Key ID                   |
| `APP_STORE_CONNECT_API_ISSUER_ID`     | Same page → Issuer ID                                                  |
| `APP_STORE_CONNECT_API_KEY_BASE64`    | `base64 < AuthKey_XXXXX.p8` (the downloaded .p8 file, base64-encoded) |
| `APPLE_TEAM_ID`                       | developer.apple.com → Membership → Team ID                             |
| `BUILD_CERTIFICATE_BASE64`            | Distribution cert (.p12) → `base64 -i cert.p12`                        |
| `P12_PASSWORD`                        | Password used when exporting the .p12                                  |
| `PROVISIONING_PROFILE_BASE64`         | App Store provisioning profile → `base64 -i profile.mobileprovision`   |
| `KEYCHAIN_PASSWORD`                   | Any strong random string — ephemeral CI keychain password              |

### App Store Connect setup (one-time)

1. **Create the app record** in App Store Connect with bundle ID
   `com.gradethread.app`.
2. **Generate an App Store Connect API key** (Admin role) and download the
   `.p8`. Save the Key ID + Issuer ID alongside.
3. **Create a Distribution certificate** (Apple Distribution) in Xcode or
   via developer portal, export as `.p12`.
4. **Create an App Store provisioning profile** for the bundle ID, signed
   by the distribution cert.
5. Encode all three as base64 and load them into the GitHub secrets above.

The release workflow re-creates the signing keychain on each run — nothing
persists between jobs and no secrets ever land in artifacts.

### Cutting a release

Three paths:

**Automatic beta (every merge to main)**

A push to `main` that touches anything under `ios/` automatically
archives + uploads to TestFlight. Build number = `GITHUB_RUN_NUMBER`
so each upload is monotonic without manual bumping. Release notes
are scraped from `git log <previous-ios-tag>..HEAD -- ios/` and
surfaced in the workflow summary (paste them into the build's
"What to test" field in App Store Connect; full automation via
`fastlane pilot` is a follow-up).

**Tagged version bump**

```bash
git tag -a ios-v0.2.0 -m 'Drop -10% bulk action + Realtime channel'
git push origin ios-v0.2.0
```

The tag annotation becomes the release-notes body verbatim.

**Manual (App Store submission)**

Run the **ios-release** workflow with `submit_to_app_store: true`.
The build is uploaded and submitted for review with metadata pulled
from `ios/fastlane/metadata/` (lands in US-197).

### TestFlight tester groups

App Store Connect → TestFlight tab → External Testing. Create two
groups once:

1. **Internal** — Pearson Media team members. Internal testers don't
   need a beta review for each build; they get builds as soon as the
   upload finishes processing.
2. **Beta** — external power users on the waitlist. First build
   requires beta-review (24–48h); subsequent builds within the same
   build train don't.

The workflow uploads to TestFlight; group assignment happens in App
Store Connect after the build finishes processing.

### Crash report forwarding

Two channels:

- **Apple-side** — TestFlight automatically collects crash logs when
  testers enable "Share with Developers". Visible under TestFlight →
  Crashes in App Store Connect.
- **Sentry** — production builds initialize Sentry-Cocoa at app
  launch (US-191) with the DSN from xcconfig. Symbol uploads are not
  yet automated; debug-symbol .dSYMs land in
  `${{ runner.temp }}/GradeThread.xcarchive/dSYMs/` and you can
  upload them with `sentry-cli upload-dif` as a manual follow-up.

## Status

| Story | What's done |
|-------|-------------|
| US-168 | ✅ Project scaffold, tab bar shell, CI + release workflows |
| US-169–US-199 | ⏳ Each ships in its own focused session |
| Certified grading | ✅ Request a certified condition grade for an inventory item (`Grading/`): readiness + tier picker → submit via the FlipDesk→GradeThread bridge → live polling → factor-by-factor report + shareable certificate. Surfaced on the item canvas (`CertifiedGradeSection`) and as a grade chip in the inventory list. |
| Grades history | ✅ `GradesListView` — all certified grades in one place (sort, average), reachable from a dashboard card; reports show detected defects + submitted photos. |
| Bulk grading | ✅ Grade a multi-selection from the inventory action bar (`BulkGradeSheet`): batch readiness + tier + credits, submits the ready items. |
| Onboarding | ✅ First-run welcome carousel (`Onboarding/`), shown once at launch. |

See `prd.json` for the full iOS roadmap and `progress.txt` for what's
in-flight.
