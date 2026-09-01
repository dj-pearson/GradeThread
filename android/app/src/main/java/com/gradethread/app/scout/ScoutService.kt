package com.gradethread.app.scout

import android.util.Base64
import com.gradethread.app.inventory.CategorySuggestResponse
import com.gradethread.app.inventory.CategorySuggestion
import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1374: the Scout and Prospect endpoints.
 *
 * Goes through [EdgeApi] like everything else on Android. iOS needed a bespoke
 * transport here because its shared client snake-cases keys and would mangle
 * the camelCase scout payload; kotlinx.serialization names every field
 * explicitly, so there is nothing to work around — and using the shared client
 * means the 402 plan gate reaches the shell's upgrade dialog for free.
 */
interface ScoutScanning {
    /** A sharper eBay leaf category from free text, or null. */
    suspend fun suggestCategory(query: String): CategorySuggestion?

    suspend fun scan(categoryId: String, q: String?, brand: String?, limit: Int): ScoutScanResponse

    /**
     * Identify and comp an item from one or two photos.
     *
     * Each photo carries its own role. The edge decides who identifies the item
     * from the roles alone, so a photo without one can never reach eBay visual
     * search however good a garment shot it is (US-3027).
     */
    suspend fun prospect(photos: List<ProspectPhotoBytes>, costCents: Int?): ProspectResponse

    /** Commit a prospected item into inventory at `sourced`. */
    suspend fun buy(request: ProspectBuyRequest): ProspectBuyResponse
}

@Singleton
class ScoutService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) : ScoutScanning {

    companion object {
        const val SUGGEST_PATH = "/api/flipdesk/ebay/category/suggest"
        const val SCAN_PATH = "/api/flipdesk/scout"
        const val PROSPECT_PATH = "/api/flipdesk/scout/prospect"
        const val BUY_PATH = "/api/flipdesk/scout/buy"

        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        /** The edge takes photos as data URIs and stores none of them. */
        fun dataUri(bytes: ByteArray): String =
            "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    /**
     * A failed suggest is NOT fatal.
     *
     * The caller falls back to the broad apparel root, so a taxonomy blip
     * narrows the results rather than stopping the scan. Throwing here would
     * turn a nice-to-have into a hard dependency.
     */
    override suspend fun suggestCategory(query: String): CategorySuggestion? {
        val q = query.trim()
        if (q.isEmpty()) return null
        return runCatching {
            json.decodeFromString(
                CategorySuggestResponse.serializer(),
                edge.getRaw(SUGGEST_PATH, mapOf("q" to q)),
            ).suggestions.firstOrNull()
        }.getOrNull()
    }

    override suspend fun scan(
        categoryId: String,
        q: String?,
        brand: String?,
        limit: Int,
    ): ScoutScanResponse = json.decodeFromString(
        ScoutScanResponse.serializer(),
        edge.postRaw(
            SCAN_PATH,
            json.encodeToString(
                ScoutScanRequest.serializer(),
                ScoutScanRequest(categoryId, q, brand, limit),
            ),
        ),
    )

    override suspend fun prospect(
        photos: List<ProspectPhotoBytes>,
        costCents: Int?,
    ): ProspectResponse = json.decodeFromString(
        ProspectResponse.serializer(),
        edge.postRaw(
            PROSPECT_PATH,
            json.encodeToString(
                ProspectRequest.serializer(),
                // Both lists are built from the SAME list of pairs in one pass,
                // which is the only reason they cannot drift out of step.
                ProspectRequest(
                    images = photos.map { dataUri(it.bytes) },
                    imageRoles = photos.map { it.role.wire },
                    costCents = costCents,
                ),
            ),
        ),
    )

    override suspend fun buy(request: ProspectBuyRequest): ProspectBuyResponse =
        json.decodeFromString(
            ProspectBuyResponse.serializer(),
            edge.postRaw(
                BUY_PATH,
                json.encodeToString(ProspectBuyRequest.serializer(), request),
            ),
        )
}
