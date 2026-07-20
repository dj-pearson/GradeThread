package com.gradethread.app.ai

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.vision.SizeTagInference
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1334: the AI extraction call and its offline fallbacks.
 *
 * Routes to `functions.gradethread.com` via [EdgeApi] — NOT `api.*`, which
 * hosts only Supabase and would 404 every one of these paths.
 */
@Singleton
class AiExtractService @Inject constructor(
    /**
     * The `ai` profile, NOT `shared` — extraction takes ~20-40s and streams
     * nothing, so it needs the long-idle client. The shared profile's timeout
     * would abort a perfectly healthy call partway through.
     */
    @Named("ai") private val edge: EdgeApi,
) {

    companion object {
        const val EXTRACT_PATH = "/api/flipdesk/ai/extract"
        fun logPath(logId: String) = "/api/flipdesk/ai/log/$logId"

        /** Server-side cap; sending more is wasted upload and a 400 risk. */
        const val MAX_PHOTOS = 8
    }

    /**
     * Run an extraction.
     *
     * Uses the module-local [aiExtractJson] rather than [EdgeApi]'s shared
     * instance so the field-name map keys survive untouched.
     */
    suspend fun extract(request: AiExtractRequest): AiExtractResponse {
        val capped = request.copy(photos = request.photos.take(MAX_PHOTOS))
        val body = aiExtractJson.encodeToString(AiExtractRequest.serializer(), capped)
        val raw = edge.postRaw(EXTRACT_PATH, body)
        return aiExtractJson.decodeFromString(AiExtractResponse.serializer(), raw)
    }

    /**
     * Report what the seller kept. Fire-and-forget by design: this is a
     * training signal, and failing the seller's "Apply changes" because a
     * feedback POST failed would be indefensible.
     */
    suspend fun reportAcceptance(logId: String, feedback: AiLogFeedback) {
        runCatching {
            edge.patchRaw(
                logPath(logId),
                aiExtractJson.encodeToString(AiLogFeedback.serializer(), feedback),
            )
        }.onFailure {
            Telemetry.breadcrumb("AI acceptance report failed: ${it.message}", "ai-extract")
        }
    }

    /**
     * The post-success gap fill (US-1333 becomes live here).
     *
     * Runs ONLY when brand or size is still missing after a successful
     * extract, and merges only the missing one. A value the model or the
     * seller already provided is never recomputed, so on-device OCR can never
     * overwrite a stronger source.
     *
     * @param ocrLines lines already recognized from the tag photo.
     */
    fun mergeLiveTextGaps(
        response: AiExtractResponse,
        ocrLines: List<String>,
    ): AiExtractResponse {
        val brand = response.suggestions["brand"]?.value
        val size = response.suggestions["size"]?.value
        if (!SizeTagInference.needsInference(brand, size)) return response

        val inferred = SizeTagInference.infer(ocrLines, existingBrand = brand, existingSize = size)
        if (inferred.isEmpty) return response

        val merged = response.suggestions.toMutableMap()
        inferred.brand?.let { merged["brand"] = liveTextSuggestion(it) }
        inferred.size?.let { merged["size"] = liveTextSuggestion(it) }
        return response.copy(suggestions = merged)
    }

    /**
     * Build a response entirely from on-device OCR, for when there was no
     * server call at all — offline, or the extract failed.
     *
     * `actionsRemaining` is the UNKNOWN sentinel, not 0: no action was spent,
     * and showing "0 left" here would wrongly tell the seller they're out of
     * quota.
     */
    fun liveTextOnlyResponse(ocrLines: List<String>): AiExtractResponse? {
        val inferred = SizeTagInference.infer(ocrLines)
        if (inferred.isEmpty) return null
        val suggestions = buildMap {
            inferred.brand?.let { put("brand", liveTextSuggestion(it)) }
            inferred.size?.let { put("size", liveTextSuggestion(it)) }
        }
        return AiExtractResponse(
            suggestions = suggestions,
            actionsRemaining = AiExtractResponse.ACTIONS_REMAINING_UNKNOWN,
        )
    }

    private fun liveTextSuggestion(value: String) = FieldSuggestion(
        value = value,
        confidence = SizeTagInference.SUGGESTION_CONFIDENCE,
        source = "live-text",
    )
}

/** The item-level extraction phase (iOS `AIExtractionManager.Phase`). */
sealed class AiExtractPhase {
    data class Uploading(val done: Int, val total: Int) : AiExtractPhase()
    object Running : AiExtractPhase()
    object Ready : AiExtractPhase()
    data class Failed(val message: String) : AiExtractPhase()

    val isRunning: Boolean get() = this is Uploading || this is Running
}

/**
 * User-facing failure copy, mirroring iOS string-for-string.
 *
 * The offline and stuck-upload cases deliberately reassure that the photos
 * are SAVED — the common panic is that leaving the screen loses the capture.
 */
object AiExtractMessages {

    const val OFFLINE =
        "You're offline. Reconnect and reopen this item to let AI read your photos — " +
            "they're saved and waiting."

    const val NO_UPLOADS =
        "Your photos didn't finish uploading — check your connection, then tap Try again. " +
            "They're saved and keep retrying in the background."

    const val UNAVAILABLE =
        "AI extraction is temporarily unavailable. Please try again in a moment."

    /** Quota exhaustion is a plan state, not an error — it routes to upgrade. */
    fun forError(error: Throwable): String = when (error) {
        is EdgeApiError -> error.userMessage()
        else -> error.message ?: "Something went wrong. Please try again."
    }
}
