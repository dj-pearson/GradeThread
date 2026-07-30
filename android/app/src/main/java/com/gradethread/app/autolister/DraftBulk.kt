package com.gradethread.app.autolister

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.money.Money
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.math.floor

/**
 * US-1359: an unpublished AutoLister draft — a `listings` row in draft status
 * carrying a batch id.
 */
@Serializable
data class DraftListing(
    val id: String = "",
    @SerialName("inventory_item_id") val inventoryItemId: String = "",
    @SerialName("listing_title") val listingTitle: String? = null,
    @SerialName("listing_description") val listingDescription: String? = null,
    @SerialName("listing_price") val listingPrice: Double? = null,
    @SerialName("ebay_condition") val ebayCondition: String? = null,
    val quantity: Int? = null,
    @SerialName("batch_id") val batchId: String? = null,
    /**
     * The price came from the AI estimate, not from comps. Surfaced, because a
     * seller should know which numbers were guessed before bulk-publishing them.
     */
    @SerialName("price_is_estimated") val priceIsEstimated: Boolean? = null,
    /** US-1511: a failed publish drops the draft back here carrying its reason. */
    @SerialName("publish_error") val publishError: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
) {
    val title: String get() = listingTitle?.takeIf { it.isNotBlank() } ?: "Untitled draft"
}

/**
 * US-1359: bulk draft edits, as pure functions.
 *
 * A bulk price edit rewrites many unpublished listings at once, so the same
 * caution as bulk pricing applies: it must never invent a price for a draft
 * that has none, and it must never produce a negative one.
 */
object DraftBulk {

    /** How a bulk price edit changes each draft. */
    sealed interface PriceChange {
        /** Every selected draft gets this price. */
        data class Absolute(val price: Double) : PriceChange

        /** Each draft moves by a percentage of ITS OWN price. */
        data class Percent(val pct: Double) : PriceChange

        /** The reseller charm price: floor plus .99. */
        data object Round99 : PriceChange
    }

    /**
     * The new price for one draft, or null when the change can't apply.
     *
     * Percent and round-to-.99 need a starting price; a draft with none is left
     * alone rather than being handed a number out of nowhere. Results floor at
     * zero, so a bulk edit can never seed a negative listing price.
     */
    fun newPrice(current: Double?, change: PriceChange): Double? = when (change) {
        is PriceChange.Absolute -> Money.cents(maxOf(0.0, change.price))
        is PriceChange.Percent -> current?.let {
            Money.cents(maxOf(0.0, it * (1 + change.pct / 100)))
        }

        is PriceChange.Round99 -> current?.let { Money.cents(roundTo99(it)) }
    }

    /**
     * Sub-$1 rounds to whole cents; everything else is floor + .99.
     *
     * Mirrors the web's roundTo99. The sub-$1 branch exists because flooring
     * $0.75 to $0.99 would RAISE the price, which is not what "round down to
     * .99" means to anyone.
     */
    fun roundTo99(price: Double): Double {
        if (price < 1.0) return Math.round(price * 100) / 100.0
        return floor(price) + 0.99
    }

    /** Parse a typed price for the editor. Null when blank or unparseable. */
    fun parsePrice(text: String): Double? =
        CurrencyAmount.parseCents(text)?.takeIf { it > 0L }?.let { it / 100.0 }

    /** How many of a selection a change would actually touch. */
    fun affected(drafts: List<DraftListing>, selected: Set<String>, change: PriceChange): Int =
        drafts.count { it.id in selected && newPrice(it.listingPrice, change) != null }

    /**
     * What the bulk bar says before the seller commits.
     *
     * Names the skipped rows explicitly: with a percentage change, drafts with
     * no price are silently untouched, and "12 drafts" when only 9 move is the
     * kind of quiet mismatch that erodes trust in the whole feature.
     */
    fun previewSummary(
        drafts: List<DraftListing>,
        selected: Set<String>,
        change: PriceChange,
    ): String {
        val total = drafts.count { it.id in selected }
        val touched = affected(drafts, selected, change)
        if (total == 0) return "Nothing selected."
        if (touched == total) {
            return "Updates $touched ${if (touched == 1) "draft" else "drafts"}."
        }
        val skipped = total - touched
        return "Updates $touched of $total. $skipped skipped — no price to work from."
    }
}
