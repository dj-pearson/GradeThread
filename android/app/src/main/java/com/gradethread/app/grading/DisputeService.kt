package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.from
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Base64
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1340: filing a grade dispute.
 *
 * The filing goes through the EDGE, not straight to Supabase, and that is not
 * incidental: evidence photos have to be magic-byte validated and EXIF-stripped
 * before storage (US-276), and a dispute belongs to the WORKSPACE OWNER — a
 * member's direct insert would fail RLS outright. The edge does both.
 */
@Singleton
class DisputeService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    private val client: SupabaseClient,
) {

    companion object {
        const val DISPUTE_PATH = "/api/grade/dispute"

        /** `MAX_DISPUTE_EVIDENCE` on the edge. */
        const val MAX_EVIDENCE = 8
    }

    /**
     * File a dispute.
     *
     * Evidence is encoded off the caller's thread — the same reason Snap does
     * it: base64 inflates a couple of megabytes by a third, and the sheet is
     * showing a spinner it should not be blocking.
     */
    suspend fun file(
        gradeReportId: String,
        reason: String,
        evidence: List<File> = emptyList(),
    ): DisputeResponse {
        val body = withContext(Dispatchers.Default) {
            val images = evidence.take(MAX_EVIDENCE).mapNotNull { file ->
                runCatching {
                    "data:image/jpeg;base64," +
                        Base64.getEncoder().encodeToString(file.readBytes())
                }.getOrNull()
            }
            gradingJson.encodeToString(
                DisputeRequest.serializer(),
                DisputeRequest(gradeReportId = gradeReportId, reason = reason, images = images),
            )
        }
        val raw = edge.postRaw(DISPUTE_PATH, body)
        return try {
            gradingJson.decodeFromString(DisputeResponse.serializer(), raw)
        } catch (t: Throwable) {
            throw EdgeApiError.Decoding(t.message ?: "unparseable dispute response", t)
        }
    }

    /**
     * The existing dispute for a report, if any.
     *
     * Read through the ANON client so RLS scopes it to the caller. This is what
     * powers the re-file gate — and it is the ONLY thing preventing a duplicate:
     * the edge route performs no existing-dispute check, and `disputes` carries
     * no uniqueness constraint on (user_id, grade_report_id).
     */
    suspend fun existing(gradeReportId: String): DisputeRow? =
        runCatching {
            client.from("disputes").select {
                filter { eq("grade_report_id", gradeReportId) }
                limit(1)
            }.decodeList<DisputeRow>().firstOrNull()
        }.getOrNull()
}
