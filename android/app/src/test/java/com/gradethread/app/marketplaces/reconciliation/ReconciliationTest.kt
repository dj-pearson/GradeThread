package com.gradethread.app.marketplaces.reconciliation

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.R

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** US-1356: what the orphan queue shows and how a bulk run reports itself. */
class ReconciliationTest {

    /**
     * US-2976: an opaque failure marker. These tests never assert the WORDS -
     * they assert which orphans failed and what the summary counts - so the
     * message only has to be distinct, and the server-detail slot is the
     * honest place for a string this test invented.
     */
    private fun failure(marker: String) = UiMessage(R.string.reconcile_error_create, detail = marker)

    @Test
    fun `a listing with no title still names itself`() {
        // eBay doesn't always give one back, and a blank row is unusable.
        val untitled = OrphanEbayListing(id = "o1", ebayItemId = "123456", title = null)
        assertEquals("Listing 123456", untitled.displayTitle)
        assertEquals("Listing 123456", untitled.suggestedTitle)

        val blank = OrphanEbayListing(id = "o2", ebayItemId = "9", title = "   ")
        assertEquals("Listing 9", blank.displayTitle)
    }

    @Test
    fun `a titled listing uses its title`() {
        val orphan = OrphanEbayListing(id = "o1", ebayItemId = "1", title = "Levi's 501 34x32")
        assertEquals("Levi's 501 34x32", orphan.displayTitle)
    }

    @Test
    fun `outcomes know whether they succeeded`() {
        assertTrue(ReconcileOutcome.Created("o1", "i1").succeeded)
        assertTrue(ReconcileOutcome.Linked("o1", "i1").succeeded)
        assertTrue(ReconcileOutcome.Ignored("o1").succeeded)
        assertFalse(ReconcileOutcome.Failed("o1", failure("nope")).succeeded)
    }

    @Test
    fun `a clean bulk run reports the count`() {
        val result = ReconcileBulkResult.from(
            listOf(ReconcileOutcome.Created("o1", "i1"), ReconcileOutcome.Created("o2", "i2")),
        )
        assertEquals(2, result.succeeded)
        assertEquals("Created 2 items from eBay.", result.summary)
    }

    @Test
    fun `a partial run names the shortfall`() {
        // "Created 8" would hide the two rows still sitting in the queue.
        val result = ReconcileBulkResult.from(
            (1..8).map { ReconcileOutcome.Created("o$it", "i$it") } +
                listOf(
                    ReconcileOutcome.Failed("o9", failure("duplicate")),
                    ReconcileOutcome.Failed("o10", failure("network")),
                ),
        )
        assertEquals(8, result.succeeded)
        assertEquals(10, result.total)
        assertEquals("Created 8 of 10 items; 2 failed.", result.summary)
        assertEquals(listOf("o9", "o10"), result.failures.map { it.first })
    }

    @Test
    fun `a run where everything failed says so plainly`() {
        val result = ReconcileBulkResult.from(
            listOf(ReconcileOutcome.Failed("o1", failure("x")), ReconcileOutcome.Failed("o2", failure("y"))),
        )
        assertEquals("All 2 items failed.", result.summary)
    }

    @Test
    fun `one item is singular`() {
        val result = ReconcileBulkResult.from(listOf(ReconcileOutcome.Created("o1", "i1")))
        assertEquals("Created 1 item from eBay.", result.summary)
    }
}
