package com.gradethread.app.referrals

import androidx.annotation.StringRes
import com.gradethread.app.R

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
data class ReferralStats(val total: Int = 0, val pending: Int = 0, val qualified: Int = 0, val granted: Int = 0)

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
data class NextMilestone(val threshold: Int = 0, val bonus: Int = 0, val remaining: Int = 0)

@Serializable
data class ReferredBy(val status: String = "", val code: String = "")

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

    @StringRes
    val GENERIC: Int = R.string.referral_error_generic

    @StringRes
    fun message(reason: String?): Int = when (reason) {
        "invalid_code", "not_found" -> R.string.referral_error_not_found
        "self_referral" -> R.string.referral_error_self
        "already_referred" -> R.string.referral_error_already
        "expired" -> R.string.referral_error_expired
        "account_suspended" -> R.string.referral_error_suspended
        "missing_code" -> R.string.referral_error_missing
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

    fun link(code: String?): String? = code?.takeIf { it.isNotBlank() }?.let { "$SIGNUP_ORIGIN/signup?ref=$it" }

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
     * What the sharer actually sends: the code and the link.
     *
     * The code is in the message as well as in the link, because plenty of
     * places strip or shorten URLs and a code someone can type is the fallback.
     *
     * US-2976: the two PARTS, not the sentence.
     *
     * This is the text a seller sends a friend, so it has to be in the
     * seller's language - and the sentence around the code cannot be built by
     * an object with no Context. The screen formats
     * R.string.referral_share_text with these two.
     */
    fun shareParts(code: String?): Pair<String, String>? {
        val trimmed = code?.takeIf { it.isNotBlank() } ?: return null
        val url = link(trimmed) ?: return null
        return trimmed to url
    }

    /** What a referral is worth, or null when it is nothing. */
    fun creditsPerReferral(credits: ReferralCredits): Int? = credits.perReferral.takeIf { it > 0 }

    /** The next milestone's remaining count and bonus, or null when none is next. */
    fun nextMilestone(milestones: ReferralMilestones): Pair<Int, Int>? {
        val next = milestones.next ?: return null
        if (next.remaining <= 0) return null
        return next.remaining to next.bonus
    }

    /**
     * How the seller's own referred-by state reads.
     *
     * `pending` and `qualified` are both "not yet", but they are not the same
     * "not yet" — one is waiting on the friend, the other on us — so they get
     * different words.
     */
    @StringRes
    fun referredByLabel(referredBy: ReferredBy?): Int? = when (referredBy?.status) {
        null -> null
        "granted" -> R.string.referral_referred_granted
        "qualified" -> R.string.referral_referred_qualified
        else -> R.string.referral_referred_pending
    }
}
