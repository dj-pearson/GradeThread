package com.gradethread.app.analytics

import com.gradethread.app.money.MoneyFixtures
import com.gradethread.app.sync.db.InventoryItemEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1368: the analytics math. Every figure here is one a seller makes a
 * sourcing or pricing decision on, so the tests care most about what happens
 * when the data is thin or awkward.
 */
class AnalyticsRollupTest {

    private val now = MoneyFixtures.ms(2026, 7, 1)
    private fun daysAgo(days: Int) = now - days * AnalyticsRange.DAY_MS

    private fun item(
        id: String,
        brand: String? = null,
        status: String = "cataloged",
        acquiredPrice: Double? = null,
        listingPrice: Double? = null,
        grade: Double? = null,
        gradeLabel: String? = null,
    ): InventoryItemEntity = MoneyFixtures.item(
        id = id,
        status = status,
        acquiredPrice = acquiredPrice,
        listingPrice = listingPrice,
    ).copy(brand = brand, gradeValue = grade, gradeLabel = gradeLabel)

    // ── Ranges ───────────────────────────────────────────────────────────────

    @Test
    fun `all time has no lower bound`() {
        assertNull(AnalyticsRange.All.startMs(now))
        assertEquals(now - 30 * AnalyticsRange.DAY_MS, AnalyticsRange.Days(30).startMs(now))
    }

    @Test
    fun `a custom range is clamped to something answerable`() {
        assertEquals(AnalyticsRange.Days(1), AnalyticsRange.custom(0))
        assertEquals(AnalyticsRange.Days(1), AnalyticsRange.custom(-5))
        assertEquals(AnalyticsRange.Days(3650), AnalyticsRange.custom(99999))
        assertEquals("45 days", AnalyticsRange.custom(45).label)
    }

    // ── Grading ──────────────────────────────────────────────────────────────

    @Test
    fun `the distribution total reconciles with the graded count`() {
        // The chart and the header above it are derived from the same
        // predicate, so a graded item with no tier label lands in "Other"
        // rather than silently vanishing from the chart.
        val items = listOf(
            item("a", grade = 9.0, gradeLabel = "Excellent"),
            item("b", grade = 9.5, gradeLabel = "Excellent"),
            item("c", grade = 6.0, gradeLabel = null),
            item("d"),
        )

        assertEquals(3, AnalyticsRollup.gradedCount(items))
        assertEquals(3, AnalyticsRollup.gradeDistribution(items).sumOf { it.count })
        assertEquals(
            listOf("Excellent" to 2, "Other" to 1),
            AnalyticsRollup.gradeDistribution(items).map { it.tier to it.count },
        )
    }

    @Test
    fun `average grade rounds to one decimal and is null with nothing graded`() {
        assertEquals(
            8.2,
            AnalyticsRollup.averageGrade(
                listOf(item("a", grade = 8.0), item("b", grade = 8.5), item("c", grade = 8.0)),
            )!!,
            0.001,
        )
        assertNull(AnalyticsRollup.averageGrade(listOf(item("a"))))
    }

    // ── Brand profit ─────────────────────────────────────────────────────────

    @Test
    fun `top brands net out fees and cost basis`() {
        val items = listOf(
            item("i1", brand = "Patagonia", acquiredPrice = 20.0),
            item("i2", brand = "Patagonia", acquiredPrice = 10.0),
            item("i3", brand = "Carhartt", acquiredPrice = 5.0),
        )
        val sales = listOf(
            MoneyFixtures.sale("s1", "i1", salePrice = 100.0, platformFees = 10.0, saleDate = daysAgo(5)),
            MoneyFixtures.sale("s2", "i2", salePrice = 50.0, platformFees = 5.0, saleDate = daysAgo(5)),
            MoneyFixtures.sale("s3", "i3", salePrice = 40.0, platformFees = 4.0, saleDate = daysAgo(5)),
        )

        val brands = AnalyticsRollup.topBrandsByProfit(items, sales, daysAgo(30))

        assertEquals("Patagonia", brands[0].brand)
        assertEquals(105.0, brands[0].netProfit, 0.001) // (100-10-20) + (50-5-10)
        assertEquals(2, brands[0].unitsSold)
        assertEquals(31.0, brands[1].netProfit, 0.001)
    }

