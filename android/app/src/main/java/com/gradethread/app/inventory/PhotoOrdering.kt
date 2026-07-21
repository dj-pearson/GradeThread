package com.gradethread.app.inventory

import com.gradethread.app.capture.PhotoSlotType
import com.gradethread.app.sync.db.ItemPhotoEntity

/**
 * US-1344: the photo-order rules.
 *
 * **An array index IS the canonical `sort_order`, and index 0 is the cover.**
 * That single fact reaches further than it looks: the lowest sort_order is what
 * the grid thumbnail shows AND what eBay publishes as the listing's main image.
 * Getting it wrong doesn't look like a bug locally — it looks like a live
 * listing whose lead photo is the care label.
 *
 * Pure, so every rule below is provable without Supabase or a camera.
 */
object PhotoOrdering {

    /**
     * The `(id, newSortOrder)` pairs that actually MOVED.
     *
     * Only changed rows are written. A reorder that rewrote all twelve rows
     * would burn twelve round trips to move one photo, and would touch
     * `updated_at` on photos nobody dragged.
     */
    fun changedSortOrders(ordered: List<ItemPhotoEntity>): List<Pair<String, Int>> =
        ordered.mapIndexedNotNull { index, photo ->
            if (photo.sortOrder == index) null else photo.id to index
        }

    /** Move one photo to the cover slot. A no-op when it is already there. */
    fun movedToCover(ordered: List<ItemPhotoEntity>, from: Int): List<ItemPhotoEntity> {
        if (from !in ordered.indices || from == 0) return ordered
        val copy = ordered.toMutableList()
        copy.add(0, copy.removeAt(from))
        return copy
    }

    /** Move one photo by drag. */
    fun moved(ordered: List<ItemPhotoEntity>, from: Int, to: Int): List<ItemPhotoEntity> {
        if (from !in ordered.indices || to !in ordered.indices || from == to) return ordered
        val copy = ordered.toMutableList()
        copy.add(to, copy.removeAt(from))
        return copy
    }

    /**
     * The survivors after a removal, with their sort_order gap closed.
     *
     * Densifying matters because the cover is "lowest sort_order", not
     * "sort_order 0" — deleting the cover without re-densifying leaves the next
     * photo at 1, which still reads as the cover, but every later comparison
     * against a freshly-densified list disagrees about the order.
     */
    fun removed(ordered: List<ItemPhotoEntity>, photoId: String): List<ItemPhotoEntity> =
        ordered.filterNot { it.id == photoId }

    /** Sorted display order — server `sort_order`, ties broken by creation. */
    fun displayOrder(photos: List<ItemPhotoEntity>): List<ItemPhotoEntity> =
        photos.sortedWith(compareBy({ it.sortOrder }, { it.createdAt }, { it.id }))

    /**
     * The cover of a set of PERSISTED rows — lowest `sort_order` wins.
     *
     * Derived from the photo rows rather than read from
     * `inventory_items.primaryPhotoUrl`: that column is a denormalized cache
     * that lags the real set (US-994), so trusting it would show a cover the
     * listing no longer uses.
     *
     * Use [coverOf] for a list that has been reordered but not yet written.
     * The two genuinely differ: [moved] and [movedToCover] rearrange the LIST
     * without renumbering `sort_order` — they have to, because
     * [changedSortOrders] finds what moved by comparing each row's stored order
     * against its new index. So mid-drag the stored orders are stale, and
     * sorting by them here would report the OLD cover while the seller is
     * looking at the new one.
     */
    fun cover(photos: List<ItemPhotoEntity>): ItemPhotoEntity? = displayOrder(photos).firstOrNull()

    /** The cover of an already-ordered list: whatever is at index 0. */
    fun coverOf(ordered: List<ItemPhotoEntity>): ItemPhotoEntity? = ordered.firstOrNull()

    /**
     * Standard slots with no photo yet — what "Add" offers to fill.
     *
     * Defect slots are EXCLUDED from the filled check on purpose: defect1..3
     * all collapse to the server type `defect`, so one defect photo would
     * otherwise mark every defect slot as taken.
     */
    fun unfilledStandardSlots(photos: List<ItemPhotoEntity>): List<PhotoSlotType> {
        val filled = photos.map { it.photoType }.toSet()
        return PhotoSlotType.defaultSlots.filter { slot ->
            slot !in PhotoSlotType.defects && slot.serverPhotoType !in filled
        }
    }

    /** Required shots still missing — the grading blocker, in the seller's words. */
    fun missingRequiredSlots(photos: List<ItemPhotoEntity>): List<PhotoSlotType> {
        val filled = photos.map { it.photoType }.toSet()
        return PhotoSlotType.required.filter { it.serverPhotoType !in filled }
    }

    /**
     * The next sort_order for a newly added photo — the end of the list.
     *
     * Appending rather than inserting is the safe default: a new photo must
     * never silently become the cover, because that would change the main
     * image of a live listing without anyone asking for it.
     */
    fun nextSortOrder(photos: List<ItemPhotoEntity>): Int =
        (photos.maxOfOrNull { it.sortOrder } ?: -1) + 1
}
