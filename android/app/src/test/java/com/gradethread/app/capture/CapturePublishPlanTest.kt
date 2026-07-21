package com.gradethread.app.capture

import com.gradethread.app.upload.PhotoUpload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334: what "Continue" publishes.
 */
class CapturePublishPlanTest {

    private val owner = "owner-1"
    private val itemId = "AB-CD"
    private val now = 1_700_000_000_000L

    private fun state(vararg slots: PhotoSlotType) = PhotoIntakeStore.State(
        photos = slots.associate { it.wire to "/tmp/${it.wire}.jpg" },
    )

    private fun plan(vararg slots: PhotoSlotType) =
        CapturePublishPlan.build(state(*slots), itemId, owner, now)

    @Test
    fun `sort order follows the canonical slot order, not the shooting order`() {
        // Shot back-first; front must still be sort order 0 (the cover / eBay
        // main image).
        val plan = plan(PhotoSlotType.BACK, PhotoSlotType.FRONT, PhotoSlotType.TAG)
        assertEquals(
            listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK, PhotoSlotType.TAG),
            plan.uploads.map { it.slot },
        )
        assertEquals(listOf(0, 1, 2), plan.uploads.map { it.sortOrder })
    }

    @Test
    fun `the three defect slots get distinct storage paths`() {
        // They all collapse to the server type `defect`, so a shared timestamp
        // would have them overwrite each other at the same storage key.
        val plan = plan(
            PhotoSlotType.FRONT,
            PhotoSlotType.DEFECT1,
            PhotoSlotType.DEFECT2,
            PhotoSlotType.DEFECT3,
        )
        val paths = plan.uploads.map { entry ->
            PhotoUpload.uploadPath(owner, plan.itemId, entry.serverPhotoType, entry.capturedAtMs)
        }
        assertEquals(paths.size, paths.toSet().size)
        assertEquals(3, plan.uploads.count { it.serverPhotoType == "defect" })
    }

    @Test
    fun `capture timestamps are stable per slot, not per position`() {
        val withTag = plan(PhotoSlotType.FRONT, PhotoSlotType.TAG)
        val withoutBack = plan(PhotoSlotType.FRONT, PhotoSlotType.BACK, PhotoSlotType.TAG)
        val tagA = withTag.uploads.first { it.slot == PhotoSlotType.TAG }
        val tagB = withoutBack.uploads.first { it.slot == PhotoSlotType.TAG }
        assertEquals(tagA.capturedAtMs, tagB.capturedAtMs)
        // Position DID change, so a position-derived timestamp would differ.
        assertNotEquals(tagA.sortOrder, tagB.sortOrder)
    }

    @Test
    fun `the gate is the required photos when any were captured`() {
        val plan = plan(PhotoSlotType.TAG, PhotoSlotType.FRONT, PhotoSlotType.BACK)
        val required = plan.uploads.filter { it.isRequired }.map { it.sortOrder }.toSet()
        assertEquals(required, plan.gateSortOrders)
        // A slow optional tag shot must not be in the gate.
        val tagOrder = plan.uploads.first { it.slot == PhotoSlotType.TAG }.sortOrder
        assertTrue(tagOrder !in plan.gateSortOrders)
    }

    @Test
    fun `with no required photo the gate falls back to everything`() {
        val plan = plan(PhotoSlotType.TAG, PhotoSlotType.DETAIL)
        assertEquals(setOf(0, 1), plan.gateSortOrders)
    }

    @Test
    fun `the item id is lowercased everywhere it appears`() {
        val plan = plan(PhotoSlotType.FRONT)
        assertEquals("ab-cd", plan.itemId)
        assertEquals("\"ab-cd\"", plan.item["id"].toString())
    }

    @Test
    fun `the payload carries only the placeholder identity`() {
        val plan = plan(PhotoSlotType.FRONT)
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
        val plan = CapturePublishPlan.build(state, itemId, owner, now)
        assertEquals(listOf(PhotoSlotType.FRONT), plan.uploads.map { it.slot })
    }
}
