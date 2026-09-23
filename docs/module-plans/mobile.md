# Mobile apps (iOS + Android)

Health: **ok**

Both apps are big (768 Swift files, 747 Kotlin files) and well guarded. Web parity is broad: Money, mileage, reconcile, consignment, radar, offers and post-sale all exist on both phones. Sync is careful on both sides (SyncEngine.swift:363-420 and SyncService.kt:196-285 refuse to prune on an incomplete read). The biggest opportunity is a handful of confirmed live bugs that already have fixes shaped. Android drops 8 push categories and flattens other clients' AI provenance, and iOS shows payout dates one day early. The mobile backlog also needs a cleanup: several open stories are already done in code or describe code that no longer exists.

## Actions

### 1. Android: know every push category the edge sends, and test it against the generated contract

Impact: high | Effort: S | Story: US-3449 (duplicate: US-3430)

**Why:** Diffing contracts/push-contract.json against the enum in android/app/src/main/java/com/gradethread/app/platform/push/PushCategory.kt:27-41 shows the edge sends 15 categories and Android knows 12. Eight are missing: cancellation.requested, case.deadline, case.opened, dispute.opened, inquiry.opened, marketing, offer.responded, return.opened. Unknown ids fall back to the low-importance UPDATES channel and have no tap route. Five ids Android declares have no sender at all. Unlike iOS (ios/GradeThreadTests/PushCategoryCoverageTests.swift, PushContract.swift), nothing on Android reads the contract. US-3430 and US-3449 describe the same defect twice.

**Steps:**
- Merge US-3430 into US-3449 (US-3449 is newer and cites the generated contract) and close the duplicate
- Add the 8 missing ids to PushCategory.kt; put case.deadline, dispute.opened and return.opened on URGENT, the same reasoning the file already gives for DELIST_NEEDED
- Route each new id to the post-sale / offers destination the web uses (src/pages/flipdesk/post-sale.tsx, offers.tsx)
- Add a JVM test that parses contracts/push-contract.json and fails on any id with no PushCategory entry, modeled on iOS PushCategoryCoverageTests
- Decide the 5 unsent ids (keep grade.ready if it is posted locally, delete or document the rest)

### 2. Android: stop AiFieldWriter from flattening every JSONB entry it did not touch

Impact: high | Effort: S | Story: US-3360

**Why:** android/app/src/main/java/com/gradethread/app/ai/AiFieldWriter.kt:144-145 turns every attributes and ai_field_sources value into a string with `it.value.toString().trim('"')`. The write path then re-emits all of them as JsonPrimitive (:68). One Android apply permanently wipes the confidence and acceptance that edge, web and iOS wrote as objects. The same code also turns any non-string attributes value (number, bool, array) into a quoted string. US-3360 names only ai_field_sources, not attributes.

**Steps:**
- Change CurrentJsonb to keep Map<String, JsonElement> for both columns
- Merge only the keys this apply touched, and pass every other element through untouched
- Add a unit test: seed an object-valued ai_field_sources entry and a numeric attribute, apply one field, and assert both survive byte-for-byte
- Add a note on US-3360 that the attributes column has the same flattening, so the fix covers both

### 3. iOS: payout dates show one day early for sellers west of UTC

Impact: medium | Effort: S | Story: none

**Why:** payout_date is a Postgres `date` (supabase/migrations/00008_flipdesk_schema.sql:207). ios/GradeThread/Money/PayoutReconciliationTypes.swift:99-103 parses it at UTC midnight. display() at :107-113 then formats it with a DateFormatter that has no timeZone, so it uses the device zone and 'Paid Jan 5' shows as 'Jan 4' across the Americas (PayoutReconciliationView.swift:158). Android fixed the same thing by formatting in UTC (PayoutReconciliationScreen.kt:466-470). iOS already has the right helper in MoneyDate.dayDisplay (MoneyDate.swift:195-202). The only test (PayoutReconciliationTests.swift:162-164) checks parse is non-nil and never checks the rendered day. No open story covers it.

**Steps:**
- Make PayoutDateFormat.display format date-only inputs in UTC, or route through MoneyDate.dayDisplay; keep device zone only for full timestamps
- Add an XCTest that runs display("2024-01-05") with the default zone set to America/Los_Angeles and asserts the output contains 5, not 4
- Grep iOS for other `dateStyle = .medium` formatters fed by date-only columns (acquired_date, spent_on, trip dates) and apply the same rule
- File a new story at prd.json.nextId, since none exists

### 4. Turn App Links and Universal Links back on in production

Impact: high | Effort: S | Story: US-3340, US-3108

**Why:** The AndroidManifest.xml App Link filters (autoVerify at :158-187, OAuth return at AuthCallbackActivity :224+) depend on assetlinks.json. US-3340 measured it returning 503 because ANDROID_CERT_SHA256 is not set on the Pages project. So eBay OAuth returns and shared links open in the browser, not the app. US-3108 (iOS AASA) is code-complete and waits only on a real-device tap test. Both are operator tasks and very cheap for what they fix.

**Steps:**
- OPERATOR: set ANDROID_CERT_SHA256 on the Cloudflare Pages project to the Play app-signing cert fingerprint, then curl /.well-known/assetlinks.json and expect 200 application/json
- Run `adb shell pm verify-app-links --re-verify com.gradethread.app` and `pm get-app-links` on a device to confirm the domain is verified
- Add the assetlinks uptime probe US-3340 AC3 asks for, next to the AASA job
- OPERATOR: tap a real password-reset link from Mail on an iPhone to close US-3108 AC5

### 5. Clean up the mobile backlog: close stale stories and fix ones done in code but stuck

