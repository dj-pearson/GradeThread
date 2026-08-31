package com.gradethread.app.home

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1370 AC2 / US-647: what the activation checklist shows, and when.
 *
 * Pure value types, separate from [ActivationChecklistStore] (which needs a
 * Context for DataStore) so the visibility rules are unit-testable without an
 * Android runtime — the same split the rollups use.
 */
data class ActivationState(
    val hasItem: Boolean = false,
    val ebayConnected: Boolean = false,
    val notificationsEnabled: Boolean = false,
    val dismissed: Boolean = false,
) {
    val completedCount: Int
        get() = listOf(hasItem, ebayConnected, notificationsEnabled).count { it }

    val totalCount: Int get() = 3

    val allComplete: Boolean get() = completedCount == totalCount

    /**
     * Whether to show the card at all.
     *
     * Hidden once every step is done EVEN IF never dismissed — a checklist with
     * three ticks is just clutter, and making the seller dismiss it to be rid of
     * it is a chore we'd be choosing to give them.
     */
    val shouldShow: Boolean get() = !dismissed && !allComplete

    /** Steps in display order, so the card and its progress copy can't disagree. */
    val steps: List<ActivationStep>
        get() = listOf(
            ActivationStep.ADD_ITEM to hasItem,
            ActivationStep.CONNECT_EBAY to ebayConnected,
            ActivationStep.NOTIFICATIONS to notificationsEnabled,
        ).map { (step, done) -> step.copy(done = done) }
}

data class ActivationStep(
    /**
     * ⚠ WIRE, NOT DISPLAY. [id] is persisted in DataStore and switched on by
     * HomeScreen to decide what a tap does. Translating it would route a
     * Spanish seller's tap nowhere.
     */
    val id: String,
    @StringRes val title: Int,
    @StringRes val subtitle: Int,
    val done: Boolean = false,
) {
    companion object {
        val ADD_ITEM = ActivationStep(
            id = "add_item",
            title = R.string.activation_add_item_title,
            subtitle = R.string.activation_add_item_subtitle,
        )
        val CONNECT_EBAY = ActivationStep(
            id = "connect_ebay",
            title = R.string.activation_connect_ebay_title,
            subtitle = R.string.activation_connect_ebay_subtitle,
        )
        val NOTIFICATIONS = ActivationStep(
            id = "notifications",
            // Value-framed, per US-647: the copy explains WHY before Android
            // shows the system dialog, which is the difference between a
            // considered yes and a reflexive no.
            title = R.string.activation_step_notifications_title,
            subtitle = R.string.activation_notifications_subtitle,
        )
    }
}
