package com.gradethread.app.snap

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1335: the Snap wire contract and the result card's display rules.
 */
@RunWith(RobolectricTestRunner::class)
class SnapTest {

    // US-2976: every one of these five is named for the WORDS - "the subtitle
    // says so", "reads as thin comps", "capitalizes the wire tier". They
    // render rather than checking resource ids.
    private val context = ApplicationProvider.getApplicationContext<Context>()

    // ── Wire ─────────────────────────────────────────────────────────────

    /** A full response as the edge actually emits it — note the two casings. */
    private val fullBody = """
        {
          "grade": {
            "overall_score": 8.4,
            "grade_tier": "excellent",
            "confidence": 0.87,
            "factor_scores": {"fabric": 8.5}
          },
          "value": {
            "lowCents": 3200,
            "medianCents": 4500,
            "highCents": 6100,
            "sampleSize": 24,
            "confidence": 0.7,
            "sufficient": true,
            "currency": "USD"
          },
          "garment": {"type": "tops", "category": "sweater"},
          "estimate": true,
          "disclaimer": "This is an AI condition + value ESTIMATE."
        }
    """.trimIndent()

    private fun decode(body: String) = snapJson.decodeFromString(SnapResponse.serializer(), body)

    @Test
    fun `the snake_case envelope and the camelCase value block both decode`() {
        // This is the assertion that would fail the moment someone "tidies"
        // this module with a global snake_case naming strategy: the envelope
        // would still parse and the value block would silently null out.
        val response = decode(fullBody)
        assertEquals(8.4, response.grade.overallScore, 0.001)
        assertEquals("excellent", response.grade.gradeTier)
        assertNotNull(response.value)
        assertEquals(3200, response.value?.lowCents)
        assertEquals(24, response.value?.sampleSize)
    }

    @Test
    fun `unknown response fields do not break decoding`() {
        // factor_scores and estimate are present above and modelled by neither
        // client; the server adds fields ahead of us routinely.
        assertEquals("tops", decode(fullBody).garment?.type)
    }

    @Test
    fun `a grade-only response decodes with a null value`() {
        val response = decode(
            """{"grade":{"overall_score":6.0,"grade_tier":"good","confidence":0.5},
               "value":null,"disclaimer":"x"}""",
        )
        assertNull(response.value)
        assertEquals(6.0, response.grade.overallScore, 0.001)
    }

    @Test
    fun `the request omits blank hints rather than sending empty strings`() {
        val encoded = snapJson.encodeToString(
            SnapRequest.serializer(),
            SnapRequest(image = "data:image/jpeg;base64,AA", brand = null, keyword = null),
        )
        assertFalse(encoded.contains("brand"))
        assertFalse(encoded.contains("keyword"))
        assertTrue(encoded.contains("data:image/jpeg;base64,AA"))
    }

    // ── Display ──────────────────────────────────────────────────────────

    private val sufficient = SnapValue(
        lowCents = 3200,
        medianCents = 4500,
        highCents = 6100,
        sampleSize = 24,
        confidence = 0.7,
        sufficient = true,
    )

    @Test
    fun `a sufficient value renders the low-to-high range`() {
        assertEquals("$32.00–$61.00", SnapDisplay.valueRange(sufficient))
    }

    @Test
    fun `a sufficient set with no median is not quoted`() {
        // Sufficient without a middle is a wider claim than the data supports.
        assertEquals(
            SnapDisplay.NO_VALUE,
            SnapDisplay.valueRange(sufficient.copy(medianCents = null)),
        )
    }

    @Test
    fun `an insufficient comp set is not quoted`() {
        assertEquals(
            SnapDisplay.NO_VALUE,
            SnapDisplay.valueRange(sufficient.copy(sufficient = false)),
        )
    }

    @Test
    fun `no hints means we never looked, and the subtitle says so`() {
        // The edge only comps when it has a brand or a keyword, so "not enough
        // comps" here would be a lie about work we didn't do.
        assertEquals(
            "add a brand or item to see value",
            SnapDisplay.valueSubtitle(null, hasHints = false).text(context),
        )
    }

    @Test
    fun `hints with a thin comp set reads as thin comps`() {
        assertEquals(
            "not enough comps to value yet",
            SnapDisplay.valueSubtitle(sufficient.copy(sufficient = false), hasHints = true).text(context),
        )
    }

    @Test
    fun `a quoted value explains what the number means`() {
        assertEquals(
            "est. resale value at this condition",
            SnapDisplay.valueSubtitle(sufficient, hasHints = true).text(context),
        )
    }

    @Test
    fun `the grade subtitle capitalizes the wire tier and rounds confidence`() {
        val grade = SnapGrade(overallScore = 8.44, gradeTier = "excellent", confidence = 0.876)
        assertEquals("Excellent · 88% confidence", SnapDisplay.gradeSubtitle(grade).text(context))
        assertEquals("8.4", SnapDisplay.scoreText(grade))
    }

    @Test
    fun `a nonsense confidence cannot render over 100 percent`() {
        val grade = SnapGrade(overallScore = 9.0, gradeTier = "mint", confidence = 4.2)
        assertEquals("Mint · 100% confidence", SnapDisplay.gradeSubtitle(grade).text(context))
    }
}
