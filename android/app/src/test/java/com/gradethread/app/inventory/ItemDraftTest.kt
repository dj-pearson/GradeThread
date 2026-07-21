package com.gradethread.app.inventory

import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.sync.db.InventoryItemEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1343: seeding a draft, and what a save is allowed to write.
 */
class ItemDraftTest {

    private fun entity(
        title: String = "Fleece",
        itemCategory: String? = "clothing",
        acquiredPrice: Double? = null,
        targetPrice: Double? = null,
        status: String = "cataloged",
        sku: String? = null,
    ) = InventoryItemEntity(
        id = "i1",
        userId = "u1",
        title = title,
        brand = "Patagonia",
        sku = sku,
        size = null,
        color = null,
        material = null,
        status = status,
        itemCategory = itemCategory,
        garmentType = null,
        garmentCategory = null,
        itemDescription = null,
        style = null,
        sourcedBy = null,
        acquiredDate = null,
        container = null,
        compSetJson = null,
        sourceId = null,
        locationBin = null,
        consignorId = null,
        consignmentSplitPct = null,
        acquiredPrice = acquiredPrice,
        targetPrice = targetPrice,
        listingPrice = null,
        gradeValue = null,
        gradeLabel = null,
        certificateUrl = null,
        gradeReportId = null,
        disputeStatus = null,
        conditionNotes = null,
        measurementsJson = null,
        primaryPhotoUrl = null,
        createdAt = 0,
        updatedAt = 0,
    )

    // ── the category seed (AC3) ──────────────────────────────────────────

    @Test
    fun `an item with no category seeds to null, not clothing`() {
        // FlipdeskCategory.from() falls back to CLOTHING, which is right for a
        // picker default and wrong here: photo-first intake creates items with
        // NO category, and seeding one would have the first save assert a
        // category the seller never chose — on a watch, say.
        assertNull(ItemDraft.from(entity(itemCategory = null)).category)
        assertNull(ItemDraft.from(entity(itemCategory = "  ")).category)
        assertNull(ItemDraft.categoryOrNull("not_a_category"))
    }

    @Test
    fun `a real category round-trips`() {
        val draft = ItemDraft.from(entity(itemCategory = "watches"))
        assertEquals(FlipdeskCategory.WATCHES, draft.category)
        // Unchanged, so the patch says nothing about it at all.
        assertFalse(ItemPatch.diff(draft, draft).containsKey("item_category"))
    }

    @Test
    fun `an untouched null category is never written`() {
        // The AC's "no accidental null" cuts both ways: an item that never had
        // a category must still not have one after an unrelated edit.
        val draft = ItemDraft.from(entity(itemCategory = null))
        val patch = ItemPatch.diff(draft, draft.copy(brand = "Arc'teryx"))
        assertFalse(patch.containsKey("item_category"))
        assertEquals(setOf("brand"), patch.keys)
    }

    @Test
    fun `clearing a category writes an explicit null`() {
        val draft = ItemDraft.from(entity(itemCategory = "clothing"))
        val patch = ItemPatch.diff(draft, draft.copy(category = null))
        assertEquals("null", patch["item_category"].toString())
    }

    // ── the diff ─────────────────────────────────────────────────────────

    @Test
    fun `only changed columns are written`() {
        // The canvas holds a snapshot from when it opened. A full-row write
        // would push every stale field back over anything that changed since —
        // a grade that landed, a price a sync pulled.
        val draft = ItemDraft.from(entity())
        val patch = ItemPatch.diff(draft, draft.copy(size = "M"))
        assertEquals(setOf("size"), patch.keys)
    }

    @Test
    fun `nothing changed means nothing written`() {
        val draft = ItemDraft.from(entity())
        assertTrue(ItemPatch.diff(draft, draft).isEmpty())
        assertFalse(ItemPatch.isDirty(draft, draft))
    }

    @Test
    fun `whitespace-only edits are not changes`() {
        val draft = ItemDraft.from(entity())
        assertTrue(ItemPatch.diff(draft, draft.copy(brand = "  Patagonia  ")).isEmpty())
    }

    @Test
    fun `a cleared field becomes null, never an empty string`() {
        // "" is a real value that reads as set-but-empty downstream, and it
        // would occupy the partial unique index on sku.
        val draft = ItemDraft.from(entity(sku = "ABC-1"))
        val patch = ItemPatch.diff(draft, draft.copy(sku = "   "))
        assertEquals("null", patch["sku"].toString())
    }

    @Test
    fun `a blank title is dropped rather than failing the whole patch`() {
        // title is NOT NULL server-side; sending null would reject every other
        // field in the same write.
        val draft = ItemDraft.from(entity())
        val patch = ItemPatch.diff(draft, draft.copy(title = "", size = "L"))
        assertFalse(patch.containsKey("title"))
        assertEquals(setOf("size"), patch.keys)
    }

    // ── money ────────────────────────────────────────────────────────────

    @Test
    fun `money compares as cents so reformatting is not an edit`() {
        // Without this, re-opening the canvas would dirty the price fields
        // purely by formatting them, and every save would write untouched
        // values.
        val draft = ItemDraft.from(entity(acquiredPrice = 12.0))
        assertEquals("12.00", draft.acquiredPriceText)
        assertTrue(ItemPatch.diff(draft, draft.copy(acquiredPriceText = "12")).isEmpty())
        assertTrue(ItemPatch.diff(draft, draft.copy(acquiredPriceText = "$12.00")).isEmpty())
    }

    @Test
    fun `a real price change is written`() {
        val draft = ItemDraft.from(entity(acquiredPrice = 12.0))
        val patch = ItemPatch.diff(draft, draft.copy(acquiredPriceText = "18.50"))
        assertEquals("18.5", patch["acquired_price"].toString())
    }

    @Test
    fun `clearing a price nulls it rather than writing zero`() {
        val draft = ItemDraft.from(entity(targetPrice = 40.0))
        val patch = ItemPatch.diff(draft, draft.copy(targetPriceText = ""))
        assertEquals("null", patch["target_price"].toString())
    }

    // ── status ───────────────────────────────────────────────────────────

    @Test
    fun `a sold item cannot regress to a pre-sale status`() {
        assertFalse(ItemPatch.allowsStatus("sold", "cataloged"))
        assertFalse(ItemPatch.allowsStatus("shipped", "listed"))
        // Terminal to terminal is fine — sold, then shipped, then completed.
        assertTrue(ItemPatch.allowsStatus("sold", "shipped"))
        assertTrue(ItemPatch.allowsStatus("cataloged", "listed"))
        assertTrue(ItemPatch.allowsStatus("sold", "sold"))
    }

    @Test
    fun `a disallowed status transition is silently dropped from the patch`() {
        val draft = ItemDraft.from(entity(status = "sold"))
        val patch = ItemPatch.diff(draft, draft.copy(status = "cataloged", size = "S"))
        assertFalse(patch.containsKey("status"))
        // The rest of the edit still lands.
        assertEquals(setOf("size"), patch.keys)
    }

    // ── dates ────────────────────────────────────────────────────────────

    @Test
    fun `an acquired date is written as a plain calendar day`() {
        // acquired_date is a Postgres DATE; a timestamp is rejected.
        val millis = java.time.LocalDate.of(2026, 3, 9)
            .atStartOfDay(java.time.ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli()
        assertEquals("2026-03-09", ItemDraft.toDateWire(millis))
        assertNull(ItemDraft.toDateWire(null))
    }
}
