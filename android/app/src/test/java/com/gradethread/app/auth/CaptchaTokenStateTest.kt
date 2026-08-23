package com.gradethread.app.auth

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * US-2792: the captcha token's lifecycle on the auth form.
 *
 * TurnstileChallenge and TurnstileHtml have existed since US-1312 with nothing
 * rendering either, so Android signup had no bot protection at all while web
 * and iOS did. Wiring it is one state field and one call, and these cases pin
 * the three rules that are easy to get wrong and invisible when wrong.
 *
 * Deliberately over AuthViewModel.State rather than the ViewModel: the rules
 * are pure state transitions, and a test that needed a real ViewModel would
 * need Hilt, a repository and a coroutine scope to assert a copy().
 */
class CaptchaTokenStateTest {

    private fun state(token: String? = null) =
        AuthViewModel.State(mode = AuthFormRules.Mode.SIGN_UP, captchaToken = token)

    /** The same mapping setCaptcha applies, kept in one place. */
    private fun applied(from: AuthViewModel.State, result: TurnstileResult) =
        from.copy(
            captchaToken = when (result) {
                is TurnstileResult.Token -> result.token
                is TurnstileResult.Failed -> null
                TurnstileResult.NotConfigured -> null
            },
        )

    @Test
    fun solvedChallenge_keepsTheToken() {
        assertEquals(
            "tok_abc123",
            applied(state(), TurnstileResult.Token("tok_abc123")).captchaToken,
        )
    }

    @Test
    fun notConfigured_leavesNoToken_soSignupStillWorks() {
        // Dev, CI, and any build without the secret. The server has captcha off
        // in those environments too, so a null token is the correct request --
        // NOT a reason to block the button.
        assertNull(applied(state(), TurnstileResult.NotConfigured).captchaToken)
    }

    @Test
    fun failure_CLEARS_a_previouslySolvedToken() {
        // The rule most likely to be written the other way round. Turnstile
        // tokens are single-use, so carrying a spent one into the retry fails
        // validation while LOOKING like a token was sent -- harder to diagnose
        // than sending none at all.
        val solved = applied(state(), TurnstileResult.Token("tok_first"))
        assertEquals("tok_first", solved.captchaToken)
        assertNull(applied(solved, TurnstileResult.Failed("expired")).captchaToken)
    }

    @Test
    fun expiryAfterSolving_alsoClears() {
        val solved = applied(state(), TurnstileResult.Token("tok_first"))
        assertNull(applied(solved, TurnstileResult.NotConfigured).captchaToken)
    }

    @Test
    fun aTokenNeverGatesSubmission() {
        // canSubmit must not depend on the token. A wedged widget would
        // otherwise lock signup on a screen with no way past it, which is worse
        // than one rejected attempt the user can simply repeat.
        val withToken = AuthViewModel.State(
            mode = AuthFormRules.Mode.SIGN_UP,
            email = "a@b.com",
            password = "Str0ngPassw0rd!",
            captchaToken = "tok_abc",
        )
        assertEquals(withToken.canSubmit, withToken.copy(captchaToken = null).canSubmit)
    }

    @Test
    fun theProductionMappingIsTheONEThisFileMirrors() {
        // THE TEST ABOVE MIRRORS setCaptcha RATHER THAN CALLING IT, because
        // AuthViewModel needs an AuthRepository, which is a concrete class over
        // a SupabaseClient - no interface to fake, and no existing test builds
        // one. A mirror that nothing pins is a guard that passes while the code
        // it describes is wrong, so this pins it.
        //
        // Found by sabotage: mutating the mirror proves only that the mirror is
        // self-consistent. The mutations have to reach the real mapping, and
        // this is what carries them there.
        val src = File("src/main/java/com/gradethread/app/auth/AuthViewModel.kt").readText()
        val fn = src.substringAfter("fun setCaptcha").substringBefore("    }")
        assertTrue("setCaptcha not found", fn.isNotEmpty())
        assertTrue("solved token not kept", fn.contains("is TurnstileResult.Token -> result.token"))
        assertTrue("failure does not clear", fn.contains("is TurnstileResult.Failed -> null"))
        assertTrue(
            "NotConfigured does not clear",
            fn.contains("TurnstileResult.NotConfigured -> null"),
        )
    }

    @Test
    fun theTokenIsACTUALLYWIREDThroughSignupAndOntoTheScreen() {
        // THE MAPPING TEST ABOVE IS NOT ENOUGH, and a sabotage run is what said
        // so: deleting the SignUpCaptcha call, dropping captchaToken from the
        // signUp arguments, and removing the clear-on-mode-switch ALL left this
        // file green. The whole feature could be deleted and the tests would
        // still pass, because they only ever exercised a when-expression.
        //
        // These three are WIRING claims - does this call that? - and a source
        // scan is the right instrument for wiring, where it is the wrong one
        // for logic. The mapping stays tested as logic above.
        val vm = File("src/main/java/com/gradethread/app/auth/AuthViewModel.kt").readText()
        val screen = File("src/main/java/com/gradethread/app/auth/AuthScreen.kt").readText()

        assertTrue(
            "signUp no longer forwards the token - the feature sends nothing",
            vm.contains("captchaToken = current.captchaToken"),
        )
        assertTrue(
            "toggleMode no longer clears the token - a consumed one gets re-sent",
            vm.substringAfter("fun toggleMode").substringBefore("    }")
                .contains("captchaToken = null"),
        )
        assertTrue(
            "nothing renders the challenge on signup",
            screen.contains("SignUpCaptcha(state.isSignUp, viewModel::setCaptcha)"),
        )
        assertTrue(
            "the challenge is not signup-gated",
            screen.substringAfter("private fun SignUpCaptcha").contains("if (!isSignUp) return"),
        )
    }
}
