package com.gradethread.app.capture

import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import org.junit.Assert.assertNotEquals
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
        // US-2976: a catalogued type must resolve to a RESOURCE, not to the
        // derived fallback. `detail` being non-null is what says the lookup
        // missed - it is the wire value tidied up, which is exactly the
        // snake_case leak this test was written to end.
        for (t in FlipdeskPhotoType.all) {
            val label = FlipdeskPhotoType.label(t)
            assertNull("$t fell through to the derived fallback", label.detail)
            assertNotEquals("$t has no label", R.string.photo_type_unknown, label.res)
        }
    }

    @Test
    fun `a type the app has never seen still reads as words`() {
        // New types ship from the server without a Play Store release, so the
        // fallback is load-bearing rather than defensive.
        val unknown = FlipdeskPhotoType.label("provenance_card")
        assertEquals(R.string.photo_type_unknown, unknown.res)
        // The derived name is `detail`: it came off the wire, so it is shown
        // exactly as derived and is not ours to translate.
        assertEquals("Provenance Card", unknown.detail)
    }

    @Test
    fun `the role carries the meaning, the type is the fallback`() {
        // A `detail` with role 'fabric' is a Fabric close-up, not "Detail 1".
        assertEquals(
            R.string.photo_role_detail_fabric,
            FlipdeskPhotoType.label("detail", "fabric").res,
        )
        assertEquals(R.string.photo_role_tag_size, FlipdeskPhotoType.label("tag", "size").res)
        assertEquals(R.string.photo_type_detail, FlipdeskPhotoType.label("detail", null).res)
        // An unknown role falls back to the type rather than vanishing.
        assertEquals(
            R.string.photo_type_detail,
            FlipdeskPhotoType.label("detail", "no_such_role").res,
        )
    }

    @Test
    fun `measurement roles are labelled from the shared catalog`() {
        // US-2976: "Measure: %1$s" wrapping a measurement name that is a
        // message in its own right. The nested one is resolved by text().
        val chest = FlipdeskPhotoType.label("measurement", "chest")
        assertEquals(R.string.photo_role_measure, chest.res)
        assertEquals(
            listOf<Any>(UiMessage(R.string.measurement_chest)),
            chest.args,
        )

        // A measurement key the catalog has never seen de-underscores rather
        // than rendering raw - MeasurementCatalog already guarantees this, and
        // the derived name rides as `detail` on the nested message.
        val unknown = FlipdeskPhotoType.label("measurement", "cuff_opening")
        assertEquals(
            listOf<Any>(
                UiMessage(R.string.measurement_unknown, detail = "Cuff Opening"),
            ),
            unknown.args,
        )
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
        // The profile's wording is the server's, so it arrives as `detail`.
        assertEquals("Sweatband", FlipdeskPhotoType.label("interior", null, hat).detail)
        // A profile that does not cover the pair does not override the catalog.
        val sole = FlipdeskPhotoType.label("sole", null, hat)
        assertEquals(R.string.photo_type_sole, sole.res)
        assertNull(sole.detail)
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
        assertEquals("Trouser size tag", FlipdeskPhotoType.label("tag", "size_alt", suit).detail)
        assertEquals("Brand label", FlipdeskPhotoType.label("tag", "brand", suit).detail)
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
        assertEquals(
            R.string.photo_type_measurement_chest,
            FlipdeskPhotoType.label("measurement_chest").res,
        )
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
        assertEquals(R.string.photo_type_front, FlipdeskPhotoType.label("front", "anything").res)
    }
}
