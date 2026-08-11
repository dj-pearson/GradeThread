package com.gradethread.app.measure

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-1576: the overlay-editor math, asserted against the SHARED fixture the
 * web suite reads (`src/test/fixtures/measure-editor-math-cases.json`).
 *
 * Reading the same file rather than transcribing its numbers is the whole
 * point: a transcription is a snapshot of the spec at the moment someone
 * copied it, and it goes stale silently. If the web changes a rule and does not
 * change the port, one of these cases turns red naming the function.
 */
class MeasureGeometryTest {

    private val fixture: JsonObject = loadFixture()
    private val homography: List<Double> =
        fixture.getValue("homography").jsonArray.map { it.jsonPrimitive.double }
    private val tolerance: Double = fixture.getValue("_tolerance").jsonPrimitive.double

    @Test
    fun `the fixture is the one the web suite reads`() {
        // A fixture that silently failed to load would make every case below
        // pass over an empty list, which is the failure mode a shared-file
        // guard is most exposed to.
        assertTrue("no applyHomography cases", cases("applyHomography").isNotEmpty())
        assertTrue("no hitEndpoint cases", cases("hitEndpoint").isNotEmpty())
        assertEquals(9, homography.size)
    }

    @Test
    fun `applyHomography matches the spec`() {
        for (case in cases("applyHomography")) {
            val out = case.getValue("out").jsonArray
            val got = MeasureGeometry.applyHomography(
                homography,
                case.num("x"),
                case.num("y"),
            )
            assertClose("applyHomography x", out[0].jsonPrimitive.double, got.x)
            assertClose("applyHomography y", out[1].jsonPrimitive.double, got.y)
        }
    }

    @Test
    fun `roundQuarterInch matches the spec`() {
        for (case in cases("roundQuarterInch")) {
            assertClose(
                "roundQuarterInch(${case.num("in")})",
                case.num("out"),
                MeasureGeometry.roundQuarterInch(case.num("in")),
            )
        }
    }

    @Test
    fun `formatQuarter matches the spec`() {
        for (case in cases("formatQuarter")) {
            assertEquals(
                "formatQuarter(${case.num("in")})",
                case.getValue("out").jsonPrimitive.content,
                MeasureGeometry.formatQuarter(case.num("in")),
            )
        }
    }

    @Test
    fun `fitScale matches the spec`() {
        for (case in cases("fitScale")) {
            assertClose(
                "fitScale",
                case.num("out"),
                MeasureGeometry.fitScale(
                    case.num("imgW"),
                    case.num("imgH"),
                    case.num("maxW"),
                    case.num("maxH"),
                ),
            )
        }
    }

    @Test
    fun `inchesBetween matches the spec`() {
        for (case in cases("inchesBetween")) {
            assertClose(
                "inchesBetween",
                case.num("out"),
                MeasureGeometry.inchesBetween(
                    homography,
                    case.point("e1"),
                    case.point("e2"),
                ),
            )
        }
    }

    @Test
    fun `hitEndpoint matches the spec`() {
        val lines = cases("hitEndpointLines").map { line ->
            MeasureGeometry.Line(
                key = line.getValue("key").jsonPrimitive.content,
                label = line.getValue("label").jsonPrimitive.content,
                e1 = line.point("e1"),
                e2 = line.point("e2"),
            )
        }
        for (case in cases("hitEndpoint")) {
            val got = MeasureGeometry.hitEndpoint(
                lines = lines,
                displayPoint = case.point("point"),
                scale = case.num("scale"),
                radius = case.num("radius"),
            )
            val expected = case.getValue("out")
            val label = "hitEndpoint(${case.getValue("point")}, r=${case.num("radius")})"
            if (expected is JsonNull) {
                assertNull(label, got)
                continue
            }
            assertNotNull(label, got)
            val want = expected.jsonObject
            assertEquals(label, want.getValue("lineIndex").jsonPrimitive.int, got!!.lineIndex)
            assertEquals(
                label,
                want.getValue("end").jsonPrimitive.content,
                if (got.end == MeasureGeometry.End.E1) "e1" else "e2",
            )
        }
    }

