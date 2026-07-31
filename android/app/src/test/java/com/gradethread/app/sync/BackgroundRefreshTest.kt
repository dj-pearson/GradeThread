package com.gradethread.app.sync

import com.gradethread.app.money.Money
import com.gradethread.app.money.MoneyFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1379: the background refresh detector.
 *
 * These rules run with nobody watching, so the tests are the only place they are
 * ever observed going right. The two failure modes worth naming: announcing a
 * back catalogue on first run (noisy enough that people disable notifications
 * for good), and missing the one sale they wanted to hear about.
 */
class BackgroundRefreshTest {

    private fun sale(id: String, item: String = "i-$id", status: String = "completed") =
        MoneyFixtures.sale(id = id, itemId = item, status = status)

    private fun graded(id: String, grade: Double? = 8.5, updatedAt: Long = 0L) =
        MoneyFixtures.item(id = id, updatedAt = updatedAt).copy(gradeValue = grade)

    // ── Baseline ─────────────────────────────────────────────────────────────

    @Test
    fun `first run with no baseline finds nothing`() {
        val findings = BackgroundRefresh.findings(
            sales = listOf(sale("s1"), sale("s2")),
            items = listOf(graded("i1")),
            seenSaleIds = emptySet(),
            seenGradedItemIds = emptySet(),
            baselineEstablished = false,
        )

        assertTrue(findings.isEmpty)
    }

    @Test
    fun `an established but empty baseline does find new rows`() {
        // The distinction the separate flag exists for: a genuinely new account
        // has an empty baseline AND has been baselined.
        val findings = BackgroundRefresh.findings(
            sales = listOf(sale("s1")),
            items = emptyList(),
            seenSaleIds = emptySet(),
            seenGradedItemIds = emptySet(),
            baselineEstablished = true,
        )

        assertEquals(listOf("s1"), findings.newSales.map { it.id })
    }

    @Test
    fun `baseline captures every sale and only graded items`() {
        val (saleIds, gradedIds) = BackgroundRefresh.baseline(
            sales = listOf(sale("s1"), sale("s2", status = "cancelled")),
            items = listOf(graded("i1"), graded("i2", grade = null)),
        )

        // Cancelled sales still enter the baseline: they are not NEWS, but
        // leaving them out would make one look new the moment it un-cancels.
        assertEquals(setOf("s1", "s2"), saleIds)
        assertEquals(setOf("i1"), gradedIds)
    }

    @Test
    fun `a baseline round-trips to no findings`() {
        val sales = listOf(sale("s1"), sale("s2"))
        val items = listOf(graded("i1"))
        val (saleIds, gradedIds) = BackgroundRefresh.baseline(sales, items)

        val findings = BackgroundRefresh.findings(
            sales = sales,
            items = items,
            seenSaleIds = saleIds,
            seenGradedItemIds = gradedIds,
            baselineEstablished = true,
        )

        assertTrue(findings.isEmpty)
    }

    // ── Detection ────────────────────────────────────────────────────────────

    @Test
    fun `cancelled and refunded sales are not news`() {
        val findings = BackgroundRefresh.findings(
            sales = listOf(
                sale("s1"),
                sale("s2", status = "cancelled"),
                sale("s3", status = "refunded"),
                sale("s4", status = "pending"),
            ),
            items = emptyList(),
            seenSaleIds = emptySet(),
            seenGradedItemIds = emptySet(),
            baselineEstablished = true,
        )

        assertEquals(setOf("s1", "s4"), findings.newSales.map { it.id }.toSet())
    }

    @Test
    fun `an ungraded item is not a new grade`() {
        val findings = BackgroundRefresh.findings(
            sales = emptyList(),
            items = listOf(graded("i1", grade = null), graded("i2")),
            seenSaleIds = emptySet(),
            seenGradedItemIds = emptySet(),
            baselineEstablished = true,
        )

        assertEquals(listOf("i2"), findings.newlyGraded.map { it.id })
    }

