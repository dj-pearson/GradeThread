package com.gradethread.app.home

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
    val id: String,
    val title: String,
    val subtitle: String,
    val done: Boolean = false,
) {
    companion object {
        val ADD_ITEM = ActivationStep(
            id = "add_item",
            title = "Add your first item",
            subtitle = "Snap a few photos and let AI catalog it.",
        )
        val CONNECT_EBAY = ActivationStep(
            id = "connect_ebay",
            title = "Connect eBay",
            subtitle = "Sync your listings, orders and payouts.",
        )
        val NOTIFICATIONS = ActivationStep(
            id = "notifications",
            // Value-framed, per US-647: the copy explains WHY before Android
            // shows the system dialog, which is the difference between a
            // considered yes and a reflexive no.
            title = "Turn on notifications",
            subtitle = "Know the moment something sells or a payout lands.",
        )
    }
}
