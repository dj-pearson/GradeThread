package com.gradethread.app.sync

import androidx.room.withTransaction
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.PendingMutationEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * US-1320: delete reconciliation (iOS reconcileDeletesIfDue, US-1221/1495/
 * 1520). Delta pulls can't see server-side deletes, so a throttled id-only
 * scan prunes local rows absent from the surviving server set — otherwise
 * rows deleted on the web or another device inflate Money totals forever.
 *
 * Rules carried exactly:
 *  - THROTTLE (~15 min), in-memory so the first pull of a session reconciles;
 *    a FAILED pass (offline) does NOT advance the throttle — it retries on
 *    the next pull instead of waiting out the window;
 *  - PROTECTED SET: never prune a row whose server copy legitimately doesn't
 *    exist yet — every pending create's target id + the client-minted
 *    photo_id inside each queued uploadPhoto payload (whose targetId is the
 *    PARENT item, not the photo row) + not-yet-uploaded local captures;
 *  - DIRTY ROWS: rows with hasLocalChanges (and items with ANY queued edit,
 *    US-1495) are never pruned;
 *  - a table whose id-fetch failed (null) is left UNTOUCHED — pruning
 *    against a partial view would delete live rows.
 */
class DeleteReconciler(
    private val db: GradeThreadDb,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    companion object {
        const val RECONCILE_INTERVAL_MS: Long = 15 * 60 * 1000

        private val json = Json { ignoreUnknownKeys = true }

        /**
         * Ids reconciliation must never prune (US-1221): pending creates'
         * target ids + the photo_id carried inside queued uploadPhoto
         * payloads.
         */
        fun protectedReconcileIds(queue: List<PendingMutationEntity>): Set<String> {
            val ids = OfflineMutationQueue.unconfirmedCreateTargetIds(queue).toMutableSet()
            for (mutation in queue) {
                if (mutation.kind != MutationKind.UPLOAD_PHOTO.wire) continue
                uploadPhotoId(mutation.payload)?.let(ids::add)
            }
            return ids
        }

        internal fun uploadPhotoId(payload: ByteArray): String? = runCatching {
            json.parseToJsonElement(payload.decodeToString())
                .jsonObject["photo_id"]?.jsonPrimitive?.content
        }.getOrNull()

        /** Pure prune decision: local ids to delete for one table. */
        fun prunePlan(
            localIds: Collection<String>,
            survivingIds: Set<String>,
            protectedIds: Set<String>,
        ): List<String> =
            localIds.filter { it !in survivingIds && it !in protectedIds }
    }

    /** The five surviving-id sets; null = that table's fetch failed. */
    data class ServerIds(
        val items: Set<String>?,
        val sales: Set<String>?,
        val expenses: Set<String>?,
        val listings: Set<String>?,
        val photos: Set<String>?,
    ) {
        val allFailed: Boolean
            get() = items == null && sales == null && expenses == null &&
                listings == null && photos == null
    }

    /** Table names the id-fetcher is called with (iOS parity incl. the
     *  user-scoped vs parent-scoped split). */
    enum class Table(val remote: String, val userScoped: Boolean) {
        ITEMS("inventory_items", true),
        SALES("sales", true),
        EXPENSES("flipdesk_expenses", true),
        LISTINGS("listings", false),
        PHOTOS("item_photos", false),
    }

    private var lastReconcileAt: Long? = null

    data class Outcome(val ran: Boolean, val pruned: Int)

    /**
     * One reconcile pass. [fetchIds] returns the surviving server id set for
     * a table, or null on any error (offline / partial view) — the five
     * fetches run CONCURRENTLY (US-1520).
     */
    suspend fun reconcileIfDue(fetchIds: suspend (Table) -> Set<String>?): Outcome {
        val now = clock()
        lastReconcileAt?.let {
            if (now - it < RECONCILE_INTERVAL_MS) return Outcome(ran = false, pruned = 0)
        }

        val queue = db.pendingMutations().allInOrder()
        val protectedIds = protectedReconcileIds(queue)
        // US-1495: items with ANY queued edit are genuinely dirty — protected.
        val protectedItemIds = protectedIds + OfflineMutationQueue.itemIdsWithPendingEdits(queue)

        val server = coroutineScope {
            val items = async { fetchIds(Table.ITEMS) }
            val sales = async { fetchIds(Table.SALES) }
            val expenses = async { fetchIds(Table.EXPENSES) }
            val listings = async { fetchIds(Table.LISTINGS) }
            val photos = async { fetchIds(Table.PHOTOS) }
            ServerIds(items.await(), sales.await(), expenses.await(), listings.await(), photos.await())
        }

        // Everything failed (offline): touch neither the mirror nor the throttle.
        if (server.allFailed) return Outcome(ran = false, pruned = 0)

        var pruned = 0
        withContext(Dispatchers.IO) {
            db.withTransaction {
                server.items?.let { surviving ->
                    val protectedSet = protectedItemIds + db.items().dirtyIds()
                    val plan = prunePlan(db.items().allIds(), surviving, protectedSet)
                    if (plan.isNotEmpty()) db.items().deleteByIds(plan)
                    pruned += plan.size
                }
                server.sales?.let { surviving ->
                    val protectedSet = protectedIds + db.sales().dirtyIds()
                    val plan = prunePlan(db.sales().allIds(), surviving, protectedSet)
                    if (plan.isNotEmpty()) db.sales().deleteByIds(plan)
                    pruned += plan.size
                }
                server.expenses?.let { surviving ->
                    val plan = prunePlan(db.expenses().allIds(), surviving, protectedIds)
                    if (plan.isNotEmpty()) db.expenses().deleteByIds(plan)
                    pruned += plan.size
                }
                server.listings?.let { surviving ->
                    val protectedSet = protectedIds + db.listings().dirtyIds()
                    val plan = prunePlan(db.listings().allIds(), surviving, protectedSet)
                    if (plan.isNotEmpty()) db.listings().deleteByIds(plan)
                    pruned += plan.size
                }
                server.photos?.let { surviving ->
                    val protectedSet = protectedIds + db.photos().localOnlyIds()
                    val plan = prunePlan(db.photos().allIds(), surviving, protectedSet)
                    if (plan.isNotEmpty()) db.photos().deleteByIds(plan)
                    pruned += plan.size
                }
            }
        }
        lastReconcileAt = now
        return Outcome(ran = true, pruned = pruned)
    }
}
