# iOS Release Guide — GradeThread

End-to-end walkthrough from a fresh Apple Developer account to a TestFlight build, then to the App Store. All `base64` commands assume PowerShell on Windows (the daily-driver dev machine for this project).

The CI infrastructure is already wired:
- `.github/workflows/ios-ci.yml` — PR + main checks (build + test, unsigned)
- `.github/workflows/ios-release.yml` — archive + sign + upload to TestFlight on `main`/tag/dispatch (pulls all signing secrets from Infisical at runtime)
- `ios/project.yml` — XcodeGen project definition (no `.xcodeproj` in the repo; it's generated on every CI run)
- `ios/GradeThread/Config/{Debug,Release}.xcconfig` — non-secret build-time values surfaced into `Info.plist`
- `ios/GradeThread/GradeThread.entitlements` — APNs + Sign in with Apple capabilities

This guide describes the **one-time setup** to make all of the above actually work. After Phase 1-8 (~2 hours, mostly waiting on Apple), every future release is just a push to `main`.

---

## Phase 0 · What you'll end up with

- App registered at `com.gradethread.app` in Apple Developer
- App Store Connect app record ready to receive TestFlight builds
- 8 signing secrets stored in **Infisical** (`grade-thread` project, `prod` environment) — `ios-release.yml` pulls them at build time
- 3 Infisical-connection secrets in GitHub (`INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_DOMAIN`) — the only secrets that live in GitHub now
- Real Supabase + Sentry + PostHog values in `Release.xcconfig`
- APNs configured on the edge service so pushes to `push_device_tokens` deliver
- A first build sitting in TestFlight

**Everything in this guide runs from Windows.** Apple's tooling assumes a Mac (their docs walk you through Keychain Access), but the underlying crypto and file formats are platform-independent — we generate the signing key + CSR with OpenSSL locally, upload the CSR to Apple's web portal, and bundle the result into a `.p12` from PowerShell. The macOS runner in GitHub Actions does the actual signing.

---

## Phase 1 · Apple Developer Program enrollment

If not already enrolled:

1. https://developer.apple.com/programs/enroll
2. Sign in with the Apple ID that should permanently own the developer account (billing + ownership ties to it — use a long-term one, not a personal alias)
3. **$99/year**, billed via Apple ID
4. **Organization** enrollment for Pearson Media LLC requires a D-U-N-S number and takes 2-7 days. **Individual** is same-day. You can ship the first build under Individual and migrate the app to the org later if needed.
5. Once enrolled, note your **Apple Team ID** at https://developer.apple.com/account → visible top-right. 10-char alphanumeric like `ABC1234567`. This becomes the `APPLE_TEAM_ID` secret in Infisical (Phase 6b).

---

## Phase 2 · Apple Developer Portal — App IDs + APNs key

### 2a. Register the main App ID

1. https://developer.apple.com/account/resources/identifiers/list
2. **+** → **App IDs** → **Continue** → **App** → **Continue**
3. Fill in:
   - **Description:** `GradeThread`
   - **Bundle ID:** `Explicit` → `com.gradethread.app`
4. Under **Capabilities** check **ON**:
   - **Push Notifications** (required — the `push_device_tokens` migration is wired for it)
   - **Sign in with Apple** (the entitlements file already requests it)
5. **Continue** → **Register**

### 2b. Register the test-target App ID

Repeat 2a with:
- Description: `GradeThread Tests`
- Bundle ID: `com.gradethread.app.tests`
- No capabilities needed

### 2c. Create the APNs Auth Key (.p8)

This is what the **edge service** uses to send pushes. One key works for both APNs environments and all apps in the team.

1. https://developer.apple.com/account/resources/authkeys/list
2. **+** → name `GradeThread APNs` → check **Apple Push Notifications service (APNs)** → **Continue** → **Register**
3. **Download the .p8 file immediately** — Apple only allows one download. Losing it means revoking and starting over.
4. Note the **Key ID** shown on the confirmation page (10-char like `ABCD1234EF`)

After Phase 2 you have:
- `AuthKey_<APNS_KEY_ID>.p8`
- APNs Key ID: `<APNS_KEY_ID>`
- Apple Team ID: from Phase 1

---

## Phase 3 · App Store Connect — create app + API key

### 3a. Create the app

1. https://appstoreconnect.apple.com/apps
2. **+** → **New App**
3. Fill in:
   - **Platform:** iOS
   - **Name:** `GradeThread`
   - **Primary Language:** English (U.S.)
   - **Bundle ID:** select `com.gradethread.app — GradeThread` from the dropdown (only appears after Phase 2a)
   - **SKU:** `gradethread-ios` (any unique non-user-visible string)
   - **User Access:** Full Access
4. **Create**

The app sits as "Waiting for Upload" until the first CI build lands.

### 3b. Create the App Store Connect API Key

This is what CI uses to upload builds. **Different from the APNs key.**

1. https://appstoreconnect.apple.com/access/integrations/api
2. **Team Keys** tab → **Generate API Key**
3. **Name:** `GradeThread CI` · **Access:** `App Manager` (sufficient to upload + manage TestFlight; avoid Admin)
4. **Generate**
5. **Download the .p8 immediately** — one-shot download
6. Note:
   - **Key ID** (10-char, shown in the list)
   - **Issuer ID** (UUID like `69a6de70-...`, shown at the top of the page)

After Phase 3 you have:
- `AuthKey_<ASC_KEY_ID>.p8` (the ASC key — different file from the APNs one)
- ASC Key ID + Issuer ID

---

## Phase 4 · Distribution certificate + provisioning profile (Windows / OpenSSL)

No Mac needed. Apple's developer portal accepts any PEM-encoded CSR — Keychain Access is just a UI wrapper around the same OpenSSL primitives we'll use directly.

### 4a. Make sure OpenSSL is available

OpenSSL ships with **Git for Windows** at `C:\Program Files\Git\usr\bin\openssl.exe`. If `git` works in your terminal, OpenSSL is already there.

Confirm in PowerShell:

```powershell
& "C:\Program Files\Git\usr\bin\openssl.exe" version
# → OpenSSL 3.x.x ...
```

If you want to call it as just `openssl`, add it to your PATH for this session:

```powershell
$env:PATH = "C:\Program Files\Git\usr\bin;$env:PATH"
openssl version
```

(Permanent PATH add via System Properties is fine too, but this guide uses the session approach so nothing is permanently changed.)

If you don't have Git for Windows, install it from https://git-scm.com/download/win or grab a standalone OpenSSL build from `winget install ShiningLight.OpenSSL.Light`.

### 4b. Generate the private key + CSR

Pick a working folder (e.g. `C:\GradeThread-Signing\`) and run:

```powershell
# 2048-bit RSA private key — keep this file FOREVER and treat it like
# a master password. Re-generating means you have to redo Phase 4 in
# full and re-sign every existing build.
openssl genrsa -out gradethread-private.key 2048

# Certificate signing request. Fill in your real email + state.
openssl req -new -key gradethread-private.key -out gradethread.csr `
  -subj "/CN=GradeThread Distribution/O=Pearson Media LLC/C=US/emailAddress=PEARSONPERFORMANCE@gmail.com"
```

You now have two files:
- `gradethread-private.key` — the secret half. Never upload it anywhere; back it up to a password manager or encrypted USB.
- `gradethread.csr` — the public half. This is what Apple signs.

### 4c. Submit the CSR to Apple → download the .cer

1. https://developer.apple.com/account/resources/certificates/list
2. **+** → **Apple Distribution** → **Continue**
3. **Choose File** → upload `gradethread.csr` → **Continue**
4. **Download** the resulting `distribution.cer` (DER-encoded binary)

### 4d. Bundle the .cer + private key into a .p12

Apple ships the `.cer` in DER format. Convert to PEM, then merge with the private key into a single password-protected `.p12`:

```powershell
# 1. Convert Apple's .cer (DER binary) to PEM text
openssl x509 -inform DER -in distribution.cer -out distribution.pem

# 2. Bundle cert + private key. Use -legacy so Apple's altool (which
#    uses an older PKCS#12 reader) accepts the file without
#    "MAC verification failed" errors. The -legacy flag exists in
#    OpenSSL 3.x and is a no-op on older versions.
openssl pkcs12 -export -legacy `
  -inkey gradethread-private.key `
  -in distribution.pem `
  -out gradethread-distribution.p12 `
  -name "Apple Distribution"
```

When prompted **"Enter Export Password"**, type a strong password (16+ chars). **This becomes the `P12_PASSWORD` secret in Infisical** (Phase 6b) — save it in 1Password / Bitwarden immediately. Losing it means redoing Phase 4 in full.

Confirm the .p12 is well-formed:

```powershell
openssl pkcs12 -info -in gradethread-distribution.p12 -nokeys -passin pass:YOUR_P12_PASSWORD
# → should print "subject=CN = Apple Distribution: <your team> ..."
```

If you see an error like `Mac verify error: invalid password?`, the password didn't match what you typed during export — re-run step 2 with a fresh password.

### 4e. Create the App Store provisioning profile

1. https://developer.apple.com/account/resources/profiles/list
2. **+** → **App Store** (under Distribution) → **Continue**
3. **App ID:** select `com.gradethread.app` → **Continue**
4. **Certificates:** select the Distribution cert from 4c (its CN will start with `Apple Distribution: <team name>`) → **Continue**
5. **Provisioning Profile Name:** `GradeThread App Store` → **Generate** → **Download**

You now have `GradeThread_App_Store.mobileprovision`.

### 4f. Files you should have on disk

In your `C:\GradeThread-Signing\` folder (or wherever you worked):

| File | Keep where? | Used for |
|---|---|---|
| `gradethread-private.key` | password manager / encrypted backup | regenerating future certs if Apple revokes; never goes to CI |
| `gradethread.csr` | can delete after Phase 4c | one-shot upload to Apple |
| `distribution.cer` / `.pem` | can delete after Phase 4d | one-shot intermediate |
| `gradethread-distribution.p12` | encode → Infisical secret, then can delete local copy | `BUILD_CERTIFICATE_BASE64` |
| `GradeThread_App_Store.mobileprovision` | encode → Infisical secret, then can delete local copy | `PROVISIONING_PROFILE_BASE64` |
| `AuthKey_<ASC_KEY_ID>.p8` (from 3b) | encode → Infisical secret, then can delete local copy | `APP_STORE_CONNECT_API_KEY_BASE64` |

> **Alternative: Keychain Access on macOS.** If you ever do get Mac access, the Keychain Access UI does the same thing — CSR via *Certificate Assistant → Request a Certificate*, double-click the downloaded `.cer` to install, then **My Certificates** → right-click → **Export as .p12**. The output `.p12` is byte-compatible with what OpenSSL produces here.

---

## Phase 5 · Base64-encode the secrets (PowerShell)

Infisical secrets are plain text, so the binary files have to be base64-encoded before you paste them into Infisical (Phase 6b). The comment after each command is the **exact secret key** to store the value under. From PowerShell in the folder containing the files:

```powershell
# Distribution certificate (.p12) → BUILD_CERTIFICATE_BASE64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("gradethread-distribution.p12")) |
  Set-Clipboard

# Provisioning profile (.mobileprovision) → PROVISIONING_PROFILE_BASE64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("GradeThread_App_Store.mobileprovision")) |
  Set-Clipboard

# App Store Connect API key (.p8) → APP_STORE_CONNECT_API_KEY_BASE64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_<ASC_KEY_ID>.p8")) |
  Set-Clipboard
```

If you'd rather write to a file than to the clipboard:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("gradethread-distribution.p12")) |
  Out-File -Encoding ascii -NoNewline cert.b64.txt
```

**Generate the keychain password** (random 32-char string — the workflow uses it to create a temporary keychain that gets destroyed after the build):

```powershell
-join ((48..57 + 65..90 + 97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
# → save as KEYCHAIN_PASSWORD
```

**Verify the base64 round-trip** before pasting into Infisical (catches UTF-16 BOM and trailing-newline issues — the classic traps):

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("gradethread-distribution.p12"))
[Convert]::FromBase64String($b64).Length
# → must equal (Get-Item "gradethread-distribution.p12").Length
```

If lengths don't match, your file has a BOM or your terminal is line-wrapping. Use `Out-File -Encoding ascii -NoNewline` instead of redirecting.

---

## Phase 6 · Store the secrets in Infisical + connect GitHub

`ios-release.yml` does **not** read the 8 signing secrets from GitHub. Its **"Import signing secrets from Infisical"** step pulls them from self-hosted Infisical (`grade-thread` project, `prod` environment, root path) at build time and injects them into the job environment. The only things in GitHub are the three values the action needs to authenticate to Infisical.

### 6a. Create a machine identity in Infisical

The action authenticates with **Universal Auth** — a client ID + client secret bound to a machine identity.

1. Infisical → **Organization → Access Control → Identities → Create identity**
2. Name it `github-actions-ios`, organization role **No Access** (project access is granted separately in 6c)
3. Open the identity → **Authentication → Universal Auth** (enabled by default)
4. Copy the **Client ID**, then **Add Client Secret** and copy the secret value — it's shown only once

These two values become `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` in 6d.

### 6b. Add the 8 signing secrets to Infisical

In Infisical → **`grade-thread` project → `prod` environment → root (`/`) path → Add Secret**, create all 8 with these **exact** keys.

> **The key name *is* the env-var name.** The action injects each secret into the build using its Infisical key verbatim, and every workflow step reads it by that exact name (e.g. `$APPLE_TEAM_ID`). A typo'd key means the matching build step gets an empty value and fails — so the spelling below is not optional.

| Infisical secret key (= env var name) | Value | Source |
|---|---|---|
| `APPLE_TEAM_ID` | `ABC1234567` | Phase 1 |
| `APP_STORE_CONNECT_API_KEY_ID` | 10-char key ID | Phase 3b |
| `APP_STORE_CONNECT_API_ISSUER_ID` | UUID like `69a6de70-...` | Phase 3b |
| `APP_STORE_CONNECT_API_KEY_BASE64` | base64 blob | Phase 5 — ASC `.p8` |
| `BUILD_CERTIFICATE_BASE64` | base64 blob | Phase 5 — `.p12` |
| `P12_PASSWORD` | export password | Phase 4d |
| `PROVISIONING_PROFILE_BASE64` | base64 blob | Phase 5 — `.mobileprovision` |
| `KEYCHAIN_PASSWORD` | random 32-char string | Phase 5 |

### 6c. Grant the identity read access to the project

1. Infisical → **`grade-thread` project → Access Control → Machine Identities → Add Identity**
2. Select `github-actions-ios` from 6a
3. Give it a role with **read** access to the `prod` environment (the built-in **Viewer** role is enough)

Skip this and the CI step fails with a 401/403 — the identity can authenticate but can't see any secrets.

### 6d. Add the 3 connection secrets to GitHub

**https://github.com/dj-pearson/GradeThread/settings/secrets/actions → New repository secret**

| GitHub secret | Value |
|---|---|
| `INFISICAL_CLIENT_ID` | Client ID from 6a |
| `INFISICAL_CLIENT_SECRET` | Client secret from 6a |
| `INFISICAL_DOMAIN` | Your self-hosted Infisical URL, e.g. `https://infisical.yourdomain.com` (include the scheme, no trailing slash) |

The workflow step is already wired to `project-slug: grade-thread`, `env-slug: prod`, `secret-path: /`. Once these three exist in GitHub and the 8 secrets are in Infisical, the next release pulls them automatically — nothing else to configure.

---

## Phase 7 · Fill in `Release.xcconfig`

Edit `ios/GradeThread/Config/Release.xcconfig` (committed to the repo — that's fine; everything here is publicly safe).

```
SUPABASE_URL          = https:/$()/api.gradethread.com
SUPABASE_ANON_KEY     = <paste the anon public key from Supabase Studio>
EDGE_API_URL          = https:/$()/functions.gradethread.com
SENTRY_DSN            = <https:/$()/abc@o123.ingest.sentry.io/456>
POSTHOG_API_KEY       = <paste from PostHog project settings>
POSTHOG_HOST          = https:/$()/us.i.posthog.com
```

Where to find each:
- **`SUPABASE_ANON_KEY`** — Supabase Studio at `https://api.gradethread.com` → **Project Settings → API → Project API keys → `anon public`**
- **`SENTRY_DSN`** — Sentry → project settings → Client Keys (DSN)
- **`POSTHOG_API_KEY`** — PostHog → project settings → Project API Key

**Critical gotcha:** xcconfig comments use `//`. URLs are written as `https:/$()/` and the build system resolves `$()` to nothing, producing a valid `https://` URL at runtime. If you forget the escape, the URL becomes `https:` and silently breaks.

**Do NOT paste service-role keys here** — only the publicly-safe client keys. The `anon` Supabase key is gated by RLS; the Sentry DSN is rate-limited; the PostHog key is client-scoped. All three are designed for client-side use.

**Note: `aps-environment` is handled automatically.** The entitlements file commits as `development` (for local Xcode-signed dev builds). The release workflow's **"Flip aps-environment to production"** step rewrites it to `production` with PlistBuddy before archiving. Don't flip it manually.

---

## Phase 8 · APNs env vars on the edge service (Coolify, not GitHub)

The edge service (Deno/Hono) is what actually sends pushes — it reads from `push_device_tokens` and signs requests to APNs with the .p8 key from Phase 2c.

**Convert the APNs .p8 to base64** (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_<APNS_KEY_ID>.p8")) |
  Set-Clipboard
```

**In Coolify → your edge-functions service → Environment Variables:**

| Variable | Value |
|---|---|
| `APNS_KEY_ID` | APNs Key ID from Phase 2c (10-char) |
| `APNS_TEAM_ID` | Same as `APPLE_TEAM_ID` |
| `APNS_BUNDLE_ID` | `com.gradethread.app` |
| `APNS_AUTH_KEY_BASE64` | base64 blob of the APNs `.p8` |
| `APNS_ENVIRONMENT` | `production` (matches what the workflow flips entitlements to) |

The `.p8` contents are PEM-encoded ASCII, so you *can* paste raw text instead of base64 — but base64 sidesteps newline-handling issues in Coolify's env var UI. Match whichever format the push code actually reads.

Restart the edge service after setting these.

---

## Phase 9 · First TestFlight build

### 9a. Trigger the workflow — pick one

**A. Push to main** with any change touching `ios/**`:

```bash
git commit -m "ios: ship first TestFlight build"
git push origin main
```

Easiest. The `ios-release.yml` `paths:` filter catches it.

**B. Tag-driven release** for explicit version bumps:

```bash
git tag -a ios-v0.1.0 -m "First TestFlight build

- Initial release for internal testing
- Manual intake, voice dictation, barcode scan
- eBay publish + sync"
git push origin ios-v0.1.0
```

The tag annotation becomes the "What to test" release notes surfaced in the workflow run summary.

**C. Manual** — **Actions → iOS Release → Run workflow**. Optional `submit_to_app_store` checkbox (leave off until App Store metadata is ready — see Phase 10).

### 9b. What the workflow does (~10-15 min)

1. Pulls the 8 signing secrets from Infisical (`grade-thread`/`prod`) into the job environment
2. Generates the Xcode project from `project.yml`
3. **Flips `aps-environment` to `production`** in the entitlements file via PlistBuddy
4. Decodes `.p12` + creates an ephemeral keychain on the macOS runner
5. Installs the provisioning profile
6. Drops the ASC `.p8` into `~/.appstoreconnect/private_keys/`
7. Archives with manual signing using `Apple Distribution` + the team ID
8. Exports an `.ipa` with `method=app-store`
9. `xcrun altool --upload-app` to TestFlight
10. Surfaces release notes in the run summary (paste them into TestFlight manually for v1)
11. Saves the `.ipa` as a downloadable artifact (30-day retention)
12. Destroys the keychain + deletes the ASC `.p8`

### 9c. After the workflow finishes

About 10-20 minutes later (Apple's processing delay):

1. https://appstoreconnect.apple.com → your app → **TestFlight** tab
2. New build appears under **iOS** → click it
3. **Test Information** — feedback email, marketing URL (optional), privacy policy URL (required: `https://gradethread.com/privacy`)
4. **Export Compliance** — `ITSAppUsesNonExemptEncryption: false` is set in `project.yml`, so it auto-approves
5. **Groups → Internal Testing** → add yourself + internal testers (they get an email + install via the TestFlight app)
6. Paste the release notes from the workflow run summary into **What to Test**

External testing (the Public Link path) requires a **Beta App Review** from Apple — typically 1-2 days for the first submission, faster after.

---

## Phase 10 · App Store submission (when ready)

When you eventually flip `submit_to_app_store: true` in the workflow_dispatch:

- [ ] Real app icon in `ios/GradeThread/Assets.xcassets/AppIcon.appiconset` (Apple rejects builds without one)
- [ ] Privacy policy URL live at `https://gradethread.com/privacy`
- [ ] App Store screenshots: 6.7" iPhone (1290×2796) + 13" iPad (2064×2752) at minimum
- [ ] **App Information** in App Store Connect: description, keywords, support URL, marketing URL
- [ ] **Age rating** questionnaire completed
- [ ] **App Review Information**: contact email, demo account credentials (since the app requires login)
- [ ] **App Privacy** → data collection disclosures matching what Sentry/PostHog/Supabase actually collect (Sentry: crash data + breadcrumbs; PostHog: usage analytics if opted-in; Supabase: account data + user content)

The `submit_to_app_store` workflow step now runs `bundle exec fastlane release` (US-197), which pushes the repo's metadata from `ios/fastlane/metadata`, runs Apple's precheck, and submits the already-uploaded build for review. Before the first run:

- Fill in `ios/fastlane/metadata/review_information/demo_user.txt` + `demo_password.txt` with real demo-account credentials (the committed values are `*_PLACEHOLDER`).
- Capture screenshots once with `cd ios && bundle exec fastlane screenshots` (needs a Mac + simulators) and commit them under `ios/fastlane/screenshots`, **or** upload them manually in App Store Connect — `deliver` is configured with `skip_screenshots` off, so it uploads whatever's in that folder.
- Set the **App Privacy** answers in App Store Connect to match `ios/fastlane/metadata/PRIVACY_LABELS.md` (the on-device `PrivacyInfo.xcprivacy` is committed; the web nutrition labels are transcribed by hand).
- Complete the **age-rating** questionnaire (expect 17+ for commercial/selling activity — see PRIVACY_LABELS.md).

---

## Quick reference — every secret in one place

| Where it lives | Name | What it is | Source |
|---|---|---|---|
| GitHub secrets | `INFISICAL_CLIENT_ID` | Machine-identity client ID | Phase 6a |
| GitHub secrets | `INFISICAL_CLIENT_SECRET` | Machine-identity client secret | Phase 6a |
| GitHub secrets | `INFISICAL_DOMAIN` | Self-hosted Infisical URL | Phase 6d |
| Infisical (`grade-thread`/`prod`) | `APPLE_TEAM_ID` | Apple Team ID | Phase 1 |
| Infisical (`grade-thread`/`prod`) | `APP_STORE_CONNECT_API_KEY_ID` | ASC API key ID | Phase 3b |
| Infisical (`grade-thread`/`prod`) | `APP_STORE_CONNECT_API_ISSUER_ID` | ASC Issuer UUID | Phase 3b |
| Infisical (`grade-thread`/`prod`) | `APP_STORE_CONNECT_API_KEY_BASE64` | ASC `.p8` base64 | Phase 3b + 5 |
| Infisical (`grade-thread`/`prod`) | `BUILD_CERTIFICATE_BASE64` | Distribution `.p12` base64 | Phase 4d + 5 |
| Infisical (`grade-thread`/`prod`) | `P12_PASSWORD` | `.p12` export password | Phase 4d |
| Infisical (`grade-thread`/`prod`) | `PROVISIONING_PROFILE_BASE64` | `.mobileprovision` base64 | Phase 4e + 5 |
| Infisical (`grade-thread`/`prod`) | `KEYCHAIN_PASSWORD` | random 32-char string | Phase 5 |
| `Release.xcconfig` (committed) | `SUPABASE_URL` | edge URL | already set |
| `Release.xcconfig` (committed) | `SUPABASE_ANON_KEY` | Supabase anon public key | Phase 7 |
| `Release.xcconfig` (committed) | `EDGE_API_URL` | functions.gradethread.com | already set |
| `Release.xcconfig` (committed) | `SENTRY_DSN` | Sentry DSN | Phase 7 |
| `Release.xcconfig` (committed) | `POSTHOG_API_KEY` | PostHog project key | Phase 7 |
| Coolify edge service | `APNS_KEY_ID` | APNs Key ID | Phase 2c |
| Coolify edge service | `APNS_TEAM_ID` | same as `APPLE_TEAM_ID` | Phase 1 |
| Coolify edge service | `APNS_BUNDLE_ID` | `com.gradethread.app` | constant |
| Coolify edge service | `APNS_AUTH_KEY_BASE64` | APNs `.p8` base64 | Phase 2c + 5 |
| Coolify edge service | `APNS_ENVIRONMENT` | `production` | constant |

---

## Common failure modes + fixes

| Symptom in CI logs | Cause | Fix |
|---|---|---|
| `No identity found` during Archive | `.p12` didn't include the private key | Re-run Phase 4d step 2 — the `-inkey` flag must point at `gradethread-private.key` |
| `MAC verify error` when CI imports the .p12 | OpenSSL 3.x exported with the modern PKCS#12 algorithm Apple's tooling can't read | Re-export in 4d with the `-legacy` flag (you'll get a fresh `.p12` — re-base64 it + update the `BUILD_CERTIFICATE_BASE64` secret in Infisical) |
| `Provisioning profile doesn't include signing certificate` | Profile in 4e was created before the cert in 4c | Regenerate the profile after the cert exists |
| `Invalid Provisioning Profile` after upload | Profile's bundle ID doesn't match `com.gradethread.app` | Recheck Phase 2a + 4e |
| `Could not find altool` | macOS runner image bump deprecated it | Workflow already pins `Xcode_15.4.app` — no action needed unless the pin is removed |
| `The bundle does not support the minimum OS Version` | `IPHONEOS_DEPLOYMENT_TARGET` mismatch | Already `17.0` in `project.yml` — no action |
| TestFlight build "Missing Compliance" | Forgot `ITSAppUsesNonExemptEncryption` | Already `false` in `project.yml` — no action |
| Push notifications silently fail in prod | `aps-environment` shipped as `development` | Workflow already flips it — verify the **"Flip aps-environment to production"** step ran in the Actions log |
| `base64: invalid input` on the runner | Windows wrote the base64 file as UTF-16 with BOM | Re-encode with `Out-File -Encoding ascii -NoNewline` (Phase 5) |
| `Authentication failed for App Store Connect API` | ASC key was created with `Developer` access instead of `App Manager` | Regenerate the key in Phase 3b with `App Manager` |
| `Import signing secrets from Infisical` step fails with 401/403 | Wrong `INFISICAL_CLIENT_ID`/`_SECRET`/`_DOMAIN`, or the machine identity has no read access to `prod` | Recheck the 3 GitHub secrets (6d) + grant Viewer on `prod` (6c) |
| Build step gets an empty signing value (e.g. blank team ID, `No identity found` despite a valid `.p12`) | An Infisical secret key doesn't exactly match the env-var name the workflow expects | Recheck the keys in Phase 6b are spelled exactly (the key *is* the env-var name) |
| Workflow times out > 60 min | Apple notarization queue backed up | Re-run the workflow; nothing to fix on our side |

---

## What this guide doesn't cover (yet)

- **dSYM upload to Sentry** for symbolicated crash stacks — straightforward addition to the Archive step
- **Different signing per branch** (e.g. ad-hoc profile for QA branch) — out of scope for v1
- **Mac Catalyst / visionOS builds** — out of scope; iOS-only

When any of those become priority, drop a US-### in `prd.json` and we'll wire it.
