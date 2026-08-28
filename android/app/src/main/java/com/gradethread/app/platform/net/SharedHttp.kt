package com.gradethread.app.platform.net

import okhttp3.CookieJar
import okhttp3.OkHttpClient

/**
 * The one OkHttp client every other client in the app is derived from.
 *
 * OkHttp puts a connection pool and a dispatcher (with its own thread pool)
 * inside each `OkHttpClient`, so five independently built clients meant five
 * pools and five thread pools that could not reuse a single TLS handshake
 * between them - and four of the five talk to the same two hosts. `newBuilder()`
 * is the documented way out: it copies the configuration and SHARES the pool,
 * the dispatcher and the cache, so a variant costs a few objects rather than a
 * second networking stack.
 *
 * Sharing the dispatcher is safe for the profiles below. Timeouts are per-call,
 * so a 120-second AI read cannot lengthen a 20-second one; the dispatcher's
 * `maxRequestsPerHost` applies to ENQUEUED calls only, so the uploader's
 * blocking `execute()` cannot be starved by a burst of edge requests, and
 * WorkManager caps upload parallelism at three regardless.
 *
 * [base] deliberately configures nothing but the shared resources. Every
 * property that matters to a caller - timeouts, retry behaviour, the cookie jar
 * - is set on the variant, so reading a variant tells you what it does without
 * having to come here first.
 */
object SharedHttp {

    /**
     * Not `by lazy` and not a function: one instance, created when the class
     * loads. A function would hand each caller a fresh stack again, which is
     * the bug this file exists to close.
     *
     * No cache and no cookie jar, which are also OkHttp's defaults - stated
     * here because [com.gradethread.app.upload.PhotoSignedUrlProvider] depends
     * on both and a change made here would silently reach it.
     */
    val base: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .build()

    /** A variant that shares [base]'s pool, dispatcher and cache. */
    fun variant(configure: OkHttpClient.Builder.() -> Unit): OkHttpClient =
        base.newBuilder().apply(configure).build()
}
