package com.gradethread.app.billing

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1366: the FlipDesk subscription products, keyed by their PLAY CONSOLE id.
 *
 * These ids must match `ANDROID_CATALOG` in the edge's
 * `lib/google-play/products.ts` exactly. The server classifies a purchase from
 * the reported product id alone and FAILS CLOSED on an unknown one, so a typo
 * here is not a display bug — it is a subscription the buyer is charged for and
 * never entitled to. Pinned by a test against the same table.
 *
 * One product per plan+interval rather than one product with base plans. That
 * mirrors the iOS structure and keeps the mapping deterministic from the
 * reported product id, which is all the server gets.
 */
enum class PlanTier(val slug: String, val label: String) {
    STARTER("starter", "Starter"),
    PRO("pro", "Pro"),
    BUSINESS("business", "Business"),
    ;

    companion object {
        fun fromSlug(slug: String?): PlanTier? = entries.firstOrNull { it.slug.equals(slug, ignoreCase = true) }
    }
}

/**
 * US-2976: [label] is a string RESOURCE here and a plain String on [PlanTier]
 * one class up, and the difference is deliberate. "Monthly" and "Yearly" are
 * words; "Starter", "Pro" and "Business" are the names of things we sell, and a
 * seller who reads about Pro in a Spanish support thread has to find Pro on the
 * paywall.
 */
enum class SubscriptionInterval(val slug: String, @StringRes val label: Int) {
    MONTHLY("monthly", R.string.billing_period_monthly),
    YEARLY("yearly", R.string.billing_period_yearly),
}

enum class SubscriptionProduct(
    val productId: String,
    val plan: PlanTier,
    val interval: SubscriptionInterval,
    val fallbackPriceCents: Int,
) {
    STARTER_MONTHLY("flipdesk_starter_monthly", PlanTier.STARTER, SubscriptionInterval.MONTHLY, 2900),
    STARTER_YEARLY("flipdesk_starter_yearly", PlanTier.STARTER, SubscriptionInterval.YEARLY, 29000),
    PRO_MONTHLY("flipdesk_pro_monthly", PlanTier.PRO, SubscriptionInterval.MONTHLY, 5900),
    PRO_YEARLY("flipdesk_pro_yearly", PlanTier.PRO, SubscriptionInterval.YEARLY, 59000),
    BUSINESS_MONTHLY("flipdesk_business_monthly", PlanTier.BUSINESS, SubscriptionInterval.MONTHLY, 9900),
    BUSINESS_YEARLY("flipdesk_business_yearly", PlanTier.BUSINESS, SubscriptionInterval.YEARLY, 99000),
    ;

    /**
     * Shown only until Play returns the real localized price. It mirrors
     * `FLIPDESK_PLANS` in the web constants, but Play's formatted price is
     * authoritative — it carries the buyer's currency and any regional pricing,
     * and quoting USD to someone who will be charged euros is a broken promise.
     */
    val fallbackPriceLabel: String
        get() = "$" + "%,.2f".format(java.util.Locale.US, fallbackPriceCents / 100.0)

    companion object {
        val productIds: List<String> = entries.map { it.productId }

        fun fromProductId(productId: String?): SubscriptionProduct? = entries.firstOrNull { it.productId == productId }

        fun of(plan: PlanTier, interval: SubscriptionInterval): SubscriptionProduct =
            entries.first { it.plan == plan && it.interval == interval }
    }
}

/** A subscription joined with whatever Play told us about it. */
data class SubscriptionOffer(
    val product: SubscriptionProduct,
    /** Play's localized formatted price, or null before the query resolves. */
    val formattedPrice: String? = null,
    /** Required to buy; null means this product isn't purchasable right now. */
    val offerToken: String? = null,
) {
    val priceLabel: String get() = formattedPrice ?: product.fallbackPriceLabel

    /**
     * Play only sells a subscription through an offer. Without a token the row
     * is a price tag with no button behind it, and the paywall must say so
     * rather than open a dialog that dies.
     */
    val purchasable: Boolean get() = !offerToken.isNullOrBlank()
}
