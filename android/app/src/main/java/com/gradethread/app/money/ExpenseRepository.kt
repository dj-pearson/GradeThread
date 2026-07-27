package com.gradethread.app.money

import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.GradeThreadDb
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1364: expenses CRUD.
 *
 * Local mirror FIRST, then the server — the seller's ledger has to accept an
 * entry made in a stockroom with no signal. A transient failure rides the
 * mutation queue (which `MutationReplayer` now actually drains); anything else
 * rolls the local row back so the list never claims to hold an expense the
 * server rejected outright.
 *
 * The SERVER table is `flipdesk_expenses`; the local Room table is `expenses`.
 * The mismatch is easy to miss and shows up as a silent 404.
 */
@Singleton
class ExpenseRepository @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val queue: OfflineMutationQueue,
) {

    /** The outcome the form needs to distinguish for its confirmation copy. */
    sealed interface Outcome {
        data class Saved(val id: String) : Outcome

        /** Stored locally and queued — a truthful "saved, will sync" state. */
        data class Queued(val id: String) : Outcome
        data class Failed(val message: String) : Outcome
    }

    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    suspend fun save(draft: ExpenseDraft): Outcome {
        val owner = ownerId() ?: return Outcome.Failed("You're signed out — sign in to save this.")
        val validation = draft.validate()
        if (validation != null) return Outcome.Failed(validation)

        // An edit keeps its id so the upsert replaces rather than duplicates.
        val id = draft.id ?: UUID.randomUUID().toString().lowercase()
        val entity = draft.toEntity(id)
        val previous = if (draft.id != null) db.expenses().byId(id) else null

        db.expenses().upsert(listOf(entity))

        val body = wireBody(entity, owner)
        return runCatching { client.from(TABLE).upsert(body) }.fold(
            onSuccess = { Outcome.Saved(id) },
            onFailure = { error ->
                if (OfflineMutationQueue.shouldEnqueue(error)) {
                    queue.enqueue(
                        kind = MutationKind.CREATE_EXPENSE,
                        targetId = id,
                        payload = body.toString().encodeToByteArray(),
                    )
                    Outcome.Queued(id)
                } else {
                    // A validation/RLS rejection is permanent: keeping the local
                    // row would put a number in the seller's P&L that no server
                    // will ever agree with.
                    if (previous != null) db.expenses().upsert(listOf(previous))
                    else db.expenses().deleteByIds(listOf(id))
                    Outcome.Failed(message(error))
                }
            },
        )
    }

    suspend fun delete(id: String): Outcome {
        val owner = ownerId() ?: return Outcome.Failed("You're signed out — sign in to do that.")
        val previous = db.expenses().byId(id)
        db.expenses().deleteByIds(listOf(id))

        return runCatching {
            client.from(TABLE).delete {
                filter {
                    eq("id", id)
                    // Tenant scope. Never act on an id alone (US-268).
                    eq("user_id", owner)
                }
            }
        }.fold(
            onSuccess = { Outcome.Saved(id) },
            onFailure = { error ->
                if (OfflineMutationQueue.shouldEnqueue(error)) {
                    queue.enqueue(
                        kind = MutationKind.DELETE_EXPENSE,
                        targetId = id,
                        payload = """{"id":"$id"}""".encodeToByteArray(),
                    )
                    Outcome.Queued(id)
                } else {
                    previous?.let { db.expenses().upsert(listOf(it)) }
                    Outcome.Failed(message(error))
                }
            },
        )
    }

    /**
     * The insert/upsert body.
     *
     * `spent_on` is a DATE column, so it is sent as `YYYY-MM-DD` — sending a
     * full timestamp makes Postgres truncate it in UTC, which silently moves an
     * evening expense to the next day for anyone east of Greenwich.
     */
    private fun wireBody(entity: ExpenseEntity, owner: String): JsonObject = JsonObject(
        buildMap {
            put("id", JsonPrimitive(entity.id))
            put("user_id", JsonPrimitive(owner))
            put("category", JsonPrimitive(entity.category))
            put("amount", JsonPrimitive(entity.amount))
            put("spent_on", JsonPrimitive(ExpenseDraft.isoDate(entity.spentOn)))
            put(
                "description",
                entity.expenseDescription?.let { JsonPrimitive(it) } ?: JsonNull,
            )
            // Attribution is optional; an explicit null CLEARS a previous link
            // on an edit, which omitting the key would not.
            put(
                "inventory_item_id",
                entity.inventoryItemId?.let { JsonPrimitive(it) } ?: JsonNull,
            )
            put("listing_id", entity.listingId?.let { JsonPrimitive(it) } ?: JsonNull)
        },
    )

    private fun message(error: Throwable): String =
        error.message ?: "Couldn't save that expense."

    companion object {
        const val TABLE = "flipdesk_expenses"
    }
}
