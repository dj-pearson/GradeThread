package com.gradethread.app.intake

import com.gradethread.app.capture.PhotoIntakeStore
import com.gradethread.app.capture.PhotoSlotType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1382: the share-target rules.
 *
 * The share Activity is gone a second after it runs and the drain happens on a
 * foreground event with no screen up, so neither is a place where a mistake
 * would be seen. The rule that matters most: a share NEVER overwrites a photo
 * the seller already took.
 */
class IntakeInboxTest {

    private fun entry(slot: PhotoSlotType, name: String = slot.wire) =
        IntakeInbox.PhotoEntry(path = "/tmp/$name.jpg", slot = slot.wire, bytes = 1000L)

    private fun batch(vararg photos: IntakeInbox.PhotoEntry, createdAt: Long = 0L) =
        IntakeInbox.Batch(id = "b1", createdAt = createdAt, photos = photos.toList())

    // ── Slot assignment ──────────────────────────────────────────────────────

    @Test
    fun `a fresh share fills front, back, tag, detail first`() {
        assertEquals(
            listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK, PhotoSlotType.TAG, PhotoSlotType.DETAIL),
            IntakeInbox.defaultSlots(4),
        )
    }

    @Test
    fun `the cap is eight, matching the picker`() {
        assertEquals(IntakeInbox.MAX_PHOTOS, IntakeInbox.defaultSlots(20).size)
        assertTrue(IntakeInbox.defaultSlots(0).isEmpty())
    }

    // ── Draining into a draft ────────────────────────────────────────────────

    @Test
    fun `an empty draft takes the batch as sent`() {
        val result = IntakeInbox.drainInto(
            PhotoIntakeStore.State(),
            batch(entry(PhotoSlotType.FRONT), entry(PhotoSlotType.BACK)),
        )

        assertEquals(2, result.added)
        assertEquals(0, result.dropped)
        assertEquals("/tmp/front.jpg", result.state.photos["front"])
        assertEquals("/tmp/back.jpg", result.state.photos["back"])
    }

    @Test
    fun `a share never overwrites a photo already taken`() {
        // The single worst outcome here: a seller who shot two frames, shared a
        // third, and lost the first two. Silently replacing them is
        // indistinguishable from the app eating their work.
        val existing = PhotoIntakeStore.State(photos = mapOf("front" to "/camera/front.jpg"))

        val result = IntakeInbox.drainInto(existing, batch(entry(PhotoSlotType.FRONT)))

        assertEquals("/camera/front.jpg", result.state.photos["front"])
        assertEquals(1, result.added)
        // It moved to the next free slot rather than being thrown away.
        assertEquals("/tmp/front.jpg", result.state.photos["back"])
    }

    @Test
    fun `overflow past every candidate slot is reported, not silent`() {
        val filled = (
            PhotoSlotType.defaultSlots + listOf(
                PhotoSlotType.DETAIL2, PhotoSlotType.DETAIL3, PhotoSlotType.DETAIL4,
                PhotoSlotType.TAG2, PhotoSlotType.FLATLAY, PhotoSlotType.INTERIOR,
            )
            ).associate { it.wire to "/camera/${it.wire}.jpg" }

        val result = IntakeInbox.drainInto(
            PhotoIntakeStore.State(photos = filled),
            batch(entry(PhotoSlotType.FRONT), entry(PhotoSlotType.BACK)),
        )

        assertEquals(0, result.added)
        assertEquals(2, result.dropped)
        assertTrue(result.isEmpty)
    }

    @Test
    fun `a slot outside the defaults is revealed when it is used`() {
        val result = IntakeInbox.drainInto(
            PhotoIntakeStore.State(),
            batch(entry(PhotoSlotType.FLATLAY)),
        )

        // Otherwise the photo is in the draft but has no chip in the strip, so
        // the seller cannot see or retake it.
        assertTrue(PhotoSlotType.FLATLAY.wire in result.state.extraSlots)
    }

    @Test
    fun `the camera opens on the first slot still empty`() {
        val result = IntakeInbox.drainInto(
            PhotoIntakeStore.State(),
            batch(entry(PhotoSlotType.FRONT)),
        )

        assertEquals(PhotoSlotType.BACK.wire, result.state.activeSlot)
    }

    @Test
    fun `an unknown slot from an older build still lands somewhere`() {
        val result = IntakeInbox.drainInto(
            PhotoIntakeStore.State(),
            batch(IntakeInbox.PhotoEntry(path = "/tmp/x.jpg", slot = "not-a-slot", bytes = 1L)),
        )

        assertEquals(1, result.added)
        assertEquals("/tmp/x.jpg", result.state.photos["front"])
    }

    // ── Staleness ────────────────────────────────────────────────────────────

    @Test
    fun `batches older than a week are swept`() {
        val now = 30L * 24 * 60 * 60 * 1000
        val fresh = batch(entry(PhotoSlotType.FRONT), createdAt = now - 1000)
        val old = batch(entry(PhotoSlotType.FRONT), createdAt = now - IntakeInbox.STALE_AFTER_MS - 1)

        val stale = IntakeInbox.stale(listOf(fresh, old), now)

        assertEquals(1, stale.size)
        assertEquals(old.createdAt, stale.single().createdAt)
    }

    @Test
    fun `a batch exactly at the age limit survives`() {
        val now = 30L * 24 * 60 * 60 * 1000
        val edge = batch(entry(PhotoSlotType.FRONT), createdAt = now - IntakeInbox.STALE_AFTER_MS)

        assertTrue(IntakeInbox.stale(listOf(edge), now).isEmpty())
    }

    // ── What the seller is told ──────────────────────────────────────────────

    @Test
    fun `a clean drain says nothing`() {
        val result = IntakeInbox.drainInto(PhotoIntakeStore.State(), batch(entry(PhotoSlotType.FRONT)))
        assertNull(IntakeInbox.message(result, failedToRead = 0))
    }

    @Test
    fun `unreadable photos are named, never swallowed`() {
        // US-1181. The silent version of this looks exactly like the app losing
        // someone's photos, which is the worst thing a capture app can seem to do.
        val nothing = IntakeInbox.DrainResult(PhotoIntakeStore.State(), added = 0, dropped = 0)

        assertEquals(
            "Couldn't read 3 photos you shared. Try sharing again from the gallery.",
            IntakeInbox.message(nothing, failedToRead = 3),
        )
        assertEquals(
            "Couldn't read 1 photo you shared. Try sharing again from the gallery.",
            IntakeInbox.message(nothing, failedToRead = 1),
        )
    }

    @Test
    fun `a full draft explains why nothing landed`() {
        val nothing = IntakeInbox.DrainResult(PhotoIntakeStore.State(), added = 0, dropped = 4)
        assertEquals(
            "Nothing was added — every photo slot is already filled.",
            IntakeInbox.message(nothing, failedToRead = 0),
        )
    }

    @Test
    fun `a partial drain counts both kinds of loss`() {
        val partial = IntakeInbox.DrainResult(PhotoIntakeStore.State(), added = 2, dropped = 1)
        assertEquals(
            "Added 2 photos. 2 photos didn't fit.",
            IntakeInbox.message(partial, failedToRead = 1),
        )
    }
}
