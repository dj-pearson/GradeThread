package com.gradethread.app.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
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
 *
 * ── US-2902 ────────────────────────────────────────────────────────────────
 * All three cases failed on every CI run ("Failed to inject touch input",
 * "Failed to assert the following: (is not enabled)", "Failed to perform text
 * input") for one reason: they asserted immediately, and the app takes five to
 * eight seconds to draw this screen. See [awaitAuthScreen].
 *
 * HANDLES ARE TAGS; CONTENT IS STILL TEXT, and the split is deliberate. The
 * field and the button are looked up by [TestTags] because their labels are
 * copy — "Sign in" becomes "Create account" in sign-up mode, which is why the
 * third case used to need a different matcher for the same button, and the app
 * ships Spanish. The two VALIDATION MESSAGES stay as text because they are the
 * thing under test: a tag would let the message change to anything at all and
 * this test would still pass.
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
        compose.awaitAuthScreen()

        // Nothing typed: the button is dead, and says so rather than failing on
        // tap with a server error.
        compose.onNodeWithTag(TestTags.Auth.SUBMIT).assertIsNotEnabled()

        compose.onNodeWithTag(TestTags.Auth.EMAIL).performTextInput("not-an-email")
        compose.onNodeWithText("That doesn't look like an email address.").assertExists()
        compose.onNodeWithTag(TestTags.Auth.SUBMIT).assertIsNotEnabled()

        compose.onNodeWithTag(TestTags.Auth.PASSWORD).performTextInput("whatever")
        // Still refused — the email is the problem, and it stays the problem.
        compose.onNodeWithTag(TestTags.Auth.SUBMIT).assertIsNotEnabled()
    }

    @Test
    fun aValidPairEnablesSubmit() {
        hilt.inject()
        compose.awaitAuthScreen()

        compose.onNodeWithTag(TestTags.Auth.EMAIL).performTextInput("dj@gradethread.com")
        compose.onNodeWithTag(TestTags.Auth.PASSWORD).performTextInput("CorrectHorse1")

        compose.onNodeWithTag(TestTags.Auth.SUBMIT).assertIsEnabled()
    }

    @Test
    fun signUpEnforcesThePasswordPolicyThatSignInDoesNot() {
        hilt.inject()
        compose.awaitAuthScreen()

        compose.onNodeWithTag(TestTags.Auth.TOGGLE).performClick()

        compose.onNodeWithTag(TestTags.Auth.EMAIL).performTextInput("dj@gradethread.com")
        compose.onNodeWithTag(TestTags.Auth.PASSWORD).performTextInput("short")

        // The same password that would be accepted for sign-in is refused
        // here, because the server's policy applies to a NEW password.
        compose.onNodeWithText("Password must be at least 10 characters.").assertExists()
        // The submit button is the same node in both modes now that it is
        // matched by tag; its LABEL changes to "Create account" and no longer
        // has to be spelled out here.
        compose.onNodeWithTag(TestTags.Auth.SUBMIT).assertIsNotEnabled()
    }
}
