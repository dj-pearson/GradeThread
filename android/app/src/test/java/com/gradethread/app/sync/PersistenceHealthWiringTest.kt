package com.gradethread.app.sync

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2792: is PersistenceHealth actually CONNECTED at both ends?
 *
 * Its behaviour — the failure threshold, acknowledging, re-arming — is already
 * covered by ConnectivityAndStatusTest and is not repeated here. What that
 * cannot see is whether anything CALLS it, and for years nothing did: every one
 * of its mentions was in its own file or in that test, so a Room write failing
 * on a full disk was counted, breadcrumbed, and shown to nobody.
 *
 * These are wiring claims — does this call that, does that render this — and a
 * source scan is the right instrument for wiring even though it is the wrong
 * one for logic. Written this way from the start because AC2 of this same story
 * taught it the expensive way: three mutations that deleted the feature outright
 * left a behaviour-only suite completely green.
 */
class PersistenceHealthWiringTest {

    private fun source(path: String) = File("src/main/java/com/gradethread/app/$path").readText()

    @Test
    fun theLocalWriteRecordsAFailure_andRethrows() {
        val src = source("sync/SyncCoordinator.kt")
        assertTrue(
            "nothing records a save failure — the notice can never arm",
            src.contains("PersistenceHealth.recordSaveFailure("),
        )
        // Rethrowing is load-bearing: the cursor must stay put so the next pass
        // re-pulls these rows. Swallowing the error here would advance past
        // rows that were never written and lose them permanently.
        val block = src.substringAfter("PersistenceHealth.recordSaveFailure(")
            .substringBefore("            }")
        assertTrue("the write failure is swallowed instead of rethrown", block.contains("throw error"))
    }

    @Test
    fun onlyTheLOCALWriteCounts_notTheFetch() {
        // THE POSITION OF THE try IS THE DISCRIMINATOR, and that is the whole
        // design. plan.apply() is the Room write; plan.fetchPage() is the
        // network. The outer catch at the end of pullTable sees both and cannot
        // tell them apart, so recording there would blame a full disk for a
        // flaky connection and tell a seller their DEVICE could not save.
        val src = source("sync/SyncCoordinator.kt")
        // The INNER try, found by walking back from the record call. Taking the
        // first "try {" in the file grabs the OUTER one wrapping the whole pull,
        // which legitimately contains the fetch - this assertion failed that way
        // first, and the failure was in the test rather than in the code.
        val guarded = src
            .substringBefore("PersistenceHealth.recordSaveFailure(")
            .substringAfterLast("try {")
        assertTrue(
            "the guarded block is no longer the local apply",
            guarded.contains("plan.apply(fetched.rows)"),
        )
        assertTrue(
            "the guarded block now covers the fetch too — network errors would arm the notice",
            !guarded.contains("fetchPage"),
        )
    }

    @Test
    fun theShellRendersTheNotice() {
        val shell = source("ui/shell/AppShell.kt")
        assertTrue(
            "nothing renders the notice — it arms and is shown to nobody, again",
            shell.contains("PersistenceHealthHost()"),
        )
        assertTrue(
            "the host is not imported",
            shell.contains("import com.gradethread.app.sync.PersistenceHealthHost"),
        )
    }

    @Test
    fun theHostObservesTheFlagAndCanClearIt() {
        val host = source("sync/PersistenceHealthHost.kt")
        assertTrue(
            "the host does not read noticeNeeded",
            host.contains("PersistenceHealth.noticeNeeded.collectAsState()"),
        )
        assertTrue(
            "the host renders even when no notice is needed",
            host.contains("if (!needed) return"),
        )
        // Acknowledge rather than a timed snooze: the counter resets, so the
        // notice re-arms only on NEW trouble. A snooze would hide a disk that
        // is still full.
        assertTrue(
            "dismissing does not acknowledge, so the notice cannot re-arm correctly",
            host.contains("PersistenceHealth::acknowledgeNotice"),
        )
    }
}
