<!-- Admin Tasks import file. Select all → paste into /admin/tasks → Import from Markdown. Source of truth: ios/RELEASE.md. Format spec: docs/ADMIN_TASK_IMPORT.md -->
# iOS Release Setup
> One-time setup from a fresh Apple Developer account to a TestFlight build, then the App Store. Source: ios/RELEASE.md.
> End state: app registered at com.gradethread.app, App Store Connect record ready, 8 GitHub secrets set, Release.xcconfig filled, APNs configured on the edge service, first build in TestFlight.
> ~2 hours, mostly waiting on Apple. After this, every future release is just a push to main.

## Phase 1 · Apple Developer enrollment
- [ ] Enroll in the Apple Developer Program !high
  https://developer.apple.com/programs/enroll
  Sign in with the Apple ID that should permanently own the account (billing + ownership tie to it — use a long-term one).
  $99/year. Organization enrollment (Pearson Media LLC) needs a D-U-N-S number and takes 2-7 days; Individual is same-day.
  You can ship the first build under Individual and migrate to the org later.
- [ ] Record your Apple Team ID
  At https://developer.apple.com/account (top-right). 10-char alphanumeric like ABC1234567.
  This becomes the APPLE_TEAM_ID GitHub secret.

## Phase 2 · App IDs + APNs key
- [ ] Register the main App ID
  https://developer.apple.com/account/resources/identifiers/list — + → App IDs → Continue → App → Continue.
  Description: GradeThread. Bundle ID: Explicit → com.gradethread.app.
  Capabilities ON: Push Notifications + Sign in with Apple. Continue → Register.
- [ ] Register the test-target App ID
  Repeat with Description: GradeThread Tests, Bundle ID: com.gradethread.app.tests, no capabilities.
- [ ] Create the APNs Auth Key (.p8) !high
  https://developer.apple.com/account/resources/authkeys/list — + → name "GradeThread APNs" → check APNs → Continue → Register.
  Download the .p8 immediately — Apple allows one download only. Losing it means revoking and starting over.
  Note the Key ID (10-char). This is what the edge service uses to send pushes.

## Phase 3 · App Store Connect
- [ ] Create the app record
  https://appstoreconnect.apple.com/apps → + → New App.
  Platform iOS; Name GradeThread; Primary Language English (U.S.); Bundle ID com.gradethread.app; SKU gradethread-ios; User Access Full Access. Create.
  Sits as "Waiting for Upload" until the first CI build lands.
- [ ] Create the App Store Connect API key (CI upload) !high
  https://appstoreconnect.apple.com/access/integrations/api → Team Keys → Generate API Key.
  Name "GradeThread CI", Access "App Manager". Generate.
  Download the .p8 immediately (one-shot). Note the Key ID and Issuer ID (UUID). This is a different key from the APNs one.

## Phase 4 · Distribution cert + provisioning profile (Windows/OpenSSL)
- [ ] Confirm OpenSSL is available
  Ships with Git for Windows at C:\Program Files\Git\usr\bin\openssl.exe.
  Check: & "C:\Program Files\Git\usr\bin\openssl.exe" version
- [ ] Generate the private key + CSR !high
  In a working folder (e.g. C:\GradeThread-Signing\):
  openssl genrsa -out gradethread-private.key 2048
  openssl req -new -key gradethread-private.key -out gradethread.csr -subj "/CN=GradeThread Distribution/O=Pearson Media LLC/C=US/emailAddress=PEARSONPERFORMANCE@gmail.com"
  Keep gradethread-private.key FOREVER — treat it like a master password.
- [ ] Submit the CSR to Apple → download the .cer
  https://developer.apple.com/account/resources/certificates/list — + → Apple Distribution → Continue → upload gradethread.csr → Continue → Download distribution.cer.
- [ ] Bundle the .cer + key into a .p12 !high
  openssl x509 -inform DER -in distribution.cer -out distribution.pem
  openssl pkcs12 -export -legacy -inkey gradethread-private.key -in distribution.pem -out gradethread-distribution.p12 -name "Apple Distribution"
  The export password becomes P12_PASSWORD (16+ chars) — save it immediately. Use -legacy so Apple's altool accepts the file.
- [ ] Create the App Store provisioning profile
  https://developer.apple.com/account/resources/profiles/list — + → App Store → Continue → App ID com.gradethread.app → select the Distribution cert → Name "GradeThread App Store" → Generate → Download.
  Result: GradeThread_App_Store.mobileprovision.

