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
        val slot: PhotoSlotType,
        val stagedPath: String,
        val sortOrder: Int,
        val capturedAtMs: Long,
    ) {
        val serverPhotoType: String get() = slot.serverPhotoType
        val isRequired: Boolean get() = slot in PhotoSlotType.required
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
     * Build the plan.
     *
     * @param nowMs the capture-session publish instant.
     */
    fun build(
        state: PhotoIntakeStore.State,
        itemId: String,
        ownerId: String,
        nowMs: Long,
    ): Plan {
        val uploads = PhotoSlotType.entries
            // DECLARATION ORDER IS THE CANONICAL COVER ORDER — front is the
            // eBay main image, so sort_order must follow the enum, never the
            // order the seller happened to shoot in.
            .mapNotNull { slot -> state.photoFor(slot)?.let { slot to it } }
            .mapIndexed { index, (slot, path) ->
                UploadEntry(
                    slot = slot,
                    stagedPath = path,
                    sortOrder = index,
                    // Offset by the slot's ordinal, NOT by `index`: the storage
                    // path is `{user}/{item}/{type}_{ts}.jpg` and defect1–3 all
                    // collapse to the server type `defect`, so a shared `nowMs`
                    // would have the three defect shots overwrite each other at
                    // the same key. The ordinal is stable and unique per slot.
                    capturedAtMs = nowMs + slot.ordinal,
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
