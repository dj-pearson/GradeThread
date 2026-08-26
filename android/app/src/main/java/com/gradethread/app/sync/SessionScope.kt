package com.gradethread.app.sync

import androidx.room.withTransaction
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

/**
 * US-1323: tenant-boundary correctness (iOS ContentView sign-out block +
 * US-670/1211/1493). Two flows share parts but differ deliberately:
 *
 * SIGN-OUT (account boundary):
 *  1. stop sync + realtime and cancel in-flight uploads FIRST (nothing may
 *     write mid-wipe);
 *  2. bump the scope epoch so any still-in-flight pull discards its merge +
 *     cursor advance instead of re-saving rows after the wipe (US-1493);
 *  3. reset ALL watermarks **BEFORE** wiping rows — if the wipe ran first
 *     and the app died before the reset, the next account would delta-pull
 *     from the old cursor and silently miss everything older (the iOS
 *     ordering rule);
 *  4. wipe every cache table + the mutation queue in ONE transaction (the
 *     next account must neither SEE nor FLUSH the previous user's data);
 *  5. run the clearances (intake inbox, push token, widget snapshot).
 *
 * WORKSPACE SWITCH (same auth user, different tenant):
 *  flush pending FIRST (the queue belongs to the same signed-in user and
 *  its edits target the OLD tenant — replay them before the view changes),
 *  then epoch-bump + watermark reset + wipe TENANT ROWS ONLY (the queue is
 *  KEPT — same owner), re-home realtime, re-pull scoped to the new owner.
 */
class SessionScope(
    private val db: GradeThreadDb,
    private val watermark: SyncWatermark,
    // Injectable so tests can record call ORDER; defaults do the real work.
    private val resetWatermarks: suspend () -> Unit = { watermark.resetAll() },
    private val wipeRows: suspend (includeQueue: Boolean) -> Unit = { includeQueue ->
        wipeAllTables(db, includeQueue)
    },
) {

    /** US-1493: in-flight pulls carry an epoch token; a bump invalidates them. */
    class ScopeEpoch {
        private val value = AtomicLong(0)
        fun current(): Long = value.get()
        fun invalidate(): Long = value.incrementAndGet()
        fun isCurrent(token: Long): Boolean = value.get() == token
    }

    val epoch = ScopeEpoch()

    data class Hooks(
        val stopRealtime: suspend () -> Unit = {},
        val stopSync: suspend () -> Unit = {},
        val cancelUploads: suspend () -> Unit = {},
        /** Intake inbox, push token, widget snapshot — each story registers. */
        val clearances: List<suspend () -> Unit> = emptyList(),
        val flushPending: suspend () -> Unit = {},
        val rehomeRealtime: suspend (ownerId: String) -> Unit = {},
        val pullForOwner: suspend (ownerId: String) -> Unit = {},
    )

    /** The account boundary. Ordering here is the contract — see class doc. */
    suspend fun signOutWipe(hooks: Hooks = Hooks()) {
        hooks.stopSync()
        hooks.stopRealtime()
        hooks.cancelUploads()
        epoch.invalidate()
        // Watermarks BEFORE rows — the crash-safety ordering rule.
        resetWatermarks()
        wipeRows(true)
        // US-1369: a pending "show me this brand" request names a brand from the
        // OUTGOING account's inventory. Left set, it would apply to whoever
        // signs in next.
        com.gradethread.app.inventory.InventoryFilterRequests.clear()
        hooks.clearances.forEach { it() }
    }

    /** The tenant boundary within one signed-in user (US-670/1211). */
    suspend fun switchWorkspace(newOwnerId: String, hooks: Hooks = Hooks()) {
        // The queued edits target the OLD tenant — replay them first.
        hooks.flushPending()
        epoch.invalidate()
        resetWatermarks()
        wipeRows(false) // tenant rows only; the queue is the same user's
        hooks.rehomeRealtime(newOwnerId)
        hooks.pullForOwner(newOwnerId)
    }

    companion object {
        /** All cache tables (+ optionally the queue) in one transaction. */
        suspend fun wipeAllTables(db: GradeThreadDb, includeQueue: Boolean) = withContext(Dispatchers.IO) {
            db.withTransaction {
                db.items().clearAll() // cascades item_photos
                db.photos().clearAll() // belt & braces for orphans
                db.sales().clearAll()
                db.expenses().clearAll()
                db.listings().clearAll()
                db.sources().clearAll()
                db.sourcers().clearAll()
                db.payouts().clearAll() // US-1365: deposits are tenant data too
                db.captureDrafts().clearAll() // an in-flight capture is tenant data
                // US-1382: staged share photos are someone's garments, in
                // their house. The FILES are removed separately, by
                // IntakeInboxStore.clearAll — this only drops the rows.
                db.intakeBatches().clearAll()
                // US-2408: an unsent AutoLister batch is someone's stock,
                // photographed in their house.
                db.autolisterSessions().clearAll()
                if (includeQueue) db.pendingMutations().clearAll()
            }
        }
    }
}
