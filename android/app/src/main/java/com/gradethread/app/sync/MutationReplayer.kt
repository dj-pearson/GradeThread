package com.gradethread.app.sync

import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.PendingMutationEntity
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import javax.inject.Inject
import com.gradethread.app.platform.net.EdgeApi
import javax.inject.Named
import javax.inject.Singleton

/**
 * The replay half of US-1319 — what turns a queued payload back into the write
 * it was standing in for.
 *
 * US-1319 built [OfflineMutationQueue] (FIFO ordering, create-before-edit
 * deferral, the terminal/transient split) and every enqueue site uses it. But
 * `drain()` had NO production caller: grep found it only in MutationQueueTest.
 * So an edit made in a tunnel, a capture published offline, and every
 * `item_photos` row an upload produced were written to `pending_mutations` and
 * stayed there. Forever. The seller's local mirror looked correct, which is what
 * made it invisible — the row was in Room, so the UI had nothing to complain
 * about, and the server simply never heard about it. Same class of gap as
 * US-2151 (the pull primitives with no caller), one layer up.
 *
 * Split the same way [SyncCoordinator] is: [MutationReplayPlan] decides WHAT
 * write a payload means (pure, exhaustively unit-tested, no client), and this
 * class performs it and keeps the local mirror honest. Decisions the queue
 * already owns — ordering, retry budget, stuck marking — are not re-implemented
 * here; this only performs one mutation and throws on failure, which is the
 * contract [OfflineMutationQueue.Executor] asks for.
 */
@Singleton
class MutationReplayer @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val queue: OfflineMutationQueue,
    /** US-2413: the one queued mutation that is an edge call, not a table write. */
    @Named("shared") private val edge: EdgeApi,
) {

    /** Active workspace, else self — matching every other tenant-scoped write. */
    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * Drain the queue once.
     *
     * @return null when signed out. There is no tenant to scope replays to, and
     * a create replayed with no `user_id` would either be rejected by RLS or —
     * on a row whose payload carries a STALE one — land in the wrong tenant.
     * Queued rows survive sign-out only for the same user (`SessionScope` wipes
     * them otherwise), so waiting costs nothing.
     */
    suspend fun replay(): OfflineMutationQueue.DrainResult? {
        val owner = ownerId() ?: return null
        return queue.drain(executorFor(owner))
    }

    private fun executorFor(owner: String) = OfflineMutationQueue.Executor { mutation ->
        // The photo-row plan needs the URL the upload worker actually resolved,
        // which lives on the local row. Looked up HERE so the planner stays pure.
        val hints = if (mutation.kind == MutationKind.UPLOAD_PHOTO.wire) {
            MutationReplayPlan.photoIdOf(mutation)
                ?.let { db.photos().forItemPhoto(it) }
                ?.let {
                    MutationReplayPlan.PhotoHints(
                        photoUrl = it.photoUrl,
                        sortOrder = it.sortOrder,
                        width = it.width,
                        height = it.height,
                        bytes = it.bytes,
                    )
                }
        } else {
            null
        }

        when (val write = MutationReplayPlan.plan(mutation, owner, hints)) {
            is MutationReplayPlan.Write.Upsert -> client.from(write.table).upsert(write.body)

            is MutationReplayPlan.Write.Update ->
                // An empty patch is not an error — there is nothing to send, and
                // failing it would pin a harmless row to stuck forever.
                if (write.patch.isNotEmpty()) {
                    client.from(write.table).update(write.patch) {
                        filter {
                            eq("id", write.id)
                            // Tenant scope. Never act on an id alone (US-268).
                            write.userId?.let { eq("user_id", it) }
                        }
                    }
                }

            is MutationReplayPlan.Write.Delete ->
                client.from(write.table).delete {
                    filter {
                        eq("id", write.id)
                        write.userId?.let { eq("user_id", it) }
                    }
                }

            // US-2413: the edge scopes this to the caller's workspace itself,
            // reading the tenant from the token — so unlike the table writes
            // above there is no owner to re-stamp here.
            is MutationReplayPlan.Write.EdgePost -> edge.postRaw(write.path, write.body.toString())
        }

        mirrorLocally(mutation)
    }

    /**
     * Post-replay local bookkeeping.
     *
     * Runs only after the write succeeded (the executor throws otherwise, and
     * the queue keeps the row). Clearing `hasLocalChanges` is the point: the
     * server now holds this edit, so the next pull must stop treating its own
     * copy as a conflict to defend against. Deletes drop the local row for the
     * same reason — it is gone server-side, and leaving it would have the
     * delete reconciler re-add it as an orphan.
     */
    private suspend fun mirrorLocally(mutation: PendingMutationEntity) {
        val id = MutationReplayPlan.rowIdOf(mutation) ?: return
        when (mutation.kind) {
            MutationKind.CREATE_INVENTORY_ITEM.wire,
            MutationKind.UPDATE_INVENTORY_ITEM.wire,
            ->
                db.items().byId(id)?.let {
                    db.items().upsert(listOf(it.copy(hasLocalChanges = false)))
                }

            MutationKind.DELETE_INVENTORY_ITEM.wire -> db.items().delete(id)
            MutationKind.DELETE_PHOTO.wire -> db.photos().delete(id)
            MutationKind.DELETE_EXPENSE.wire -> db.expenses().deleteByIds(listOf(id))
            MutationKind.DELETE_MILEAGE_TRIP.wire ->
                db.mileageTrips().deleteByIds(listOf(id))

            // US-1377: the sale is no longer ahead of the server, so clearing
            // the dirty flag lets a later pull correct it if eBay disagreed.
            MutationKind.MARK_SHIPPED.wire ->
                db.sales().all().firstOrNull { it.id == id }?.let {
                    db.sales().upsert(listOf(it.copy(hasLocalChanges = false)))
                }
            else -> Unit
        }
    }
}

