package com.gradethread.app.disclosure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1360: where a callout lands.
 *
 * This arithmetic decides whether a marker sits ON a flaw or next to it, in a
 * photo that goes to a buyer as evidence. Annotations are stored normalised
 * precisely so the phone preview, the uploaded PNG and the web all agree — so
 * the mapping is pinned here rather than eyeballed on a screen.
 */
class DisclosureGeometryTest {

    private fun annotation(
        n: Int = 1,
        bbox: List<Double>? = listOf(0.1, 0.2, 0.3, 0.4),
        severity: String = "minor",
        issue: String = "Pilling",
        location: String? = null,
    ) = PhotoAnnotation(n = n, issue = issue, severity = severity, location = location, bbox = bbox)

    // ── canvas ───────────────────────────────────────────────────────────────

    @Test
    fun `a large photo scales down to the cap, keeping its aspect`() {
        val size = DisclosureGeometry.canvasSize(1800, 1200)
        assertEquals(900f, size.width, 1e-3f)
        assertEquals(600f, size.height, 1e-3f)
    }

    @Test
    fun `a small photo is never scaled up`() {
        // Upscaling a small flaw photo makes it blurrier, not clearer — and the
        // whole point of this image is showing the flaw.
        val size = DisclosureGeometry.canvasSize(400, 300)
        assertEquals(400f, size.width, 1e-3f)
        assertEquals(300f, size.height, 1e-3f)
    }

    @Test
    fun `a degenerate image has no canvas rather than a crash`() {
        assertTrue(DisclosureGeometry.canvasSize(0, 500).isEmpty)
        assertTrue(DisclosureGeometry.canvasSize(500, 0).isEmpty)
    }

    // ── the normalised → pixel mapping ───────────────────────────────────────

    @Test
    fun `a normalised box maps into pixel space`() {
        val size = DisclosureGeometry.Size(900f, 600f)
        val rect = DisclosureGeometry.scaledRect(listOf(0.1, 0.2, 0.3, 0.4), size)!!
        assertEquals(90f, rect.left, 1e-3f)
        assertEquals(120f, rect.top, 1e-3f)
        assertEquals(270f, rect.width, 1e-3f)
        assertEquals(240f, rect.height, 1e-3f)
        assertEquals(360f, rect.right, 1e-3f)
        assertEquals(360f, rect.bottom, 1e-3f)
    }

    @Test
    fun `the same box lands proportionally at any render size`() {
        // The consistency the story asks for: a preview and the saved composite
        // put the marker on the same thread.
        val small = DisclosureGeometry.scaledRect(listOf(0.25, 0.5, 0.1, 0.1), DisclosureGeometry.Size(400f, 400f))!!
        val large = DisclosureGeometry.scaledRect(listOf(0.25, 0.5, 0.1, 0.1), DisclosureGeometry.Size(900f, 900f))!!
        assertEquals(small.left / 400f, large.left / 900f, 1e-6f)
        assertEquals(small.top / 400f, large.top / 900f, 1e-6f)
    }

    @Test
    fun `a malformed box draws nothing rather than something wrong`() {
        // A callout from bad coordinates points at the wrong part of the
        // garment, which is worse than no box — the legend still names it.
        val size = DisclosureGeometry.Size(900f, 600f)
        assertNull(DisclosureGeometry.scaledRect(null, size))
        assertNull(DisclosureGeometry.scaledRect(listOf(0.1, 0.2), size))
        assertNull(DisclosureGeometry.scaledRect(listOf(0.1, 0.2, 0.3, 0.4, 0.5), size))
        assertNull(DisclosureGeometry.scaledRect(listOf(0.1, Double.NaN, 0.3, 0.4), size))
        assertNull(
            DisclosureGeometry.scaledRect(listOf(0.1, 0.2, 0.3, 0.4), DisclosureGeometry.Size(0f, 0f)),
        )
    }

    @Test
    fun `an unlocalised annotation is legend-only`() {
        assertTrue(annotation().isLocalized)
        assertTrue(!annotation(bbox = null).isLocalized)
        assertTrue(!annotation(bbox = listOf(0.1, 0.2)).isLocalized)
    }

    // ── legend ───────────────────────────────────────────────────────────────

    @Test
    fun `the legend strip grows with the callouts`() {
        assertEquals(0f, DisclosureGeometry.legendHeight(0), 1e-3f)
        assertEquals(
            DisclosureGeometry.LEGEND_PADDING * 2 + 3 * DisclosureGeometry.LEGEND_LINE_HEIGHT,
            DisclosureGeometry.legendHeight(3),
            1e-3f,
        )
    }

    @Test
    fun `the composite is the photo plus its legend`() {
        val composite = DisclosureGeometry.compositeSize(1800, 1200, 2)
        assertEquals(900f, composite.width, 1e-3f)
        assertEquals(600f + DisclosureGeometry.legendHeight(2), composite.height, 1e-3f)
    }

    @Test
    fun `a photo with no callouts gets no legend strip`() {
        val composite = DisclosureGeometry.compositeSize(900, 600, 0)
        assertEquals(600f, composite.height, 1e-3f)
    }

    @Test
    fun `a legend line names the defect, where it is, and how bad`() {
        assertEquals(
            "2. Pilling — left cuff (moderate)",
            DisclosureGeometry.legendLine(
                annotation(n = 2, location = "left cuff", severity = "moderate"),
            ),
        )
        // No location recorded: the line still reads as a sentence.
        assertEquals("1. Pilling (minor)", DisclosureGeometry.legendLine(annotation()))
    }

    // ── severity colour ──────────────────────────────────────────────────────

    @Test
    fun `severity colours match the web, and an unknown one still draws`() {
        assertEquals(DisclosureGeometry.SeverityColor.MAJOR, DisclosureGeometry.SeverityColor.of("major"))
        assertEquals(DisclosureGeometry.SeverityColor.MAJOR, DisclosureGeometry.SeverityColor.of("MAJOR"))
        assertEquals(DisclosureGeometry.SeverityColor.MODERATE, DisclosureGeometry.SeverityColor.of("moderate"))
        assertEquals(DisclosureGeometry.SeverityColor.MINOR, DisclosureGeometry.SeverityColor.of("minor"))
        // An unrecognised severity falls back rather than rendering invisible.
        assertEquals(DisclosureGeometry.SeverityColor.MINOR, DisclosureGeometry.SeverityColor.of("catastrophic"))
    }
}
