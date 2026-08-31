package com.gradethread.app.referrals

import com.gradethread.app.R

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1385: the referral maths and copy.
 *
 * The numbers here sit next to a seller's credit balance, so they get checked
 * against it. The rejection copy is the only thing standing between someone who
 * typed their own code and a dead end.
 */
class ReferralsTest {

    // ── The link ─────────────────────────────────────────────────────────────

    @Test
    fun `the link carries the code`() {
        assertEquals(
            "https://gradethread.com/signup?ref=ABCD2345",
            Referrals.link("ABCD2345"),
        )
    }

    @Test
    fun `no code means no link and nothing to share`() {
        // A share button over an empty link sends a broken URL to someone's
        // friend, which is worse than no button.
        assertNull(Referrals.link(null))
        assertNull(Referrals.link(""))
        assertNull(Referrals.link("   "))
        assertNull(Referrals.shareParts(null))
    }

    @Test
    fun `the share message carries the code as well as the link`() {
        // Plenty of places strip or shorten URLs; a typeable code is the
        // fallback that still works when the link doesn't survive.
        //
        // US-2976: the two PARTS. The sentence around them is assembled on
        // screen from R.string.referral_share_text, because the seller is
        // sending it and it has to be in their language.
        val (code, url) = Referrals.shareParts("ABCD2345")!!
        assertEquals("ABCD2345", code)
        assertEquals("https://gradethread.com/signup?ref=ABCD2345", url)
    }

    // ── The three columns ────────────────────────────────────────────────────

    @Test
    fun `referred equals in-progress plus rewarded, always`() {
        // Derived as total minus granted, NOT pending plus qualified (US-1255),
        // so a reward_status this build has never heard of cannot make the row
        // stop adding up.
        val stats = ReferralStats(total = 7, pending = 2, qualified = 1, granted = 3)

        assertEquals(4, Referrals.inProgress(stats))
        assertEquals(stats.total, Referrals.inProgress(stats) + stats.granted)
    }

    @Test
    fun `a server that reports more granted than total does not go negative`() {
        val stats = ReferralStats(total = 1, granted = 4)
        assertEquals(0, Referrals.inProgress(stats))
    }

    // ── Redeeming ────────────────────────────────────────────────────────────

    @Test
    fun `you cannot redeem twice, or while busy, or with nothing typed`() {
        val fresh = ReferralMe(code = "MINE")
        val referred = ReferralMe(code = "MINE", referredBy = ReferredBy("pending", "FRIEND"))

        assertTrue(Referrals.canRedeem(fresh, "FRIEND", busy = false))
        assertFalse(Referrals.canRedeem(referred, "FRIEND", busy = false))
        assertFalse(Referrals.canRedeem(fresh, "FRIEND", busy = true))
        assertFalse(Referrals.canRedeem(fresh, "   ", busy = false))
    }

    @Test
    fun `codes are normalized the way the server stores them`() {
        assertEquals("ABCD2345", Referrals.normalize("  abcd2345 "))
    }

    @Test
    fun `every rejection says something specific`() {
        // A generic "that code isn't valid" in front of someone who typed their
        // own code is a dead end. The server tags each rejection so the client
        // can do better; this is the doing better.
        // US-2976: ids, and then the claim the ids alone would drop - that
        // every reason gets its OWN sentence, which is the entire point of
        // tagging them.
        assertEquals(R.string.referral_error_self, RedeemRejection.message("self_referral"))
        assertEquals(
            R.string.referral_error_already,
            RedeemRejection.message("already_referred"),
        )
        assertEquals(
            R.string.referral_error_suspended,
            RedeemRejection.message("account_suspended"),
        )
        assertEquals(R.string.referral_error_missing, RedeemRejection.message("missing_code"))
        val reasons = listOf(
            "self_referral",
            "already_referred",
            "account_suspended",
            "missing_code",
            "expired",
            "not_found",
        )
        assertEquals(reasons.size, reasons.map(RedeemRejection::message).toSet().size)
        assertEquals(R.string.referral_error_expired, RedeemRejection.message("expired"))
        // invalid_code and not_found share one sentence ON PURPOSE - both mean
        // "we do not know that code" and there is nothing different to say.
        assertEquals(
            RedeemRejection.message("not_found"),
            RedeemRejection.message("invalid_code"),
        )
    }

    @Test
    fun `an unknown reason falls back rather than showing a raw code`() {
        assertEquals(RedeemRejection.GENERIC, RedeemRejection.message(null))
        assertEquals(RedeemRejection.GENERIC, RedeemRejection.message("some_new_rule"))
    }

    // ── Being referred ───────────────────────────────────────────────────────

    @Test
    fun `pending and qualified are different kinds of not-yet`() {
        // One is waiting on the friend, the other on us. Same word for both
        // would leave a seller unable to tell whether to do anything.
        assertEquals(
            R.string.referral_referred_pending,
            Referrals.referredByLabel(ReferredBy("pending", "FRIEND")),
        )
        assertEquals(
            R.string.referral_referred_qualified,
            Referrals.referredByLabel(ReferredBy("qualified", "FRIEND")),
        )
        assertEquals(
            R.string.referral_referred_granted,
            Referrals.referredByLabel(ReferredBy("granted", "FRIEND")),
        )
        // Three states, three DIFFERENT ids. Same word for all three would
        // leave a seller unable to tell whether to do anything.
        val states = listOf("pending", "qualified", "granted")
        assertEquals(
            states.size,
            states.mapNotNull { Referrals.referredByLabel(ReferredBy(it, "FRIEND")) }.toSet().size,
        )
        assertNull(Referrals.referredByLabel(null))
    }

    @Test
    fun `a status nobody has seen before still reads as pending, not blank`() {
        // An unknown status falls to the PENDING wording, not to null and not
        // to "granted". Asserting the id is what says which of the three.
        assertEquals(
            R.string.referral_referred_pending,
            Referrals.referredByLabel(ReferredBy("escrowed", "FRIEND")),
        )
    }

    // ── Credits and milestones ───────────────────────────────────────────────

    @Test
    fun `the credit count is what the line is built from`() {
        // US-2976: the COUNT. Singular versus plural is now a plurals resource,
        // which is what Spanish needs anyway - this object cannot pick the form.
        assertEquals(1, Referrals.creditsPerReferral(ReferralCredits(perReferral = 1)))
        assertEquals(5, Referrals.creditsPerReferral(ReferralCredits(perReferral = 5)))
    }

    @Test
    fun `a zero reward says nothing rather than promising zero credits`() {
        assertNull(Referrals.creditsPerReferral(ReferralCredits(perReferral = 0)))
    }

    @Test
    fun `the milestone line only shows when there is one to reach`() {
        assertEquals(
            2 to 25,
            Referrals.nextMilestone(
                ReferralMilestones(next = NextMilestone(threshold = 5, bonus = 25, remaining = 2)),
            ),
        )
        assertNull(Referrals.nextMilestone(ReferralMilestones()))
        // Already reached: the server can report remaining 0 in the window
        // between hitting a tier and the grant landing.
        assertNull(
            Referrals.nextMilestone(
                ReferralMilestones(next = NextMilestone(threshold = 5, bonus = 25, remaining = 0)),
            ),
        )
    }
}
