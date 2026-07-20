package com.gradethread.app.upload

import com.gradethread.app.ui.components.PhotoRef
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * US-1329: the <=900s TTL bound, the 30s refresh skew, memory-only caching,
 * and transient (never memoized) mint failure — the iOS
 * PhotoSignedURLProviderTests contract, proven with an injected clock so no
 * test sleeps.
 */
class PhotoSignedUrlProviderTest {

    private fun signBody(token: String = "abc") =
        MockResponse().setBody(
            """{"signedURL":"/object/sign/submission-images/u/i/tag_1.jpg?token=$token"}""",
        )

    /**
     * MockWebServer speaks plaintext http, and the production endpoint builder
     * (`StorageUrls.signUrl`) deliberately rejects any non-https base. Override
     * that one seam so these tests exercise the REAL mint/cache/skew logic
     * against a real server without weakening the production guard —
     * `StorageUrlsTest` already covers the https rejection itself.
     */
    private fun provider(
        server: MockWebServer,
        ttlSeconds: Int = PhotoSignedUrlProvider.DEFAULT_TTL_SECONDS,
        clock: () -> Long,
        token: String? = "jwt",
    ): PhotoSignedUrlProvider {
        val base = server.url("/").toString().trimEnd('/')
        return PhotoSignedUrlProvider(
            supabaseUrl = base,
            anonKey = "anon-key",
            tokenProvider = { token },
            ttlSeconds = ttlSeconds,
            clock = clock,
            endpointBuilder = { bucket, path -> "$base/storage/v1/object/sign/$bucket/$path" },
        )
    }

    /**
     * Never the no-arg `takeRequest()`: it blocks FOREVER when the request
     * under test was never made, which hangs the whole suite instead of
     * failing it.
     */
    private fun MockWebServer.takeRequestOrFail() =
        takeRequest(5, TimeUnit.SECONDS) ?: error("expected a request, none arrived")

    // ── AC1: TTL bound + request shape ──

    @Test
    fun requestedTtl_defaultsBelowTheCeiling_andIsClampedAt900() {
        val server = MockWebServer()
        var now = 0L
        assertEquals(600, provider(server, clock = { now }).requestedTtlSeconds)
        // US-276: the private-bucket guard fails the build above 900s.
        assertEquals(900, provider(server, ttlSeconds = 3600, clock = { now }).requestedTtlSeconds)
        assertEquals(900, PhotoSignedUrlProvider.MAX_TTL_SECONDS)
        // Never degenerate to a zero/negative lifetime.
        assertEquals(1, provider(server, ttlSeconds = 0, clock = { now }).requestedTtlSeconds)
        assertEquals(1, provider(server, ttlSeconds = -5, clock = { now }).requestedTtlSeconds)
    }

    @Test
    fun mint_postsExpiresIn_withAuthAndApikey_andAbsolutizesTheSignedUrl() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(signBody())
        var now = 0L
        val base = server.url("/").toString().trimEnd('/')

        val url = provider(server, clock = { now })
            .signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")