/**
 * The pure half: which write does a queued payload mean?
 *
 * Every failure here is TERMINAL by construction — a malformed or unsupported
 * payload cannot be repaired by trying again, and [EdgeApiError.BadRequest] is
 * what [OfflineMutationQueue.isTerminal] reads as "stop, surface it in the
 * inspector" rather than burning six retries on it.
 */
object MutationReplayPlan {

    const val ITEMS = "inventory_items"
    const val PHOTOS = "item_photos"

    /** The SERVER table is `flipdesk_expenses`; Room's local one is `expenses`. */
    const val EXPENSES = "flipdesk_expenses"
    const val MILEAGE_TRIPS = "mileage_trips"

    const val SALES = "sales"

    /** US-2413: mirrors AspectWriteBackService.PATH; kept here so the pure
     *  planner does not have to reach into an inventory service. */
    const val ASPECT_WRITE_BACK_PATH = "/api/flipdesk/ebay/aspects/write-back"

    sealed interface Write {
        /**
         * Upsert rather than insert, deliberately.
         *
         * The original insert may well have REACHED the server and only its
         * response been lost — the classic at-least-once case — and a plain
         * insert would then fail on the primary key and mark a perfectly landed
         * row stuck. Upserting on the client-minted id is idempotent, which is
         * exactly why those ids are minted client-side and lowercased.
         */
        data class Upsert(val table: String, val body: JsonObject) : Write

        /** @param userId null = the table has no tenant column (`item_photos`). */
        data class Update(val table: String, val id: String, val patch: JsonObject, val userId: String?) : Write

        data class Delete(val table: String, val id: String, val userId: String?) : Write

        /**
         * US-2413: a queued POST to the edge, replayed verbatim.
         *
         * The payload IS the original request body, so replaying it is the same
         * call the phone would have made when it had signal — no reconstruction,
         * nothing to get wrong a second time.
         */
        data class EdgePost(val path: String, val body: JsonObject) : Write
    }

    /** Local-row hints for the photo case, read by the caller (IO, not pure). */
    data class PhotoHints(
        val photoUrl: String?,
        val sortOrder: Int,
        val width: Int?,
        val height: Int?,
        val bytes: Int?,
    )

    fun plan(mutation: PendingMutationEntity, owner: String, photoHints: PhotoHints? = null): Write =
        when (mutation.kind) {
            MutationKind.CREATE_INVENTORY_ITEM.wire -> {
                // The payload IS the original insert body (`CapturePublisher` /
                // `IntakeRepository`), so it already carries id and user_id.
                val body = decode(mutation)
                requireId(body, mutation, "item create")
                // Re-stamp the tenant rather than trust the payload's: a queued row
                // may predate a workspace switch, and replaying yesterday's edit
                // into today's tenant is the one unrecoverable outcome here.
                Write.Upsert(ITEMS, JsonObject(body + ("user_id" to JsonPrimitive(owner))))
            }

            MutationKind.UPDATE_INVENTORY_ITEM.wire -> {
                // Payload shape: {"id": "...", "patch": { … }} (ItemCanvasViewModel).
                val body = decode(mutation)
                val patch = body["patch"] as? JsonObject
                    ?: terminal("Queued item update has no patch object")
                Write.Update(ITEMS, requireId(body, mutation, "item update"), patch, owner)
            }

            MutationKind.DELETE_INVENTORY_ITEM.wire ->
                Write.Delete(ITEMS, requireId(decode(mutation), mutation, "item delete"), owner)

            MutationKind.UPLOAD_PHOTO.wire -> Write.Upsert(PHOTOS, photoRow(mutation, photoHints))

            MutationKind.DELETE_PHOTO.wire ->
                Write.Delete(
                    PHOTOS,
                    decode(mutation).string("photo_id")
                        ?: mutation.targetId
                        ?: terminal("Queued photo delete has no photo_id"),
                    // item_photos carries no user_id — ownership is via the parent
                    // item and RLS enforces it through that FK, so there is no
                    // tenant column to filter on.
                    userId = null,
                )

            MutationKind.CREATE_EXPENSE.wire -> {
                val body = decode(mutation)
                requireId(body, mutation, "expense create")
                Write.Upsert(EXPENSES, JsonObject(body + ("user_id" to JsonPrimitive(owner))))
            }

            MutationKind.DELETE_EXPENSE.wire ->
                Write.Delete(EXPENSES, requireId(decode(mutation), mutation, "expense delete"), owner)

            // US-3000. Same two shapes as expenses: an upsert body with the tenant
            // re-stamped from the CURRENT session rather than trusted from the
            // payload, and a delete by id scoped to the owner.
            MutationKind.CREATE_MILEAGE_TRIP.wire -> {
                val body = decode(mutation)
                requireId(body, mutation, "mileage trip create")
                Write.Upsert(MILEAGE_TRIPS, JsonObject(body + ("user_id" to JsonPrimitive(owner))))
            }

            MutationKind.DELETE_MILEAGE_TRIP.wire ->
                Write.Delete(
                    MILEAGE_TRIPS,
                    requireId(decode(mutation), mutation, "mileage trip delete"),
                    owner,
                )

            // US-1377: a parcel marked shipped with no signal. Same
            // {"id","patch"} shape as an item edit, so the same Update write
            // applies — and the same re-stamped tenant scope.
            MutationKind.MARK_SHIPPED.wire -> {
                val body = decode(mutation)
                val patch = body["patch"] as? JsonObject
                    ?: terminal("Queued mark-shipped has no patch object")
                Write.Update(SALES, requireId(body, mutation, "mark shipped"), patch, owner)
            }

            MutationKind.EBAY_ASPECT_WRITE_BACK.wire ->
                Write.EdgePost(ASPECT_WRITE_BACK_PATH, decode(mutation))

            // CREATE_SALE / CREATE_LISTING / REVISE_LISTING have no enqueue site yet
            // (no Android surface creates them). Terminal rather than retried:
            // nothing about a later attempt changes the fact that this build cannot
            // perform it, so it belongs in the inspector immediately.
            else -> terminal("No replay handler for mutation kind '${mutation.kind}'")
        }

