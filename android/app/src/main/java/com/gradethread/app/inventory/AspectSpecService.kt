package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1347: `GET /api/flipdesk/ebay/category/:id/aspects`.
 *
 * The edge caches eBay's taxonomy response, so this is cheap to call whenever
 * the editor opens rather than something to hoard client-side and let go
 * stale.
 */
@Singleton
class AspectSpecService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        fun aspectsPath(categoryId: String) =
            "/api/flipdesk/ebay/category/$categoryId/aspects"
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    suspend fun fetch(categoryId: String?): AspectSpecState {
        val id = categoryId?.trim().orEmpty()
        // Without a resolved leaf category there is no spec to fetch — a
        // distinct state from "the fetch failed", because the fix is different
        // (resolve a category first, via comps).
        if (id.isEmpty()) return AspectSpecState.NoCategory

        return runCatching {
            val raw = edge.getRaw(aspectsPath(id))
            json.decodeFromString(AspectSpecResponse.serializer(), raw)
        }.fold(
            onSuccess = { AspectSpecState.Loaded(it.aspectList, it.categoryName) },
            onFailure = { error ->
                AspectSpecState.Failed(
                    (error as? EdgeApiError)?.userMessage()
                        ?: error.message
                        ?: "Couldn't load item specifics for this category.",
                )
            },
        )
    }
}
