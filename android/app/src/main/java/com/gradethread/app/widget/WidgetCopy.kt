package com.gradethread.app.widget

import android.content.Context
import com.gradethread.app.R
import com.gradethread.app.money.Money

/**
 * US-1380 AC3 (mirrors US-1222): every word the widget says, composed from the
 * snapshot.
 *
 * Separate from the Glance tree for one reason: the TalkBack labels are the
 * only version of this widget a blind seller ever gets, and a Glance composable
 * cannot be asserted in a test. Splitting the copy out means the labels are
 * actually checked rather than merely written.
 *
 * US-2976: EVERY FUNCTION TAKES A CONTEXT NOW. This object used to be pure and
 * every sentence was built in Kotlin, so the whole widget - a thing that sits
 * on the home screen - was English regardless of the phone's language. A
 * Context is what a resource needs, and Robolectric supplies one, so the labels
 * are still asserted; the tests moved rather than went away.
 *
 * ⚠ AND THE SENTENCES ARE NOT CONCATENATED ANY MORE. "3 sales today, $412.00"
 * was five appends in a row, which fixes the word order in English. Each one is
 * a format string with its arguments, so a translator can move them.
 */
object WidgetCopy {

    fun title(context: Context): String = context.getString(R.string.widget_title)

    /** What the signed-out widget says instead of a row of zeros. */
    fun signedOut(context: Context): String = context.getString(R.string.widget_signed_out)

    fun activeListings(snapshot: WidgetSnapshot): String = snapshot.activeListings.toString()

    fun soldToday(snapshot: WidgetSnapshot): String = Money.formatCompact(snapshot.soldTodayGross)

    fun pendingPayout(snapshot: WidgetSnapshot): String = Money.formatCompact(snapshot.pendingPayoutNet)

    /**
     * The small line under each money figure.
     *
     * A bare "2" under a dollar amount reads as part of the amount. The unit
     * is what makes it a count.
     */
    fun soldTodaySub(context: Context, snapshot: WidgetSnapshot): String = sales(context, snapshot.soldTodayCount)

    fun pendingSub(context: Context, snapshot: WidgetSnapshot): String = sales(context, snapshot.pendingPayoutCount)

    /**
     * "Updated 5m ago".
     *
     * A widget can be hours behind - the system decides when it refreshes - so
     * saying WHEN is the difference between old numbers and wrong ones. A
     * snapshot with no timestamp says nothing rather than claiming "now".
     */
    fun updatedAgo(context: Context, generatedAtMs: Long, nowMs: Long): String? {
        if (generatedAtMs <= 0L) return null
        val minutes = (nowMs - generatedAtMs) / 60_000L
        return when {
            // A clock that moved backwards (timezone change, NTP correction)
            // is not a reason to claim the future. US-2976: this branch was
            // briefly replaced by coerceAtLeast(0L) while moving the strings,
            // which turns "say nothing" into "Updated just now". The test
            // caught it.
            minutes < 0L -> null
            minutes < 1L -> context.getString(R.string.widget_updated_now)
            minutes < 60L -> context.getString(R.string.widget_updated_minutes, minutes)
            minutes < 60L * 24 -> context.getString(R.string.widget_updated_hours, minutes / 60)
            else -> context.getString(R.string.widget_updated_days, minutes / (60 * 24))
        }
    }

    /**
     * The whole widget as one sentence, for TalkBack.
     *
     * Spoken in the order a sighted seller reads it, with units attached to
     * every number: "3" alone tells a screen-reader user nothing, and the
     * visual layout that supplies the meaning is exactly what they cannot see.
     */
    fun accessibilityLabel(context: Context, snapshot: WidgetSnapshot): String {
        if (!snapshot.isSignedIn) return signedOut(context)
        return context.getString(
            R.string.widget_a11y,
            title(context),
            listings(context, snapshot.activeListings),
            soldPhrase(context, snapshot),
            pendingPhrase(context, snapshot),
        )
    }

    /** Where each tappable region says it goes. */
    fun listingsActionLabel(context: Context, snapshot: WidgetSnapshot): String = context.getString(
        R.string.widget_action_listings,
        listings(context, snapshot.activeListings),
    )

    fun moneyActionLabel(context: Context, snapshot: WidgetSnapshot): String =
        context.getString(R.string.widget_action_money, soldPhrase(context, snapshot))

    fun pendingActionLabel(context: Context, snapshot: WidgetSnapshot): String =
        context.getString(R.string.widget_action_money, pendingPhrase(context, snapshot))

    /**
     * The EXACT amount, not the compact "$1.2k" the tile shows.
     *
     * There is no space pressure in speech, and a rounded figure read aloud
     * sounds like the real one.
     */
    private fun soldPhrase(context: Context, snapshot: WidgetSnapshot): String = if (snapshot.soldTodayCount == 0) {
        context.getString(R.string.widget_sold_none)
    } else {
        context.getString(
            R.string.widget_sold_phrase,
            sales(context, snapshot.soldTodayCount),
            Money.format(snapshot.soldTodayGross),
        )
    }

    private fun pendingPhrase(context: Context, snapshot: WidgetSnapshot): String =
        if (snapshot.pendingPayoutCount == 0) {
            context.getString(R.string.widget_payout_none)
        } else {
            context.getString(
                R.string.widget_payout_pending,
                Money.format(snapshot.pendingPayoutNet),
                sales(context, snapshot.pendingPayoutCount),
            )
        }

    private fun sales(context: Context, count: Int): String =
        context.resources.getQuantityString(R.plurals.widget_sales, count, count)

    private fun listings(context: Context, count: Int): String =
        context.resources.getQuantityString(R.plurals.widget_active_listings, count, count)
}
