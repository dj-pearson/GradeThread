package com.gradethread.app.intake

import com.gradethread.app.capture.PhotoIntakeStore
import com.gradethread.app.capture.PhotoSlotType
import kotlinx.serialization.Serializable

/**
 * US-1382 (iOS `IntakeInbox`): photos shared in from another app, and what
 * happens to them.
 *
 * Everything here is pure. The share target runs as its own Activity that is
 * gone a second later, and the drain runs on a foreground event before any
 * screen is up — neither is a place where a mistake would be seen.
 */
object IntakeInbox {

    /** The same ceiling the photo picker uses, for the same reason: slots. */
    const val MAX_PHOTOS = 8

    /** How long an unopened batch survives. */
    const val STALE_AFTER_MS = 7L * 24 * 60 * 60 * 1000

    @Serializable
    data class PhotoEntry(
        /** Absolute path of the staged JPEG. */
        val path: String,
        /** [PhotoSlotType.wire]. */
        val slot: String,
        val bytes: Long,
    )

    @Serializable
    data class Batch(
        val id: String,
        val createdAt: Long,
        val photos: List<PhotoEntry>,
    )

    /**
     * The slots a fresh share fills, in order.
     *
     * Front, back, tag, detail first — the four that block or shape a grade —
     * then extras. Someone sharing four photos from their camera roll almost
     * always shot them in that order.
     */
    fun defaultSlots(count: Int): List<PhotoSlotType> {
        val ordered = PhotoSlotType.defaultSlots +
            listOf(
                PhotoSlotType.DETAIL2,
                PhotoSlotType.DETAIL3,
                PhotoSlotType.TAG2,
                PhotoSlotType.FLATLAY,
            )
        return ordered.take(count.coerceIn(0, MAX_PHOTOS))
    }

    /** What a drain did, so the app can say it out loud. */
    data class DrainResult(
        val state: PhotoIntakeStore.State,
        /** Photos placed into a slot. */
        val added: Int,
        /** Photos with nowhere to go — every target slot was already filled. */
        val dropped: Int,
    ) {
        val isEmpty: Boolean get() = added == 0
    }

    /**
     * Fold a shared batch into the in-flight capture draft.
     *
     * NEVER overwrites a slot that already has a photo. A seller who has shot
     * two frames and then shares a third from their gallery must not lose
     * either of the first two, and a share that silently replaced them would
     * be indistinguishable from the app eating their work.
     *
     * A photo whose requested slot is taken moves to the next free one. Only
     * when nothing is free at all is it [dropped] — reported, never silent.
     */
    fun drainInto(existing: PhotoIntakeStore.State, batch: Batch): DrainResult {
        val photos = existing.photos.toMutableMap()
        val extras = existing.extraSlots.toMutableList()

        // Ordered candidates: the four defaults, then whatever is already
        // revealed, then the extras a share is allowed to reveal on its own.
        val candidates = (
            PhotoSlotType.defaultSlots +
                existing.revealed +
                listOf(
                    PhotoSlotType.DETAIL2,
                    PhotoSlotType.DETAIL3,
                    PhotoSlotType.DETAIL4,
                    PhotoSlotType.TAG2,
                    PhotoSlotType.FLATLAY,
                    PhotoSlotType.INTERIOR,
                )
            ).distinct()

        var added = 0
        var dropped = 0
        batch.photos.forEach { entry ->
            val requested = PhotoSlotType.fromWire(entry.slot)
            val target = requested?.takeIf { photos[it.wire] == null }
                ?: candidates.firstOrNull { photos[it.wire] == null }
            if (target == null) {
                dropped += 1
                return@forEach
            }
            photos[target.wire] = entry.path
            if (target !in PhotoSlotType.defaultSlots && target.wire !in extras) {
                extras += target.wire
            }
            added += 1
        }

        val state = existing.copy(
            photos = photos,
            extraSlots = extras,
            // Park on the first slot still empty, so the camera opens where
            // the seller actually has work left.
            activeSlot = (PhotoSlotType.defaultSlots + extras.mapNotNull(PhotoSlotType::fromWire))
                .firstOrNull { photos[it.wire] == null }
                ?.wire
                ?: existing.activeSlot,
        )
        return DrainResult(state, added, dropped)
    }

    /** Batches past their shelf life, whether or not anyone ever opened them. */
    fun stale(batches: List<Batch>, nowMs: Long, maxAgeMs: Long = STALE_AFTER_MS): List<Batch> =
        batches.filter { nowMs - it.createdAt > maxAgeMs }

    /**
     * What the app tells the seller after a drain.
     *
     * A share that produced nothing has to SAY so (US-1181). The silent
     * version of this bug looks exactly like the app losing photos, which is
     * the single worst thing a capture app can appear to do.
     */
    fun message(result: DrainResult, failedToRead: Int): String? = when {
        result.added == 0 && failedToRead > 0 ->
            "Couldn't read ${photoWord(failedToRead)} you shared. Try sharing again from the gallery."
        result.added == 0 ->
            "Nothing was added — every photo slot is already filled."
        result.dropped > 0 || failedToRead > 0 -> {
            val lost = result.dropped + failedToRead
            "Added ${photoWord(result.added)}. ${photoWord(lost)} didn't fit."
        }
        else -> null
    }

    private fun photoWord(count: Int) = "$count photo" + if (count == 1) "" else "s"
}
