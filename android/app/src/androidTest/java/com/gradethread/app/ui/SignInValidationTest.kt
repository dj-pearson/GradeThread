package com.gradethread.app.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.gradethread.app.MainActivity
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * US-2369 (and the US-1395 criterion that could not be written before this
 * screen existed): sign-in validation, on a device, with no network.
 *
 * The emulator has no session, so `MainActivity` lands here — which is exactly
 * the state this test needs and the reason it can exist at all.
 */
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class SignInValidationTest {

    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun theFormRefusesToSubmitUntilBothFieldsAreValid() {
        hilt.inject()

        // Nothing typed: the button is dead, and says so rather than failing on
        // tap with a server error.
        compose.onNodeWithText("Sign in").assertIsNotEnabled()

        compose.onNodeWithText("Email").performTextInput("not-an-email")
        compose.onNodeWithText("That doesn't look like an email address.").assertExists()
        compose.onNodeWithText("Sign in").assertIsNotEnabled()

        compose.onNodeWithText("Password").performTextInput("whatever")
        // Still refused — the email is the problem, and it stays the problem.
        compose.onNodeWithText("Sign in").assertIsNotEnabled()
    }

    @Test
    fun aValidPairEnablesSubmit() {
        hilt.inject()

        compose.onNodeWithText("Email").performTextInput("dj@gradethread.com")
        compose.onNodeWithText("Password").performTextInput("CorrectHorse1")

        compose.onNodeWithText("Sign in").assertIsEnabled()
    }

    @Test
    fun signUpEnforcesThePasswordPolicyThatSignInDoesNot() {
        hilt.inject()

        compose.onNodeWithText("Need an account? Sign up").performClick()

        compose.onNodeWithText("Email").performTextInput("dj@gradethread.com")
        compose.onNodeWithText("Password").performTextInput("short")

        // The same password that would be accepted for sign-in is refused
        // here, because the server's policy applies to a NEW password.
        compose.onNodeWithText("Password must be at least 10 characters.").assertExists()
        compose.onNodeWithText("Create account").assertIsNotEnabled()
    }
}
