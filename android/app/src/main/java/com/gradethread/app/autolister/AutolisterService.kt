package com.gradethread.app.autolister

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
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
    suspend fun classifyPhotos(photos: List<ClassifyPhoto>): ClassifyPhotosResponse =
        aiEdge.json.decodeFromString(
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

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "AutoLister couldn't be reached."
}
