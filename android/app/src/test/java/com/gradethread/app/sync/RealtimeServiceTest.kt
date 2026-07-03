package com.gradethread.app.sync

import com.gradethread.app.sync.RealtimeService.Phase
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1321: the pure realtime rules — the US-1211 catch-up decision, lenient
 * row decoding, and timestamp parsing. Socket lifecycle is device territory.
 */
class RealtimeServiceTest {

    // ── US-1211: catch-up on every transition INTO subscribed ──

    @Test
    fun catchUp_firesOnFirstSubscribeAndEveryReconnect() {
        assertTrue(RealtimeService.shouldCatchUp(Phase.IDLE, Phase.SUBSCRIBED))
        assertTrue(RealtimeService.shouldCatchUp(Phase.SUBSCRIBING, Phase.SUBSCRIBED))
        assertTrue(RealtimeService.shouldCatchUp(Phase.RECONNECTING, Phase.SUBSCRIBED))
    }

    @Test
    fun catchUp_neverFiresOtherwise() {
        assertFalse(RealtimeService.shouldCatchUp(Phase.SUBSCRIBED, Phase.SUBSCRIBED))
        assertFalse(RealtimeService.shouldCatchUp(Phase.SUBSCRIBED, Phase.IDLE))
        assertFalse(RealtimeService.shouldCatchUp(Phase.IDLE, Phase.SUBSCRIBING))
        assertFalse(RealtimeService.shouldCatchUp(Phase.SUBSCRIBED, Phase.RECONNECTING))
    }

    // ── Row decoding ──

    @Test
    fun inventoryRow_decodesWithLowercasedIdAndParsedTimestamps() {
        val entity = RealtimeRows.decodeInventoryRow(
            buildJsonObject {
                put("id", "ABC-DEF") // server should be lowercase; normalize anyway
                put("user_id", "u1")
                put("title", "Vintage jacket")
                put("status", "cataloged")
                put("grade_value", 8.5)
                put("updated_at", "2026-07-03T10:15:30+00:00")
                put("unknown_column", "ignored")
            },
        )!!
        assertEquals("abc-def", entity.id)
        assertEquals("Vintage jacket", entity.title)
        assertEquals("cataloged", entity.status)
        assertEquals(8.5, entity.gradeValue!!, 0.0)
        assertTrue(entity.updatedAt > 0)
    }

    @Test
    fun malformedRow_isDroppedNotThrown() {
        // Missing the required id → null (the catch-up pull repairs).
        assertNull(RealtimeRows.decodeInventoryRow(buildJsonObject { put("user_id", "u1") }))
    }

    @Test
    fun deleteIdExtraction_normalizesCase() {
        assertEquals(
            "abc",
            RealtimeRows.idOf(buildJsonObject { put("id", "ABC") }),
        )
        assertNull(RealtimeRows.idOf(buildJsonObject { put("other", "x") }))
    }

    // ── Timestamp parsing ──

    @Test
    fun timestamps_parseAllThreeServerShapes() {
        // Postgres timestamptz with offset:
        assertEquals(
            1_751_537_730_000L,
            RealtimeRows.parseTimestamp("2025-07-03T10:15:30+00:00"),
        )
        // Zulu:
        assertEquals(
            1_751_537_730_000L,
            RealtimeRows.parseTimestamp("2025-07-03T10:15:30Z"),
        )
        // Date-only (acquired_date):
        assertEquals(
            1_751_500_800_000L,
            RealtimeRows.parseTimestamp("2025-07-03"),
        )
        assertNull(RealtimeRows.parseTimestamp(null))
        assertNull(RealtimeRows.parseTimestamp("not a date"))
    }
}
