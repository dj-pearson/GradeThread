package com.gradethread.app.platform.telemetry

import com.gradethread.app.platform.net.SharedHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * US-2897: the coarse country signal the consent regime is chosen from.
 *
 * Reads `https://gradethread.com/geo.json`, the SAME endpoint the web consent
 * banner uses. That endpoint is a Cloudflare Pages Function reading
 * `request.cf.country` at the edge, so no third-party IP-geolocation service is
 * involved — which would itself be a privacy problem, and is the reason the web
 * side built it this way.
 *
 * ⚠ IT MUST BE THE PAGES SITE, not the edge service. `functions.gradethread.com`
 * runs on Coolify, behind no Cloudflare edge, so `request.cf` does not exist
 * there and the endpoint could only ever answer "unknown". Pointing this at the
 * API host would fail safe (every seller treated as opt-in) and look like it was
 * working.
 *
 * NOTHING IS SENT. This is a plain GET with no body, no identifier and no
 * cookie; the country comes from the network path the request already takes.
 * The response is held for the life of the process and never written to disk —
 * a cached country is a location on disk, and it is cheap enough to re-ask.
 */
object GeoService {

    /** The Pages site. See the warning above about why not the edge host. */
    private const val GEO_URL = "https://gradethread.com/geo.json"

    /**
     * Short on purpose.
     *
     * PostHog does not start until this resolves, so the timeout is a cap on
     * how long analytics is held back, not on how long a seller waits — nothing
     * user-facing blocks on it. Failing to unknown costs a US seller's early
     * events, which is the right way round: the alternative is running
     * analytics for an EU seller because a request was slow.
     */
    private const val TIMEOUT_MS = 4_000L

    @Serializable
    private data class GeoResponse(
        val country: String? = null,
        val regionCode: String? = null,
        val isEU: Boolean = false,
    )

    private val json = Json { ignoreUnknownKeys = true }

    private val client by lazy {
        SharedHttp.variant {
            connectTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            readTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
        }
    }

    @Volatile
    private var cached: GeoSignal? = null

    /**
     * The signal, fetched once per process.
     *
     * NEVER THROWS and never returns null. Every failure path — no network, a
     * timeout, a 500, malformed JSON, Cloudflare's "T1"/"XX" placeholders —
     * resolves to [GeoSignal.UNKNOWN], which [Consent.regimeFor] maps to
     * OPT_IN. The strict answer has to be what a failure produces, or the
     * failure mode is running analytics on someone who never agreed.
     */
    suspend fun signal(): GeoSignal {
        cached?.let { return it }
        val resolved = withTimeoutOrNull(TIMEOUT_MS) { fetch() } ?: GeoSignal.UNKNOWN
        cached = resolved
        return resolved
    }

    private suspend fun fetch(): GeoSignal = withContext(Dispatchers.IO) {
        runCatching {
            client.newCall(Request.Builder().url(GEO_URL).get().build()).execute().use { response ->
                if (!response.isSuccessful) return@use GeoSignal.UNKNOWN
                val body = response.body?.string() ?: return@use GeoSignal.UNKNOWN
                val parsed = json.decodeFromString<GeoResponse>(body)
                GeoSignal(
                    country = normalizeCountry(parsed.country),
                    regionCode = parsed.regionCode?.takeIf { it.isNotBlank() },
                    isEU = parsed.isEU,
                )
            }
        }.getOrDefault(GeoSignal.UNKNOWN)
    }

    /**
     * Cloudflare uses "T1" (Tor) and "XX" for unresolvable, and the web client
     * maps both to null so the strict default applies. Same treatment here —
     * a Tor exit node is precisely the visitor not to guess about.
     */
    internal fun normalizeCountry(raw: String?): String? {
        val trimmed = raw?.trim()?.uppercase()
        return if (trimmed.isNullOrEmpty() || trimmed == "T1" || trimmed == "XX") null else trimmed
    }

    /** Tests only: forget the cached signal. */
    internal fun resetForTest() {
        cached = null
    }
}
