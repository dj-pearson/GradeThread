package com.gradethread.app.ai

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.ui.text
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1334: extraction branch order and fallback behaviour.
 *
 * Every seam is injected, so this proves WHICH path runs and what is
 * reported, without a network, a camera or a database.
 */
@RunWith(RobolectricTestRunner::class)
class AiExtractFlowTest {

    // US-2976: the reassurance copy lives in strings.xml now, and these two
    // tests are about the WORDS - "saved and waiting" is the answer to the
    // panic that leaving the screen loses the capture. Asserting a resource id
    // would prove which branch ran and say nothing about whether the sentence
    // still reassures anybody.
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private val photo = AiExtractPhoto("https://x/1.jpg", "front")

    private val tagLines = listOf("PATAGONIA", "M")

    private suspend fun run(
        isOnline: Boolean = true,
        photos: List<AiExtractPhoto> = listOf(photo),
        extract: suspend (List<AiExtractPhoto>) -> AiExtractResponse = { AiExtractResponse() },
        ocr: List<String> = tagLines,
        existing: Map<String, String> = emptyMap(),
    ): AiExtractFlow.Result {
        var ocrCalls = 0
        return AiExtractFlow.run(
            itemId = "item-1",
            isOnline = isOnline,
            photos = photos,
            existingValues = existing,
            extract = extract,
            ocrLines = {
                ocrCalls++
                ocr
            },
            liveTextOnly = { lines -> liveTextOnly(lines) },
            mergeGaps = { response, lines -> mergeGaps(response, lines) },
        )
    }

    // Local stand-ins for the service helpers, which are themselves pure.
    private fun liveTextOnly(lines: List<String>): AiExtractResponse? {
        val inferred = com.gradethread.app.vision.SizeTagInference.infer(lines)
        if (inferred.isEmpty) return null
        return AiExtractResponse(
            suggestions = buildMap {
                inferred.brand?.let { put("brand", FieldSuggestion(it, 0.4, "live-text")) }
                inferred.size?.let { put("size", FieldSuggestion(it, 0.4, "live-text")) }
            },
        )
    }

    private fun mergeGaps(response: AiExtractResponse, lines: List<String>): AiExtractResponse {
        val inferred = com.gradethread.app.vision.SizeTagInference.infer(
            lines,
            existingBrand = response.suggestions["brand"]?.value,
            existingSize = response.suggestions["size"]?.value,
        )
        if (inferred.isEmpty) return response
        val merged = response.suggestions.toMutableMap()
        inferred.brand?.let { merged["brand"] = FieldSuggestion(it, 0.4, "live-text") }
        inferred.size?.let { merged["size"] = FieldSuggestion(it, 0.4, "live-text") }
        return response.copy(suggestions = merged)
    }

    private fun names(result: AiExtractFlow.Result) = result.emissions.map { it.name }

    // ── offline ──────────────────────────────────────────────────────────

    @Test
    fun offline_neverCallsTheServerAndSalvagesWithOcr() = runTest {
        val result = run(
            isOnline = false,
            // Would blow up if the server were called at all.
            extract = { error("server must not be called offline") },
        )
        val ready = result.outcome as AiExtractFlow.Outcome.Ready
        assertTrue(ready.usedLiveTextFallback)
        assertEquals("Patagonia", ready.review.lowConfidence.first { it.field == "brand" }.suggestion.value)
        assertTrue(AiExtractFlow.Events.OFFLINE_LIVETEXT in names(result))
    }

    @Test
    fun offline_withAnUnreadableTagFailsWithTheReassuringCopy() = runTest {
        val result = run(isOnline = false, ocr = listOf("MADE IN VIETNAM"), extract = { error("no") })
        val failed = result.outcome as AiExtractFlow.Outcome.Failed
        // The common panic is that leaving the screen loses the capture.
        assertTrue(failed.message.text(context).contains("saved and waiting"))
        val bail = result.emissions.single { it.name == AiExtractFlow.Events.BAIL }
        assertEquals("offline", bail.props["reason"])
    }

    // ── no uploads ───────────────────────────────────────────────────────

    @Test
    fun noPhotosUploaded_salvagesWithOcr() = runTest {
        val result = run(photos = emptyList(), extract = { error("server must not be called") })
        assertTrue(result.outcome is AiExtractFlow.Outcome.Ready)
        assertTrue(AiExtractFlow.Events.NO_UPLOADS_LIVETEXT in names(result))
    }

    @Test
    fun noPhotosAndNoOcr_failsWithTheUploadCopy() = runTest {
        val result = run(
            photos = emptyList(),
            ocr = emptyList(),
            extract = { error("server must not be called") },
        )
        val failed = result.outcome as AiExtractFlow.Outcome.Failed
        assertTrue(failed.message.text(context).contains("keep retrying in the background"))
        val bail = result.emissions.single { it.name == AiExtractFlow.Events.BAIL }
        assertEquals("no_uploads", bail.props["reason"])
    }

