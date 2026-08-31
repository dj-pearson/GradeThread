package com.gradethread.app.auth

import com.gradethread.app.platform.net.EdgeApiError
import org.junit.Assert.assertEquals
import java.io.File
import org.junit.Assert.assertNotNull
import org.junit.Test

/** US-1310: GoTrue message classification (iOS FriendlyErrorCopy). */
class FriendlyAuthErrorTest {

    private fun classify(message: String) = FriendlyAuthError.classify(RuntimeException(message))

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

    /**
     * US-2976: the copy moved to strings.xml, so this reads the FILE.
     *
     * It used to call message() and check the length. A resource id has no
     * length, and "the id is not zero" would have dropped the only assertion
     * that said the copy has to be actionable - which is the whole reason
     * these nine cases exist rather than one generic error. So it resolves each
     * id's name back to strings.xml and checks the sentence there. The file is
     * also the only version a translator ever edits.
     */
    @Test
    fun everyCase_hasActionableCopy() {
        val xml = File("src/main/res/values/strings.xml").readText()
        for (case in FriendlyAuthError.entries) {
            val name = "auth_error_" + case.name.lowercase()
            val copy = Regex("""<string name="$name">([^<]*)</string>""")
                .find(xml)?.groupValues?.get(1)
            assertNotNull("$case has no string named $name", copy)
            check(copy!!.length > 20) { "$case copy too short to be actionable: $copy" }
        }
    }

    /** Nine distinct answers, or the classification was pointless. */
    @Test
    fun everyCase_hasItsOwnCopy() {
        val ids = FriendlyAuthError.entries.map { it.message() }
        assertEquals(ids.size, ids.toSet().size)
    }
}
