package com.gradethread.app.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2151: the sync coordinator's ordering and cursor-advance rules.
 *
 * The primitives were already tested in isolation (US-1317); what was never
 * tested is the ASSEMBLY, because there wasn't one. These are the rules that
 * decide whether a pull can lose data.
 */
class SyncCoordinatorTest {

    private fun row(id: String, updatedAt: String): JsonElement = JsonObject(
        mapOf("id" to JsonPrimitive(id), "updated_at" to JsonPrimitive(updatedAt)),
    )

    /** Decodes to the id; a row whose id starts with "bad" fails to decode. */
    private val decodeId: (JsonElement) -> String? = { raw ->
        val id = (raw as JsonObject)["id"]?.let { (it as JsonPrimitive).content }
        if (id == null || id.startsWith("bad")) null else id
    }

    private class Recorder {
        val applied = mutableListOf<List<String>>()
        val advanced = mutableListOf<Pair<SyncWatermark.Table, String>>()
        var cursor: String? = null
    }

    private fun coordinator(
        recorder: Recorder,
        pages: List<List<JsonElement>>,
        apply: suspend (List<String>) -> Unit = { recorder.applied += it },
    ) = SyncCoordinator(
        tables = listOf(
            SyncCoordinator.TablePlan(
                table = SyncWatermark.Table.ITEMS,
                fetchPage = { _, offset ->
                    pages.getOrElse(offset / SyncPull.PAGE_SIZE) { emptyList() }
                },
                decode = decodeId,
                apply = apply,
            ),
        ),
        readCursor = { recorder.cursor },
        advanceCursor = { table, cursor -> recorder.advanced += table to cursor },
    )

    @Test
    fun aCleanPullAppliesRowsAndAdvancesToTheMaxCursor() = runTest {
        val r = Recorder()
        val outcome = coordinator(
            r,
            listOf(listOf(row("a", "2026-01-01"), row("b", "2026-01-02"))),
        ).pullAll()

        assertEquals(listOf(listOf("a", "b")), r.applied)
        assertEquals(SyncWatermark.Table.ITEMS to "2026-01-02", r.advanced.single())
        assertTrue(outcome.succeeded)
        assertEquals(2, outcome.rowsApplied)
    }

    @Test
    fun rowsAreAppliedBeforeTheCursorAdvances() = runTest {
        // Ordering is the whole safety property: advancing past rows that were
        // never written loses them permanently, because the next pass filters
        // them out with gt(updated_at, cursor).
        val order = mutableListOf<String>()
        SyncCoordinator(
            tables = listOf(
                SyncCoordinator.TablePlan(
                    table = SyncWatermark.Table.ITEMS,
                    fetchPage = { _, offset ->
                        if (offset == 0) listOf(row("a", "2026-01-01")) else emptyList()
                    },
                    decode = decodeId,
                    apply = { order += "apply" },
                ),
            ),
            readCursor = { null },
            advanceCursor = { _, _ -> order += "advance" },
        ).pullAll()
        assertEquals(listOf("apply", "advance"), order)
    }

    @Test
    fun aFailedApplyDoesNotAdvanceTheCursor() = runTest {
        // So the next pass re-pulls the same rows. Upserts are idempotent, so
        // re-applying is free; skipping them is not.
        val r = Recorder()
        val outcome = coordinator(
            r,
            listOf(listOf(row("a", "2026-01-01"))),
            apply = { error("write failed") },
        ).pullAll()

        assertTrue(r.advanced.isEmpty())
        assertFalse(outcome.succeeded)
        assertEquals(1, outcome.failures.size)
    }

    @Test
    fun aDroppedRowClampsTheAdvanceBeforeIt() = runTest {
        // US-1210: advancing past a row that failed to decode would skip it
        // forever. The cursor stops at the last good row BEFORE the bad one.
        val r = Recorder()
        coordinator(
            r,
            listOf(
                listOf(
                    row("a", "2026-01-01"),
                    row("bad", "2026-01-02"),
                    row("c", "2026-01-03"),
                ),
            ),
        ).pullAll()

        assertEquals(listOf(listOf("a", "c")), r.applied)
        // NOT 2026-01-03 — that would strand the bad row permanently.
        assertEquals("2026-01-01", r.advanced.single().second)
    }

