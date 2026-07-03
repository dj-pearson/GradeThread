package com.gradethread.app.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1317: the pull invariants — the US-1210 drop-safe advance, lenient
 * per-row decode, pagination drain + ceiling, and the primary-photo mapping.
 */
class SyncPullTest {

    // ── safeCursor (the US-1210 matrix) ──

    @Test
    fun safeCursor_noDrops_advancesToMax() {
        assertEquals(
            "2026-07-03T10:00:00Z",
            SyncPull.safeCursor(
                decodedCursors = listOf("2026-07-03T09:00:00Z", "2026-07-03T10:00:00Z"),
                droppedCursors = emptyList(),
            ),
        )
    }

    @Test
    fun safeCursor_clampsStrictlyBeforeTheEarliestDrop() {
        assertEquals(
            "2026-07-03T09:00:00Z",
            SyncPull.safeCursor(
                decodedCursors = listOf(
                    "2026-07-03T09:00:00Z",
                    "2026-07-03T10:00:00Z", // decoded but AFTER the drop — unsafe
                ),
                droppedCursors = listOf("2026-07-03T09:30:00Z"),
            ),
        )
    }

    @Test
    fun safeCursor_dropAtTheSameInstantIsNotPassed() {
        // STRICTLY before: a decoded cursor equal to the drop can't advance.
        assertNull(
            SyncPull.safeCursor(
                decodedCursors = listOf("2026-07-03T09:30:00Z"),
                droppedCursors = listOf("2026-07-03T09:30:00Z"),
            ),
        )
    }

    @Test
    fun safeCursor_everythingDropped_neverAdvances() {
        assertNull(
            SyncPull.safeCursor(
                decodedCursors = emptyList(),
                droppedCursors = listOf("2026-07-03T09:00:00Z"),
            ),
        )
    }

    @Test
    fun safeCursor_emptyPass_isNull() {
        assertNull(SyncPull.safeCursor(emptyList(), emptyList()))
    }

    // ── fetchPaged ──

    private fun row(id: String, cursor: String, good: Boolean = true): JsonElement =
        buildJsonObject {
            put("id", id)
            put("updated_at", cursor)
            if (!good) put("malformed", true)
        }

    private fun decodeGood(raw: JsonElement): String? {
        val obj = raw.jsonObject
        if (obj.containsKey("malformed")) return null
        return obj["id"]?.jsonPrimitive?.content
    }

    @Test
    fun lenientDecode_dropsTheRowNeverThePage() = runTest {
        val page = listOf(
            row("a", "T1"),
            row("bad", "T2", good = false),
            row("c", "T3"),
        )
        val fetch = SyncPull.fetchPaged(
            fetchPage = { if (it == 0) page else emptyList() },
            decode = ::decodeGood,
        )
        assertEquals(listOf("a", "c"), fetch.rows)
        assertEquals(listOf("T1", "T3"), fetch.decodedCursors)
        assertEquals(listOf("T2"), fetch.droppedCursors)
        assertTrue(fetch.drained)
        // The composed advance re-fetches the dropped row next pass.
        assertEquals("T1", SyncPull.safeCursor(fetch.decodedCursors, fetch.droppedCursors))
    }

    @Test
    fun aThrowingDecode_countsAsDroppedToo() = runTest {
        val fetch = SyncPull.fetchPaged(
            fetchPage = { if (it == 0) listOf(row("a", "T1")) else emptyList() },
            decode = { error("decoder exploded") },
        )
        assertEquals(0, fetch.rows.size)
        assertEquals(listOf("T1"), fetch.droppedCursors)
    }

    @Test
    fun pagination_drainsOnShortPage_andHonorsTheCeiling() = runTest {
        // Full pages forever: the ceiling must stop the loop, not drain it.
        var pagesServed = 0
        val fullPage = (0 until 500).map { row("r$it", "T$it") }
        val capped = SyncPull.fetchPaged(
            fetchPage = { pagesServed += 1; fullPage },
            decode = ::decodeGood,
        )
        assertEquals(SyncPull.MAX_ROWS_PER_PASS, capped.rows.size)
        assertEquals(SyncPull.MAX_ROWS_PER_PASS / SyncPull.PAGE_SIZE, pagesServed)
        assertFalse(capped.drained)

        // A short page drains normally.
        val drained = SyncPull.fetchPaged(
            fetchPage = { if (it == 0) listOf(row("a", "T1")) else emptyList() },
            decode = ::decodeGood,
        )
        assertTrue(drained.drained)
    }

    @Test
    fun rowWithNoCursor_cannotClampTheAdvance() = runTest {
        val cursorless = buildJsonObject { put("id", "x"); put("malformed", true) }
        val fetch = SyncPull.fetchPaged(
            fetchPage = { if (it == 0) listOf(cursorless, row("a", "T2")) else emptyList() },
            decode = ::decodeGood,
        )
        assertEquals(emptyList<String>(), fetch.droppedCursors)
        assertEquals("T2", SyncPull.safeCursor(fetch.decodedCursors, fetch.droppedCursors))
    }

    // ── Primary-photo mapping (AC4) ──

    @Test
    fun primaryPhoto_isTheLowestSortOrderPerItem() {
        val mapping = SyncPull.primaryPhotoByItem(
            listOf(
                Triple("item1", 2, "https://x/2.jpg"),
                Triple("item1", 0, "https://x/0.jpg"),
                Triple("item2", 5, "https://x/5.jpg"),
            ),
        )
        assertEquals("https://x/0.jpg", mapping["item1"])
        assertEquals("https://x/5.jpg", mapping["item2"])
        assertNull(mapping["item3"])
    }
}
