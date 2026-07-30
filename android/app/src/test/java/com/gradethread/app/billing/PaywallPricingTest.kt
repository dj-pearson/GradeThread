package com.gradethread.app.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1367: the numbers and the labels on the paywall.
 */
class PaywallPricingTest {

    private fun offers(
        purchasable: Set<SubscriptionProduct> = SubscriptionProduct.entries.toSet(),
    ) = SubscriptionProduct.entries.map { product ->
        SubscriptionOffer(
            product = product,
            formattedPrice = null,
            offerToken = if (product in purchasable) "offer-${product.productId}" else null,
        )
    }

    @Test
    fun `yearly savings are rounded to a whole percent`() {
        // $29/mo is $348 a year against a $290 yearly price.
        assertEquals(17, PaywallPricing.yearlySavingsPercent(2900, 29000))
        assertEquals(17, PaywallPricing.yearlySavingsPercent(PlanTier.STARTER))
        assertEquals(17, PaywallPricing.bestYearlySavingsPercent())
    }

    @Test
    fun `no badge when yearly isn't actually cheaper`() {
        // "Save 0%" is worse than no badge, and a negative one is a lie.
        assertNull(PaywallPricing.yearlySavingsPercent(2900, 34800))
        assertNull(PaywallPricing.yearlySavingsPercent(2900, 40000))
        assertNull(PaywallPricing.yearlySavingsPercent(0, 29000))
        assertNull(PaywallPricing.yearlySavingsPercent(2900, 0))
    }

    @Test
    fun `rows are one interval, cheapest first`() {
        val rows = PaywallPricing.rows(offers(), SubscriptionInterval.MONTHLY, null)

        assertEquals(
            listOf(PlanTier.STARTER, PlanTier.PRO, PlanTier.BUSINESS),
            rows.map { it.plan },
        )
        assertTrue(rows.all { it.interval == SubscriptionInterval.MONTHLY })
    }

    @Test
    fun `only yearly rows carry a savings badge`() {
        val monthly = PaywallPricing.rows(offers(), SubscriptionInterval.MONTHLY, null)
        val yearly = PaywallPricing.rows(offers(), SubscriptionInterval.YEARLY, null)

        assertTrue(monthly.all { it.savingsPercent == null })
        assertTrue(yearly.all { it.savingsPercent != null })
    }

    @Test
    fun `the current plan is marked and cannot be bought again`() {
        // Play will happily sell someone the plan they are already on, and the
        // charge is real.
        val rows = PaywallPricing.rows(offers(), SubscriptionInterval.YEARLY, PlanTier.PRO)
        val pro = rows.first { it.plan == PlanTier.PRO }

        assertTrue(pro.current)
        assertFalse(pro.purchasable)
        assertEquals("Your current plan", PaywallPricing.blockedReason(pro))
        assertTrue(rows.first { it.plan == PlanTier.BUSINESS }.purchasable)
    }

    @Test
    fun `a plan Play can't sell says that, not that you already have it`() {
        val rows = PaywallPricing.rows(
            offers(purchasable = setOf(SubscriptionProduct.STARTER_MONTHLY)),
            SubscriptionInterval.MONTHLY,
            null,
        )
        val business = rows.first { it.plan == PlanTier.BUSINESS }

        assertFalse(business.purchasable)
        assertEquals(
            "Not available through Google Play right now",
            PaywallPricing.blockedReason(business),
        )
        assertNull(PaywallPricing.blockedReason(rows.first { it.plan == PlanTier.STARTER }))
    }

    @Test
    fun `price lines name the billing period`() {
        val monthly = PaywallPricing.rows(offers(), SubscriptionInterval.MONTHLY, null)
            .first { it.plan == PlanTier.PRO }
        val yearly = PaywallPricing.rows(offers(), SubscriptionInterval.YEARLY, null)
            .first { it.plan == PlanTier.PRO }

        assertEquals("$59.00 / month", PaywallPricing.priceLine(monthly))
        assertEquals("$590.00 / year", PaywallPricing.priceLine(yearly))
    }

    @Test
    fun `only a yearly row restates itself as a monthly figure`() {
        val rows = PaywallPricing.rows(offers(), SubscriptionInterval.YEARLY, null)
        assertEquals(
            "About $49.16 a month",
            PaywallPricing.monthlyEquivalent(rows.first { it.plan == PlanTier.PRO }),
        )
        assertNull(
            PaywallPricing.monthlyEquivalent(
                PaywallPricing.rows(offers(), SubscriptionInterval.MONTHLY, null).first(),
            ),
        )
    }

    @Test
    fun `Play's localized price is shown, never re-derived`() {
        // The percentage comes from the reference cents; the PRICE comes from
        // Play. Parsing a percentage back out of "€54,99" in an unknown locale
        // is how a wrong number ends up in front of a buyer.
        val rows = PaywallPricing.rows(
            listOf(SubscriptionOffer(SubscriptionProduct.PRO_YEARLY, "€541,00", "t")),
            SubscriptionInterval.YEARLY,
            null,
        )

        assertEquals("€541,00 / year", PaywallPricing.priceLine(rows.first()))
        assertEquals(17, rows.first().savingsPercent)
    }
}
