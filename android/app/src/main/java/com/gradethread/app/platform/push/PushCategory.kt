package com.gradethread.app.platform.push

import com.gradethread.app.platform.deeplink.DeepLinkRoute

/**
 * US-1378 (iOS `NotificationCategoryID`): the push categories the server stamps.
 *
 * These strings are a WIRE CONTRACT with the edge's push payloads. Renaming one
 * silently stops routing every already-sent notification of that kind, so they
 * are never touched for tidiness.
 */
enum class PushCategory(
    val id: String,
    val label: String,
    val help: String,
) {
    SALE_CREATED("sale.created", "New eBay sales", "When eBay reports a sold listing."),
    PAYOUT_CLEARED("payout.cleared", "Payouts cleared", "When funds reach your bank."),
    PAYOUT_POSTED("payout.posted", "Payouts posted", "When eBay posts a payout, before it clears."),
    TOKEN_EXPIRING(
        "token.expiring",
        "eBay token expiring",
        "Your eBay connection expires in under a week. Reconnect to keep syncing.",
    ),
    ITEM_REVIEW_NEEDED(
        "item.review_needed",
        "Items need review",
        "When a grade lands below the confidence threshold.",
    ),
    GRADE_READY("grade.ready", "Certified grades ready", "When an item's grade finishes."),
    OFFER_RECEIVED("offer.received", "Best offers", "When a buyer sends an offer you can answer."),
    MESSAGE_RECEIVED("message.received", "Buyer messages", "When a buyer messages you."),
    LISTING_ENDED("listing.ended", "Listing ended", "When a listing ends unsold, so you can relist."),
    AGING_DIGEST("aging.digest", "Aging stock", "A periodic summary of stock sitting too long."),
    SUPPORT_REPLY("support.reply", "Support replies", "When our support team replies to a ticket."),
    ;

    /**
     * The notification channel this category posts to.
     *
     * Channels are grouped by WHAT THE NEWS IS, not one per category: eleven
     * channels in the system settings list is a wall nobody reads, and someone
     * who wants to mute payout chatter means all of it.
     */
    val channel: PushChannel
        get() = when (this) {
            SALE_CREATED, OFFER_RECEIVED, MESSAGE_RECEIVED -> PushChannel.SELLING
            PAYOUT_CLEARED, PAYOUT_POSTED -> PushChannel.MONEY
            GRADE_READY, ITEM_REVIEW_NEEDED -> PushChannel.GRADING
            // Losing the eBay connection stops sync, listings and orders dead,
            // and the seller has days to fix it. It gets its own urgent channel
            // rather than being buried with the digest.
            TOKEN_EXPIRING -> PushChannel.URGENT
            LISTING_ENDED, AGING_DIGEST, SUPPORT_REPLY -> PushChannel.UPDATES
        }

    /**
     * Inline buttons for this category.
     *
     * Only where the action genuinely works. A button that does nothing is
     * worse than no button, because the seller believes they have dealt with it.
     */
    val actions: List<PushAction>
        get() = when (this) {
            OFFER_RECEIVED -> listOf(PushAction.ACCEPT_OFFER, PushAction.COUNTER_OFFER)
            // "You made a sale" IS the shipping prompt — there is no separate
            // shipping push, so mark-shipped lives here.
            SALE_CREATED -> listOf(PushAction.MARK_SHIPPED)
            TOKEN_EXPIRING -> listOf(PushAction.RECONNECT_EBAY)
            else -> emptyList()
        }

    companion object {
        fun of(raw: String?): PushCategory? = entries.firstOrNull { it.id == raw }
    }
}

/**
 * The notification channels, in the order they appear in system settings.
 *
 * [importance] is the Android constant; kept as an Int so this file stays a
 * plain, testable value type with no framework import.
 */
enum class PushChannel(
    val id: String,
    val title: String,
    val description: String,
    /** `NotificationManager.IMPORTANCE_*`. */
    val importance: Int,
) {
    /** Money in. The reason most people turn push on at all. */
    MONEY("money", "Payouts", "When money posts and when it lands.", IMPORTANCE_HIGH),

    SELLING("selling", "Sales, offers and messages", "Someone bought, offered, or asked.", IMPORTANCE_HIGH),

    GRADING("grading", "Grading", "When a grade finishes or needs your eye.", IMPORTANCE_DEFAULT),

    /**
     * Time-critical. HIGH importance and set to bypass Do Not Disturb, because
     * an expired eBay token silently stops orders syncing and the window to fix
     * it is measured in days.
     */
    URGENT("urgent", "Connection problems", "Your eBay connection needs attention.", IMPORTANCE_HIGH),

    UPDATES("updates", "Everything else", "Ended listings, aging stock, support replies.", IMPORTANCE_LOW),
    ;

    /** Only the urgent channel asks to cut through Do Not Disturb. */
    val bypassDnd: Boolean get() = this == URGENT

    companion object {
        // Mirrors android.app.NotificationManager, without importing it, so the
        // mapping is unit-testable on a plain JVM.
        const val IMPORTANCE_LOW = 2
        const val IMPORTANCE_DEFAULT = 3
        const val IMPORTANCE_HIGH = 4
    }
}

/**
 * Inline action buttons.
 *
 * Like the categories, these ids are matched against what the system hands back
 * on a button tap, so they are a contract with every already-installed build.
 */
enum class PushAction(
    val id: String,
    val title: String,
    /** Placeholder for a typed reply, or null for a plain tap. */
    val inputPlaceholder: String?,
) {
    ACCEPT_OFFER("offer.accept", "Accept", null),
    COUNTER_OFFER("offer.counter", "Counter", "Your counter price"),
    MARK_SHIPPED("order.mark_shipped", "Mark shipped", "Tracking number (optional)"),
    RECONNECT_EBAY("ebay.reconnect", "Reconnect", null),
    ;

    val takesInput: Boolean get() = inputPlaceholder != null

    /**
     * Whether tapping must open the app rather than run in the background.
     *
     * Only the eBay reconnect: OAuth needs a browser and a person, and running
     * it headless would fail silently every time.
     */
    val opensApp: Boolean get() = this == RECONNECT_EBAY

    companion object {
        fun of(raw: String?): PushAction? = entries.firstOrNull { it.id == raw }
    }
}

/** Where a tap on this category should land. */
fun PushCategory.route(data: Map<String, String>): DeepLinkRoute {
    val itemId = data["inventory_item_id"]?.takeIf { it.isNotBlank() }
    return when (this) {
        PushCategory.SALE_CREATED -> DeepLinkRoute.Shipping
        PushCategory.PAYOUT_CLEARED, PushCategory.PAYOUT_POSTED ->
            DeepLinkRoute.SalesTab(inventoryItemId = null)
        PushCategory.OFFER_RECEIVED, PushCategory.MESSAGE_RECEIVED ->
            DeepLinkRoute.NegotiationInbox(filterItemId = itemId)
        PushCategory.GRADE_READY, PushCategory.ITEM_REVIEW_NEEDED ->
            itemId?.let { DeepLinkRoute.InventoryItem(it) } ?: DeepLinkRoute.GradesList
        PushCategory.TOKEN_EXPIRING -> DeepLinkRoute.ReconnectEbay
        PushCategory.LISTING_ENDED ->
            itemId?.let { DeepLinkRoute.InventoryItem(it) } ?: DeepLinkRoute.InventoryTab
        PushCategory.AGING_DIGEST -> DeepLinkRoute.InventoryTab
        PushCategory.SUPPORT_REPLY -> DeepLinkRoute.SupportTickets(data["ticket_id"])
    }
}
