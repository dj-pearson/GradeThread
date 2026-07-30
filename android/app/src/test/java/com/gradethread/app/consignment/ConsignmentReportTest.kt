package com.gradethread.app.consignment

import com.gradethread.app.money.MoneyFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1372: money owed to somebody else. The tests care about the cases where
 * being off by a cent, or paying out on a sale that reversed, is a real problem
 * between two people.
 */
class ConsignmentReportTest {

    private fun consignor(
        id: String = "c1",
        name: String = "Ada",
        split: Double = 50.0,
    ) = Consignor(id = id, name = name, defaultSplitPct = split)

    private fun sold(
        consignorId: String = "c1",
        override: Double? = null,
        salePrice: Double = 100.0,
        fees: Double = 10.0,
    ) = ConsignmentReport.SoldConsignedItem(consignorId, override, salePrice, fees)

    // ── The split ────────────────────────────────────────────────────────────

    @Test
    fun `the consignor gets their share of what is left after fees`() {
        val row = ConsignmentReport.compute(listOf(sold()), listOf(consignor())).single()

        assertEquals(1, row.itemsSold)
        assertEquals(100.0, row.grossRevenue, 0.001)
        assertEquals(10.0, row.fees, 0.001)
        assertEquals(90.0, row.netProceeds, 0.001)
        assertEquals(45.0, row.consignorPayout, 0.001)
        assertEquals(45.0, row.yourCut, 0.001)
    }

    @Test
    fun `a per-item split overrides the consignor's default`() {
        val row = ConsignmentReport.compute(
            listOf(sold(override = 70.0)),
            listOf(consignor(split = 50.0)),
        ).single()

        assertEquals(63.0, row.consignorPayout, 0.001)
        assertEquals(27.0, row.yourCut, 0.001)
    }

    @Test
    fun `an out-of-range split is clamped, never applied as typed`() {
        // A 150% split would pay out more than the sale brought in.
        val over = ConsignmentReport.compute(
            listOf(sold(override = 150.0)),
            listOf(consignor()),
        ).single()
        assertEquals(90.0, over.consignorPayout, 0.001)
        assertEquals(0.0, over.yourCut, 0.001)

        val under = ConsignmentReport.compute(
            listOf(sold(override = -20.0)),
            listOf(consignor()),
        ).single()
        assertEquals(0.0, under.consignorPayout, 0.001)
    }

    @Test
    fun `a zero split is honoured and is not read as no override`() {
        // 0 and null mean different things: "they get nothing on this one"
        // versus "use their usual cut".
        val row = ConsignmentReport.compute(
            listOf(sold(override = 0.0)),
            listOf(consignor(split = 50.0)),
        ).single()

        assertEquals(0.0, row.consignorPayout, 0.001)
        assertEquals(90.0, row.yourCut, 0.001)
    }

    @Test
    fun `a sale that lost money pays out nothing rather than a negative`() {
        // A refund-heavy line must not quietly reduce what another sale earned.
        val rows = ConsignmentReport.compute(
            listOf(sold(salePrice = 20.0, fees = 30.0), sold(salePrice = 100.0, fees = 10.0)),
            listOf(consignor()),
        )

        assertEquals(45.0, rows.single().consignorPayout, 0.001)
    }

    @Test
    fun `each line is rounded to whole cents`() {
        // $10.05 at 33.33% must not carry a fractional cent into a payable.
        val row = ConsignmentReport.compute(
            listOf(sold(salePrice = 10.05, fees = 0.0, override = 33.33)),
            listOf(consignor()),
        ).single()

        assertEquals(3.35, row.consignorPayout, 0.0001)
        assertEquals(6.70, row.yourCut, 0.0001)
        assertEquals(row.netProceeds, row.consignorPayout + row.yourCut, 0.0001)
    }

    @Test
    fun `the totals foot against the lines they came from`() {
        val rows = ConsignmentReport.compute(
            List(7) { sold(salePrice = 24.99, fees = 3.33, override = 33.33) },
            listOf(consignor()),
        )
        val row = rows.single()

        assertEquals(row.netProceeds, row.consignorPayout + row.yourCut, 0.0001)
        assertEquals(row.consignorPayout, ConsignmentReport.totalOwed(rows), 0.0001)
        assertEquals(row.yourCut, ConsignmentReport.totalYourCut(rows), 0.0001)
    }

    // ── Who is included ──────────────────────────────────────────────────────

    @Test
    fun `an item pointing at a consignor we don't have is skipped`() {
        // A payout row labelled "Unknown" is not something anyone can act on.
        val rows = ConsignmentReport.compute(
            listOf(sold(consignorId = "ghost")),
            listOf(consignor(id = "c1")),
        )
        assertTrue(rows.isEmpty())
    }

    @Test
    fun `rows are ordered by who is owed the most`() {
        val rows = ConsignmentReport.compute(
            listOf(
                sold(consignorId = "small", salePrice = 20.0, fees = 0.0),
                sold(consignorId = "big", salePrice = 500.0, fees = 0.0),
            ),
            listOf(consignor(id = "small", name = "Small"), consignor(id = "big", name = "Big")),
        )
        assertEquals(listOf("Big", "Small"), rows.map { it.consignorName })
    }

    // ── Joining against the local cache ──────────────────────────────────────