    @Test
    fun `newest first`() {
        val findings = BackgroundRefresh.findings(
            sales = emptyList(),
            items = listOf(graded("old", updatedAt = 100L), graded("new", updatedAt = 900L)),
            seenSaleIds = emptySet(),
            seenGradedItemIds = emptySet(),
            baselineEstablished = true,
        )

        assertEquals(listOf("new", "old"), findings.newlyGraded.map { it.id })
    }

    // ── Notices ──────────────────────────────────────────────────────────────

    @Test
    fun `nothing new posts nothing`() {
        assertTrue(
            BackgroundRefresh.notices(
                BackgroundRefresh.Findings(emptyList(), emptyList()),
            ).isEmpty(),
        )
    }

    @Test
    fun `a sale notice names the price and deep-links to the item`() {
        val notices = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(
                newSales = listOf(
                    sale("s1", item = "item-9").copy(salePrice = 42.0, buyerUsername = "flipfan"),
                ),
                newlyGraded = emptyList(),
            ),
        )

        val notice = notices.single()
        assertEquals("sale-s1", notice.id)
        assertEquals("You made a sale", notice.title)
        // Built through Money.format rather than hardcoded, so a CI runner in a
        // non-US locale asserts the app's own formatting, not a US string.
        assertEquals("${Money.format(42.0)} to flipfan", notice.body)
        assertEquals("item-9", notice.itemId)
    }

    @Test
    fun `a sale with no buyer still posts`() {
        val notice = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(listOf(sale("s1").copy(salePrice = 12.5)), emptyList()),
        ).single()

        assertEquals(Money.format(12.5), notice.body)
    }

    @Test
    fun `a grade notice reads the grade at one decimal`() {
        val notice = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(
                emptyList(),
                listOf(graded("i1").copy(title = "Levi's 501", gradeLabel = "Excellent")),
            ),
        ).single()

        assertEquals("grade-i1", notice.id)
        assertEquals("Grade ready", notice.title)
        assertEquals("Levi's 501 graded 8.5 · Excellent", notice.body)
        assertEquals("i1", notice.itemId)
    }

    @Test
    fun `exactly the threshold still posts individually`() {
        val notices = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(
                newSales = listOf(sale("s1"), sale("s2")),
                newlyGraded = listOf(graded("i1")),
            ),
        )

        assertEquals(BackgroundRefresh.MAX_INDIVIDUAL, notices.size)
        assertEquals(listOf("sale-s1", "sale-s2", "grade-i1"), notices.map { it.id })
    }

    @Test
    fun `past the threshold collapses to one summary`() {
        val notices = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(
                newSales = listOf(sale("s1"), sale("s2"), sale("s3")),
                newlyGraded = listOf(graded("i1"), graded("i2")),
            ),
        )

        val notice = notices.single()
        assertEquals("background-summary", notice.id)
        assertEquals("While you were away", notice.title)
        assertEquals("3 sales and 2 grades landed.", notice.body)
        // No item to open — a summary spans several, so it lands on the app.
        assertNull(notice.itemId)
    }

    @Test
    fun `a summary of one kind names only that kind`() {
        val notice = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(
                newSales = emptyList(),
                newlyGraded = listOf(graded("i1"), graded("i2"), graded("i3"), graded("i4")),
            ),
        ).single()

        assertEquals("4 grades landed.", notice.body)
    }

    @Test
    fun `singular wording`() {
        // Reachable only alongside another kind, since one alone is under the
        // threshold — but "1 sales" would still be wrong when it happens.
        val notice = BackgroundRefresh.notices(
            BackgroundRefresh.Findings(
                newSales = listOf(sale("s1")),
                newlyGraded = listOf(graded("i1"), graded("i2"), graded("i3")),
            ),
        ).single()

        assertEquals("1 sale and 3 grades landed.", notice.body)
    }
}
