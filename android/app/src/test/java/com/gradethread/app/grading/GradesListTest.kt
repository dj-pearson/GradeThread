package com.gradethread.app.grading

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

import com.gradethread.app.sync.db.InventoryItemEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1341: which grades count, and what the average is allowed to claim.
 */
@RunWith(RobolectricTestRunner::class)
class GradesListTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun item(
        id: String,
        grade: Double? = null,
        certificateUrl: String? = "https://gradethread.com/cert/$id",
        gradeReportId: String? = "report-$id",
        updatedAt: Long = 0,
        disputeStatus: String? = null,
    ) = InventoryItemEntity(
        id = id,
        userId = "u1",
        title = "Item $id",
        brand = null,
        sku = null,
        size = null,
        color = null,
        material = null,
        status = "sourced",
        itemCategory = null,
        garmentType = null,
        garmentCategory = null,
        itemDescription = null,
        style = null,
        sourcedBy = null,
        acquiredDate = null,
        container = null,
        compSetJson = null,
        sourceId = null,
        locationBin = null,
        consignorId = null,
        consignmentSplitPct = null,
        acquiredPrice = null,
        targetPrice = null,
        listingPrice = null,
        gradeValue = grade,
        gradeLabel = null,
        certificateUrl = certificateUrl,
        gradeReportId = gradeReportId,
        disputeStatus = disputeStatus,
        conditionNotes = null,
        measurementsJson = null,
        primaryPhotoUrl = null,
        createdAt = 0,
        updatedAt = updatedAt,
    )

    /** A grade produced but withheld pending review: score, no cert, no report. */
    private fun provisional(id: String, grade: Double) = item(id, grade, certificateUrl = null, gradeReportId = null)

    @Test
    fun `only graded items are listed`() {
        val items = listOf(item("a", 8.0), item("b"), item("c", 6.5))
        assertEquals(listOf("a", "c"), GradesList.graded(items).map { it.id })
    }

    @Test
    fun `a provisional grade is detected from the denormalized row alone`() {
        // The list renders offline from Room, so this cannot consult the
        // report. A finalized grade always has a certificate or a report id.
        assertTrue(GradesList.isPendingReview(provisional("p", 7.0)))
        assertFalse(GradesList.isPendingReview(item("a", 7.0)))
        assertFalse(
            GradesList.isPendingReview(item("a", 7.0, certificateUrl = null)),
        )
        assertFalse(
            GradesList.isPendingReview(item("a", 7.0, gradeReportId = null)),
        )
    }

    @Test
    fun `an ungraded row is never pending review`() {
        assertFalse(
            GradesList.isPendingReview(item("x", null, certificateUrl = null, gradeReportId = null)),
        )
    }

    @Test
    fun `the average excludes provisional grades`() {
        // A provisional score can still be revised or withdrawn by the
        // reviewer, so averaging it would quote a portfolio number partly
        // built on grades that don't officially exist yet.
        val items = listOf(item("a", 8.0), item("b", 6.0), provisional("p", 2.0))
        assertEquals(7.0, GradesList.averageGrade(items)!!, 1e-9)
        assertEquals(listOf("a", "b"), GradesList.certified(items).map { it.id })
    }

    @Test
    fun `no certified grades means no average, not zero`() {
        // 0.0 renders as a grade, and a terrible one.
        assertNull(GradesList.averageGrade(listOf(provisional("p", 9.0))))
        assertNull(GradesList.averageGrade(emptyList()))
    }

    @Test
    fun `sorting covers recency and both score directions`() {
        val items = listOf(
            item("old-high", 9.0, updatedAt = 100),
            item("new-low", 4.0, updatedAt = 900),
            item("mid", 7.0, updatedAt = 500),
        )
        assertEquals(
            listOf("new-low", "mid", "old-high"),
            GradesList.sorted(items, GradesList.Sort.RECENT).map { it.id },
        )
        assertEquals(
            listOf("old-high", "mid", "new-low"),
            GradesList.sorted(items, GradesList.Sort.HIGHEST).map { it.id },
        )
        assertEquals(
            listOf("new-low", "mid", "old-high"),
            GradesList.sorted(items, GradesList.Sort.LOWEST).map { it.id },
        )
    }

    @Test
    fun `sorting drops ungraded items whatever the order`() {
        val items = listOf(item("a", 8.0), item("nope"), item("b", 3.0))
        GradesList.Sort.entries.forEach { sort ->
            assertEquals(sort.name, 2, GradesList.sorted(items, sort).size)
        }
    }

    @Test
    fun `provisional grades still appear in the list, just not the average`() {
        // Hiding them would leave a seller wondering where their grade went.
        val items = listOf(item("a", 8.0), provisional("p", 5.0))
        assertEquals(2, GradesList.sorted(items, GradesList.Sort.RECENT).size)
    }

    // ── the summary line ─────────────────────────────────────────────────

    @Test
    fun `the summary mentions pending grades only when there are some`() {
        val clean = GradesList.summarize(listOf(item("a", 8.0), item("b", 6.0)))
        assertEquals("2 graded · avg 7.0", clean.label.text(context))

        val mixed = GradesList.summarize(listOf(item("a", 8.0), provisional("p", 5.0)))
        assertEquals("2 graded · 1 pending review · avg 8.0", mixed.label.text(context))
    }

    @Test
    fun `an all-provisional summary quotes no average`() {
        val summary = GradesList.summarize(listOf(provisional("p", 5.0)))
        assertEquals("1 graded · 1 pending review", summary.label.text(context))
        assertEquals("—", summary.averageLabel)
    }

    /**
     * US-2976: the same line in Spanish.
     *
     * The English forms hide every plural mistake in this summary - "2 graded"
     * and "1 graded" differ only in the digit, so a translator who filled in
     * only the "other" form still passes every assertion above. Spanish
     * inflects both the total and the pending count.
     */
    @Test
    @Config(qualifiers = "es")
    fun `the Spanish summary agrees with its own numbers`() {
        val one = GradesList.summarize(listOf(provisional("p", 5.0)))
        assertEquals("1 evaluado · 1 pendiente de revisión", one.label.text(context))

        val many = GradesList.summarize(
            listOf(item("a", 8.0), item("b", 6.0), provisional("p", 5.0)),
        )
        assertEquals(
            "3 evaluados · 1 pendiente de revisión · media 7.0",
            many.label.text(context),
        )
    }

    @Test
    fun `an empty inventory summarizes to nothing rather than crashing`() {
        val summary = GradesList.summarize(emptyList())
        assertEquals(0, summary.total)
        assertEquals("0 graded", summary.label.text(context))
    }
}
