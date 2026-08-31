package com.gradethread.app.ai

import com.gradethread.app.ui.UiMessage

/**
 * US-1334: the extraction orchestration — WHAT happens in which order and
 * which fallback fires when.
 *
 * Follows the [com.gradethread.app.inventory.IntakeSubmission] pattern: all
 * decisions live here behind injected seams, so the branch order and every
 * fallback are testable without a network, a camera or a database.
 */
object AiExtractFlow {

    /** Telemetry names, matching iOS so the two clients share dashboards. */
    object Events {
        const val RUN_BEGIN = "ai_extract_run_begin"
        const val OFFLINE_LIVETEXT = "ai_extract_offline_livetext"
        const val PHOTOS_READY = "ai_extract_photos_ready"
        const val BAIL = "ai_extract_bail"
        const val NO_UPLOADS_LIVETEXT = "ai_extract_no_uploads_livetext"
        const val SUCCEEDED = "ai_extract_succeeded"
        const val USED = "ai_extract_used"
    }

    /** Why a run gave up before calling the server. */
    enum class BailReason(val wire: String) {
        OFFLINE("offline"),
        NO_UPLOADS("no_uploads"),
    }

    sealed class Outcome {
        /** A review is ready — from the server, from OCR, or both. */
        data class Ready(val review: AiExtractReview.Review, val usedLiveTextFallback: Boolean) : Outcome()

        data class Failed(val message: UiMessage) : Outcome()
    }

    /** One telemetry emission the caller forwards to Telemetry.event. */
    data class Emission(val name: String, val props: Map<String, Any?>)

    data class Result(val outcome: Outcome, val emissions: List<Emission>)

    /**
     * Run an extraction for one item.
     *
     * Branch order is deliberate and mirrors iOS:
     *  1. offline → on-device OCR only, no server call attempted;
     *  2. no photos finished uploading → OCR salvage;
     *  3. server call → on success, OCR fills only brand/size gaps;
     *  4. server error → OCR salvage, else fail.
     *
     * OCR is tried on every failure path because the seller has already taken
     * the photos — surfacing "we got nothing" while a readable tag sits in
     * the capture is the worst outcome available.
     *
     * @param ocrLines lazily produced; not evaluated unless a fallback needs it.
     */
    suspend fun run(
        itemId: String,
        isOnline: Boolean,
        photos: List<AiExtractPhoto>,
        existingValues: Map<String, String>,
        extract: suspend (List<AiExtractPhoto>) -> AiExtractResponse,
        ocrLines: suspend () -> List<String>,
        liveTextOnly: (List<String>) -> AiExtractResponse?,
        mergeGaps: (AiExtractResponse, List<String>) -> AiExtractResponse,
    ): Result {
        val emissions = mutableListOf<Emission>()
        emissions += Emission(
            Events.RUN_BEGIN,
            mapOf("item_id" to itemId, "captured" to photos.size, "offline" to !isOnline),
        )

        if (!isOnline) {
            val salvage = liveTextOnly(ocrLines())
            return if (salvage != null) {
                emissions += Emission(Events.OFFLINE_LIVETEXT, mapOf("item_id" to itemId))
                ready(itemId, salvage, existingValues, true, emissions)
            } else {
                emissions += Emission(
                    Events.BAIL,
                    mapOf(
                        "reason" to BailReason.OFFLINE.wire,
                        "item_id" to itemId,
                        "captured" to photos.size,
                    ),
                )
                Result(Outcome.Failed(AiExtractMessages.OFFLINE), emissions)
            }
        }

        emissions += Emission(
            Events.PHOTOS_READY,
            mapOf("item_id" to itemId, "ready" to photos.size, "captured" to photos.size),
        )

        if (photos.isEmpty()) {
            val salvage = liveTextOnly(ocrLines())
            return if (salvage != null) {
                emissions += Emission(Events.NO_UPLOADS_LIVETEXT, mapOf("item_id" to itemId))
                ready(itemId, salvage, existingValues, true, emissions)
            } else {
                emissions += Emission(
                    Events.BAIL,
                    mapOf(
                        "reason" to BailReason.NO_UPLOADS.wire,
                        "item_id" to itemId,
                        "captured" to photos.size,
                    ),
                )
                Result(Outcome.Failed(AiExtractMessages.NO_UPLOADS), emissions)
            }
        }

        val response = runCatching { extract(photos) }
        if (response.isFailure) {
            val error = response.exceptionOrNull() ?: IllegalStateException("unknown")
            val salvage = liveTextOnly(ocrLines())
            return if (salvage != null) {
                ready(itemId, salvage, existingValues, true, emissions)
            } else {
                Result(Outcome.Failed(AiExtractMessages.forError(error)), emissions)
            }
        }

        val raw = response.getOrThrow()
        emissions += Emission(
            Events.SUCCEEDED,
            mapOf("item_id" to itemId, "photos_sent" to photos.size),
        )

        // Gap fill runs only when brand or size is still missing, and the OCR
        // pass is skipped entirely when neither is.
        val brand = raw.suggestions["brand"]?.value
        val size = raw.suggestions["size"]?.value
        val merged: AiExtractResponse
        val usedLiveText: Boolean
        if (com.gradethread.app.vision.SizeTagInference.needsInference(brand, size)) {
            val lines = ocrLines()
            merged = mergeGaps(raw, lines)
            usedLiveText = merged.suggestions != raw.suggestions
        } else {
            merged = raw
            usedLiveText = false
        }

        return ready(itemId, merged, existingValues, usedLiveText, emissions)
    }

    private fun ready(
        itemId: String,
        response: AiExtractResponse,
        existingValues: Map<String, String>,
        usedLiveText: Boolean,
        emissions: MutableList<Emission>,
    ): Result = Result(
        Outcome.Ready(
            review = AiExtractReview.build(itemId, response, existingValues, usedLiveText),
            usedLiveTextFallback = usedLiveText,
        ),
        emissions,
    )

    /**
     * The acceptance telemetry, emitted when the seller applies the review.
     */
    fun usedEvent(
        review: AiExtractReview.Review,
        keptApplied: Set<String>,
        acceptedLowConfidence: Set<String>,
        keepMeasurements: Boolean,
        background: Boolean = false,
    ): Emission = Emission(
        Events.USED,
        mapOf(
            "fields_accepted" to keptApplied.size + acceptedLowConfidence.size,
            "measurements_accepted" to if (keepMeasurements) review.measurements.size else 0,
            "auto_applied" to review.applied.size,
            // What the seller left on the table — the signal that the bar may
            // be set wrong.
            "low_confidence_pending" to (review.lowConfidence.size - acceptedLowConfidence.size),
            "live_text_fallback" to review.usedLiveTextFallback,
            "background" to background,
        ),
    )
}