    @Test
    fun `an item with no brand is grouped, not dropped`() {
        val items = listOf(item("i1", brand = null, acquiredPrice = 5.0))
        val sales = listOf(MoneyFixtures.sale("s1", "i1", salePrice = 30.0, saleDate = daysAgo(2)))

        val brands = AnalyticsRollup.topBrandsByProfit(items, sales, null)
        assertEquals("Unknown", brands.single().brand)
    }

    @Test
    fun `sales outside the window and reversed orders are excluded`() {
        val items = listOf(item("i1", brand = "A", acquiredPrice = 0.0))
        val sales = listOf(
            MoneyFixtures.sale("in", "i1", salePrice = 100.0, saleDate = daysAgo(5)),
            MoneyFixtures.sale("old", "i1", salePrice = 900.0, saleDate = daysAgo(200)),
            MoneyFixtures.sale(
                "refunded",
                "i1",
                salePrice = 500.0,
                status = "refunded",
                saleDate = daysAgo(5),
            ),
        )

        val brands = AnalyticsRollup.topBrandsByProfit(items, sales, daysAgo(30))
        assertEquals(1, brands.single().unitsSold)
        assertEquals(100.0, brands.single().netProfit, 0.001)
    }

    // ── Sell-through ─────────────────────────────────────────────────────────

    @Test
    fun `sell-through counts only items that reached the market`() {
        // A seller who just sourced fifty pieces must not look like their brands
        // stopped selling.
        val items = listOf(
            item("a", brand = "Nike", status = "listed"),
            item("b", brand = "Nike", status = "sold"),
            item("c", brand = "Nike", status = "cataloged"),
            item("d", brand = "Nike", status = "sourced"),
        )

        val row = AnalyticsRollup.sellThroughByBrand(items).single()
        assertEquals(2, row.listed)
        assertEquals(1, row.sold)
        assertEquals(0.5, row.rate, 0.001)
    }

    @Test
    fun `a brand with nothing on the market has no rate to divide by`() {
        val items = listOf(item("a", brand = "Nike", status = "cataloged"))
        assertTrue(AnalyticsRollup.sellThroughByBrand(items).isEmpty())
        assertNull(AnalyticsRollup.overallSellThroughRate(items))
    }

    // ── Period P&L ───────────────────────────────────────────────────────────

    @Test
    fun `the period P and L foots to the same net as the per-sale math`() {
        // grossProfit must equal the sum of SalePnL.net, or the header
        // disagrees with the rows under it.
        val items = listOf(
            item("i1", acquiredPrice = 20.0),
            item("i2", acquiredPrice = 8.0),
        )
        val sales = listOf(
            MoneyFixtures.sale(
                "s1", "i1",
                salePrice = 100.0, platformFees = 10.0, paymentProcessingFees = 3.0,
                shippingCollected = 8.0, shippingCost = 6.0, saleDate = daysAgo(3),
            ),
            MoneyFixtures.sale(
                "s2", "i2",
                salePrice = 45.0, platformFees = 4.5, gradingCost = 2.0, saleDate = daysAgo(3),
            ),
        )

        val pnl = AnalyticsRollup.periodPnL(items, sales, daysAgo(30))

        assertEquals(2, pnl.unitsSold)
        assertEquals(153.0, pnl.grossRevenue, 0.001)
        assertEquals(17.5, pnl.fees, 0.001)
        assertEquals(36.0, pnl.cogs, 0.001)
        assertEquals(99.5, pnl.grossProfit, 0.001)
    }

    @Test
    fun `an empty period is zero, not a crash`() {
        val pnl = AnalyticsRollup.periodPnL(emptyList(), emptyList(), daysAgo(30))
        assertEquals(PeriodPnL.EMPTY, pnl)
    }

