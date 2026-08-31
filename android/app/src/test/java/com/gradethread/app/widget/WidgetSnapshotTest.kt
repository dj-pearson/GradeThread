package com.gradethread.app.widget

import com.gradethread.app.money.MoneyFixtures
import com.gradethread.app.sync.db.ListingEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * US-1380: the widget's rollup, its coalescing rule, and its spoken labels.
 *
 * The Glance tree itself can't be asserted from a JVM test, which is exactly
 * why everything that can be decided outside it was pulled out. What's left in
 * the composable is layout.
 */
class WidgetSnapshotTest {

    private val zone: ZoneId = MoneyFixtures.ZONE

    private fun listing(id: String, status: String) = ListingEntity(
        id = id,
        inventoryItemId = "i-$id",
        platform = "ebay",
        platformListingId = null,
        platformOfferId = null,
        externalUrl = null,
        listingPrice = 40.0,
        listingStatus = status,
        listedAt = null,
        endedAt = null,
        viewsTotal = null,
        watchersCount = null,
        listingOrigin = null,
        publishError = null,
        createdAt = 0L,
        updatedAt = 0L,
    )

    // ── Rollup ───────────────────────────────────────────────────────────────

    @Test
    fun `signed out is not an all-zero snapshot`() {
        val snapshot = WidgetRollup.compute(
            listings = listOf(listing("l1", "active")),
            sales = listOf(MoneyFixtures.sale("s1", "i1")),
            nowMs = MoneyFixtures.ms(2026, 7, 31),
            isSignedIn = false,
            zone = zone,
        )

        assertFalse(snapshot.isSignedIn)
        // The rows are there; the snapshot deliberately reports none of them.
        assertEquals(0, snapshot.activeListings)
    }

    @Test
    fun `live listings count active and relisted, any casing`() {
        val snapshot = WidgetRollup.compute(
            listings = listOf(
                listing("l1", "active"),
                listing("l2", "ACTIVE"),
                listing("l3", "relisted"),
                listing("l4", "ended"),
                listing("l5", "draft"),
            ),
            sales = emptyList(),
            nowMs = MoneyFixtures.ms(2026, 7, 31),
            isSignedIn = true,
            zone = zone,
        )

        assertEquals(3, snapshot.activeListings)
    }

    @Test
    fun `sold today buckets by the local day, not UTC`() {
        val now = MoneyFixtures.ms(2026, 7, 31, hour = 2)
        val startOfToday = MoneyFixtures.dayMs(LocalDate.of(2026, 7, 31))
        val snapshot = WidgetRollup.compute(
            listings = emptyList(),
            sales = listOf(
                MoneyFixtures.sale("today", "i1", salePrice = 20.0, saleDate = startOfToday),
                MoneyFixtures.sale("also", "i2", salePrice = 30.0, saleDate = now - 60_000),
                // 2am local on the 31st is still the 31st in Chicago and the
                // 31st in UTC — this one is yesterday either way.
                MoneyFixtures.sale("yday", "i3", salePrice = 99.0, saleDate = startOfToday - 1),
            ),
            nowMs = now,
            isSignedIn = true,
            zone = zone,
        )

        assertEquals(2, snapshot.soldTodayCount)
        assertEquals(50.0, snapshot.soldTodayGross, 0.001)
    }

    @Test
    fun `cancelled sales count for nothing`() {
        val now = MoneyFixtures.ms(2026, 7, 31)
        val snapshot = WidgetRollup.compute(
            listings = emptyList(),
            sales = listOf(
                MoneyFixtures.sale("ok", "i1", salePrice = 10.0, saleDate = now),
                MoneyFixtures.sale("no", "i2", salePrice = 900.0, saleDate = now, status = "cancelled"),
                MoneyFixtures.sale("nope", "i3", salePrice = 900.0, saleDate = now, status = "refunded"),
            ),
            nowMs = now,
            isSignedIn = true,
            zone = zone,
        )

        assertEquals(1, snapshot.soldTodayCount)
        assertEquals(10.0, snapshot.soldTodayGross, 0.001)
        assertEquals(1, snapshot.pendingPayoutCount)
    }

    @Test
    fun `pending payout is everything without a payout reference, netted`() {
        val now = MoneyFixtures.ms(2026, 7, 31)
        val snapshot = WidgetRollup.compute(
            listings = emptyList(),
            sales = listOf(
                MoneyFixtures.sale("a", "i1", salePrice = 100.0, platformFees = 13.0, saleDate = now),
                MoneyFixtures.sale("b", "i2", salePrice = 50.0, platformFees = 6.5, saleDate = now),
                MoneyFixtures.sale(
                    "paid",
                    "i3",
                    salePrice = 400.0,
                    platformFees = 0.0,
                    saleDate = now,
                    payoutReference = "PAYOUT-1",
                ),
            ),
            nowMs = now,
            isSignedIn = true,
            zone = zone,
        )

        assertEquals(2, snapshot.pendingPayoutCount)
        assertEquals(130.5, snapshot.pendingPayoutNet, 0.001)
    }

