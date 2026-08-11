package com.gradethread.app.measure

import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1576: the save semantics of the overlay editor.
 *
 * These are the functions whose output reaches a published listing and the
 * measurement-accuracy dataset, so they are tested without Hilt, Room, a
 * network or a Compose harness.
 */
class MeasureLinesTest {

    /** 100 px to the inch, no rotation — an inch of garment is 100 px of photo. */
    private val homography = listOf(
        0.01, 0.0, 0.0,
        0.0, 0.01, 0.0,
        0.0, 0.0, 1.0,
    )

    private fun calibration(lines: Map<String, StoredLine>?) = MeasureCalibration(
        v = 1,
        ppi = 100.0,
        homography = homography,
        lines = lines,
    )

    private fun stored(x1: Double, y1: Double, x2: Double, y2: Double, label: String = "") =
        StoredLine(e1 = listOf(x1, y1), e2 = listOf(x2, y2), label = label)

    private fun line(key: String, x1: Double, y1: Double, x2: Double, y2: Double) =
        MeasureGeometry.Line(
            key = key,
            label = key,
            e1 = MeasureGeometry.Point(x1, y1),
            e2 = MeasureGeometry.Point(x2, y2),
        )

    @Test
    fun `seed orders by the catalog, not by map iteration`() {
        val seeded = MeasureLines.seed(
            calibration(
                linkedMapOf(
                    "sleeve" to stored(0.0, 0.0, 100.0, 0.0),
                    "chest" to stored(0.0, 0.0, 200.0, 0.0),
                ),
            ),
        )
        // Catalog order, so reopening the editor never reshuffles the lines and
        // makes the seller re-find the one they were dragging.
        assertEquals(listOf("chest", "sleeve"), seeded.map { it.key })
    }

    @Test
    fun `seed drops a line whose endpoints are malformed`() {
        val seeded = MeasureLines.seed(
            calibration(
                mapOf(
                    "chest" to stored(0.0, 0.0, 200.0, 0.0),
                    "waist" to StoredLine(e1 = listOf(1.0), e2 = emptyList()),
                ),
            ),
        )
        assertEquals(listOf("chest"), seeded.map { it.key })
    }

    @Test
    fun `seed falls back to the catalog label when the stored one is blank`() {
        val seeded = MeasureLines.seed(calibration(mapOf("chest" to stored(0.0, 0.0, 1.0, 0.0))))
        assertEquals("Chest (pit to pit)", seeded.single().label)
    }

    @Test
    fun `an endpoint dragged past the edge is clamped to the image`() {
        val moved = MeasureLines.moved(
            listOf(line("chest", 0.0, 0.0, 100.0, 0.0)),
            index = 0,
            end = MeasureGeometry.End.E2,
            to = MeasureGeometry.Point(9000.0, -40.0),
            imgW = 800.0,
            imgH = 600.0,
        )
        // Not cosmetic: an endpoint off the photo still maps through the
        // homography and still publishes a number.
        assertEquals(800.0, moved.single().e2.x, 1e-9)
        assertEquals(0.0, moved.single().e2.y, 1e-9)
    }

    @Test
    fun `moving an index that does not exist leaves the lines alone`() {
        val lines = listOf(line("chest", 0.0, 0.0, 100.0, 0.0))
        assertEquals(
            lines,
            MeasureLines.moved(lines, 5, MeasureGeometry.End.E1, MeasureGeometry.Point(1.0, 1.0), 800.0, 600.0),
        )
    }

    @Test
    fun `adding a key that is already drawn is a no-op`() {
        val lines = listOf(line("chest", 0.0, 0.0, 100.0, 0.0))
        assertEquals(lines, MeasureLines.withAdded(lines, "chest", 800.0, 600.0))
        assertEquals(2, MeasureLines.withAdded(lines, "waist", 800.0, 600.0).size)
    }

