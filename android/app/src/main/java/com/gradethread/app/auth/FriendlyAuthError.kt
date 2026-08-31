package com.gradethread.app.auth

import androidx.annotation.StringRes
import com.gradethread.app.R

import com.gradethread.app.platform.net.EdgeApiError

/**
 * US-1310: friendly auth error copy (iOS FriendlyErrorCopy) — GoTrue's raw
 * messages classified into actionable cases so the UI can offer the right
 * recovery (resend confirmation, reset password, wait out a rate limit).
 * Pure string classification; unit-tested.
 */
enum class FriendlyAuthError {
    OFFLINE,
    INVALID_CREDENTIALS,

    /** Sign-in rejected because the signup confirmation link was never
     *  clicked — the UI offers a RESEND button (US-810). */
    EMAIL_NOT_CONFIRMED,

    /** The EDGE refused a feature for an unconfirmed account (US-1182) —
     *  same recovery as [EMAIL_NOT_CONFIRMED], kept distinct by origin. */
    EMAIL_UNVERIFIED,
    RATE_LIMITED,
    USER_ALREADY_EXISTS,
    WEAK_PASSWORD,

    /** Expired/used OTP or PKCE mismatch on an auth link (US-1492). */
    EXPIRED_LINK,
    GENERIC,
    ;

    /** User-facing copy — mirrors the iOS strings. */
    /**
     * US-2976: a string RESOURCE, not a sentence.
     *
     * These are the nine things the app says when someone cannot get IN, so a
     * seller who reads them in a language they do not have is stuck at the
     * door with no way to tell an expired link from a wrong password.
     */
    @StringRes
    fun message(): Int = when (this) {
        OFFLINE -> R.string.auth_error_offline
        INVALID_CREDENTIALS -> R.string.auth_error_invalid_credentials
        EMAIL_NOT_CONFIRMED -> R.string.auth_error_email_not_confirmed
        EMAIL_UNVERIFIED -> R.string.auth_error_email_unverified
        RATE_LIMITED -> R.string.auth_error_rate_limited
        USER_ALREADY_EXISTS -> R.string.auth_error_user_already_exists
        WEAK_PASSWORD -> R.string.auth_error_weak_password
        EXPIRED_LINK -> R.string.auth_error_expired_link
        GENERIC -> R.string.auth_error_generic
    }

    companion object {

        fun classify(error: Throwable): FriendlyAuthError {
            // Typed edge cases first (like the iOS typed matches).
            if (error is EdgeApiError.Network) return OFFLINE
            if (error is EdgeApiError.EmailUnverified) return EMAIL_UNVERIFIED

            val lower = (error.message ?: "").lowercase()
            return when {
                listOf(
                    "offline",
                    "the internet connection",
                    "not connected to the internet",
                    "network connection was lost",
                    "timed out",
                    "unable to resolve host",
                    "failed to connect",
                ).any { lower.contains(it) } -> OFFLINE

                listOf(
                    "invalid login credentials",
                    "invalid_credentials",
                    "invalid email or password",
                    "incorrect email or password",
                ).any { lower.contains(it) } -> INVALID_CREDENTIALS

                listOf(
                    "email not confirmed",
                    "email_not_confirmed",
                    "not confirmed",
                    "confirm your email",
                ).any { lower.contains(it) } -> EMAIL_NOT_CONFIRMED

                listOf(
                    "rate limit",
                    "rate_limit",
                    "too many requests",
                    "over_email_send_rate_limit",
                ).any { lower.contains(it) } -> RATE_LIMITED

                listOf(
                    "user already registered",
                    "already registered",
                    "user_already_exists",
                    "email_exists",
                    "already been registered",
                ).any { lower.contains(it) } -> USER_ALREADY_EXISTS

                listOf(
                    "weak_password",
                    "password should be",
                    "password is too weak",
                    "password should contain",
                ).any { lower.contains(it) } -> WEAK_PASSWORD

                listOf(
                    "otp_expired",
                    "expired",
                    "invalid flow state",
                    "flow_state_not_found",
                    "code verifier",
                ).any { lower.contains(it) } -> EXPIRED_LINK

                else -> GENERIC
            }
        }
    }
}
