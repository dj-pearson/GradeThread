package com.gradethread.app.platform.push

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.platform.deeplink.DeepLinkRoute

/**
 * US-1378 (iOS `NotificationCategoryID`): the push categories the server stamps.
 *
 * These strings are a WIRE CONTRACT with the edge's push payloads. Renaming one
 * silently stops routing every already-sent notification of that kind, so they
 * are never touched for tidiness.
 */
/*
 * `label` and `help` used to sit here, holding an English name and an English
 * sentence for every category. Nothing read either one: the strings that
 * actually reach a person are PushChannel's, which is what Android shows in
 * system settings, and those are resources now. Twenty-one untranslatable
 * strings, in a file whose header is about the ids being a wire contract, which
 * is why nobody looked at the columns beside them.
 *
 * Deleted rather than localized. A per-category preferences screen would want
 * copy like it, and it should write copy for what it renders rather than
 * inherit a description written for nothing.
 */
enum class PushCategory(val id: String) {
    SALE_CREATED("sale.created"),
    PAYOUT_CLEARED("payout.cleared"),
    PAYOUT_POSTED("payout.posted"),
    TOKEN_EXPIRING("token.expiring"),
    ITEM_REVIEW_NEEDED("item.review_needed"),
    GRADE_READY("grade.ready"),
    OFFER_RECEIVED("offer.received"),
    MESSAGE_RECEIVED("message.received"),
    LISTING_ENDED("listing.ended"),
    AGING_DIGEST("aging.digest"),
    SUPPORT_REPLY("support.reply"),
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

// Mirrors android.app.NotificationManager, without importing it, so the mapping
// stays unit-testable on a plain JVM.
//
// These live OUTSIDE PushChannel rather than in its companion: an enum's
// entries are constructed before its companion is initialized, so referring to
// a companion constant from an entry's constructor argument does not compile
// ("Companion object of enum class 'PushChannel' is uninitialized here").
const val IMPORTANCE_LOW = 2
const val IMPORTANCE_DEFAULT = 3
const val IMPORTANCE_HIGH = 4

/**
 * The notification channels, in the order they appear in system settings.
 *
 * [importance] is the Android constant; kept as an Int so this file stays a
 * plain, testable value type with no framework import.
 */
enum class PushChannel(
    val id: String,
    /**
     * Resource ids, not strings, and this is the one place in the app where
     * that is not merely tidier. These two are what Android prints in Settings
     * > Apps > GradeThread > Notifications - a screen the app does not draw and
     * cannot put a `stringResource` inside. Held as English they were the only
     * part of the product that stayed English no matter what the phone's
     * language was, on a screen the seller reaches by going looking for it.
     */
    @StringRes val titleRes: Int,
    @StringRes val descriptionRes: Int,
    /** `NotificationManager.IMPORTANCE_*`. */
    val importance: Int,
) {
    /** Money in. The reason most people turn push on at all. */
    MONEY(
        "money",
        R.string.push_channel_money_title,
        R.string.push_channel_money_desc,
        IMPORTANCE_HIGH,
    ),

    SELLING(
        "selling",
        R.string.push_channel_selling_title,
        R.string.push_channel_selling_desc,
        IMPORTANCE_HIGH,
    ),

    GRADING(
        "grading",
        R.string.push_channel_grading_title,
        R.string.push_channel_grading_desc,
        IMPORTANCE_DEFAULT,
    ),

    /**
     * Time-critical. HIGH importance and set to bypass Do Not Disturb, because
     * an expired eBay token silently stops orders syncing and the window to fix
     * it is measured in days.
     */
    URGENT(
        "urgent",
        R.string.push_channel_urgent_title,
        R.string.push_channel_urgent_desc,
        IMPORTANCE_HIGH,
    ),

    UPDATES(
        "updates",
        R.string.push_channel_updates_title,
        R.string.push_channel_updates_desc,
        IMPORTANCE_LOW,
    ),
    ;

    /** Only the urgent channel asks to cut through Do Not Disturb. */
    val bypassDnd: Boolean get() = this == URGENT
}

/**
 * Inline action buttons.
 *
 * Like the categories, these ids are matched against what the system hands back
 * on a button tap, so they are a contract with every already-installed build.
 */
enum class PushAction(
    val id: String,
    /**
     * The button's caption, as a resource. Same reason as PushChannel's: this
     * text is drawn by the system in the notification shade, where none of the
     * app's own UI code can reach it, so an English literal here stayed English
     * on a Spanish phone.
     */
    @StringRes val titleRes: Int,
    /**
     * Placeholder for a typed reply, or null for a plain tap.
     *
     * Nullability is load-bearing beyond the caption: [takesInput] reads it,
     * and that decides FLAG_MUTABLE on the PendingIntent. A reply button built
     * immutable silently drops what the seller typed.
     */
    @StringRes val inputPlaceholderRes: Int? = null,
) {
    ACCEPT_OFFER("offer.accept", R.string.push_action_accept),
    COUNTER_OFFER("offer.counter", R.string.push_action_counter, R.string.push_action_counter_hint),
    MARK_SHIPPED("order.mark_shipped", R.string.push_action_shipped, R.string.push_action_shipped_hint),
    RECONNECT_EBAY("ebay.reconnect", R.string.push_action_reconnect),
    ;

    val takesInput: Boolean get() = inputPlaceholderRes != null

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
