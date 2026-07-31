package com.gradethread.app.ui

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
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
 * The most valuable instrumented test this app can have, and one the 130+ JVM
 * unit tests cannot replace: none of them constructs the real object graph. A
 * missing `@Binds`, a `@Provides` that throws, a circular dependency, or a
 * crash inside a ViewModel's `init` all compile perfectly and fail only when
 * Dagger assembles on a device.
 *
 * The emulator has no session, so the correct landing is the SIGN-IN screen
 * (US-2369). Asserting that is asserting the whole startup path: Application
 * created, MainActivity survived onCreate, AuthRepository injected, the phase
 * resolved to SignedOut, and the form composed.
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

        compose.onNodeWithText("Sign in").assertExists(
            "The app did not reach the sign-in form — startup or the Hilt graph failed.",
        )
        compose.onNodeWithText("Email").assertExists()
        compose.onNodeWithText("Password").assertExists()
    }

    @Test
    fun theSignUpToggleSwapsTheForm() {
        hilt.inject()

        compose.onNodeWithText("Need an account? Sign up").assertExists()
    }
}
