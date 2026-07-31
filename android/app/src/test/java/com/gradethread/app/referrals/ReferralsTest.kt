package com.gradethread.app.referrals

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
        assertNull(Referrals.shareText(null))
    }

    @Test
    fun `the share message carries the code as well as the link`() {
        // Plenty of places strip or shorten URLs; a typeable code is the
        // fallback that still works when the link doesn't survive.
        val text = Referrals.shareText("ABCD2345")!!
        assertTrue(text.contains("ABCD2345"))
        assertTrue(text.contains("https://gradethread.com/signup?ref=ABCD2345"))
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
        assertEquals(
            "That's your own code — enter a friend's code instead.",
            RedeemRejection.message("self_referral"),
        )
        assertEquals(
            "You've already applied a referral code.",
            RedeemRejection.message("already_referred"),
        )
        assertEquals(
            "Your account can't redeem a referral code right now.",
            RedeemRejection.message("account_suspended"),
        )
        assertEquals("Enter a code to continue.", RedeemRejection.message("missing_code"))
        assertEquals(
            "That code has expired. Ask your friend for a current one.",
            RedeemRejection.message("expired"),
        )
        assertEquals(
            "We couldn't find that code. Double-check it and try again.",
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
            "You were referred with code FRIEND. The bonus lands once your first grade goes through.",
            Referrals.referredByLabel(ReferredBy("pending", "FRIEND")),
        )
        assertEquals(
            "You were referred with code FRIEND. Your bonus is on its way.",
            Referrals.referredByLabel(ReferredBy("qualified", "FRIEND")),
        )
        assertEquals(
            "You were referred with code FRIEND. The bonus has been applied.",
            Referrals.referredByLabel(ReferredBy("granted", "FRIEND")),
        )
        assertNull(Referrals.referredByLabel(null))
    }

    @Test
    fun `a status nobody has seen before still reads as pending, not blank`() {
        assertTrue(
            Referrals.referredByLabel(ReferredBy("escrowed", "FRIEND"))!!
                .contains("once your first grade goes through"),
        )
    }

    // ── Credits and milestones ───────────────────────────────────────────────

    @Test
    fun `the credit line is singular for one`() {
        assertEquals(
            "You get 1 grading credit per friend who signs up.",
            Referrals.creditsSummary(ReferralCredits(perReferral = 1)),
        )
        assertEquals(
            "You get 5 grading credits per friend who signs up.",
            Referrals.creditsSummary(ReferralCredits(perReferral = 5)),
        )
    }

    @Test
    fun `a zero reward says nothing rather than promising zero credits`() {
        assertNull(Referrals.creditsSummary(ReferralCredits(perReferral = 0)))
    }

    @Test
    fun `the milestone line only shows when there is one to reach`() {
        assertEquals(
            "2 more to unlock 25 bonus credits",
            Referrals.nextMilestoneLabel(
                ReferralMilestones(next = NextMilestone(threshold = 5, bonus = 25, remaining = 2)),
            ),
        )
        assertNull(Referrals.nextMilestoneLabel(ReferralMilestones()))
        // Already reached: the server can report remaining 0 in the window
        // between hitting a tier and the grant landing.
        assertNull(
            Referrals.nextMilestoneLabel(
                ReferralMilestones(next = NextMilestone(threshold = 5, bonus = 25, remaining = 0)),
            ),
        )
    }
}
