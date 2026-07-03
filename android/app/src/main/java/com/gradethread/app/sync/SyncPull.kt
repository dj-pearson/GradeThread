package com.gradethread.app.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * US-1317: the pull machinery (iOS SyncEngine's paged fetch, US-633/1210).
 * Pure over an injected page fetcher so every invariant unit-tests without a
 * network:
 *
 *  - PAGINATION: 500/page, drained on a short page, hard 50k ceiling per pass
 *    (a runaway table can't spin the loop forever);
 *  - LENIENT DECODE: one malformed row drops THAT ROW, never the page — a
 *    single bad row must never blank a table;
 *  - DROP-SAFE ADVANCE ([safeCursor], US-1210): the cursor only advances to
 *    the max decoded cursor STRICTLY BEFORE the earliest dropped row, so a
 *    dropped row is re-fetched next pass instead of being skipped forever.
 */
object SyncPull {

    const val PAGE_SIZE = 500
    const val MAX_ROWS_PER_PASS = 50_000

    /** One pass's outcome for a table. */
    data class PagedFetch<T>(
        val rows: List<T>,
        val decodedCursors: List<String>,
        val droppedCursors: List<String>,
        /** True when the table was fully drained (short final page). */
        val drained: Boolean,
    )

    /**
     * The US-1210 rule, ported exactly: with no drops, advance to the max
     * decoded cursor; with drops, only to the max decoded cursor strictly
     * before the earliest dropped one (lexical ISO-8601 compare).
     */
    fun safeCursor(decodedCursors: List<String>, droppedCursors: List<String>): String? {
        val earliestDropped = droppedCursors.minOrNull()
            ?: return decodedCursors.maxOrNull()
        return decodedCursors.filter { it < earliestDropped }.maxOrNull()
    }

    /**
     * Paged fetch with lenient decode. [fetchPage] returns raw JSON rows for
     * an offset (server-ordered by updated_at ASC, scoped to the tenant by
     * the caller — see [SyncPull] docs); [decode] returns null for a
     * malformed row, which records its cursor as dropped.
     */
    suspend fun <T> fetchPaged(
        pageSize: Int = PAGE_SIZE,
        maxRows: Int = MAX_ROWS_PER_PASS,
        fetchPage: suspend (offset: Int) -> List<JsonElement>,
        decode: (JsonElement) -> T?,
    ): PagedFetch<T> {
        val rows = mutableListOf<T>()
        val decodedCursors = mutableListOf<String>()
        val droppedCursors = mutableListOf<String>()
        var offset = 0
        var drained = false

        while (true) {
            val page = fetchPage(offset)
            for (raw in page) {
                val cursor = rawCursor(raw)
                val decoded = runCatching { decode(raw) }.getOrNull()
                when {
                    decoded != null -> {
                        rows += decoded
                        cursor?.let { decodedCursors += it }
                    }
                    // A malformed row: remember WHERE it sat so the advance
                    // clamps before it. A row with no readable cursor at all
                    // can't clamp anything — it's unrecoverable noise.
                    cursor != null -> droppedCursors += cursor
                }
            }
            if (page.size < pageSize) {
                drained = true
                break
            }
            offset += pageSize
            if (offset >= maxRows) break // ceiling; next pass continues
        }
        return PagedFetch(rows, decodedCursors, droppedCursors, drained)
    }

    /** Best-effort updated_at extraction — works even when full decode fails. */
    internal fun rawCursor(raw: JsonElement): String? = runCatching {
        raw.jsonObject["updated_at"]?.jsonPrimitive?.content
    }.getOrNull()

    /**
     * US-1317 AC4: the item→primary-photo mapping computed IN MEMORY during
     * the pull (lowest sortOrder wins) — display denormalization only; photo
     * PRESENCE stays the relation (US-994).
     */
    fun primaryPhotoByItem(
        photos: List<Triple<String, Int, String>>, // (itemId, sortOrder, url)
    ): Map<String, String> =
        photos
            .groupBy { it.first }
            .mapValues { (_, itemPhotos) -> itemPhotos.minBy { it.second }.third }

    /** Shared lenient JSON for row decoding. */
    val json: Json = Json { ignoreUnknownKeys = true; isLenient = true }
}
