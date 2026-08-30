package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.auth.AuthActions
import com.gradethread.app.auth.AuthContent
import com.gradethread.app.auth.AuthFormRules
import com.gradethread.app.auth.AuthViewModel
import com.gradethread.app.auth.FriendlyAuthError
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: a golden over the FIRST screen every user sees.
 *
 * ⚠ THIS SCREEN CARRIED A REAL DEFECT THAT NOTHING CAUGHT (US-3003). The
 * headline rendered black on the navy window in dark mode, because
 * MainActivity's setContent had no Surface and LocalContentColor defaults to
 * black. Invisible text, on the sign-in screen, in the mode half of phones are
 * in - and it was found by launching the app on an emulator and looking, not by
 * any test.
 *
 * It could not have been caught before now: AuthScreen took a hiltViewModel, so
 * there was nothing a screenshot test could render. That is US-2902 AC3's whole
 * point - 49 of the app's 52 screens are in that state, and this is one fewer.
 *
 * THE DARK CAPTURE IS THE LOAD-BEARING ONE. The light one would have passed
 * throughout the defect.
 *
 * WHY THE ERROR AND RECOVERY STATES TOO: they are the branches a smoke test
 * never reaches. An error message and the resend-confirmation affordance are
 * each one boolean apart from the default and visually unmistakable in a PNG,
 * which is exactly the shape a golden is good at and a unit test is not.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class AuthScreenshotTest {

    private val signIn = AuthViewModel.State()

    @Test
    fun signIn_light() = capture("screen-auth-signin-light") {
        AuthContent(state = signIn, actions = AuthActions())
    }

    /** The capture US-3003 would have failed. */
    @Test
    fun signIn_dark() = capture("screen-auth-signin-dark", dark = true) {
        AuthContent(state = signIn, actions = AuthActions())
    }

    @Test
    fun signUp_light() = capture("screen-auth-signup-light") {
        AuthContent(state = signIn.copy(mode = AuthFormRules.Mode.SIGN_UP), actions = AuthActions())
    }

    /**
     * A rejected sign-in that offers a way out. The message is the only thing
     * on the screen telling the seller why they are still on it.
     */
    @Test
    fun error_dark() = capture("screen-auth-error-dark", dark = true) {
        AuthContent(
            state = signIn.copy(
                email = "seller@example.invalid",
                // EMAIL_NOT_CONFIRMED rather than INVALID_CREDENTIALS on
                // purpose: it is the one error that renders a RECOVERY control
                // (the resend button, US-810), so the capture covers the
                // message AND the affordance a plain rejection would not show.
                error = FriendlyAuthError.EMAIL_NOT_CONFIRMED,
            ),
            actions = AuthActions(),
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
