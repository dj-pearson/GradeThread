package com.gradethread.app.money

import com.gradethread.app.platform.net.EdgeApi
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-3000 AC2: reading a receipt on the phone uses the SAME edge extraction the
 * web uses.
 *
 * There is one prompt, one model, one set of confidence rules and one staging
 * boundary, and they live on the server. A second implementation here would
 * drift the first time either side was tuned, and the seller would get two
 * different answers from the same photo depending on which screen they were on.
 *
 * So this file is a transport and nothing else. It does not decide what a
 * receipt says, does not score confidence, and does not write an expense: the
 * model PROPOSES and the seller confirms, which is US-2993 AC1 and is not a
 * formality -- a wrong number nobody looked at is worse than no number, because
 * nobody checks it again.
 *
 * Routes to `functions.gradethread.com` via [EdgeApi]. NOT `api.*`, which hosts
 * only Supabase and would 404 every one of these paths.
 */
@Singleton
class ReceiptScanService @Inject constructor(
    /**
     * The `ai` profile, NOT `shared`. Reading a receipt is a vision call and
     * takes tens of seconds; the shared profile's timeout would abort a
     * perfectly healthy extraction partway through and report it as a failure.
     */
    @Named("ai") private val edge: EdgeApi,
) {

    /**
     * Send a photo to be read.
     *
     * The server stages the image and returns where it parked it. Nothing is
     * attached to an expense until the seller confirms one, so an abandoned
     * scan leaves a staged file and no ledger row rather than the reverse.
     */
    suspend fun scan(bytes: ByteArray, mimeType: String = "image/jpeg"): ScanResult {
        val raw = edge.postMultipartImage(
            path = EXTRACT_PATH,
            fieldName = "receipt",
            fileName = "receipt.${extensionFor(mimeType)}",
            mimeType = mimeType,
            bytes = bytes,
        )
        return json.decodeFromString(ScanResult.serializer(), raw)
    }

    /** Attach a staged photo to the expense the seller just confirmed. */
    suspend fun adoptStaged(expenseId: String, stagingPath: String) {
        edge.postRaw(
            adoptPath(expenseId),
            json.encodeToString(AdoptRequest.serializer(), AdoptRequest(stagingPath)),
        )
    }

    companion object {
        const val EXTRACT_PATH = "/api/flipdesk/expenses/extract"

        fun adoptPath(expenseId: String) = "/api/flipdesk/expenses/$expenseId/adopt-staged"

        /**
         * The server sniffs by magic bytes and ignores what we claim (US-276),
         * so this only names the file sensibly in storage.
         */
        fun extensionFor(mimeType: String): String = when (mimeType.lowercase()) {
            "image/png" -> "png"
            "image/webp" -> "webp"
            "application/pdf" -> "pdf"
            else -> "jpg"
        }

        /**
         * Lenient on purpose. The server owns this contract and will grow
         * fields; a strict decoder here would turn every server improvement
         * into a client crash.
         */
        private val json = Json { ignoreUnknownKeys = true }
    }
}

@Serializable
data class ScannedLine(val description: String? = null, @SerialName("amount_cents") val amountCents: Long = 0)

@Serializable
data class ScannedDraft(
    val vendor: String? = null,
    /** A bare `YYYY-MM-DD`. Parsed through CalendarDateField, never elsewhere. */
    @SerialName("spent_on") val spentOn: String? = null,
    @SerialName("total_cents") val totalCents: Long? = null,
    @SerialName("tax_cents") val taxCents: Long? = null,
    val category: String? = null,
    val lines: List<ScannedLine> = emptyList(),
)

@Serializable
data class ScanResult(
    /** Where the photo is parked until an expense exists to attach it to. */
    @SerialName("staging_path") val stagingPath: String,
    val draft: ScannedDraft? = null,
    val confidence: Map<String, Double> = emptyMap(),
    @SerialName("low_confidence") val lowConfidence: List<String> = emptyList(),
    /** Total less tax less the sum of lines. Non-zero means it read partially. */
    @SerialName("lines_gap_cents") val linesGapCents: Long? = null,
    @SerialName("prompt_version") val promptVersion: String? = null,
    val warning: String? = null,
) {

    /**
     * A scan that produced nothing usable.
     *
     * A blurred photo, a crumpled receipt or a model that simply could not read
     * it are all the same outcome to the seller: type it in. Saying "the AI
     * failed" invites a retry that will fail the same way.
     */
    val readAnything: Boolean
        get() = draft?.totalCents != null || draft?.vendor != null

    /**
     * Turn what was read into a form the seller then CONFIRMS.
     *
     * Every field the model was unsure about is still filled in -- blanking it
     * would make the seller retype something the model got right -- but the
     * caller is expected to mark those fields so the seller looks at them.
     */
    fun toDraft(): ExpenseDraft {
        val d = draft
        val spentOn = d?.spentOn
            ?.let { CalendarDateField.parseIso(it) }
            ?: CalendarDateField.todayMs()
        return ExpenseDraft(
            category = d?.category?.takeIf { it.isNotBlank() } ?: ExpenseDraft.DEFAULT_CATEGORY,
            // Cents to the raw text the amount field holds, at 2dp, because the
            // field is the seller's typing and not a number until they save.
            amountText = d?.totalCents
                ?.let { String.format(java.util.Locale.ROOT, "%d.%02d", it / 100, it % 100) }
                .orEmpty(),
            description = d?.vendor.orEmpty(),
            spentOnMs = spentOn,
        )
    }
}

@Serializable
private data class AdoptRequest(@SerialName("staging_path") val stagingPath: String)
