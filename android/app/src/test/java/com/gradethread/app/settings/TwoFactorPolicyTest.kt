package com.gradethread.app.settings

import com.gradethread.app.R
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2685 AC4: the challenge -> verify retry policy.
 *
 * The two network calls are injected, so every branch runs without a GoTrue
 * container. What is tested is the POLICY, which is the part that can be wrong.
 *
 * The one rule that matters most is the negative: A WRONG CODE IS NEVER
 * RETRIED. Retrying a genuine rejection burns the user's remaining attempts
 * against a lockout they cannot see, to fix a problem they do not have.
 */
class TwoFactorPolicyTest {

    private fun ipMismatch() = RuntimeException("422: mfa_ip_address_mismatch")
    private fun wrongCode() = RuntimeException("Invalid TOTP code entered")

    @Test
    fun `a correct code verifies on the first attempt`() = runTest {
        var challenges = 0
        var verifies = 0
        val outcome = TwoFactorPolicy.challengeAndVerify(
            code = "123456",
            sleep = {},
            challenge = {
                challenges++
                "ch-$challenges"
            },
            verify = { _, _ -> verifies++ },
        )
        assertEquals(TwoFactorPolicy.Outcome.Verified, outcome)
        assertEquals(1, challenges)
        assertEquals(1, verifies)
    }

    @Test
    fun `an IP mismatch retries, and a later attempt can succeed`() = runTest {
        // The whole reason this policy exists: the code was RIGHT and the
        // network moved underneath it.
        var attempts = 0
        val outcome = TwoFactorPolicy.challengeAndVerify(
            code = "123456",
            sleep = {},
            challenge = { "ch" },
            verify = { _, _ -> if (++attempts < 3) throw ipMismatch() },
        )
        assertEquals(TwoFactorPolicy.Outcome.Verified, outcome)
        assertEquals(3, attempts)
    }

    @Test
    fun `each retry re-runs the CHALLENGE, not just the verify`() = runTest {
        // Load-bearing. Re-verifying against the SAME challenge would retry
        // against the stale IP stamp and fail identically every time. The point
        // is to re-stamp the IP immediately before the verify.
        val challengeIds = mutableListOf<String>()
        var n = 0
        TwoFactorPolicy.challengeAndVerify(
            code = "123456",
            sleep = {},
            challenge = { "ch-${++n}" },
            verify = { id, _ ->
                challengeIds += id
                if (n < 3) throw ipMismatch()
            },
        )
        assertEquals(listOf("ch-1", "ch-2", "ch-3"), challengeIds)
    }

    @Test
    fun `a wrong code is NEVER retried`() = runTest {
        var verifies = 0
        val outcome = TwoFactorPolicy.challengeAndVerify(
            code = "000000",
            sleep = {},
            challenge = { "ch" },
            verify = { _, _ ->
                verifies++
                throw wrongCode()
            },
        )
        assertTrue(outcome is TwoFactorPolicy.Outcome.Failed)
        assertEquals("a wrong code was retried", 1, verifies)
    }

    @Test
    fun `a challenge failure is terminal`() = runTest {
        // A mismatch cannot surface on challenge - it is the call that STAMPS
        // the IP - so any challenge failure is something else, and retrying it
        // would be retrying a different problem.
        var challenges = 0
        val outcome = TwoFactorPolicy.challengeAndVerify(
            code = "123456",
            sleep = {},
            challenge = {
                challenges++
                throw IOException("network down")
            },
            verify = { _, _ -> throw AssertionError("verify must not run") },
        )
        assertTrue(outcome is TwoFactorPolicy.Outcome.Failed)
        assertEquals(1, challenges)
    }

    @Test
    fun `exhausting the retries reports the mismatch, not a wrong code`() = runTest {
        // The user typed the right code. Telling them it was wrong sends them
        // to re-read their authenticator instead of switching networks.
        var verifies = 0
        val outcome = TwoFactorPolicy.challengeAndVerify(
            code = "123456",
            retries = 2,
            sleep = {},
            challenge = { "ch" },
            verify = { _, _ ->
                verifies++
                throw ipMismatch()
            },
        )
        assertEquals(TwoFactorPolicy.Outcome.IpMismatch, outcome)
        assertEquals("retries=2 means 3 attempts in total", 3, verifies)
        // US-2908: message() returns a @StringRes id now, so this asserts the
        // MAPPING rather than the English. The wording itself is res/values and
        // res/values-es, where the translation guard can see it.
        assertEquals(R.string.twofactor_msg_ip_mismatch, TwoFactorPolicy.message(outcome))
    }

