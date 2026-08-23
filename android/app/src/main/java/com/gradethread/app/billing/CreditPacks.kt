package com.gradethread.app.billing

/**
 * US-1338: the consumable credit packs, keyed by their PLAY CONSOLE product id.
 *
 * These ids must match `ANDROID_CATALOG` in the edge's
 * `lib/google-play/products.ts` exactly. The server classifies a purchase from
 * the reported product id alone and FAILS CLOSED on an unknown one, so a typo
 * here is not a display bug — it is a purchase the buyer completes and is never
 * credited for. Pinned by a test against the same table.
 *
 * [credits] is shown, never trusted: the grant comes from the server's own
 * mapping after it verifies the token with Google.
 */
/**
 * Which purchase funnel a top-up belongs to.
 *
 * Named rather than spelled inline at each call site: the funnel is compared
 * ACROSS surfaces, so a typo would not fail anything — it would quietly open
 * a fourth funnel that nobody is charting.
 */
object TopUpSurface {
    const val SINGLE = "single"
    const val BULK = "bulk"

    /** US-2830: the consumer photo-grade flow. */
    const val CONSUMER = "consumer"
}

enum class CreditPack(val productId: String, val credits: Int, val fallbackPriceCents: Int) {
    PACK_10("credits_10", 10, 2499),
    PACK_25("credits_25", 25, 5999),
    PACK_50("credits_50", 50, 10999),
    PACK_100("credits_100", 100, 19999),
    ;

    /**
     * Shown only until Play returns the real localized price. The fallback
     * mirrors `CREDIT_PACKS` in grade-pricing.ts, but Play's formatted price is
     * authoritative — it carries the buyer's currency and any regional pricing,
     * and quoting USD to someone who will be charged euros is a broken promise.
     */
    val fallbackPriceLabel: String
        get() = "$" + "%,.2f".format(java.util.Locale.US, fallbackPriceCents / 100.0)

    val label: String get() = "$credits credits"

    companion object {
        val productIds: List<String> = entries.map { it.productId }

        fun fromProductId(productId: String?): CreditPack? = entries.firstOrNull { it.productId == productId }
    }
}

/** A pack joined with whatever Play told us about it. */
data class CreditPackOffer(
    val pack: CreditPack,
    /** Play's localized formatted price, or null before the query resolves. */
    val formattedPrice: String? = null,
) {
    val priceLabel: String get() = formattedPrice ?: pack.fallbackPriceLabel
}
