package com.gradethread.app.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1366: the product ids are a contract with the Play Console and with the
 * server, and nothing in the build checks them. This does.
 */
class SubscriptionCatalogTest {

    @Test
    fun `product ids match the server catalog exactly`() {
        // Pinned against ANDROID_CATALOG in lib/google-play/products.ts. The
        // server classifies a purchase from the reported product id alone and
        // fails closed on an unknown one, so a typo here is not a display bug -
        // it is a subscription the buyer pays for and is never entitled to.
        assertEquals(
            listOf(
                "flipdesk_starter_monthly",
                "flipdesk_starter_yearly",
                "flipdesk_pro_monthly",
                "flipdesk_pro_yearly",
                "flipdesk_business_monthly",
                "flipdesk_business_yearly",
            ),
            SubscriptionProduct.productIds,
        )
    }

    @Test
    fun `plan slugs match the server plan keys`() {
        // These land in users.flipdesk_plan. A mismatch would gate features the
        // buyer paid for.
        assertEquals(listOf("starter", "pro", "business"), PlanTier.entries.map { it.slug })
        assertEquals(listOf("monthly", "yearly"), SubscriptionInterval.entries.map { it.slug })
    }

    @Test
    fun `every plan and interval combination has exactly one product`() {
        for (plan in PlanTier.entries) {
            for (interval in SubscriptionInterval.entries) {
                val matches = SubscriptionProduct.entries
                    .filter { it.plan == plan && it.interval == interval }
                assertEquals("$plan/$interval", 1, matches.size)
            }
        }
    }

    @Test
    fun `fallback prices mirror the web plan matrix`() {
        // FLIPDESK_PLANS in src/lib/constants.ts. Shown only until Play answers,
        // but a wrong number here is a wrong number in front of a buyer.
        assertEquals(2900, SubscriptionProduct.STARTER_MONTHLY.fallbackPriceCents)
        assertEquals(29000, SubscriptionProduct.STARTER_YEARLY.fallbackPriceCents)
        assertEquals(5900, SubscriptionProduct.PRO_MONTHLY.fallbackPriceCents)
        assertEquals(59000, SubscriptionProduct.PRO_YEARLY.fallbackPriceCents)
        assertEquals(9900, SubscriptionProduct.BUSINESS_MONTHLY.fallbackPriceCents)
        assertEquals(99000, SubscriptionProduct.BUSINESS_YEARLY.fallbackPriceCents)
        assertEquals("$29.00", SubscriptionProduct.STARTER_MONTHLY.fallbackPriceLabel)
    }

    @Test
    fun `an unknown product id resolves to nothing`() {
        assertNull(SubscriptionProduct.fromProductId("flipdesk_pro"))
        assertNull(SubscriptionProduct.fromProductId(null))
        assertNull(PlanTier.fromSlug("enterprise"))
    }

    @Test
    fun `plan slugs are matched case-insensitively`() {
        // The slug arrives from a JSON column, not from our own enum.
        assertEquals(PlanTier.PRO, PlanTier.fromSlug("Pro"))
    }

    @Test
    fun `an offer without a token is not purchasable`() {
        // Play sells a subscription only through an offer. A row with no token
        // is a price tag with no button behind it, and pretending otherwise
        // opens a dialog that dies in front of the buyer.
        val offer = SubscriptionOffer(SubscriptionProduct.PRO_MONTHLY, "$59.00", null)
        assertFalse(offer.purchasable)
        assertEquals("$59.00", offer.priceLabel)

        val real = SubscriptionOffer(SubscriptionProduct.PRO_MONTHLY, "$59.00", "offer-token")
        assertTrue(real.purchasable)
    }

    @Test
    fun `the fallback price shows until Play answers`() {
        val offer = SubscriptionOffer(SubscriptionProduct.BUSINESS_YEARLY)
        assertEquals("$990.00", offer.priceLabel)
    }

    @Test
    fun `credit pack ids and subscription ids never overlap`() {
        // Settlement is chosen from the id alone. An id in both catalogs would
        // make that choice ambiguous, and one of the two answers cancels a
        // subscription.
        val overlap = CreditPack.productIds.intersect(SubscriptionProduct.productIds.toSet())
        assertTrue(overlap.toString(), overlap.isEmpty())
    }
}
