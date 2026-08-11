package com.gradethread.app.inventory

import com.gradethread.app.capture.PhotoSlotType
import com.gradethread.app.sync.db.ItemPhotoEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1344: photo order. Index 0 is the cover, and the cover is the eBay main
 * image — so every rule here has a consequence on a live listing.
 */
class PhotoOrderingTest {

    private fun photo(
        id: String,
        type: String = "detail",
        sortOrder: Int = 0,
        createdAt: Long = 0,
        role: String? = null,
    ) = ItemPhotoEntity(
        id = id,
        inventoryItemId = "item-1",
        photoType = type,
        photoRole = role,
        photoUrl = "https://cdn/$id.jpg",
        thumbnailUrl = null,
        storagePath = "u/i/$id.jpg",
        width = null,
        height = null,
        bytes = null,
        sortOrder = sortOrder,
        createdAt = createdAt,
        localBytesPath = null,
    )

    private val strip = listOf(
        photo("front", "front", 0),
        photo("back", "back", 1),
        photo("tag", "tag", 2),
    )

    // ── changed rows only ────────────────────────────────────────────────

    @Test
    fun `only rows that actually moved are written`() {
        // A reorder that rewrote all twelve rows would burn twelve round trips
        // to move one photo, and touch updated_at on photos nobody dragged.
        val reordered = PhotoOrdering.moved(strip, from = 2, to = 0)
        assertEquals(listOf("tag", "front", "back"), reordered.map { it.id })
        assertEquals(
            listOf("tag" to 0, "front" to 1, "back" to 2),
            PhotoOrdering.changedSortOrders(reordered),
        )
    }

    @Test
    fun `an unchanged order writes nothing`() {
        assertTrue(PhotoOrdering.changedSortOrders(strip).isEmpty())
    }

    @Test
    fun `moving the tail leaves the head alone`() {
        val reordered = PhotoOrdering.moved(strip, from = 1, to = 2)
        // front never moved, so it is not in the write set.
        assertEquals(listOf("tag" to 1, "back" to 2), PhotoOrdering.changedSortOrders(reordered))
    }

    // ── cover ────────────────────────────────────────────────────────────

    @Test
    fun `set-cover promotes to index zero`() {
        val reordered = PhotoOrdering.movedToCover(strip, from = 2)
        assertEquals(listOf("tag", "front", "back"), reordered.map { it.id })
        // coverOf, not cover: a reorder rearranges the LIST without renumbering
        // sort_order (changedSortOrders needs the stale values to find what
        // moved), so sorting by sort_order here would still report the old
        // cover while the seller is looking at the new one.
        assertEquals("tag", PhotoOrdering.coverOf(reordered)?.id)
        assertEquals("front", PhotoOrdering.cover(reordered)?.id)
    }

    @Test
    fun `set-cover on the existing cover is a no-op`() {
        assertEquals(strip, PhotoOrdering.movedToCover(strip, from = 0))
    }

    @Test
    fun `an out-of-range index changes nothing rather than throwing`() {
        assertEquals(strip, PhotoOrdering.movedToCover(strip, from = 9))
        assertEquals(strip, PhotoOrdering.moved(strip, from = 0, to = 9))
        assertEquals(strip, PhotoOrdering.moved(strip, from = 1, to = 1))
    }

    @Test
    fun `the cover comes from the photo rows, lowest sort order first`() {
        // Deliberately NOT from inventory_items.primaryPhotoUrl, which is a
        // denormalized cache that lags the real set (US-994).
        val shuffled = listOf(
            photo("c", sortOrder = 5),
            photo("a", sortOrder = 1),
            photo("b", sortOrder = 3),
        )
        assertEquals("a", PhotoOrdering.cover(shuffled)?.id)
        assertEquals(listOf("a", "b", "c"), PhotoOrdering.displayOrder(shuffled).map { it.id })
    }

    @Test
    fun `equal sort orders break the tie deterministically`() {
        // Two photos can share a sort_order after a partial sync; the order
        // must not flicker between renders.
        val tied = listOf(
            photo("z", sortOrder = 0, createdAt = 200),
            photo("y", sortOrder = 0, createdAt = 100),
        )
        assertEquals(listOf("y", "z"), PhotoOrdering.displayOrder(tied).map { it.id })
    }

    @Test
    fun `no photos means no cover, not a crash`() {
        assertNull(PhotoOrdering.cover(emptyList()))
    }

    // ── removal ──────────────────────────────────────────────────────────

