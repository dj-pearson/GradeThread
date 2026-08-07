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
}

// US-1301: build-time secrets — CI env var first, then local.properties, then
// an empty placeholder (AppConfig treats empty as absent; required values fail
// fast at startup). Nothing sensitive is ever committed.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun secret(name: String, default: String = ""): String =
    System.getenv(name) ?: localProps.getProperty(name) ?: default

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
    // compileSdk 35 = the newest stable platform installed on dev machines and
    // the CI image; targetSdk matches (Play requires 34+ as of 2025).
    compileSdk = 35

    defaultConfig {
        applicationId = "com.gradethread.app"
        // minSdk 26 (Android 8.0): covers ~97% of devices while keeping
        // java.time, notification channels, and adaptive icons native.
        minSdk = 26
        targetSdk = 35
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
}

dependencies {
    implementation(libs.androidx.core.ktx)
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

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)

    debugImplementation(libs.androidx.compose.ui.tooling)

    // US-1395: the instrumented (emulator) lane.
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.hilt.android.testing)
    kspAndroidTest(libs.hilt.compiler)
    // The empty activity ui-test-manifest injects; it lives in the DEBUG
    // manifest because that is the variant the instrumented tests run against.
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
