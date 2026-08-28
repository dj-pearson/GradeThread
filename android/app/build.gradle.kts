// `Base64` is imported rather than written as `java.util.Base64` below: inside a
// Kotlin-DSL build script `java` resolves to the JavaPluginExtension accessor,
// so the fully-qualified form fails to compile with `Unresolved reference: util`
// — which takes the WHOLE android module down, not just the release lane.
import java.util.Base64
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    // US-2502: the quality tooling that replaces an Android Studio menu item.
    // detekt = Analyze > Inspect Code (Kotlin half), spotless = Reformat Code,
    // kover = the coverage gutter. See android/README.md "Working without
    // Android Studio" for the full mapping.
    alias(libs.plugins.detekt)
    alias(libs.plugins.spotless)
    alias(libs.plugins.kover)
    // Roborazzi = the Compose Preview pane, as a test. Renders through
    // Robolectric's native graphics on the JVM, so it runs in the same
    // testDebugUnitTest lane as everything else -- no emulator, no device.
    alias(libs.plugins.roborazzi)
}

/**
 * US-2502: the line-coverage floor kover enforces (percent).
 *
 * A single named constant rather than a literal buried in the kover block, so
 * changing it is visible in a diff and has to be argued for. It should be the
 * MEASURED number, not a target: a floor above what the suite actually reaches
 * gets lowered within a week, and a floor at today's number still catches the
 * change that deletes tests.
 *
 * MEASURED 2026-08-26 (US-2903): `:app:koverLogDebug` reported
 * **46.1643%** application line coverage over 1,864 unit tests. 45 is that
 * number rounded down to the nearest 5, which is the whole rule - the floor is
 * a tripwire under where the suite already stands, not a target above it.
 *
 * It replaces a provisional 40 that had never been measured. 40 was not
 * catastrophically wrong, and it was still inert in the way that matters: six
 * points of slack is roughly an eighth of the suite, so a change could have
 * deleted that much and `koverVerifyDebug` would have stayed green while
 * reading as enforced in both `verify.mjs` and `android-ci.yml`.
 *
 * RAISE IT IN THE SAME COMMIT AS THE TESTS THAT EARNED IT, never on its own and
 * never to a number nobody has run. Re-measure with
 * `node scripts/gradlew.mjs :app:koverLogDebug` - through the wrapper, which
 * resolves JDK 21; a bare `gradlew.bat` picks up whatever JAVA_HOME holds, and
 * on JDK 17 twenty-two Robolectric classes fail before any coverage is counted.
 */
val koverLineFloor = 45

// US-1301: build-time secrets — CI env var first, then local.properties, then
// an empty placeholder (AppConfig treats empty as absent; required values fail
// fast at startup). Nothing sensitive is ever committed.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun secret(name: String, default: String = ""): String = System.getenv(name) ?: localProps.getProperty(name) ?: default

/**
 * US-1391: the release keystore.
 *
 * Two shapes, because CI and a laptop need different things. CI sets
 * ANDROID_KEYSTORE_BASE64 (a GitHub secret can only carry text); a developer
 * points ANDROID_KEYSTORE_PATH at a file. Neither is ever committed.
 *
 * Returns null when the material is absent, and the release build type then
 * has NO signing config — an unsigned release APK still proves that
 * minification and the manifest merge work, which is what a fork or a PR from
 * outside the org needs. A build that failed outright would make the release
 * lane unrunnable for everyone without the secret.
 */
fun resolveKeystore(): File? {
    val base64 = secret("ANDROID_KEYSTORE_BASE64")
    if (base64.isNotBlank()) {
        val decoded = File(layout.buildDirectory.get().asFile, "release-keystore.jks")
        decoded.parentFile.mkdirs()
        decoded.writeBytes(Base64.getDecoder().decode(base64.trim()))
        return decoded
    }
    return secret("ANDROID_KEYSTORE_PATH").takeIf { it.isNotBlank() }
        ?.let { rootProject.file(it) }
        ?.takeIf { it.exists() }
}

