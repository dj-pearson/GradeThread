package com.gradethread.app.inventory

import com.gradethread.app.ui.UiMessage
import com.gradethread.app.capture.FlipdeskPhotoType
import com.gradethread.app.capture.PhotoProfile
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
     * US-2488: one slot this garment wants, as the (type, role) PAIR the
     * profile named plus the wording a seller reads.
     *
     * A pair rather than a [PhotoSlotType]: the enum has `measurement_chest`,
     * `measurement_waist` and friends but no plain `measurement`, so resolving
     * a profile's measurement roles through it returns null every time and
     * silently drops every measurement slot the garment asked for.
     */
    data class Slot(val type: String, val role: String?, val label: UiMessage, val required: Boolean) {
        val key: String get() = PhotoProfile.slotKey(type, role)
    }

    /**
     * Slots this garment wants that have no photo yet — what "Add" fills first.
     *
     * Driven by the resolved profile, so a pair of jeans is never offered a
     * sleeve measurement and a suit gets a slot per tag. Two exclusions:
     *  - `defect`, because defects collapse to one server type, so a single
     *    defect photo would otherwise mark every defect slot as taken;
     *  - anything retired, because the profile table is server data this client
     *    did not author and a stale row must not put `detail_2` back in play.
     */
    fun unfilledSlots(photos: List<ItemPhotoEntity>, profile: PhotoProfile): List<Slot> {
        val filled = filledSlotKeys(photos)
        return profileSlots(profile).filter { it.key !in filled }
    }

    /** Required shots still missing — the grading blocker, in the seller's words. */
    fun missingRequiredSlots(photos: List<ItemPhotoEntity>, profile: PhotoProfile): List<Slot> {
        val filled = filledSlotKeys(photos)
        return profileSlots(profile).filter { it.required && it.key !in filled }
    }

    /** The profile's slots in CAPTURE order, deduped by pair. */
    private fun profileSlots(profile: PhotoProfile): List<Slot> {
        val seen = mutableSetOf<String>()
        return profile.roles.mapNotNull { role ->
            if (role.type == "defect" || FlipdeskPhotoType.isRetired(role.type)) return@mapNotNull null
            val slot = Slot(
                type = role.type,
                role = role.role,
                label = FlipdeskPhotoType.label(role.type, role.role, profile),
                required = role.required,
            )
            if (!seen.add(slot.key)) null else slot
        }
    }

    /**
     * US-2469: what a stored photo FILLS, as a (type, role) slot key.
     *
     * A retired type resolves to the pair migration 00587 rewrote it to, so a
     * row the backfill has not reached yet still counts as the same slot as one
     * it has. Without that, a device holding a pre-00587 `measurement_chest`
     * would be told its chest measurement is still missing while looking at it.
     */
    fun slotKeyOf(photo: ItemPhotoEntity): String {
        val retired = FlipdeskPhotoType.retired[photo.photoType]
        if (retired != null) return PhotoProfile.slotKey(retired.first, retired.second)
        return PhotoProfile.slotKey(photo.photoType, photo.photoRole)
    }

    private fun filledSlotKeys(photos: List<ItemPhotoEntity>): Set<String> = photos.map { slotKeyOf(it) }.toSet()

    /**
     * The next sort_order for a newly added photo — the end of the list.
     *
     * Appending rather than inserting is the safe default: a new photo must
     * never silently become the cover, because that would change the main
     * image of a live listing without anyone asking for it.
     */
    fun nextSortOrder(photos: List<ItemPhotoEntity>): Int = (photos.maxOfOrNull { it.sortOrder } ?: -1) + 1
}
