package com.gradethread.app.sync

import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.PendingMutationEntity
import java.io.IOException
import java.util.UUID

/**
 * US-1319: the offline mutation queue (iOS OfflineMutationQueue +
 * PendingMutationActor + the SyncEngine flush loop). Edits made offline queue
 * as [PendingMutationEntity] rows and replay FIFO on reconnect.
 *
 * The hard-won iOS rules, carried exactly:
 *  - CREATE-BEFORE-EDIT (US-1208): an edit/delete whose target row's CREATE
 *    is still unconfirmed in the queue must NOT flush ahead of it — the
 *    server-side `WHERE id=?` would match nothing, return 200 with 0 rows,
 *    and the edit would dequeue silently LOST. The blocked set comes from
 *    the FULL queue (stuck creates included); a create succeeding UNBLOCKS
 *    its dependents in the same pass.
 *  - BLOCKED-TARGET HOLD (US-1496): once a same-target mutation fails this
 *    pass, later ones for that target hold — preserving per-target FIFO so a
 *    newer update can't land ahead of an older one that stayed queued.
 *  - TERMINAL VS TRANSIENT (US-1221): terminal failures (missing target/file,
 *    invalid storage URL, unknown kind, validation) mark STUCK immediately
 *    (retryCount pinned to the budget); transient (network/5xx/auth-expired)
 *    bump the retry count. Stuck rows are skipped by the drain and surface
 *    in the inspector (US-641) for manual retry/discard.
 */
class OfflineMutationQueue(private val db: GradeThreadDb, private val clock: () -> Long = System::currentTimeMillis) {

    companion object {
        /** The auto-retry budget; retryCount >= this = stuck. */
        const val MAX_RETRIES = 6

        // ── Pure ordering helpers (US-1208/1495/1496) — unit-tested ──

        fun isCreateKind(kind: String): Boolean = kind in setOf(
            MutationKind.CREATE_INVENTORY_ITEM.wire,
            MutationKind.CREATE_SALE.wire,
            MutationKind.CREATE_EXPENSE.wire,
            MutationKind.CREATE_LISTING.wire,
        )

        fun isDependentEdit(kind: String): Boolean = kind in setOf(
            MutationKind.UPDATE_INVENTORY_ITEM.wire,
            MutationKind.DELETE_INVENTORY_ITEM.wire,
            MutationKind.DELETE_EXPENSE.wire,
        )

        fun unconfirmedCreateTargetIds(queue: List<PendingMutationEntity>): Set<String> =
            queue.filter { isCreateKind(it.kind) }.mapNotNull { it.targetId }.toSet()

        /** US-1495: items with queued create/update edits stay dirty + protected. */
        fun itemIdsWithPendingEdits(queue: List<PendingMutationEntity>): Set<String> = queue
            .filter {
                it.kind == MutationKind.CREATE_INVENTORY_ITEM.wire ||
                    it.kind == MutationKind.UPDATE_INVENTORY_ITEM.wire
            }
            .mapNotNull { it.targetId }
            .toSet()

        fun shouldDeferDependent(mutation: PendingMutationEntity, unconfirmedCreateIds: Set<String>): Boolean {
            if (!isDependentEdit(mutation.kind)) return false
            val target = mutation.targetId ?: return false
            return target in unconfirmedCreateIds
        }

        fun shouldHoldForBlockedTarget(mutation: PendingMutationEntity, blockedTargetIds: Set<String>): Boolean =
            mutation.targetId?.let { it in blockedTargetIds } == true

        /**
         * Only GENUINE connectivity failures enqueue for later; a 4xx /
         * validation / RLS rejection surfaces to the user immediately —
         * queueing it would replay the same rejection forever.
         */
        fun shouldEnqueue(error: Throwable): Boolean = when (error) {
            is EdgeApiError.Network -> true
            is EdgeApiError.ServerError -> true
            is IOException -> true
            else -> false
        }

        /**
         * The inspector-facing failure text. EdgeApiError cases carry their
         * detail in properties, not the Throwable message — pull it out so
         * `lastError` reads "gone", not "NotFound".
         */
        fun describe(error: Throwable): String = when (error) {
            is EdgeApiError.NotFound -> error.detail
            is EdgeApiError.BadRequest -> error.detail
            is EdgeApiError.ServerError -> error.detail
            is EdgeApiError.FeatureUnavailable -> error.detail
            is EdgeApiError.Network -> error.reason
            is EdgeApiError.Decoding -> error.reason
            else -> error.message
        } ?: error.javaClass.simpleName

        /** Terminal = can never succeed on retry; transient = worth retrying. */
        fun isTerminal(error: Throwable): Boolean = when (error) {
            is EdgeApiError.NotFound, is EdgeApiError.BadRequest -> true
            is EdgeApiError.FeatureUnavailable -> true
            // Network / 5xx / rate limits / auth-expired: transient (a token
            // refresh or a healthy server fixes them).
            else -> false
        }
    }

