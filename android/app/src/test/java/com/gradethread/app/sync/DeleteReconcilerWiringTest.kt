package com.gradethread.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2207: [DeleteReconciler] must have a PRODUCTION caller.
 *
 * It shipped complete and unit-tested — create-before-edit protection,
 * local-only photo protection, dirty-row protection, the throttle, the
 * all-failed short-circuit — and nothing called it. So an Android pull only
 * ever ADDED and UPDATED rows: anything deleted on the web or on iOS stayed on
 * the device forever, and the seller worked from an inventory containing items
 * they had already got rid of.
 *
 * Its own test suite could not notice, because a class is fully testable while
 * being entirely unreachable. That is the shape this file guards: not "does the
 * reconciler work" but "is it wired", which is a different question and the one
 * that was wrong.
 */
class DeleteReconcilerWiringTest {

    private fun source(path: String): String =
        File(path).readText()
            // Comments first. The wiring is EXPLAINED in the prose above it, so
            // a scan that includes comments would pass on the explanation alone
            // — a header describing a call that was deleted is precisely the
            // false pass this file exists to prevent.
            .replace(Regex("""/\*[\s\S]*?\*/"""), "")
            .replace(Regex("""(?m)^\s*//.*$"""), "")

    private val trigger by lazy {
        source("src/main/java/com/gradethread/app/sync/SyncTrigger.kt")
    }

    /**
     * The body of `runPull` — the ONE function every trigger funnels through.
     *
     * ⚠ Scoped deliberately, and the first version of this file was not.
     *
     * It searched the whole file for `reconcileDeletes()`, and a mutation that
     * DELETED the call from `runPull` still passed: the declaration
     * `private suspend fun reconcileDeletes()` contains that string too, and it
     * sits after `service.pull()` in the file, so even the ordering assertion
     * was satisfied by the declaration alone.
     *
     * That is exactly the defect US-2207 exists to fix — a complete, tested unit
     * with no caller — reproduced inside its own guard. A whole-file scan cannot
     * tell a definition from a call. Only the call site counts.
     */
    private val runPullBody by lazy {
        val start = trigger.indexOf("private suspend fun runPull(")
        assertTrue("runPull is gone or was renamed", start > -1)
        // Up to the next top-level declaration, so the private helpers BELOW
        // runPull (including reconcileDeletes itself) are out of scope.
        val end = trigger.indexOf("private suspend fun reconcileDeletes(", start)
        assertTrue("reconcileDeletes is gone or was renamed", end > -1)
        trigger.substring(start, end)
    }

    @Test
    fun `the sync path invokes the reconciler`() {
        assertTrue(
            "runPull no longer CALLS reconcileDeletes(). A pull that never " +
                "reconciles cannot see a server-side delete, so rows deleted on " +
                "the web or on iOS stay on this device forever — the exact " +
                "regression US-2207 fixed. Note the helper existing is not the " +
                "same as it being called; that was the original bug.",
            runPullBody.contains("reconcileDeletes()"),
        )
        assertTrue(
            "SyncTrigger no longer calls reconcileIfDue.",
            trigger.contains("reconciler.reconcileIfDue("),
        )
        assertTrue(
            "reconcileIfDue must be given the real id-scan (service::survivingIds). " +
                "A reconcile driven by anything else is not reconciling against " +
                "the server.",
            trigger.contains("service::survivingIds"),
        )
    }

    @Test
    fun `reconcile runs after the flush and after the pull`() {
        // The ordering is the correctness property, not a style preference.
        //
        // Flush first: an offline-created row has no server copy yet, so
        // reconciling against a half-flushed queue would prune rows the server
        // has simply not been told about. (The reconciler's protected set is a
        // second defence; this is the first.)
        //
        // Pull before reconcile: the step that DELETES should act on the
        // freshest local state available.
        val flushAt = runPullBody.indexOf("flushQueue(reason)")
        val pullAt = runPullBody.indexOf("service.pull()")
        val reconcileAt = runPullBody.indexOf("reconcileDeletes()")

        assertTrue("flushQueue call not found in runPull", flushAt > -1)
        assertTrue("service.pull call not found in runPull", pullAt > -1)
        assertTrue("reconcileDeletes call not found in runPull", reconcileAt > -1)

        assertTrue(
            "flush must run BEFORE the pull — pull-then-flush leaves a window " +
                "in which the server's view of an item is older than the device's",
            flushAt < pullAt,
        )
        assertTrue(
            "reconcile must run AFTER the pull. Reconciling first prunes against " +
                "a mirror the pull is about to update anyway, and does the one " +
                "irreversible thing in the sequence on the stalest state.",
            pullAt < reconcileAt,
        )
    }

