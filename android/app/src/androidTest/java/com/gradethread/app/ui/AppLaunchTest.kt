package com.gradethread.app.ui

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.MainActivity
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-1395: the app launches without the Hilt graph blowing up.
 *
 * The most valuable instrumented test this app can have, and one the JVM unit
 * tests cannot replace: none of them constructs the real object graph. A missing
 * `@Binds`, a `@Provides` that throws, a circular dependency, or a crash inside
 * a ViewModel's `init` all compile perfectly and fail only when Dagger assembles
 * on a device.
 *
 * The emulator has no session, so the correct landing is the SIGN-IN screen
 * (US-2369). Asserting that is asserting the whole startup path: Application
 * created, MainActivity survived onCreate, AuthRepository injected, the phase
 * resolved, and the form composed.
 *
 * ── US-2902: TWO CHANGES, AND THE SECOND IS WHY THIS WAS FAILING ────────────
 *
 * 1. TAGS, NOT COPY. This used to call `onNodeWithText("Sign in")`. The app
 *    ships Spanish, and the localization work (US-2908, US-2976, the
 *    unlocalized-copy ratchet) is actively moving literals into strings.xml —
 *    so the test was asserting on the device locale and on wording nobody
 *    thinks about when they reword a button. There were zero testTag calls in
 *    the whole app; TestTags.Auth is the first.
 *
 * 2. IT HAS TO WAIT. US-2899 gave MainActivity a splash held by
 *    `keepOnScreenCondition` and changed the Loading branch to render NOTHING
 *    until `SPLASH_MAX_HOLD_MS` (5s) has passed:
 *
 *        AuthRepository.Phase.Loading -> if (restoreGaveUp) AuthScreen() else Unit
 *
 *    `restoreGaveUp` flips from a `LaunchedEffect` that `delay`s. A suspended
 *    delay leaves the Recomposer idle, so Compose's idling resource considers
 *    the app settled while the composition is still empty — and an immediate
 *    `assertExists` reads that as "startup failed". Which is exactly the
 *    message the CI log has been carrying.
 *
 *    So the assertion waits for the surface to appear rather than assuming it
 *    already has. The timeout is deliberately longer than SPLASH_MAX_HOLD_MS:
 *    the point is to outlast the app's own give-up clock, so a failure here
 *    means the app never got there, not that the test looked too early.
 *
 * ⚠ THIS IS AN INFERENCE, NOT A REPRODUCTION. It cannot be run from a Windows
 * checkout, and the emulator on that host does not start this app either
 * (US-2899). It is written to be correct under every explanation — a slow
 * restore, a held splash, or a genuinely broken graph all end with the same
 * assertion, and only the last one still fails.
 */
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class AppLaunchTest {

    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun aSessionlessLaunchReachesTheSignInForm() {
        hilt.inject()
        awaitAuthScreen()

        compose.onNodeWithTag(TestTags.Auth.EMAIL).assertExists()
        compose.onNodeWithTag(TestTags.Auth.PASSWORD).assertExists()
        compose.onNodeWithTag(TestTags.Auth.SUBMIT).assertExists()
    }

    @Test
    fun theSignUpToggleSwapsTheForm() {
        hilt.inject()
        awaitAuthScreen()

        // Kept from the original, retargeted. It matched the literal
        // "Need an account? Sign up", which is one rewording or one Spanish
        // device away from failing for a reason that has nothing to do with the
        // toggle.
        compose.onNodeWithTag(TestTags.Auth.TOGGLE).assertExists()
    }

    /**
     * Waits for the signed-out surface, past the splash's own give-up clock.
     *
     * Fails with a message that says which of the two things went wrong, since
     * "node not found" on its own sent the last reader looking at the Hilt graph
     * for a timing problem.
     */
    private fun awaitAuthScreen() {
        compose.waitUntil(timeoutMillis = LAUNCH_TIMEOUT_MS) {
            compose.onAllNodesWithTag(TestTags.Auth.SCREEN).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag(TestTags.Auth.SCREEN).assertExists(
            "The app never reached the sign-in surface within ${LAUNCH_TIMEOUT_MS}ms — " +
                "either startup or the Hilt graph failed, or the auth phase never left Loading.",
        )
    }

    private companion object {
        /**
         * Longer than MainActivity.SPLASH_MAX_HOLD_MS (5s) on purpose. Anything
         * shorter tests the splash rather than the app.
         */
        const val LAUNCH_TIMEOUT_MS = 15_000L
    }
}