    @Test
    fun `cancelled and refunded sales never generate a payout`() {
        // The reseller never collected that money; owing a cut of it would be
        // paying out of pocket.
        val items = listOf(
            MoneyFixtures.item("i1").copy(consignorId = "c1"),
            MoneyFixtures.item("i2").copy(consignorId = "c1"),
        )
        val sales = listOf(
            MoneyFixtures.sale("s1", "i1", salePrice = 100.0, platformFees = 10.0),
            MoneyFixtures.sale("s2", "i2", salePrice = 500.0, status = "refunded"),
        )

        val row = ConsignmentReport.compute(items, sales, listOf(consignor())).single()
        assertEquals(1, row.itemsSold)
        assertEquals(45.0, row.consignorPayout, 0.001)
    }

    @Test
    fun `an item with no consignor is not part of the report`() {
        val items = listOf(MoneyFixtures.item("i1"))
        val sales = listOf(MoneyFixtures.sale("s1", "i1", salePrice = 100.0))

        assertTrue(ConsignmentReport.compute(items, sales, listOf(consignor())).isEmpty())
    }

    @Test
    fun `fees include payment processing, not just the platform cut`() {
        // Leaving processing fees out would overstate net proceeds and overpay
        // the consignor.
        val items = listOf(MoneyFixtures.item("i1").copy(consignorId = "c1"))
        val sales = listOf(
            MoneyFixtures.sale(
                "s1", "i1",
                salePrice = 100.0, platformFees = 10.0, paymentProcessingFees = 3.0,
            ),
        )

        val row = ConsignmentReport.compute(items, sales, listOf(consignor())).single()
        assertEquals(13.0, row.fees, 0.001)
        assertEquals(43.5, row.consignorPayout, 0.001)
    }

    @Test
    fun `the item's cost basis is deliberately not subtracted`() {
        // Consignment items are taken in at zero cost. Subtracting a cost the
        // reseller never paid would shrink somebody else's payment.
        val items = listOf(
            MoneyFixtures.item("i1", acquiredPrice = 40.0).copy(consignorId = "c1"),
        )
        val sales = listOf(MoneyFixtures.sale("s1", "i1", salePrice = 100.0, platformFees = 10.0))

        assertEquals(
            45.0,
            ConsignmentReport.compute(items, sales, listOf(consignor())).single().consignorPayout,
            0.001,
        )
    }

    // ── Empty states ─────────────────────────────────────────────────────────

    @Test
    fun `the empty message says which of the three situations you are in`() {
        assertTrue(ConsignmentReport.emptyMessage(0, 0).contains("Add a consignor"))
        assertTrue(ConsignmentReport.emptyMessage(2, 0).contains("No items are assigned"))
        // Assigned but unsold is not a problem and needs no action.
        assertTrue(ConsignmentReport.emptyMessage(2, 3).contains("waiting to sell"))
        assertTrue(ConsignmentReport.emptyMessage(2, 1).contains("item is"))
    }

    @Test
    fun `unsold consigned items are counted, sold ones are not`() {
        val items = listOf(
            MoneyFixtures.item("i1").copy(consignorId = "c1"),
            MoneyFixtures.item("i2").copy(consignorId = "c1"),
            MoneyFixtures.item("i3"),
        )
        val sales = listOf(MoneyFixtures.sale("s1", "i1"))

        assertEquals(1, ConsignmentReport.unsoldConsignedCount(items, sales))
    }

    // ── Draft validation ─────────────────────────────────────────────────────

    @Test
    fun `a nameless consignor cannot be saved`() {
        val draft = ConsignorDraft(name = "   ")
        assertFalse(draft.isValid)
        assertTrue(draft.validationMessage!!.contains("name"))
    }

    @Test
    fun `an unparseable split blocks the save instead of becoming the default`() {
        // The number here decides what a third party gets paid. Silently
        // treating "half" as 50 is not a favour.
        val draft = ConsignorDraft(name = "Ada", splitText = "half")
        assertFalse(draft.isValid)
        assertNull(draft.splitPct)
        assertTrue(draft.validationMessage!!.contains("number"))
    }

    @Test
    fun `a split outside 0 to 100 is rejected with a reason`() {
        val draft = ConsignorDraft(name = "Ada", splitText = "120")
        assertFalse(draft.isValid)
        assertTrue(draft.validationMessage!!.contains("between 0 and 100"))
        assertTrue(ConsignorDraft(name = "Ada", splitText = "0").isValid)
        assertTrue(ConsignorDraft(name = "Ada", splitText = "100").isValid)
    }

    @Test
    fun `percentages read as people write them`() {
        assertEquals("50", ConsignorDraft.formatPct(50.0))
        assertEquals("33.5", ConsignorDraft.formatPct(33.5))
    }

    @Test
    fun `a draft round-trips from an existing consignor`() {
        val draft = ConsignorDraft.of(
            Consignor("c1", "Ada", "a@example.com", null, 60.0, "Vintage denim"),
        )
        assertEquals("Ada", draft.name)
        assertEquals("60", draft.splitText)
        assertEquals("a@example.com", draft.contactEmail)
        assertEquals("", draft.contactPhone)
        assertTrue(draft.isValid)
    }

    // ── The split hint on the item canvas ────────────────────────────────────

    @Test
    fun `a blank override says the default applies, not that there is no split`() {
        // A blank field looks like "no split", which is how someone thinks they
        // keep everything.
        val hint = splitHint(consignor(name = "Ada", split = 60.0), "")
        assertTrue(hint.contains("default"))
        assertTrue(hint.contains("60%"))
    }

    @Test
    fun `an override says what it replaces`() {
        val hint = splitHint(consignor(name = "Ada", split = 60.0), "70")
        assertTrue(hint.contains("70%"))
        assertTrue(hint.contains("60%"))
    }

    @Test
    fun `no consignor says the item is yours`() {
        assertTrue(splitHint(null, "70").contains("yours"))
    }
}