    /** The replay executor — throws to signal failure. */
    fun interface Executor {
        suspend fun execute(mutation: PendingMutationEntity)
    }

    suspend fun enqueue(kind: MutationKind, targetId: String?, payload: ByteArray) {
        db.pendingMutations().enqueue(
            PendingMutationEntity(
                id = UUID.randomUUID().toString().lowercase(),
                kind = kind.wire,
                payload = payload,
                targetId = targetId,
                lastError = null,
                lastAttemptAt = null,
                createdAt = clock(),
            ),
        )
    }

    data class DrainResult(
        val succeeded: Int,
        val transientFailures: Int,
        val markedStuck: Int,
        val deferred: Int,
        val skippedStuck: Int,
    )

    /** One FIFO drain pass (called on reconnect / after sign-in sync). */
    suspend fun drain(executor: Executor): DrainResult {
        val all = db.pendingMutations().allInOrder()
        // The blocked set comes from the FULL queue, stuck creates included.
        val unconfirmedCreates = unconfirmedCreateTargetIds(all).toMutableSet()
        val blockedTargets = mutableSetOf<String>()

        var succeeded = 0
        var transient = 0
        var stuck = 0
        var deferred = 0
        val skippedStuck = all.count { it.retryCount >= MAX_RETRIES }

        for (mutation in all) {
            if (mutation.retryCount >= MAX_RETRIES) continue // inspector-only
            if (shouldHoldForBlockedTarget(mutation, blockedTargets)) {
                deferred += 1
                continue
            }
            if (shouldDeferDependent(mutation, unconfirmedCreates)) {
                deferred += 1
                continue
            }
            try {
                executor.execute(mutation)
                db.pendingMutations().delete(mutation.id)
                succeeded += 1
                // A confirmed create unblocks its dependents THIS pass.
                if (isCreateKind(mutation.kind)) {
                    mutation.targetId?.let(unconfirmedCreates::remove)
                }
            } catch (error: Throwable) {
                mutation.targetId?.let(blockedTargets::add)
                val message = describe(error)
                if (isTerminal(error)) {
                    stuck += 1
                    db.pendingMutations().markAttempt(
                        mutation.id,
                        MAX_RETRIES,
                        message,
                        clock(),
                    )
                    Telemetry.breadcrumb(
                        "Mutation replay terminal (${mutation.kind}): $message — now stuck",
                        category = "sync",
                    )
                } else {
                    transient += 1
                    val next = mutation.retryCount + 1
                    db.pendingMutations().markAttempt(mutation.id, next, message, clock())
                    val suffix = if (next >= MAX_RETRIES) " — now stuck (manual retry needed)" else ""
                    Telemetry.breadcrumb(
                        "Mutation replay failed (${mutation.kind}, attempt $next/$MAX_RETRIES): $message$suffix",
                        category = "sync",
                    )
                }
            }
        }
        return DrainResult(succeeded, transient, stuck, deferred, skippedStuck)
    }

    /** Inspector data (US-641): everything queued, stuck rows flagged. */
    suspend fun snapshot(): List<PendingMutationEntity> = db.pendingMutations().allInOrder()

    /** Manual inspector actions. */
    suspend fun retryNow(id: String) {
        db.pendingMutations().markAttempt(id, 0, null, null)
    }

    suspend fun discard(id: String) {
        db.pendingMutations().delete(id)
    }
}

/** The replayable mutation kinds (iOS MutationKind wire values). */
enum class MutationKind(val wire: String) {
    CREATE_INVENTORY_ITEM("createInventoryItem"),
    UPDATE_INVENTORY_ITEM("updateInventoryItem"),
    DELETE_INVENTORY_ITEM("deleteInventoryItem"),
    UPLOAD_PHOTO("uploadPhoto"),
    DELETE_PHOTO("deletePhoto"),
    CREATE_LISTING("createListing"),
    CREATE_SALE("createSale"),
    CREATE_EXPENSE("createExpense"),
    DELETE_EXPENSE("deleteExpense"),

    /** US-3000: a mileage trip logged in a car park with no signal. */
    CREATE_MILEAGE_TRIP("createMileageTrip"),
    DELETE_MILEAGE_TRIP("deleteMileageTrip"),
    REVISE_LISTING("reviseListing"),

    /** US-1377: `shipped_at` (+ tracking) stamped on a sale while offline. */
    MARK_SHIPPED("markShipped"),

    /**
     * US-2413: fold specifics edits back into the item's own columns.
     *
     * The only queued mutation that is an EDGE CALL rather than a table write.
     * It has to be: the aspect-to-column mapping lives in the server's registry,
     * and a phone that computed the patch itself would be a second mapping
     * table free to drift from the one publish reads.
     */
    EBAY_ASPECT_WRITE_BACK("ebayAspectWriteBack"),
}
