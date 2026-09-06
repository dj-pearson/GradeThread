package com.gradethread.app.inventory

import com.gradethread.app.R
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.UiMessage
import com.gradethread.app.ui.components.StatusStyle
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1348: runs a bulk action item by item.
 *
 * PER-ITEM ISOLATION is the contract. One row failing must not abort the
 * other nineteen — a seller who selected twenty and got "failed" with no idea
 * which ones landed is worse off than before they started. Every failure is
 * caught, attributed to its item, and reported alongside the successes.
 */
@Singleton
class BulkActionExecutor @Inject constructor(private val client: SupabaseClient, private val db: GradeThreadDb) {

    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    data class Outcome(val result: BulkActionResult, val undo: BulkUndo?)

    suspend fun run(action: BulkAction, itemIds: List<String>): Outcome {
        val owner = ownerId()
            ?: return Outcome(
                BulkActionResult(
                    action = action,
                    succeeded = 0,
                    failures = itemIds.map {
                        BulkActionResult.Failure(it, UiMessage(R.string.bulk_error_signed_out))
                    },
                ),
                undo = null,
            )

        val failures = mutableListOf<BulkActionResult.Failure>()
        var succeeded = 0
        val statusSnapshot = mutableMapOf<String, String>()
        val priceSnapshot = mutableMapOf<String, Double?>()

        for (id in itemIds) {
            val item = db.items().byId(id)
            if (item == null) {
                failures += BulkActionResult.Failure(
                    id,
                    UiMessage(R.string.bulk_error_not_synced),
                )
                continue
            }
            val outcome = runCatching { apply(action, item, owner, statusSnapshot, priceSnapshot) }
            outcome.fold(
                onSuccess = { skippedReason ->
                    if (skippedReason == null) {
                        succeeded++
                    } else {
                        failures += BulkActionResult.Failure(id, skippedReason)
                    }
                },
                onFailure = { error ->
                    failures += BulkActionResult.Failure(id, message(error))
                },
            )
        }

        val undo = if (action.reversible && (statusSnapshot.isNotEmpty() || priceSnapshot.isNotEmpty())) {
            BulkUndo(
                label = UiMessage.plural(
                    R.plurals.bulk_undo_label,
                    args = listOf(action.label, succeeded),
                    quantity = succeeded,
                ),
                statuses = statusSnapshot,
                targetPrices = priceSnapshot,
            )
        } else {
            null
        }

        return Outcome(BulkActionResult(action, succeeded, failures), undo)
    }

    /** @return null on success, or the reason this item was skipped. */
    private suspend fun apply(
        action: BulkAction,
        item: InventoryItemEntity,
        owner: String,
        statusSnapshot: MutableMap<String, String>,
        priceSnapshot: MutableMap<String, Double?>,
    ): UiMessage? = when (action) {
        BulkAction.CreateDraft -> setStatus(item, owner, "drafted", statusSnapshot)
        BulkAction.MarkShipped -> setStatus(item, owner, "shipped", statusSnapshot)

        is BulkAction.DropPrice -> {
            val next = BulkPricing.dropped(item.targetPrice, action.percent)
            if (next == null) {
                // Named rather than silently skipped: "nothing happened" on
                // some rows and not others is indistinguishable from a bug.
                UiMessage(R.string.bulk_error_no_target_price)
            } else {
                // Snapshot BEFORE the write, and only for rows that get this
                // far — reverting one that failed would write a value it
                // never had.
                priceSnapshot[item.id] = item.targetPrice
                update(item.id, owner, mapOf("target_price" to JsonPrimitive(next)))
                db.items().upsert(
                    listOf(item.copy(targetPrice = next, updatedAt = System.currentTimeMillis())),
                )
                null
            }
        }

        BulkAction.Delete -> {
            client.from(TABLE).delete {
                filter {
                    eq("id", item.id)
                    // Tenant scope. Never act on an id alone.
                    eq("user_id", owner)
                }
            }
            db.items().delete(item.id)
            null
        }

        // Intercepted by the list before it reaches the executor.
        BulkAction.Grade -> UiMessage(R.string.bulk_error_grade_sheet)
    }

    private suspend fun setStatus(
        item: InventoryItemEntity,
        owner: String,
        target: String,
        snapshot: MutableMap<String, String>,
    ): UiMessage? {
        if (item.status == target) return null // already there; not a failure
        if (!ItemPatch.allowsStatus(item.status, target)) {
            // Reuses the canvas's guard so one rule decides what a legal
            // transition is, rather than two that can drift.
            // US-2976: both statuses are nested UiMessages rather than raw
            // slugs. "Can't move a drafted item to shipped" was showing the
            // WIRE value in a sentence a seller reads, in every language.
            return UiMessage(
                R.string.bulk_error_illegal_move,
                args = listOf(StatusStyle.message(item.status), StatusStyle.message(target)),
            )
        }
        snapshot[item.id] = item.status
        update(item.id, owner, mapOf("status" to JsonPrimitive(target)))
        db.items().upsert(
            listOf(item.copy(status = target, updatedAt = System.currentTimeMillis())),
        )
        return null
    }

    /** Put back what a reversible batch changed. */
    suspend fun revert(undo: BulkUndo) {
        val owner = ownerId() ?: return
        for ((id, status) in undo.statuses) {
            runCatching {
                update(id, owner, mapOf("status" to JsonPrimitive(status)))
                db.items().byId(id)?.let { db.items().upsert(listOf(it.copy(status = status))) }
            }
        }
        for ((id, price) in undo.targetPrices) {
            runCatching {
                update(
                    id,
                    owner,
                    mapOf("target_price" to (price?.let { JsonPrimitive(it) } ?: JsonNull)),
                )
                db.items().byId(id)?.let { db.items().upsert(listOf(it.copy(targetPrice = price))) }
            }
        }
    }

    private suspend fun update(
        itemId: String,
        owner: String,
        patch: Map<String, kotlinx.serialization.json.JsonElement>,
    ) {
        client.from(TABLE).update(JsonObject(patch)) {
            filter {
                eq("id", itemId)
                eq("user_id", owner)
            }
        }
    }

    private fun message(error: Throwable): UiMessage = UiMessage(
        R.string.bulk_error_generic,
        // The server's sentence wins when there is one: it is usually the
        // only thing that says what actually went wrong.
        detail = (error as? EdgeApiError)?.userMessage() ?: error.message,
    )

    private companion object {
        const val TABLE = "inventory_items"
    }
}
