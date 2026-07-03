package com.gradethread.app.auth

import com.gradethread.app.platform.net.EdgeApiError
import org.junit.Assert.assertEquals
import org.junit.Test

/** US-1310: GoTrue message classification (iOS FriendlyErrorCopy). */
class FriendlyAuthErrorTest {

    private fun classify(message: String) =
        FriendlyAuthError.classify(RuntimeException(message))

    @Test
    fun typedEdgeCases_beatStringMatching() {
        assertEquals(
            FriendlyAuthError.OFFLINE,
            FriendlyAuthError.classify(EdgeApiError.Network("boom")),
        )
        assertEquals(
            FriendlyAuthError.EMAIL_UNVERIFIED,
            FriendlyAuthError.classify(EdgeApiError.EmailUnverified),
        )
    }

    @Test
    fun gotruePhrases_classify() {
        assertEquals(FriendlyAuthError.INVALID_CREDENTIALS, classify("Invalid login credentials"))
        assertEquals(FriendlyAuthError.EMAIL_NOT_CONFIRMED, classify("Email not confirmed"))
        assertEquals(FriendlyAuthError.RATE_LIMITED, classify("over_email_send_rate_limit"))
        assertEquals(FriendlyAuthError.USER_ALREADY_EXISTS, classify("User already registered"))
        assertEquals(FriendlyAuthError.WEAK_PASSWORD, classify("weak_password: too short"))
        assertEquals(
            FriendlyAuthError.WEAK_PASSWORD,
            classify("Password should be at least 8 characters"),
        )
        assertEquals(FriendlyAuthError.EXPIRED_LINK, classify("otp_expired"))
        assertEquals(FriendlyAuthError.OFFLINE, classify("Unable to resolve host api.gradethread.com"))
        assertEquals(FriendlyAuthError.GENERIC, classify("some backend exploded"))
    }

    @Test
    fun everyCase_hasActionableCopy() {
        for (case in FriendlyAuthError.entries) {
            val msg = case.message()
            check(msg.length > 20) { "$case copy too short to be actionable" }
        }
    }
}
