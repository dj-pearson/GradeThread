package com.gradethread.app.auth

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2369: what the sign-in form accepts.
 *
 * Two failure modes, both expensive: a rule stricter than the server's is an
 * account nobody can create, and a rule looser than it is a round trip that
 * comes back as a rejection the form could have explained instantly.
 */
class AuthFormRulesTest {

    private val signIn = AuthFormRules.Mode.SIGN_IN
    private val signUp = AuthFormRules.Mode.SIGN_UP

    // ── Email ────────────────────────────────────────────────────────────────

    @Test
    fun `an obviously wrong email is caught before the network`() {
        assertEquals(R.string.auth_email_required, AuthFormRules.emailError(""))
        // Whitespace-only is EMPTY, not malformed: the two are different
        // resources and telling them apart is what this line is for.
        assertEquals(R.string.auth_email_required, AuthFormRules.emailError("   "))
        assertEquals(R.string.auth_email_shape, AuthFormRules.emailError("no-at-sign"))
        assertTrue(AuthFormRules.emailError("no-at-sign") != null)
        assertTrue(AuthFormRules.emailError("missing@dot") != null)
    }

    @Test
    fun `a real address passes, including the awkward ones`() {
        // Deliberately loose: an RFC-complete pattern rejects real addresses,
        // and the server verifies by SENDING to it, which is the only check
        // that proves anything.
        listOf(
            "dj@gradethread.com",
            "first.last+tag@sub.domain.co.uk",
            "  spaced@example.com  ",
        ).forEach { assertNull(it, AuthFormRules.emailError(it)) }
    }

    // ── Password ─────────────────────────────────────────────────────────────

    @Test
    fun `the sign-up rules mirror the server policy exactly`() {
        // supabase/config.toml: minimum_password_length = 10,
        // password_requirements = lower_upper_letters_digits.
        assertEquals(10, AuthFormRules.PASSWORD_MIN_LENGTH)

        // US-2976: the resource id, and for the length rule the NUMBER too.
        // That number is the whole content of the message - "at least some
        // characters" helps nobody - so it travels as an argument, and a change
        // to PASSWORD_MIN_LENGTH cannot leave the sentence quoting the old one.
        val short = AuthFormRules.passwordError("Short1", signUp)!!
        assertEquals(R.string.auth_password_too_short, short.res)
        assertEquals(listOf<Any>(AuthFormRules.PASSWORD_MIN_LENGTH), short.args)

        assertEquals(
            R.string.auth_password_needs_lower,
            AuthFormRules.passwordError("ALLUPPER123", signUp)?.res,
        )
        assertEquals(
            R.string.auth_password_needs_upper,
            AuthFormRules.passwordError("alllower123", signUp)?.res,
        )
        assertEquals(
            R.string.auth_password_needs_digit,
            AuthFormRules.passwordError("NoDigitsHere", signUp)?.res,
        )
        assertNull(AuthFormRules.passwordError("CorrectHorse1", signUp))
    }

    @Test
    fun `sign-in does not apply today's policy to an old password`() {
        // Applying it would lock out anyone who created their account before
        // the rule tightened, and refuse them with a message about the RULE
        // rather than letting the server say "wrong password".
        assertNull(AuthFormRules.passwordError("old", signIn))
        assertEquals(
            R.string.auth_password_required,
            AuthFormRules.passwordError("", signIn)?.res,
        )
    }

    // ── Submission ───────────────────────────────────────────────────────────

    @Test
    fun `submit is gated on both fields and on not already working`() {
        assertTrue(AuthFormRules.canSubmit("dj@gradethread.com", "anything", signIn, busy = false))
        assertFalse(AuthFormRules.canSubmit("dj@gradethread.com", "anything", signIn, busy = true))
        assertFalse(AuthFormRules.canSubmit("nope", "anything", signIn, busy = false))
        assertFalse(AuthFormRules.canSubmit("dj@gradethread.com", "", signIn, busy = false))
        // The same password is fine to sign in with and refused to sign up with.
        assertFalse(AuthFormRules.canSubmit("dj@gradethread.com", "anything", signUp, busy = false))
    }

    // ── Strength ─────────────────────────────────────────────────────────────

    @Test
    fun `strength matches the web meter`() {
        assertEquals(0, AuthFormRules.strength(""))
        assertEquals(0, AuthFormRules.strength("short"))
        // 10+ chars, mixed case, a digit but no symbol.
        assertEquals(2, AuthFormRules.strength("Password12"))
        // 14+ chars, mixed case, digit AND symbol.
        assertEquals(4, AuthFormRules.strength("CorrectHorse1!x"))
    }

    // ── Recovery ─────────────────────────────────────────────────────────────

    @Test
    fun `every failure that has a next step offers it`() {
        // "That didn't work" with no next step is where people give up.
        assertEquals(
            AuthFormRules.Recovery.RESEND_CONFIRMATION,
            AuthFormRules.recovery(FriendlyAuthError.EMAIL_NOT_CONFIRMED),
        )
        assertEquals(
            AuthFormRules.Recovery.RESEND_CONFIRMATION,
            AuthFormRules.recovery(FriendlyAuthError.EMAIL_UNVERIFIED),
        )
        assertEquals(
            AuthFormRules.Recovery.RESET_PASSWORD,
            AuthFormRules.recovery(FriendlyAuthError.INVALID_CREDENTIALS),
        )
        assertEquals(
            AuthFormRules.Recovery.RESET_PASSWORD,
            AuthFormRules.recovery(FriendlyAuthError.EXPIRED_LINK),
        )
        // They already have an account; sending them to sign in beats making
        // them work out why "already registered" appeared under a sign-up form.
        assertEquals(
            AuthFormRules.Recovery.SWITCH_TO_SIGN_IN,
            AuthFormRules.recovery(FriendlyAuthError.USER_ALREADY_EXISTS),
        )
    }

    @Test
    fun `a failure with no useful next step offers none`() {
        assertEquals(AuthFormRules.Recovery.NONE, AuthFormRules.recovery(FriendlyAuthError.OFFLINE))
        assertEquals(
            AuthFormRules.Recovery.NONE,
            AuthFormRules.recovery(FriendlyAuthError.RATE_LIMITED),
        )
        assertEquals(AuthFormRules.Recovery.NONE, AuthFormRules.recovery(null))
    }

    @Test
    fun `the toggle goes both ways`() {
        assertEquals(signUp, AuthFormRules.toggled(signIn))
        assertEquals(signIn, AuthFormRules.toggled(signUp))
    }
}
