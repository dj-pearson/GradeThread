package com.gradethread.app.sync

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2792: is SyncStatusBar actually fed, and by the right five things?
 *
 * SyncStatus.derive is pure and already tested, so the DECISION was never the
 * problem — 119 lines of sync UI simply rendered nowhere. These assert the
 * plumbing that was missing, and each one names a way of getting it subtly
 * wrong rather than merely absent.
 */
class SyncStatusWiringTest {

    private fun source(path: String) = File("src/main/java/com/gradethread/app/$path").readText()

    @Test
    fun theShellRendersTheBar() {
        val shell = source("ui/shell/AppShell.kt")
        assertTrue("nothing mounts the sync bar", shell.contains("SyncStatusHost()"))
        assertTrue(
            "the host is not imported",
            shell.contains("import com.gradethread.app.sync.SyncStatusHost"),
        )
    }

    @Test
    fun allFiveInputsReachDerive() {
        // derive() takes five arguments and the priority between them is the
        // whole design. Dropping one does not fail to compile — it silently
        // pins that input to a constant, and the bar then lies in one specific
        // situation that nobody will think to test by hand.
        val vm = source("sync/SyncStatusViewModel.kt")
        for (input in listOf(
            "observePendingCount(",
            "observeStuckCount(",
            "syncService.syncing",
            "connectivity.online",
            "realtime.phase",
        )) {
            assertTrue("$input no longer reaches the status", vm.contains(input))
        }
        assertTrue("derive is bypassed", vm.contains("SyncStatus.derive("))
    }

    @Test
    fun syncingComesFromTheSingleton_notThePerPullCoordinator() {
        // The mistake this replaced: a flow on SyncCoordinator. That object is
        // built PER PULL inside SyncService.pull(), so an observable on it
        // belongs to something nothing outside can reach — an observable nobody
        // can observe, which is the exact bug this whole story is about.
        val service = source("sync/SyncService.kt")
        assertTrue("SyncService no longer publishes syncing", service.contains("val syncing:"))
        assertTrue(
            "the flag is not cleared in a finally — a thrown pull would stick on Syncing",
            service.substringAfter("syncingFlow.value = true").substringBefore("}}")
                .contains("finally"),
        )
        assertTrue(
            "SyncCoordinator grew its own flow again — it is per-pull and unreachable",
            !source("sync/SyncCoordinator.kt").contains("val running:"),
        )
    }

    @Test
    fun pendingAndStuckAreCountedSEPARATELY() {
        // They mean different things to a seller: queued work will go on its
        // own once there is a connection, stuck work has exhausted its retries
        // and needs a deliberate retry or discard. One query counting both
        // would promise a stuck row is still trying.
        val dao = source("sync/db/Daos.kt")
        assertTrue(
            "pending no longer excludes stuck rows",
            dao.contains("WHERE retryCount < :maxRetries"),
        )
        assertTrue(
            "stuck is not counted on the retry budget",
            dao.contains("WHERE retryCount >= :maxRetries"),
        )
    }

    @Test
    fun realtimeDISABLEDIsNotReportedAsReconnecting() {
        // Realtime switched off is a settled state. Mapping it to RECONNECTING
        // would show "Reconnecting…" forever as the loudest possible way of
        // saying nothing is wrong.
        val vm = source("sync/SyncStatusViewModel.kt")
        assertTrue(
            "reconnecting is no longer pinned to the RECONNECTING phase alone",
            vm.contains("phase == RealtimeService.Phase.RECONNECTING"),
        )
    }
}
