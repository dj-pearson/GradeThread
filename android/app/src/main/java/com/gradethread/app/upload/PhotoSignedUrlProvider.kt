package com.gradethread.app.upload

import com.gradethread.app.platform.net.SharedHttp
import com.gradethread.app.platform.supabase.StorageUrls
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * US-1329: mints + caches short-TTL signed READ urls for the PRIVATE
 * `submission-images` bucket (iOS `PhotoSignedURLProvider`, US-979), so
 * grading labels / certificates / PII close-ups display WITHOUT ever getting a
 * permanent public URL (US-276 forbids `getPublicUrl` there).
 *
 * Public-bucket (`item-photos`) rows keep their permanent `photo_url` and
 * never touch this class.
 *
 * The contract carried from iOS:
 *  - the requested TTL is CLAMPED to <= 900s — the private-bucket guard test
 *    fails the build on any larger TTL, and a signed URL is a capability;
 *  - a cached entry is treated as already dead [REFRESH_SKEW_MS] BEFORE its
 *    real expiry, so an image load that starts now can't race the token
 *    going stale mid-flight;
 *  - the cache is MEMORY-ONLY and never written to disk — nothing outlives
 *    the process, let alone the TTL;
 *  - a mint failure is TRANSIENT: it is never negatively cached, so the next
 *    call retries rather than pinning a placeholder for the whole TTL.
 */
