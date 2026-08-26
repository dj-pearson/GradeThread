# US-2502 handoff: finishing the Android-without-Studio setup

Everything is written and committed. Three artifacts still have to be GENERATED
on a machine with an Android SDK, because they are outputs of a build, not
source. A cloud session cannot produce them: the sandbox has no Android SDK and
its network policy blocks `dl.google.com`, so Google's Maven repo (where AGP,
androidx and Compose all live) is unreachable. Maven Central is reachable, but
no Android build resolves from Central alone.

## Run these, in order, from the repo root

```bash
npm run android:doctor                                   # sanity check (passes today)
node scripts/gradlew.mjs :app:updateLintBaseline          # writes android/app/lint-baseline.xml
node scripts/gradlew.mjs :app:lintDebug                   # must pass with that baseline
node scripts/gradlew.mjs :app:recordRoborazziDebug        # writes android/app/src/test/screenshots/*.png
node scripts/gradlew.mjs :app:koverLogDebug               # prints the real coverage number
```

Then set `koverLineFloor` in `android/app/build.gradle.kts:37` to the measured
number rounded DOWN to the nearest 5, and finish with:

```bash
npm run verify:android
```

Builds are slow on this machine: a cold `assembleDebug` is 17-21 minutes.
`updateLintBaseline` with `checkDependencies = true` will be several minutes.

## What to watch for

- **`lintDebug` may still fail after the baseline** if a finding is `fatal`
  (baselines do not suppress fatal). Only `StopShip` is set fatal.
- **`:app:testDebugUnitTest` has never been run with
  `isIncludeAndroidResources = true`.** It should only help the 18 Robolectric
  tests, but it is a behaviour change.
- **`ciCheck`** (root `build.gradle.kts`) lists task names that are all now
  confirmed to exist, but the aggregate task itself has not been run.

## Already verified working

- `npm run android:doctor` — finds scoop temurin17, the SDK, python; wrote
  `android/local.properties`
- `assembleDebug` with the full new plugin set — BUILD SUCCESSFUL, 17m
- `:app:detektBaseline` → 494 findings baselined; `:app:detekt` passes
- `:app:spotlessApply` / `spotlessCheck` (ratcheted against origin/main)
- `node android/scripts/check-room-schemas.mjs` → version 7, 6 migrations, known
  gap at 3 and 4
- `node android/scripts/device.mjs devices`
- the three `.py` guards
- both workflow YAML files parse; all six new `.mjs` files pass `node --check`

## Checked by reading, not by compiling

`ComponentScreenshotTest.kt` had never compiled. Every symbol it uses was
re-checked against source and against the published artifacts:

- `GradeThreadTheme(darkTheme=, content=)`, the three `Brand*Button(text=,
  onClick=)`, `StatusBadge(String)`, `DataRow(label=, value=)`,
  `InfoCard(title=, body=, tone=)`, `InfoTone.entries`: all match.
- `captureRoboImage(String, RoborazziOptions, @Composable content)` and
  `RobolectricDeviceQualifiers.Pixel5` both exist in roborazzi 1.44.0 (verified
  against the published `.aar`s, not from memory).
- **One real break, now fixed:** `ErrorStateView` has a required trailing
  `retry: suspend () -> Unit`. The test omitted it, which would not have
  compiled. It now passes `retry = {}`.

So `recordRoborazziDebug` should get past compilation. What it can still do is
fail at RUN time (a missing resource, a Robolectric graphics problem), and that
cannot be predicted from source.

## Not done

**All four are now done.** Kept as a record of what the handoff was for rather
than deleted, because "generated on a machine with an SDK" is the reason each of
them could not be produced in a cloud session, and that constraint has not
changed.

- ~~`android/app/lint-baseline.xml` (step 1 above)~~ **DONE** — 251 entries,
  regenerated most recently under US-2891
- ~~`android/app/src/test/screenshots/*.png` (step 3)~~ **DONE** — seven PNGs
  (buttons, data rows, error state, info cards, status badges; light and dark).
  They are all `ui/components` primitives and not one is a screen, which is
  US-2902's problem, not this handoff's
- ~~the real coverage number (step 4)~~ **DONE 2026-08-26 (US-2903)** —
  `:app:koverLogDebug` reported **46.1643%**, so `koverLineFloor` is **45**
- ~~`npm run verify:android` end to end~~ **DONE** — green, most recently under
  US-2891 on JDK 21

## One thing to tell Dj

**Android Studio was open during the session and upgraded the Gradle
toolchain underneath the work**: wrapper 8.13 → 8.14.5, a downgraded
`gradlew.bat`, a `foojay-resolver` plugin in `settings.gradle.kts`, and a new
`android/gradle/gradle-daemon-jvm.properties` pinning a JetBrains JDK **21** for
the daemon. That last one would have overridden `JAVA_HOME` and silently moved
CI off JDK 17. All five files were reverted. **Close Android Studio before the
next run**, or it will do it again. Whether to actually take Gradle 8.14.5 is a
separate decision.

## Unrelated, and worth a look

`assets/14b567c0-...-a8f27b1cc113_result_bwm_video_with_audio.mp4` (19 MB) was
swept into the US-2502 commit. It has nothing to do with this story, and there is already an
8.6 MB sibling from an earlier commit. Both are in git history now, so deleting
them does not shrink the clone, but decide whether they belong in the repo at
all before more of them land.