    // ── server success ───────────────────────────────────────────────────

    @Test
    fun success_withBothFieldsSkipsOcrEntirely() = runTest {
        var ocrCalls = 0
        val result = AiExtractFlow.run(
            itemId = "i",
            isOnline = true,
            photos = listOf(photo),
            existingValues = emptyMap(),
            extract = {
                AiExtractResponse(
                    suggestions = mapOf(
                        "brand" to FieldSuggestion("Nike", 0.9, "photo:tag"),
                        "size" to FieldSuggestion("L", 0.9, "photo:tag"),
                    ),
                )
            },
            ocrLines = {
                ocrCalls++
                tagLines
            },
            liveTextOnly = { liveTextOnly(it) },
            mergeGaps = { r, l -> mergeGaps(r, l) },
        )
        // The whole point of the gate: no wasted decode when nothing is missing.
        assertEquals(0, ocrCalls)
        val ready = result.outcome as AiExtractFlow.Outcome.Ready
        assertFalse(ready.usedLiveTextFallback)
    }

    @Test
    fun success_withAMissingSizeFillsOnlyThatGap() = runTest {
        val result = run(
            extract = {
                AiExtractResponse(
                    suggestions = mapOf("brand" to FieldSuggestion("Nike", 0.9, "photo:tag")),
                )
            },
        )
        val ready = result.outcome as AiExtractFlow.Outcome.Ready
        // The server's brand survives — OCR read "Patagonia" but must not win.
        assertEquals("Nike", ready.review.applied.single { it.field == "brand" }.value)
        // ...and the missing size is filled from the tag, below the bar.
        assertEquals("M", ready.review.lowConfidence.single { it.field == "size" }.suggestion.value)
        assertTrue(ready.usedLiveTextFallback)
    }

    @Test
    fun success_emitsSucceededWithThePhotoCount() = runTest {
        val result = run(photos = listOf(photo, photo))
        val event = result.emissions.single { it.name == AiExtractFlow.Events.SUCCEEDED }
        assertEquals(2, event.props["photos_sent"])
    }

    // ── server failure ───────────────────────────────────────────────────

    @Test
    fun serverError_fallsBackToOcrRatherThanFailing() = runTest {
        val result = run(extract = { throw RuntimeException("502") })
        val ready = result.outcome as AiExtractFlow.Outcome.Ready
        assertTrue(ready.usedLiveTextFallback)
        assertEquals("Patagonia", ready.review.lowConfidence.first { it.field == "brand" }.suggestion.value)
    }

    @Test
    fun serverError_withNoOcrSalvageSurfacesTheError() = runTest {
        val result = run(
            extract = { throw RuntimeException("boom") },
            ocr = listOf("NOTHING USEFUL"),
        )
        assertTrue(result.outcome is AiExtractFlow.Outcome.Failed)
    }

    // ── telemetry ────────────────────────────────────────────────────────

    @Test
    fun everyRunOpensWithRunBegin() = runTest {
        assertEquals(AiExtractFlow.Events.RUN_BEGIN, names(run()).first())
    }

    @Test
    fun usedEventReportsWhatTheSellerLeftOnTheTable() {
        val review = AiExtractReview.build(
            "i",
            AiExtractResponse(
                suggestions = mapOf(
                    "brand" to FieldSuggestion("Nike", 0.9, "photo:tag"),
                    "size" to FieldSuggestion("M", 0.4, "live-text"),
                    "color" to FieldSuggestion("Red", 0.4, "photo:front"),
                ),
                measurements = mapOf("chest" to 21.0),
            ),
        )
        val emission = AiExtractFlow.usedEvent(
            review = review,
            keptApplied = setOf("brand"),
            acceptedLowConfidence = setOf("size"),
            keepMeasurements = true,
        )
        assertEquals(2, emission.props["fields_accepted"])
        assertEquals(1, emission.props["measurements_accepted"])
        assertEquals(1, emission.props["auto_applied"])
        // One low-confidence row was offered and declined — the signal that
        // the auto-apply bar may be set wrong.
        assertEquals(1, emission.props["low_confidence_pending"])
    }

    @Test
    fun usedEventReportsZeroMeasurementsWhenTheyAreDropped() {
        val review = AiExtractReview.build(
            "i",
            AiExtractResponse(measurements = mapOf("chest" to 21.0, "length" to 28.0)),
        )
        val emission = AiExtractFlow.usedEvent(review, emptySet(), emptySet(), keepMeasurements = false)
        assertEquals(0, emission.props["measurements_accepted"])
    }
}