        val recorded = server.takeRequestOrFail()
        assertEquals("POST", recorded.method)
        assertEquals("/storage/v1/object/sign/submission-images/u/i/tag_1.jpg", recorded.path)
        assertEquals("""{"expiresIn":600}""", recorded.body.readUtf8())
        assertEquals("Bearer jwt", recorded.getHeader("Authorization"))
        assertEquals("anon-key", recorded.getHeader("apikey"))
        assertEquals(
            "$base/storage/v1/object/sign/submission-images/u/i/tag_1.jpg?token=abc",
            url,
        )
        server.shutdown()
    }

    // ── AC1: the 30s refresh skew ──

    @Test
    fun cachedUrl_isReused_whileComfortablyValid() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(signBody("first"))
        var now = 0L
        val p = provider(server, clock = { now })

        val a = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")
        // 9 minutes in: 60s of life left, well clear of the 30s skew.
        now = 9 * 60 * 1_000L
        val b = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")

        assertEquals(a, b)
        // A scrolling gallery must not re-sign every frame: ONE mint.
        assertEquals(1, server.requestCount)
        server.shutdown()
    }

    @Test
    fun entryWithinTheSkewWindow_isReMinted_beforeItActuallyExpires() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(signBody("first"))
        server.enqueue(signBody("second"))
        var now = 0L
        val p = provider(server, clock = { now })

        val first = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")
        // 580s in — the URL is STILL VALID for 20s, but that is inside the 30s
        // skew, so an image load starting now could race expiry. Re-sign.
        now = 580 * 1_000L
        val second = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")

        assertTrue(first!!.endsWith("token=first"))
        assertTrue(second!!.endsWith("token=second"))
        assertEquals(2, server.requestCount)
        server.shutdown()
    }

    // ── AC3: mint failure is transient, never memoized ──

    @Test
    fun mintFailure_returnsNull_andIsRetriedNotCached() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(signBody("recovered"))
        var now = 0L
        val p = provider(server, clock = { now })

        val failed = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")
        val recovered = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")

        assertNull(failed)
        // The failure was NOT negatively cached — the very next call retries.
        assertNotNull(recovered)
        assertTrue(recovered!!.endsWith("token=recovered"))
        server.shutdown()
    }

    @Test
    fun aFailedReMint_doesNotHandBackTheNearExpiredUrl() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(signBody("first"))
        server.enqueue(MockResponse().setResponseCode(500))
        var now = 0L
        val p = provider(server, clock = { now })

        p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")
        now = 590 * 1_000L // inside the skew window
        val stale = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")

        // Better a placeholder + retry than a URL about to 400 mid-load.
        assertNull(stale)
        server.shutdown()
    }

    @Test
    fun clearCache_dropsEverything_soTheNextUserReMints() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(signBody("userA"))
        server.enqueue(signBody("userB"))
        var now = 0L
        val p = provider(server, clock = { now })

        p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")
        p.clearCache()
        val after = p.signedUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "u/i/tag_1.jpg")

        assertTrue(after!!.endsWith("token=userB"))
        assertEquals(2, server.requestCount)
        server.shutdown()
    }

    // ── AC2: public bucket keeps its permanent URL ──

    @Test
    fun publicBucket_returnsThePermanentUrl_withoutSigning() = runTest {
        val server = MockWebServer()
        server.start()
        var now = 0L

        val url = provider(server, clock = { now }).displayUrl(
            PhotoUpload.Bucket.ITEM_PHOTOS,
            storagePath = "u/i/front_1.jpg",
            publicUrl = "https://api.x.com/storage/v1/object/public/item-photos/u/i/front_1.jpg",
        )

        assertEquals(
            "https://api.x.com/storage/v1/object/public/item-photos/u/i/front_1.jpg",
            url,
        )
        // No network at all for public imagery.
        assertEquals(0, server.requestCount)
        server.shutdown()
    }

    @Test
    fun privateBucketWithoutAStoragePath_resolvesToNull_neverAPublicUrl() = runTest {
        val server = MockWebServer()
        server.start()
        var now = 0L
        val p = provider(server, clock = { now })

        assertNull(p.displayUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, null, ""))
        assertNull(p.displayUrl(PhotoUpload.Bucket.SUBMISSION_IMAGES, "  ", ""))
        assertEquals(0, server.requestCount)
        server.shutdown()
    }

    // ── Read-time bucket routing ──

    @Test
    fun readBucket_sendsPrivateTypesPrivate_butHonoursAnExistingPublicUrl() {
        assertEquals(
            PhotoUpload.Bucket.SUBMISSION_IMAGES,
            PhotoUpload.readBucketFor("tag", ""),
        )
        // Legacy/reclassified: a private TYPE that already has a public URL
        // really does live in the public bucket — signing it would 404.
        assertEquals(
            PhotoUpload.Bucket.ITEM_PHOTOS,
            PhotoUpload.readBucketFor("tag", "https://api.x.com/storage/v1/object/public/x.jpg"),
        )
        assertEquals(PhotoUpload.Bucket.ITEM_PHOTOS, PhotoUpload.readBucketFor("front", ""))
    }

    // ── Cache busting for in-place rotates ──

    @Test
    fun cacheBusted_appendsCbOnlyWhenRotated() {
        val signed = "https://x.com/object/sign/b/p.jpg?token=t"
        assertEquals(signed, PhotoSignedUrlProvider.cacheBusted(signed, 0))
        assertEquals("$signed&_cb=3", PhotoSignedUrlProvider.cacheBusted(signed, 3))
        assertEquals(
            "https://x.com/p.jpg?_cb=2",
            PhotoSignedUrlProvider.cacheBusted("https://x.com/p.jpg", 2),
        )
        assertNull(PhotoSignedUrlProvider.cacheBusted(null, 5))
    }

    // ── The resolver seam the UI consumes ──

    @Test
    fun resolver_marksPrivateImagesSoTheyBypassTheDiskCache() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(signBody())
        var now = 0L
        val resolver = SignedUrlStorageResolver(provider(server, clock = { now }))

        val private = resolver.resolve(
            PhotoRef(storagePath = "u/i/tag_1.jpg", photoUrl = "", serverPhotoType = "tag"),
        )
        val public = resolver.resolve(
            PhotoRef(
                storagePath = "u/i/front_1.jpg",
                photoUrl = "https://api.x.com/storage/v1/object/public/item-photos/u/i/front_1.jpg",
                serverPhotoType = "front",
            ),
        )

        // A signed URL must never reach Coil's DISK cache (US-276).
        assertTrue(private!!.isPrivate)
        assertFalse(public!!.isPrivate)
        // Keyed on the storage path, not the rotating signed URL, so the
        // 30s-skew re-sign is a memory-cache hit rather than a re-download.
        assertEquals("submission-images/u/i/tag_1.jpg#0", private.cacheKey)
        assertFalse(private.cacheKey.contains("token="))
        server.shutdown()
    }

    @Test
    fun resolver_returnsNullOnMintFailure_soTheUiRetries() = runTest {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(500))
        var now = 0L
        val resolver = SignedUrlStorageResolver(provider(server, clock = { now }))

        val resolved = resolver.resolve(
            PhotoRef(storagePath = "u/i/tag_1.jpg", serverPhotoType = "tag"),
        )

        assertNull(resolved)
        server.shutdown()
    }
}
