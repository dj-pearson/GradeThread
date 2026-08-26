package com.gradethread.app.settings

import androidx.annotation.StringRes
import com.gradethread.app.R
import kotlinx.coroutines.delay

/**
 * US-2685: the challenge -> verify policy for TOTP, with the IPv6 retry.
 *
 * GoTrue binds each MFA challenge to the IP that CREATED it and rejects the
 * verify with a 422 `mfa_ip_address_mismatch` when the verify egresses from a
 * different address. On cellular IPv6 — rotating RFC 4941 temporary addresses,
 * or a Wi-Fi/cellular handoff mid-flow — a single attempt flakes for a user who
 * typed the RIGHT code. Mobile networks are where this fires, which is why the
 * mobile clients carry it and the web helper it came from does too.
 *
 * A DELIBERATE PORT, not a second design. `src/lib/mfa.ts` is the original and
 * `ios/GradeThread/Settings/TwoFactorStore.swift` is the iOS port; re-running
 * challenge -> verify as one tight unit re-stamps the challenge IP immediately
 * before the verify, so the retry usually reuses the just-warmed connection.
 * The server-side half normalises the client IP at the proxy
 * (vault/10-ops/mfa-ipv6-ip-mismatch.md).
 *
 * A WRONG CODE IS NEVER RETRIED. That is the load-bearing half: retrying a
 * genuine rejection would burn the user's remaining attempts against a lockout
 * they cannot see, to fix a problem they do not have.
 *
 * The two network calls are INJECTED so the policy can be driven through every
 * branch without a GoTrue container. The policy is the part that can be wrong;
 * the calls are the part that cannot be tested here.
 */
object TwoFactorPolicy {

    /** Default attempts after the first, matching iOS and src/lib/mfa.ts. */
    const val DEFAULT_RETRIES: Int = 3

    /** Pause between attempts. Short: the point is to re-stamp the IP, not to wait. */
    const val RETRY_DELAY_MS: Long = 150

    /** What the caller gets back. `IpMismatch` is the only one that was retried. */
    sealed interface Outcome {
        data object Verified : Outcome

        /** Every attempt hit the IP mismatch. The code was probably right. */
        data object IpMismatch : Outcome

        /** Anything else, including a wrong code. Never retried. */
        data class Failed(val error: Throwable) : Outcome
    }

    /**
     * Strip everything a user might paste around a six-digit code.
     *
     * Authenticator apps render `123 456`, and a long-press copy takes the
     * space with it. Rejecting that as a wrong code would be the app blaming
     * the user for its own formatting.
     */
    fun normalizeCode(raw: String): String = raw.filter { it.isDigit() }

    /**
     * Is this the IP-mismatch GoTrue reports when the verify leaves from a
     * different address than the challenge?
     *
     * MATCHED ON THE WIRE VOCABULARY rather than on a concrete SDK exception
     * type: the code string is GoTrue's and is stable, while the Kotlin error
     * shape has changed across supabase-kt minors. A rename upstream degrades
     * this to "no retry", which is the old behaviour, not a crash.
     */
    fun isIpMismatch(error: Throwable): Boolean {
        val text = describe(error).lowercase()
        if (text.contains("mfa_ip_address_mismatch")) return true
        return text.contains("ip address") && text.contains("mismatch")
    }

    /** Message plus type name, because supabase-kt puts the code in either. */
    fun describe(error: Throwable): String {
        val message = error.message.orEmpty()
        val type = error::class.qualifiedName.orEmpty()
        val cause = error.cause?.message.orEmpty()
        return listOf(message, type, cause).filter { it.isNotBlank() }.joinToString(" ")
    }

    /**
     * Run challenge -> verify, retrying ONLY the IP mismatch.
     *
     * A challenge failure is terminal and never retried: challenge is the call
     * that STAMPS the IP, so a mismatch cannot surface there. Retrying it would
     * be retrying something else entirely.
     */
    suspend fun challengeAndVerify(
        code: String,
        retries: Int = DEFAULT_RETRIES,
        sleep: suspend (Long) -> Unit = { delay(it) },
        challenge: suspend () -> String,
        verify: suspend (challengeId: String, code: String) -> Unit,
    ): Outcome {
        val entered = normalizeCode(code)
        val attempts = maxOf(0, retries)
        var last: Throwable? = null

        for (attempt in 0..attempts) {
            val challengeId = try {
                challenge()
            } catch (e: Throwable) {
                return Outcome.Failed(e)
            }
            try {
                verify(challengeId, entered)
                return Outcome.Verified
            } catch (e: Throwable) {
                last = e
                if (!isIpMismatch(e)) return Outcome.Failed(e)
                if (attempt < attempts) sleep(RETRY_DELAY_MS)
            }
        }
        return if (last != null && isIpMismatch(last)) {
            Outcome.IpMismatch
        } else {
            Outcome.Failed(last ?: IllegalStateException("verify never ran"))
        }
    }

    /**
     * User-facing copy. NEVER GoTrue's raw sentence (the US-1025 convention):
     * the detail goes to Sentry, the user gets something they can act on.
     */
    /**
     * US-2908: the DECISION, not the words.
     *
     * This used to return English, which meant a Spanish seller read English on
     * a security surface, and it meant the US-1025 rule ("the raw GoTrue
     * sentence never reaches the user") was enforced by a test rather than by
     * the type. An Int cannot carry `mfa_ip_address_mismatch`, so the leak is
     * now impossible rather than merely checked for.
     */
    @StringRes
    fun message(outcome: Outcome): Int = when (outcome) {
        Outcome.Verified -> R.string.twofactor_msg_verified
        Outcome.IpMismatch -> R.string.twofactor_msg_ip_mismatch
        is Outcome.Failed -> R.string.twofactor_msg_code_failed
    }
}
