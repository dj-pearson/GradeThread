package com.gradethread.app.inventory

import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ItemPhotoEntity
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1344: persisting photo order, removals and item-level actions.
 *
 * Writes go through the ANON client, so RLS on `item_photos` scopes every one
 * of them to the caller's own rows — no service-role bypass, unlike the edge
 * paths. Server first, local mirror second: a failed write leaves the cache
 * untouched and the next sync re-reconciles.
 */
@Singleton
class ItemPhotoRepository @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
) {

    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * Write a new display order.
     *
     * Only the rows that moved are updated, and the changes are computed
     * BEFORE anything is mutated locally — computing them after would compare
     * the new order against itself and find nothing to write.
     */
    suspend fun persistOrder(ordered: List<ItemPhotoEntity>): Result<Unit> = runCatching {
        val changes = PhotoOrdering.changedSortOrders(ordered)
        for ((photoId, sortOrder) in changes) {
            client.from(PHOTOS).update(
                JsonObject(mapOf("sort_order" to JsonPrimitive(sortOrder))),
            ) {
                filter { eq("id", photoId) }
            }
        }
        mirrorOrder(ordered)
    }

    /**
     * Remove one photo and close the gap its sort_order left.
     *
     * @param remaining the post-removal order the caller already computed.
     */
    suspend fun remove(
        photoId: String,
        remaining: List<ItemPhotoEntity>,
    ): Result<Unit> = runCatching {
        client.from(PHOTOS).delete { filter { eq("id", photoId) } }
        // Re-densify the survivors, then mirror. Order matters: the local
        // delete happens last so a failed server call leaves the cache
        // describing what the server still holds.
        val changes = PhotoOrdering.changedSortOrders(remaining)
        for ((id, sortOrder) in changes) {
            client.from(PHOTOS).update(
                JsonObject(mapOf("sort_order" to JsonPrimitive(sortOrder))),
            ) {
                filter { eq("id", id) }
            }
        }
        db.photos().delete(photoId)
        mirrorOrder(remaining)
    }

    /**
     * Re-tag a photo's slot (web "retag" parity).
     *
     * US-2469: the target is the (type, role) PAIR. Both halves are always
     * written, and the role is written as an explicit JSON null when the new
     * type takes no qualifier — omitting it would leave the old role attached
     * to the new type, so retagging a "Fabric close-up" to "Front" would store
     * a front photo still qualified as fabric.
     */
    suspend fun retag(
        photoId: String,
        serverPhotoType: String,
        photoRole: String? = null,
    ): Result<Unit> = runCatching {
        val role = photoRole?.takeIf { it.isNotBlank() }
        client.from(PHOTOS).update(
            JsonObject(
                mapOf(
                    "photo_type" to JsonPrimitive(serverPhotoType),
                    "photo_role" to (role?.let { JsonPrimitive(it) } ?: JsonNull),
                ),
            ),
        ) {
            filter { eq("id", photoId) }
        }
        db.photos().forItemPhoto(photoId)?.let {
            db.photos().upsert(listOf(it.copy(photoType = serverPhotoType, photoRole = role)))
        }
    }

    /** Delete the whole item. `item_photos` cascades, server-side and locally. */
    suspend fun deleteItem(itemId: String): Result<Unit> = runCatching {
        val owner = ownerId() ?: error("Not signed in")
        client.from(ITEMS).delete {
            filter {
                eq("id", itemId)
                // Tenant scope. Never act on an id alone.
                eq("user_id", owner)
            }
        }
        db.items().delete(itemId)
    }

    /**
     * Duplicate an item's fields into a new row.
     *
     * PHOTOS ARE NOT COPIED, and that is the point: `item_photos` rows carry
     * storage paths, and pointing two items at the same objects means deleting
     * either one takes the other's images with it. The duplicate is a
     * cataloguing shortcut for a second identical garment, which needs its own
     * photos anyway.
     */
    suspend fun duplicate(itemId: String): Result<String> = runCatching {
        val owner = ownerId() ?: error("Not signed in")
        val source = db.items().byId(itemId) ?: error("Item not found")
        val newId = java.util.UUID.randomUUID().toString().lowercase()

        val payload = buildMap<String, JsonPrimitive> {
            put("id", JsonPrimitive(newId))
            put("user_id", JsonPrimitive(owner))
            put("title", JsonPrimitive(source.title))
            // Back to the start of the pipeline: a copy has no photos, so it
            // cannot legitimately be "photographed" or "listed".
            put("status", JsonPrimitive("cataloged"))
            source.brand?.let { put("brand", JsonPrimitive(it)) }
            source.size?.let { put("size", JsonPrimitive(it)) }
            source.color?.let { put("color", JsonPrimitive(it)) }
            source.material?.let { put("material", JsonPrimitive(it)) }
            source.style?.let { put("style", JsonPrimitive(it)) }
            source.itemCategory?.let { put("item_category", JsonPrimitive(it)) }
            source.garmentType?.let { put("garment_type", JsonPrimitive(it)) }
            source.garmentCategory?.let { put("garment_category", JsonPrimitive(it)) }
            source.itemDescription?.let { put("description", JsonPrimitive(it)) }
            source.container?.let { put("container", JsonPrimitive(it)) }
            source.locationBin?.let { put("location_bin", JsonPrimitive(it)) }
            source.sourcedBy?.let { put("sourced_by", JsonPrimitive(it)) }
            source.acquiredPrice?.let { put("acquired_price", JsonPrimitive(it)) }
            source.targetPrice?.let { put("target_price", JsonPrimitive(it)) }
            // SKU is deliberately absent: it is unique per item, and copying it
            // would collide with the partial unique index. The grade and its
            // certificate are absent for a stronger reason — they belong to the
            // garment that was actually photographed and graded, and carrying
            // them over would fabricate a certified grade for an ungraded item.
        }
        client.from(ITEMS).insert(JsonObject(payload))
        newId
    }

    /** Mirror the order into Room and refresh the cached cover. */
    private suspend fun mirrorOrder(ordered: List<ItemPhotoEntity>) {
        val renumbered = ordered.mapIndexed { index, photo -> photo.copy(sortOrder = index) }
        if (renumbered.isNotEmpty()) db.photos().upsert(renumbered)

        val itemId = ordered.firstOrNull()?.inventoryItemId ?: return
        // `renumbered` is already in display order, so index 0 IS the cover.
        val cover = PhotoOrdering.coverOf(renumbered)
        db.items().byId(itemId)?.let { item ->
            db.items().upsert(
                listOf(
                    item.copy(
                        // A local display cache only — the server recomputes it
                        // from sort_order, so it is never written back.
                        primaryPhotoUrl = cover?.thumbnailUrl ?: cover?.photoUrl,
                        updatedAt = System.currentTimeMillis(),
                    ),
                ),
            )
        }
    }

    private companion object {
        const val PHOTOS = "item_photos"
        const val ITEMS = "inventory_items"
    }
}