    /**
     * The `item_photos` row an upload produced.
     *
     * A `UploadWorker.queueStuckMutation` payload (`{"photo_id","error"}`) has no
     * `storage_path` and is deliberately caught by the missing-field check: that
     * row records an upload that never happened, and replaying it as though it
     * had would publish a row pointing at bytes that were never stored.
     */
    private fun photoRow(mutation: PendingMutationEntity, hints: PhotoHints?): JsonObject {
        val body = decode(mutation)
        val photoId = body.string("photo_id") ?: terminal("Queued photo row has no photo_id")
        val itemId = body.string("inventory_item_id")
            ?: terminal("Queued photo row has no inventory_item_id")
        val storagePath = body.string("storage_path")
            ?: terminal("Queued photo row has no storage_path")

        return buildJsonObject {
            put("id", JsonPrimitive(photoId))
            put("inventory_item_id", JsonPrimitive(itemId))
            put("photo_type", JsonPrimitive(body.string("photo_type") ?: "detail"))
            // US-2488: only when the upload carried one. Writing an explicit
            // null would be wrong on a REPLAY of an older queued row, which
            // predates the column and never had a role to lose.
            body.string("photo_role")?.takeIf { it.isNotBlank() }
                ?.let { put("photo_role", JsonPrimitive(it)) }
            put("storage_path", JsonPrimitive(storagePath))
            put("sort_order", JsonPrimitive(body.int("sort_order") ?: hints?.sortOrder ?: 0))
            // The URL comes from the local row the worker already wrote, never
            // rebuilt here: the worker resolved it against the bucket it
            // actually uploaded to (`item-photos` vs the private
            // `submission-images`), and re-deriving it risks the wrong one.
            hints?.photoUrl?.let { put("photo_url", JsonPrimitive(it)) }
            hints?.width?.let { put("width", JsonPrimitive(it)) }
            hints?.height?.let { put("height", JsonPrimitive(it)) }
            hints?.bytes?.let { put("bytes", JsonPrimitive(it)) }
        }
    }

    /** The photo id an UPLOAD_PHOTO payload targets, for the hints lookup. */
    fun photoIdOf(mutation: PendingMutationEntity): String? =
        runCatching { decode(mutation).string("photo_id") }.getOrNull()

    /** The local row a successful replay should reconcile, if any. */
    fun rowIdOf(mutation: PendingMutationEntity): String? = runCatching {
        val body = decode(mutation)
        when (mutation.kind) {
            MutationKind.DELETE_PHOTO.wire -> body.string("photo_id")
            else -> body.string("id")
        } ?: mutation.targetId
    }.getOrElse { mutation.targetId }

    private fun requireId(body: JsonObject, mutation: PendingMutationEntity, what: String): String = body.string("id")
        ?: mutation.targetId
        ?: terminal("Queued $what has no id")

    private fun decode(mutation: PendingMutationEntity): JsonObject = runCatching {
        json.parseToJsonElement(mutation.payload.decodeToString()).jsonObject
    }.getOrElse {
        terminal("Queued ${mutation.kind} payload is not a valid JSON object")
    }

    private fun terminal(message: String): Nothing = throw EdgeApiError.BadRequest(message)

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /** A JSON null, a blank string or a non-primitive all read as absent. */
    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun JsonObject.int(key: String): Int? =
        (this[key] as? JsonPrimitive)?.let { it.intOrNull ?: it.longOrNull?.toInt() }
}
