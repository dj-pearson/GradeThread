package com.gradethread.app.auth

/**
 * US-2369: what a sign-in / sign-up form will accept, before the network sees
 * it.
 *
 * A faithful port of the web's `src/lib/password-policy.ts` and the same
 * feedback shape the iOS form uses. The SERVER (GoTrue) stays authoritative —
 * these rules exist so someone finds out their password is too short while
 * typing it, not after a round trip that reads like a rejection.
 *
 * Pure, because a validation bug here is either an account nobody can create or
 * a form that lets through what the server will refuse.
 */
object AuthFormRules {

    /** Mirrors `minimum_password_length` in `supabase/config.toml`. */
    const val PASSWORD_MIN_LENGTH = 10

    const val PASSWORD_HINT =
        "At least 10 characters, including upper- and lower-case letters and a number."

    enum class Mode { SIGN_IN, SIGN_UP }

    /**
     * Email shape, loosely.
     *
     * Deliberately not an RFC-complete pattern: those reject real addresses,
     * and the server verifies by SENDING to it, which is the only check that
     * proves anything. This catches a missing @ and a missing dot — the two
     * that are always a typo.
     */
    fun emailError(email: String): String? {
        val trimmed = email.trim()
        return when {
            trimmed.isEmpty() -> "Enter your email address."
            !EMAIL_SHAPE.matches(trimmed) -> "That doesn't look like an email address."
            else -> null
        }
    }

    /**
     * Password rules, only on SIGN-UP.
     *
     * On sign-in the existing password is whatever it is: applying today's
     * policy to it would lock out anyone who created their account before the
     * rule tightened, and refuse them with a message about the rule rather than
     * letting the server say "wrong password".
     */
    fun passwordError(password: String, mode: Mode): String? = when {
        password.isEmpty() -> "Enter your password."
        mode == Mode.SIGN_IN -> null
        password.length < PASSWORD_MIN_LENGTH ->
            "Password must be at least $PASSWORD_MIN_LENGTH characters."
        !password.any { it.isLowerCase() } -> "Password must include a lower-case letter."
        !password.any { it.isUpperCase() } -> "Password must include an upper-case letter."
        !password.any { it.isDigit() } -> "Password must include a number."
        else -> null
    }

    fun canSubmit(email: String, password: String, mode: Mode, busy: Boolean): Boolean =
        !busy && emailError(email) == null && passwordError(password, mode) == null

    /**
     * A coarse 0-4 strength score for the meter.
     *
     * The same shape as the web's, so the two surfaces don't disagree about
     * whether the same password is "strong".
     */
    fun strength(password: String): Int {
        if (password.isEmpty()) return 0
        var score = 0
        if (password.length >= PASSWORD_MIN_LENGTH) score++
        if (password.length >= 14) score++
        if (password.any { it.isLowerCase() } && password.any { it.isUpperCase() }) score++
        if (password.any { it.isDigit() } && password.any { !it.isLetterOrDigit() }) score++
        return minOf(score, 4)
    }

    /**
     * What recovery to offer for a failure.
     *
     * The whole point of [FriendlyAuthError] being classified is that the form
     * can put the right button under the message. "That didn't work" with no
     * next step is where people give up.
     */
    enum class Recovery { NONE, RESEND_CONFIRMATION, RESET_PASSWORD, SWITCH_TO_SIGN_IN }

    fun recovery(error: FriendlyAuthError?): Recovery = when (error) {
        FriendlyAuthError.EMAIL_NOT_CONFIRMED,
        FriendlyAuthError.EMAIL_UNVERIFIED,
        -> Recovery.RESEND_CONFIRMATION

        FriendlyAuthError.INVALID_CREDENTIALS -> Recovery.RESET_PASSWORD
        // They already have an account; sending them to sign in beats making
        // them work out why "already registered" appeared under a sign-up form.
        FriendlyAuthError.USER_ALREADY_EXISTS -> Recovery.SWITCH_TO_SIGN_IN
        FriendlyAuthError.EXPIRED_LINK -> Recovery.RESET_PASSWORD
        else -> Recovery.NONE
    }

    /** The other mode, for the toggle. */
    fun toggled(mode: Mode): Mode =
        if (mode == Mode.SIGN_IN) Mode.SIGN_UP else Mode.SIGN_IN

    private val EMAIL_SHAPE = Regex("""^[^@\s]+@[^@\s]+\.[^@\s]+$""")
}