## Phase 5 · Base64-encode the secrets (PowerShell)
- [ ] Base64-encode the three binary files
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("gradethread-distribution.p12")) | Set-Clipboard   (→ BUILD_CERTIFICATE_BASE64)
  Repeat for GradeThread_App_Store.mobileprovision (→ PROVISIONING_PROFILE_BASE64) and the ASC AuthKey_<ASC_KEY_ID>.p8 (→ APP_STORE_CONNECT_API_KEY_BASE64).
- [ ] Generate the keychain password
  -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })   (→ KEYCHAIN_PASSWORD)
- [ ] Verify the base64 round-trip before pasting
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("gradethread-distribution.p12")); [Convert]::FromBase64String($b64).Length
  Must equal (Get-Item "gradethread-distribution.p12").Length. If not, re-encode with Out-File -Encoding ascii -NoNewline (BOM/line-wrap trap).

## Phase 6 · GitHub secrets
- [ ] Add all 8 repository secrets !high
  https://github.com/dj-pearson/GradeThread/settings/secrets/actions → New repository secret.
  APPLE_TEAM_ID, APP_STORE_CONNECT_API_KEY_ID, APP_STORE_CONNECT_API_ISSUER_ID, APP_STORE_CONNECT_API_KEY_BASE64, BUILD_CERTIFICATE_BASE64, P12_PASSWORD, PROVISIONING_PROFILE_BASE64, KEYCHAIN_PASSWORD.
  Names must match exactly — ios-release.yml reads them by spelling.

## Phase 7 · Release.xcconfig
- [ ] Fill ios/GradeThread/Config/Release.xcconfig
  SUPABASE_ANON_KEY from Supabase Studio → Project Settings → API → anon public.
  SENTRY_DSN from Sentry → Client Keys (DSN). POSTHOG_API_KEY from PostHog project settings.
  URLs use the https:/$()/ escape — $() resolves to nothing, producing https://. Forgetting it breaks the URL silently.
  Do NOT paste service-role keys — only publicly-safe client keys.

## Phase 8 · APNs env vars on the edge service (Coolify)
- [ ] Set APNs env vars in Coolify
  Convert the APNs .p8 to base64: [Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_<APNS_KEY_ID>.p8")) | Set-Clipboard
  In Coolify → edge-functions service → Environment Variables set: APNS_KEY_ID, APNS_TEAM_ID (= APPLE_TEAM_ID), APNS_BUNDLE_ID = com.gradethread.app, APNS_AUTH_KEY_BASE64, APNS_ENVIRONMENT = production.
  Restart the edge service after setting these.

## Phase 9 · First TestFlight build
- [ ] Trigger the release workflow
  Easiest: push to main with any change touching ios/** (ios-release.yml paths filter catches it).
  Or tag: git tag -a ios-v0.1.0 -m "First TestFlight build"; git push origin ios-v0.1.0 (the annotation becomes the "What to test" notes).
  Or Actions → iOS Release → Run workflow.
- [ ] Configure TestFlight after the build processes
  ~10-20 min later: appstoreconnect.apple.com → app → TestFlight → the new build.
  Test Information: feedback email, privacy policy URL (required: https://gradethread.com/privacy).
  Export Compliance auto-approves (ITSAppUsesNonExemptEncryption = false). Groups → Internal Testing → add testers. Paste the release notes into What to Test.

## Phase 10 · App Store submission (when ready)
- [ ] Add a real app icon in Assets.xcassets/AppIcon.appiconset
  Apple rejects builds without one.
- [ ] Confirm the privacy policy URL is live at https://gradethread.com/privacy
- [ ] Produce App Store screenshots
  6.7" iPhone (1290x2796) + 13" iPad (2064x2752) at minimum.
- [ ] Complete App Information
  Description, keywords, support URL, marketing URL.
- [ ] Complete the age-rating questionnaire
  Expect 17+ for commercial/selling activity (see PRIVACY_LABELS.md).
- [ ] Fill App Review Information
  Contact email + demo account credentials in ios/fastlane/metadata/review_information/demo_user.txt + demo_password.txt (committed values are *_PLACEHOLDER).
- [ ] Set App Privacy data-collection disclosures
  Match what Sentry/PostHog/Supabase collect; see ios/fastlane/metadata/PRIVACY_LABELS.md.
