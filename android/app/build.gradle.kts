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
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

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
    }

    buildTypes {
        debug {
            // Side-by-side install with a release build; verbose logging on.
            applicationIdSuffix = ".debug"
            buildConfigField("boolean", "LOGGING_ENABLED", "true")
        }
        release {
            isMinifyEnabled = true
            buildConfigField("boolean", "LOGGING_ENABLED", "false")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
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
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
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

    debugImplementation(libs.androidx.compose.ui.tooling)
}
