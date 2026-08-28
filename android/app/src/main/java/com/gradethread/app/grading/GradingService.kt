package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1336: the grading bridge —
 *   1. `POST /api/flipdesk/grading/validate`        → readiness + plan/credits
 *   2. `POST /api/flipdesk/grading/submit`          → create the submission
 *   3. `GET  /api/flipdesk/grading/submissions/:id` → poll status + report
 */
@Singleton
class GradingService @Inject constructor(
    /**
     * The `shared` profile, NOT `ai` — every call here returns promptly. The
     * model work happens behind [status], which is polled; holding these on the
     * long-idle client would only delay surfacing a real network failure
     * (iOS US-1407).
     */
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        const val VALIDATE_PATH = "/api/flipdesk/grading/validate"
        const val SUBMIT_PATH = "/api/flipdesk/grading/submit"
        fun statusPath(submissionRef: String) = "/api/flipdesk/grading/submissions/$submissionRef"
    }

    suspend fun validate(inventoryItemId: String, tier: GradeTier): GradingValidateResponse =
        decode(
            edge.postRaw(VALIDATE_PATH, encode(inventoryItemId, tier)),
            GradingValidateResponse.serializer(),
        )

    suspend fun submit(inventoryItemId: String, tier: GradeTier): GradingSubmitResponse =
        decode(
            edge.postRaw(SUBMIT_PATH, encode(inventoryItemId, tier)),
            GradingSubmitResponse.serializer(),
        )

    suspend fun status(submissionRef: String): GradingStatusResponse =
        decode(edge.getRaw(statusPath(submissionRef)), GradingStatusResponse.serializer())

    // ── Batch (US-1339) ──────────────────────────────────────────────────

    suspend fun validateBatch(
        inventoryItemIds: List<String>,
        tier: GradeTier,
    ): GradingValidateResponse = decode(
        edge.postRaw(VALIDATE_PATH, encodeBatch(inventoryItemIds, tier)),
        GradingValidateResponse.serializer(),
    )

    suspend fun submitBatch(
        inventoryItemIds: List<String>,
        tier: GradeTier,
    ): GradingSubmitResponse = decode(
        edge.postRaw(SUBMIT_PATH, encodeBatch(inventoryItemIds, tier)),
        GradingSubmitResponse.serializer(),
    )

    private fun encodeBatch(inventoryItemIds: List<String>, tier: GradeTier): String =
        gradingJson.encodeToString(
            GradingRequestBody.serializer(),
            GradingRequestBody.batch(inventoryItemIds, tier),
        )

    private fun encode(inventoryItemId: String, tier: GradeTier): String =
        gradingJson.encodeToString(
            GradingRequestBody.serializer(),
            GradingRequestBody.single(inventoryItemId, tier),
        )

    /**
     * Decode, mapping a parse failure to [EdgeApiError.Decoding].
     *
     * That mapping is the point, not boilerplate: the poll loop treats a decode
     * failure as "server reachable, payload incomplete" and keeps going, while
     * anything else counts toward the lost-connection streak. A raw
     * SerializationException escaping here would be indistinguishable from an
     * unreachable server and would end a healthy grade in an error state.
     */
    private fun <T> decode(
        raw: String,
        serializer: kotlinx.serialization.DeserializationStrategy<T>,
    ): T = try {
        gradingJson.decodeFromString(serializer, raw)
    } catch (t: Throwable) {
        throw EdgeApiError.Decoding(t.message ?: "unparseable grading response", t)
    }
}
