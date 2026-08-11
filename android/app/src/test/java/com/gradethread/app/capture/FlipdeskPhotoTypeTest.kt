package com.gradethread.app.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2469. Android had no vocabulary for a PERSISTED photo's type at all: the
 * canvas rendered `photo.photoType` straight into a Text, so a seller who had
 * measured a chest saw the literal string `measurement_chest` under the tile.
 * Every assertion here is about a string a seller reads.
 */
class FlipdeskPhotoTypeTest {

    @Test
    fun `no server type renders as snake_case`() {
        // The bug this file exists to end. Every catalogued type must have a
        // label, and it must not be the wire value with underscores in it.
        for (t in FlipdeskPhotoType.all) {
            val label = FlipdeskPhotoType.label(t)
            assertFalse("$t rendered as snake_case: $label", label.contains('_'))
            assertTrue("$t has no label", label.isNotBlank())
        }
    }

    @Test
    fun `a type the app has never seen still reads as words`() {
        // New types ship from the server without a Play Store release, so the
        // fallback is load-bearing rather than defensive.
        assertEquals("Provenance Card", FlipdeskPhotoType.label("provenance_card"))
    }

    @Test
    fun `the role carries the meaning, the type is the fallback`() {
        // A `detail` with role 'fabric' is a Fabric close-up, not "Detail 1".
        assertEquals("Fabric close-up", FlipdeskPhotoType.label("detail", "fabric"))
        assertEquals("Size tag", FlipdeskPhotoType.label("tag", "size"))
        assertEquals("Detail 1", FlipdeskPhotoType.label("detail", null))
        // An unknown role falls back to the type rather than vanishing.
        assertEquals("Detail 1", FlipdeskPhotoType.label("detail", "no_such_role"))
    }

    @Test
    fun `measurement roles are labelled from the shared catalog`() {
        assertEquals("Measure: Chest (pit to pit)", FlipdeskPhotoType.label("measurement", "chest"))
        // A measurement key the catalog has never seen de-underscores rather
        // than rendering raw — MeasurementCatalog already guarantees this.
        assertEquals("Measure: Cuff Opening", FlipdeskPhotoType.label("measurement", "cuff_opening"))
    }

    @Test
    fun `the profile label wins when one is loaded`() {
        // "Sweatband" on a hat, not "Interior / Lining". The profile is written
        // for the category; the catalog is written for everything.
        val hat = PhotoProfile(
            category = "headwear",
            label = "Headwear",
            roles = listOf(
                PhotoRole("interior", "Sweatband", "Inside the band", required = false, icon = "layers"),
            ),
        )
        assertEquals("Sweatband", FlipdeskPhotoType.label("interior", null, hat))
        // A profile that does not cover the pair does not override the catalog.
        assertEquals("Sole", FlipdeskPhotoType.label("sole", null, hat))
    }

    @Test
    fun `a suit profile picks the right one of three tag slots`() {
        val suit = PhotoProfile(
            category = "clothing:suit",
            label = "Suit",
            roles = listOf(
                PhotoRole("tag", "Brand label", "", required = false, icon = "tag", role = "brand"),
                PhotoRole("tag", "Size tag", "", required = false, icon = "tag", role = "size"),
                PhotoRole("tag", "Trouser size tag", "", required = false, icon = "tag", role = "size_alt"),
            ),
        )
        assertEquals("Trouser size tag", FlipdeskPhotoType.label("tag", "size_alt", suit))
        assertEquals("Brand label", FlipdeskPhotoType.label("tag", "brand", suit))
        // roleForServerType keys on the type alone and so picks the FIRST of
        // the three — which is exactly why roleFor exists.
        assertEquals("Brand label", suit.roleForServerType("tag")?.label)
        assertEquals("Size tag", suit.roleFor("tag", "size")?.label)
    }

    @Test
    fun `retired types keep their old names but are never offered again`() {
        // Postgres cannot drop an enum value and historical rows point at these,
        // so a row that migration 00587 has not rewritten yet must still label.
        assertTrue(FlipdeskPhotoType.isRetired("measurement_chest"))
        assertTrue(FlipdeskPhotoType.isRetired("tag_2"))
        assertFalse(FlipdeskPhotoType.isRetired("tag"))
        assertEquals("Measure: Chest / Bust", FlipdeskPhotoType.label("measurement_chest"))
        assertEquals(("measurement" to "chest"), FlipdeskPhotoType.retired["measurement_chest"])
        assertEquals(("tag" to null), FlipdeskPhotoType.retired["tag_2"])
    }

    @Test
    fun `listability is role-aware for measurement`() {
        // A `measurement` with a NULL role is the MeasureCard calibration frame:
        // a branded foreign object beside the garment, which must never publish.
        // With a role it is a tape close-up, which sellers publish on purpose.
        assertTrue(FlipdeskPhotoType.isNonListable("measurement", null))
        assertTrue(FlipdeskPhotoType.isNonListable("measurement", ""))
        assertFalse(FlipdeskPhotoType.isNonListable("measurement", "chest"))
        assertTrue(FlipdeskPhotoType.isNonListable("internal"))
        assertFalse(FlipdeskPhotoType.isNonListable("front"))
    }

    @Test
    fun `slot identity is the pair, not the type`() {
        assertEquals("tag", PhotoProfile.slotKey("tag", null))
        assertEquals("tag", PhotoProfile.slotKey("tag", ""))
        assertEquals("tag:size_alt", PhotoProfile.slotKey("tag", "size_alt"))
        assertEquals(("tag" to "size_alt"), PhotoProfile.parseSlotKey("tag:size_alt"))
        assertEquals(("front" to null), PhotoProfile.parseSlotKey("front"))
    }

    @Test
    fun `every capture slot type is in the catalog`() {
        // The two vocabularies are separate on purpose — one is capture-time,
        // one is storage — but a capture slot that writes a type the catalog
        // does not know would render as snake_case the moment it persists.
        for (slot in PhotoSlotType.entries) {
            assertTrue(
                "${slot.wire} writes ${slot.serverPhotoType}, which is not catalogued",
                slot.serverPhotoType in FlipdeskPhotoType.all,
            )
        }
    }

    @Test
    fun `an unknown type with a role does not invent a label`() {
        assertNull(PhotoRoleVocabulary.label("front", "anything"))
        assertEquals("Front", FlipdeskPhotoType.label("front", "anything"))
    }
}
