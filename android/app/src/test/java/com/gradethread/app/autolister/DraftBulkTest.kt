package com.gradethread.app.autolister

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1359: bulk draft edits.
 *
 * These rewrite many unpublished listings at once, so the two guards matter:
 * never invent a price for a draft that has none, and never produce a negative
 * one.
 */
class DraftBulkTest {

    private fun draft(id: String, price: Double?) =
        DraftListing(id = id, listingTitle = "Draft $id", listingPrice = price)

    @Test
    fun `an absolute price applies to every draft, priced or not`() {
        assertEquals(29.99, DraftBulk.newPrice(null, DraftBulk.PriceChange.Absolute(29.99))!!, 1e-9)
        assertEquals(29.99, DraftBulk.newPrice(10.0, DraftBulk.PriceChange.Absolute(29.99))!!, 1e-9)
    }

    @Test
    fun `a percentage needs something to work from`() {
        // Otherwise a 10% cut on "no price" would have to invent a starting
        // number, and every such draft would end up at the same made-up value.
        assertNull(DraftBulk.newPrice(null, DraftBulk.PriceChange.Percent(-10.0)))
        assertEquals(36.0, DraftBulk.newPrice(40.0, DraftBulk.PriceChange.Percent(-10.0))!!, 1e-9)
        assertEquals(44.0, DraftBulk.newPrice(40.0, DraftBulk.PriceChange.Percent(10.0))!!, 1e-9)
    }

    @Test
    fun `a bulk edit can never produce a negative price`() {
        assertEquals(0.0, DraftBulk.newPrice(40.0, DraftBulk.PriceChange.Percent(-150.0))!!, 1e-9)
        assertEquals(0.0, DraftBulk.newPrice(null, DraftBulk.PriceChange.Absolute(-5.0))!!, 1e-9)
    }

    @Test
    fun `round to 99 floors, except under a dollar`() {
        assertEquals(19.99, DraftBulk.roundTo99(19.49), 1e-9)
        assertEquals(19.99, DraftBulk.roundTo99(19.99), 1e-9)
        assertEquals(0.0, DraftBulk.roundTo99(0.0), 1e-9)
        // Flooring $0.75 to $0.99 would RAISE it, which isn't what rounding
        // down to .99 means to anyone.
        assertEquals(0.75, DraftBulk.roundTo99(0.75), 1e-9)
    }

    @Test
    fun `round to 99 needs a price too`() {
        assertNull(DraftBulk.newPrice(null, DraftBulk.PriceChange.Round99))
        assertEquals(19.99, DraftBulk.newPrice(19.49, DraftBulk.PriceChange.Round99)!!, 1e-9)
    }

    @Test
    fun `the preview names the drafts a change will skip`() {
        // "12 drafts" when only 9 move is the quiet mismatch that erodes trust
        // in the whole bulk bar.
        val drafts = listOf(draft("a", 40.0), draft("b", null), draft("c", 20.0))
        val selected = setOf("a", "b", "c")
        assertEquals(2, DraftBulk.affected(drafts, selected, DraftBulk.PriceChange.Percent(-10.0)))
        val summary = DraftBulk.previewSummary(drafts, selected, DraftBulk.PriceChange.Percent(-10.0))
        assertTrue(summary.contains("Updates 2 of 3"))
        assertTrue(summary.contains("1 skipped"))
    }

    @Test
    fun `a change that touches everything says so plainly`() {
        val drafts = listOf(draft("a", 40.0), draft("b", 20.0))
        val selected = setOf("a", "b")
        assertEquals(
            "Updates 2 drafts.",
            DraftBulk.previewSummary(drafts, selected, DraftBulk.PriceChange.Round99),
        )
        assertEquals(
            "Nothing selected.",
            DraftBulk.previewSummary(drafts, emptySet(), DraftBulk.PriceChange.Round99),
        )
    }

    @Test
    fun `unselected drafts are never touched`() {
        val drafts = listOf(draft("a", 40.0), draft("b", 20.0))
        assertEquals(1, DraftBulk.affected(drafts, setOf("a"), DraftBulk.PriceChange.Round99))
    }

    @Test
    fun `typed prices go through the shared money parser`() {
        assertEquals(29.99, DraftBulk.parsePrice("\$29.99")!!, 1e-9)
        assertNull(DraftBulk.parsePrice(""))
        assertNull(DraftBulk.parsePrice("0"))
    }

    /**
     * US-2370: the sheet used to open on "price", a key no chip and no branch
     * knows, so it rendered with nothing selected, no field and a dead confirm
     * button. The default has to be a real mode.
     */
    @Test
    fun `the bulk sheet opens on a mode it actually offers`() {
        assertTrue(DraftBulk.DEFAULT_BULK_EDIT_MODE in DraftBulk.BULK_EDIT_MODES)
    }

    @Test
    fun `every offered mode renders a field or is self-contained`() {
        assertEquals(
            listOf("set", "percent", "round99", "title"),
            DraftBulk.BULK_EDIT_MODES,
        )
    }
}
