package com.gradethread.app.upload

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File

/**
 * US-1328: the two-phase upload (iOS PhotoUploadService, US-1219 + the
 * foreground-uploader rebuild). Phase 1 mints a SHORT-TTL signed upload URL
 * over an ephemeral authenticated request; phase 2 PUTs the bytes against
 * that URL — the persisted WorkManager task carries ONLY the short-lived
 * query token, never a long-lived credential.
 *
 * Hard-won iOS lessons encoded here:
 *  - ONE PUT PER PHOTO, no auto-retrying background session (the duplicated-
 *    transfer storm against slow self-hosted storage);
 *  - the sign mint POST MUST send `{}` — an empty application/json body 400s
 *    at storage-api/Fastify before any handler runs (the empty-body bug);
 *  - photo row ids are DETERMINISTIC (the work id), so a replay upserts the
 *    SAME row instead of duplicating (the photo-link race);
 *  - every client-minted UUID is LOWERCASED (the uppercase-UUID sync dup).
 */
object PhotoUpload {

    /** Bucket routing (US-276): grading-sensitive types stay PRIVATE. */
    enum class Bucket(val bucketName: String, val isPublic: Boolean) {
        SUBMISSION_IMAGES("submission-images", isPublic = false),
        ITEM_PHOTOS("item-photos", isPublic = true),
    }

    /** Label/certificate imagery must never land in the public bucket. */
    private val PRIVATE_TYPES = setOf("tag", "tag_2", "certificate")

    fun bucketFor(serverPhotoType: String): Bucket =
        if (serverPhotoType in PRIVATE_TYPES) Bucket.SUBMISSION_IMAGES else Bucket.ITEM_PHOTOS

    /** `{userId}/{itemId}/{type}_{ts}.jpg` — per-user-folder RLS shape. */
    fun uploadPath(userId: String, itemId: String, serverPhotoType: String, timestampMs: Long): String =
        "${userId.lowercase()}/${itemId.lowercase()}/${serverPhotoType}_$timestampMs.jpg"

    /**
     * The public URL recorded on the row — EMPTY for the private bucket
     * (readers mint signed URLs, TTL <= 900s; never getPublicUrl there).
     */
    fun publicUrlFor(supabaseUrl: String, bucket: Bucket, path: String): String =
        if (bucket.isPublic) {
            "$supabaseUrl/storage/v1/object/public/${bucket.bucketName}/$path"
        } else {
            ""
        }

    // ── Phase 1: mint ────────────────────────────────────────────────────────

    @Serializable
    internal data class SignResponse(val url: String)

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Mint a signed upload URL. The response's `url` is relative to the
     * storage API root; the returned value is absolute.
     */
    suspend fun mintSignedUploadUrl(
        client: OkHttpClient,
        supabaseUrl: String,
        accessToken: String,
        bucket: Bucket,
        path: String,
    ): String {
        val request = Request.Builder()
            .url("$supabaseUrl/storage/v1/object/upload/sign/${bucket.bucketName}/$path")
            // THE iOS lesson: an empty JSON body 400s at Fastify — send {}.
            .post("{}".toRequestBody("application/json".toMediaType()))
            .header("Authorization", "Bearer $accessToken")
            .build()
        val response = kotlinx.coroutines.suspendCancellableCoroutine<okhttp3.Response> { cont ->
            val call = client.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                    if (cont.isActive) cont.resumeWith(Result.failure(e))
                }

                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    if (cont.isActive) cont.resumeWith(Result.success(response))
                }
            })
        }
        response.use { resp ->
            check(resp.isSuccessful) { "sign mint failed: HTTP ${resp.code}" }
            val body = resp.body?.string().orEmpty()
            val signed = json.decodeFromString(SignResponse.serializer(), body).url
            return if (signed.startsWith("http")) signed else "$supabaseUrl/storage/v1$signed"
        }
    }

    // ── Phase 2: the single PUT ──────────────────────────────────────────────

    /** One PUT, x-upsert for idempotent replay. Throws on non-2xx. */
    suspend fun putBytes(
        client: OkHttpClient,
        signedUrl: String,
        file: File,
    ) {
        val request = Request.Builder()
            .url(signedUrl)
            .put(file.asRequestBody())
            // Replays overwrite the same object instead of erroring (AC3).
            .header("x-upsert", "true")
            .build()
        val response = kotlinx.coroutines.suspendCancellableCoroutine<okhttp3.Response> { cont ->
            val call = client.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                    if (cont.isActive) cont.resumeWith(Result.failure(e))
                }

                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    if (cont.isActive) cont.resumeWith(Result.success(response))
                }
            })
        }
        response.use { resp ->
            check(resp.isSuccessful) { "upload PUT failed: HTTP ${resp.code}" }
        }
    }

    private fun File.asRequestBody() =
        readBytes().toRequestBody("image/jpeg".toMediaType())
}
