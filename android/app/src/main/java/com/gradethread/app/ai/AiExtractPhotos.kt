package com.gradethread.app.ai

import com.gradethread.app.upload.PhotoUpload

/**
 * US-1334: turning persisted photo rows into the URLs the extract endpoint
 * can actually fetch.
 *
 * The bucket split (US-276) decides the URL shape: `item-photos` is public
 * and its permanent URL passes straight through, while tag/certificate shots
 * live in the PRIVATE `submission-images` bucket and need a short-TTL signed
 * URL — the same rule [com.gradethread.app.upload.SignedUrlStorageResolver]
 * applies for display. A private row sent as a bare public URL would 404 at
 * the model, silently costing the seller the most informative photo they took.
 */
object AiExtractPhotos {

    /** One `item_photos` row, narrowed to what URL building needs. */
    data class Row(
        val photoType: String,
        val photoUrl: String,
        val storagePath: String?,
        val sortOrder: Int,
    )

    /**
     * Build the request's photo list.
     *
     * Rows are taken in `sortOrder`, so the cap keeps the front/back shots and
     * drops trailing extras — the opposite order would spend the budget on
     * measurement close-ups and leave the model without a garment.
     *
     * @param resolve mints a fetchable URL, or null when it cannot (an
     *   unsigned private row, a failed mint). Such rows are SKIPPED, never
     *   sent unsigned.
     */
    suspend fun build(
        rows: List<Row>,
        resolve: suspend (PhotoUpload.Bucket, String?, String) -> String?,
        max: Int = AiExtractService.MAX_PHOTOS,
    ): List<AiExtractPhoto> = rows
        .sortedBy { it.sortOrder }
        .mapNotNull { row ->
            val bucket = PhotoUpload.readBucketFor(row.photoType, row.photoUrl)
            val url = resolve(bucket, row.storagePath, row.photoUrl) ?: return@mapNotNull null
            if (url.isBlank()) null else AiExtractPhoto(url = url, type = row.photoType)
        }
        .take(max)
}
