package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2921: `GET /api/flipdesk/size-bands`.
 *
 * Fetches the expected-size band table for one brand + garment + department.
 * Kept out of [SizeCheck] on purpose: the check itself is pure arithmetic that
 * runs on every keystroke, and the only reason it needs a network at all is to
 * get the table once. The edge marks the response cacheable for half an hour and
 * it does not depend on the caller, so a stale table is never wrong, only old.
 *
 * A failure is NOT an error state. The size check is an assist; when the table
 * cannot be fetched the canvas shows no note and the seller carries on, which is
 * exactly what happens for a brand with no chart on file.
 */
@Singleton
class SizeBandsService @Inject constructor(
    /** The short-idle profile: this is a cached reference read, not a model call. */
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        const val BANDS_PATH = "/api/flipdesk/size-bands"

        /** Half an hour, matching the endpoint's own Cache-Control. */
        const val CACHE_TTL_MILLIS = 30L * 60L * 1000L
    }

    suspend fun load(
        brand: String?,
        garment: String?,
        gender: String?,
    ): SizeCheck.BandsResponse {
        val garmentValue = garment?.trim().orEmpty()
        if (garmentValue.isEmpty()) return SizeCheck.BandsResponse.EMPTY

        val query = buildMap {
            put("garment", garmentValue)
            brand?.trim()?.takeIf { it.isNotEmpty() }?.let { put("brand", it) }
            gender?.trim()?.takeIf { it.isNotEmpty() }?.let { put("gender", it) }
        }

        return runCatching {
            val raw = edge.getRaw(BANDS_PATH, query, CACHE_TTL_MILLIS)
            json.decodeFromString(SizeCheck.BandsResponse.serializer(), raw)
        }.getOrDefault(SizeCheck.BandsResponse.EMPTY)
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
}
