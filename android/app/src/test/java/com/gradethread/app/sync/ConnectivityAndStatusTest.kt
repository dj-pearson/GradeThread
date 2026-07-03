package com.gradethread.app.sync

import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * US-1322: the US-997 debounce semantics, the status derivation priority,
 * and the US-1142 save-failure notice threshold.
 */
class ConnectivityAndStatusTest {

    @Before
    fun setUp() = PersistenceHealth.resetForTest()

    @After
    fun tearDown() = PersistenceHealth.resetForTest()

    // ── ConnectivityDebouncer (US-997) ──

    @Test
    fun aFlapStorm_coalescesIntoOneTrailingFire() = runTest {
        var fires = 0
        val debouncer = ConnectivityDebouncer(this, windowMs = 2_000) { fires += 1 }

        repeat(5) {
            debouncer.trigger()
            advanceTimeBy(500) // each flap arrives inside the window
        }
        assertEquals(0, fires) // still deferring — the burst keeps restarting it
        advanceTimeBy(2_001)
        runCurrent()
        assertEquals(1, fires) // exactly once after the link settles
    }

    @Test
    fun separatedTriggers_eachFire() = runTest {
        var fires = 0
        val debouncer = ConnectivityDebouncer(this, windowMs = 2_000) { fires += 1 }
        debouncer.trigger()
        advanceTimeBy(2_001); runCurrent()
        debouncer.trigger()
        advanceTimeBy(2_001); runCurrent()
        assertEquals(2, fires)
    }

    @Test
    fun manualSync_bypassesTheWindowAndCancelsThePendingRun() = runTest {
        var fires = 0
        val debouncer = ConnectivityDebouncer(this, windowMs = 2_000) { fires += 1 }
        debouncer.trigger() // pending
        debouncer.fireNow() // user gesture: immediate
        assertEquals(1, fires)
        advanceTimeBy(3_000); runCurrent()
        assertEquals(1, fires) // the pending run was cancelled, not doubled
    }

    // ── Status derivation priority ──

    @Test
    fun stuckChanges_beatEverything() {
        assertEquals(
            SyncStatus.NEEDS_ATTENTION,
            SyncStatus.derive(stuckCount = 1, syncing = true, pendingCount = 5, online = false, reconnecting = true),
        )
    }

    @Test
    fun derivation_matrix() {
        assertEquals(
            SyncStatus.SYNCING,
            SyncStatus.derive(0, syncing = true, pendingCount = 3, online = true, reconnecting = false),
        )
        assertEquals(
            SyncStatus.OFFLINE,
            SyncStatus.derive(0, syncing = false, pendingCount = 3, online = false, reconnecting = false),
        )
        assertEquals(
            SyncStatus.PENDING,
            SyncStatus.derive(0, syncing = false, pendingCount = 3, online = true, reconnecting = false),
        )
        // Cold launch offline, nothing queued: offline immediately (AC2).
        assertEquals(
            SyncStatus.OFFLINE,
            SyncStatus.derive(0, syncing = false, pendingCount = 0, online = false, reconnecting = false),
        )
        assertEquals(
            SyncStatus.RECONNECTING,
            SyncStatus.derive(0, syncing = false, pendingCount = 0, online = true, reconnecting = true),
        )
        assertEquals(
            SyncStatus.IDLE,
            SyncStatus.derive(0, syncing = false, pendingCount = 0, online = true, reconnecting = false),
        )
    }

    // ── PersistenceHealth (US-1142) ──

    @Test
    fun notice_surfacesOnlyAfterPersistentFailures() {
        val error = RuntimeException("disk full")
        PersistenceHealth.recordSaveFailure("upsert items", error)
        PersistenceHealth.recordSaveFailure("upsert sales", error)
        assertFalse(PersistenceHealth.noticeNeeded.value) // two blips ≠ persistent
        PersistenceHealth.recordSaveFailure("upsert photos", error)
        assertTrue(PersistenceHealth.noticeNeeded.value)
    }

    @Test
    fun acknowledging_resetsSoTheNoticeReArmsOnNewTrouble() {
        val error = RuntimeException("disk full")
        repeat(3) { PersistenceHealth.recordSaveFailure("op", error) }
        assertTrue(PersistenceHealth.noticeNeeded.value)

        PersistenceHealth.acknowledgeNotice()
        assertFalse(PersistenceHealth.noticeNeeded.value)

        // One more failure is a blip again, not an instant re-notice.
        PersistenceHealth.recordSaveFailure("op", error)
        assertFalse(PersistenceHealth.noticeNeeded.value)
    }
}
