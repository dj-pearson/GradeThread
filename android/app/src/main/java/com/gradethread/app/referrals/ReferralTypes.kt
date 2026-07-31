package com.gradethread.app.referrals

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1385 (iOS `ReferralTypes`): the referrals wire contract.
 *
 * Mirrors `services/edge-functions/src/routes/referrals.ts` and the web's
 * `src/pages/referrals.tsx`. Every field is defaulted, because the edge grew
 * `credits` and `milestones` after the first clients shipped and a strict decode
 * would break an old build against a new server for no reason.
 */
@Serializable
data class ReferralMe(
    val code: String = "",
    val stats: ReferralStats = ReferralStats(),
    val credits: ReferralCredits = ReferralCredits(),
    val milestones: ReferralMilestones = ReferralMilestones(),
    @SerialName("referred_by") val referredBy: ReferredBy? = null,
)

@Serializable
data class ReferralStats(
    val total: Int = 0,
    val pending: Int = 0,
    val qualified: Int = 0,
    val granted: Int = 0,
)

@Serializable
data class ReferralCredits(
    @SerialName("per_referral") val perReferral: Int = 0,
    val earned: Int = 0,
    val pending: Int = 0,
)

@Serializable
data class ReferralMilestones(
    @SerialName("earned_bonus_credits") val earnedBonusCredits: Int = 0,
    val next: NextMilestone? = null,
)

@Serializable
data class NextMilestone(
    val threshold: Int = 0,
    val bonus: Int = 0,
    val remaining: Int = 0,
)

@Serializable
data class ReferredBy(
    val status: String = "",
    val code: String = "",
)

/** The result of a redeem attempt: taken, or refused with a machine reason. */
data class RedeemResult(val ok: Boolean, val reason: String? = null)

/**
 * US-1385 (iOS `RedeemRejection`): the edge's `error_code` in plain words.
 *
 * Pure and separate from the network call, because the whole point of the
 * server tagging its rejections is that the client can say something SPECIFIC.
 * "That code isn't valid" in front of someone who typed their own code is a
 * dead end; "that's your own code" tells them what to do next.
 */
object RedeemRejection {

    const val GENERIC = "That code isn't valid. Double-check it and try again."

    fun message(reason: String?): String = when (reason) {
        "invalid_code", "not_found" ->
            "We couldn't find that code. Double-check it and try again."
        "self_referral" -> "That's your own code — enter a friend's code instead."
        "already_referred" -> "You've already applied a referral code."
        "expired" -> "That code has expired. Ask your friend for a current one."
        "account_suspended" -> "Your account can't redeem a referral code right now."
        "missing_code" -> "Enter a code to continue."
        else -> GENERIC
    }
}

/**
 * The referral surface's derived numbers.
 *
 * Pure, so the arithmetic that a seller will check against their credit balance
 * is checkable here rather than only on a device.
 */
object Referrals {

    /** Where a shared link points. */
    const val SIGNUP_ORIGIN = "https://gradethread.com"

    fun link(code: String?): String? =
        code?.takeIf { it.isNotBlank() }?.let { "$SIGNUP_ORIGIN/signup?ref=$it" }

    /**
     * Referrals that are counted but not yet rewarded.
     *
     * Derived as total minus granted, NOT pending plus qualified (US-1255), so
     * the three columns always reconcile — Referred = In progress + Rewarded —
     * even if the server adds a fourth `reward_status` this build has never
     * heard of. Clamped at zero: a server that reports more granted than total
     * is wrong, and a negative count on screen is worse than a stale one.
     */
    fun inProgress(stats: ReferralStats): Int = maxOf(0, stats.total - stats.granted)

    fun alreadyReferred(me: ReferralMe?): Boolean = me?.referredBy != null

    fun canRedeem(me: ReferralMe?, typed: String, busy: Boolean): Boolean =
        !alreadyReferred(me) && !busy && typed.trim().isNotEmpty()

    /** Codes are stored uppercase; the edge uppercases too, so match it here. */
    fun normalize(typed: String): String = typed.trim().uppercase()

    /**
     * What the sharer actually sends.
     *
     * The code is in the message as well as in the link, because plenty of
     * places strip or shorten URLs and a code someone can type is the fallback.
     */
    fun shareText(code: String?): String? {
        val url = link(code) ?: return null
        return "Grade and list your clothes faster with GradeThread. " +
            "Use my code $code when you sign up: $url"
    }

    /** What the seller's own referrals are worth, said once. */
    fun creditsSummary(credits: ReferralCredits): String? {
        if (credits.perReferral <= 0) return null
        return "You get ${credits.perReferral} grading " +
            (if (credits.perReferral == 1) "credit" else "credits") + " per friend who signs up."
    }

    /** "2 more to unlock 25 bonus credits" — or nothing when nothing is next. */
    fun nextMilestoneLabel(milestones: ReferralMilestones): String? {
        val next = milestones.next ?: return null
        if (next.remaining <= 0) return null
        return "${next.remaining} more to unlock ${next.bonus} bonus credits"
    }

    /**
     * How the seller's own referred-by state reads.
     *
     * `pending` and `qualified` are both "not yet", but they are not the same
     * "not yet" — one is waiting on the friend, the other on us — so they get
     * different words.
     */
    fun referredByLabel(referredBy: ReferredBy?): String? = when (referredBy?.status) {
        null -> null
        "granted" -> "You were referred with code ${referredBy.code}. The bonus has been applied."
        "qualified" -> "You were referred with code ${referredBy.code}. Your bonus is on its way."
        else -> "You were referred with code ${referredBy.code}. " +
            "The bonus lands once your first grade goes through."
    }
}