android {
    namespace = "com.gradethread.app"
    // US-2891: compileSdk 36 (Android 16); targetSdk matches.
    //
    // NOT a routine bump. Play's target-API floor steps once a year on 31
    // August, and the page was read on 2026-08-25: from 2026-08-31 a NEW app
    // must target API 36 or it is "not available to new users on devices
    // running newer versions of Android" — which for a product that has never
    // shipped is the whole audience. There is no grandfathering for a first
    // upload; the extension form (to 2026-11-01) exists for updates to apps
    // that are already live. Rejection happens at UPLOAD, minutes after a
    // green twenty-minute release lane, so the cost of being wrong here is
    // paid at the worst moment.
    //
    // The three API 36 behaviour changes that reach this app were each checked
    // rather than assumed; see PLAY_STORE_SUBMISSION.md §6.5 for the findings.
    // Short version: edge-to-edge was already on, predictive back needed the
    // manifest flag (set), and the large-screen resizability change makes the
    // two-pane work (US-2905) matter more, not less.
    compileSdk = 36

    defaultConfig {
        // NOT the same as `namespace` above, and that is deliberate rather than
        // a typo. The Play Console record was created as com.gradethread.myapp
        // and Play locks a package name to a record permanently, so the store
        // identity is myapp while the Kotlin package stays com.gradethread.app.
        // Changing this to match the namespace would orphan the store listing.
        // The iOS bundle id is com.gradethread.app, so the two stores differ.
        applicationId = "com.gradethread.myapp"
        // minSdk 26 (Android 8.0): covers ~97% of devices while keeping
        // java.time, notification channels, and adaptive icons native.
        minSdk = 26
        // US-2891: see the compileSdk note above. This is the value Play
        // actually reads off the uploaded bundle.
        targetSdk = 36
        // US-1391: CI drives the version code so every upload to Play is
        // strictly higher than the last. Play REJECTS a re-used code outright,
        // and hand-bumping a literal is how a release lane ends up blocked at
        // the worst moment. Defaults to 1 for a local build.
        versionCode = secret("ANDROID_VERSION_CODE", "1").toIntOrNull() ?: 1
        versionName = secret("ANDROID_VERSION_NAME", "0.1.0")
        // US-1395: a Hilt-aware runner. The stock AndroidJUnitRunner would
        // start the real GradeThreadApp, whose onCreate validates config,
        // starts sync and opens sockets — none of which belongs in a UI test.
        testInstrumentationRunner = "com.gradethread.app.HiltTestRunner"

        // US-2150: which ABIs get BUILT at all. ML Kit ships a native OCR
        // pipeline (~11MB) and a barcode scanner (~5MB) PER ABI, so every ABI
        // in this list is ~16MB of .so that has to exist somewhere.
        //
        // x86 (32-bit) is dropped: no phone has shipped it in a decade and the
        // only thing that ran it was an old emulator image. x86_64 STAYS —
        // that is the arch the instrumented CI lane emulates, and dropping it
        // would make `connectedDebugAndroidTest` fail to install.
        //
        // This is the build-side half. The download-side half is the App
        // Bundle below, which sends ONE of these to each device.
        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86_64")
        }

        // US-1301: endpoint/keys via BuildConfig (see AppConfig.kt). The two
        // base URLs default to prod (they're public routing facts — CLAUDE.md);
        // keys default to empty placeholders that read as absent.
        buildConfigField("String", "SUPABASE_URL", "\"${secret("SUPABASE_URL", "https://api.gradethread.com")}\"")
        buildConfigField("String", "EDGE_API_URL", "\"${secret("EDGE_API_URL", "https://functions.gradethread.com")}\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"${secret("SUPABASE_ANON_KEY")}\"")
        buildConfigField("String", "SENTRY_DSN", "\"${secret("SENTRY_DSN")}\"")
        buildConfigField("String", "POSTHOG_API_KEY", "\"${secret("POSTHOG_API_KEY")}\"")
        buildConfigField("String", "POSTHOG_HOST", "\"${secret("POSTHOG_HOST")}\"")
        buildConfigField("String", "TURNSTILE_SITE_KEY", "\"${secret("TURNSTILE_SITE_KEY")}\"")
        // US-1378: Firebase, supplied the same way. All four must be present
        // for push to work; any blank disables it rather than half-initializing
        // a client that fails on the first send.
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${secret("FIREBASE_PROJECT_ID")}\"")
        buildConfigField("String", "FIREBASE_APP_ID", "\"${secret("FIREBASE_APP_ID")}\"")
        buildConfigField("String", "FIREBASE_API_KEY", "\"${secret("FIREBASE_API_KEY")}\"")
        buildConfigField("String", "FIREBASE_SENDER_ID", "\"${secret("FIREBASE_SENDER_ID")}\"")
    }

    signingConfigs {
        create("release") {
            resolveKeystore()?.let { keystore ->
                storeFile = keystore
                storePassword = secret("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = secret("ANDROID_KEY_ALIAS", "gradethread")
                keyPassword = secret("ANDROID_KEY_PASSWORD")
                // V1 as well as V2/V3: minSdk is 26, so a V2-only APK is fine
                // for Play, but a sideloaded install on an older image and some
                // enterprise MDM flows still verify the JAR signature.
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // Side-by-side install with a release build; verbose logging on.
            applicationIdSuffix = ".debug"
            buildConfigField("boolean", "LOGGING_ENABLED", "true")
            // US-1393: en-XA (accented + padded ~30%) and en-XB (RTL mirror)
            // for clipping QA. Debug only — they are the real Android
            // mechanism, not a hand-written values-xx directory, and shipping
            // them would put them in the Play language list.
            isPseudoLocalesEnabled = true
        }
        release {
            // Only when the keystore actually resolved — see resolveKeystore().
            signingConfig = signingConfigs.getByName("release")
                .takeIf { it.storeFile != null }
            isMinifyEnabled = true
            buildConfigField("boolean", "LOGGING_ENABLED", "false")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    /**
     * US-2150: the release artifact is an App Bundle (`./gradlew bundleRelease`),
     * not a universal APK.
     *
     * A universal APK carries every ABI, so a phone downloads four copies of
     * ML Kit's native pipeline and can run exactly one of them. Play splits an
     * AAB and delivers only the slice a device can use — which is the whole
     * fix, and it is a distribution property, not something the app code can
     * do anything about.
     *
     * `language` split is deliberately OFF. The app has an in-app language
     * picker (`AppLocale.SUPPORTED` + `res/xml/locales_config.xml`); with
     * language splits on, Play ships only the device's language and every
     * other one silently falls back to English the moment someone switches.
     * Strings are kilobytes — this costs nothing and removes a whole class of
     * "translations work in debug, not in production" bug.
     */
    bundle {
        abi { enableSplit = true }
        density { enableSplit = true }
        language { enableSplit = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // US-1316: Room schema JSON export (migration-diff reviews).
    ksp {
        arg("room.schemaLocation", "$projectDir/schemas")
    }

    // US-2502: MigrationTestHelper reads the exported schemas out of the test
    // APK's ASSETS. Without this line it finds nothing and every migration test
    // fails with "Cannot find the schema file", which reads like the export is
    // broken rather than like the test APK is missing a directory.
    sourceSets.getByName("androidTest") {
        assets.srcDirs(files("$projectDir/schemas"))
    }

    /**
     * US-2502: Android Lint as a GATE.
     *
     * `lintDebug` already ran in CI, and it was reporting rather than blocking:
     * Lint's default `abortOnError` fails only on ERROR, and almost everything
     * worth catching is a WARNING -- a leaked context, a hardcoded locale, an
     * unused resource, a Play SDK Index entry saying a dependency version is
     * known-vulnerable and will be rejected at upload.
     *
     * warningsAsErrors + a checked-in baseline is the pairing that works on an
     * existing codebase: lint-baseline.xml records what was already there, so
     * the gate can only fire on something the current change introduced.
     * Regenerate deliberately with `./gradlew :app:updateLintBaseline`, in the
     * same commit as whatever fixed the findings -- a baseline refreshed on its
     * own is a gate switched off quietly.
     */
    lint {
        abortOnError = true
        warningsAsErrors = true
        baseline = file("lint-baseline.xml")
        // Studio inspects library code too; the CLI default does not, and the
        // Play SDK Index findings live almost entirely in dependencies.
        checkDependencies = true
        // The release variant merges a different manifest and runs R8, so it
        // reaches conclusions debug cannot.
        checkReleaseBuilds = true
        htmlReport = true
        xmlReport = true
        // GitHub code scanning ingests SARIF, which is how a lint finding shows
        // up on the diff instead of inside a downloaded zip.
        sarifReport = true
        textReport = false
        // "A newer version exists" is a real thing to know and a terrible thing
        // to fail a build on -- it turns red the day an unrelated library ships.
        // `./gradlew dependencyUpdates` reports it on purpose instead.
        //
        // OldTargetApi is the same check wearing a platform's clothes, and it
        // joined the list on 2026-08-28 for two reasons. It fires because
        // targetSdk is not the HIGHEST api level lint can see -- and 36 is not
        // an oversight, it is the value US-2891 chose deliberately against
        // Play's 31 August floor, with the three API 36 behaviour changes
        // checked one by one (see the compileSdk note above). Chasing a preview
        // level to silence a nag would undo that reasoning.
        //
        // Worse, it is not even a stable gate: lint compares against the
        // platforms INSTALLED on the machine, so it passes on a laptop with
        // only SDK 36 and fails on a CI runner that ships the next one. A check
        // whose verdict depends on which SDK packages happen to be unpacked is
        // the local-green / CI-red shape that costs the most to diagnose.
        // Raising targetSdk stays a story with testing behind it.
        disable += setOf(
            "GradleDependency",
            "AndroidGradlePluginVersion",
            "NewerVersionAvailable",
            "OldTargetApi",
        )
        // Never shippable, whatever the baseline holds.
        fatal += setOf("StopShip")
    }

    testOptions {
        unitTests {
            // Robolectric resolves the merged resource table through this. The
            // 18 Robolectric tests here pass without it only because none has
            // needed a string or a theme yet; the first one that does would
            // fail with a resource-not-found that reads like a missing file.
            isIncludeAndroidResources = true
        }
        /**
         * US-2502: Gradle-managed devices -- an emulator nobody has to create.
         *
         * `./gradlew pixel6api34DebugAndroidTest` downloads the image, boots a
         * headless device, installs, runs, and tears it all down. That is the
         * whole reason instrumented tests needed Android Studio (or the
         * hand-rolled emulator setup in the CI workflow) and now they do not.
         *
         * aosp-atd, not google_apis: the automated-test image has no Play
         * services, no launcher and no background apps, so it boots in a
         * fraction of the time and is far less prone to an ANR under load. The
         * tests here assert on the app's own Hilt graph and UI, not on GMS.
         */
        managedDevices {
            localDevices {
                create("pixel6api34") {
                    device = "Pixel 6"
                    apiLevel = 34
                    systemImageSource = "aosp-atd"
                }
            }
        }
    }
}

/**
 * US-2502: detekt -- the Kotlin half of "Analyze > Inspect Code".
 *
 * Android Lint checks the PLATFORM: manifests, resources, API levels, leaked
 * contexts. It has nothing to say about a swallowed exception, a 400-line
 * function, or a Composable that takes a `List` and therefore recomposes on
 * every frame. Those live here, together with io.nlopez.compose.rules.
 *
 * The config is `buildUponDefaultConfig`, so config/detekt/detekt.yml records
 * only the deliberate differences.
 */
detekt {
    buildUponDefaultConfig = true
    config.setFrom(files("$rootDir/config/detekt/detekt.yml"))
    baseline = file("$rootDir/config/detekt/baseline.xml")
    parallel = true
    source.setFrom(files("src/main/java", "src/test/java", "src/androidTest/java"))
}

tasks.withType<io.gitlab.arturbosch.detekt.Detekt>().configureEach {
    // Detekt's default is 1.8, which makes it reject every file using a Java 17
    // language feature with a parse error that names neither.
    jvmTarget = "17"
    reports {
        html.required.set(true)
        sarif.required.set(true)
        xml.required.set(false)
        txt.required.set(false)
        md.required.set(false)
    }
}
tasks.withType<io.gitlab.arturbosch.detekt.DetektCreateBaselineTask>().configureEach {
    jvmTarget = "17"
}

/**
 * US-2502: spotless/ktlint -- "Reformat Code", as a gate.
 *
 * `ratchetFrom` is the important part. Applying ktlint to all 435 existing
 * files would produce a reformat commit large enough that no human could review
 * anything else in it, and it would conflict with every branch open at the
 * time. Ratcheting checks only files that differ from origin/main, so the
 * standard applies to new and changed code from today and the rest converges as
 * it is touched.
 *
 * Escape hatch: SPOTLESS_RATCHET=off, for a checkout with no origin/main (a
 * shallow CI clone, a fork, a detached tree).
 */
spotless {
    if (System.getenv("SPOTLESS_RATCHET") != "off") {
        ratchetFrom = "origin/main"
    }
    kotlin {
        target("src/**/*.kt")
        targetExclude("**/build/**")
        ktlint(libs.versions.ktlint.get()).editorConfigOverride(
            mapOf(
                // ktlint 1.x defaults to the `ktlint_official` style, which
                // rewrites class and function signatures wholesale. This
                // codebase was written to IDE defaults, so that style would
                // reformat every file anyone touches and bury the actual change.
                // intellij_idea is the same standard the code already follows.
                "ktlint_code_style" to "intellij_idea",
                // @Composable functions are PascalCase. Without this override
                // ktlint flags every screen in the app.
                "ktlint_function_naming_ignore_when_annotated_with" to "Composable",
                "ktlint_standard_function-naming" to "disabled",
                // Compose trailing-lambda call chains routinely run past 100.
                "max_line_length" to "120",
                // ktlint's import ordering disagrees with the IDE default and
                // neither is more correct; letting it rewrite imports produces
                // churn on every file anyone opens.
                "ktlint_standard_import-ordering" to "disabled",
            ),
        )
        trimTrailingWhitespace()
        endWithNewline()
    }
    kotlinGradle {
        target("*.gradle.kts")
        // Same style as the source set above, for the same reason.
        ktlint(libs.versions.ktlint.get()).editorConfigOverride(
            mapOf(
                "ktlint_code_style" to "intellij_idea",
                "max_line_length" to "120",
            ),
        )
    }
}

/**
 * US-2502: Roborazzi -- Compose Preview, as a test that can fail.
 *
 * Android Studio's preview pane and Layout Validation are the two things that
 * ever look at a Composable's rendered output, and both are a human squinting
 * at a panel. Roborazzi renders the same Composables through Robolectric's
 * native graphics on the JVM and diffs them against committed PNGs, so a
 * padding change that quietly clips a badge fails a build instead of shipping.
 *
 * Goldens live in src/test/screenshots and are committed. Re-record with
 * `npm run android:screenshots:record` after a deliberate visual change, in the
 * same commit as the change -- a golden re-recorded on its own is the assertion
 * deleted.
 *
 * The images are recorded on whatever machine ran the command. Robolectric's
 * native graphics ship their own font stack, so the output is far more portable
 * than a device screenshot, but sub-pixel antialiasing can still differ between
 * a Windows checkout and the Linux CI runner. That is why the CI step is not a
 * blocking gate yet -- see the comment on it in android-ci.yml, which also says
 * what has to be true before it becomes one.
 *
 * The roborazzi extension deliberately sets no `outputDir`. The tests pass an
 * explicit path to captureRoboImage, and the record task CLEARS outputDir
 * before it runs -- so pointing it at src/test/screenshots would put a
 * directory of committed goldens under a task that deletes it. Left at the
 * default, the comparison and diff images stay in build/ where they belong.
 */

/**
 * US-2502: kover -- the coverage gutter, as a number with a floor under it.
 *
 * The floor is set from the measured number rather than an aspiration: a
 * threshold nobody can meet gets lowered, and a threshold set at what already
 * passes at least catches a change that deletes tests. Raise it in the same
 * commit as the tests that earned it.
 *
 * Composables and generated code are excluded. A Composable's correctness is
 * measured by the screenshot and instrumented lanes; counting its lines here
 * would let a screen full of untested logic look covered because its layout ran.
 */
kover {
    reports {
        filters {
            excludes {
                classes(
                    "*.BuildConfig",
                    "*_Factory",
                    "*_Factory\$*",
                    "*_HiltModules*",
                    "*_Impl",
                    "*_Impl\$*",
                    "*_MembersInjector",
                    "*ComposableSingletons*",
                    "hilt_aggregated_deps.*",
                    "dagger.hilt.*",
                    "*\$\$serializer",
                )
                annotatedBy("androidx.compose.runtime.Composable")
                annotatedBy("androidx.compose.ui.tooling.preview.Preview")
            }
        }
        verify {
            rule("line coverage floor") {
                // Measure with `:app:koverLogDebug`, then set the constant
                // above. `npm run verify:android` enforces it.
                minBound(koverLineFloor)
            }
        }
    }
}

/**
 * US-2496: two unit tests read SOURCE FILES off disk rather than exercising
 * compiled classes - `DeleteReconcilerWiringTest` (is the reconciler wired) and
 * `ResponseCacheTenantGuardTest` (is every response cache tenant-keyed, and does
 * every cache-clear have a caller). Gradle only knows about the compiled
 * classpath, so a change that touches ONLY the text they read leaves this task
 * UP-TO-DATE and the guard silently does not run. That is exactly how a guard
 * ends up green for the wrong reason.
 *
 * The Swift tree is listed because the cache guard scans it too: iOS has no lane
 * that runs on a Windows checkout, and `ios-ci.yml` enumerates its Python guards
 * one by one, so this is the only place the cross-client rule is enforced today.
 */
tasks.withType<Test>().configureEach {
    inputs.files(
        fileTree("src/main/java") { include("**/*.kt") },
        fileTree("$rootDir/../ios/GradeThread") { include("**/*.swift") },
    )
        .withPropertyName("sourceScannedByGuardTests")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation(libs.androidx.navigation.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    implementation(platform(libs.supabase.bom))
    implementation(libs.supabase.auth)
    implementation(libs.supabase.postgrest)
    implementation(libs.supabase.realtime)
    implementation(libs.supabase.storage)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.androidx.security.crypto)
    implementation(libs.sentry.android)
    implementation(libs.posthog.android)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.mlkit.text.recognition)
    implementation(libs.mlkit.text.recognition.japanese)
    implementation(libs.androidx.exifinterface)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)
    implementation(libs.play.billing)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.lifecycle.process)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.navigation.compose)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.datastore.preferences)

    // US-2502: the Compose ruleset detekt runs, and Slack's Compose checks that
    // run inside Android Lint. Two different engines because they see different
    // things: detekt reads the Kotlin AST, lint reads the compiled UAST plus the
    // resource graph.
    detektPlugins(libs.detekt.compose.rules)
    lintChecks(libs.compose.lint.checks)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)

    // US-2502: the screenshot lane, on the JVM. compose-ui-test is on the UNIT
    // test classpath here as well as the instrumented one -- Roborazzi composes
    // through the same test rule, and without it the tests fail to resolve
    // createComposeRule at compile time.
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.compose.ui.test.manifest)

    debugImplementation(libs.androidx.compose.ui.tooling)

    // US-1395: the instrumented (emulator) lane.
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.hilt.android.testing)
    // US-2502: Room's MigrationTestHelper, which replays the exported schema
    // JSONs against the real migrations on a real SQLite. Nothing else proves a
    // migration works -- a wrong ALTER compiles, ships, and crashes on the
    // first launch of an app that had the previous version installed.
    androidTestImplementation(libs.androidx.room.testing)
    kspAndroidTest(libs.hilt.compiler)
    // The empty activity ui-test-manifest injects; it lives in the DEBUG
    // manifest because that is the variant the instrumented tests run against.
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
