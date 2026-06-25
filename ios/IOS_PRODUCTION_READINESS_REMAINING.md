# iOS Production Readiness — Remaining (simulator/device-gated)

The 2026-06-21 production-readiness epic (US-1142…US-1159) is complete except the
three stories below. They are **not** abandoned — they're blocked on a macOS
toolchain (Xcode build + simulator/device + iterative UI runs) that the headless
Linux dev environment doesn't have. Writing them blind risks breaking the build
or shipping non-functional infra, so they're scoped here with concrete steps to
finish on a Mac. Everything else in the epic shipped with unit tests.

---

## US-1153 — Critical-flow UI tests in CI

**Done here (safe artifacts):**
- `ios/GradeThread.storekit` — a StoreKit Testing configuration with all 6
  subscriptions + 4 consumable credit packs (IDs match
  `APP_STORE_SUBMISSION.md` and the server map). Lets the paywall purchase flow
  run hermetically in a UI test with no App Store Connect round-trip.

**To finish on a Mac:**
1. In the `GradeThread` scheme → Run/Test → Options, set **StoreKit
   Configuration** to `GradeThread.storekit` (or set it per UI-test plan).
2. Add UI tests to the existing `GradeThreadUITests` target for the three
   critical journeys, driven by launch arguments so they're hermetic:
   - **Sign in** (email + Sign in with Apple button presence/route),
   - **Paywall purchase** against the `.storekit` config (tap a plan → assert the
     entitlement/Current state),
   - **Capture → grade → draft** (use a `--uitest-mock-grading` launch arg to
     stub the grading network so the flow is deterministic).
   Add accessibility identifiers to the key controls as you go (the a11y labels
   from US-1151 help, but stable `accessibilityIdentifier`s are better selectors).
3. Wire a **UI-test phase** into `.github/workflows/ios-ci.yml` (a separate job
   from the fast unit lane, on a macOS runner with a booted simulator):
   `xcodebuild test -scheme GradeThread -testPlan UITests -destination 'platform=iOS Simulator,name=iPhone 16'`.
   Keep it off the PR-blocking path until it's stable, then promote.
4. Iterate selectors/timing on the simulator until green.

---

## US-1155 — Localization foundation

**Done here (safe, Windows-verifiable artifacts):**
- `GradeThread/Localizable.xcstrings` — the String Catalog. It's auto-classified
  into the resources build phase by the `- path: GradeThread` source glob (same
  mechanism as `PrivacyInfo.xcprivacy`), so it is **not** re-listed under
  `resources:` (that would double-reference it). With `SWIFT_EMIT_LOC_STRINGS=YES`
  already set, build-time extraction lands every `Text("…")` / `Label(…)` /
  `String(localized:)` literal here — the binary is no longer English-only-by-
  omission.
- Currency display literals migrated to the locale-aware `CurrencyFormatter`
  (US-1161 did the bulk; US-1155 cleaned up the remaining hardcoded `"$"` in
  `AutomationTypes`, `PublishDialog`, `ItemMergePlan`, and the `DraftsBulkEditView`
  price-field affordances). App-wide currency now honors the locale / the
  `AppPreferences.currencyCode` override; dates already display via locale-aware
  `.formatted()` / `Date.FormatStyle` (ISO8601 stays wire-only).
- `no-bare-strings.py` (the localization guard, wired in `ios-ci.yml`) now also
  **validates the String Catalog** (present + well-formed JSON, `en` source) and
  its scope was **widened to the Settings priority flow** (existing literals
  baselined; NEW Settings UI text must go through a localized key or CI fails).
- `GradeThreadPseudo` scheme (`project.yml`) runs the app with the double-length
  pseudolanguage (`-NSDoubleLocalizedStrings YES`, `-NSShowNonLocalizedStrings
  YES`) for the clipping smoke check.

**Why the rest is still Mac-gated:** migrating the remaining ~670 `Text("…")`
literals across the app is high-volume and each is a potential build/runtime
regression that can only be confirmed by compiling + rendering on a simulator.

**To finish on a Mac:**
1. Continue migrating user-facing strings **in priority order** (paywall +
   billing → onboarding → capture/intake → the rest), widening the guard's
   `SCOPE_DIRS` + `BASELINE` as each directory is done. Note SwiftUI `Text("…")`
   / `Button("…")` / `Label("…", …)` literals are *already* `LocalizedStringKey`
   and extract automatically once the catalog exists — the manual work is the
   `String`-typed and interpolation-built UI text.
2. Run the `GradeThreadPseudo` scheme (or Scheme → Options → App Language →
   "Double-Length Pseudolanguage") and walk the priority flows, fixing any
   clipping/truncation before adding real locales.

---

## US-1157 — iPad multi-window & scene state restoration

**Status:** multi-scene is already enabled (`UIApplicationSupportsMultipleScenes:
true`, `NavigationSplitView` three-column on regular width). The per-scene
restoration scaffolding now ships; what remains is **on-device verification**
(simulator or Stage Manager-capable iPad), which the Linux/Windows environment
can't run.

**Done here (safe artifacts):**
- `MainShell` now persists per-scene navigation state via `@SceneStorage`
  (per-scene, value-based — no UIKit `SceneDelegate`): the resting `AppSection`
  (`shell.section`) and the open item id (`shell.focusedItemId`). `AppSection`
  was made `String`-backed so it round-trips through scene storage.
- `restorePersistedScene(router:)` runs once per scene (guarded by
  `didRestoreScene`) at `.task` time, re-selecting the section and re-pushing the
  open item's canvas onto that section's path. Two windows keep independent state
  because `@SceneStorage` is scene-scoped.
- `ItemCanvasSceneHost` wraps every `ItemCanvasView` navigation destination and
  writes/clears `shell.focusedItemId` on appear/disappear (clearing only when it
  still owns the slot, so navigating item→item doesn't wipe the newer id).
- `SceneRestoration` holds the pure decode/encode logic, unit-tested by
  `GradeThreadTests/SceneRestorationTests.swift` (the `.add` pseudo-section is
  never persisted; raw values are pinned so a rename can't silently break
  restoration for installed apps).

**To finish on a Mac:**
1. For richer cross-device hand-off (optional), attach an `NSUserActivity` to the
   detail routes and restore from it in `onContinueUserActivity`. The
   `@SceneStorage` path above already covers same-device teardown/relaunch.
2. **Verify on simulator/Stage Manager:** open Inventory in window 1, drag out
   window 2 to an Item canvas, close window 1, confirm window 2 keeps its state;
   confirm split-view ↔ Slide Over transitions don't lose selection or crash.
3. Add a UI test in the (US-1153) lane that backgrounds + relaunches a scene and
   asserts the restored tab/selection.

---

## What shipped (for context)

US-1142 (silent saves), US-1143 (SwiftData versioning), US-1144 (StoreKit
listener), US-1145 (429 retry), US-1146 (token refresh + uploads), US-1147 (sync
shutdown + stuck mutations), US-1148 (telemetry), US-1149 (privacy-cover snapshot
race), US-1150 (cert-pinning decision: no-go), US-1151 (VoiceOver labels), US-1152
(Dynamic Type), US-1154 (memory-leak checks), US-1156 (deep-link hardening),
US-1158 (offline indicator), US-1159 (BGTask/push tests) — all with unit tests,
pending one **iOS CI run** to confirm compilation/green (authored on Linux, no
local Swift toolchain).
