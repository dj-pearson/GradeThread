package com.gradethread.app.platform.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * US-1306: the typed HTTP layer for the Hono edge service (iOS EdgeAPI).
 * Attaches the bearer token + workspace scope to every request so callers
 * don't have to remember; one forced token refresh on 401 before surfacing
 * "session expired"; bounded exponential backoff for transient failures;
 * plan-gate signals intercepted on EVERY response; TTL cache for idempotent
 * GETs.
 *
 * Two client profiles mirror the iOS session split (see [EdgeNetwork]):
 * shared = 20s read timeout — fails a stalled request fast instead of hanging
 * a spinner (the App Store 2.1(b) lesson); ai = 120s read for the slow vision
 * calls a 20s idle cap would falsely time out. The DI wiring (token providers
 * from the auth layer) lands with US-1307/US-1310.
 *
 * Retry policy (iOS US-638/US-1145/US-1164): network blips and 429 retry for
 * any method (a 429 was rejected, not processed); 5xx retries ONLY for
 * idempotent methods — a 5xx on a POST may have applied server-side, and a
 * blind retry risks a duplicate sale/listing.
 */
class EdgeApi(
    private val baseUrl: String,
    private val client: OkHttpClient,
    /** Returns a token, null for signed-out, or THROWS [EdgeApiError.Network]
     *  for a transient fetch failure (the US-1523 contract — a blip must
     *  never send the request unauthenticated). */
    private val tokenProvider: suspend () -> String?,
    /** One forced refresh after a server 401; null = the session is truly
     *  dead and the caller sees Unauthorized. */
    private val tokenRefresher: suspend () -> String?,
    private val workspaceOwnerProvider: () -> String? = { null },
    private val onPlanGate: (PlanGateError) -> Unit = PlanGateNotifier::publish,
    private val onPlanWarning: (PlanWarning) -> Unit = PlanGateNotifier::publishWarning,
    /** US-794: fired when the edge reports the active workspace membership was
     *  revoked — the scope layer drops the stale selection; the error still
     *  surfaces to the caller. */
    private val onWorkspaceRevoked: () -> Unit = {},
    /** US-2685: the workspace demands 2FA and this session is aal1. */
    private val onMfaRequired: () -> Unit = {},
    /**
     * US-2496: the tenant a cached GET belongs to - the active workspace owner
     * when one is selected, else the signed-in user. This is the CORRECTNESS
     * mechanism, and it is self-healing: a different owner is a different key,
     * so sign-out, sign-in-as-someone-else and a workspace switch are all
     * covered without any exit path having to remember anything.
     *
     * Null means "no tenant resolved", and then nothing is served from the
     * cache or written to it. Failing closed costs a cache hit; failing open
     * costs the wrong account's answer. The endpoint that made this concrete -
     * `GET /api/flipdesk/photo-profiles` - is served per
     * `workspaceOwnerId ?? userId`, so an unscoped key is a key that can be
     * read back by somebody else.
     *
     * Defaulted to null on purpose: a construction site that forgets to supply
     * an owner gets NO caching rather than account-blind caching.
     */
    private val cacheOwnerProvider: () -> String? = { null },
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
) {

    val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val cache = TtlCache(maxEntries = 64, maxBytes = 4 * 1024 * 1024)

    init {
        liveCaches.add(cache)
    }

    companion object {
        private const val MAX_RETRIES = 2
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /**
         * Every live instance's response cache. There are two EdgeApi profiles
         * today (shared + ai) and a sign-out has to reach both; registering
         * here means a third profile is covered the day it is added, instead of
         * depending on whoever adds it noticing the clearance list.
         *
         * Strong references are fine: the instances are `@Singleton` and live
         * as long as the process does.
         */
        private val liveCaches = java.util.concurrent.CopyOnWriteArrayList<TtlCache>()

        /**
         * US-2496: drop every cached response body.
         *
         * This is DATA RETENTION, not correctness - the owner-scoped key above
         * already stops one account's response being served to another. What it
         * does not do is unhold the previous account's response bytes, which sit
         * in memory until their TTL expires. On a shared device that is the
         * outgoing seller's data in the incoming seller's process. Two separate
         * jobs: do not delete either one thinking it duplicates the other.
         */
        fun clearAllResponseCaches() {
            liveCaches.forEach { it.clear() }
        }

        /** Which (error, method) pairs are safe to retry. Pure; unit-tested. */
        fun shouldRetry(error: EdgeApiError, method: String): Boolean = when (error) {
            is EdgeApiError.Network, is EdgeApiError.RateLimited -> true
            is EdgeApiError.ServerError -> method == "GET" || method == "HEAD"
            else -> false
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** GET returning the raw body; `cacheTtlMillis > 0` serves fresh cached
     *  entries and stores successes (idempotent GETs only — US-638). */
    suspend fun getRaw(path: String, query: Map<String, String> = emptyMap(), cacheTtlMillis: Long = 0): String {
        // US-2496: the owner is resolved ONCE, before the request, and the same
        // key is used for the read and the write. Resolving it twice would file
        // a response under a tenant it was not fetched for if the workspace
        // changed mid-request. A null key means no tenant, so no caching.
        val key = if (cacheTtlMillis > 0) {
            cacheOwnerProvider()?.let { cacheKey(it, path, query) }
        } else {
            null
        }
        if (key != null) cache.get(key)?.let { return it }
        val body = perform("GET", path, query, body = null)
        if (key != null) cache.put(key, body, cacheTtlMillis)
        return body
    }

    suspend inline fun <reified T> getJson(
        path: String,
        query: Map<String, String> = emptyMap(),
        cacheTtlMillis: Long = 0,
    ): T = decode(getRaw(path, query, cacheTtlMillis))

    suspend fun postRaw(path: String, jsonBody: String): String =
        perform("POST", path, emptyMap(), jsonBody.toRequestBody(JSON_MEDIA))

    suspend inline fun <reified T, reified B> postJson(path: String, body: B): T =
        decode(postRaw(path, json.encodeToString(kotlinx.serialization.serializer(), body)))

    suspend fun patchRaw(path: String, jsonBody: String): String =
        perform("PATCH", path, emptyMap(), jsonBody.toRequestBody(JSON_MEDIA))

    /** US-1358: some edge resources are replaced wholesale (repricing rules). */
    suspend fun putRaw(path: String, jsonBody: String): String =
        perform("PUT", path, emptyMap(), jsonBody.toRequestBody(JSON_MEDIA))

    /**
     * US-1378: a DELETE may carry a body.
     *
     * `DELETE /api/notifications/register` identifies the device token in the
     * body rather than the path, because a push token is a credential and does
     * not belong in a URL that proxies and access logs record.
     */
    suspend fun deleteRaw(path: String, jsonBody: String? = null): String =
        perform("DELETE", path, emptyMap(), jsonBody?.toRequestBody(JSON_MEDIA))

    /**
     * POSTs one image part + optional string fields as multipart/form-data
     * (iOS US-1049). NOT retried for transients (uploads aren't idempotent)
     * but it gets the same single forced 401 refresh.
     */
    suspend fun postMultipartImage(
        path: String,
        fieldName: String,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
        fields: Map<String, String> = emptyMap(),
    ): String {
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            fields.forEach { (k, v) -> addFormDataPart(k, v) }
            addFormDataPart(fieldName, fileName, bytes.toRequestBody(mimeType.toMediaType()))
        }.build()
        return send("POST", path, emptyMap(), multipart, allowTransientRetry = false)
    }

    /**
     * US-2408: POSTs SEVERAL image parts in one multipart body.
     *
     * `/staging/upload` takes a `full` and an optional `thumb` in the same
     * request, and splitting them into two calls would double a 200-photo
     * batch's requests against a 120/min limiter — and leave the thumbnail
     * orphaned whenever the second call failed.
     */
    suspend fun postMultipartImages(
        path: String,
        parts: List<ImagePart>,
        fields: Map<String, String> = emptyMap(),
    ): String {
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            fields.forEach { (k, v) -> addFormDataPart(k, v) }
            parts.forEach {
                addFormDataPart(it.fieldName, it.fileName, it.bytes.toRequestBody(it.mimeType.toMediaType()))
            }
        }.build()
        return send("POST", path, emptyMap(), multipart, allowTransientRetry = false)
    }

    /**
     * US-2815: a multipart body whose part ORDER and REPEATS are both
     * significant.
     *
     * [postMultipartImages] cannot express this. Its `fields` is a Map, so a
     * name can appear once, and it writes every field before every file — but
     * `POST /api/grade/submit` reads `images` and `image_types` as POSITIONAL
     * arrays and zips images[i] with image_types[i].
     *
     * Writing them in two passes is how a reorder silently mislabels every
     * photo, and a back shot graded as a tag is a WRONG GRADE rather than an
     * error — nothing fails, a customer is charged, and the certificate is
     * confidently wrong. The iOS uploader carries the same warning above the
     * same loop.
     *
     * So the caller supplies one ordered list and this writes it verbatim.
     */
    suspend fun postMultipart(path: String, parts: List<Part>): String {
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            parts.forEach { part ->
                when (part) {
                    is Part.Field -> addFormDataPart(part.name, part.value)
                    is Part.File -> addFormDataPart(
                        part.name,
                        part.fileName,
                        part.bytes.toRequestBody(part.mimeType.toMediaType()),
                    )
                }
            }
        }.build()
        return send("POST", path, emptyMap(), multipart, allowTransientRetry = false)
    }

    /** One entry in an ordered multipart body. */
    sealed class Part {
        class Field(val name: String, val value: String) : Part()

        /** Not a data class: it holds an array, whose generated `equals` would
         *  compare identity and read as if it compared content. */
        class File(val name: String, val fileName: String, val mimeType: String, val bytes: ByteArray) : Part()
    }

    /** One image part. Not a data class: it holds an array, whose generated
     *  `equals` would compare identity and read as if it compared content. */
    class ImagePart(val fieldName: String, val fileName: String, val mimeType: String, val bytes: ByteArray)

    /** Decode helper shared by the reified entry points. */
    inline fun <reified T> decode(raw: String): T = try {
        json.decodeFromString<T>(raw)
    } catch (e: Exception) {
        throw EdgeApiError.Decoding(e.message ?: "decode failed", e)
    }

    // ── Core send loop ───────────────────────────────────────────────────────

    private suspend fun perform(method: String, path: String, query: Map<String, String>, body: RequestBody?): String =
        send(method, path, query, body, allowTransientRetry = true)

    private suspend fun send(
        method: String,
        path: String,
        query: Map<String, String>,
        body: RequestBody?,
        allowTransientRetry: Boolean,
    ): String = withContext(Dispatchers.IO) {
        var attempt = 0
        var didRefreshAuth = false
        var retryAfterHint: Long? = null

        while (true) {
            try {
                val request = buildRequest(method, path, query, body)
                val (code, responseBody, warningHeader, retryAfter) = execute(request)

                // Plan signals ride on ANY status (US-805).
                warningHeader?.let { PlanWarning.parse(it) }?.let(onPlanWarning)
                if (code == 402) PlanGateError.decode(responseBody)?.let(onPlanGate)

                if (code in 200..299) return@withContext responseBody
                if (code == 429) retryAfterHint = retryAfter
                throw EdgeApiError.from(code, responseBody)
            } catch (error: EdgeApiError) {
                // US-794: drop the stale workspace scope so the retry/next
                // request runs under the personal tenant, then surface it.
                if (error is EdgeApiError.WorkspaceAccessRevoked) {
                    onWorkspaceRevoked()
                    throw error
                }
                // US-2685: surface the workspace-MFA block so the UI can offer
                // the code box. Announced and RE-THROWN, never swallowed — the
                // request did fail and the caller still has to handle that.
                // `==` rather than `is`: WorkspaceMfaRequired is an object, so
                // identity IS the test, and detekt's InstanceOfCheckForException
                // (rightly) flags type checks inside a catch. The neighbours above
                // predate that and sit in the baseline; this one does not need to.
                if (error == EdgeApiError.WorkspaceMfaRequired) {
                    onMfaRequired()
                    throw error
                }
                // One forced token refresh on a server 401 (US-1146): a token
                // the server rejects (rotation, clock skew) gets exactly one
                // explicit refresh + retry before "session expired".
                if (error is EdgeApiError.Unauthorized && !didRefreshAuth) {
                    didRefreshAuth = true
                    if (tokenRefresher() != null) continue
                    throw error
                }
                if (allowTransientRetry && shouldRetry(error, method) && attempt < MAX_RETRIES) {
                    val delayMs = retryAfterHint?.coerceIn(0, 8)?.times(1000)
                        ?: Backoff.delayMillis(attempt, baseMillis = 500, capMillis = 4_000)
                    retryAfterHint = null
                    sleeper(delayMs)
                    attempt += 1
                    continue
                }
                throw error
            }
        }
        // Formally required by the lambda's type inference; the loop above
        // only exits via return@withContext or throw.
        @Suppress("UNREACHABLE_CODE")
        throw IllegalStateException("unreachable")
    }

    private suspend fun buildRequest(
        method: String,
        path: String,
        query: Map<String, String>,
        body: RequestBody?,
    ): Request {
        val url: HttpUrl = ("$baseUrl$path").toHttpUrl().newBuilder().apply {
            query.forEach { (k, v) -> addQueryParameter(k, v) }
        }.build()

        val builder = Request.Builder().url(url).method(
            method,
            if (body == null && (method == "POST" || method == "PATCH")) {
                "".toRequestBody(JSON_MEDIA)
            } else {
                body
            },
        )
        builder.header("Accept", "application/json")

        // US-1523 contract: a transient token failure THROWS (retryable
        // Network) — the request is never sent unauthenticated on a blip.
        tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }

        // US-670: scope edge operations to the active workspace; the edge
        // middleware validates membership before honoring it.
        workspaceOwnerProvider()?.let { builder.header("X-Workspace-Owner", it) }
        return builder.build()
    }

    private data class WireResponse(
        val code: Int,
        val body: String,
        val planWarningHeader: String?,
        val retryAfterSeconds: Long?,
    )

    private suspend fun execute(request: Request): WireResponse = suspendCancellableCoroutine { cont ->
        val call = client.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(
                    EdgeApiError.Network(e.message ?: e.javaClass.simpleName),
                )
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    cont.resume(
                        WireResponse(
                            code = it.code,
                            body = it.body?.string() ?: "",
                            planWarningHeader = it.header("X-Plan-Warning"),
                            retryAfterSeconds = it.header("Retry-After")?.toLongOrNull(),
                        ),
                    )
                }
            }
        })
    }

    /** The cache key. [owner] leads so the tenant can never be optional. */
    private fun cacheKey(owner: String, path: String, query: Map<String, String>): String = owner + "|" + path + "?" +
        query.entries.sortedBy { it.key }.joinToString("&") { "${it.key}=${it.value}" }
}

