// Root build file — plugin declarations only; module config lives in app/.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.detekt) apply false
    alias(libs.plugins.spotless) apply false
    alias(libs.plugins.kover) apply false
    // US-2502: `./gradlew dependencyUpdates` — the Studio "a newer version is
    // available" inspection, as a report. Applied at the root because it walks
    // every configuration in the build.
    alias(libs.plugins.versions)
}

/**
 * US-2502: one task that runs everything a push has to survive.
 *
 * The same list `npm run verify:android` runs, expressed as a Gradle task so CI
 * and a laptop cannot drift into checking different things. Ordered cheapest
 * first: a formatting or static-analysis failure should not cost the eight
 * minutes an assembleRelease takes to find out.
 *
 * NOT included, deliberately:
 *   - the .py source guards, which need no JVM and run before this
 *   - anything needing a device (see `pixel6api34DebugAndroidTest`)
 *   - bundleRelease + the ABI budget, which the release lane owns
 */
tasks.register("ciCheck") {
    group = "verification"
    description = "Format, static analysis, lint, unit tests, coverage floor, and both APKs."
    dependsOn(
        ":app:spotlessCheck",
        ":app:detekt",
        ":app:lintDebug",
        ":app:testDebugUnitTest",
        ":app:koverVerifyDebug",
        ":app:assembleDebug",
        ":app:assembleDebugAndroidTest",
        ":app:assembleRelease",
    )
}

/**
 * The dependency-update report, restricted to STABLE candidates.
 *
 * Without this the report is a wall of alphas and release candidates for
 * libraries nobody would upgrade to, which is how a useful report becomes one
 * that gets ignored.
 */
tasks.named<com.github.benmanes.gradle.versions.updates.DependencyUpdatesTask>("dependencyUpdates") {
    gradleReleaseChannel = "current"
    // US-2906 AC5: json alongside plain so a script can read the report. The
    // recurring drift check parses build/dependencyUpdates/report.json; the
    // plain copy stays because that is what a person opens.
    outputFormatter = "json,plain"
    rejectVersionIf {
        val stable = listOf("RELEASE", "FINAL", "GA").any { candidate.version.uppercase().contains(it) } ||
            "^[0-9,.v-]+(-r)?$".toRegex().matches(candidate.version)
        !stable && "^[0-9,.v-]+(-r)?$".toRegex().matches(currentVersion)
    }
}
