package com.gradethread.app.platform.shortcuts

import com.gradethread.app.money.Money
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

    const val SIGNED_OUT = "Sign in to see what sold today"

    /**
     * The full sentence.
     *
     * A null snapshot (nothing published yet) and a signed-out one both fall
     * back to the sign-in prompt rather than reading zeros, which sound like a
     * dead business rather than an unknown one.
     */
    fun dialog(snapshot: WidgetSnapshot?): String {
        if (snapshot == null || !snapshot.isSignedIn) return SIGNED_OUT

        val payout = payoutClause(snapshot.pendingPayoutCount, snapshot.pendingPayoutNet)
        if (snapshot.soldTodayCount == 0) return "Nothing's sold yet today. $payout"

        val itemWord = if (snapshot.soldTodayCount == 1) "item" else "items"
        return "You've sold ${snapshot.soldTodayCount} $itemWord today for " +
            "${Money.format(snapshot.soldTodayGross)}. $payout"
    }

    /**
     * The short version, for a launcher shortcut label.
     *
     * Long labels are truncated by every launcher at some width nobody can
     * predict, so the money — the thing being asked about — goes first and the
     * count second. A truncated "$184 today" still answers the question.
     */
    fun shortLabel(snapshot: WidgetSnapshot?): String {
        if (snapshot == null || !snapshot.isSignedIn) return "Sold today"
        if (snapshot.soldTodayCount == 0) return "Nothing sold today"
        return "${Money.format(snapshot.soldTodayGross)} today"
    }

    private fun payoutClause(count: Int, net: Double): String {
        if (count <= 0) return "No payouts are waiting."
        val saleWord = if (count == 1) "sale" else "sales"
        return "${Money.format(net)} is waiting from $count $saleWord."
    }
}
