package com.gradethread.app.measure

import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * US-1576: pure math for the measurement overlay editor — the Kotlin port of
 * `src/lib/measure-editor-math.ts`, which its own header names as THE SPEC.
 *
 * The homography maps ORIGINAL image pixels onto the MeasureCard's inch plane.
 * It comes from the server's US-1572 calibration; Android never re-implements
 * marker detection, so there is no computer vision here at all — just the
 * px↔inch mapping, hit-testing and default placements the editor needs to be
 * provable without a camera, a network or a Compose harness.
 *
 * Drift is pinned by `src/test/fixtures/measure-editor-math-cases.json`, read
 * by BOTH the vitest suite and [MeasureGeometryTest]. A source diff could never
 * be the guard: the three ports are in three languages with three point types.
 *
 * ⚠ ONE KNOWN DIVERGENCE, recorded rather than copied. The iOS port
 * (`MeasureGeometry.formatQuarter`) returns ASCII `"22 1/4"`; the web spec
 * returns the glyph `"22¼"`. Android follows the WEB, because the web file is
 * the declared spec and Roboto carries the vulgar-fraction glyphs. iOS is the
 * odd one out and nothing currently pins it — the fixture is there for a macOS
 * session to adopt.
 */
object MeasureGeometry {

    /** A point in ORIGINAL image pixels unless a caller says otherwise. */
    data class Point(val x: Double, val y: Double)

    /** One draggable measurement line, endpoints in ORIGINAL image pixels. */
    data class Line(
        val key: String,
        val label: String,
        val e1: Point,
        val e2: Point,
    )

    enum class End { E1, E2 }

    data class EndpointHit(val lineIndex: Int, val end: End)

    /**
     * Apply a row-major 3x3 homography.
     *
     * A malformed or degenerate matrix returns the input point rather than a
     * NaN: the editor draws whatever comes back, and a NaN endpoint takes the
     * whole Canvas down instead of showing one line in the wrong place.
     */
    fun applyHomography(h: List<Double>, x: Double, y: Double): Point {
        if (h.size != 9) return Point(x, y)
        val w = h[6] * x + h[7] * y + h[8]
        if (w == 0.0 || !w.isFinite()) return Point(x, y)
        return Point(
            (h[0] * x + h[1] * y + h[2]) / w,
            (h[3] * x + h[4] * y + h[5]) / w,
        )
    }

    fun roundQuarterInch(v: Double): Double = (v * 4).roundToLong() / 4.0

    /** Card-plane inches between two ORIGINAL-px endpoints, 0.25in steps. */
    fun inchesBetween(h: List<Double>, e1: Point, e2: Point): Double {
        val a = applyHomography(h, e1.x, e1.y)
        val b = applyHomography(h, e2.x, e2.y)
        return roundQuarterInch(hypot(a.x - b.x, a.y - b.y))
    }

    /** `22.25` → `22¼`, `0.5` → `½` — compact chip text. */
    fun formatQuarter(v: Double): String {
        val whole = floor(v).toLong()
        val frac = ((v - whole) * 4).roundToInt()
        val glyph = when (frac) {
            1 -> "¼"
            2 -> "½"
            3 -> "¾"
            else -> ""
        }
        if (glyph.isEmpty()) return whole.toString()
        return if (whole == 0L) glyph else "$whole$glyph"
    }

    /** Uniform display scale fitting the image inside maxW×maxH (never >1). */
    fun fitScale(imgW: Double, imgH: Double, maxW: Double, maxH: Double): Double {
        if (imgW <= 0.0 || imgH <= 0.0) return 1.0
        return min(1.0, min(maxW / imgW, maxH / imgH))
    }

    /**
     * Which endpoint (if any) a DISPLAY-space touch grabs.
     *
     * The default radius is 24dp, not the web's 14: a fingertip covers roughly
     * 9mm and a cursor covers one pixel, so matching the web number here would
     * make a line the seller can see and cannot grab.
     */
    fun hitEndpoint(
        lines: List<Line>,
        displayPoint: Point,
        scale: Double,
        radius: Double = TOUCH_RADIUS_DP,
    ): EndpointHit? {
        var best: EndpointHit? = null
        var bestDistance = radius
        lines.forEachIndexed { index, line ->
            for (end in End.entries) {
                val point = if (end == End.E1) line.e1 else line.e2
                val d = hypot(point.x * scale - displayPoint.x, point.y * scale - displayPoint.y)
                if (d <= bestDistance) {
                    bestDistance = d
                    best = EndpointHit(index, end)
                }
            }
        }
        return best
    }

    const val TOUCH_RADIUS_DP: Double = 24.0

    /** Keys that read as vertical on a flat-lay; everything else horizontal. */
    private val verticalKeys = setOf("length", "inseam", "rise", "sleeve", "insole")

    /**
     * A starting line for a measurement the auto pass did not place — centered,
     * 40% of the image span, along the key's natural axis. The seller drags it
     * into position; this only has to be grabbable.
     */
    fun defaultPlacement(key: String, imgW: Double, imgH: Double): Pair<Point, Point> {
        val cx = imgW / 2
        val cy = imgH / 2
        if (key in verticalKeys) {
            val span = imgH * 0.4
            return Point(cx, cy - span / 2) to Point(cx, cy + span / 2)
        }
        val span = imgW * 0.4
        return Point(cx - span / 2, cy) to Point(cx + span / 2, cy)
    }
}
