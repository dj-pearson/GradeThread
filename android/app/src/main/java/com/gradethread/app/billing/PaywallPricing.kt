package com.gradethread.app.billing

/**
 * US-1367: what the paywall says, with no Play Store behind it.
 *
 * The savings percentages come from the REFERENCE cents in
 * [SubscriptionProduct], not from Play's localized strings. Play returns
 * "€54,99" and "$59.00" as text, and a percentage parsed back out of a
 * formatted string in an unknown locale is a number nobody should put in front
 * of a buyer. The reference prices track Play's proportional price tiers, so the
 * percentage stays right in every currency (iOS `IAPCatalog.yearlySavings`,
 * US-1177).
 */
object PaywallPricing {

    /** One row on the paywall. */
    data class TierRow(
        val offer: SubscriptionOffer,
        /** "Save 17%" on a yearly row that is actually cheaper. Null otherwise. */
        val savingsPercent: Int?,
        /** True when this is the plan the account already pays for. */
        val current: Boolean,
    ) {
        val plan: PlanTier get() = offer.product.plan
        val interval: SubscriptionInterval get() = offer.product.interval
        val purchasable: Boolean get() = offer.purchasable && !current
    }

    /**
     * Percent saved by paying yearly instead of twelve monthly payments.
     *
     * Null when either price is missing or yearly isn't actually cheaper —
     * a "Save 0%" badge is worse than no badge, and a negative one is a lie.
     */
    fun yearlySavingsPercent(monthlyCents: Int, yearlyCents: Int): Int? {
        if (monthlyCents <= 0 || yearlyCents <= 0) return null
        val annualized = monthlyCents * 12
        if (yearlyCents >= annualized) return null
        val pct = Math.round((annualized - yearlyCents) * 100.0 / annualized).toInt()
        return pct.takeIf { it > 0 }
    }

    fun yearlySavingsPercent(plan: PlanTier): Int? = yearlySavingsPercent(
        SubscriptionProduct.of(plan, SubscriptionInterval.MONTHLY).fallbackPriceCents,
        SubscriptionProduct.of(plan, SubscriptionInterval.YEARLY).fallbackPriceCents,
    )

    /** The headline for the yearly toggle: the best discount any tier offers. */
    fun bestYearlySavingsPercent(): Int? =
        PlanTier.entries.mapNotNull { yearlySavingsPercent(it) }.maxOrNull()

    /**
     * The rows for one billing interval, cheapest tier first.
     *
     * [currentPlan] is what the SERVER says the account has. Marking the current
     * plan matters more than it looks: Play will happily sell someone the plan
     * they are already on, and the charge is real.
     */
    fun rows(
        offers: List<SubscriptionOffer>,
        interval: SubscriptionInterval,
        currentPlan: PlanTier?,
    ): List<TierRow> = offers
        .filter { it.product.interval == interval }
        .sortedBy { it.product.fallbackPriceCents }
        .map { offer ->
            TierRow(
                offer = offer,
                savingsPercent = if (interval == SubscriptionInterval.YEARLY) {
                    yearlySavingsPercent(offer.product.plan)
                } else {
                    null
                },
                current = currentPlan == offer.product.plan,
            )
        }

    /** "$59.00 / month" — the unit a buyer compares on. */
    fun priceLine(row: TierRow): String {
        val per = when (row.interval) {
            SubscriptionInterval.MONTHLY -> "month"
            SubscriptionInterval.YEARLY -> "year"
        }
        return "${row.offer.priceLabel} / $per"
    }

    /**
     * What a yearly price works out to per month.
     *
     * Derived from the reference cents rather than Play's string, for the same
     * reason the percentage is. Null on a monthly row — restating its own price
     * is noise.
     */
    fun monthlyEquivalent(row: TierRow): String? {
        if (row.interval != SubscriptionInterval.YEARLY) return null
        val cents = row.offer.product.fallbackPriceCents / 12
        return "About $" + "%,.2f".format(java.util.Locale.US, cents / 100.0) + " a month"
    }

    /**
     * Why a row can't be tapped, or null if it can.
     *
     * Two different reasons, and conflating them would be its own bug: "you
     * already have this" is good news, "Play can't sell this" is not.
     */
    fun blockedReason(row: TierRow): String? = when {
        row.current -> "Your current plan"
        !row.offer.purchasable -> "Not available through Google Play right now"
        else -> null
    }
}
