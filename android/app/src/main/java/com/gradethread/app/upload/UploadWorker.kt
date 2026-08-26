package com.gradethread.app.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.DatabaseProvider
import com.gradethread.app.sync.db.ItemPhotoEntity
import io.github.jan.supabase.auth.auth
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * US-1328: the survive-app-death upload task. The persisted input carries
 * bucket/path/row fields and the STAGED FILE PATH — phase 1 (the signed-URL
 * mint) runs INSIDE the worker with a fresh session token, so nothing
 * long-lived is ever serialized to WorkManager's database; the signed URL
 * itself is minted per attempt and dies with its short TTL.
 *
 * Determinism: the photo row id IS the WorkManager id (lowercased) — a
 * retried/replayed worker upserts the SAME item_photos row and x-upserts the
 * same storage object. No duplicates, ever (the iOS photo-link race lesson).
 *
 * Failure split (US-1221): transient (network/5xx) → Result.retry() with
 * WorkManager backoff; terminal (staged file gone, 4xx) → queue a pending
 * uploadPhoto mutation for the inspector and stop retrying.
 */
class UploadWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val staged = inputData.getString(KEY_STAGED_PATH)?.let(::File)
        val itemId = inputData.getString(KEY_ITEM_ID) ?: return Result.failure()
        val serverType = inputData.getString(KEY_SERVER_TYPE) ?: return Result.failure()
        // US-2488: blank is normalized to null here rather than at the call
        // site, because WorkManager's Data has no null-string distinction and a
        // stored "" role is NOT the same slot as no role at all.
        val photoRole = inputData.getString(KEY_PHOTO_ROLE)?.takeIf { it.isNotBlank() }
        val sortOrder = inputData.getInt(KEY_SORT_ORDER, 0)
        val capturedAt = inputData.getLong(KEY_CAPTURED_AT, System.currentTimeMillis())
        val photoId = id.toString().lowercase() // deterministic (AC3)

        if (staged == null || !staged.exists()) {
            // Terminal: the bytes are gone; retrying can never succeed.
            queueStuckMutation(itemId, photoId, "staged file missing")
            Telemetry.event("photo_upload_failed", mapOf("reason" to "staged_missing"))
            return Result.failure()
        }

        return try {
            val client =
                com.gradethread.app.platform.supabase.SupabaseShared.client(applicationContext)
            val session = client.auth.currentSessionOrNull()
                ?: return Result.retry() // signed out mid-flight; retry after sign-in
            val userId = session.user?.id?.lowercase()
                ?: return Result.retry()

            val bucket = PhotoUpload.bucketFor(serverType)
            val path = PhotoUpload.uploadPath(userId, itemId, serverType, capturedAt)
            val supabaseUrl = com.gradethread.app.platform.AppConfig.supabaseUrl

            // Phase 1: short-TTL mint (fresh per attempt). Phase 2: ONE PUT.
            val signedUrl = PhotoUpload.mintSignedUploadUrl(
                http,
                supabaseUrl,
                session.accessToken,
                bucket,
                path,
            )
            PhotoUpload.putBytes(http, signedUrl, staged)

            // Phase 3: the row — deterministic id makes the replay idempotent.
            val db = DatabaseProvider.open(applicationContext)
            db.photos().upsert(
                listOf(
                    ItemPhotoEntity(
                        id = photoId,
                        inventoryItemId = itemId,
                        photoType = serverType,
                        photoRole = photoRole,
                        photoUrl = PhotoUpload.publicUrlFor(supabaseUrl, bucket, path),
                        thumbnailUrl = null,
                        storagePath = path,
                        width = inputData.getInt(KEY_WIDTH, 0).takeIf { it > 0 },
                        height = inputData.getInt(KEY_HEIGHT, 0).takeIf { it > 0 },
                        bytes = staged.length().toInt(),
                        sortOrder = sortOrder,
                        createdAt = capturedAt,
                        localBytesPath = null, // uploaded — no longer local-only
                    ),
                ),
            )
            // The server row rides the mutation queue (created idempotently by
            // photo_id) — enqueue AFTER the local row so the mirror is truthful.
            OfflineMutationQueue(db).enqueue(
                MutationKind.UPLOAD_PHOTO,
                targetId = itemId,
                payload = uploadPayload(
                    photoId,
                    itemId,
                    serverType,
                    photoRole,
                    path,
                    sortOrder,
                    capturedAt,
                ),
            )

            // Staged bytes deleted ONLY after the row landed (AC4).
            staged.delete()
            Telemetry.event("photo_upload_ok", mapOf("type" to serverType))
            Result.success(workDataOf(KEY_PHOTO_ID to photoId))
        } catch (t: Throwable) {
            val transient = t is java.io.IOException ||
                (t.message?.contains("HTTP 5") == true) ||
                (t.message?.contains("HTTP 429") == true)
            if (transient && runAttemptCount < MAX_ATTEMPTS) {
                Telemetry.breadcrumb(
                    "photo upload retry ${runAttemptCount + 1}: ${t.message}",
                    category = "upload",
                )
                Result.retry()
            } else {
                queueStuckMutation(itemId, photoId, t.message ?: "upload failed")
                Telemetry.event("photo_upload_failed", mapOf("reason" to "exhausted"))
                Result.failure()
            }
        }
    }

    private suspend fun queueStuckMutation(itemId: String, photoId: String, error: String) {
        runCatching {
            val db = DatabaseProvider.open(applicationContext)
            OfflineMutationQueue(db).enqueue(
                MutationKind.UPLOAD_PHOTO,
                targetId = itemId,
                payload = """{"photo_id":"$photoId","error":${'"'}$error${'"'}}""".encodeToByteArray(),
            )
        }
    }

    companion object {
        const val KEY_STAGED_PATH = "staged_path"
        const val KEY_ITEM_ID = "item_id"
        const val KEY_SERVER_TYPE = "server_type"
        const val KEY_PHOTO_ROLE = "photo_role"
        const val KEY_SORT_ORDER = "sort_order"
        const val KEY_CAPTURED_AT = "captured_at"
        const val KEY_WIDTH = "width"
        const val KEY_HEIGHT = "height"
        const val KEY_PHOTO_ID = "photo_id"
        const val MAX_ATTEMPTS = 5

        /** No auto-retry interceptors: ONE PUT per attempt (the iOS rule). */
        internal val http: OkHttpClient = OkHttpClient.Builder()
            .retryOnConnectionFailure(false)
            .connectTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()

        internal fun uploadPayload(
            photoId: String,
            itemId: String,
            serverType: String,
            photoRole: String?,
            path: String,
            sortOrder: Int,
            capturedAt: Long,
        ): ByteArray = buildJsonObject {
            put("photo_id", photoId)
            put("inventory_item_id", itemId)
            put("photo_type", serverType)
            // US-2488: absent, not "" — the replayer treats a missing key as
            // "this slot takes no qualifier" and an empty string would instead
            // write a role nothing can look up.
            photoRole?.takeIf { it.isNotBlank() }?.let { put("photo_role", it) }
            put("storage_path", path)
            put("sort_order", sortOrder)
            put("captured_at", capturedAt)
        }.toString().encodeToByteArray()

        /** Build the persisted request for one photo. */
        fun request(
            stagedPath: String,
            itemId: String,
            serverType: String,
            sortOrder: Int,
            capturedAt: Long,
            width: Int? = null,
            height: Int? = null,
            photoRole: String? = null,
        ): OneTimeWorkRequest = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(
                Data.Builder()
                    .putString(KEY_STAGED_PATH, stagedPath)
                    .putString(KEY_ITEM_ID, itemId.lowercase())
                    .putString(KEY_SERVER_TYPE, serverType)
                    .putString(KEY_PHOTO_ROLE, photoRole?.takeIf { it.isNotBlank() })
                    .putInt(KEY_SORT_ORDER, sortOrder)
                    .putLong(KEY_CAPTURED_AT, capturedAt)
                    .putInt(KEY_WIDTH, width ?: 0)
                    .putInt(KEY_HEIGHT, height ?: 0)
                    .build(),
            )
            .addTag(TAG_ALL)
            // US-1334: the AI publish gate has to tell "this item's front shot
            // failed terminally" from "it's still uploading", and WorkInfo
            // exposes tags but never input data. Two tags — the item and the
            // sort order — are the only channel WorkManager offers for that.
            .addTag(itemTag(itemId))
            .addTag(ORDER_TAG_PREFIX + sortOrder)
            .build()

        /**
         * The tag every photo upload carries, whichever entry point queued it.
         *
         * US-2895: a named constant because [cancelAll] has to match it. A
         * cancel written against a copy-pasted `"photo-upload"` keeps compiling
         * after a rename and silently cancels nothing, which at an account
         * boundary means the outgoing seller's photos keep uploading.
         */
        const val TAG_ALL = "photo-upload"

        private const val ORDER_TAG_PREFIX = "photo-upload-order:"

        /**
         * US-2895: stop every queued and running photo upload.
         *
         * Called at sign-out, BEFORE the row wipe. WorkManager work outlives the
         * Activity, the ViewModel and the session: each job carries its staged
         * file path in its own input Data and a signed URL minted for the
         * OUTGOING account, so without this it keeps PUTting one seller's
         * garments into their storage folder while the next seller is signing
         * in. The row wipe cannot stop it — the worker reads nothing from Room.
         */
        fun cancelAll(context: Context) {
            androidx.work.WorkManager.getInstance(context).cancelAllWorkByTag(TAG_ALL)
        }

        fun itemTag(itemId: String): String = "photo-upload-item:${itemId.lowercase()}"

        /** The sort order carried by [request]'s tags, or null if absent. */
        fun sortOrderFromTags(tags: Set<String>): Int? = tags
            .firstOrNull { it.startsWith(ORDER_TAG_PREFIX) }
            ?.removePrefix(ORDER_TAG_PREFIX)
            ?.toIntOrNull()
    }
}
