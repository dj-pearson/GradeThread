package com.gradethread.app.platform.shortcuts

import com.gradethread.app.R
import com.gradethread.app.money.Money
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.widget.WidgetSnapshot

/**
 * US-1381 (iOS `SoldTodaySummary`): the "what sold today" answer, in words.
 *
 * Reads the SAME snapshot the home-screen widget renders, so the two can never
 * disagree — and, like the widget, touches no auth and no network. The answer
 * has to be available with the app closed and the phone offline, which rules
 * out asking the server.
 *
 * Pure, because on Android this string is a shortcut label the launcher may
 * render at any moment, with nobody watching it be composed.
 */
object SoldTodaySummary {

    val SIGNED_OUT = UiMessage(R.string.sold_today_signed_out)

    /**
     * The full sentence.
     *
     * A null snapshot (nothing published yet) and a signed-out one both fall
     * back to the sign-in prompt rather than reading zeros, which sound like a
     * dead business rather than an unknown one.
     */
    fun dialog(snapshot: WidgetSnapshot?): UiMessage {
        if (snapshot == null || !snapshot.isSignedIn) return SIGNED_OUT

        // US-2976: the payout clause NESTS as an argument rather than being
        // concatenated on. It is a plural sentence in its own right, and a
        // language that puts it first can now do that.
        val payout = payoutClause(snapshot.pendingPayoutCount, snapshot.pendingPayoutNet)
        if (snapshot.soldTodayCount == 0) {
            return UiMessage(R.string.sold_today_nothing_yet, args = listOf(payout))
        }

        return UiMessage.plural(
            R.plurals.sold_today_sold,
            args = listOf(
                snapshot.soldTodayCount,
                Money.format(snapshot.soldTodayGross),
                payout,
            ),
            quantity = snapshot.soldTodayCount,
        )
    }

    /**
     * The short version, for a launcher shortcut label.
     *
     * Long labels are truncated by every launcher at some width nobody can
     * predict, so the money — the thing being asked about — goes first and the
     * count second. A truncated "$184 today" still answers the question.
     */
    fun shortLabel(snapshot: WidgetSnapshot?): UiMessage {
        if (snapshot == null || !snapshot.isSignedIn) {
            return UiMessage(R.string.sold_today_label_default)
        }
        if (snapshot.soldTodayCount == 0) return UiMessage(R.string.sold_today_label_nothing)
        return UiMessage(
            R.string.sold_today_label_money,
            args = listOf(Money.format(snapshot.soldTodayGross)),
        )
    }

    private fun payoutClause(count: Int, net: Double): UiMessage {
        if (count <= 0) return UiMessage(R.string.sold_today_no_payouts)
        return UiMessage.plural(
            R.plurals.sold_today_payout_waiting,
            args = listOf(count, Money.format(net)),
            quantity = count,
        )
    }
}
