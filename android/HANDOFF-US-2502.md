# US-2502 handoff — finishing the Android-without-Studio setup

Everything is written and mostly verified. Four steps remain, all of them
"run a Gradle task and commit what it produces". Nothing is committed yet.

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

- **`recordRoborazziDebug` may fail to resolve `GradeThreadTheme(darkTheme=)`
  or a component signature.** The test is
  `android/app/src/test/java/com/gradethread/app/ui/ComponentScreenshotTest.kt`;
  every signature it uses was checked against source, but it has never compiled.
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

## Not done

- `android/app/lint-baseline.xml` (step 1 above)
- `android/app/src/test/screenshots/*.png` (step 3)
- the real coverage number (step 4) — `koverLineFloor` is a placeholder 40
- `npm run verify:android` end to end
- nothing committed

## One thing to tell Dj

**Android Studio was open during the session and upgraded the Gradle
toolchain underneath the work**: wrapper 8.13 → 8.14.5, a downgraded
`gradlew.bat`, a `foojay-resolver` plugin in `settings.gradle.kts`, and a new
`android/gradle/gradle-daemon-jvm.properties` pinning a JetBrains JDK **21** for
the daemon. That last one would have overridden `JAVA_HOME` and silently moved
CI off JDK 17. All five files were reverted. **Close Android Studio before the
next run**, or it will do it again. Whether to actually take Gradle 8.14.5 is a
separate decision.