    @Test
    fun `the reconciler is a singleton, or the throttle is decorative`() {
        val module = source("src/main/java/com/gradethread/app/platform/di/DatabaseModule.kt")
        // Anchor on the PROVIDER, not on the type name: the first occurrence of
        // "DeleteReconciler" in this file is the import at the top, and reading
        // backwards from there found no @Singleton and failed for the wrong
        // reason. Caught by running the test, not by writing it.
        val at = module.indexOf("fun provideDeleteReconciler")
        assertTrue("DatabaseModule no longer provides DeleteReconciler", at > -1)
        // lastReconcileAt lives in the instance. A per-caller reconciler would
        // start every trigger with a fresh throttle, so foreground churn would
        // mean a full five-table id-scan each time — expensive on exactly the
        // large accounts the cap exists for.
        //
        // ⚠ Bounded by THIS provider's own @Provides, not by a fixed character
        // count. The first version read back 200 characters, which — once the
        // KDoc was stripped — landed inside provideMutationQueue's annotations,
        // so deleting @Singleton from provideDeleteReconciler still passed on
        // its NEIGHBOUR's. Caught by mutating, not by reading.
        val annotations = module.substring(module.lastIndexOf("@Provides", at), at)
        assertTrue(
            "provideDeleteReconciler must be @Singleton: the ~15-minute throttle " +
                "is instance state, so a new reconciler per injection makes it a no-op.",
            annotations.contains("@Singleton"),
        )
    }

    @Test
    fun `a failed reconcile cannot fail the pull`() {
        // This runs after the pull has already succeeded AND been reported. A
        // throw escaping here would turn a good refresh into a failed one over
        // a maintenance step whose only cost is a few stale rows until next time.
        //
        // ⚠ Bounded to reconcileDeletes' OWN body. The first version took
        // everything after the declaration to the end of the file, and
        // flushQueue — which follows it and legitimately uses runCatching for
        // its own reasons — satisfied the assertion. Deleting the wrapper here
        // still passed. Caught by mutating, not by reading.
        val start = trigger.indexOf("private suspend fun reconcileDeletes()")
        assertTrue("reconcileDeletes is gone or was renamed", start > -1)
        val next = trigger.indexOf("private suspend fun flushQueue(", start)
        assertTrue("flushQueue is gone or was renamed — re-anchor this bound", next > -1)
        val body = trigger.substring(start, next)

        assertTrue(
            "reconcileDeletes must wrap the reconcile — an exception here would " +
                "surface as a failed sync when the seller's data is on screen " +
                "and correct.",
            body.contains("runCatching"),
        )
    }
}

/**
 * US-2207: the id-scan's completeness decision.
 *
 * [SyncService.survivingIds] feeds [DeleteReconciler], which PRUNES against
 * whatever it returns — so "the set is complete" is not an optimisation, it is
 * the precondition for deleting anything. PostgREST silently truncates a read
 * at `db-max-rows` and reports it only in a `Content-Range` header the client
 * never surfaces, so completeness has to be PROVEN by reading a short page.
 */
class IdScanStepTest {

    private val page = SyncService.ID_PAGE_SIZE
    private val cap = SyncService.MAX_ROWS_PER_PASS

    @Test
    fun `a short page proves the set is complete`() {
        assertEquals(
            SyncService.ScanStep.COMPLETE,
            SyncService.idScanStep(received = page - 1, scanned = page - 1),
        )
    }

    @Test
    fun `zero rows is complete, not suspicious`() {
        // An account really can have deleted everything, and refusing to prune
        // an empty set would mean the last delete on an account never lands.
        //
        // The DANGEROUS empty set — an unscoped read that RLS answers with
        // nothing — is refused earlier, by resolving the owner before the first
        // request. Guarding it here instead would be guessing from a count.
        assertEquals(
            SyncService.ScanStep.COMPLETE,
            SyncService.idScanStep(received = 0, scanned = 0),
        )
    }

    @Test
    fun `a full page keeps reading`() {
        assertEquals(
            SyncService.ScanStep.CONTINUE,
            SyncService.idScanStep(received = page, scanned = page),
        )
    }

    @Test
    fun `a full page at the cap abandons the pass rather than pruning`() {
        // The set now holds only the LOWEST cap-many ids. Pruning against it
        // deletes every local row above the cap; the next delta pull re-fetches
        // them and the next reconcile prunes them again. Rows would visibly come
        // and go, on exactly the largest accounts.
        assertEquals(
            SyncService.ScanStep.ABANDON,
            SyncService.idScanStep(received = page, scanned = cap),
        )
        assertEquals(
            SyncService.ScanStep.ABANDON,
            SyncService.idScanStep(received = page, scanned = cap + page),
        )
    }

    @Test
    fun `a short page at the cap is still complete`() {
        // Order matters: the cap check must not pre-empt the short-page check.
        // An account sitting exactly on the boundary is fully read, and
        // abandoning there would mean its deletes never reconcile at all.
        assertEquals(
            SyncService.ScanStep.COMPLETE,
            SyncService.idScanStep(received = page - 1, scanned = cap),
        )
    }
}