Impact: medium | Effort: M | Story: US-3014, US-2911, US-2337, US-2339, US-2688

**Why:** US-3014's title says iOS has neither a mileage log nor receipt capture, but ios/GradeThread/Money/MileageLogView.swift (141 lines), MileageStore.swift (281), TripFormSheet.swift and ReceiptScanService.swift (260) exist, and MoneyView.swift:601 links to MileageLogView. US-2911's title says predictive back is off, but AndroidManifest.xml:69 sets enableOnBackInvokedCallback="true"; only the in-app update half is still open. US-2337 (SyncEngine.swift:363-390 guard in place) and US-2339 (ExpenseDraft.kt:63-100 UTC zone) are fixed in code and wait on a Sentry grant or a prod audit. US-2090, US-2016, US-2274, US-2337, US-2557 and US-2812 all carry the 'git merge-base --is-ancestor' note, so whether iOS CI has seen them can be settled mechanically. Of the 37 open mobile-titled stories, 19 have device or OPERATOR acceptance criteria.

**Steps:**
- Re-verify US-3014 against the Money folder, then either close it or rewrite it down to whatever is actually missing, and attach it to epic US-2981 as its notes ask
- Retitle US-2911 to the in-app-update half only
- For the six stories with the ancestor note: run `gh run list --workflow='iOS CI' --branch main` and the merge-base check, then close whichever are covered by a green run
- Ask the owner to grant Sentry read on project 4511508903362560; one grant unblocks US-2337, US-2688, US-2011 and US-2003
- Group the remaining device-gated ACs into one real-device checklist session instead of 19 separate waits

### 6. Give iOS a coverage floor and grow GradeThreadCore so more Swift runs off a Mac

Impact: medium | Effort: M | Story: US-3278

**Why:** iOS CI already gathers coverage (.github/workflows/ios-ci.yml:188, `-enableCodeCoverage YES`; ios/project.yml:246) but nothing enforces a number. Android enforces a measured 45% floor with kover (android/app/build.gradle.kts:28-40, 516-519). The Linux-testable package ios/Packages/GradeThreadCore has only 9 source files (2,559 lines with tests) against 768 app Swift files. So bug classes like date-zone handling (MoneyDate) and request-key casing (the US-2688 dispute outage) can only be checked on macOS CI. No swift toolchain is present in the cloud container (`which swift` finds nothing).

**Steps:**
- Measure line coverage from the last green iOS CI run with `xcrun xccov view --report`, then add a floor at that number rounded down to 5, as Android does
- Move pure logic into GradeThreadCore first: MoneyDate, PayoutDateFormat, and the EdgeAPI request DTOs, so their encoded bytes can be asserted by `swift test`
- Do US-3278 (Swift toolchain in the container) and add the optional verify lane it describes

### 7. Finish Android string extraction and add real plurals before more Spanish ships

Impact: medium | Effort: L | Story: US-2976, US-2499

**Why:** Android ships values-es (android/app/src/main/res/values-es), but US-2976's notes count 26 files and 757 strings still hardcoded in English. android/app/lint-baseline.xml hides 35 PluralsCandidate warnings, such as '%d days', '%d sold' and '%d graded' in values/strings.xml, for example money_time_on_market_summary at strings.xml:271. Spanish cannot translate those correctly without <plurals>. The baseline also holds 32 ComposeUnstableCollections entries, which cost recompositions.

**Steps:**
- Convert the 35 PluralsCandidate strings to <plurals> in values and values-es, then delete those rows from lint-baseline.xml so lint enforces it
- Work through US-2976's 26-file list one screen at a time, writing one format string per sentence
- Add a check that fails when lint-baseline.xml gains rows, so the baseline can only shrink
- Separately, burn down ComposeUnstableCollections by switching list params to ImmutableList on the hottest screens (inventory, marketplaces)

### 8. Make the Android screenshot lane trustworthy again

Impact: low | Effort: M | Story: US-3311

**Why:** US-3311 measured 57 of 395 Roborazzi goldens failing. 13 of them photograph an infinite progress spinner and take 93% of the suite's runtime, and 44 are simply stale. Screenshots are advisory in both verify:android and Android CI (CLAUDE.md, US-2502), so a real visual regression looks exactly like the existing noise.

**Steps:**
- Hide or freeze indeterminate progress indicators under a test flag in the 13 waiting-state previews, so capture goes idle
- Re-record the 44 stale goldens after reviewing each diff
- Once it is green, make the screenshot step blocking in android-ci.yml

## Risks

- The Android push gap puts payment-dispute, return and case-deadline alerts on the channel sellers mute. Missing one can mean an eBay defect or a lost case (PushCategory.kt:27-41 vs contracts/push-contract.json).
- Each Android AI apply permanently destroys provenance that other clients wrote (AiFieldWriter.kt:144-145), and the damage grows with every use until it is fixed.
- Many mobile fixes are shipped but unverified: they wait on devices, a Sentry grant or a macOS-only compile. The backlog reads as further from done than the code is, and some titles (US-3014, US-2911) are now wrong.
- No Swift toolchain runs in the cloud session and iOS has no coverage floor, so iOS changes made here are checked only by text-scanning guards (the ios lane in scripts/verify.mjs, run by ci.yml:157).
- Deep links are fail-closed in prod (assetlinks 503, US-3340), so eBay OAuth returns on Android open in the browser instead of the app.
- Checked and found sound, not problems: all 18 iOS guards run in CI via ci.yml:157; iOS and Android sync both refuse to prune on an unscoped or partial read; Android expense dates are anchored to UTC (ExpenseDraft.kt:63-100).
