package com.gradethread.app.marketplaces.pricing

import com.gradethread.app.capture.CurrencyAmount
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.math.roundToLong

/** One active eBay listing eligible for a bulk price edit. */
data class BulkListing(
    val id: String,
    val title: String,
    val price: Double,
    val quantity: Int?,
)

@Serializable
internal data class BulkListingRow(
    val id: String = "",
    @SerialName("listing_title") val listingTitle: String? = null,
    @SerialName("listing_price") val listingPrice: Double = 0.0,
    val quantity: Int? = null,
    @SerialName("platform_offer_id") val platformOfferId: String? = null,
)

/** One update in the bulk request. A null field is left alone server-side. */
@Serializable
data class BulkPriceUpdate(
    @SerialName("listing_id") val listingId: String,
    val price: Double? = null,
    val quantity: Int? = null,
)

@Serializable
data class BulkPriceResult(
    @SerialName("listing_id") val listingId: String = "",
    val ok: Boolean = false,
    val error: String? = null,
)

@Serializable
data class BulkPriceResponse(
    val ok: Boolean = false,
    val results: List<BulkPriceResult> = emptyList(),
    val succeeded: Int = 0,
    val total: Int = 0,
)

/**
 * US-1355: the bulk-pricing rules.
 *
 * Pure, because the arithmetic is the whole feature: a mis-rounded reduction
 * applied to two hundred live listings is two hundred wrong prices on a
 * marketplace, and there is no undo.
 */
object BulkPricing {

    /** eBay's floor. A listing can't go live below a cent. */
    const val MIN_PRICE = 0.01

    /** The server refuses more than this in one request. */
    const val MAX_UPDATES = 500

    enum class Mode(val label: String) {
        /** Leave prices alone (the safe default). */
        NONE("No change"),

        /** Every selected listing gets the same price. */
        SET("Set price"),

        /** Take a percentage off each listing's current price. */
        REDUCE("Reduce %"),
    }

    /** A row's computed target, or why it can't be applied. */
    data class Target(val price: Double?, val error: String? = null) {
        val applicable: Boolean get() = price != null
    }

    /**
     * The new price for one listing.
     *
     * Rounds to cents the same way on both branches, and REFUSES anything under
     * a cent rather than clamping: a 95% reduction on a $0.15 item rounds to
     * $0.01 legitimately, but a deeper one reaches $0.00, and quietly pushing a
     * clamped price is not what the seller asked for.
     */
    fun target(base: Double, mode: Mode, value: Double?): Target {
        if (mode == Mode.NONE || value == null) return Target(null)
        val raw = if (mode == Mode.SET) value else base * (1 - value / 100)
        val rounded = (raw * 100).roundToLong() / 100.0
        if (rounded < MIN_PRICE) {
            return Target(
                null,
                if (rounded <= 0) {
                    "That would price this at \$0 or less — lower the reduction."
                } else {
                    "That would price this under a cent — lower the reduction."
                },
            )
        }
        return Target(rounded)
    }

    /**
     * Parse the price/percent box.
     *
     * A price goes through the shared money parser; a percent is a plain number
     * bounded to 1–99. A 100% reduction is free, and a negative one is a raise
     * the seller didn't ask for — both are refused rather than reinterpreted.
     */
    fun inputValue(text: String, mode: Mode): Double? = when (mode) {
        Mode.NONE -> null
        Mode.SET -> CurrencyAmount.parseCents(text)?.takeIf { it > 0L }?.let { it / 100.0 }
        Mode.REDUCE -> text.trim().removeSuffix("%").trim().toDoubleOrNull()
            ?.takeIf { it > 0.0 && it < 100.0 }
    }

    /**
     * The updates to send: only selected rows whose target is valid.
     *
     * Rows that can't be priced are DROPPED from the request rather than sent
     * and rejected — the seller already sees the reason on the row, and a
     * request the server will refuse wholesale would take the good rows with it.
     */
    fun updates(
        listings: List<BulkListing>,
        selected: Set<String>,
        mode: Mode,
        value: Double?,
    ): List<BulkPriceUpdate> = listings
        .filter { it.id in selected }
        .mapNotNull { listing ->
            target(listing.price, mode, value).price?.let {
                BulkPriceUpdate(listingId = listing.id, price = it)
            }
        }
        .take(MAX_UPDATES)

    /** Per-listing failures from an apply, keyed by listing id. */
    fun rowErrors(results: List<BulkPriceResult>): Map<String, String> = results
        .filter { !it.ok }
        .associate { it.listingId to (it.error ?: "eBay rejected this one.") }

    /**
     * The outcome line.
     *
     * A partial batch is named as a partial: "18 of 20" tells the seller two
     * listings still carry the old price, which "done" would hide.
     */
    fun summary(response: BulkPriceResponse): String = when {
        response.total == 0 -> "Nothing to update."
        response.succeeded == response.total -> "Updated ${response.total} listings on eBay."
        response.succeeded == 0 -> "None of the ${response.total} updates went through."
        else -> "Updated ${response.succeeded} of ${response.total}. " +
            "The rest are marked below with what eBay said."
    }
}