class PhotoSignedUrlProvider(
    private val supabaseUrl: String,
    private val anonKey: String,
    private val tokenProvider: suspend () -> String?,
    private val client: OkHttpClient = ephemeralClient(),
    ttlSeconds: Int = DEFAULT_TTL_SECONDS,
    // Injected so expiry/skew is provable without sleeping (EdgeApi.TtlCache
    // precedent) — the repo has no mocking library by design.
    private val clock: () -> Long = System::currentTimeMillis,
    /**
     * Builds the sign endpoint. Defaults to [StorageUrls.signUrl], which
     * REJECTS any non-https base — that guard must stay on in production, so
     * tests driving a plaintext local server override this seam rather than
     * the provider weakening it.
     */
    private val endpointBuilder: (bucket: String, path: String) -> String? =
        { bucket, path -> StorageUrls.signUrl(supabaseUrl, bucket, path) },
) {

    /**
     * The TTL actually requested: never above the 15-minute ceiling, never
     * below 1s. Exposed for the tests asserting the <=900s bound.
     */
    val requestedTtlSeconds: Int = ttlSeconds.coerceIn(1, MAX_TTL_SECONDS)

    private class Entry(val url: String, val expiresAtMs: Long)

    private val mutex = Mutex()
    private val cache = HashMap<String, Entry>()

    /**
     * A displayable URL for a persisted photo. Public-bucket photos return
     * their permanent [publicUrl]; private-bucket photos resolve a cached
     * signed URL from [storagePath]. Null when it can't be produced — the
     * caller shows a placeholder and tries again later.
     */
    suspend fun displayUrl(
        bucket: PhotoUpload.Bucket,
        storagePath: String?,
        publicUrl: String,
    ): String? {
        if (bucket.isPublic) return publicUrl.ifBlank { null }
        if (storagePath.isNullOrBlank()) return null
        return signedUrl(bucket, storagePath)
    }

    /**
     * A signed URL for [path], served from cache while still comfortably
     * valid. Returns null on any failure — never caches that failure.
     */
    suspend fun signedUrl(bucket: PhotoUpload.Bucket, path: String): String? {
        val key = "${bucket.bucketName}/$path"
        mutex.withLock {
            val hit = cache[key]
            // Inside the skew window the entry is already dead to us.
            if (hit != null && hit.expiresAtMs > clock() + REFRESH_SKEW_MS) return hit.url
            // Drop the stale entry now so a failed re-mint can't leave a
            // near-expired URL behind to be handed out again.
            if (hit != null) cache.remove(key)
        }
        // Minted OUTSIDE the lock: a gallery scrolling 20 private thumbnails
        // must not serialize every mint behind one slow request.
        val minted = mint(bucket, path) ?: return null
        val expiresAt = clock() + requestedTtlSeconds * 1_000L
        mutex.withLock { cache[key] = Entry(minted, expiresAt) }
        return minted
    }

    /**
     * Drop every cached signed URL. A signed URL carries its own token in the
     * query string, so the PREVIOUS user's private grading-label photos must
     * not stay fetchable for up to a TTL on a shared device.
     *
     * US-2496: wired at last, as [signOutClearance] in the
     * `SessionScope.Hooks.clearances` that `SettingsViewModel.confirmSignOut`
     * assembles. It sat here unreferenced from US-1329 to US-2496 waiting for a
     * composition root that had in fact already landed.
     */
    suspend fun clearCache() {
        mutex.withLock { cache.clear() }
    }

    /** Shaped for `SessionScope.Hooks.clearances`. */
    fun signOutClearance(): suspend () -> Unit = { clearCache() }

    private suspend fun mint(bucket: PhotoUpload.Bucket, path: String): String? {
        val endpoint = endpointBuilder(bucket.bucketName, path) ?: return null
        // A transient token failure throws out of the provider rather than
        // minting unauthenticated (the US-1523 contract) — treat it as a
        // failed mint, which is retried, not memoized.
        val token = runCatching { tokenProvider() }.getOrNull()
        val request = Request.Builder()
            .url(endpoint)
            .post(
                Json.encodeToString(SignRequest.serializer(), SignRequest(requestedTtlSeconds))
                    .toRequestBody(JSON_MEDIA_TYPE),
            )
            .apply { if (!token.isNullOrBlank()) header("Authorization", "Bearer $token") }
            .header("apikey", anonKey)
            .build()

        return runCatching {
            val response = suspendCancellableCoroutine { cont ->
                val call = client.newCall(request)
                cont.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (cont.isActive) cont.resumeWith(Result.failure(e))
                    }

                    override fun onResponse(call: Call, response: Response) {
                        if (cont.isActive) cont.resumeWith(Result.success(response))
                    }
                })
            }
            response.use { resp ->
                if (!resp.isSuccessful) return@use null
                val body = resp.body?.string().orEmpty()
                resolve(supabaseUrl, json.decodeFromString(SignResponse.serializer(), body).signedURL)
            }
        }.getOrNull()
    }

    @Serializable
    private data class SignRequest(val expiresIn: Int)

    @Serializable
    private data class SignResponse(val signedURL: String)

    companion object {
        /** Requested lifetime. Deliberately below the ceiling. */
        const val DEFAULT_TTL_SECONDS: Int = 600

        /**
         * The hard ceiling from US-276. The `private-bucket-access` guard
         * fails the build on any signed-URL TTL above this.
         */
        const val MAX_TTL_SECONDS: Int = 900

        /**
         * Re-sign this long BEFORE the real expiry so an in-flight image load
         * never races the token going stale.
         */
        const val REFRESH_SKEW_MS: Long = 30_000

        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true }

        /**
         * The REST response's `signedURL` is relative to the storage API root
         * (`/object/sign/{bucket}/{path}?token=...`) — absolutize it.
         */
        fun resolve(base: String, signedURL: String): String =
            if (signedURL.startsWith("http")) signedURL
            else "${base.trimEnd('/')}/storage/v1$signedURL"

        /**
         * Appends a photo's local cache token as an ignored `_cb` param so an
         * IN-PLACE rotate busts URL-keyed image caches. A rotate doesn't change
         * the storage path, so the signed URL is byte-identical and every
         * URL-keyed cache would otherwise serve the pre-rotation pixels.
         * Supabase signs the path + expiry only and ignores `_cb`, so the
         * server still returns the freshly rotated bytes. No-op at token 0.
         */
        fun cacheBusted(url: String?, token: Int): String? {
            if (url == null || token == 0) return url
            val separator = if (url.contains('?')) "&" else "?"
            return "$url${separator}_cb=$token"
        }

        /**
         * NO disk cache and NO cookies, so the bearer token and the signed URL
         * never land in a shared or persisted store. Bounded read timeout so a
         * stalled mint fails fast instead of holding a private thumbnail on the
         * skeleton for the default 60s.
         *
         * It shares [SharedHttp.base]'s connection pool and dispatcher, and the
         * two lines below are what keeps that safe: `SharedHttp` sets neither a
         * cache nor a cookie jar today, and restating both here means a change
         * there cannot quietly give this client a store to leak into. What is
         * shared is TCP connections and threads, neither of which carries a
         * credential.
         */
        fun ephemeralClient(): OkHttpClient = SharedHttp.variant {
            connectTimeout(10, TimeUnit.SECONDS)
            readTimeout(20, TimeUnit.SECONDS)
            callTimeout(30, TimeUnit.SECONDS)
            cache(null)
            cookieJar(okhttp3.CookieJar.NO_COOKIES)
        }
    }
}