    @Test
    fun `defaultPlacement matches the spec`() {
        for (case in cases("defaultPlacement")) {
            val key = case.getValue("key").jsonPrimitive.content
            val (e1, e2) = MeasureGeometry.defaultPlacement(
                key,
                case.num("imgW"),
                case.num("imgH"),
            )
            assertClose("defaultPlacement $key e1.x", case.point("e1").x, e1.x)
            assertClose("defaultPlacement $key e1.y", case.point("e1").y, e1.y)
            assertClose("defaultPlacement $key e2.x", case.point("e2").x, e2.x)
            assertClose("defaultPlacement $key e2.y", case.point("e2").y, e2.y)
        }
    }

    // ── Behaviour the fixture deliberately does NOT carry ────────────────────

    @Test
    fun `a malformed homography returns the input point rather than a NaN`() {
        // The editor draws whatever comes back. A NaN endpoint takes the whole
        // Canvas down; a point in the wrong place is one visibly wrong line.
        val identityish = MeasureGeometry.applyHomography(listOf(1.0, 0.0, 0.0), 7.0, 9.0)
        assertEquals(7.0, identityish.x, 0.0)
        assertEquals(9.0, identityish.y, 0.0)

        val degenerate = listOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0)
        val out = MeasureGeometry.applyHomography(degenerate, 7.0, 9.0)
        assertEquals(7.0, out.x, 0.0)
        assertEquals(9.0, out.y, 0.0)
    }

    @Test
    fun `the default touch radius is wider than the web cursor radius`() {
        // 14dp is the web number; a fingertip covers roughly 9mm, so matching
        // it here would ship a line the seller can see and cannot grab.
        val lines = listOf(
            MeasureGeometry.Line("chest", "Chest", pt(100.0, 100.0), pt(500.0, 100.0)),
        )
        // chest.e1 shows at (50, 50); the point is 20dp away.
        val point = pt(70.0, 50.0)
        assertNull(MeasureGeometry.hitEndpoint(lines, point, 0.5, radius = 14.0))
        assertNotNull(MeasureGeometry.hitEndpoint(lines, point, 0.5))
        assertEquals(24.0, MeasureGeometry.TOUCH_RADIUS_DP, 0.0)
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun assertClose(what: String, expected: Double, actual: Double) {
        assertEquals(what, expected, actual, tolerance)
    }

    private fun cases(name: String): List<JsonObject> =
        (fixture.getValue(name) as JsonArray).map { it.jsonObject }

    private fun JsonObject.num(key: String): Double = getValue(key).jsonPrimitive.double

    private fun JsonObject.point(key: String): MeasureGeometry.Point {
        val arr = getValue(key).jsonArray
        return pt(arr[0].jsonPrimitive.double, arr[1].jsonPrimitive.double)
    }

    private fun pt(x: Double, y: Double) = MeasureGeometry.Point(x, y)

    private companion object {
        const val FIXTURE = "src/test/fixtures/measure-editor-math-cases.json"

        /**
         * Walk up from the test working directory (the Gradle module dir) to the
         * repo root. Hard-coding `../../` would work today and break the first
         * time the module moves, and the failure would read as "the math is
         * wrong" rather than "the file moved" — so the search names the path it
         * gave up on.
         */
        fun loadFixture(): JsonObject {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            val tried = mutableListOf<String>()
            while (dir != null) {
                val candidate = File(dir, FIXTURE)
                tried += candidate.path
                if (candidate.isFile) {
                    return Json.parseToJsonElement(candidate.readText(Charsets.UTF_8)).jsonObject
                }
                dir = dir.parentFile
            }
            throw AssertionError(
                "Shared fixture $FIXTURE not found. Looked at:\n" + tried.joinToString("\n"),
            )
        }
    }
}
