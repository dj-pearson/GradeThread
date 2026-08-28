package com.gradethread.app.platform.net

import com.gradethread.app.upload.PhotoSignedUrlProvider
import okhttp3.CookieJar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Do the app's HTTP clients actually share one networking stack?
 *
 * The bug this guards against is invisible at runtime and free to reintroduce:
 * an `OkHttpClient.Builder()` anywhere gives that caller its own connection
 * pool and its own dispatcher thread pool, and nothing fails - the app just
 * carries a second networking stack and re-handshakes TLS against a host it
 * already had a connection to. Identity assertions are the only thing that can
 * tell the two apart.
 */
class SharedHttpTest {

    @Test
    fun everyProfileSharesTheBasePoolAndDispatcher() {
        val clients = listOf(
            EdgeNetwork.sharedClient(),
            EdgeNetwork.aiClient(),
            PhotoSignedUrlProvider.ephemeralClient(),
        )
        for (client in clients) {
            assertSame(
                "a client built its own connection pool instead of sharing",
                SharedHttp.base.connectionPool,
                client.connectionPool,
            )
            assertSame(
                "a client built its own dispatcher, and so its own thread pool",
                SharedHttp.base.dispatcher,
                client.dispatcher,
            )
        }
    }

    @Test
    fun sharingDoesNotFlattenTheProfilesTimeouts() {
        // The whole reason there are separate profiles: a vision call needs
        // room a stalled list request must not get.
        assertEquals(20, EdgeNetwork.sharedClient().readTimeoutMillis / 1_000)
        assertEquals(120, EdgeNetwork.aiClient().readTimeoutMillis / 1_000)
        assertEquals(60, EdgeNetwork.sharedClient().callTimeoutMillis / 1_000)
        assertEquals(180, EdgeNetwork.aiClient().callTimeoutMillis / 1_000)
    }

    /**
     * The signed-URL client mints URLs carrying a bearer token, so it must
     * never acquire a store to leak one into. Sharing a pool and a dispatcher
     * shares TCP connections and threads; neither carries a credential. A
     * cache or a cookie jar would.
     */
    @Test
    fun nothingInTheChainCanPersistACredential() {
        val minter = PhotoSignedUrlProvider.ephemeralClient()
        assertNull("the signed-URL client acquired a disk cache", minter.cache)
        assertSame("the signed-URL client acquired a cookie jar", CookieJar.NO_COOKIES, minter.cookieJar)
        assertNull("the base client acquired a disk cache", SharedHttp.base.cache)
        assertSame("the base client acquired a cookie jar", CookieJar.NO_COOKIES, SharedHttp.base.cookieJar)
    }

    @Test
    fun variantsAreDistinctInstances() {
        // Sharing resources is not the same as being the same client - a
        // variant that returned `base` would silently take base's timeouts.
        val a = EdgeNetwork.sharedClient()
        val b = EdgeNetwork.aiClient()
        assertNotSame(a, b)
        assertNotSame(a, SharedHttp.base)
        assertEquals(
            "the base client is not meant to carry a call timeout of its own",
            0,
            SharedHttp.base.callTimeoutMillis,
        )
        assertEquals(TimeUnit.SECONDS.toMillis(60).toInt(), a.callTimeoutMillis)
    }
}
