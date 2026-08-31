package com.gradethread.app.marketplaces.pricing

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import com.gradethread.app.capture.CurrencyAmount
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.math.BigDecimal
import java.math.RoundingMode

/** One active eBay listing eligible for a bulk price edit. */
data class BulkListing(val id: String, val title: String, val price: Double, val quantity: Int?)

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

    enum class Mode(@StringRes val label: Int) {
        /** Leave prices alone (the safe default). */
        NONE(R.string.bulkpricing_mode_none),

        /** Every selected listing gets the same price. */
        SET(R.string.bulkpricing_mode_set),

        /** Take a percentage off each listing's current price. */
        REDUCE(R.string.bulkpricing_mode_reduce),
    }

    /** A row's computed target, or why it can't be applied. */
    data class Target(val price: Double?, @StringRes val error: Int? = null) {
        val applicable: Boolean get() = price != null
    }

    /**
     * The new price for one listing.
     *
     * Rounds to cents the same way on both branches, and REFUSES anything under
     * a cent rather than clamping: a 95% reduction on a $0.15 item rounds to
     * $0.01 legitimately, but a deeper one reaches $0.00, and quietly pushing a
     * clamped price is not what the seller asked for.
     *
     * ## Why BigDecimal here (US-2435)
     *
     * This did the whole computation in `Double` and rounded with
     * `(raw * 100).roundToLong()`. `roundToLong` is half-up, but binary doubles
     * meant the ties never reached it: 90% off $0.15 is exactly $0.015, and the
     * double product is 0.014999999999999996 — a hair BELOW the tie — so it
     * rounded down to $0.01.
     *
     * The damage was that it was inconsistent, not that it was low. $19.99 at
     * 50% off gave $9.99 (down) while $3.33 at 50% off gave $1.67 (up). A seller
     * repricing 200 listings had a cent shaved off an arbitrary subset, with the
     * preview and the published price agreeing so nothing looked wrong.
     *
     * `CurrencyAmount` already states the house rule — "BigDecimal (never
     * Double) so 0.1 + 0.2 problems can't reach money" — and `inputValue()`
     * below routes the SET price through that same parser. This function then
     * threw the result straight back into Double two lines later.
     */
    fun target(base: Double, mode: Mode, value: Double?): Target {
        if (mode == Mode.NONE || value == null) return Target(null)
        val raw: BigDecimal = if (mode == Mode.SET) {
            BigDecimal.valueOf(value)
        } else {
            // (100 - value)/100 rather than 1 - value/100: the division happens
            // last and only once, so the intermediate stays exact.
            BigDecimal.valueOf(base)
                .multiply(BigDecimal.valueOf(100.0).subtract(BigDecimal.valueOf(value)))
                .divide(BigDecimal.valueOf(100.0))
        }
        val rounded = raw.setScale(2, RoundingMode.HALF_UP).toDouble()
        if (rounded < MIN_PRICE) {
            return Target(
                null,
                if (rounded <= 0) {
                    R.string.bulkpricing_below_zero
                } else {
                    R.string.bulkpricing_below_cent
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

    /**
     * Per-listing failures from an apply, keyed by listing id.
     *
     * US-2976: a [UiMessage], because the two halves have different owners.
     * eBay's own rejection text is the useful one and we cannot translate it;
     * our fallback only runs when eBay said nothing, and that one must.
     */
    fun rowErrors(results: List<BulkPriceResult>): Map<String, UiMessage> = results
        .filter { !it.ok }
        .associate {
            it.listingId to UiMessage(R.string.bulkpricing_row_rejected, it.error)
        }

    /**
     * The outcome line.
     *
     * A partial batch is named as a partial: "18 of 20" tells the seller two
     * listings still carry the old price, which "done" would hide.
     */
    fun summary(response: BulkPriceResponse): Summary = when {
        response.total == 0 -> Summary(R.string.bulkpricing_summary_none)
        response.succeeded == response.total ->
            Summary(R.string.bulkpricing_summary_all, listOf(response.total))
        response.succeeded == 0 ->
            Summary(R.string.bulkpricing_summary_zero, listOf(response.total))
        else -> Summary(
            R.string.bulkpricing_summary_partial,
            listOf(response.succeeded, response.total),
        )
    }

    /**
     * The outcome line, as a resource plus its numbers.
     *
     * US-2976: the SENTENCE cannot be built here. "18 of 20" puts the numbers
     * in an order English chose, and a translator has to be free to move them -
     * which is only possible if what leaves this object is the resource and the
     * arguments, not a finished string.
     */
    data class Summary(@StringRes val res: Int, val args: List<Int> = emptyList())
}