    @Test
    fun `values come from the endpoints, never from the stored inches`() {
        // The stored number says 99; the endpoints say 2. The line is what the
        // seller is looking at, so the line wins.
        val seeded = MeasureLines.seed(
            calibration(mapOf("chest" to stored(0.0, 0.0, 200.0, 0.0).copy(inches = 99.0))),
        )
        assertEquals(2.0, MeasureLines.values(seeded, homography).getValue("chest"), 1e-9)
    }

    @Test
    fun `the stored document keeps original image pixels and a recomputed length`() {
        val doc = MeasureLines.storedDocument(listOf(line("chest", 10.0, 20.0, 210.0, 20.0)), homography)
        val chest = doc.getValue("chest").jsonObject
        assertEquals(10.0, chest.getValue("e1").jsonArray[0].jsonPrimitive.double, 1e-9)
        assertEquals(20.0, chest.getValue("e1").jsonArray[1].jsonPrimitive.double, 1e-9)
        assertEquals(2.0, chest.getValue("inches").jsonPrimitive.double, 1e-9)
        assertEquals("chest", chest.getValue("label").jsonPrimitive.content)
    }

    // ── corrections: the US-1582 accuracy dataset ────────────────────────

    private fun proposal(key: String, inches: Double, flagged: Boolean = false) =
        ProposedMeasurement(key = key, label = key, inches = inches, confidence = 0.8, flagged = flagged)

    @Test
    fun `only a touched line with a proposal behind it is a correction`() {
        val lines = listOf(
            line("chest", 0.0, 0.0, 200.0, 0.0), // touched, proposed → a correction
            line("waist", 0.0, 0.0, 300.0, 0.0), // proposed but left alone → agreement
            line("hip", 0.0, 0.0, 400.0, 0.0), // touched but drawn by hand → nothing to be wrong
        )
        val corrections = MeasureLines.corrections(
            lines = lines,
            proposals = mapOf("chest" to proposal("chest", 21.0), "waist" to proposal("waist", 3.0)),
            touched = setOf("chest", "hip"),
            homography = homography,
        )
        assertEquals(listOf("chest"), corrections.map { it.key })
        assertEquals(21.0, corrections.single().proposed, 1e-9)
        assertEquals(2.0, corrections.single().final, 1e-9)
    }

    @Test
    fun `an out-of-band row is dropped rather than failing the whole batch`() {
        val corrections = MeasureLines.corrections(
            // 300 inches across: the server rejects anything at or over 200 and
            // fails the WHOLE request, which would cost the good rows too.
            lines = listOf(line("chest", 0.0, 0.0, 30000.0, 0.0), line("waist", 0.0, 0.0, 200.0, 0.0)),
            proposals = mapOf("chest" to proposal("chest", 21.0), "waist" to proposal("waist", 19.0)),
            touched = setOf("chest", "waist"),
            homography = homography,
        )
        assertEquals(listOf("waist"), corrections.map { it.key })
    }

    @Test
    fun `a zero-length line is not a correction`() {
        val corrections = MeasureLines.corrections(
            lines = listOf(line("chest", 50.0, 50.0, 50.0, 50.0)),
            proposals = mapOf("chest" to proposal("chest", 21.0)),
            touched = setOf("chest"),
            homography = homography,
        )
        assertTrue(corrections.isEmpty())
    }

    @Test
    fun `the flag verdict rides along so the accuracy gate can slice by it`() {
        val corrections = MeasureLines.corrections(
            lines = listOf(line("chest", 0.0, 0.0, 200.0, 0.0)),
            proposals = mapOf("chest" to proposal("chest", 21.0, flagged = true)),
            touched = setOf("chest"),
            homography = homography,
        )
        assertEquals(true, corrections.single().flagged)
        assertEquals(0.8, corrections.single().confidence!!, 1e-9)
    }

    @Test
    fun `removing a key leaves the rest in order`() {
        val lines = listOf(line("chest", 0.0, 0.0, 1.0, 0.0), line("waist", 0.0, 0.0, 1.0, 0.0))
        val left = MeasureLines.withRemoved(lines, "chest")
        assertEquals(listOf("waist"), left.map { it.key })
        assertNull(left.firstOrNull { it.key == "chest" })
    }
}
