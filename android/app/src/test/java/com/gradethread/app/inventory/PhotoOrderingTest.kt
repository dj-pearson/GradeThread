package com.gradethread.app.inventory

import com.gradethread.app.capture.PhotoProfile
import com.gradethread.app.capture.PhotoRole
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

    private fun role(type: String, label: String, role: String? = null, required: Boolean = false) =
        PhotoRole(type, label, "", required = required, icon = "x", role = role)

    /**
     * A small four-slot clothing profile: front, back, one bare tag, one bare
     * detail, plus defects.
     *
     * US-2498: this WAS `PhotoProfile.clothingFallback`, which is now the
     * server's real clothing profile — sixteen roles, four of them tags. These
     * tests are about the ordering and slot-offer RULES, and against a
     * sixteen-role profile every expectation here becomes a list nobody can read
     * and the rule under test stops being visible. The fixture is the shape the
     * rules describe; the bundled table's contents are pinned in
     * `PhotoProfileTest` instead.
     */
    private val clothing = PhotoProfile(
        category = "clothing",
        label = "Clothing",
        roles = listOf(
            role("front", "Front", required = true),
            role("back", "Back", required = true),
            role("tag", "Garment Tag", required = true),
            role("detail", "Detail", required = true),
            role("defect", "Defect"),
        ),
    )

    private val suit = PhotoProfile(
        category = "clothing:suit",
        label = "Suit",
        roles = listOf(
            role("front", "Front", required = true),
            role("back", "Back", required = true),
            role("tag", "Brand label", "brand"),
            role("tag", "Size tag", "size"),
            role("tag", "Trouser size tag", "size_alt"),
            role("detail", "Fabric close-up", "fabric"),
            role("defect", "Defect"),
            role("measurement", "Measure: Chest", "chest"),
            role("measurement", "Measure: Inseam", "inseam"),
        ),
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
    fun `add offers the slots this garment wants that have no photo`() {
        val partial = listOf(photo("front", "front", 0))
        assertEquals(
            listOf("back", "tag", "detail"),
            PhotoOrdering.unfilledSlots(partial, clothing).map { it.key },
        )
    }

    @Test
    fun `one defect photo does not mark every defect slot filled`() {
        // defect1..3 all collapse to the server type `defect`, so a naive
        // filled-check would hide the remaining defect slots after one shot.
        // Defects are excluded from the offer list outright for that reason.
        val withDefect = strip + photo("d1", "defect", 3) + photo("detail", "detail", 4)
        assertTrue(PhotoOrdering.unfilledSlots(withDefect, clothing).isEmpty())
    }

    @Test
    fun `missing required slots are reported by name`() {
        // US-2488: named from the PROFILE's required flags, which is why this
        // now says Tag and Detail too. The old list was the capture enum's
        // `required` — front+back, the PUBLISH gate (00306) — but this string
        // is the canvas hint, and grading needs front, back, label and at
        // least one detail. It was under-reporting.
        val onlyFront = listOf(photo("front", "front", 0))
        // US-2976: the profile names these slots, so the wording is the
        // server's and rides as `detail`. WHICH slots are missing is what the
        // test is for, and that is unchanged.
        assertEquals(
            listOf("Back", "Garment Tag", "Detail"),
            PhotoOrdering.missingRequiredSlots(onlyFront, clothing).map { it.label.detail },
        )
        // The front+back+tag strip still owes a detail shot.
        assertEquals(
            listOf("Detail"),
            PhotoOrdering.missingRequiredSlots(strip, clothing).map { it.label.detail },
        )
        assertTrue(
            PhotoOrdering.missingRequiredSlots(
                strip + photo("d", "detail", 3),
                clothing,
            ).isEmpty(),
        )
    }

    // ── US-2488: the offer list is the PROFILE's, not the enum's ──────────

    @Test
    fun `measurement roles survive - the enum silently dropped every one`() {
        // The bug this story exists for: PhotoSlotType has measurement_chest
        // and friends but NO plain `measurement`, so resolving a profile's
        // measurement roles through the enum returned null every time and the
        // seller was never offered a single measurement shot.
        val offered = PhotoOrdering.unfilledSlots(strip, suit).map { it.key }
        assertTrue("measurement:chest" in offered)
        assertTrue("measurement:inseam" in offered)
        // US-1576 later gave the enum its plain `measurement` slot, so this no
        // longer reads as a gap. It still reads as INDEPENDENCE, which is the
        // durable half: the offer list is built from the profile's (type, role)
        // pairs, so it would keep working even if the enum lost the slot again.
        assertEquals("measurement", PhotoSlotType.MEASUREMENT.wire)
        assertNull(PhotoSlotType.fromWire("measurement_hip"))
    }

    @Test
    fun `a suit is offered a slot per tag and a top is not offered an inseam`() {
        val suitSlots = PhotoOrdering.unfilledSlots(emptyList(), suit).map { it.key }
        assertEquals(
            listOf("tag:brand", "tag:size", "tag:size_alt"),
            suitSlots.filter { it.startsWith("tag") },
        )
        val topSlots = PhotoOrdering.unfilledSlots(emptyList(), clothing).map { it.key }
        assertTrue("measurement:inseam" !in topSlots)
    }

    @Test
    fun `filling one tag role still leaves the other tag slots on offer`() {
        val withBrand = listOf(photo("b", "tag", 0, role = "brand"))
        val offered = PhotoOrdering.unfilledSlots(withBrand, suit).map { it.key }
        assertTrue("tag:brand" !in offered)
        assertTrue("tag:size" in offered)
    }

    @Test
    fun `a stale server profile cannot put a retired type back on offer`() {
        val stale = PhotoProfile(
            category = "clothing",
            label = "Clothing",
            roles = listOf(role("front", "Front", required = true), role("detail_2", "Detail 2")),
        )
        assertEquals(
            listOf("front"),
            PhotoOrdering.unfilledSlots(emptyList(), stale).map { it.key },
        )
    }

    @Test
    fun `a duplicate pair in a server profile is offered once`() {
        val dupes = PhotoProfile(
            category = "clothing",
            label = "Clothing",
            roles = listOf(
                role("tag", "Brand label", "brand"),
                role("tag", "Brand label again", "brand"),
            ),
        )
        assertEquals(1, PhotoOrdering.unfilledSlots(emptyList(), dupes).size)
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
    fun `a qualified tag does not satisfy the plain tag slot`() {
        // The clothing default asks for a bare `tag`. A photo the seller
        // retagged to "Brand label" is a different slot, so Tag is still on
        // offer.
        val qualified = listOf(
            photo("front", "front", 0),
            photo("back", "back", 1),
            photo("brand", "tag", 2, role = "brand"),
        )
        assertTrue("tag" in PhotoOrdering.unfilledSlots(qualified, clothing).map { it.key })
        // …and the unqualified one still does.
        assertTrue("tag" !in PhotoOrdering.unfilledSlots(strip, clothing).map { it.key })
    }
}
