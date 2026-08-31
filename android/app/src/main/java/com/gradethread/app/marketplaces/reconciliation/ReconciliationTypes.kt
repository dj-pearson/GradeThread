package com.gradethread.app.marketplaces.reconciliation

import com.gradethread.app.ui.UiMessage

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1356: one unmatched eBay listing from `flipdesk_ebay_listings`.
 *
 * Each row waits on a decision — create a new item, link it to an existing
 * one, or ignore it — before it leaves the queue.
 */
@Serializable
data class OrphanEbayListing(
    val id: String = "",
    @SerialName("ebay_item_id") val ebayItemId: String = "",
    /** eBay's "Custom label" — usually the seller's SKU. Often unset. */
    @SerialName("custom_label") val customLabel: String? = null,
    val title: String? = null,
    @SerialName("current_price") val currentPrice: Double? = null,
    @SerialName("available_quantity") val availableQuantity: Int? = null,
    @SerialName("listing_url") val listingUrl: String? = null,
    @SerialName("listing_format") val listingFormat: String? = null,
    @SerialName("imported_at") val importedAt: String? = null,
) {
    /**
     * What the queue row shows. eBay doesn't always give us a title, and
     * "Listing 12345" is at least true — a blank row is not.
     */
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() } ?: "Listing $ebayItemId"

    /** The title pre-filled into the create sheet. Same fallback, named for intent. */
    val suggestedTitle: String get() = displayTitle
}

/** What happened to one orphan. */
sealed interface ReconcileOutcome {
    val orphanId: String

    data class Created(override val orphanId: String, val itemId: String) : ReconcileOutcome
    data class Linked(override val orphanId: String, val itemId: String) : ReconcileOutcome
    data class Ignored(override val orphanId: String) : ReconcileOutcome
    data class Failed(override val orphanId: String, val message: UiMessage) : ReconcileOutcome

    val succeeded: Boolean get() = this !is Failed
}

/** Aggregate of a create-all run. */
data class ReconcileBulkResult(val succeeded: Int = 0, val failures: List<Pair<String, UiMessage>> = emptyList()) {
    val total: Int get() = succeeded + failures.size

    /**
     * The toast line. A partial run says so — "created 8 of 10" leaves the
     * seller looking for the two that didn't, which "created 8" would hide.
     */
    val summary: String
        get() {
            val unit = if (total == 1) "item" else "items"
            return when {
                total == 0 -> "Nothing to create."
                failures.isEmpty() -> "Created $succeeded $unit from eBay."
                succeeded == 0 -> "All $total $unit failed."
                else -> "Created $succeeded of $total $unit; ${failures.size} failed."
            }
        }

    companion object {
        fun from(outcomes: List<ReconcileOutcome>): ReconcileBulkResult = ReconcileBulkResult(
            succeeded = outcomes.count { it.succeeded },
            failures = outcomes.filterIsInstance<ReconcileOutcome.Failed>()
                .map { it.orphanId to it.message },
        )
    }
}

/**
 * US-1356: how many listings are waiting, and whether that number is exact.
 *
 * [atLeast] exists because the count is read with a ceiling — "200+" is what we
 * actually know, and rendering a precise-looking 200 would claim a measurement
 * that wasn't taken.
 */
data class OrphanCount(val value: Int = 0, val atLeast: Boolean = false) {
    val isEmpty: Boolean get() = value <= 0

    /** "3 unmatched eBay listings" / "200+ unmatched eBay listings". */
    val label: String
        get() {
            val number = if (atLeast) "$value+" else "$value"
            val noun = if (value == 1 && !atLeast) "listing" else "listings"
            return "$number unmatched eBay $noun"
        }
}
