package com.gradethread.app.capture

import com.gradethread.app.upload.PhotoUpload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334: what "Continue" publishes.
 *
 * US-2498: the slot ORDER and each photo's `photo_role` come from the resolved
 * profile, so these build against one explicitly.
 */
class CapturePublishPlanTest {

    private val owner = "owner-1"
    private val itemId = "AB-CD"
    private val now = 1_700_000_000_000L
    private val profile = PhotoProfile.clothingFallback

    private fun state(vararg slots: CaptureSlot) = PhotoIntakeStore.State(
        photos = slots.associate { it.storageKey to "/tmp/${it.storageKey}.jpg" },
    )

    private fun plan(vararg slots: CaptureSlot) =
        CapturePublishPlan.build(state(*slots), itemId, owner, now, profile)

    private fun slot(type: PhotoSlotType, role: String? = null) = CaptureSlot(type, role)

    private val front = slot(PhotoSlotType.FRONT)
    private val back = slot(PhotoSlotType.BACK)
    private val tagBrand = slot(PhotoSlotType.TAG, "brand")
    private val tagSize = slot(PhotoSlotType.TAG, "size")
    private val defects = profile.defectCaptureSlots

    @Test
    fun `sort order follows the profile order, not the shooting order`() {
        // Shot back-first; front must still be sort order 0 (the cover / eBay
        // main image).
        val plan = plan(back, front, tagBrand)
        assertEquals(listOf(front, back, tagBrand), plan.uploads.map { it.slot })
        assertEquals(listOf(0, 1, 2), plan.uploads.map { it.sortOrder })
    }

    @Test
    fun `the three defect slots get distinct storage paths`() {
        // They all collapse to the server type `defect`, so a shared timestamp
        // would have them overwrite each other at the same storage key.
        val plan = plan(front, defects[0], defects[1], defects[2])
        val paths = plan.uploads.map { entry ->
            PhotoUpload.uploadPath(owner, plan.itemId, entry.serverPhotoType, entry.capturedAtMs)
        }
        assertEquals(paths.size, paths.toSet().size)
        assertEquals(3, plan.uploads.count { it.serverPhotoType == "defect" })
    }

    @Test
    fun `two tag shots of the same item get distinct storage paths`() {
        // US-2498: `tag|brand` and `tag|size` both write photo_type = "tag", and
        // the storage key is {user}/{item}/{type}_{ts}.jpg — so a per-TYPE
        // offset would have the size tag overwrite the brand label. This is the
        // failure the (type, role) pair introduces and has to answer for.
        val plan = plan(tagBrand, tagSize)
        val paths = plan.uploads.map { entry ->
            PhotoUpload.uploadPath(owner, plan.itemId, entry.serverPhotoType, entry.capturedAtMs)
        }
        assertEquals(2, paths.toSet().size)
        assertEquals(listOf("brand", "size"), plan.uploads.map { it.photoRole })
    }

    @Test
    fun `an unroled slot carries no photo_role`() {
        // Present-and-empty is not the same as absent: the column is nullable
        // and a blank role would sort and group as its own value.
        assertNull(plan(front).uploads.single().photoRole)
    }

    @Test
    fun `capture timestamps are stable per slot, not per position`() {
        val withTag = plan(front, tagBrand)
        val withoutBack = plan(front, back, tagBrand)
        val tagA = withTag.uploads.first { it.slot == tagBrand }
        val tagB = withoutBack.uploads.first { it.slot == tagBrand }
        assertEquals(tagA.capturedAtMs, tagB.capturedAtMs)
        // Position DID change, so a position-derived timestamp would differ.
        assertNotEquals(tagA.sortOrder, tagB.sortOrder)
    }

    @Test
    fun `the gate is the required photos when any were captured`() {
        val plan = plan(tagBrand, front, back)
        val required = plan.uploads.filter { it.isRequired }.map { it.sortOrder }.toSet()
        assertEquals(required, plan.gateSortOrders)
        // A slow optional tag shot must not be in the gate.
        val tagOrder = plan.uploads.first { it.slot == tagBrand }.sortOrder
        assertTrue(tagOrder !in plan.gateSortOrders)
    }

    @Test
    fun `with no required photo the gate falls back to everything`() {
        val plan = plan(tagBrand, slot(PhotoSlotType.DETAIL, "fabric"))
        assertEquals(setOf(0, 1), plan.gateSortOrders)
    }

    @Test
    fun `the item id is lowercased everywhere it appears`() {
        val plan = plan(front)
        assertEquals("ab-cd", plan.itemId)
        assertEquals("\"ab-cd\"", plan.item["id"].toString())
    }

    @Test
    fun `the payload carries only the placeholder identity`() {
        val plan = plan(front)
        assertEquals(setOf("id", "user_id", "title", "status"), plan.item.keys)
        assertEquals("\"${CapturePublishPlan.PLACEHOLDER_TITLE}\"", plan.item["title"].toString())
        assertEquals("\"${CapturePublishPlan.INITIAL_STATUS}\"", plan.item["status"].toString())
    }

    @Test
    fun `a draft slot this build does not know is skipped, not published`() {
        val state = PhotoIntakeStore.State(
            photos = mapOf(
                PhotoSlotType.FRONT.wire to "/tmp/front.jpg",
                "hologram" to "/tmp/hologram.jpg",
            ),
        )
        val plan = CapturePublishPlan.build(state, itemId, owner, now, profile)
        assertEquals(listOf(front), plan.uploads.map { it.slot })
    }

    @Test
    fun `a slot the profile does not list still publishes, last`() {
        // A session that started under one category and finished under another.
        // The photo exists; dropping it would lose the seller's work silently.
        val stray = slot(PhotoSlotType.SOLE)
        val plan = CapturePublishPlan.build(
            state(front, stray),
            itemId,
            owner,
            now,
            profile,
        )
        assertEquals(listOf(front, stray), plan.uploads.map { it.slot })
    }
}