    @Test
    fun `zero and negative retries still make one attempt`() = runTest {
        for (retries in listOf(0, -1, -5)) {
            var verifies = 0
            TwoFactorPolicy.challengeAndVerify(
                code = "123456",
                retries = retries,
                sleep = {},
                challenge = { "ch" },
                verify = { _, _ ->
                    verifies++
                    throw ipMismatch()
                },
            )
            assertEquals("retries=$retries", 1, verifies)
        }
    }

    @Test
    fun `the mismatch is matched on GoTrue's wire vocabulary`() = runTest {
        // Matched on the code string rather than an SDK exception type: the
        // string is GoTrue's and stable, the Kotlin error shape has moved
        // across supabase-kt minors. A rename upstream degrades this to "no
        // retry", which is the old behaviour rather than a crash.
        assertTrue(TwoFactorPolicy.isIpMismatch(RuntimeException("mfa_ip_address_mismatch")))
        assertTrue(TwoFactorPolicy.isIpMismatch(RuntimeException("MFA_IP_ADDRESS_MISMATCH")))
        assertTrue(TwoFactorPolicy.isIpMismatch(RuntimeException("IP address mismatch detected")))
        assertFalse(TwoFactorPolicy.isIpMismatch(RuntimeException("Invalid TOTP code")))
        assertFalse(TwoFactorPolicy.isIpMismatch(RuntimeException("ip address")))
    }

    @Test
    fun `the mismatch is found on a wrapped cause too`() = runTest {
        // supabase-kt wraps transport errors, so the code can arrive one level
        // down. Missing it there would silently disable the retry.
        val wrapped = RuntimeException("request failed", RuntimeException("mfa_ip_address_mismatch"))
        assertTrue(TwoFactorPolicy.isIpMismatch(wrapped))
    }

    @Test
    fun `a pasted code with spaces still verifies`() = runTest {
        // Authenticator apps render "123 456" and a long-press copy takes the
        // space. Rejecting that as a wrong code is the app blaming the user for
        // its own formatting.
        var seen: String? = null
        TwoFactorPolicy.challengeAndVerify(
            code = " 123 456 ",
            sleep = {},
            challenge = { "ch" },
            verify = { _, entered -> seen = entered },
        )
        assertEquals("123456", seen)
    }

    @Test
    fun `normalizeCode keeps digits only`() {
        assertEquals("123456", TwoFactorPolicy.normalizeCode("123-456"))
        assertEquals("123456", TwoFactorPolicy.normalizeCode(" 123 456\n"))
        assertEquals("", TwoFactorPolicy.normalizeCode("abcdef"))
    }

    /**
     * US-1025's rule, now enforced by the TYPE rather than by this test.
     *
     * message() returned English until US-2908, and the risk was that a future
     * branch would interpolate GoTrue's own sentence into it. It returns a
     * @StringRes id now, and an Int cannot carry "mfa_ip_address_mismatch" - so
     * the leak is impossible rather than merely checked for.
     *
     * What is still worth asserting is that every outcome maps to a REAL and
     * DISTINCT resource. A `when` that fell through to one id would show the
     * same sentence for "verified" and "that code didn't work", which is a
     * worse failure than an untranslated string and would pass any test that
     * only asked for non-blankness.
     */
    @Test
    fun `every outcome maps to its own real string resource`() {
        val ids = listOf(
            TwoFactorPolicy.message(TwoFactorPolicy.Outcome.Verified),
            TwoFactorPolicy.message(TwoFactorPolicy.Outcome.IpMismatch),
            TwoFactorPolicy.message(
                TwoFactorPolicy.Outcome.Failed(RuntimeException("mfa_ip_address_mismatch")),
            ),
        )
        for (id in ids) assertTrue("unresolved resource id", id != 0)
        assertEquals("two outcomes share a message", ids.size, ids.toSet().size)
    }
}
