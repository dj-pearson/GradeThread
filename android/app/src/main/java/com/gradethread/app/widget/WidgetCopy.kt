package com.gradethread.app.widget

import com.gradethread.app.money.Money

/**
 * US-1380 AC3 (mirrors US-1222): every word the widget says, composed from the
 * snapshot.
 *
 * Pure and separate from the Glance tree for one reason: the TalkBack labels
 * are the only version of this widget a blind seller ever gets, and a Glance
 * composable cannot be asserted in a JVM unit test. Splitting the copy out
 * means the labels are actually checked rather than merely written.
 */
object WidgetCopy {

    const val TITLE = "Seller snapshot"

    /** What the signed-out widget says instead of a row of zeros. */
    const val SIGNED_OUT = "Sign in to see your snapshot"

    fun activeListings(snapshot: WidgetSnapshot): String = snapshot.activeListings.toString()

    fun soldToday(snapshot: WidgetSnapshot): String = Money.formatCompact(snapshot.soldTodayGross)

    fun pendingPayout(snapshot: WidgetSnapshot): String =
        Money.formatCompact(snapshot.pendingPayoutNet)

    /**
     * The small line under each money figure.
     *
     * A bare "2" under a dollar amount reads as part of the amount. The unit
     * has to be on the tile, not only in the label above it.
     */
    fun soldTodaySub(snapshot: WidgetSnapshot): String =
        plural(snapshot.soldTodayCount, "sale", "sales")

    fun pendingSub(snapshot: WidgetSnapshot): String =
        plural(snapshot.pendingPayoutCount, "sale", "sales")

    /**
     * "Updated 5m ago".
     *
     * A widget can be hours behind — the system decides when it refreshes — so
     * saying WHEN is the difference between old numbers and wrong ones. A
     * snapshot with no timestamp says nothing rather than claiming "now".
     */
    fun updatedAgo(generatedAtMs: Long, nowMs: Long): String? {
        if (generatedAtMs <= 0L) return null
        val minutes = (nowMs - generatedAtMs) / 60_000L
        return when {
            // A clock that moved backwards (timezone change, NTP correction)
            // is not a reason to claim the future.
            minutes < 0L -> null
            minutes < 1L -> "Updated just now"
            minutes < 60L -> "Updated ${minutes}m ago"
            minutes < 60L * 24 -> "Updated ${minutes / 60}h ago"
            else -> "Updated ${minutes / (60 * 24)}d ago"
        }
    }

    /**
     * The whole widget as one sentence, for TalkBack.
     *
     * Spoken in the order a sighted seller reads it, with units attached to
     * every number: "3" alone tells a screen-reader user nothing, and the
     * visual layout that supplies the meaning is exactly what they can't see.
     */
    fun accessibilityLabel(snapshot: WidgetSnapshot): String {
        if (!snapshot.isSignedIn) return SIGNED_OUT
        return buildString {
            append(TITLE)
            append(". ")
            append(plural(snapshot.activeListings, "active listing", "active listings"))
            append(". ")
            if (snapshot.soldTodayCount == 0) {
                append("Nothing sold today")
            } else {
                append(plural(snapshot.soldTodayCount, "sale", "sales"))
                append(" today, ")
                // The exact amount, not the compact "$1.2k" the tile shows —
                // there is no space pressure in speech, and a rounded figure
                // read aloud sounds like the real one.
                append(Money.format(snapshot.soldTodayGross))
            }
            append(". ")
            if (snapshot.pendingPayoutCount == 0) {
                append("No payouts pending")
            } else {
                append(Money.format(snapshot.pendingPayoutNet))
                append(" pending across ")
                append(plural(snapshot.pendingPayoutCount, "sale", "sales"))
            }
            append(".")
        }
    }

    /** Where each tappable region says it goes. */
    fun listingsActionLabel(snapshot: WidgetSnapshot): String =
        "${plural(snapshot.activeListings, "active listing", "active listings")}. Opens marketplaces."

    fun moneyActionLabel(snapshot: WidgetSnapshot): String = buildString {
        if (snapshot.soldTodayCount == 0) {
            append("Nothing sold today")
        } else {
            append(plural(snapshot.soldTodayCount, "sale", "sales"))
            append(" today, ")
            append(Money.format(snapshot.soldTodayGross))
        }
        append(". Opens money.")
    }

    fun pendingActionLabel(snapshot: WidgetSnapshot): String = buildString {
        if (snapshot.pendingPayoutCount == 0) {
            append("No payouts pending")
        } else {
            append(Money.format(snapshot.pendingPayoutNet))
            append(" pending across ")
            append(plural(snapshot.pendingPayoutCount, "sale", "sales"))
        }
        append(". Opens money.")
    }

    private fun plural(count: Int, one: String, many: String): String =
        "$count ${if (count == 1) one else many}"
}
