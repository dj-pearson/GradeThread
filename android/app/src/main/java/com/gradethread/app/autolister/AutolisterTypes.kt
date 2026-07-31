package com.gradethread.app.autolister

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1359: AutoLister batch generation, photo classification and QA.
 *
 * The batch is a DURABLE server job: the phone starts it and polls, and the
 * work continues whether the app is open or not. That shapes everything here —
 * the client never owns progress, it reports it.
 */

/** Batch lifecycle. `partial` is a real outcome, not a failure. */
@Serializable
enum class BatchStatus {
    @SerialName("pending")
    PENDING,

    @SerialName("running")
    RUNNING,

    @SerialName("completed")
    COMPLETED,

    @SerialName("failed")
    FAILED,

    @SerialName("partial")
    PARTIAL,
    ;

    /** No open jobs left — polling can stop. */
    val isTerminal: Boolean get() = this == COMPLETED || this == FAILED || this == PARTIAL
}

@Serializable
enum class JobStatus {
    @SerialName("pending")
    PENDING,

    @SerialName("running")
    RUNNING,

    @SerialName("success")
    SUCCESS,

    @SerialName("failed")
    FAILED,
}

@Serializable
data class AutolisterBatch(
    val id: String = "",
    val status: BatchStatus = BatchStatus.PENDING,
    val source: String? = null,
    @SerialName("item_count") val itemCount: Int = 0,
    @SerialName("succeeded_count") val succeededCount: Int = 0,
    @SerialName("failed_count") val failedCount: Int = 0,
    val error: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class AutolisterJob(
    val id: String = "",
    @SerialName("inventory_item_id") val inventoryItemId: String = "",
    val status: JobStatus = JobStatus.PENDING,
    val error: String? = null,
    val attempts: Int = 0,
    @SerialName("listing_id") val listingId: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class BatchStatusResponse(
    val batch: AutolisterBatch = AutolisterBatch(),
    val jobs: List<AutolisterJob> = emptyList(),
)

@Serializable
data class StartBatchResponse(
    @SerialName("batch_id") val batchId: String = "",
    @SerialName("item_count") val itemCount: Int = 0,
)

@Serializable
data class RetryFailedResponse(
    @SerialName("batch_id") val batchId: String = "",
    val retried: Int = 0,
)

@Serializable
internal data class StartBatchRequest(
    @SerialName("item_ids") val itemIds: List<String>,
    @SerialName("use_comps") val useComps: Boolean = true,
    @SerialName("template_id") val templateId: String? = null,
    @SerialName("auto_publish_green") val autoPublishGreen: Boolean = false,
)

// ── photo classification ────────────────────────────────────────────────────

@Serializable
data class ClassifyPhoto(
    val id: String,
    @SerialName("storage_path") val storagePath: String,
)

@Serializable
internal data class ClassifyRequest(val photos: List<ClassifyPhoto>)

/**
 * Which photo should lead, and what each one shows.
 *
 * `roles` is keyed by OUR photo ids, so a missing key means "the model didn't
 * say" — not "no role". The UI leaves those alone rather than guessing.
 */
@Serializable
data class ClassifyPhotosResponse(
    @SerialName("cover_id") val coverId: String? = null,
    val roles: Map<String, String> = emptyMap(),
)

// ── photo QA ────────────────────────────────────────────────────────────────

@Serializable
data class PhotoQaIssue(
    val type: String = "",
    val severity: String = "",
    val message: String = "",
    @SerialName("photo_index") val photoIndex: Int? = null,
)

/** One item's photo readiness. A score of -1 means QA itself failed. */
@Serializable
data class PhotoQaResult(
    @SerialName("item_id") val itemId: String = "",
    val score: Int = 0,
    val issues: List<PhotoQaIssue> = emptyList(),
    val error: String? = null,
)

@Serializable
data class PhotoQaResponse(val results: List<PhotoQaResult> = emptyList())

@Serializable
internal data class PhotoQaRequest(@SerialName("item_ids") val itemIds: List<String>)