    @Test
    fun `removing the cover promotes the next photo and closes the gap`() {
        val remaining = PhotoOrdering.removed(strip, "front")
        assertEquals(listOf("back", "tag"), remaining.map { it.id })
        // The survivors are re-densified, so "lowest sort_order" and "index 0"
        // agree again.
        assertEquals(listOf("back" to 0, "tag" to 1), PhotoOrdering.changedSortOrders(remaining))
    }

    @Test
    fun `removing the last photo touches nothing else`() {
        val remaining = PhotoOrdering.removed(strip, "tag")
        assertTrue(PhotoOrdering.changedSortOrders(remaining).isEmpty())
    }

    @Test
    fun `removing an unknown id leaves the strip intact`() {
        assertEquals(strip, PhotoOrdering.removed(strip, "not-here"))
    }

    // ── slots ────────────────────────────────────────────────────────────

    @Test
    fun `add offers the standard slots that have no photo`() {
        val partial = listOf(photo("front", "front", 0))
        assertEquals(
            listOf(PhotoSlotType.BACK, PhotoSlotType.TAG, PhotoSlotType.DETAIL),
            PhotoOrdering.unfilledStandardSlots(partial),
        )
    }

    @Test
    fun `one defect photo does not mark every defect slot filled`() {
        // defect1..3 all collapse to the server type `defect`, so a naive
        // filled-check would hide the remaining defect slots after one shot.
        val withDefect = strip + photo("d1", "defect", 3) + photo("detail", "detail", 4)
        assertTrue(PhotoOrdering.unfilledStandardSlots(withDefect).isEmpty())
    }

    @Test
    fun `missing required slots are reported by name`() {
        val onlyFront = listOf(photo("front", "front", 0))
        assertEquals(listOf(PhotoSlotType.BACK), PhotoOrdering.missingRequiredSlots(onlyFront))
        assertTrue(PhotoOrdering.missingRequiredSlots(strip).isEmpty())
    }

    // ── appending ────────────────────────────────────────────────────────

    @Test
    fun `a new photo appends and never becomes the cover`() {
        // Silently changing a live listing's main image is not something
        // anyone asked for by tapping "Add photos".
        assertEquals(3, PhotoOrdering.nextSortOrder(strip))
        assertEquals(0, PhotoOrdering.nextSortOrder(emptyList()))
    }

    @Test
    fun `appending is safe when sort orders are already sparse`() {
        val sparse = listOf(photo("a", sortOrder = 0), photo("b", sortOrder = 7))
        assertEquals(8, PhotoOrdering.nextSortOrder(sparse))
    }

    // ── US-2469: what a photo FILLS is the (type, role) pair ──────────────

    @Test
    fun `a retired type fills the same slot as the pair it became`() {
        // A device holding a pre-00587 row must not be told its chest
        // measurement is still missing while the seller is looking at it.
        assertEquals(
            PhotoOrdering.slotKeyOf(photo("old", "measurement_chest")),
            PhotoOrdering.slotKeyOf(photo("new", "measurement", role = "chest")),
        )
        assertEquals("tag", PhotoOrdering.slotKeyOf(photo("old", "tag_2")))
        assertEquals("detail", PhotoOrdering.slotKeyOf(photo("old", "detail_3")))
    }

    @Test
    fun `two roles on one type are two different slots`() {
        // The whole reason the enum stopped growing a tag_2: a suit's brand
        // label and its trouser size tag are both `tag` and are not the same
        // shot. Keying on the type alone would call one of them filled.
        val brand = photo("a", "tag", role = "brand")
        val size = photo("b", "tag", role = "size_alt")
        assertEquals("tag:brand", PhotoOrdering.slotKeyOf(brand))
        assertEquals("tag:size_alt", PhotoOrdering.slotKeyOf(size))
    }

    @Test
    fun `a qualified tag does not satisfy the plain tag capture slot`() {
        // The capture strip writes a bare `tag`. A photo the seller retagged to
        // "Brand label" is a different slot, so the strip still offers Tag.
        val qualified = listOf(
            photo("front", "front", 0),
            photo("back", "back", 1),
            photo("brand", "tag", 2, role = "brand"),
        )
        assertTrue(PhotoSlotType.TAG in PhotoOrdering.unfilledStandardSlots(qualified))
        // …and the unqualified one still does.
        assertTrue(PhotoSlotType.TAG !in PhotoOrdering.unfilledStandardSlots(strip))
    }
}
