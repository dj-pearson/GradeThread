package com.gradethread.app.onboarding

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1384 AC2: the last onboarding step — the two things that make the app
 * useful on day one.
 *
 * Deliberately short and deliberately skippable. A checklist that blocks the
 * app is a wall in front of someone who has not seen it work yet; a checklist
 * that just SHOWS what is left is a nudge. Every item here can be done later
 * from Settings, and the copy says so.
 */
object ActivationChecklist {

    enum class Item(@StringRes val title: Int, @StringRes val detail: Int) {
        /**
         * Notifications. Asked HERE rather than at launch because the seller
         * has just told us what they came to do, so "we'll tell you when it
         * sells" is finally an answer to a question they asked.
         */
        NOTIFICATIONS(
            title = R.string.activation_notifications_title,
            detail = R.string.activation_notifications_detail,
        ),

        /** eBay. The single biggest difference between a full app and an empty one. */
        EBAY(
            title = R.string.activation_ebay_title,
            detail = R.string.activation_ebay_detail,
        ),
    }

    data class Row(val item: Item, val done: Boolean, val actionable: Boolean)

    /**
     * The checklist for the current state.
     *
     * A DONE item stays on the list rather than disappearing. A list that
     * shortens as you work it looks like things are being taken away; a list
     * with ticks on it looks like progress.
     *
     * Notifications drop off entirely below Android 13, where there is no
     * runtime grant to give — offering a button that cannot do anything is
     * worse than not offering it.
     */
    fun rows(
        notificationsRequired: Boolean,
        notificationsGranted: Boolean,
        notificationsAsked: Boolean,
        ebayConnected: Boolean,
    ): List<Row> = buildList {
        if (notificationsRequired) {
            add(
                Row(
                    item = Item.NOTIFICATIONS,
                    done = notificationsGranted,
                    // Android auto-denies a second dialog, so a button that has
                    // already been refused would do nothing and look broken.
                    actionable = !notificationsGranted && !notificationsAsked,
                ),
            )
        }
        add(Row(item = Item.EBAY, done = ebayConnected, actionable = !ebayConnected))
    }

    /** How far along, or null when there is nothing to report. */
    data class Progress(val done: Int, val total: Int)

    /**
     * US-2976: the two NUMBERS, not the sentence.
     *
     * This returned "1 of 2 done", which cannot be translated from here - the
     * word order is the translator's business and this object has no Context.
     * The screen formats it with R.string.onboarding_progress.
     */
    fun progress(rows: List<Row>): Progress? {
        if (rows.isEmpty()) return null
        return Progress(done = rows.count { it.done }, total = rows.size)
    }

    /** True when every row is ticked, so the flow can say so instead of nagging. */
    fun allDone(rows: List<Row>): Boolean = rows.isNotEmpty() && rows.all { it.done }
}