/**
 * US-1306: bounded in-memory TTL cache for idempotent GETs (iOS US-638 +
 * the US-995 caps): LRU past [maxEntries] or [maxBytes]; a blob larger than
 * the byte cap is never cached. Clock-injectable for tests.
 */
class TtlCache(
    private val maxEntries: Int,
    private val maxBytes: Int,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private data class Entry(val value: String, val expiresAt: Long)

    /**
     * Declared BEFORE [entries], because [entries]'s `removeEldestEntry` reads
     * it and Kotlin initializes properties in source order. The other way round
     * compiles and then subtracts into a field that has not been zeroed yet.
     */
    private var totalBytes = 0

    private val entries = object : LinkedHashMap<String, Entry>(16, 0.75f, true) {
        /**
         * The eviction the ENTRY cap performs, accounted for.
         *
         * This used to be a bare `size > maxEntries`, and LinkedHashMap then
         * dropped the eldest entry without anyone subtracting its bytes, so
         * [totalBytes] over-counted by the full size of every entry the count
         * cap ever evicted, and only ever grew. Once the drift passed
         * [maxBytes] the loop in [put] evicted the WHOLE cache on every write
         * and could never get back under the cap, because the excess was
         * bookkeeping rather than data. The cache silently stopped caching.
         *
         * Reproduced directly at 4 entries / 1,000 bytes: fifty 100-byte puts
         * left the cache holding 300 real bytes while reporting 1,000. The
         * production caps are 64 entries and 4 MB, so the same leak needs a
         * few thousand evictions to disable the cache rather than fifty.
         */
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>): Boolean {
            if (size <= maxEntries) return false
            totalBytes -= eldest.value.value.length
            return true
        }
    }

    @Synchronized
    fun get(key: String): String? {
        val entry = entries[key] ?: return null
        if (clock() > entry.expiresAt) {
            totalBytes -= entry.value.length
            entries.remove(key)
            return null
        }
        return entry.value
    }

    @Synchronized
    fun put(key: String, value: String, ttlMillis: Long) {
        if (value.length > maxBytes) return
        entries.remove(key)?.let { totalBytes -= it.value.length }
        entries[key] = Entry(value, clock() + ttlMillis)
        totalBytes += value.length
        // Evict LRU until under the byte cap (the entry cap is handled by
        // removeEldestEntry).
        while (totalBytes > maxBytes && entries.isNotEmpty()) {
            val eldest = entries.entries.first()
            totalBytes -= eldest.value.value.length
            entries.remove(eldest.key)
        }
    }

    @Synchronized
    fun clear() {
        entries.clear()
        totalBytes = 0
    }
}

/**
 * The two shared clients (iOS EdgeNetwork): [shared] fails stalled requests
 * fast (20s read); [ai] gives the 20–40s model passes room (120s). Both ban
 * cleartext via the app-wide network security config.
 */
object EdgeNetwork {
    fun sharedClient(): OkHttpClient = SharedHttp.variant {
        connectTimeout(10, TimeUnit.SECONDS)
        readTimeout(20, TimeUnit.SECONDS)
        callTimeout(60, TimeUnit.SECONDS)
    }

    fun aiClient(): OkHttpClient = SharedHttp.variant {
        connectTimeout(10, TimeUnit.SECONDS)
        readTimeout(120, TimeUnit.SECONDS)
        callTimeout(180, TimeUnit.SECONDS)
    }
}
