package com.gradethread.app.marketplaces.publish

import com.gradethread.app.money.Money

/**
 * US-1352: forward-looking profit/margin estimate for a listing at a given
 * price, so pricing is a margin decision instead of a guess.
 *
 * Mirrors the web `estimateListingProfit` (`src/lib/listing-profit.ts`) and iOS
 * `ListingProfit` field-for-field — the same eBay Managed Payments model: a
 * final-value-fee fraction (~13.25%, which already folds in payment processing)
 * plus a fixed per-order fee. Pure, so the math is unit-tested with no view
 * plumbing.
 */
data class ListingProfit(
    /** Estimated marketplace fees (FVF + fixed). */
    val fees: Double,
    /** Your costs: cost basis + grading + shipping. */
    val costs: Double,
    /** price − fees − costs. Can be negative — that is the point. */
    val net: Double,
    /** net / price * 100; 0 when there is no price to divide by. */
    val marginPct: Double,
) {

    /**
     * `net` rounded to whole cents through [Money] — the SAME rounding the
     * Money tab applies to a completed sale's realized P&L. The composer shows
     * THIS, so its estimate agrees with the Money tab to the cent; the raw
     * [net] stays a faithful mirror of the web function.
     */
    val netCents: Double get() = Money.cents(net)

    /** [fees] rounded to whole cents, for display next to [netCents]. */
    val feesCents: Double get() = Money.cents(fees)

    /** Margin recomputed from [netCents] so the shown % agrees with the shown net. */
    fun marginPctCents(price: Double): Double {
        val p = Money.cents(price)
        return if (p > 0) (netCents / p) * 100 else 0.0
    }

    companion object {
        const val DEFAULT_FEE_RATE = 0.1325
        const val DEFAULT_FIXED_FEE = 0.40

        /**
         * Estimates fees/costs/net/margin for [price]. Costs are clamped to ≥ 0
         * and treated as 0 when null — the margin then reflects
         * revenue-after-fees only, matching the web.
         */
        fun estimate(
            price: Double,
            costBasis: Double? = null,
            gradingCost: Double? = null,
            shippingCost: Double? = null,
            feeRate: Double = DEFAULT_FEE_RATE,
            fixedFee: Double = DEFAULT_FIXED_FEE,
        ): ListingProfit {
            val listPrice = price.coerceAtLeast(0.0).takeIf { it.isFinite() } ?: 0.0
            val cost = (costBasis ?: 0.0).coerceAtLeast(0.0)
            val grading = (gradingCost ?: 0.0).coerceAtLeast(0.0)
            val shipping = (shippingCost ?: 0.0).coerceAtLeast(0.0)

            // No price means no sale, so no fees — not a bare fixed fee charged
            // against an empty box.
            val fees = if (listPrice > 0) listPrice * feeRate + fixedFee else 0.0
            val costs = cost + grading + shipping
            val net = listPrice - fees - costs
            return ListingProfit(
                fees = fees,
                costs = costs,
                net = net,
                marginPct = if (listPrice > 0) (net / listPrice) * 100 else 0.0,
            )
        }
    }
}