    // ── Grading ROI ──────────────────────────────────────────────────────────

    @Test
    fun `a thin comparison is marked unmeaningful rather than reported`() {
        // "+$40 from grading" built on one sale is how someone talks themselves
        // into a spending decision on noise.
        val items = listOf(
            item("g1", acquiredPrice = 0.0, grade = 9.0),
            item("u1", acquiredPrice = 0.0),
        )
        val sales = listOf(
            MoneyFixtures.sale("s1", "g1", salePrice = 100.0, saleDate = daysAgo(1)),
            MoneyFixtures.sale("s2", "u1", salePrice = 60.0, saleDate = daysAgo(1)),
        )

        val bucket = AnalyticsRollup.gradingRoiBuckets(items, sales, null).single()
        assertFalse(bucket.meaningful)
        assertEquals(40.0, bucket.netProfitLift!!, 0.001)
        assertNull(AnalyticsRollup.headlineRoiLift(listOf(bucket)))
    }

    @Test
    fun `a full comparison reports the lift`() {
        val items = (1..3).map { item("g$it", acquiredPrice = 0.0, grade = 9.0) } +
            (1..3).map { item("u$it", acquiredPrice = 0.0) }
        val sales = (1..3).map {
            MoneyFixtures.sale("sg$it", "g$it", salePrice = 100.0, saleDate = daysAgo(1))
        } + (1..3).map {
            MoneyFixtures.sale("su$it", "u$it", salePrice = 70.0, saleDate = daysAgo(1))
        }

        val bucket = AnalyticsRollup.gradingRoiBuckets(items, sales, null).single()
        assertTrue(bucket.meaningful)
        assertEquals(30.0, AnalyticsRollup.headlineRoiLift(listOf(bucket))!!, 0.001)
    }

    @Test
    fun `a band with no sales is omitted, not drawn at zero`() {
        // A bar at zero says "graded items made nothing", which is a different
        // claim from "nothing sold in this band".
        val items = listOf(item("i1", acquiredPrice = 0.0, grade = 9.0))
        val sales = listOf(MoneyFixtures.sale("s1", "i1", salePrice = 20.0, saleDate = daysAgo(1)))

        val buckets = AnalyticsRollup.gradingRoiBuckets(items, sales, null)
        assertEquals(1, buckets.size)
        assertTrue(buckets.single().band.startsWith("Under"))
        assertNull(buckets.single().ungradedAvgNet)
        assertNull(buckets.single().netProfitLift)
    }

    @Test
    fun `sale prices land in the band they belong to`() {
        val items = listOf(
            item("a", acquiredPrice = 0.0),
            item("b", acquiredPrice = 0.0),
            item("c", acquiredPrice = 0.0),
        )
        val sales = listOf(
            MoneyFixtures.sale("s1", "a", salePrice = 49.99, saleDate = daysAgo(1)),
            MoneyFixtures.sale("s2", "b", salePrice = 50.0, saleDate = daysAgo(1)),
            MoneyFixtures.sale("s3", "c", salePrice = 150.0, saleDate = daysAgo(1)),
        )

        val bands = AnalyticsRollup.gradingRoiBuckets(items, sales, null)
        assertEquals(3, bands.size)
        assertTrue(bands.all { it.ungradedCount == 1 })
    }

    // ── Inventory value ──────────────────────────────────────────────────────

    @Test
    fun `inventory value uses the market-value fallback chain`() {
        // Listing price, then target, then what it cost — the same chain the
        // Home tab uses, so the two screens can't disagree.
        val items = listOf(
            item("a", status = "listed", listingPrice = 80.0, acquiredPrice = 10.0),
            item("b", status = "listed", acquiredPrice = 12.0),
            item("c", status = "sold", listingPrice = 500.0),
        )

        val rows = AnalyticsRollup.inventoryValueByStatus(items)
        assertEquals(1, rows.size)
        assertEquals("listed", rows.single().status)
        assertEquals(92.0, rows.single().value, 0.001)
        assertEquals(2, rows.single().count)
    }
}
