package com.gradethread.app.ai

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334: the publish gate and the photo-URL build — the two places the
 * extraction can silently send nothing.
 */
class AiExtractGateTest {

    private val afterGrace = AiExtractGate.REGISTER_GRACE_MS

    @Test
    fun `nothing settles inside the registration grace window`() {
        // The uploads enqueue asynchronously; an empty settled set would
        // otherwise satisfy an all-of check vacuously on the first poll.
        assertFalse(AiExtractGate.isSettled(gate = emptySet(), settled = emptySet(), elapsedMs = 0))
        assertFalse(
            AiExtractGate.isSettled(
                gate = setOf(0, 1),
                settled = setOf(0, 1),
                elapsedMs = afterGrace - 1,
            ),
        )
    }

    @Test
    fun `the gate opens when every required photo has settled`() {
        assertTrue(
            AiExtractGate.isSettled(gate = setOf(0, 1), settled = setOf(0, 1), elapsedMs = afterGrace),
        )
    }

    @Test
    fun `a slow optional photo never holds the gate`() {
        // Front+back settled, the tag shot (2) still uploading.
        assertTrue(
            AiExtractGate.isSettled(gate = setOf(0, 1), settled = setOf(0, 1), elapsedMs = afterGrace),
        )
    }

    @Test
    fun `a required photo still in flight holds the gate`() {
        assertFalse(
            AiExtractGate.isSettled(gate = setOf(0, 1), settled = setOf(0), elapsedMs = afterGrace),
        )
    }

    @Test
    fun `a terminally failed required photo settles rather than spinning`() {
        // The caller unions landed rows with failed work; a dead required
        // photo must reach the retry prompt now, not in three minutes.
        assertTrue(
            AiExtractGate.isSettled(gate = setOf(0, 1), settled = setOf(0, 1), elapsedMs = afterGrace),
        )
    }

    @Test
    fun `the timeout wins over an unsettled gate`() {
        assertTrue(
            AiExtractGate.isSettled(
                gate = setOf(0, 1),
                settled = emptySet(),
                elapsedMs = AiExtractGate.TIMEOUT_MS,
            ),
        )
    }

    @Test
    fun `progress never reports more done than total`() {
        assertEquals(AiExtractPhase.Uploading(2, 2), AiExtractGate.progress(landed = 5, total = 2))
        assertEquals(AiExtractPhase.Uploading(0, 3), AiExtractGate.progress(landed = -1, total = 3))
    }

    // ── Photo URL building ───────────────────────────────────────────────

    private fun row(type: String, order: Int, url: String = "https://cdn/$type.jpg") =
        AiExtractPhotos.Row(
            photoType = type,
            photoUrl = if (type in setOf("tag", "certificate")) "" else url,
            storagePath = "u/i/${type}_1.jpg",
            sortOrder = order,
        )

    private val signAll: suspend (com.gradethread.app.upload.PhotoUpload.Bucket, String?, String) -> String? =
        { bucket, path, publicUrl ->
            if (bucket.isPublic) publicUrl.ifBlank { null } else "https://signed/$path?token=t"
        }

    @Test
    fun `private-bucket rows are signed, public rows pass through`() = runTest {
        val photos = AiExtractPhotos.build(
            rows = listOf(row("front", 0), row("tag", 1)),
            resolve = signAll,
        )
        assertEquals(listOf("front", "tag"), photos.map { it.type })
        assertTrue(photos[1].url.startsWith("https://signed/"))
        assertEquals("https://cdn/front.jpg", photos[0].url)
    }

    @Test
    fun `a row we cannot resolve is skipped, never sent unsigned`() = runTest {
        val photos = AiExtractPhotos.build(
            rows = listOf(row("front", 0), row("tag", 1)),
            resolve = { bucket, _, publicUrl ->
                if (bucket.isPublic) publicUrl else null // mint failed
            },
        )
        assertEquals(listOf("front"), photos.map { it.type })
    }

    @Test
    fun `the cap keeps the earliest sort orders`() = runTest {
        val rows = (0..11).map { row("detail", it, "https://cdn/$it.jpg") }.shuffled()
        val photos = AiExtractPhotos.build(rows = rows, resolve = signAll, max = 3)
        assertEquals(
            listOf("https://cdn/0.jpg", "https://cdn/1.jpg", "https://cdn/2.jpg"),
            photos.map { it.url },
        )
    }

    @Test
    fun `no rows means no photos, so the flow takes its bail branch`() = runTest {
        assertTrue(AiExtractPhotos.build(rows = emptyList(), resolve = signAll).isEmpty())
    }

    @Test
    fun `the MeasureCard frame never reaches the model, but a tape shot does`() = runTest {
        val photos = AiExtractPhotos.build(
            rows = listOf(
                row("front", 0),
                // No role: the calibration frame, a printed card beside the
                // garment. It would spend a photo slot on a foreign object.
                AiExtractPhotos.Row("measurement", "https://cdn/card.jpg", "u/i/m.jpg", 1),
                // A role: a tape close-up, which sellers publish on purpose.
                AiExtractPhotos.Row("measurement", "https://cdn/chest.jpg", "u/i/c.jpg", 2, "chest"),
                AiExtractPhotos.Row("internal", "https://cdn/price.jpg", "u/i/p.jpg", 3),
            ),
            resolve = signAll,
        )
        assertEquals(
            listOf("https://cdn/front.jpg", "https://cdn/chest.jpg"),
            photos.map { it.url },
        )
    }

    @Test
    fun `a public row with a blank url is dropped rather than sent empty`() = runTest {
        val photos = AiExtractPhotos.build(
            rows = listOf(AiExtractPhotos.Row("front", "", null, 0)),
            resolve = signAll,
        )
        assertTrue(photos.isEmpty())
        assertNull(photos.firstOrNull())
    }
}