    @Test
    fun `a fee larger than the sale price floors at zero, not below`() {
        // Bad data, not a payout the seller owes back. Letting it go negative
        // would silently reduce the total of every other pending sale.
        val now = MoneyFixtures.ms(2026, 7, 31)
        val snapshot = WidgetRollup.compute(
            listings = emptyList(),
            sales = listOf(
                MoneyFixtures.sale("bad", "i1", salePrice = 10.0, platformFees = 40.0, saleDate = now),
                MoneyFixtures.sale("ok", "i2", salePrice = 100.0, platformFees = 10.0, saleDate = now),
            ),
            nowMs = now,
            isSignedIn = true,
            zone = zone,
        )

        assertEquals(90.0, snapshot.pendingPayoutNet, 0.001)
    }

    @Test
    fun `an empty blank payout reference still counts as pending`() {
        val now = MoneyFixtures.ms(2026, 7, 31)
        val snapshot = WidgetRollup.compute(
            listings = emptyList(),
            sales = listOf(
                MoneyFixtures.sale(
                    "a",
                    "i1",
                    salePrice = 20.0,
                    saleDate = now,
                    payoutReference = "   ",
                ),
            ),
            nowMs = now,
            isSignedIn = true,
            zone = zone,
        )

        assertEquals(1, snapshot.pendingPayoutCount)
    }

    // ── Change detection + coalescing ────────────────────────────────────────

    @Test
    fun `hasSameRollup ignores the timestamp`() {
        val a = WidgetSnapshot.PLACEHOLDER.copy(generatedAt = 1_000L)
        val b = WidgetSnapshot.PLACEHOLDER.copy(generatedAt = 9_999_999L)

        assertTrue(a.hasSameRollup(b))
        assertFalse(a.hasSameRollup(b.copy(soldTodayCount = 4)))
    }

    @Test
    fun `unchanged numbers publish nothing at all`() {
        val snapshot = WidgetSnapshot.PLACEHOLDER
        assertEquals(
            WidgetPublisher.Action.SKIP,
            WidgetPublisher.decide(
                previous = snapshot.copy(generatedAt = 1L),
                next = snapshot.copy(generatedAt = 500_000L),
                lastReloadAtMs = 0L,
                nowMs = 500_000L,
            ),
        )
    }

    @Test
    fun `the first publish always redraws`() {
        assertEquals(
            WidgetPublisher.Action.WRITE_AND_RELOAD,
            WidgetPublisher.decide(
                previous = null,
                next = WidgetSnapshot.PLACEHOLDER,
                lastReloadAtMs = 0L,
                nowMs = 1_000L,
            ),
        )
    }

    @Test
    fun `a change inside the window is stored but held`() {
        val action = WidgetPublisher.decide(
            previous = WidgetSnapshot.PLACEHOLDER,
            next = WidgetSnapshot.PLACEHOLDER.copy(soldTodayCount = 9),
            lastReloadAtMs = 100_000L,
            nowMs = 110_000L,
        )

        assertEquals(WidgetPublisher.Action.WRITE_ONLY, action)
        // And the held change gets a catch-up redraw for the rest of the
        // window, rather than waiting for the next sync.
        assertEquals(20_000L, WidgetPublisher.catchUpDelayMs(100_000L, 110_000L))
    }

    @Test
    fun `a change past the window redraws`() {
        assertEquals(
            WidgetPublisher.Action.WRITE_AND_RELOAD,
            WidgetPublisher.decide(
                previous = WidgetSnapshot.PLACEHOLDER,
                next = WidgetSnapshot.PLACEHOLDER.copy(soldTodayCount = 9),
                lastReloadAtMs = 100_000L,
                nowMs = 100_000L + WidgetPublisher.MIN_RELOAD_INTERVAL_MS,
            ),
        )
    }

    @Test
    fun `a clock that jumped backwards does not hold the redraw forever`() {
        assertEquals(
            WidgetPublisher.Action.WRITE_AND_RELOAD,
            WidgetPublisher.decide(
                previous = WidgetSnapshot.PLACEHOLDER,
                next = WidgetSnapshot.PLACEHOLDER.copy(soldTodayCount = 9),
                lastReloadAtMs = 900_000L,
                nowMs = 100_000L,
            ),
        )
    }

    // The copy cases moved to WidgetCopyTest, which needs a Context now that
    // the labels come from resources (US-2976). Everything above this line is
    // the rollup, which is still pure.

    @Test
    fun `widget links match the scheme the manifest claims`() {
        assertEquals("com.gradethread.app://widget/marketplaces", WidgetDeepLink.MARKETPLACES.uri)
        assertEquals("com.gradethread.app://widget/money", WidgetDeepLink.MONEY.uri)
    }
}
