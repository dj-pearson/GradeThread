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

| Workflow              | Triggers                                       | What it does                                         |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `ios-ci.yml`          | push/PR touching `ios/**`                      | xcodegen → xcodebuild test on iPhone 15 simulator    |
| `ios-release.yml`     | tag `ios-v*` or manual workflow_dispatch       | archive → export .ipa → upload to TestFlight        |

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

Two paths:

**TestFlight beta**

```bash
git tag ios-v0.2.0
git push origin ios-v0.2.0
# ios-release.yml fires, uploads to TestFlight automatically
```

**Manual (App Store submission)**

Run the **ios-release** workflow with `submit_to_app_store: true`. The
build is uploaded and submitted for review with the metadata pulled from
`ios/fastlane/metadata/` (added in US-197).

## Status

| Story | What's done |
|-------|-------------|
| US-168 | ✅ Project scaffold, tab bar shell, CI + release workflows |
| US-169–US-199 | ⏳ Each ships in its own focused session |

See `prd.json` for the full iOS roadmap and `progress.txt` for what's
in-flight.
