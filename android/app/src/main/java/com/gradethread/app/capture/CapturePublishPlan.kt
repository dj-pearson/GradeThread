package com.gradethread.app.capture

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * US-1334: what a finished capture session publishes — the draft inventory
 * item and the per-photo upload entries.
 *
 * Pure over an immutable [PhotoIntakeStore.State] (the [com.gradethread.app
 * .inventory.IntakeSubmission] pattern) so the ordering and timestamp rules
 * below are provable without WorkManager, Supabase or a camera.
 */
object CapturePublishPlan {

    /**
     * The row is created BEFORE the AI runs, so it needs a title now. The
     * extraction seeds a real one (see [com.gradethread.app.ai
     * .AiExtractReview.bestTitleSeed]); this is what the seller sees for the
     * ~40s in between, and what survives if extraction finds nothing.
     */
    const val PLACEHOLDER_TITLE = "Untitled item"

    /** Photo-first intake produces a `sourced` item — nothing is cataloged yet. */
    const val INITIAL_STATUS = "sourced"

    data class UploadEntry(
        val slot: CaptureSlot,
        val stagedPath: String,
        val sortOrder: Int,
        val capturedAtMs: Long,
    ) {
        val serverPhotoType: String get() = slot.serverPhotoType

        /** `item_photos.photo_role`, or null for a slot that takes none. */
        val photoRole: String? get() = slot.role
        val isRequired: Boolean get() = slot.type in PhotoSlotType.required
    }

    data class Plan(
        val itemId: String,
        val item: JsonObject,
        val uploads: List<UploadEntry>,
    ) {
        /** The gate photos: required if any were captured, else everything. */
        val gateSortOrders: Set<Int>
            get() = uploads.filter { it.isRequired }.map { it.sortOrder }.toSet()
                .ifEmpty { uploads.map { it.sortOrder }.toSet() }
    }

    /**
     * Every slot this session could hold a photo in, in the order they publish.
     *
     * US-2498: THE PROFILE OWNS THIS ORDER. It used to be `PhotoSlotType.entries`
     * — the enum's declaration order — which could only ever describe one
     * category, and which stopped being able to name a slot at all once two
     * slots could share a type (`tag:brand` and `tag:size` are both `TAG`).
     *
     * Defects come after the profile's own slots because they are close-ups of
     * a flaw, and a buyer scrolling a gallery should reach the garment first.
     * Anything captured under a slot this profile does not list — a session that
     * started under a different category — lands last, in enum order, which is
     * where the web puts it too.
     */
    fun orderedSlots(
        state: PhotoIntakeStore.State,
        profile: PhotoProfile,
    ): List<CaptureSlot> {
        val known = profile.captureSlots + profile.defectCaptureSlots
        val leftovers = state.photos.keys
            .mapNotNull(CaptureSlot::fromStorageKey)
            .filter { it !in known }
            .sortedWith(compareBy({ it.type.ordinal }, { it.role ?: "" }))
        return (known + leftovers).distinct()
    }

    /**
     * Build the plan.
     *
     * @param profile the resolved photo profile for the item's category — the
     *   source of both slot ORDER and the `photo_role` each upload carries.
     * @param nowMs the capture-session publish instant.
     */
    fun build(
        state: PhotoIntakeStore.State,
        itemId: String,
        ownerId: String,
        nowMs: Long,
        profile: PhotoProfile = PhotoProfile.clothingFallback,
    ): Plan {
        val ordered = orderedSlots(state, profile)
        val uploads = ordered
            .mapIndexedNotNull { position, slot ->
                state.photoFor(slot)?.let { path ->
                    Triple(slot, path, position)
                }
            }
            .mapIndexed { index, (slot, path, position) ->
                UploadEntry(
                    slot = slot,
                    stagedPath = path,
                    sortOrder = index,
                    // Offset by the slot's position in the FULL slot list, not
                    // by `index`: the storage path is
                    // `{user}/{item}/{type}_{ts}.jpg`, defect1-3 all collapse to
                    // the server type `defect`, and a suit's three tag shots all
                    // collapse to `tag` — so a shared `nowMs` would have them
                    // overwrite each other at the same key. The position is
                    // stable per slot, because the list it indexes into is the
                    // profile's, not the list of what happened to be shot.
                    capturedAtMs = nowMs + position,
                )
            }

        return Plan(
            itemId = itemId.lowercase(),
            item = itemPayload(itemId, ownerId),
            uploads = uploads,
        )
    }

    /**
     * The insert body. Deliberately minimal — photo-first intake collects no
     * fields, and every column the AI might fill is left absent rather than
     * written blank so the extract's suggestions aren't competing with "".
     */
    fun itemPayload(itemId: String, ownerId: String): JsonObject = buildJsonObject {
        // Client-minted and LOWERCASED: Postgres normalizes uuids, and a
        // case-mismatched id caused duplicate-item sync bugs on iOS.
        put("id", itemId.lowercase())
        put("user_id", ownerId)
        put("title", PLACEHOLDER_TITLE)
        put("status", INITIAL_STATUS)
    }
}
