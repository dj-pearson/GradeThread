package com.gradethread.app.sync

import android.content.Context
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ItemPhotoEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-2151: the production entry point for sync.
 *
 * Builds the tenant-scoped [SyncCoordinator.TablePlan]s and runs them. Call
 * on sign-in, on foreground, and from pull-to-refresh.
 */
@Singleton
class SyncService @Inject constructor(
    @ApplicationContext private val context: Context,
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
) {

    private val watermark = SyncWatermark(context)
    private val merger = SyncMerger(db)

    /** Active workspace, else self — matching every other tenant-scoped read. */
    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * @return null when signed out — there is no tenant to scope to, and an
     * unscoped pull would be a cross-tenant read.
     */
    suspend fun pull(): SyncCoordinator.Outcome? = withContext(Dispatchers.IO) {
        val owner = ownerId() ?: return@withContext null
        coordinator(owner).pullAll()
    }

    private fun coordinator(owner: String) = SyncCoordinator(
        tables = listOf(itemsPlan(owner), photosPlan(owner)),
        readCursor = { table -> watermark.cursor(table) },
        advanceCursor = { table, cursor -> watermark.advance(table, cursor) },
    )

    private fun itemsPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.ITEMS,
        fetchPage = { cursor, offset -> page("inventory_items", owner, cursor, offset) },
        // Reuses the realtime decoder — one row shape, one place to change it.
        decode = { raw -> (raw as? JsonObject)?.let(RealtimeRows::decodeInventoryRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(items = rows)) },
    )

    private fun photosPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.PHOTOS,
        // item_photos has no user_id: ownership is via the parent item, so the
        // scope is an inner join on inventory_items rather than a direct eq.
        fetchPage = { cursor, offset -> photoPage(owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodePhotoRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(photos = rows)) },
    )

    /**
     * One page, ordered by `updated_at` ASC and scoped to [owner].
     *
     * The order is not cosmetic — [SyncPull.safeCursor] and the monotonic
     * watermark both assume ascending cursors.
     */
    private suspend fun page(
        table: String,
        owner: String,
        cursor: String?,
        offset: Int,
    ): List<JsonElement> = client.from(table).select {
        filter {
            eq("user_id", owner)
            // Strictly greater-than: a row exactly at the cursor was already
            // consumed, and re-fetching it every pass would never drain.
            cursor?.let { gt("updated_at", it) }
        }
        order("updated_at", Order.ASCENDING)
        range(offset.toLong(), (offset + SyncPull.PAGE_SIZE - 1).toLong())
    }.decodeList<JsonObject>()

    private suspend fun photoPage(
        owner: String,
        cursor: String?,
        offset: Int,
    ): List<JsonElement> = client.from("item_photos").select(
        // Ownership via the parent row — item_photos carries no user_id, and
        // an unscoped read here would be a cross-tenant leak.
        io.github.jan.supabase.postgrest.query.Columns.raw("*, inventory_items!inner(user_id)"),
    ) {
        filter {
            eq("inventory_items.user_id", owner)
            cursor?.let { gt("updated_at", it) }
        }
        order("updated_at", Order.ASCENDING)
        range(offset.toLong(), (offset + SyncPull.PAGE_SIZE - 1).toLong())
    }.decodeList<JsonObject>()
}

/** US-2151: row decoders for the pull that realtime doesn't already cover. */
object SyncRows {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Serializable
    private data class RemotePhotoRow(
        val id: String,
        @SerialName("inventory_item_id") val inventoryItemId: String,
        @SerialName("photo_type") val photoType: String? = null,
        @SerialName("photo_url") val photoUrl: String? = null,
        @SerialName("thumbnail_url") val thumbnailUrl: String? = null,
        @SerialName("storage_path") val storagePath: String? = null,
        val width: Int? = null,
        val height: Int? = null,
        val bytes: Int? = null,
        @SerialName("sort_order") val sortOrder: Int? = null,
        @SerialName("created_at") val createdAt: String? = null,
    )

    /** Lenient: null on any decode failure, so one bad row can't fail a page. */
    fun decodePhotoRow(record: JsonObject): ItemPhotoEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemotePhotoRow.serializer(), record)
        // A photo with no URL can't render and would show as a broken tile —
        // drop it rather than store it.
        val url = row.photoUrl?.takeIf { it.isNotBlank() } ?: return null
        ItemPhotoEntity(
            id = row.id.lowercase(),
            inventoryItemId = row.inventoryItemId.lowercase(),
            photoType = row.photoType ?: "detail",
            photoUrl = url,
            thumbnailUrl = row.thumbnailUrl,
            storagePath = row.storagePath,
            width = row.width,
            height = row.height,
            bytes = row.bytes,
            sortOrder = row.sortOrder ?: 0,
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
            localBytesPath = null,
        )
    }.getOrNull()
}
