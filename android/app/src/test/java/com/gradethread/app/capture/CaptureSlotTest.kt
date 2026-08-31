package com.gradethread.app.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2498: the (photo_type, photo_role) pair, and the profile-to-slot boundary.
 */
class CaptureSlotTest {

    @Test
    fun `identity is the pair and nothing else`() {
        val fromProfile = CaptureSlot(
            type = PhotoSlotType.TAG,
            role = "size",
            label = "Size tag",
            hint = "close enough to read",
        )
        val fromDraft = CaptureSlot.fromStorageKey("tag|size")
        // Labels differ; the slot is the same slot. If wording took part in
        // equality, a profile arriving mid-session would orphan every photo
        // captured under the bundled fallback's wording.
        assertEquals(fromProfile, fromDraft)
        assertEquals(fromProfile.hashCode(), fromDraft?.hashCode())
        assertNotEquals(fromProfile, CaptureSlot(PhotoSlotType.TAG))
    }

    @Test
    fun `a blank role is the same as no role`() {
        assertNull(CaptureSlot(PhotoSlotType.TAG, "  ").role)
        assertEquals("tag", CaptureSlot(PhotoSlotType.TAG, "").storageKey)
        assertEquals("tag|size", CaptureSlot(PhotoSlotType.TAG, " size ").storageKey)
    }

    @Test
    fun `a pre-US-2498 storage key still decodes`() {
        val slot = CaptureSlot.fromStorageKey("front")
        assertEquals(PhotoSlotType.FRONT, slot?.type)
        assertNull(slot?.role)
    }

    @Test
    fun `a storage key this build has no case for decodes to null`() {
        assertNull(CaptureSlot.fromStorageKey("hologram"))
        assertNull(CaptureSlot.fromStorageKey("hologram|left"))
    }

    @Test
    fun `every photo type the server profiles name has a capture case`() {
        // AC2. These are the types `services/edge-functions/src/lib/
        // photo-profiles.ts` builds roles from. A type with no case here is a
        // slot the seller is never offered, and before this story that happened
        // with nothing on screen to say so — `on_hanger` and `set_pair` were
        // both dropped that way.
        // `defect` is excluded on purpose: the enum holds defect1..3, which all
        // write it, because the strip reveals them one at a time.
        val served = listOf(
            "front", "back", "tag", "detail", "measurement",
            "interior", "flatlay", "on_hanger", "on_model", "set_pair",
            "angle", "sole", "marking", "serial", "accessory",
            "certificate", "corner", "surface",
        )
        val missing = served.filter { PhotoSlotType.fromWire(it) == null }
        assertEquals("photo types with no capture case: $missing", emptyList<String>(), missing)
    }

    @Test
    fun `a retired type is refused at the profile boundary`() {
        val role = PhotoRole("detail_2", "Detail 2", "", required = false, icon = "search")
        assertNull(role.captureSlot())
    }

    @Test
    fun `an unknown type is reported, not just dropped`() {
        val profile = PhotoProfile(
            category = "future",
            label = "Future",
            roles = listOf(
                PhotoRole("front", "Front", "", required = true, icon = "image"),
                PhotoRole("hologram", "Hologram", "", required = false, icon = "sparkle"),
                PhotoRole("detail_2", "Detail 2", "", required = false, icon = "search"),
            ),
        )
        assertEquals(listOf("hologram"), profile.unsupportedRoleTypes)
        // A retired type is NOT reported: it is refused on purpose, not missing.
        assertTrue(profile.captureSlots.none { it.type == PhotoSlotType.DETAIL2 })
    }

    @Test
    fun `the default strip is one slot of each kind, not the first four`() {
        // Clothing's role order is front, back, tag_brand, tag_size, tag_care,
        // detail_fabric — so "the first four" would offer two tag slots and no
        // detail at all.
        val strip = PhotoProfile.clothingFallback.defaultCaptureSlots
        assertEquals(listOf("front", "back", "tag|brand", "detail|fabric"), strip.map { it.storageKey })
        assertEquals(4, strip.map { it.serverPhotoType }.distinct().size)
        assertEquals(listOf(true, true, false, false), strip.map { it.isBlocking })
    }

    @Test
    fun `a profile with no usable role falls back to the four-slot strip`() {
        val empty = PhotoProfile(category = "x", label = "X", roles = emptyList())
        assertEquals(CaptureSlot.defaults, empty.defaultCaptureSlots)
    }

    @Test
    fun `a duplicated role is deduped, first occurrence wins`() {
        // Server data this client did not author. Two identical keys in a
        // LazyRow is a crash, not an extra row.
        val profile = PhotoProfile(
            category = "x",
            label = "X",
            roles = listOf(
                PhotoRole("tag", "Brand label", "", required = false, icon = "tag", role = "brand"),
                PhotoRole("tag", "Brand, again", "", required = false, icon = "tag", role = "brand"),
            ),
        )
        assertEquals(1, profile.captureSlots.size)
        // US-2976: the PROFILE's wording arrives from the server, so it is
        // `detail` and is shown exactly as it came.
        assertEquals("Brand label", profile.captureSlots.single().label.detail)
    }

    @Test
    fun `defect slots carry the profiles own wording`() {
        val slots = PhotoProfile.clothingFallback.defectCaptureSlots
        assertEquals(3, slots.size)
        assertEquals(3, slots.map { it.storageKey }.distinct().size)
        assertTrue(slots.all { it.label.detail == "Defect" && !it.isBlocking })
        // A profile with no defect role offers none.
        val noDefects = PhotoProfile(
            category = "x",
            label = "X",
            roles = listOf(PhotoRole("front", "Front", "", required = true, icon = "image")),
        )
        assertTrue(noDefects.defectCaptureSlots.isEmpty())
    }

    @Test
    fun `a roled tag slot is still a tag slot`() {
        // The AI extract's OCR fallback waits on one of these. An `== TAG`
        // check matched none of them.
        assertTrue(CaptureSlot(PhotoSlotType.TAG, "brand").isTagSlot)
        assertTrue(CaptureSlot(PhotoSlotType.TAG).isTagSlot)
        assertTrue(!CaptureSlot(PhotoSlotType.DETAIL, "fabric").isTagSlot)
    }
}
