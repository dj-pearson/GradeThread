package com.gradethread.app.autolister

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1359: the AutoLister batch API.
 *
 * The AI client (120s read timeout) is deliberate for the two vision passes —
 * classify and QA both run a model per photo, and the 20s shared timeout would
 * fail them while the server was still working.
 */
@Singleton
class AutolisterService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
    @Named("ai") private val aiEdge: EdgeApi,
) {

    companion object {
        private const val BASE = "/api/flipdesk/autolister"
        const val BATCH_PATH = "$BASE/batch"
        const val CLASSIFY_PATH = "$BASE/classify-photos"
        const val PHOTO_QA_PATH = "$BASE/photo-qa"

        // US-2408: the multi-item session.
        const val STAGING_UPLOAD_PATH = "$BASE/staging/upload"
        const val SESSIONS_PATH = "$BASE/sessions"
        const val PROPOSE_GROUPS_PATH = "$BASE/propose-groups"
        const val VERIFY_GROUPS_PATH = "$BASE/verify-groups"
        const val PLATFORM_FIELDS_PATH = "$BASE/platform-fields"

        fun batchPath(id: String) = "$BATCH_PATH/$id"
        fun retryFailedPath(id: String) = "$BATCH_PATH/$id/retry-failed"
        fun resumePath(id: String) = "$BATCH_PATH/$id/resume"
    }

    /**
     * Start generating drafts for [itemIds].
     *
     * Returns as soon as the batch is queued — generation is a durable server
     * job, so the caller polls [batch] rather than waiting on this call.
     */
    suspend fun startBatch(
        itemIds: List<String>,
        useComps: Boolean = true,
        templateId: String? = null,
    ): StartBatchResponse = edge.json.decodeFromString(
        StartBatchResponse.serializer(),
        edge.postRaw(
            BATCH_PATH,
            edge.json.encodeToString(
                StartBatchRequest.serializer(),
                StartBatchRequest(
                    itemIds = itemIds.distinct().take(Autolister.MAX_BATCH_ITEMS),
                    useComps = useComps,
                    templateId = templateId,
                ),
            ),
        ),
    )

    suspend fun batch(batchId: String): BatchStatusResponse = edge.json.decodeFromString(
        BatchStatusResponse.serializer(),
        edge.getRaw(batchPath(batchId)),
    )

    suspend fun retryFailed(batchId: String): RetryFailedResponse = edge.json.decodeFromString(
        RetryFailedResponse.serializer(),
        edge.postRaw(retryFailedPath(batchId), "{}"),
    )

    /** Ask the server to pick a stalled batch's remaining jobs back up. */
    suspend fun resume(batchId: String) {
        edge.postRaw(resumePath(batchId), "{}")
    }

    /** Which photo leads, and what each shows. One model call per photo. */
    suspend fun classifyPhotos(photos: List<ClassifyPhoto>): ClassifyPhotosResponse = aiEdge.json.decodeFromString(
        ClassifyPhotosResponse.serializer(),
        aiEdge.postRaw(
            CLASSIFY_PATH,
            aiEdge.json.encodeToString(
                ClassifyRequest.serializer(),
                ClassifyRequest(photos),
            ),
        ),
    )

    /** Score each item's photos BEFORE spending generation quota on them. */
    suspend fun photoQa(itemIds: List<String>): PhotoQaResponse = aiEdge.json.decodeFromString(
        PhotoQaResponse.serializer(),
        aiEdge.postRaw(
            PHOTO_QA_PATH,
            aiEdge.json.encodeToString(
                PhotoQaRequest.serializer(),
                PhotoQaRequest(itemIds.distinct()),
            ),
        ),
    )

    // ── US-2408: the multi-item session ──────────────────────────────────

    /**
     * Upload one photo to the session's `_staging/` folder.
     *
     * The shared client, not the AI one: this is a plain upload, and the AI
     * profile's 120s idle cap would leave a seller staring at a dead request
     * for two minutes when the connection dropped mid-batch.
     */
    suspend fun stagePhoto(
        stagingSessionId: String,
        fileName: String,
        bytes: ByteArray,
        thumbnail: ByteArray? = null,
    ): StagedUpload {
        val parts = buildList {
            add(EdgeApi.ImagePart("full", fileName, "image/jpeg", bytes))
            // Optional on the server and best-effort by design: a rejected
            // thumbnail costs nothing, because the grid falls back to the full
            // image. Sending it is what keeps a 200-photo grid off cellular.
            thumbnail?.let { add(EdgeApi.ImagePart("thumb", "thumb_$fileName", "image/jpeg", it)) }
        }
        return edge.json.decodeFromString(
            StagedUpload.serializer(),
            edge.postMultipartImages(
                STAGING_UPLOAD_PATH,
                parts,
                mapOf("session_id" to stagingSessionId),
            ),
        )
    }

    /** One billed AI action over at most 40 photos — see proposeWindows. */
    suspend fun proposeGroups(photos: List<GroupPhotoRef>): ProposeResponse = aiEdge.json.decodeFromString(
        ProposeResponse.serializer(),
        aiEdge.postRaw(
            PROPOSE_GROUPS_PATH,
            aiEdge.json.encodeToString(ProposeRequest.serializer(), ProposeRequest(photos)),
        ),
    )

    /** One billed AI action; returns suggestions and applies nothing. */
    suspend fun verifyGroups(groups: List<VerifyGroup>): VerifyResponse = aiEdge.json.decodeFromString(
        VerifyResponse.serializer(),
        aiEdge.postRaw(
            VERIFY_GROUPS_PATH,
            aiEdge.json.encodeToString(VerifyRequest.serializer(), VerifyRequest(groups)),
        ),
    )

    /** Put the staged batch on the shelf the desktop reads from. */
    suspend fun createHandoff(request: CreateHandoffRequest): CreatedHandoff = edge.json.decodeFromString(
        CreatedHandoff.serializer(),
        edge.postRaw(
            SESSIONS_PATH,
            edge.json.encodeToString(CreateHandoffRequest.serializer(), request),
        ),
    )

    /** Batches still waiting — open only, last 30 days, newest first. */
    suspend fun handoffs(): List<HandoffSummary> = edge.json.decodeFromString(
        HandoffList.serializer(),
        edge.getRaw(SESSIONS_PATH),
    ).sessions

    suspend fun handoff(id: String): HandoffDetail = edge.json.decodeFromString(
        HandoffDetail.serializer(),
        edge.getRaw("$SESSIONS_PATH/$id"),
    )

    /** Mark a batch as picked up. The row survives; only the status moves. */
    suspend fun claimHandoff(id: String) {
        edge.postRaw("$SESSIONS_PATH/$id/claim", "{}")
    }

    /**
     * Throw a batch away.
     *
     * The staged objects are swept too, but ONLY while the batch is still
     * open — once it has been claimed those files are live listing photos, and
     * the server refuses to touch them.
     */
    suspend fun discardHandoff(id: String): DiscardedHandoff = edge.json.decodeFromString(
        DiscardedHandoff.serializer(),
        edge.deleteRaw("$SESSIONS_PATH/$id"),
    )

    /**
     * The per-platform draft fields for one item.
     *
     * Asked for rather than assembled here: title caps, condition vocabularies
     * and category trees differ per marketplace and change without an app
     * release, so a device that built these itself would be wrong the first
     * time a marketplace renamed a condition.
     */
    suspend fun platformFields(itemId: String, platforms: List<String>): PlatformFieldsResponse =
        aiEdge.json.decodeFromString(
            PlatformFieldsResponse.serializer(),
            aiEdge.postRaw(
                PLATFORM_FIELDS_PATH,
                aiEdge.json.encodeToString(
                    PlatformFieldsRequest.serializer(),
                    PlatformFieldsRequest(itemId, platforms.distinct()),
                ),
            ),
        )

    /**
     * US-2976: the server's sentence when it sent one, our resource otherwise.
     *
     * `error.message` is dropped rather than shown - it is a JVM exception
     * string, which is a developer's sentence in a language nobody chose.
     */
    fun message(error: Throwable): UiMessage = UiMessage(
        R.string.autolister_unreachable,
        detail = (error as? EdgeApiError)?.userMessage(),
    )
}
