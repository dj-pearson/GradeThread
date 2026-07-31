package com.gradethread.app.widget

import kotlinx.serialization.Serializable

/**
 * US-1380 (iOS `WidgetSnapshot`): the tiny rollup the home-screen widget draws.
 *
 * A widget render has a hard budget and no business opening Room or the
 * network, so the app computes this after every sync and writes it once.
 * The widget only ever reads it back.
 *
 * Every field is defaulted because this is a PERSISTED shape: a snapshot
 * written by an older build has to keep decoding after an upgrade, and a
 * missing field must not throw inside a render nobody can see fail.
 */
@Serializable
data class WidgetSnapshot(
    /**
     * When the app computed this. The widget shows "Updated 5m ago", so a
     * stale snapshot looks stale rather than looking wrong.
     */
    val generatedAt: Long = 0L,

    /**
     * False when nobody is signed in. The widget then asks them to sign in
     * rather than showing zeros, which read as a dead business.
     */
    val isSignedIn: Boolean = false,

    /** Live listings across every platform (active + relisted). */
    val activeListings: Int = 0,

    /** Completed sales whose sale date falls on the current LOCAL day. */
    val soldTodayCount: Int = 0,

    /** Gross of those sales, before fees. */
    val soldTodayGross: Double = 0.0,

    /** Completed sales with no payout reference — earned, not yet banked. */
    val pendingPayoutCount: Int = 0,

    /** Net of those: sale price minus platform fees, never below zero. */
    val pendingPayoutNet: Double = 0.0,
) {
    /**
     * Whether the NUMBERS match, ignoring [generatedAt].
     *
     * The publisher diffs on this so a sync that changed nothing doesn't
     * rewrite the file and wake every widget on the home screen.
     */
    fun hasSameRollup(other: WidgetSnapshot): Boolean =
        isSignedIn == other.isSignedIn &&
            activeListings == other.activeListings &&
            soldTodayCount == other.soldTodayCount &&
            soldTodayGross == other.soldTodayGross &&
            pendingPayoutCount == other.pendingPayoutCount &&
            pendingPayoutNet == other.pendingPayoutNet

    companion object {
        /**
         * Signed out.
         *
         * Deliberately distinct from an all-zero SIGNED-IN snapshot, which is a
         * real seller having a quiet day. The widget branches its copy on it.
         */
        fun signedOut(generatedAt: Long = 0L) = WidgetSnapshot(
            generatedAt = generatedAt,
            isSignedIn = false,
        )

        /**
         * What the widget picker previews, and what shows in the gap before the
         * first real publish. Plausible numbers, so the preview reads as the
         * feature rather than as an error state.
         */
        val PLACEHOLDER = WidgetSnapshot(
            generatedAt = 0L,
            isSignedIn = true,
            activeListings = 12,
            soldTodayCount = 3,
            soldTodayGross = 184.0,
            pendingPayoutCount = 5,
            pendingPayoutNet = 312.55,
        )
    }
}
