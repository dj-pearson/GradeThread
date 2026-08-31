package com.gradethread.app.grading

import com.gradethread.app.R

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1340: the dispute window, the composed reason, and the re-file gate.
 */
class DisputeTest {

    private val now = java.time.Instant.parse("2026-07-21T12:00:00Z").toEpochMilli()

    private fun daysAgo(days: Long): String =
        java.time.Instant.ofEpochMilli(now - days * 24 * 60 * 60 * 1000).toString()

    // ── the window ───────────────────────────────────────────────────────

    @Test
    fun `the window is seven days, matching web and iOS`() {
        // The story title says fourteen. Seven is what both shipped clients
        // enforce, and one product must not quote two different deadlines.
        assertEquals(7, GradeDisputeWindow.DAYS)
    }

    @Test
    fun `a fresh grade is disputable`() {
        assertTrue(GradeDisputeWindow.isOpen(daysAgo(0), now))
        assertTrue(GradeDisputeWindow.isOpen(daysAgo(6), now))
    }

    @Test
    fun `a grade older than the window is not`() {
        assertFalse(GradeDisputeWindow.isOpen(daysAgo(8), now))
        assertFalse(GradeDisputeWindow.isOpen(daysAgo(400), now))
    }

    @Test
    fun `an unusable timestamp fails OPEN, not closed`() {
        // Withholding a seller's only recourse over a formatting quirk would be
        // the worse error — and the server accepts the filing regardless.
        assertTrue(GradeDisputeWindow.isOpen(null, now))
        assertTrue(GradeDisputeWindow.isOpen("", now))
        assertTrue(GradeDisputeWindow.isOpen("not a date", now))
    }

    @Test
    fun `fractional-second timestamps parse`() {
        // The edge emits them, and strict parsers reject them outright.
        assertTrue(GradeDisputeWindow.isOpen("2026-07-21T11:59:59.123456Z", now))
        assertEquals(
            java.time.Instant.parse("2026-07-21T11:59:59.123456Z").toEpochMilli(),
            GradeDisputeWindow.parseIsoMillis("2026-07-21T11:59:59.123456Z"),
        )
    }

    @Test
    fun `an offset timestamp parses too`() {
        assertEquals(
            java.time.Instant.parse("2026-07-21T10:00:00Z").toEpochMilli(),
            GradeDisputeWindow.parseIsoMillis("2026-07-21T12:00:00+02:00"),
        )
    }

    @Test
    fun `days remaining counts down and floors at zero`() {
        assertEquals(7, GradeDisputeWindow.daysRemaining(daysAgo(0), now))
        assertEquals(1, GradeDisputeWindow.daysRemaining(daysAgo(6), now))
        assertEquals(0, GradeDisputeWindow.daysRemaining(daysAgo(30), now))
        assertNull(GradeDisputeWindow.daysRemaining("nonsense", now))
    }

    // ── the composed reason ──────────────────────────────────────────────

    @Test
    fun `a category with no details stores the category label`() {
        assertEquals(
            "Overall grade is too low",
            DisputeComposer.compose(DisputeReason.GRADE_TOO_LOW, "   "),
        )
    }

    @Test
    fun `a category with details stores both`() {
        assertEquals(
            "A factor score looks wrong — the fabric score ignores the lining",
            DisputeComposer.compose(
                DisputeReason.FACTOR_SCORE,
                "  the fabric score ignores the lining  ",
            ),
        )
    }

    @Test
    fun `Other stores only what the seller wrote`() {
        // Prefixing "Other (please explain)" to their explanation would put a
        // form label in front of a reviewer instead of the complaint.
        assertEquals(
            "The grader used the wrong reference photo entirely",
            DisputeComposer.compose(
                DisputeReason.OTHER,
                "The grader used the wrong reference photo entirely",
            ),
        )
    }

    @Test
    fun `Other requires a real explanation`() {
        assertFalse(DisputeComposer.canSubmit(DisputeReason.OTHER, ""))
        assertFalse(DisputeComposer.canSubmit(DisputeReason.OTHER, "wrong"))
        assertTrue(
            DisputeComposer.canSubmit(DisputeReason.OTHER, "x".repeat(DisputeComposer.OTHER_MIN_LENGTH)),
        )
    }

    @Test
    fun `every other category submits on its own`() {
        DisputeReason.entries.filter { it != DisputeReason.OTHER }.forEach { reason ->
            assertTrue(reason.name, DisputeComposer.canSubmit(reason, ""))
        }
    }

    @Test
    fun `reason wire values match the web constants`() {
        // The admin queue sorts on this string; a divergence splits one
        // complaint category into two.
        assertEquals(
            listOf(
                "grade_too_low",
                "design_as_damage",
                "defect_not_present",
                "missed_detail",
                "wrong_category",
                "factor_score",
                "other",
            ),
            DisputeReason.entries.map { it.wire },
        )
    }

    // ── status + the re-file gate ────────────────────────────────────────

    @Test
    fun `known statuses badge and unknown ones stay silent`() {
        assertEquals(R.string.dispute_status_open, DisputeStatusDisplay.label("open"))
        assertEquals(
            R.string.dispute_status_under_review,
            DisputeStatusDisplay.label("under_review"),
        )
        assertEquals(
            R.string.dispute_status_resolved,
            DisputeStatusDisplay.label("resolved"),
        )
        assertEquals(
            R.string.dispute_status_rejected,
            DisputeStatusDisplay.label("rejected"),
        )
        // Four statuses, four DIFFERENT ids - four copies of one would pass
        // every check above and badge every dispute the same way.
        assertEquals(
            4,
            listOf("open", "under_review", "resolved", "rejected")
                .mapNotNull(DisputeStatusDisplay::label)
                .toSet()
                .size,
        )
        // A future server enum value must not render a blank capsule.
        assertNull(DisputeStatusDisplay.label("escalated_to_legal"))
        assertNull(DisputeStatusDisplay.label(null))
        assertFalse(DisputeStatusDisplay.isDisputed("escalated_to_legal"))
    }

    @Test
    fun `an existing dispute blocks a second filing`() {
        // This gate is the ONLY thing preventing a duplicate: the edge route
        // performs no existing-dispute check and `disputes` carries no
        // uniqueness constraint on (user_id, grade_report_id).
        assertFalse(DisputeStatusDisplay.canFile("open"))
        assertFalse(DisputeStatusDisplay.canFile("under_review"))
        assertFalse(DisputeStatusDisplay.canFile("resolved"))
        assertTrue(DisputeStatusDisplay.canFile(null))
    }

    @Test
    fun `the request encodes the keys the edge reads`() {
        val encoded = gradingJson.encodeToString(
            DisputeRequest.serializer(),
            DisputeRequest(gradeReportId = "r1", reason = "too low"),
        )
        assertTrue(encoded.contains("\"gradeReportId\":\"r1\""))
        assertTrue(encoded.contains("\"reason\":\"too low\""))
    }

    @Test
    fun `the response surfaces rejected evidence rather than hiding it`() {
        val decoded = gradingJson.decodeFromString(
            DisputeResponse.serializer(),
            """{"dispute":{"id":"d1","grade_report_id":"r1","reason":"too low","status":"open"},
                "evidence_failures":2}""",
        )
        assertEquals(2, decoded.evidenceFailures)
        assertEquals("open", decoded.dispute.status)
    }
}
