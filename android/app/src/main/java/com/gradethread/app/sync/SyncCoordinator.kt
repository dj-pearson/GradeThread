package com.gradethread.app.sync

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement

/**
 * US-2151: assembles the sync primitives into a pull that actually runs.
 *
 * US-1317/1318/1319/1320 built and tested every piece — paged fetch, safe
 * cursor advance, merge, delete reconciliation — but nothing ever called
 * them, so Room was never bulk-populated and every Room-backed screen
 * rendered empty regardless of account contents. This is the missing caller.
 *
 * The decision logic lives here behind seams (fetch / decode / apply /
 * cursor IO) so the ordering and advance rules are testable without a network
 * or a database.
 */
class SyncCoordinator(
    private val tables: List<TablePlan<*>>,
    private val readCursor: suspend (SyncWatermark.Table) -> String?,
    private val advanceCursor: suspend (SyncWatermark.Table, String) -> Unit,
) {

    /**
     * One table's pull recipe.
     *
     * @param fetchPage MUST be tenant-scoped and ordered by `updated_at` ASC
     * by the implementer — the paging and cursor logic both assume it.
     */
    class TablePlan<T>(
        val table: SyncWatermark.Table,
        val fetchPage: suspend (cursor: String?, offset: Int) -> List<JsonElement>,
        val decode: (JsonElement) -> T?,
        val apply: suspend (List<T>) -> Unit,
    )

    data class TableResult(
        val table: SyncWatermark.Table,
        val rowsApplied: Int,
        val rowsDropped: Int,
        /** False when the row ceiling was hit — a further pass has more to do. */
        val drained: Boolean,
        val advancedTo: String?,
        val error: Throwable? = null,
    )

    data class Outcome(val results: List<TableResult>) {
        val rowsApplied: Int get() = results.sumOf { it.rowsApplied }
        val failures: List<TableResult> get() = results.filter { it.error != null }
        val succeeded: Boolean get() = failures.isEmpty()

        /** True when any table hit its ceiling — the caller should pull again. */
        val hasMore: Boolean get() = results.any { it.error == null && !it.drained }
    }

    // Single-flight. A foreground event landing on top of a sign-in pull would
    // otherwise run two passes over the same cursor concurrently, and the
    // monotonic advance makes the interleaving silently lossy rather than loud.
    private val mutex = Mutex()

    val isRunning: Boolean get() = mutex.isLocked

    /**
     * Pull every table once.
     *
     * A table that throws does NOT abort the others — an inventory pull is
     * still worth having when the listings table is misbehaving. Its cursor
     * simply doesn't advance, so the next pass retries exactly that table.
     */
    suspend fun pullAll(): Outcome = mutex.withLock {
        Outcome(tables.map { plan -> pullTable(plan) })
    }

    /** @return null when a pull is already in flight. */
    suspend fun pullAllIfIdle(): Outcome? {
        if (mutex.isLocked) return null
        return pullAll()
    }

    private suspend fun <T> pullTable(plan: TablePlan<T>): TableResult {
        val cursor = runCatching { readCursor(plan.table) }.getOrNull()
        return try {
            val fetched = SyncPull.fetchPaged(
                fetchPage = { offset -> plan.fetchPage(cursor, offset) },
                decode = plan.decode,
            )
            // Apply BEFORE advancing. If the write fails the cursor stays put
            // and the next pass re-pulls the same rows — upserts are
            // idempotent, so re-applying is free, whereas advancing past rows
            // that were never written loses them permanently.
            if (fetched.rows.isNotEmpty()) {
                // US-2792: a LOCAL write failing is a different problem from a
                // fetch failing, and only this one means the device could not
                // save. The outer catch below sees both and cannot tell them
                // apart — raising the notice there would blame the disk for a
                // flaky connection. Wrapping the apply ALONE is what separates
                // them, so no exception-type sniffing is needed.
                //
                // Rethrows: the cursor must still stay put so the next pass
                // re-pulls these rows, exactly as the comment above requires.
                try {
                    plan.apply(fetched.rows)
                } catch (error: Throwable) {
                    PersistenceHealth.recordSaveFailure("pull:${plan.table}", error)
                    throw error
                }
            }

            val safe = SyncPull.safeCursor(fetched.decodedCursors, fetched.droppedCursors)
            if (safe != null) advanceCursor(plan.table, safe)

            TableResult(
                table = plan.table,
                rowsApplied = fetched.rows.size,
                rowsDropped = fetched.droppedCursors.size,
                drained = fetched.drained,
                advancedTo = safe,
            )
        } catch (error: Throwable) {
            TableResult(
                table = plan.table,
                rowsApplied = 0,
                rowsDropped = 0,
                drained = false,
                advancedTo = null,
                error = error,
            )
        }
    }
}