    @Test
    fun anEmptyPullAdvancesNothing() = runTest {
        val r = Recorder()
        val outcome = coordinator(r, listOf(emptyList())).pullAll()
        assertTrue(r.applied.isEmpty())
        assertTrue(r.advanced.isEmpty())
        assertTrue(outcome.succeeded)
        assertEquals(0, outcome.rowsApplied)
    }

    @Test
    fun aPageOfOnlyUndecodableRowsAdvancesNothing() = runTest {
        val r = Recorder()
        coordinator(r, listOf(listOf(row("bad1", "2026-01-01")))).pullAll()
        assertTrue(r.applied.isEmpty())
        // No good cursor before the earliest drop, so nothing is safe to claim.
        assertTrue(r.advanced.isEmpty())
    }

    @Test
    fun oneFailingTableDoesNotAbortTheOthers() = runTest {
        // An inventory pull is still worth having when listings misbehave.
        val advanced = mutableListOf<SyncWatermark.Table>()
        val outcome = SyncCoordinator(
            tables = listOf(
                SyncCoordinator.TablePlan(
                    table = SyncWatermark.Table.ITEMS,
                    fetchPage = { _, _ -> error("network died") },
                    decode = decodeId,
                    apply = {},
                ),
                SyncCoordinator.TablePlan(
                    table = SyncWatermark.Table.PHOTOS,
                    fetchPage = { _, offset ->
                        if (offset == 0) listOf(row("p", "2026-01-05")) else emptyList()
                    },
                    decode = decodeId,
                    apply = {},
                ),
            ),
            readCursor = { null },
            advanceCursor = { table, _ -> advanced += table },
        ).pullAll()

        assertEquals(listOf(SyncWatermark.Table.PHOTOS), advanced)
        assertEquals(1, outcome.failures.size)
        assertEquals(SyncWatermark.Table.ITEMS, outcome.failures.single().table)
        assertFalse(outcome.succeeded)
    }

    @Test
    fun theCursorIsPassedToTheFetch() = runTest {
        // Without this the pull is a full table scan every pass rather than a
        // delta, which is the entire point of the watermark.
        var seen: String? = "not-called"
        SyncCoordinator(
            tables = listOf(
                SyncCoordinator.TablePlan(
                    table = SyncWatermark.Table.ITEMS,
                    fetchPage = { cursor, _ -> seen = cursor; emptyList() },
                    decode = decodeId,
                    apply = {},
                ),
            ),
            readCursor = { "2026-01-01T00:00:00Z" },
            advanceCursor = { _, _ -> },
        ).pullAll()
        assertEquals("2026-01-01T00:00:00Z", seen)
    }

    @Test
    fun pullAllIfIdleSkipsWhenAPullIsAlreadyRunning() = runTest {
        // A foreground event landing on a sign-in pull would otherwise run two
        // passes over the same cursor concurrently.
        val r = Recorder()
        val c = coordinator(r, listOf(emptyList()))
        assertFalse(c.isRunning)
        // Not running, so it proceeds.
        assertTrue(c.pullAllIfIdle() != null)
    }

    @Test
    fun aShortFinalPageMarksTheTableDrained() = runTest {
        val r = Recorder()
        val outcome = coordinator(r, listOf(listOf(row("a", "2026-01-01")))).pullAll()
        assertTrue(outcome.results.single().drained)
        assertFalse(outcome.hasMore)
    }

    @Test
    fun droppedRowsAreReported() = runTest {
        val r = Recorder()
        val outcome = coordinator(
            r,
            listOf(listOf(row("a", "2026-01-01"), row("bad", "2026-01-02"))),
        ).pullAll()
        assertEquals(1, outcome.results.single().rowsDropped)
        assertEquals(1, outcome.results.single().rowsApplied)
    }

    @Test
    fun advancedToIsReportedForObservability() = runTest {
        val r = Recorder()
        val outcome = coordinator(r, listOf(listOf(row("a", "2026-01-09")))).pullAll()
        assertEquals("2026-01-09", outcome.results.single().advancedTo)
    }

    @Test
    fun aFailedTableReportsNoAdvance() = runTest {
        val outcome = SyncCoordinator(
            tables = listOf(
                SyncCoordinator.TablePlan(
                    table = SyncWatermark.Table.ITEMS,
                    fetchPage = { _, _ -> error("boom") },
                    decode = decodeId,
                    apply = {},
                ),
            ),
            readCursor = { null },
            advanceCursor = { _, _ -> },
        ).pullAll()
        assertNull(outcome.results.single().advancedTo)
        assertFalse(outcome.results.single().drained)
    }
}
