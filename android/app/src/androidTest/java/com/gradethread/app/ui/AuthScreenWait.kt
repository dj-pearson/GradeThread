package com.gradethread.app.ui

import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.rules.ActivityScenarioRule
import com.gradethread.app.MainActivity

/**
 * US-2902: wait for the signed-out surface before asserting anything on it.
 *
 * WHY EVERY TEST AGAINST MainActivity NEEDS THIS, and why it is one function
 * rather than four lines copied into each file.
 *
 * US-2899 gave MainActivity a splash held by `keepOnScreenCondition` and changed
 * the Loading branch to render NOTHING until `SPLASH_MAX_HOLD_MS` (5s):
 *
 *     AuthRepository.Phase.Loading -> if (restoreGaveUp) AuthScreen() else Unit
 *
 * `restoreGaveUp` flips from a `LaunchedEffect` that `delay`s. A SUSPENDED delay
 * leaves the Recomposer idle, so Compose's idling resource considers the app
 * settled while the composition is still empty — and any assertion made straight
 * after `hilt.inject()` runs against nothing.
 *
 * MEASURED, not assumed: `am start -W` against the CI-built APK on a local
 * API 36 emulator reports a COLD launch of 5364–8576 ms across four runs. Every
 * one is longer than the app's own 5s give-up clock, so this is not a slow-CI
 * caveat — it is how long the app takes.
 *
 * CONFIRMED BY CI: AppLaunchTest failed with "The app did not reach the sign-in
 * form — startup or the Hilt graph failed" on every run until it started
 * waiting, and passed on the first run afterwards. That message was the test's
 * own string and was never evidence about the Hilt graph.
 */
internal fun AndroidComposeTestRule<ActivityScenarioRule<MainActivity>, MainActivity>.awaitAuthScreen() {
    waitUntil(timeoutMillis = AUTH_SCREEN_TIMEOUT_MS) {
        onAllNodesWithTag(TestTags.Auth.SCREEN).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithTag(TestTags.Auth.SCREEN).assertExists(
        "The app never reached the sign-in surface within ${AUTH_SCREEN_TIMEOUT_MS}ms — " +
            "either startup or the Hilt graph failed, or the auth phase never left Loading.",
    )
}

/**
 * Comfortably past MainActivity.SPLASH_MAX_HOLD_MS (5s) and past the slowest
 * cold launch measured (8576 ms). Anything shorter tests the splash rather than
 * the app.
 */
internal const val AUTH_SCREEN_TIMEOUT_MS = 15_000L
